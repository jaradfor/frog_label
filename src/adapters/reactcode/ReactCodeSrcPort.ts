import { cloneDocument, deterministicSerialize } from '../../domain/document';
import { IntegrationError, ValidationError } from '../../domain/errors';
import { migrateDocument } from '../../domain/migrations';
import type {
  FrogLabelDocument,
  FrogLabelHostDataV1,
  HostCapabilities,
  HostRegion,
  HostSnapshot,
  HostStatus,
  MutationReason,
  StructuredError,
} from '../../domain/types';
import { assertDocument, assertHostData, isReactCodeHostMessage } from '../../domain/validation';
import type { AnnotationDocumentPort } from '../../ports/AnnotationDocumentPort';

type HostMessage =
  | {
      type: 'init';
      tag: string;
      context: string;
      data: unknown;
      code: string;
      regions: unknown[];
      viewState: Record<string, unknown> | null;
    }
  | {
      type: 'update';
      tag: string;
      context: string;
      data?: unknown;
      regions?: unknown[];
      viewState?: Record<string, unknown> | null;
    }
  | { type: 'regions'; tag: string; context: string; regions: unknown[] }
  | {
      type: 'viewState';
      tag: string;
      context: string;
      viewState: Record<string, unknown> | null;
    };

interface PendingEcho {
  epoch: number;
  expected: FrogLabelDocument | null;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ReactCodeSrcPortOptions {
  window?: Window;
  allowedParentOrigins?: string[];
  readyIntervalMilliseconds?: number;
  mutationTimeoutMilliseconds?: number;
}

export class ReactCodeSrcPort implements AnnotationDocumentPort {
  private readonly runtime: Window;
  private readonly targetOrigin: string;
  private readonly listeners = new Set<(snapshot: HostSnapshot) => void>();
  private readonly readyIntervalMilliseconds: number;
  private readonly mutationTimeoutMilliseconds: number;
  private snapshot: HostSnapshot = {
    epoch: 0,
    tag: null,
    data: null,
    document: null,
    regionId: null,
    locked: true,
    hidden: false,
    viewState: null,
  };
  private status: HostStatus = { phase: 'waiting', locked: true };
  private readyTimer: ReturnType<typeof setInterval> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private pendingEcho: PendingEcho | null = null;
  private hostContext: string | null = null;
  private regionLocked = false;
  private destroyed = false;

