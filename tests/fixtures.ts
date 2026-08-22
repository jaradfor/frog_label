import type {
  AudioBounds,
  FrogLabelDocumentV1,
  SpeciesCatalogV1,
  SpeciesEntryV1,
} from '../src/domain/types';

export const bounds: AudioBounds = { durationSeconds: 30, maximumFrequencyHz: 22050 };

export const per: SpeciesEntryV1 = {
  schemaVersion: 1,
  kind: 'froglabel.species',
  speciesId: 'local:per',
  code: 'PER',
  speciesName: "Peron's Tree Frog",
  addedAfterInitialization: false,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

export const catalog: SpeciesCatalogV1 = {
  schemaVersion: 1,
  kind: 'froglabel.species-catalog',
  catalogId: 'catalog:test',
  initializedAt: '2026-08-20T00:00:00.000Z',
  initializedBy: 'test',
  catalogRevision: 1,
  defaultSpeciesId: null,
  species: [per],
};

export const document: FrogLabelDocumentV1 = {
  kind: 'froglabel.annotation-set',
  schemaVersion: 1,
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
