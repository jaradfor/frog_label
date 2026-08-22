import { cloneDocument, deterministicSerialize } from '../../domain/document';
import { IntegrationError, ValidationError } from '../../domain/errors';
import { migrateDocument } from '../../domain/migrations';
import type {
  FrogLabelDocumentV1,
  FrogLabelHostDataV1,
  HostCapabilities,
  HostSnapshot,
  HostStatus,
  MutationReason,
  StructuredError,
} from '../../domain/types';
import { assertDocument, assertHostData } from '../../domain/validation';
import type { AnnotationDocumentPort } from '../../ports/AnnotationDocumentPort';

export const FROGLABEL_OUTPUT_NAME = 'froglabel';
export const FROGLABEL_TARGET_NAME = 'audio';

export interface EnterpriseInterfaceTask {
  id?: number | string;
  data?: Record<string, unknown>;
}

export interface EnterpriseInterfaceScreenRegion {
  id: string;
  type?: string;
  labels?: readonly string[];
  colors?: readonly string[];
  score?: number | null;
  hidden?: boolean;
  locked?: boolean;
  selected?: boolean;
  parentId?: string | null;
  text?: string;
  origin?: string;
  _froglabelDocument?: unknown;
  _froglabelPendingValue?: readonly unknown[];
  [key: string]: unknown;
}

export interface EnterpriseInterfaceRelation {
  id: string;
  node1Id: string;
  node2Id: string;
  direction?: string;
  labels?: readonly string[] | null;
  visible?: boolean;
}

export interface EnterpriseInterfaceHostProps {
  task?: EnterpriseInterfaceTask | null;
  regions?: readonly unknown[] | null;
  relations?: readonly unknown[] | null;
  params?: Record<string, unknown> | null;
  readOnly?: boolean;
  addRegion(region: EnterpriseInterfaceScreenRegion): unknown;
  updateRegion(id: string, patch: Partial<EnterpriseInterfaceScreenRegion>): unknown;
  deleteRegion(id: string): unknown;
}

interface EnterpriseDocumentRegion {
  id: string;
  value: unknown;
  update(value: FrogLabelDocumentV1): unknown;
  delete(): unknown;
  selected?: boolean;
  hidden?: boolean;
  locked?: boolean;
  origin?: string;
}

interface PendingEcho {
  epoch: number;
  expected: FrogLabelDocumentV1 | null;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Adapter for the current Label Studio Enterprise Interfaces controlled-component
 * runtime. Shell regions remain authoritative; mutations resolve only after an
 * equivalent region echo is observed.
 */
export class EnterpriseInterfacePort implements AnnotationDocumentPort {
  private readonly listeners = new Set<(snapshot: HostSnapshot) => void>();
  private readonly mutationTimeoutMilliseconds: number;
  private props: EnterpriseInterfaceHostProps;
  private regions: EnterpriseDocumentRegion[] = [];
  private contextSignature = '';
  private snapshot: HostSnapshot = emptySnapshot();
  private status: HostStatus = { phase: 'waiting', locked: true };
  private pending: PendingEcho | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(
    props: EnterpriseInterfaceHostProps,
    options: { mutationTimeoutMilliseconds?: number } = {},
  ) {
    this.props = props;
    this.mutationTimeoutMilliseconds = options.mutationTimeoutMilliseconds ?? 5_000;
    this.updateContext(props);
  }

  updateContext(props: EnterpriseInterfaceHostProps): void {
    this.ensureAlive();
    this.props = props;
    try {
      const data = normalizeTaskData(props.task?.data, props.params);
      const signature = stableValue({ taskId: props.task?.id ?? null, data });
      const nextRegions = readRegions(props);
      const priorRegionId = this.snapshot.regionId;
      const nextRegionId = nextRegions[0]?.id ?? null;
      const changedTask = this.contextSignature !== '' && signature !== this.contextSignature;
      const changedAnnotation =
        priorRegionId !== null && nextRegionId !== null && priorRegionId !== nextRegionId;
      if (changedTask || changedAnnotation) this.beginEpoch();
      if (this.snapshot.epoch === 0) this.snapshot = { ...this.snapshot, epoch: 1 };
      this.contextSignature = signature;
      this.regions = nextRegions;
      this.reconcile(data, {
        editable: props.readOnly !== true,
        locked: props.readOnly === true,
      });
    } catch (error) {
      this.fail(
        'ENTERPRISE_HOST_CONTEXT_INVALID',
        error instanceof Error ? error.message : 'The Enterprise Interface context is invalid.',
      );
    }
  }

