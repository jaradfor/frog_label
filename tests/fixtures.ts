import type {
  AudioBounds,
  FrogLabelDocument,
  SpeciesCatalog,
  SpeciesEntry,
} from '../src/domain/types';

export const bounds: AudioBounds = { durationSeconds: 30, maximumFrequencyHz: 22050 };

export const per: SpeciesEntry = {
  schemaVersion: 2,
  kind: 'froglabel.species',
  speciesId: 'local:per',
  code: 'ETF',
  selectionPriority: 0,
  speciesName: "Peron's Tree Frog",
  addedAfterInitialization: false,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

export const catalog: SpeciesCatalog = {
  schemaVersion: 2,
  kind: 'froglabel.species-catalog',
  catalogId: 'catalog:test',
  initializedAt: '2026-08-20T00:00:00.000Z',
  initializedBy: 'test',
  catalogRevision: 1,
  defaultSpeciesId: null,
  species: [per],
};

export const document: FrogLabelDocument = {
  kind: 'froglabel.annotation-set',
  schemaVersion: 2,
  catalogId: catalog.catalogId,
  reviewStatus: 'calls_present',
  boxes: [
    {
      id: 'box:one',
      species: {
        speciesId: per.speciesId,
        code: per.code,
        speciesName: per.speciesName,
        addedAfterInitialization: false,
      },
      startTimeSeconds: 2,
      endTimeSeconds: 5,
      lowFrequencyHz: 500,
      highFrequencyHz: 2500,
      provenance: { source: 'human' },
    },
  ],
};
