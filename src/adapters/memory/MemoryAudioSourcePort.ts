import type { AudioSourcePort, AudioSourceSnapshot } from '../../ports/AudioSourcePort';

export class MemoryAudioSourcePort implements AudioSourcePort {
  private readonly listeners = new Set<(snapshot: AudioSourceSnapshot | null) => void>();

  constructor(private snapshot: AudioSourceSnapshot | null = null) {}

  getSnapshot(): AudioSourceSnapshot | null {
    return this.snapshot ? structuredClone(this.snapshot) : null;
  }

  subscribe(listener: (snapshot: AudioSourceSnapshot | null) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  replace(snapshot: AudioSourceSnapshot | null): void {
    this.snapshot = snapshot ? structuredClone(snapshot) : null;
    for (const listener of this.listeners) listener(this.getSnapshot());
  }

  destroy(): void {
    this.listeners.clear();
  }
}
