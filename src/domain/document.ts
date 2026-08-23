import type { AudioBounds, FrogLabelBoxV2, FrogLabelDocument, SpeciesEntry } from './types';
import { ValidationError } from './errors';
import { assertDocument, speciesSnapshot } from './validation';

export function createStableId(prefix = 'local'): string {
  const cryptoApi = typeof crypto === 'undefined' ? null : crypto;
  if (!cryptoApi) throw new ValidationError('Secure random IDs are unavailable in this browser');
  const uuid =
    typeof cryptoApi.randomUUID === 'function'
      ? cryptoApi.randomUUID()
      : uuidFromRandomBytes(cryptoApi.getRandomValues(new Uint8Array(16)));
  return `${prefix}:${uuid}`;
}

export function sortBoxes(boxes: readonly FrogLabelBoxV2[]): FrogLabelBoxV2[] {
  return [...boxes].sort(
    (left, right) =>
      left.startTimeSeconds - right.startTimeSeconds ||
      left.lowFrequencyHz - right.lowFrequencyHz ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

export function createHumanBox(
  species: SpeciesEntry,
  geometry: Pick<
    FrogLabelBoxV2,
    'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
  >,
  id: string,
  now: string,
): FrogLabelBoxV2 {
  return {
    id,
    species: speciesSnapshot(species),
    ...geometry,
    createdAt: now,
    updatedAt: now,
    provenance: { source: 'human' },
  };
}

export function documentFromBoxes(
  catalogId: string,
  boxes: readonly FrogLabelBoxV2[],
  bounds?: AudioBounds,
): FrogLabelDocument | null {
  if (boxes.length === 0) return null;
  const document: FrogLabelDocument = {
    kind: 'froglabel.annotation-set',
    schemaVersion: 2,
    catalogId,
    reviewStatus: 'calls_present',
    boxes: sortBoxes(boxes),
  };
  assertDocument(document, bounds);
  return document;
}

export function noCallsDocument(catalogId: string): FrogLabelDocument {
  return {
    kind: 'froglabel.annotation-set',
    schemaVersion: 2,
    catalogId,
    reviewStatus: 'no_calls',
    boxes: [],
  };
}

export function deterministicSerialize(document: FrogLabelDocument | null): string {
  return deterministicJson(document ? { ...document, boxes: sortBoxes(document.boxes) } : null);
}

export function deterministicJson(value: unknown, space?: number): string {
  return JSON.stringify(canonicalizeJson(value), null, space);
}

export function cloneDocument(document: FrogLabelDocument | null): FrogLabelDocument | null {
  return document ? structuredClone(document) : null;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  return value;
}

function uuidFromRandomBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
