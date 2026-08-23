import type {
  FrogLabelDocument,
  FrogLabelDocumentV1,
  FrogLabelLocalFile,
  FrogLabelLocalFileV1,
  SpeciesCatalog,
  SpeciesCatalogV1,
  SpeciesEntry,
  SpeciesEntryV1,
} from './types';
import {
  assertCatalog,
  assertDocument,
  assertLocalFile,
  assertReadableCatalog,
  assertReadableDocument,
  assertReadableLocalFile,
  assertReadableSpecies,
  assertSpecies,
  normalizeSpeciesCode,
  normalizeSpeciesName,
} from './validation';
import { ValidationError } from './errors';

type LegacySpecies = Partial<SpeciesEntryV1> & { commonName?: string; fullName?: string };

export interface CatalogMigrationOptions {
  /** Administrator-reviewed V2 codes, keyed by immutable speciesId. */
  codeBySpeciesId?: Readonly<Record<string, string>>;
  /** Administrator-defined stable ranking; strict promotion requires every ID. */
  priorityBySpeciesId?: Readonly<Record<string, number>>;
}

export function migrateSpecies(
  value: unknown,
  options: CatalogMigrationOptions = {},
): SpeciesEntry {
  if (!value || typeof value !== 'object') {
    throw new ValidationError('Species value must be an object');
  }
  const source = value as LegacySpecies | SpeciesEntry;
  if (source.schemaVersion === 2) {
    const current = structuredClone(source) as SpeciesEntry;
    assertSpecies(current);
    return current;
  }
  if (source.schemaVersion !== 1 && source.schemaVersion !== undefined) {
    throw new ValidationError(
      'Species was created by a newer FrogLabel',
      String(source.schemaVersion),
    );
  }

  const legacy = source as LegacySpecies;
  const speciesId = String(legacy.speciesId ?? '');
  const speciesName = normalizeSpeciesName(
    String(legacy.speciesName ?? legacy.commonName ?? legacy.fullName ?? ''),
  );
  if (!options.codeBySpeciesId || !Object.hasOwn(options.codeBySpeciesId, speciesId)) {
    throw new ValidationError(
      `Species ${speciesId || '(missing speciesId)'} requires an administrator-assigned V2 code`,
      'Legacy codes are historical only until an explicit migration maps every entry',
    );
  }
  if (!options.priorityBySpeciesId || !Object.hasOwn(options.priorityBySpeciesId, speciesId)) {
    throw new ValidationError(
      `Species ${speciesId || '(missing speciesId)'} requires an administrator-assigned priority`,
      'Legacy entries cannot become active through an implicit default priority',
    );
  }
  const code = normalizeSpeciesCode(options.codeBySpeciesId[speciesId]);
  if (!/^[QWERTASDFGZXCVB]{1,6}$/u.test(code)) {
    throw new ValidationError(
      `Species ${speciesId || '(missing speciesId)'} requires an administrator-assigned V2 code`,
      `${code || '(empty)'} cannot be typed with the left-hand species chord`,
    );
  }
  const selectionPriority = options.priorityBySpeciesId[speciesId];
  const migrated: SpeciesEntry = {
    schemaVersion: 2,
    kind: 'froglabel.species',
    speciesId,
    code,
    selectionPriority,
    speciesName,
    ...(legacy.scientificName
      ? { scientificName: normalizeSpeciesName(String(legacy.scientificName)) }
      : {}),
    ...(legacy.externalTaxon ? { externalTaxon: structuredClone(legacy.externalTaxon) } : {}),
    addedAfterInitialization: Boolean(legacy.addedAfterInitialization),
    createdAt: String(legacy.createdAt ?? ''),
    updatedAt: String(legacy.updatedAt ?? ''),
  };
  assertSpecies(migrated);
  return migrated;
}

export function migrateCatalog(
  value: unknown,
  options: CatalogMigrationOptions = {},
): SpeciesCatalog {
  if (!value || typeof value !== 'object') throw new ValidationError('Catalog must be an object');
  assertReadableCatalog(value);
  if (value.schemaVersion === 2) {
    const current = structuredClone(value);
    assertCatalog(current);
    return current;
  }
  const source = value as SpeciesCatalogV1;
  assertExactMigrationCoverage(source.species, options);
  const migrated: SpeciesCatalog = {
    ...structuredClone(source),
    schemaVersion: 2,
    catalogRevision: source.catalogRevision ?? 1,
    species: source.species.map((entry) => migrateSpecies(entry, options)),
  };
  assertCatalog(migrated);
  return migrated;
}

/**
 * Read a catalog for labeling without promoting any V1 entry. Active V2
 * species and historical V1 species occupy separate, explicit collections.
 */
