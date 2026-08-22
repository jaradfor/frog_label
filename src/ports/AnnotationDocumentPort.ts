import type {
  FrogLabelDocumentV1,
  HostCapabilities,
  HostSnapshot,
  HostStatus,
  MutationReason,
} from '../domain/types';

export interface AnnotationDocumentPort {
  subscribe(listener: (snapshot: HostSnapshot) => void): () => void;
  getSnapshot(): HostSnapshot;
  getEpoch(): number;
  replaceDocument(next: FrogLabelDocumentV1 | null, reason: MutationReason): Promise<void>;
  getStatus(): HostStatus;
  getCapabilities(): HostCapabilities;
  destroy(): void;
}
