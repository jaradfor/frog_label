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

export interface EnterpriseInlineRegion {
  id: string;
  value: unknown;
  update?: (value: FrogLabelDocumentV1) => unknown;
  delete?: () => unknown;
  selected?: boolean;
  hidden?: boolean;
  locked?: boolean;
  origin?: string;
}

export interface EnterpriseInlineHostProps {
  React: unknown;
  addRegion: (
    value: FrogLabelDocumentV1,
    extraData?: { displayText?: string },
  ) => EnterpriseInlineRegion | unknown;
  regions?: readonly unknown[] | null;
  data?: unknown;
  viewState?: Record<string, unknown> | null;
}

interface PendingEcho {
  epoch: number;
  expected: FrogLabelDocumentV1 | null;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Direct adapter for Label Studio Enterprise's documented inline ReactCode props.
 * Region props remain authoritative; mutations resolve only after an equivalent
 * region echo is observed.
 */
export class EnterpriseInlineReactCodePort implements AnnotationDocumentPort {
  private readonly listeners = new Set<(snapshot: HostSnapshot) => void>();
  private readonly mutationTimeoutMilliseconds: number;
  private props: EnterpriseInlineHostProps;
  private regions: EnterpriseInlineRegion[] = [];
  private contextSignature = '';
  private snapshot: HostSnapshot = emptySnapshot();
  private status: HostStatus = { phase: 'waiting', locked: true };
  private pending: PendingEcho | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private destroyed = false;

  constructor(
    props: EnterpriseInlineHostProps,
    options: { mutationTimeoutMilliseconds?: number } = {},
  ) {
    this.props = props;
    this.mutationTimeoutMilliseconds = options.mutationTimeoutMilliseconds ?? 5_000;
    this.updateContext(props);
  }

  updateContext(props: EnterpriseInlineHostProps): void {
    this.ensureAlive();
    this.props = props;
    try {
      const data = normalizeData(props.data);
      const signature = stableValue(data);
      const nextRegions = readRegions(props.regions);
      const priorRegionId = this.snapshot.regionId;
      const nextRegionId = nextRegions[0]?.id ?? null;
      const changedTask = this.contextSignature !== '' && signature !== this.contextSignature;
      const changedAnnotation =
        priorRegionId !== null && nextRegionId !== null && priorRegionId !== nextRegionId;
      if (changedTask || changedAnnotation) this.beginEpoch();
      if (this.snapshot.epoch === 0) this.snapshot = { ...this.snapshot, epoch: 1 };
      this.contextSignature = signature;
      this.regions = nextRegions;
      this.reconcile(data, props.viewState ?? null);
    } catch (error) {
      this.fail(
        'ENTERPRISE_HOST_CONTEXT_INVALID',
        error instanceof Error ? error.message : 'The Enterprise ReactCode context is invalid.',
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
      new IntegrationError('ENTERPRISE_HOST_DESTROYED', 'The inline host connection closed.'),
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
    const canUpdate = !region || typeof region.update === 'function';
    const canDelete = !region || typeof region.delete === 'function';
    const warmup = data === null;
    const locked =
      warmup ||
      region?.locked === true ||
      viewState?.locked === true ||
      viewState?.editable === false ||
      !canUpdate ||
      !canDelete;
    this.snapshot = {
      ...this.snapshot,
      tag: 'froglabel',
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
        this.props.addRegion(next, { displayText: summaryText(next) });
      } else if (next && region) {
        if (typeof region.update !== 'function') {
          throw new IntegrationError(
            'ENTERPRISE_UPDATE_UNAVAILABLE',
            'The host region does not expose the documented update(value) method.',
          );
        }
        region.update(next);
      } else if (region) {
        if (typeof region.delete !== 'function') {
          throw new IntegrationError(
            'ENTERPRISE_DELETE_UNAVAILABLE',
            'The host region does not expose the documented delete() method.',
          );
        }
        region.delete();
      }
    } catch (error) {
      const failure =
        error instanceof Error ? error : new Error('The Enterprise region mutation failed.');
      this.rejectPending(failure);
      this.fail('ENTERPRISE_MUTATION_REJECTED', failure.message);
      throw failure;
    }
    // Observable host arrays commonly change synchronously. Reading the same
    // documented prop objects here gives immediate gesture-before-Submit safety
    // without fabricating an optimistic region.
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
          'Label Studio did not echo the inline region mutation.',
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
      throw new IntegrationError('ENTERPRISE_HOST_DESTROYED', 'The inline host connection closed.');
    }
  }
}

function emptySnapshot(): HostSnapshot {
  return {
    epoch: 0,
    tag: 'froglabel',
    data: null,
    document: null,
    regionId: null,
    locked: true,
    hidden: false,
    viewState: null,
  };
}

function normalizeData(value: unknown): FrogLabelHostDataV1 | null {
  if (value === undefined || value === null) return null;
  assertHostData(value);
  return structuredClone(value);
}

function readRegions(value: readonly unknown[] | null | undefined): EnterpriseInlineRegion[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ValidationError('Enterprise regions must be an array');
  return value.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new ValidationError('Enterprise region must be an object');
    }
    const candidate = item as Partial<EnterpriseInlineRegion>;
    if (typeof candidate.id !== 'string' || !candidate.id) {
      throw new ValidationError('Enterprise region has no stable string ID');
    }
    if (!Object.hasOwn(candidate, 'value')) {
      throw new ValidationError(`Enterprise region ${candidate.id} has no value`);
    }
    return candidate as EnterpriseInlineRegion;
  });
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
  if (value === null) return 'null';
  if (typeof value === 'string') return `string:${value}`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify(Object.fromEntries(entries));
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
