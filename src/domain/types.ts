import type { FrequencyScale } from './frequencyScale';

export type ReviewStatus = 'calls_present' | 'no_calls';

export interface ExternalTaxonV1 {
  authority: string;
  id: string;
}

export interface SpeciesEntryV1 {
  schemaVersion: 1;
  kind: 'froglabel.species';
  speciesId: string;
  code: string;
  speciesName: string;
  scientificName?: string;
  externalTaxon?: ExternalTaxonV1;
  addedAfterInitialization: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The active catalog contract. Codes are deliberately limited to physical
 * keys reachable by the operator's left hand; historical annotation snapshots
 * keep their original code instead of being rewritten when a catalog changes.
 */
export interface SpeciesEntryV2 {
  schemaVersion: 2;
  kind: 'froglabel.species';
  speciesId: string;
  code: string;
  selectionPriority: number;
  speciesName: string;
  scientificName?: string;
  externalTaxon?: ExternalTaxonV1;
  addedAfterInitialization: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SpeciesEntry = SpeciesEntryV2;
export type ReadableSpeciesEntry = SpeciesEntryV1 | SpeciesEntryV2;

export interface SpeciesCatalogV1 {
  schemaVersion: 1;
  kind: 'froglabel.species-catalog';
  catalogId: string;
  initializedAt: string;
  initializedBy: string;
  catalogRevision: number;
  defaultSpeciesId: string | null;
  species: SpeciesEntryV1[];
}

export interface SpeciesCatalogV2 {
  schemaVersion: 2;
  kind: 'froglabel.species-catalog';
  catalogId: string;
  initializedAt: string;
  initializedBy: string;
  catalogRevision: number;
  defaultSpeciesId: string | null;
  species: SpeciesEntryV2[];
  /**
   * Validated V1 entries retained for identification and historical display.
   * They are deliberately outside `species`, the active/chord-selectable set.
   */
  historicalSpecies?: SpeciesEntryV1[];
}

export type SpeciesCatalog = SpeciesCatalogV2;
export type ReadableSpeciesCatalog = SpeciesCatalogV1 | SpeciesCatalogV2;

export interface SpeciesSnapshotV1 {
  speciesId: string;
  code: string;
  speciesName: string;
  scientificName?: string;
  addedAfterInitialization: boolean;
}

/** V2 accepts new left-hand codes and unchanged snapshots migrated from V1. */
export interface SpeciesSnapshotV2 {
  speciesId: string;
  code: string;
  /**
   * Present on newly written V2 snapshots so annotation-scoped Enterprise
   * species retain deterministic prefix ordering. Optional for documents
   * written before the field was introduced.
   */
  selectionPriority?: number;
  speciesName: string;
  scientificName?: string;
  addedAfterInitialization: boolean;
}

export interface ModelCandidateV1 {
  rawClass: string;
  score?: number;
  mappedSpeciesId?: string;
}

export type BoxProvenanceV1 =
  | { source: 'human' }
  | {
      source: 'model';
      model: { name: string; version: string; runId?: string };
      sourceDetectionId: string;
      confidence?: number;
      mappingRuleId?: string;
      humanModified: boolean;
      candidates: ModelCandidateV1[];
      attributes?: Record<string, string | number | boolean | null>;
    };

export interface FrogLabelBoxV1 {
  id: string;
  species: SpeciesSnapshotV1;
  startTimeSeconds: number;
  endTimeSeconds: number;
  lowFrequencyHz: number;
  highFrequencyHz: number;
  createdAt?: string;
  updatedAt?: string;
  provenance: BoxProvenanceV1;
}

export interface FrogLabelBoxV2 {
  id: string;
  species: SpeciesSnapshotV2;
  startTimeSeconds: number;
  endTimeSeconds: number;
  lowFrequencyHz: number;
  highFrequencyHz: number;
  createdAt?: string;
  updatedAt?: string;
  provenance: BoxProvenanceV1;
}

export interface FrogLabelDocumentV1 {
  kind: 'froglabel.annotation-set';
  schemaVersion: 1;
  catalogId: string;
  reviewStatus: ReviewStatus;
  boxes: FrogLabelBoxV1[];
}

export interface FrogLabelDocumentV2 {
  kind: 'froglabel.annotation-set';
  schemaVersion: 2;
  catalogId: string;
  reviewStatus: ReviewStatus;
  boxes: FrogLabelBoxV2[];
}

export type FrogLabelDocument = FrogLabelDocumentV2;
export type ReadableFrogLabelDocument = FrogLabelDocumentV1 | FrogLabelDocumentV2;

export type FrogLabelHostDataV1 =
  | string
  | {
      froglabel: string;
      [key: string]: unknown;
      froglabelConfig?: {
        schemaVersion: 1;
        audio?: {
          filename?: string;
          mimeType?: string;
          durationSeconds?: number;
          sampleRateHz?: number;
        };
      };
    };

export type AnalysisChannelMode = 'average' | 'max' | 'left' | 'right';

export interface AudioAnalysisSource {
  sampleRateHz: number;
  channels: readonly Float32Array[];
  channelCount: 1 | 2;
}

export interface AudioMetadataV1 {
  filename: string;
  mimeType?: string;
  durationSeconds: number;
  sampleRateHz: number;
  channelCount: 1 | 2;
  decoder: 'source-faithful-wav' | 'browser-decoded';
}

export interface HostRegion {
  id: string;
  value: FrogLabelDocument;
  selected: boolean;
  hidden: boolean;
  locked: boolean;
  origin?: 'manual' | 'prediction' | string;
}

export interface HostSnapshot {
  epoch: number;
  tag: string | null;
  data: FrogLabelHostDataV1 | null;
  document: FrogLabelDocument | null;
  regionId: string | null;
  locked: boolean;
  hidden: boolean;
  origin?: string;
  viewState?: Record<string, unknown> | null;
}

export type MutationReason =
  | 'box/createCommitted'
  | 'box/resizeCommitted'
  | 'box/delete'
  | 'species/assign'
  | 'review/setNoCalls'
  | 'review/clear'
  | 'history/undo'
  | 'history/redo';

export interface StructuredError {
  code: string;
  message: string;
  detail?: string;
  repair?: string;
}

export interface HostCapabilities {
  editable: boolean;
  catalogRead: boolean;
  catalogCreate: boolean;
  localFiles: boolean;
}

export interface HostStatus {
  phase: 'waiting' | 'ready' | 'saving' | 'error' | 'read-only';
  locked: boolean;
  error?: StructuredError;
}

export interface AudioBounds {
  durationSeconds: number;
  maximumFrequencyHz: number;
  analysisSampleRateHz?: number;
}

export interface ViewportTransform extends AudioBounds {
  timeStartSeconds: number;
  timeEndSeconds: number;
  lowFrequencyHz: number;
  highFrequencyHz: number;
  widthPixels: number;
  heightPixels: number;
  frequencyScale?: FrequencyScale;
  frequencyWarp?: number;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface CanonicalPoint {
  timeSeconds: number;
  frequencyHz: number;
}

export interface LocalAudioDescriptor {
  filename: string;
  sizeBytes: number;
  mimeType?: string;
  durationSeconds: number;
  sampleRateHz: number;
  channelCount: 1 | 2;
  fingerprint: { algorithm: 'sha256'; value: string; scope: 'file-bytes' };
}

export interface FrogLabelLocalFileV1 {
  kind: 'froglabel.local-file';
  schemaVersion: 1;
  audio: LocalAudioDescriptor;
  catalogSnapshot: SpeciesEntryV1[];
  document: FrogLabelDocumentV1 | null;
}

export interface FrogLabelLocalFileV2 {
  kind: 'froglabel.local-file';
  schemaVersion: 2;
  audio: LocalAudioDescriptor;
  catalogSnapshot: SpeciesEntryV2[];
  /** Unmapped V1 catalog records retained without activating their old codes. */
  historicalCatalogSnapshot?: SpeciesEntryV1[];
  document: FrogLabelDocumentV2 | null;
}

export type FrogLabelLocalFile = FrogLabelLocalFileV2;
export type ReadableFrogLabelLocalFile = FrogLabelLocalFileV1 | FrogLabelLocalFileV2;