  subscribe(listener: (snapshot: HostSnapshot) => void): () => void {
    this.ensureAlive();
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): HostSnapshot {
    return structuredClone(this.snapshot);
  }

  getEpoch(): number {
    return this.snapshot.epoch;
  }

  getStatus(): HostStatus {
    return structuredClone(this.status);
  }

  getCapabilities(): HostCapabilities {
    return {
      editable: this.status.phase === 'ready' && !this.snapshot.locked,
      catalogRead: true,
      catalogCreate: true,
      localFiles: false,
    };
  }

  replaceDocument(next: FrogLabelDocumentV1 | null, reason: MutationReason): Promise<void> {
    this.ensureAlive();
    const operation = () => this.performMutation(cloneDocument(next), reason);
    const queued = this.mutationTail.then(operation, operation);
    this.mutationTail = queued.catch(() => undefined);
    return queued;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rejectPending(
      new IntegrationError('ENTERPRISE_HOST_DESTROYED', 'The Interface host connection closed.'),
    );
    this.listeners.clear();
    this.regions = [];
  }

  private reconcile(
    data: FrogLabelHostDataV1 | null,
    viewState: Record<string, unknown> | null,
  ): void {
    if (this.regions.length > 1) {
      throw new ValidationError('More than one FrogLabel document exists in this annotation');
    }
    const region = this.regions[0] ?? null;
    const document = region ? migrateDocument(region.value) : null;
    if (document) assertDocument(document);
    const warmup = data === null;
    const locked =
      warmup ||
      region?.locked === true ||
      viewState?.locked === true ||
      viewState?.editable === false;
    this.snapshot = {
      ...this.snapshot,
      tag: FROGLABEL_OUTPUT_NAME,
      data,
      document,
      regionId: region?.id ?? null,
      locked,
      hidden: region?.hidden === true,
      ...(typeof region?.origin === 'string' ? { origin: region.origin } : { origin: undefined }),
      viewState: copyViewState(viewState),
    };
    const awaitingDifferentEcho =
      this.pending?.epoch === this.snapshot.epoch &&
      !documentsEqual(this.pending.expected, document);
    this.status = awaitingDifferentEcho
      ? { phase: 'saving', locked }
      : { phase: warmup ? 'waiting' : locked ? 'read-only' : 'ready', locked };
    this.resolveEchoIfMatched();
    this.emit();
  }

  private async performMutation(
    next: FrogLabelDocumentV1 | null,
    _reason: MutationReason,
  ): Promise<void> {
    if (this.status.phase === 'error') {
      throw new IntegrationError(
        this.status.error?.code ?? 'ENTERPRISE_HOST_ERROR',
        this.status.error?.message ?? 'The Enterprise host is in an error state.',
      );
    }
    if (this.snapshot.locked || this.status.phase !== 'ready') {
      throw new IntegrationError(
        'ENTERPRISE_HOST_READ_ONLY',
        'This Label Studio annotation cannot be edited in the current context.',
      );
    }
    if (next) assertDocument(next);
    if (documentsEqual(this.snapshot.document, next)) return;
    const region = this.regions[0] ?? null;
    if (!next && !region) return;

    const acknowledgement = this.waitForEcho(next);
    this.status = { phase: 'saving', locked: false };
    this.emit();
    try {
      if (next && !region) {
        this.props.addRegion(toScreenRegion(mintRegionId('froglabel'), next));
      } else if (next && region) {
        region.update(next);
      } else if (region) {
        region.delete();
      }
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error('The Enterprise region mutation failed.');
      this.rejectPending(failure);
      this.fail('ENTERPRISE_MUTATION_REJECTED', failure.message);
      throw failure;
    }
    // The controlled shell normally re-renders immediately. This microtask also
    // supports hosts that mutate their region array synchronously.
    queueMicrotask(() => {
      if (!this.destroyed) this.updateContext(this.props);
    });
    return acknowledgement;
  }

