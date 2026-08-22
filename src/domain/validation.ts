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
  FrogLabelDocumentV1,
  FrogLabelHostDataV1,
  FrogLabelLocalFileV1,
  SpeciesCatalogV1,
  SpeciesEntryV1,
} from './types';
import { ValidationError } from './errors';

const validators = {
  species: validateSpecies as ValidateFunction<SpeciesEntryV1>,
  catalog: validateCatalog as ValidateFunction<SpeciesCatalogV1>,
  document: validateDocument as ValidateFunction<FrogLabelDocumentV1>,
  taskData: validateTaskData as ValidateFunction<FrogLabelHostDataV1>,
  localFile: validateLocalFile as ValidateFunction<FrogLabelLocalFileV1>,
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

export function speciesSnapshot(species: SpeciesEntryV1) {
  return {
    speciesId: species.speciesId,
    code: species.code,
    speciesName: species.speciesName,
    ...(species.scientificName ? { scientificName: species.scientificName } : {}),
    addedAfterInitialization: species.addedAfterInitialization,
  };
}

export function assertSpecies(value: unknown): asserts value is SpeciesEntryV1 {
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

export function assertCatalog(value: unknown): asserts value is SpeciesCatalogV1 {
  assertSchema(validators.catalog, value, 'Species catalog');
  const ids = new Set<string>();
  const codes = new Set<string>();
  const entries = new Map(value.species.map((entry) => [entry.speciesId, entry]));
  for (const entry of value.species) {
    assertSpecies(entry);
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

export function assertDocument(
  value: unknown,
  bounds?: AudioBounds,
): asserts value is FrogLabelDocumentV1 {
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

export function assertLocalFile(value: unknown): asserts value is FrogLabelLocalFileV1 {
  assertSchema(validators.localFile, value, 'Local annotation file');
  const decodedChannelSamples =
    value.audio.durationSeconds * value.audio.sampleRateHz * value.audio.channelCount;
  if (decodedChannelSamples > 30_000_000) {
    throw new ValidationError(
      'Local audio metadata exceeds the 30000000 decoded channel-sample limit',
    );
  }
  const snapshotCatalog: SpeciesCatalogV1 = {
    kind: 'froglabel.species-catalog',
    schemaVersion: 1,
    catalogId: value.document?.catalogId ?? `local:${value.audio.fingerprint.value}`,
    catalogRevision: 1,
    initializedAt: new Date(0).toISOString(),
    initializedBy: 'Local file validation',
    defaultSpeciesId: null,
    species: value.catalogSnapshot,
  };
  assertCatalog(snapshotCatalog);
  if (value.document) {
    assertDocument(value.document, {
      durationSeconds: value.audio.durationSeconds,
      maximumFrequencyHz: value.audio.sampleRateHz / 2,
      analysisSampleRateHz: value.audio.sampleRateHz,
    });
    const byId = new Map(value.catalogSnapshot.map((entry) => [entry.speciesId, entry]));
    for (const box of value.document.boxes) {
      if (!byId.has(box.species.speciesId)) {
        throw new ValidationError('Box species is absent from the catalog snapshot', box.id);
      }
    }
  }
}

export function isReactCodeHostMessage(value: unknown): boolean {
  if (!validators.message(value) || !value || typeof value !== 'object') return false;
  return HOST_MESSAGE_TYPES.has(String((value as { type?: unknown }).type));
}

export function validationErrorsForMessage(): string {
  return formatErrors(validators.message.errors);
}
