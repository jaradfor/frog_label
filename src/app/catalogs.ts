import type { SpeciesCatalogV1 } from '../domain/types';

const initializedAt = '2026-08-20T00:00:00.000Z';

export const demoCatalog: SpeciesCatalogV1 = {
  schemaVersion: 1,
  kind: 'froglabel.species-catalog',
  catalogId: 'demo:froglabel-catalog',
  initializedAt,
  initializedBy: 'FrogLabel demo fixture',
  catalogRevision: 1,
  defaultSpeciesId: null,
  species: [
    ['demo:green-tree-frog', 'GRE', 'Green Tree Frog'],
    ['demo:perons-tree-frog', 'PER', "Peron's Tree Frog"],
    ['demo:red-eyed-tree-frog', 'RED', 'Red-Eyed Tree Frog'],
    ['demo:corroboree-frog', 'COR', 'Corroboree Frog'],
  ].map(([speciesId, code, speciesName]) => ({
    schemaVersion: 1 as const,
    kind: 'froglabel.species' as const,
    speciesId,
    code,
    speciesName,
    addedAfterInitialization: false,
    createdAt: initializedAt,
    updatedAt: initializedAt,
  })),
};

export const tutorialCatalog: SpeciesCatalogV1 = {
  schemaVersion: 1,
  kind: 'froglabel.species-catalog',
  catalogId: 'tutorial:froglabel-catalog',
  initializedAt,
  initializedBy: 'FrogLabel tutorial fixture',
  catalogRevision: 1,
  defaultSpeciesId: null,
  species: [
    {
      schemaVersion: 1,
      kind: 'froglabel.species',
      speciesId: 'tutorial:perons-tree-frog',
      code: 'PER',
      speciesName: "Peron's Tree Frog",
      addedAfterInitialization: false,
      createdAt: initializedAt,
      updatedAt: initializedAt,
    },
  ],
};

export function emptyLocalCatalog(catalogId = `local:${crypto.randomUUID()}`): SpeciesCatalogV1 {
  return {
    schemaVersion: 1,
    kind: 'froglabel.species-catalog',
    catalogId,
    initializedAt: new Date().toISOString(),
    initializedBy: 'FrogLabel local route',
    catalogRevision: 1,
    defaultSpeciesId: null,
    species: [],
  };
}
