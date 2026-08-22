import type {
  FrogLabelDocumentV1,
  FrogLabelLocalFileV1,
  LocalAudioDescriptor,
  SpeciesCatalogV1,
  SpeciesEntryV1,
} from '../../domain/types';
import { deterministicJson, deterministicSerialize } from '../../domain/document';
import { ValidationError } from '../../domain/errors';
import { assertCatalog, assertDocument, assertLocalFile } from '../../domain/validation';
import type { LoadedAudio } from '../../audio/AudioResource';
import { AUDIO_LIMITS } from '../../audio/wav';

export const MAX_LOCAL_AUDIO_BYTES = AUDIO_LIMITS.maximumFileBytes;
export const MAX_LOCAL_JSON_BYTES = 10 * 1024 * 1024;

export async function fingerprintFile(
  file: File,
  signal?: AbortSignal,
): Promise<LocalAudioDescriptor['fingerprint']> {
  if (file.size > MAX_LOCAL_AUDIO_BYTES)
    throw new ValidationError('Audio exceeds the 128 MiB local limit');
  if (signal?.aborted) throw new DOMException('Fingerprint cancelled', 'AbortError');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  if (signal?.aborted) throw new DOMException('Fingerprint cancelled', 'AbortError');
  return {
    algorithm: 'sha256',
    value: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    scope: 'file-bytes',
  };
}

export function buildLocalFile(
  audio: LocalAudioDescriptor,
  catalog: SpeciesCatalogV1,
  document: FrogLabelDocumentV1 | null,
): FrogLabelLocalFileV1 {
  if (document)
    assertDocument(document, {
      durationSeconds: audio.durationSeconds,
      maximumFrequencyHz: audio.sampleRateHz / 2,
    });
  const value: FrogLabelLocalFileV1 = {
    kind: 'froglabel.local-file',
    schemaVersion: 1,
    audio: structuredClone(audio),
    catalogSnapshot: structuredClone(catalog.species),
    document: structuredClone(document),
  };
  assertLocalFile(value);
  return value;
}

export function serializeLocalFile(value: FrogLabelLocalFileV1): string {
  assertLocalFile(value);
  return `${deterministicJson(value, 2)}\n`;
}

export async function parseLocalFile(file: File): Promise<FrogLabelLocalFileV1> {
  if (file.size > MAX_LOCAL_JSON_BYTES)
    throw new ValidationError('Annotation file exceeds the 10 MiB limit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new ValidationError('Annotation file is not valid JSON');
  }
  if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
    const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
    if (typeof version === 'number' && version > 1) {
      throw new ValidationError('This file was created by a newer FrogLabel version');
    }
  }
  assertLocalFile(parsed);
  return structuredClone(parsed);
}

export async function assertMatchingAudio(
  file: File,
  descriptor: LocalAudioDescriptor,
  signal?: AbortSignal,
): Promise<LocalAudioDescriptor['fingerprint']> {
  if (file.size !== descriptor.sizeBytes) {
    throw new ValidationError(
      `Audio mismatch: expected ${descriptor.filename} (${descriptor.sizeBytes} bytes), received ${file.name} (${file.size} bytes)`,
    );
  }
  const fingerprint = await fingerprintFile(file, signal);
  if (fingerprint.value !== descriptor.fingerprint.value) {
    throw new ValidationError(
      `Audio mismatch: expected ${descriptor.filename} (${descriptor.sizeBytes} bytes), received ${file.name} (${file.size} bytes)`,
    );
  }
  return fingerprint;
}

export function catalogFromLocalFile(value: FrogLabelLocalFileV1): SpeciesCatalogV1 {
  const catalog: SpeciesCatalogV1 = {
    schemaVersion: 1,
    kind: 'froglabel.species-catalog',
    catalogId: value.document?.catalogId ?? `local:${value.audio.fingerprint.value}`,
    initializedAt: new Date(0).toISOString(),
    initializedBy: 'FrogLabel local-file resume',
    catalogRevision: 1,
    defaultSpeciesId: null,
    species: structuredClone(value.catalogSnapshot),
  };
  assertCatalog(catalog);
  return catalog;
}

