import { useQuery } from 'urql';
import { graphql } from './graphql';
import { Fields, Pokemon, PokemonFields } from './Pokemon';

const PokemonQuery = graphql(`
  query Po($id: ID!) {
    pokemon(id: $id) {
      id
      fleeRate
      ...Pok
      ...pokemonFields
      attacks {
        special {
          name
          damage
        }
      }
      weight {
        minimum
        maximum
      }
      name
      __typename
    }
    pokemons {
      name
      maxCP
      maxHP
      types
      fleeRate
    }
  }
`, [PokemonFields, Fields.Pokemon])

const persisted = graphql.persisted<typeof PokemonQuery>("sha256:78c769ed6cfef67e17e579a2abfe4da27bd51e09ed832a88393148bcce4c5a7d")

const Pokemons = () => {
  const [result] = useQuery({
    query: PokemonQuery,
    variables: { id: '' }
  });
  
  // @ts-expect-error
  const [sel] = result.data?.pokemons;
  console.log(sel.fleeRate)
  const selected = result.data?.pokemons?.at(0)!
  console.log(result.data?.pokemons?.at(0)?.maxCP)
  console.log(selected.maxHP)
  const names = result.data?.pokemons?.map(x => x?.name)
  console.log(names)
  const pos = result.data?.pokemons?.map(x => ({ ...x }))
  console.log(pos && pos[0].types)
  
  // Works
  console.log(result.data?.pokemon?.attacks && result.data?.pokemon?.attacks.special && result.data?.pokemon?.attacks.special[0] && result.data?.pokemon?.attacks.special[0].name)

  // Works
  const { fleeRate } = result.data?.pokemon || {};
  console.log(fleeRate)
  // Works
  const po = result.data?.pokemon;

  // @ts-expect-error
  const { pokemon: { weight: { minimum } } } = result.data || {};
  console.log(po?.name, minimum)

  // Works
  const { pokemon } = result.data || {};
  console.log(pokemon?.weight?.maximum)

  // @ts-ignore
  return <Pokemon data={result.data!.pokemon} />;
}