export function readCatalogWithHistory(value: unknown): SpeciesCatalog {
  assertReadableCatalog(value);
  if (value.schemaVersion === 2) {
    const current = structuredClone(value);
    assertCatalog(current);
    return current;
  }
  const historical = structuredClone(value);
  const current: SpeciesCatalog = {
    schemaVersion: 2,
    kind: historical.kind,
    catalogId: historical.catalogId,
    initializedAt: historical.initializedAt,
    initializedBy: historical.initializedBy,
    catalogRevision: historical.catalogRevision,
    // A legacy default is not active until the administrator migrates it.
    defaultSpeciesId: null,
    species: [],
    historicalSpecies: historical.species,
  };
  assertCatalog(current);
  return current;
}

/**
 * Upgrade only the envelope. Snapshot fields are intentionally cloned byte for
 * byte so a later catalog rename/recode never changes historical annotations.
 */
export function migrateDocument(value: unknown): FrogLabelDocument {
  if (!value || typeof value !== 'object') throw new ValidationError('Document must be an object');
  const migrated = structuredClone(value) as FrogLabelDocumentV1 | FrogLabelDocument;
  for (const box of migrated.boxes ?? []) {
    const provenance = box.provenance as unknown as {
      source?: unknown;
      humanModified?: boolean;
    };
    if (provenance?.source === 'model' && provenance.humanModified === undefined) {
      provenance.humanModified = false;
    }
  }
  assertReadableDocument(migrated);
  const current = { ...migrated, schemaVersion: 2 as const } as FrogLabelDocument;
  assertDocument(current);
  return current;
}

export function migrateLocalFile(
  value: unknown,
  options: CatalogMigrationOptions = {},
): FrogLabelLocalFile {
  assertReadableLocalFile(value);
  if (value.schemaVersion === 2) {
    const current = structuredClone(value);
    assertLocalFile(current);
    return current;
  }
  const source = value as FrogLabelLocalFileV1;
  const syntheticCatalog: SpeciesCatalogV1 = {
    schemaVersion: 1,
    kind: 'froglabel.species-catalog',
    catalogId: source.document?.catalogId ?? `local:${source.audio.fingerprint.value}`,
    initializedAt: new Date(0).toISOString(),
    initializedBy: 'Local file migration',
    catalogRevision: 1,
    defaultSpeciesId: null,
    species: source.catalogSnapshot,
  };
  const catalog = migrateCatalog(syntheticCatalog, options);
  const current: FrogLabelLocalFile = {
    kind: 'froglabel.local-file',
    schemaVersion: 2,
    audio: structuredClone(source.audio),
    catalogSnapshot: catalog.species,
    document: source.document ? migrateDocument(source.document) : null,
  };
  assertLocalFile(current);
  return current;
}

/** Read a local file while retaining an unmapped V1 catalog as history. */
export function readLocalFileWithHistory(value: unknown): FrogLabelLocalFile {
  assertReadableLocalFile(value);
  if (value.schemaVersion === 2) {
    const current = structuredClone(value);
    assertLocalFile(current);
    return current;
  }
  const source = structuredClone(value);
  const current: FrogLabelLocalFile = {
    kind: 'froglabel.local-file',
    schemaVersion: 2,
    audio: source.audio,
    catalogSnapshot: [],
    historicalCatalogSnapshot: source.catalogSnapshot,
    document: source.document ? migrateDocument(source.document) : null,
  };
  assertLocalFile(current);
  return current;
}

/** Validate a legacy entry without promoting it to the active catalog. */
export function readLegacySpecies(value: unknown): SpeciesEntryV1 {
  assertReadableSpecies(value);
  if (value.schemaVersion !== 1) throw new ValidationError('Expected a V1 species entry');
  return structuredClone(value);
}

function assertExactMigrationCoverage(
  species: readonly SpeciesEntryV1[],
  options: CatalogMigrationOptions,
): void {
  const expected = new Set(species.map((entry) => entry.speciesId));
  for (const [label, mapping] of [
    ['code', options.codeBySpeciesId],
    ['priority', options.priorityBySpeciesId],
  ] as const) {
    const supplied = new Set(Object.keys(mapping ?? {}));
    const missing = [...expected].filter((speciesId) => !supplied.has(speciesId));
    const unknown = [...supplied].filter((speciesId) => !expected.has(speciesId));
    if (missing.length || unknown.length) {
      throw new ValidationError(
        `Catalog migration requires an exact ${label} mapping for every legacy species`,
        [
          missing.length ? `missing: ${missing.sort().join(', ')}` : '',
          unknown.length ? `unknown: ${unknown.sort().join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('; '),
      );
    }
  }
}