  constructor(options: ReactCodeSrcPortOptions = {}) {
    this.runtime = options.window ?? window;
    this.targetOrigin = deriveParentOrigin(this.runtime, options.allowedParentOrigins ?? []);
    this.readyIntervalMilliseconds = options.readyIntervalMilliseconds ?? 500;
    this.mutationTimeoutMilliseconds = options.mutationTimeoutMilliseconds ?? 5000;
    this.runtime.addEventListener('message', this.onMessage);
    this.sendReady();
    this.readyTimer = setInterval(() => this.sendReady(), this.readyIntervalMilliseconds);
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

  replaceDocument(next: FrogLabelDocument | null, reason: MutationReason): Promise<void> {
    this.ensureAlive();
    const operation = () => this.performMutation(cloneDocument(next), reason);
    const queued = this.mutationTail.then(operation, operation);
    this.mutationTail = queued.catch(() => undefined);
    return queued;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.runtime.removeEventListener('message', this.onMessage);
    if (this.readyTimer) clearInterval(this.readyTimer);
    this.readyTimer = null;
    this.hostContext = null;
    this.rejectPending(new IntegrationError('HOST_DESTROYED', 'The host connection closed.'));
    this.listeners.clear();
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (
      this.destroyed ||
      event.source !== this.runtime.parent ||
      event.origin !== this.targetOrigin
    )
      return;
    if (!isReactCodeHostMessage(event.data)) {
      this.fail('HOST_MESSAGE_INVALID', 'The host sent a malformed ReactCode message.');
      return;
    }
    const message = event.data as HostMessage;
    if (this.snapshot.tag && message.type !== 'init' && message.tag !== this.snapshot.tag) return;
    if (
      (message.type === 'regions' || message.type === 'viewState') &&
      message.context !== this.hostContext
    )
      return;
    try {
      switch (message.type) {
        case 'init':
          this.handleInit(message);
          break;
        case 'update':
          this.handleUpdate(message);
          break;
        case 'regions':
          this.reconcile(message.regions);
          break;
        case 'viewState':
          this.applyViewState(message.viewState);
          this.emit();
          break;
      }
    } catch (error) {
      this.fail(
        'HOST_CONTEXT_INVALID',
        error instanceof Error ? error.message : 'The host context is invalid.',
      );
    }
  };

  private handleInit(message: Extract<HostMessage, { type: 'init' }>): void {
    this.cancelReadyRetry();
    this.beginEpoch();
    this.hostContext = message.context;
    this.snapshot = {
      ...this.snapshot,
      tag: message.tag,
      data: normalizeHostData(message.data),
      viewState: message.viewState,
      document: null,
      regionId: null,
      locked: true,
      hidden: false,
      origin: undefined,
    };
    if (message.data === null) {
      this.status = { phase: 'waiting', locked: true };
      this.emit();
      return;
    }
    this.reconcile(message.regions);
  }

  private handleUpdate(message: Extract<HostMessage, { type: 'update' }>): void {
    this.beginEpoch();
    this.hostContext = message.context;
    const data = Object.hasOwn(message, 'data')
      ? normalizeHostData(message.data)
      : this.snapshot.data;
    this.snapshot = {
      ...this.snapshot,
      tag: message.tag,
      data,
      document: null,
      regionId: null,
      locked: true,
      hidden: false,
      ...(Object.hasOwn(message, 'viewState') ? { viewState: message.viewState ?? null } : {}),
    };
    if (message.regions) this.reconcile(message.regions);
    else {
      const locked = data === null || isViewStateLocked(this.snapshot.viewState);
      this.snapshot = { ...this.snapshot, locked };
      this.status = { phase: data === null ? 'waiting' : locked ? 'read-only' : 'ready', locked };
      this.emit();
    }
  }

  private beginEpoch(): void {
    const nextEpoch = this.snapshot.epoch + 1;
    this.rejectPending(
      new IntegrationError(
        'HOST_EPOCH_CHANGED',
        'The task or annotation changed before the save was acknowledged.',
      ),
    );
    this.regionLocked = false;
    this.snapshot = { ...this.snapshot, epoch: nextEpoch };
  }

  private reconcile(rawRegions: unknown[]): void {
    const matching = rawRegions.map(readRegion);
    if (matching.length > 1) {
      throw new ValidationError('More than one FrogLabel document exists in this annotation');
    }
    const region = matching[0] ?? null;
    const document = region ? migrateDocument(region.value) : null;
    if (document) assertDocument(document);
    this.regionLocked = region?.locked ?? false;
    const waiting = this.snapshot.data === null;
    const locked = waiting || this.regionLocked || isViewStateLocked(this.snapshot.viewState);
    this.snapshot = {
      ...this.snapshot,
      document,
      regionId: region?.id ?? null,
      locked,
      hidden: region?.hidden ?? false,
      origin: region?.origin,
    };
    const awaitingDifferentEcho =
      this.pendingEcho?.epoch === this.snapshot.epoch &&
      !documentsEqual(this.pendingEcho.expected, document);
    this.status = awaitingDifferentEcho
      ? { phase: 'saving', locked: this.snapshot.locked }
      : {
          phase: waiting ? 'waiting' : this.snapshot.locked ? 'read-only' : 'ready',
          locked: this.snapshot.locked,
        };
    this.resolveEchoIfMatched();
    this.emit();
  }

  private applyViewState(viewState: Record<string, unknown> | null): void {
    const locked = this.regionLocked || isViewStateLocked(viewState);
    this.snapshot = { ...this.snapshot, viewState, locked };
    this.status = {
      phase: this.snapshot.data === null ? 'waiting' : locked ? 'read-only' : 'ready',
      locked,
    };
  }

  private async performMutation(
    next: FrogLabelDocument | null,
    _reason: MutationReason,
  ): Promise<void> {
    if (this.snapshot.locked || this.status.phase === 'read-only') {
      throw new IntegrationError(
        'HOST_READ_ONLY',
        'This Label Studio result is read-only. Copy the prediction before editing.',
      );
    }
    if (!this.snapshot.tag || !this.hostContext || this.snapshot.data === null) {
      throw new IntegrationError('HOST_NOT_READY', 'FrogLabel is still waiting for Label Studio.');
    }
    if (next) assertDocument(next);
    if (documentsEqual(this.snapshot.document, next)) return;
    const epoch = this.snapshot.epoch;
    let message: Record<string, unknown>;
    if (!next) {
      if (!this.snapshot.regionId) return;
      message = { type: 'deleteRegion', tag: this.snapshot.tag, id: this.snapshot.regionId };
    } else if (this.snapshot.regionId) {
      message = {
        type: 'updateRegion',
        tag: this.snapshot.tag,
        id: this.snapshot.regionId,
        value: next,
      };
    } else {
      message = {
        type: 'addRegion',
        tag: this.snapshot.tag,
        value: next,
        extraData: {
          displayText: `${next.boxes.length} FrogLabel box${next.boxes.length === 1 ? '' : 'es'}`,
        },
      };
    }
    this.status = { phase: 'saving', locked: false };
    this.emit();
    const acknowledgement = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingEcho?.epoch !== epoch) return;
        this.pendingEcho = null;
        this.fail(
          'HOST_SAVE_TIMEOUT',
          'Label Studio did not acknowledge the annotation change.',
          'Retry the edit or reload the task.',
        );
        reject(
          new IntegrationError(
            'HOST_SAVE_TIMEOUT',
            'Label Studio did not acknowledge the annotation change.',
          ),
        );
      }, this.mutationTimeoutMilliseconds);
      this.pendingEcho = { epoch, expected: cloneDocument(next), resolve, reject, timer };
    });
    this.post({ ...message, context: this.hostContext });
    return acknowledgement;
  }

  private resolveEchoIfMatched(): void {
    const pending = this.pendingEcho;
    if (!pending || pending.epoch !== this.snapshot.epoch) return;
    if (!documentsEqual(pending.expected, this.snapshot.document)) return;
    clearTimeout(pending.timer);
    this.pendingEcho = null;
    this.status = {
      phase: this.snapshot.locked ? 'read-only' : 'ready',
      locked: this.snapshot.locked,
    };
    pending.resolve();
  }

  private rejectPending(error: Error): void {
    if (!this.pendingEcho) return;
    clearTimeout(this.pendingEcho.timer);
    const pending = this.pendingEcho;
    this.pendingEcho = null;
    pending.reject(error);
  }

  private sendReady(): void {
    if (this.destroyed || this.snapshot.tag) return;
    this.post({ type: 'ready' });
  }

  private post(message: Record<string, unknown>): void {
    this.runtime.parent.postMessage(message, this.targetOrigin);
  }

  private cancelReadyRetry(): void {
    if (this.readyTimer) clearInterval(this.readyTimer);
    this.readyTimer = null;
  }

  private fail(code: string, message: string, repair?: string): void {
    const error: StructuredError = { code, message, ...(repair ? { repair } : {}) };
    this.status = { phase: 'error', locked: true, error };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private ensureAlive(): void {
    if (this.destroyed) throw new IntegrationError('HOST_DESTROYED', 'The host connection closed.');
  }
}

