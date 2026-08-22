import {
  computeSpectrogramAnalysis,
  renderSpectrogramPixels,
  type SpectrogramAnalysis,
  type SpectrogramRenderOptions,
} from '../audio/spectrogram';
import type { AudioAnalysisSource } from '../domain/types';

interface InitializeMessage {
  type: 'initialize';
  source: AudioAnalysisSource;
}

interface RenderMessage {
  type: 'render';
  requestId: number;
  width: number;
  height: number;
  options: SpectrogramRenderOptions;
}

type WorkerRequest = InitializeMessage | RenderMessage;

const workerScope = self as unknown as Pick<Worker, 'onmessage' | 'postMessage'>;
let analysis: SpectrogramAnalysis | null = null;

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'initialize') {
    analysis = computeSpectrogramAnalysis(message.source);
    return;
  }
  try {
    if (!analysis) throw new Error('The task audio analysis was not initialized.');
    const pixels = renderSpectrogramPixels(
      analysis,
      message.width,
      message.height,
      message.options,
    );
    workerScope.postMessage(
      {
        type: 'rendered',
        requestId: message.requestId,
        width: message.width,
        height: message.height,
        pixels,
      },
      [pixels.buffer],
    );
  } catch (error) {
    workerScope.postMessage({
      type: 'error',
      requestId: message.requestId,
      message: error instanceof Error ? error.message : 'Unknown render error',
    });
  }
};

workerScope.postMessage({ type: 'ready' });
