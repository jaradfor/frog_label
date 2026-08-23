import { describe, expect, it } from 'vitest';
import {
  migrateCatalog,
  migrateDocument,
  migrateLocalFile,
  readCatalogWithHistory,
  readLocalFileWithHistory,
} from '../../src/domain/migrations';
import {
  assertCatalog,
  assertReadableCatalog,
  assertSpecies,
  speciesSnapshot,
} from '../../src/domain/validation';
import type {
  FrogLabelDocumentV1,
  FrogLabelLocalFileV1,
  SpeciesCatalogV1,
  SpeciesEntry,
} from '../../src/domain/types';

const timestamp = '2026-08-20T00:00:00.000Z';

const legacyCatalog: SpeciesCatalogV1 = {
  schemaVersion: 1,
  kind: 'froglabel.species-catalog',
  catalogId: 'legacy:catalog',
  initializedAt: timestamp,
  initializedBy: 'legacy fixture',
  catalogRevision: 4,
  defaultSpeciesId: 'legacy:perons',
  species: [
    {
      schemaVersion: 1,
      kind: 'froglabel.species',
      speciesId: 'legacy:perons',
      code: 'PER',
      speciesName: "Peron's Tree Frog",
      addedAfterInitialization: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ],
};

const legacyDocument: FrogLabelDocumentV1 = {
  kind: 'froglabel.annotation-set',
  schemaVersion: 1,
  catalogId: legacyCatalog.catalogId,
  reviewStatus: 'calls_present',
  boxes: [
    {
      id: 'legacy:box',
      species: {
        speciesId: 'legacy:perons',
        code: 'PER',
        speciesName: "Peron's Tree Frog",
        addedAfterInitialization: false,
      },
      startTimeSeconds: 1,
      endTimeSeconds: 2,
      lowFrequencyHz: 500,
      highFrequencyHz: 2_000,
      provenance: { source: 'human' },
    },
  ],
};

describe('V2 catalog and document contracts', () => {
  it('reads V1 catalogs but requires an explicit administrative code mapping to activate them', () => {
    expect(() => assertReadableCatalog(legacyCatalog)).not.toThrow();
    expect(() => assertCatalog(legacyCatalog)).toThrow(/schema version 2/u);
    expect(() => migrateCatalog(legacyCatalog)).toThrow(/exact code mapping/u);
    expect(() =>
      migrateCatalog(legacyCatalog, {
        codeBySpeciesId: { 'legacy:perons': 'ETF' },
        priorityBySpeciesId: {},
      }),
    ).toThrow(/exact priority mapping/u);

    const migrated = migrateCatalog(legacyCatalog, {
      codeBySpeciesId: { 'legacy:perons': 'ETF' },
      priorityBySpeciesId: { 'legacy:perons': 250 },
    });
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      catalogRevision: 4,
      defaultSpeciesId: 'legacy:perons',
      species: [
        {
          schemaVersion: 2,
          speciesId: 'legacy:perons',
          code: 'ETF',
          selectionPriority: 250,
        },
      ],
    });
  });

  it('rejects unknown mapping IDs and collisions before returning a promoted catalog', () => {
    expect(() =>
      migrateCatalog(legacyCatalog, {
        codeBySpeciesId: { 'legacy:perons': 'ETF', 'legacy:typo': 'GRE' },
        priorityBySpeciesId: { 'legacy:perons': 0, 'legacy:typo': 0 },
      }),
    ).toThrow(/exact code mapping/u);

    const twoSpecies = structuredClone(legacyCatalog);
    twoSpecies.species.push({
      ...structuredClone(twoSpecies.species[0]),
      speciesId: 'legacy:corroboree',
      code: 'COR',
      speciesName: 'Corroboree Frog',
    });
    expect(() =>
      migrateCatalog(twoSpecies, {
        codeBySpeciesId: { 'legacy:perons': 'ETF', 'legacy:corroboree': 'ETF' },
        priorityBySpeciesId: { 'legacy:perons': 0, 'legacy:corroboree': 0 },
      }),
    ).toThrow(/Duplicate species code/u);
  });

  it('keeps an unmapped V1 code visible as historical instead of inventing an administrator decision', () => {
    const unmapped = structuredClone(legacyCatalog);
    unmapped.species[0].code = 'OWL';
    unmapped.species[0].speciesName = 'Unmapped Frog';
    const readable = readCatalogWithHistory(unmapped);
    expect(readable.species).toEqual([]);
    expect(readable.defaultSpeciesId).toBeNull();
    expect(readable.historicalSpecies).toEqual(unmapped.species);
    expect(() => migrateCatalog(unmapped)).toThrow(/exact code mapping/u);
  });

  it('never activates a legacy code merely because its letters are on the left hand', () => {
    const leftHandLegacy = structuredClone(legacyCatalog);
    leftHandLegacy.species[0].code = 'RED';
    const readable = readCatalogWithHistory(leftHandLegacy);
    expect(readable.species).toHaveLength(0);
    expect(readable.historicalSpecies?.[0].code).toBe('RED');
    expect(() => migrateCatalog(leftHandLegacy)).toThrow(/exact code mapping/u);
  });

  it('upgrades a V1 document envelope without rewriting its PER snapshot', () => {
    const migrated = migrateDocument(legacyDocument);
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.boxes[0].species).toEqual(legacyDocument.boxes[0].species);
  });

  it('keeps operational priority out of immutable annotation snapshots', () => {
    const active: SpeciesEntry = {
      schemaVersion: 2,
      kind: 'froglabel.species',
      speciesId: 'active:green',
      code: 'GRE',
      selectionPriority: 900,
      speciesName: 'Green Tree Frog',
      addedAfterInitialization: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    assertSpecies(active);
    expect(speciesSnapshot(active)).toEqual({
      speciesId: active.speciesId,
      code: active.code,
      speciesName: active.speciesName,
      addedAfterInitialization: false,
    });
  });

  it('dual-reads a V1 local file without activating its catalog and retains old box metadata', () => {
    const value: FrogLabelLocalFileV1 = {
      kind: 'froglabel.local-file',
      schemaVersion: 1,
      audio: {
        filename: 'legacy.wav',
        sizeBytes: 128,
        durationSeconds: 3,
        sampleRateHz: 8_000,
        channelCount: 1,
        fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64), scope: 'file-bytes' },
      },
      catalogSnapshot: legacyCatalog.species,
      document: legacyDocument,
    };
    const readable = readLocalFileWithHistory(value);
    expect(readable.schemaVersion).toBe(2);
    expect(readable.catalogSnapshot).toEqual([]);
    expect(readable.historicalCatalogSnapshot).toEqual(value.catalogSnapshot);
    expect(readable.document?.boxes[0].species).toEqual(value.document?.boxes[0].species);

    const migrated = migrateLocalFile(value, {
      codeBySpeciesId: { 'legacy:perons': 'ETF' },
      priorityBySpeciesId: { 'legacy:perons': 250 },
    });
    expect(migrated.catalogSnapshot[0]).toMatchObject({ code: 'ETF', selectionPriority: 250 });
    expect(migrated.historicalCatalogSnapshot).toBeUndefined();
    expect(migrated.document?.boxes[0].species.code).toBe('PER');
  });
});