function normalizeHostData(value: unknown): FrogLabelHostDataV1 | null {
  if (value === null) return null;
  assertHostData(value);
  return structuredClone(value);
}

function isViewStateLocked(value: Record<string, unknown> | null | undefined): boolean {
  return value?.locked === true || value?.editable === false;
}

function readRegion(value: unknown): HostRegion {
  if (!value || typeof value !== 'object')
    throw new ValidationError('Host region must be an object');
  const candidate = value as Partial<HostRegion>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.selected !== 'boolean' ||
    typeof candidate.hidden !== 'boolean' ||
    typeof candidate.locked !== 'boolean'
  ) {
    throw new ValidationError('Host region metadata is invalid');
  }
  return candidate as HostRegion;
}

function documentsEqual(left: FrogLabelDocument | null, right: FrogLabelDocument | null): boolean {
  return left === null || right === null
    ? left === right
    : deterministicSerialize(left) === deterministicSerialize(right);
}

export function deriveParentOrigin(runtime: Window, allowedOrigins: string[]): string {
  const normalizedAllowed = allowedOrigins.map((origin) => new URL(origin).origin);
  const referrerOrigin = runtime.document.referrer
    ? new URL(runtime.document.referrer, runtime.location.href).origin
    : null;
  const candidate = referrerOrigin ?? runtime.location.origin;
  if (candidate === runtime.location.origin || normalizedAllowed.includes(candidate))
    return candidate;
  throw new IntegrationError(
    'HOST_ORIGIN_DENIED',
    `Parent origin ${candidate} is not an allowed FrogLabel host.`,
  );
}
