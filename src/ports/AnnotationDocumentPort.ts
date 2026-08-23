import type {
  FrogLabelDocument,
  HostCapabilities,
  HostSnapshot,
  HostStatus,
  MutationReason,
} from '../domain/types';

export interface AnnotationDocumentPort {
  subscribe(listener: (snapshot: HostSnapshot) => void): () => void;
  getSnapshot(): HostSnapshot;
  getEpoch(): number;
  replaceDocument(next: FrogLabelDocument | null, reason: MutationReason): Promise<void>;
  getStatus(): HostStatus;
  getCapabilities(): HostCapabilities;
  destroy(): void;
}
