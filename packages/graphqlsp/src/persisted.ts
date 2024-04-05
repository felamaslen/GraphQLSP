import { ts } from './ts';

import { createHash } from 'crypto';

import { findAllCallExpressions, findNode, getSource } from './ast';
import { resolveTemplate } from './ast/resolve';
import { templates } from './ast/templates';
import { parse, print, visit } from '@0no-co/graphql.web';

type PersistedAction = {
  span: {
    start: number;
    length: number;
  };
  replacement: string;
};

const isPersistedCall = (expr: ts.LeftHandSideExpression) => {
  const expressionText = expr.getText();
  const [template, method] = expressionText.split('.');
  return templates.has(template) && method === 'persisted';
};

export function getPersistedCodeFixAtPosition(
  filename: string,
  position: number,
  info: ts.server.PluginCreateInfo
): PersistedAction | undefined {
  const isCallExpression = info.config.templateIsCallExpression ?? true;

  if (!isCallExpression) return undefined;

  let source = getSource(info, filename);
  if (!source) return undefined;

  const node = findNode(source, position);
  if (!node) return undefined;

  let callExpression: ts.Node = node;
  // We found a node and need to check where on the path we are
  // we expect this to look a little bit like
  // const persistedDoc = graphql.persisted<typeof x>()
  // When we are on the left half of this statement we bubble down
  // looking for the correct call-expression and on the right hand
  // we bubble up.
  if (ts.isVariableStatement(callExpression)) {
    callExpression =
      callExpression.declarationList.declarations.find(declaration => {
        return (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer)
        );
      }) || node;
  } else if (ts.isVariableDeclarationList(callExpression)) {
    callExpression =
      callExpression.declarations.find(declaration => {
        return (
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer)
        );
      }) || node;
  } else if (
    ts.isVariableDeclaration(callExpression) &&
    callExpression.initializer &&
    ts.isCallExpression(callExpression.initializer)
  ) {
    callExpression = callExpression.initializer;
  } else {
    while (callExpression && !ts.isCallExpression(callExpression)) {
      callExpression = callExpression.parent;
    }
  }

  // We want to ensure that we found a call-expression and that it looks
  // like "graphql.persisted", in a future iteration when the API surface
  // is more defined we will need to use the ts.Symbol to support re-exporting
  // this function by means of "export const peristed = graphql.persisted".
  if (
    !ts.isCallExpression(callExpression) ||
    !isPersistedCall(callExpression.expression) ||
    !callExpression.typeArguments
  )
    return undefined;

  const [typeQuery] = callExpression.typeArguments;

  if (!ts.isTypeQueryNode(typeQuery)) return undefined;

  const { node: found, filename: foundFilename } =
    getDocumentReferenceFromTypeQuery(typeQuery, filename, info);

  if (!found) return undefined;

  const initializer = found.initializer;
  if (
    !initializer ||
    !ts.isCallExpression(initializer) ||
    !ts.isNoSubstitutionTemplateLiteral(initializer.arguments[0])
  )
    return undefined;

  const externalSource = getSource(info, foundFilename)!;
  const { fragments } = findAllCallExpressions(externalSource, info);

  const text = resolveTemplate(
    initializer.arguments[0],
    foundFilename,
    info
  ).combinedText;
  const parsed = parse(text);
  const spreads = new Set();
  visit(parsed, {
    FragmentSpread: node => {
      spreads.add(node.name.value);
    },
  });

  let resolvedText = text;
  [...spreads].forEach(spreadName => {
    const fragmentDefinition = fragments.find(x => x.name.value === spreadName);
    if (!fragmentDefinition) {
      console.warn(
        `[GraphQLSP] could not find fragment for spread ${spreadName}!`
      );
      return;
    }

    resolvedText = `${resolvedText}\n\n${print(fragmentDefinition)}`;
  });

  const hash = createHash('sha256').update(text).digest('hex');

  const existingHash = callExpression.arguments[0];
  // We assume for now that this is either undefined or an existing string literal
  if (!existingHash) {
    // We have no persisted-identifier yet, suggest adding in a new one
    return {
      span: {
        start: callExpression.arguments.pos,
        length: 1,
      },
      replacement: `"sha256:${hash}")`,
    };
  } else if (
    ts.isStringLiteral(existingHash) &&
    existingHash.getText() !== `"sha256:${hash}"`
  ) {
    // We are out of sync, suggest replacing this with the updated hash
    return {
      span: {
        start: existingHash.getStart(),
        length: existingHash.end - existingHash.getStart(),
      },
      replacement: `"sha256:${hash}"`,
    };
  } else if (ts.isIdentifier(existingHash)) {
    // Suggest replacing a reference with a static one
    // this to make these easier to statically analyze
    return {
      span: {
        start: existingHash.getStart(),
        length: existingHash.end - existingHash.getStart(),
      },
      replacement: `"sha256:${hash}"`,
    };
  } else {
    return undefined;
  }
}

export const getDocumentReferenceFromTypeQuery = (
  typeQuery: ts.TypeQueryNode,
  filename: string,
  info: ts.server.PluginCreateInfo
): { node: ts.VariableDeclaration | null; filename: string } => {
  // We look for the references of the generic so that we can use the document
  // to generate the hash.
  const references = info.languageService.getReferencesAtPosition(
    filename,
    typeQuery.exprName.getStart()
  );

  if (!references) return { node: null, filename };

  let found: ts.VariableDeclaration | null = null;
  let foundFilename = filename;
  references.forEach(ref => {
    if (found) return;

    const source = getSource(info, ref.fileName);
    if (!source) return;
    const foundNode = findNode(source, ref.textSpan.start);
    if (!foundNode) return;

    if (ts.isVariableDeclaration(foundNode.parent)) {
      found = foundNode.parent;
      foundFilename = ref.fileName;
    }
  });

  return { node: found, filename: foundFilename };
};