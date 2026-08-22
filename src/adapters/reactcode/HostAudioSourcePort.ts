import type { AnnotationDocumentPort } from '../../ports/AnnotationDocumentPort';
import type { AudioSourcePort, AudioSourceSnapshot } from '../../ports/AudioSourcePort';
import type { FrogLabelHostDataV1 } from '../../domain/types';

export class HostAudioSourcePort implements AudioSourcePort {
  private readonly listeners = new Set<(snapshot: AudioSourceSnapshot | null) => void>();
  private snapshot: AudioSourceSnapshot | null;
  private readonly unsubscribe: () => void;

  constructor(annotationPort: AnnotationDocumentPort) {
    this.snapshot = toAudioSnapshot(annotationPort.getSnapshot().data);
    this.unsubscribe = annotationPort.subscribe((host) => {
      const next = toAudioSnapshot(host.data);
      if (JSON.stringify(next) === JSON.stringify(this.snapshot)) return;
      this.snapshot = next;
      for (const listener of this.listeners) listener(this.getSnapshot());
    });
  }

  getSnapshot(): AudioSourceSnapshot | null {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  subscribe(listener: (snapshot: AudioSourceSnapshot | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.unsubscribe();
    this.listeners.clear();
  }
}

function toAudioSnapshot(data: FrogLabelHostDataV1 | null): AudioSourceSnapshot | null {
  if (data === null) return null;
  if (typeof data === 'string') {
    return { url: data, filename: filenameFromUrl(data) };
  }
  const metadata = data.froglabelConfig?.audio;
  return {
    url: data.froglabel,
    filename: metadata?.filename ?? filenameFromUrl(data.froglabel),
    ...(metadata?.mimeType ? { mimeType: metadata.mimeType } : {}),
    ...(metadata?.durationSeconds ? { durationSeconds: metadata.durationSeconds } : {}),
    ...(metadata?.sampleRateHz ? { trustedSampleRateHz: metadata.sampleRateHz } : {}),
  };
}

function filenameFromUrl(url: string): string {
  try {
    const pathname = new URL(url, window.location.href).pathname;
    return decodeURIComponent(pathname.split('/').pop() || 'audio');
  } catch {
    return 'audio';
  }
}
