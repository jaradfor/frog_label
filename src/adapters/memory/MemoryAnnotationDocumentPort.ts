import { cloneDocument } from '../../domain/document';
import { assertDocument } from '../../domain/validation';
import type {
  FrogLabelDocumentV1,
  HostCapabilities,
  HostSnapshot,
  HostStatus,
  MutationReason,
} from '../../domain/types';
import type { AnnotationDocumentPort } from '../../ports/AnnotationDocumentPort';

export class MemoryAnnotationDocumentPort implements AnnotationDocumentPort {
  private readonly listeners = new Set<(snapshot: HostSnapshot) => void>();
  private readonly trustValidatedMutations: boolean;
  private snapshot: HostSnapshot;
  private destroyed = false;

  constructor(
    document: FrogLabelDocumentV1 | null,
    options: {
      data?: HostSnapshot['data'];
      tag?: string;
      epoch?: number;
      locked?: boolean;
      trustValidatedMutations?: boolean;
    } = {},
  ) {
    if (document) assertDocument(document);
    this.trustValidatedMutations = options.trustValidatedMutations ?? false;
    this.snapshot = {
      epoch: options.epoch ?? 1,
      tag: options.tag ?? 'froglabel',
      data: options.data ?? null,
      document: cloneDocument(document),
      regionId: document ? 'memory:froglabel-document' : null,
      locked: options.locked ?? false,
      hidden: false,
      origin: 'manual',
      viewState: null,
    };
  }

  subscribe(listener: (snapshot: HostSnapshot) => void): () => void {
    this.ensureAlive();
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): HostSnapshot {
    if (!this.trustValidatedMutations) return structuredClone(this.snapshot);
    // Trusted in-process adapters consume immutable reducer documents. Share
    // that persistent value while still returning a new host envelope; this
    // avoids allocating thousands of box/species objects on every local drag.
    return {
      ...this.snapshot,
      data: this.snapshot.data,
      viewState: this.snapshot.viewState ? structuredClone(this.snapshot.viewState) : null,
    };
  }

  getEpoch(): number {
    return this.snapshot.epoch;
  }

  async replaceDocument(next: FrogLabelDocumentV1 | null, _reason: MutationReason): Promise<void> {
    this.ensureAlive();
    if (this.snapshot.locked) throw new Error('The annotation is read-only.');
    if (next && !this.trustValidatedMutations) assertDocument(next);
    this.snapshot = {
      ...this.snapshot,
      document: this.trustValidatedMutations ? next : cloneDocument(next),
      regionId: next ? (this.snapshot.regionId ?? 'memory:froglabel-document') : null,
    };
    this.emit();
  }

  getStatus(): HostStatus {
    return {
      phase: this.snapshot.locked ? 'read-only' : 'ready',
      locked: this.snapshot.locked,
    };
  }

  getCapabilities(): HostCapabilities {
    return {
      editable: !this.snapshot.locked,
      catalogRead: true,
      catalogCreate: true,
      localFiles: true,
    };
  }

  replaceContext(next: Partial<HostSnapshot>): void {
    this.ensureAlive();
    this.snapshot = {
      ...this.snapshot,
      ...structuredClone(next),
      epoch: next.epoch ?? this.snapshot.epoch + 1,
    };
    this.emit();
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private ensureAlive(): void {
    if (this.destroyed) throw new Error('Annotation port has been destroyed.');
  }
}
