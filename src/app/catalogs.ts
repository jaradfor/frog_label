import type { SpeciesCatalog } from '../domain/types';

const initializedAt = '2026-08-20T00:00:00.000Z';

export const demoCatalog: SpeciesCatalog = {
  schemaVersion: 2,
  kind: 'froglabel.species-catalog',
  catalogId: 'demo:froglabel-catalog',
  initializedAt,
  initializedBy: 'FrogLabel demo fixture',
  catalogRevision: 1,
  defaultSpeciesId: null,
  species: [
    ['demo:green-tree-frog', 'GRE', 'Green Treefrog'],
    ['demo:perons-tree-frog', 'ETF', "Peron's Tree Frog"],
    ['demo:red-eyed-tree-frog', 'RED', 'Red-Eyed Tree Frog'],
    ['demo:corroboree-frog', 'CRF', 'Corroboree Frog'],
  ].map(([speciesId, code, speciesName]) => ({
    schemaVersion: 2 as const,
    kind: 'froglabel.species' as const,
    speciesId,
    code,
    selectionPriority: 0,
    speciesName,
    addedAfterInitialization: false,
    createdAt: initializedAt,
    updatedAt: initializedAt,
  })),
};

export const tutorialCatalog: SpeciesCatalog = {
  schemaVersion: 2,
  kind: 'froglabel.species-catalog',
  catalogId: 'tutorial:froglabel-catalog',
  initializedAt,
  initializedBy: 'FrogLabel tutorial fixture',
  catalogRevision: 1,
  defaultSpeciesId: null,
  species: [
    {
      schemaVersion: 2,
      kind: 'froglabel.species',
      speciesId: 'tutorial:green-treefrog',
      code: 'GRE',
      selectionPriority: 0,
      speciesName: 'Green Treefrog',
      addedAfterInitialization: false,
      createdAt: initializedAt,
      updatedAt: initializedAt,
    },
  ],
};

export function emptyLocalCatalog(catalogId = `local:${crypto.randomUUID()}`): SpeciesCatalog {
  return {
    schemaVersion: 2,
    kind: 'froglabel.species-catalog',
    catalogId,
    initializedAt: new Date().toISOString(),
    initializedBy: 'FrogLabel local route',
    catalogRevision: 1,
    defaultSpeciesId: null,
    species: [],
  };
}