export function mergeCatalogSnapshots(
  current: SpeciesCatalogV1,
  candidate: readonly SpeciesEntryV1[],
): SpeciesCatalogV1 {
  const byId = new Map(current.species.map((entry) => [entry.speciesId, entry]));
  const byCode = new Map(
    current.species.map((entry) => [entry.code.toLocaleLowerCase('en'), entry.speciesId]),
  );
  const additions: SpeciesEntryV1[] = [];
  for (const entry of candidate) {
    const existing = byId.get(entry.speciesId);
    if (existing) {
      if (deterministicJson(existing) !== deterministicJson(entry)) {
        throw new ValidationError(`Species ID ${entry.speciesId} has conflicting snapshots`);
      }
      continue;
    }
    const codeOwner = byCode.get(entry.code.toLocaleLowerCase('en'));
    if (codeOwner) {
      throw new ValidationError(
        `Species code ${entry.code} conflicts with immutable ID ${codeOwner}`,
      );
    }
    additions.push(structuredClone(entry));
    byId.set(entry.speciesId, entry);
    byCode.set(entry.code.toLocaleLowerCase('en'), entry.speciesId);
  }
  const merged = {
    ...structuredClone(current),
    catalogRevision: additions.length ? current.catalogRevision + 1 : current.catalogRevision,
    species: [...current.species, ...additions],
  };
  assertCatalog(merged);
  return merged;
}

export function downloadLocalFile(value: FrogLabelLocalFileV1): void {
  downloadText(
    serializeLocalFile(value),
    `${safeStem(value.audio.filename)}.froglabel.json`,
    'application/json',
  );
}

export function serializeFlatCsv(value: FrogLabelLocalFileV1): string {
  assertLocalFile(value);
  const headers = [
    'schemaVersion',
    'recordType',
    'audioFilename',
    'audioSha256',
    'audioByteLength',
    'boxId',
    'startTimeSeconds',
    'endTimeSeconds',
    'lowFrequencyHz',
    'highFrequencyHz',
    'speciesId',
    'code',
    'speciesName',
    'addedAfterInitialization',
    'reviewStatus',
    'provenanceSource',
  ];
  const common = [
    '1',
    '',
    value.audio.filename,
    value.audio.fingerprint.value,
    String(value.audio.sizeBytes),
  ];
  const rows: string[][] = [];
  if (!value.document || value.document.reviewStatus === 'no_calls') {
    rows.push([
      ...common.slice(0, 1),
      'review',
      ...common.slice(2),
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      value.document?.reviewStatus ?? 'unreviewed',
      '',
    ]);
  } else {
    for (const box of value.document.boxes) {
      rows.push([
        '1',
        'box',
        value.audio.filename,
        value.audio.fingerprint.value,
        String(value.audio.sizeBytes),
        box.id,
        numberCell(box.startTimeSeconds),
        numberCell(box.endTimeSeconds),
        numberCell(box.lowFrequencyHz),
        numberCell(box.highFrequencyHz),
        box.species.speciesId,
        box.species.code,
        box.species.speciesName,
        String(box.species.addedAfterInitialization),
        value.document.reviewStatus,
        box.provenance.source,
      ]);
    }
  }
  return `${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function downloadFlatCsv(value: FrogLabelLocalFileV1): void {
  downloadText(
    serializeFlatCsv(value),
    `${safeStem(value.audio.filename)}.froglabel.csv`,
    'text/csv;charset=utf-8',
  );
}

export function localDescriptorFromAudio(
  audio: LoadedAudio,
  fingerprint: LocalAudioDescriptor['fingerprint'],
  sizeBytes: number,
  mimeType?: string,
): LocalAudioDescriptor {
  return {
    filename: audio.source.filename,
    sizeBytes,
    ...(mimeType ? { mimeType } : {}),
    durationSeconds: audio.durationSeconds,
    sampleRateHz: audio.analysis.sampleRateHz,
    channelCount: audio.channelCount,
    fingerprint,
  };
}

export function localFileDocumentSignature(value: FrogLabelLocalFileV1): string {
  return deterministicSerialize(value.document);
}

function numberCell(value: number): string {
  return Number.isFinite(value) ? value.toString() : '';
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(safe) ? `"${safe.replace(/"/gu, '""')}"` : safe;
}

function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking in the same microtask can abort Chromium's asynchronous download
  // request even after the download event has fired. Keep this small blob alive
  // briefly; closing the page also releases it.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function safeStem(filename: string): string {
  return (
    filename
      .replace(/\.[^.]+$/u, '')
      .replace(/[^\p{L}\p{N}._-]+/gu, '_')
      .slice(0, 120) || 'annotations'
  );
}
