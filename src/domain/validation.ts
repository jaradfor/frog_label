import type { ErrorObject, ValidateFunction } from 'ajv';
import {
  validateCatalog,
  validateDocument,
  validateLocalFile,
  validateMessage,
  validateSpecies,
  validateTaskData,
} from './generated-validators';
import type {
  AudioBounds,
  FrogLabelDocument,
  FrogLabelHostDataV1,
  FrogLabelLocalFile,
  ReadableFrogLabelDocument,
  ReadableFrogLabelLocalFile,
  ReadableSpeciesCatalog,
  ReadableSpeciesEntry,
  SpeciesCatalog,
  SpeciesEntry,
} from './types';
import { ValidationError } from './errors';

const validators = {
  species: validateSpecies as ValidateFunction<ReadableSpeciesEntry>,
  catalog: validateCatalog as ValidateFunction<ReadableSpeciesCatalog>,
  document: validateDocument as ValidateFunction<ReadableFrogLabelDocument>,
  taskData: validateTaskData as ValidateFunction<FrogLabelHostDataV1>,
  localFile: validateLocalFile as ValidateFunction<ReadableFrogLabelLocalFile>,
  message: validateMessage as ValidateFunction,
};
const HOST_MESSAGE_TYPES = new Set(['init', 'update', 'regions', 'viewState']);

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 12)
    .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`)
    .join('; ');
}

function assertSchema<T>(
  validator: ValidateFunction<T>,
  value: unknown,
  label: string,
): asserts value is T {
  if (!validator(value))
    throw new ValidationError(`${label} is invalid`, formatErrors(validator.errors));
}

export function normalizeSpeciesCode(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase();
}

export function normalizeSpeciesName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

export function speciesSnapshot(species: SpeciesEntry) {
  return {
    speciesId: species.speciesId,
    code: species.code,
    speciesName: species.speciesName,
    ...(species.scientificName ? { scientificName: species.scientificName } : {}),
    addedAfterInitialization: species.addedAfterInitialization,
  };
}

export function assertReadableSpecies(value: unknown): asserts value is ReadableSpeciesEntry {
  assertSchema(validators.species, value, 'Species');
  if (normalizeSpeciesCode(value.code) !== value.code) {
    throw new ValidationError('Species code must already be normalized', value.code);
  }
  if (normalizeSpeciesName(value.speciesName) !== value.speciesName) {
    throw new ValidationError('Full Species Name must already be normalized', value.speciesName);
  }
  if (value.scientificName && normalizeSpeciesName(value.scientificName) !== value.scientificName) {
    throw new ValidationError('Scientific name must already be normalized', value.scientificName);
  }
}

export function assertSpecies(value: unknown): asserts value is SpeciesEntry {
  assertReadableSpecies(value);
  if (value.schemaVersion !== 2) {
    throw new ValidationError(
      'Active species must use schema version 2',
      `Species ${value.speciesId} requires an administrator-assigned left-hand code`,
    );
  }
}

export function assertReadableCatalog(value: unknown): asserts value is ReadableSpeciesCatalog {
  assertSchema(validators.catalog, value, 'Species catalog');
  const ids = new Set<string>();
  const codes = new Set<string>();
  const entries = new Map(value.species.map((entry) => [entry.speciesId, entry]));
  for (const entry of value.species) {
    assertReadableSpecies(entry);
    if (entry.schemaVersion !== value.schemaVersion) {
      throw new ValidationError('Catalog and species schema versions must match', entry.speciesId);
    }
    if (ids.has(entry.speciesId))
      throw new ValidationError('Duplicate species ID', entry.speciesId);
    ids.add(entry.speciesId);
    const code = normalizeSpeciesCode(entry.code).toLocaleLowerCase('en');
    if (codes.has(code)) throw new ValidationError('Duplicate species code', entry.code);
    codes.add(code);
  }
  const historicalSpecies = value.schemaVersion === 2 ? (value.historicalSpecies ?? []) : [];
  if (value.species.length + historicalSpecies.length > 10_000) {
    throw new ValidationError('Catalog exceeds the 10000 species limit');
  }
  for (const entry of historicalSpecies) {
    assertReadableSpecies(entry);
    if (entry.schemaVersion !== 1) {
      throw new ValidationError('Historical species must use schema version 1', entry.speciesId);
    }
    if (ids.has(entry.speciesId))
      throw new ValidationError('Duplicate species ID', entry.speciesId);
    ids.add(entry.speciesId);
    const code = normalizeSpeciesCode(entry.code).toLocaleLowerCase('en');
    if (codes.has(code)) throw new ValidationError('Duplicate species code', entry.code);
    codes.add(code);
  }
  if (value.defaultSpeciesId && !entries.has(value.defaultSpeciesId)) {
    throw new ValidationError('Default species does not exist', value.defaultSpeciesId);
  }
}

export function assertCatalog(value: unknown): asserts value is SpeciesCatalog {
  assertReadableCatalog(value);
  if (value.schemaVersion !== 2) {
    throw new ValidationError(
      'Active catalogs must use schema version 2',
      'Run an administrator-reviewed catalog migration before labeling',
    );
  }
}

export function assertDocument(
  value: unknown,
  bounds?: AudioBounds,
): asserts value is FrogLabelDocument {
  assertReadableDocument(value, bounds);
  if (value.schemaVersion !== 2) {
    throw new ValidationError(
      'Writable annotation documents must use schema version 2',
      'The V1 document must be upgraded in memory before mutation',
    );
  }
}

export function assertReadableDocument(
  value: unknown,
  bounds?: AudioBounds,
): asserts value is ReadableFrogLabelDocument {
  assertSchema(validators.document, value, 'Annotation document');
  const ids = new Set<string>();
  for (const box of value.boxes) {
    if (ids.has(box.id)) throw new ValidationError('Duplicate box ID', box.id);
    ids.add(box.id);
    if (normalizeSpeciesCode(box.species.code) !== box.species.code) {
      throw new ValidationError('Box species code must already be normalized', box.id);
    }
    if (normalizeSpeciesName(box.species.speciesName) !== box.species.speciesName) {
      throw new ValidationError('Box species name must already be normalized', box.id);
    }
    if (
      box.species.scientificName &&
      normalizeSpeciesName(box.species.scientificName) !== box.species.scientificName
    ) {
      throw new ValidationError('Box scientific name must already be normalized', box.id);
    }
    const coordinates = [
      box.startTimeSeconds,
      box.endTimeSeconds,
      box.lowFrequencyHz,
      box.highFrequencyHz,
    ];
    if (!coordinates.every(Number.isFinite))
      throw new ValidationError('Box coordinates must be finite', box.id);
    if (box.startTimeSeconds >= box.endTimeSeconds)
      throw new ValidationError('Box time bounds are inverted', box.id);
    if (box.lowFrequencyHz >= box.highFrequencyHz)
      throw new ValidationError('Box frequency bounds are inverted', box.id);
    if (bounds) {
      const timeTolerance = bounds.analysisSampleRateHz
        ? 1 / bounds.analysisSampleRateHz
        : Math.max(1e-9, bounds.durationSeconds * Number.EPSILON * 8);
      const frequencyTolerance = Math.max(1e-9, bounds.maximumFrequencyHz * Number.EPSILON * 8);
      if (box.endTimeSeconds > bounds.durationSeconds + timeTolerance) {
        throw new ValidationError('Box exceeds trusted audio duration', box.id);
      }
      if (box.highFrequencyHz > bounds.maximumFrequencyHz + frequencyTolerance) {
        throw new ValidationError('Box exceeds trusted frequency maximum', box.id);
      }
    }
  }
}

export function assertHostData(value: unknown): asserts value is FrogLabelHostDataV1 {
  assertSchema(validators.taskData, value, 'Host task data');
}

export function assertReadableLocalFile(
  value: unknown,
): asserts value is ReadableFrogLabelLocalFile {
  assertSchema(validators.localFile, value, 'Local annotation file');
  const decodedChannelSamples =
    value.audio.durationSeconds * value.audio.sampleRateHz * value.audio.channelCount;
  if (decodedChannelSamples > 30_000_000) {
    throw new ValidationError(
      'Local audio metadata exceeds the 30000000 decoded channel-sample limit',
    );
  }
  const commonCatalog = {
    kind: 'froglabel.species-catalog' as const,
    catalogId: value.document?.catalogId ?? `local:${value.audio.fingerprint.value}`,
    catalogRevision: 1,
    initializedAt: new Date(0).toISOString(),
    initializedBy: 'Local file validation',
    defaultSpeciesId: null,
  };
  const snapshotCatalog: ReadableSpeciesCatalog =
    value.schemaVersion === 1
      ? { ...commonCatalog, schemaVersion: 1, species: value.catalogSnapshot }
      : {
          ...commonCatalog,
          schemaVersion: 2,
          species: value.catalogSnapshot,
          historicalSpecies: value.historicalCatalogSnapshot,
        };
  assertReadableCatalog(snapshotCatalog);
  if (value.document) {
    assertReadableDocument(value.document, {
      durationSeconds: value.audio.durationSeconds,
      maximumFrequencyHz: value.audio.sampleRateHz / 2,
      analysisSampleRateHz: value.audio.sampleRateHz,
    });
    const byId = new Map(
      [
        ...value.catalogSnapshot,
        ...(value.schemaVersion === 2 ? (value.historicalCatalogSnapshot ?? []) : []),
      ].map((entry) => [entry.speciesId, entry]),
    );
    for (const box of value.document.boxes) {
      if (!byId.has(box.species.speciesId)) {
        throw new ValidationError('Box species is absent from the catalog snapshot', box.id);
      }
    }
  }
}

export function assertLocalFile(value: unknown): asserts value is FrogLabelLocalFile {
  assertReadableLocalFile(value);
  if (value.schemaVersion !== 2) {
    throw new ValidationError(
      'Writable local files must use schema version 2',
      'Parse and migrate the V1 file before saving',
    );
  }
}

export function isReactCodeHostMessage(value: unknown): boolean {
  if (!validators.message(value) || !value || typeof value !== 'object') return false;
  return HOST_MESSAGE_TYPES.has(String((value as { type?: unknown }).type));
}

export function validationErrorsForMessage(): string {
  return formatErrors(validators.message.errors);
}
