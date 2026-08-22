export interface AudioSourceSnapshot {
  url: string;
  filename: string;
  mimeType?: string;
  durationSeconds?: number;
  trustedSampleRateHz?: number;
}

export interface AudioSourcePort {
  getSnapshot(): AudioSourceSnapshot | null;
  subscribe(listener: (snapshot: AudioSourceSnapshot | null) => void): () => void;
  destroy(): void;
}