  private waitForEcho(expected: FrogLabelDocumentV1 | null): Promise<void> {
    const epoch = this.snapshot.epoch;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.epoch !== epoch) return;
        this.pending = null;
        const error = new IntegrationError(
          'ENTERPRISE_SAVE_TIMEOUT',
          'Label Studio did not echo the Interface region mutation.',
        );
        this.fail(error.code, error.message, 'Reload the task and retry the completed edit.');
        reject(error);
      }, this.mutationTimeoutMilliseconds);
      this.pending = { epoch, expected: cloneDocument(expected), resolve, reject, timer };
    });
  }

  private resolveEchoIfMatched(): void {
    if (!this.pending || this.pending.epoch !== this.snapshot.epoch) return;
    if (!documentsEqual(this.pending.expected, this.snapshot.document)) return;
    const pending = this.pending;
    clearTimeout(pending.timer);
    this.pending = null;
    this.status = {
      phase: this.snapshot.locked ? 'read-only' : 'ready',
      locked: this.snapshot.locked,
    };
    pending.resolve();
  }

  private beginEpoch(): void {
    this.rejectPending(
      new IntegrationError(
        'ENTERPRISE_EPOCH_CHANGED',
        'The task or annotation changed before the mutation was acknowledged.',
      ),
    );
    this.snapshot = { ...emptySnapshot(), epoch: this.snapshot.epoch + 1 };
    this.regions = [];
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    const pending = this.pending;
    this.pending = null;
    pending.reject(error);
  }

  private fail(code: string, message: string, repair?: string): void {
    this.rejectPending(new IntegrationError(code, message));
    const error: StructuredError = { code, message, ...(repair ? { repair } : {}) };
    this.snapshot = { ...this.snapshot, locked: true };
    this.status = { phase: 'error', locked: true, error };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private ensureAlive(): void {
    if (this.destroyed) {
      throw new IntegrationError(
        'ENTERPRISE_HOST_DESTROYED',
        'The Interface host connection closed.',
      );
    }
  }
}

export const enterpriseParamsSchema = {
  type: 'object',
  properties: {
    audioField: {
      type: 'string',
      title: 'Audio field',
      default: 'audio',
      description: 'Task data path containing the audio URL.',
    },
    filenameField: {
      type: 'string',
      title: 'Filename field',
      default: 'filename',
    },
    mimeTypeField: {
      type: 'string',
      title: 'MIME type field',
      default: 'mime_type',
    },
    durationField: {
      type: 'string',
      title: 'Duration field',
      default: 'duration_seconds',
    },
    sampleRateField: {
      type: 'string',
      title: 'Sample-rate field',
      default: 'sample_rate_hz',
    },
  },
  required: ['audioField'],
};

export const enterpriseInputSchema = {
  type: 'object',
  properties: {
    audio: {
      type: 'dataField',
      default: 'audio',
      title: 'Audio',
    },
  },
};

export const enterpriseOutputSchema = {
  type: 'object',
  properties: {
    froglabel: {
      type: 'array',
      title: 'FrogLabel annotation document',
      description: 'One lossless, versioned FrogLabel annotation-set document.',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        required: ['kind', 'schemaVersion', 'catalogId', 'reviewStatus', 'boxes'],
        properties: {
          kind: { const: 'froglabel.annotation-set' },
          schemaVersion: { const: 1 },
          catalogId: { type: 'string' },
          reviewStatus: { enum: ['calls_present', 'no_calls'] },
          boxes: { type: 'array', items: { type: 'object' } },
        },
      },
    },
  },
  required: ['froglabel'],
};

export function getEnterpriseInterfaceResults(
  regions: readonly unknown[] | null | undefined,
  relations: readonly unknown[] | null | undefined,
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const item of regions ?? []) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' && item.id ? item.id : mintRegionId('froglabel-result');
    if (Object.hasOwn(item, '_froglabelPendingValue')) {
      result.push({
        id,
        from_name: FROGLABEL_OUTPUT_NAME,
        to_name: FROGLABEL_TARGET_NAME,
        type: 'labels',
        value: Array.isArray(item._froglabelPendingValue)
          ? structuredClone(item._froglabelPendingValue)
          : [],
        origin: typeof item.origin === 'string' ? item.origin : 'manual',
      });
      continue;
    }
    if (!Object.hasOwn(item, '_froglabelDocument')) continue;
    const document = migrateDocument(item._froglabelDocument);
    if (!document) continue;
    assertDocument(document);
    result.push({
      id,
      from_name: FROGLABEL_OUTPUT_NAME,
      to_name: FROGLABEL_TARGET_NAME,
      type: 'labels',
      value: [cloneDocument(document)],
      origin: typeof item.origin === 'string' ? item.origin : 'manual',
    });
  }
  for (const item of relations ?? []) {
    if (!isRecord(item)) continue;
    const node1Id = asNonEmptyString(item.node1Id);
    const node2Id = asNonEmptyString(item.node2Id);
    if (!node1Id || !node2Id) continue;
    result.push({
      id: asNonEmptyString(item.id) ?? mintRegionId('froglabel-relation'),
      from_name: '',
      to_name: '',
      type: 'relation',
      value: {},
      from_id: node1Id,
      to_id: node2Id,
      direction: asNonEmptyString(item.direction) ?? 'right',
      labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
    });
  }
  return result;
}

