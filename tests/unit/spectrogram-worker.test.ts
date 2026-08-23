import { describe, expect, it, vi } from 'vitest';
import spectrogramWorkerSource from 'virtual:froglabel-spectrogram-worker';
import type { SpectrogramRenderOptions } from '../../src/audio/spectrogram';
import type { AudioAnalysisSource } from '../../src/domain/types';

interface WorkerScopeHarness {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

describe('spectrogram worker scheduling', () => {
  it('coalesces startup previews so only the latest camera request is posted', async () => {
    const posted: Array<{ type: string; requestId?: number; quality?: string }> = [];
    const scope: WorkerScopeHarness = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage: vi.fn((message: { type: string; requestId?: number; quality?: string }) => {
        posted.push(message);
      }),
    };
    const evaluateWorker = new Function('self', spectrogramWorkerSource) as (
      scope: WorkerScopeHarness,
    ) => void;
    evaluateWorker(scope);

    send(scope, { type: 'initialize', source: audioSource() });
    send(scope, { type: 'render', requestId: 1, width: 64, height: 32, options: options(0) });
    send(scope, {
      type: 'render',
      requestId: 2,
      width: 64,
      height: 32,
      options: options(0.01),
    });

    await vi.waitFor(() => {
      expect(posted.some((message) => message.type === 'rendered' && message.requestId === 2)).toBe(
        true,
      );
    });
    expect(posted.some((message) => message.type === 'rendered' && message.requestId === 1)).toBe(
      false,
    );
  });
});

function send(scope: { onmessage: ((event: MessageEvent) => void) | null }, data: unknown): void {
  if (!scope.onmessage) throw new Error('Worker message handler was not installed.');
  scope.onmessage({ data } as MessageEvent);
}

function audioSource(): AudioAnalysisSource {
  const sampleRateHz = 8_000;
  return {
    sampleRateHz,
    channelCount: 1,
    channels: [
      Float32Array.from({ length: 2_000 }, (_, index) =>
        Math.sin((2 * Math.PI * 997 * index) / sampleRateHz),
      ),
    ],
  };
}

function options(timeStartSeconds: number): SpectrogramRenderOptions {
  return {
    timeStartSeconds,
    timeEndSeconds: 0.2,
    lowFrequencyHz: 0,
    highFrequencyHz: 4_000,
    brightness: 1,
    contrast: 1,
    palette: 'viridis',
    channelMode: 'average',
    frequencyScale: 'linear',
  };
}