export function parseEnterpriseInterfaceResults(results: readonly unknown[] | null | undefined): {
  regions: EnterpriseInterfaceScreenRegion[];
  relations: EnterpriseInterfaceRelation[];
} {
  const regions: EnterpriseInterfaceScreenRegion[] = [];
  const relationResults: Record<string, unknown>[] = [];
  for (const item of results ?? []) {
    if (!isRecord(item)) continue;
    if (item.type === 'relation') {
      relationResults.push(item);
      continue;
    }
    if (readResultName(item) !== FROGLABEL_OUTPUT_NAME) continue;
    const id = asNonEmptyString(item.id) ?? mintRegionId('froglabel-loaded');
    const document = readResultDocument(item);
    if (document) {
      regions.push(toScreenRegion(id, document, item));
      continue;
    }
    regions.push({
      id,
      type: 'textarea',
      labels: [],
      colors: [],
      score: typeof item.score === 'number' ? item.score : null,
      hidden: false,
      locked: false,
      selected: false,
      parentId: null,
      text: 'Open FrogLabel to complete this annotation.',
      _froglabelPendingValue: Array.isArray(item.value) ? structuredClone(item.value) : [],
    });
  }

  const byId = new Map(regions.map((region) => [region.id, region]));
  const relations = relationResults.flatMap((item) => {
    const node1Id = asNonEmptyString(item.from_id ?? item.node1Id);
    const node2Id = asNonEmptyString(item.to_id ?? item.node2Id);
    if (!node1Id || !node2Id) return [];
    const node1 = byId.get(node1Id);
    const node2 = byId.get(node2Id);
    return [
      {
        id: asNonEmptyString(item.id) ?? mintRegionId('froglabel-relation-loaded'),
        direction: asNonEmptyString(item.direction) ?? 'right',
        visible: true,
        labels: Array.isArray(item.labels) ? item.labels.map(String) : null,
        node1Label: node1?.text || node1?.type || node1Id,
        node2Label: node2?.text || node2?.type || node2Id,
        node1Id,
        node2Id,
      },
    ];
  });
  return { regions, relations };
}

function emptySnapshot(): HostSnapshot {
  return {
    epoch: 0,
    tag: FROGLABEL_OUTPUT_NAME,
    data: null,
    document: null,
    regionId: null,
    locked: true,
    hidden: false,
    viewState: null,
  };
}

function normalizeTaskData(
  value: Record<string, unknown> | undefined,
  params: Record<string, unknown> | null | undefined,
): FrogLabelHostDataV1 | null {
  if (value === undefined) return null;
  if (typeof value.froglabel === 'string') {
    assertHostData(value);
    return structuredClone(value) as FrogLabelHostDataV1;
  }
  const audioField = stringParam(params, 'audioField', 'audio');
  const audio = getTaskField(value, audioField);
  if (typeof audio !== 'string' || !audio) {
    throw new ValidationError(`Task field ${audioField} must contain a non-empty audio URL`);
  }
  const metadata: Record<string, unknown> = {};
  const filename = getTaskField(value, stringParam(params, 'filenameField', 'filename'));
  const mimeType = getTaskField(value, stringParam(params, 'mimeTypeField', 'mime_type'));
  const duration = Number(
    getTaskField(value, stringParam(params, 'durationField', 'duration_seconds')),
  );
  const sampleRate = Number(
    getTaskField(value, stringParam(params, 'sampleRateField', 'sample_rate_hz')),
  );
  if (typeof filename === 'string' && filename) metadata.filename = filename;
  if (typeof mimeType === 'string' && mimeType) metadata.mimeType = mimeType;
  if (Number.isFinite(duration) && duration > 0 && duration <= 30) {
    metadata.durationSeconds = duration;
  }
  if (Number.isFinite(sampleRate) && sampleRate > 0 && sampleRate <= 192_000) {
    metadata.sampleRateHz = sampleRate;
  }
  const normalized: FrogLabelHostDataV1 = {
    froglabel: audio,
    froglabelConfig: {
      schemaVersion: 1,
      ...(Object.keys(metadata).length ? { audio: metadata } : {}),
    },
  };
  assertHostData(normalized);
  return normalized;
}

function readRegions(props: EnterpriseInterfaceHostProps): EnterpriseDocumentRegion[] {
  const value = props.regions;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('Enterprise regions must be an array');
  const result: EnterpriseDocumentRegion[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Object.hasOwn(item, '_froglabelDocument')) continue;
    const id = asNonEmptyString(item.id);
    if (!id) throw new ValidationError('Enterprise FrogLabel region has no stable string ID');
    result.push({
      id,
      value: item._froglabelDocument,
      update: (document) => props.updateRegion(id, toScreenRegionPatch(document)),
      delete: () => props.deleteRegion(id),
      selected: item.selected === true,
      hidden: item.hidden === true,
      locked: item.locked === true,
      ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
    });
  }
  return result;
}

function toScreenRegion(
  id: string,
  document: FrogLabelDocumentV1,
  source?: Record<string, unknown>,
): EnterpriseInterfaceScreenRegion {
  return {
    id,
    type: 'textarea',
    labels: [],
    colors: ['#65a30d'],
    score: typeof source?.score === 'number' ? source.score : null,
    hidden: source?.hidden === true,
    locked: source?.locked === true,
    selected: source?.selected === true,
    parentId: null,
    text: summaryText(document),
    origin: typeof source?.origin === 'string' ? source.origin : 'manual',
    _froglabelDocument: cloneDocument(document),
  };
}

function toScreenRegionPatch(
  document: FrogLabelDocumentV1,
): Partial<EnterpriseInterfaceScreenRegion> {
  return {
    type: 'textarea',
    text: summaryText(document),
    _froglabelDocument: cloneDocument(document),
  };
}

function readResultDocument(result: Record<string, unknown>): FrogLabelDocumentV1 | null {
  let candidate: unknown = null;
  if (result.type === 'labels' && Array.isArray(result.value) && result.value.length === 1) {
    candidate = result.value[0];
  } else if (result.type === 'reactcode' && isRecord(result.value)) {
    candidate = result.value.reactcode;
  } else {
    const text = readResultText(result);
    if (text) {
      try {
        candidate = JSON.parse(text);
      } catch {
        return null;
      }
    }
  }
  if (candidate === undefined || candidate === null) return null;
  try {
    const document = migrateDocument(candidate);
    if (!document) return null;
    assertDocument(document);
    return document;
  } catch {
    return null;
  }
}

function readResultText(result: Record<string, unknown>): string | null {
  if (!isRecord(result.value)) return typeof result.value === 'string' ? result.value : null;
  const text = result.value.text;
  if (typeof text === 'string') return text;
  if (Array.isArray(text) && typeof text[0] === 'string') return text[0];
  return null;
}

function readResultName(result: Record<string, unknown>): string | null {
  return asNonEmptyString(result.from_name ?? result.fromName);
}

function getTaskField(value: Record<string, unknown>, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stringParam(
  params: Record<string, unknown> | null | undefined,
  key: string,
  fallback: string,
): string {
  const value = params?.[key];
  return typeof value === 'string' && value ? value : fallback;
}

function copyViewState(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (['string', 'number', 'boolean'].includes(typeof item) || item === null) result[key] = item;
  }
  return result;
}

function stableValue(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!isRecord(item)) return item;
    return Object.fromEntries(
      Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
    );
  });
}

function documentsEqual(
  left: FrogLabelDocumentV1 | null,
  right: FrogLabelDocumentV1 | null,
): boolean {
  return left === null || right === null
    ? left === right
    : deterministicSerialize(left) === deterministicSerialize(right);
}

function summaryText(document: FrogLabelDocumentV1): string {
  if (document.reviewStatus === 'no_calls') return 'FrogLabel: no calls';
  return `${document.boxes.length} FrogLabel box${document.boxes.length === 1 ? '' : 'es'}`;
}

function mintRegionId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid
    ? `${prefix}:${uuid}`
    : `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
