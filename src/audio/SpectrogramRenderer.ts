import type { LoadedAudio } from './AudioResource';
import spectrogramWorkerSource from 'virtual:froglabel-spectrogram-worker';
import {
  computeSpectrogramAnalysisCooperative,
  renderSpectrogramPixels,
  type SpectrogramAnalysis,
  type SpectrogramRenderOptions,
} from './spectrogram';

interface WorkerRenderResult {
  type: 'rendered';
  requestId: number;
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

interface WorkerRenderFailure {
  type: 'error';
  requestId: number;
  message: string;
}

interface WorkerReady {
  type: 'ready';
}

type WorkerResponse = WorkerReady | WorkerRenderResult | WorkerRenderFailure;

export type SpectrogramRenderPhase = 'analyzing' | 'firstFrameReady' | 'error';

/** Owns one complete-clip analysis executor for one decoded audio resource. */
export class SpectrogramRenderer {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private workerReady = false;
  private workerInitializeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private workerStartupCleanupTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private workerUrlRevokeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private fallbackAnalysis: SpectrogramAnalysis | null = null;
  private fallbackController: AbortController | null = null;
  private latestRequestId = 0;
  private latestCanvas: HTMLCanvasElement | null = null;
  private latestOptions: SpectrogramRenderOptions | null = null;
  private destroyed = false;

  constructor(
    private readonly audio: LoadedAudio,
    private readonly onError: (message: string) => void,
    private readonly onPhaseChange: (phase: SpectrogramRenderPhase) => void = () => undefined,
  ) {
    if (typeof Worker !== 'undefined') {
      try {
        this.workerUrl = URL.createObjectURL(
          new Blob([spectrogramWorkerSource], { type: 'text/javascript' }),
        );
        this.worker = new Worker(this.workerUrl, { name: 'froglabel-spectrogram' });
        this.worker.addEventListener('message', this.handleMessage);
        this.worker.addEventListener('error', this.handleWorkerError);
        return;
      } catch {
        this.worker?.terminate();
        this.worker = null;
        this.scheduleWorkerUrlRevoke(0);
      }
    }
    this.startCooperativeFallback();
  }

  render(canvas: HTMLCanvasElement, options: SpectrogramRenderOptions): void {
    if (this.destroyed) return;
    const { width, height } = rasterSize(canvas);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    this.latestCanvas = canvas;
    this.latestOptions = options;
    this.latestRequestId += 1;
    this.onPhaseChange('analyzing');
    if (this.worker) {
      if (this.workerReady) this.renderWorker(width, height, options);
      return;
    }
    this.renderFallback();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.latestCanvas = null;
    this.latestOptions = null;
    this.fallbackController?.abort();
    this.fallbackController = null;
    this.fallbackAnalysis = null;
    if (this.worker) {
      if (this.workerReady) {
        this.disposeWorker();
      } else {
        // Let an in-flight blob bootstrap reach its ready message before
        // termination. Chromium otherwise reports intentional cancellation as
        // a failed request, and the worker receives no scientific work after
        // `destroyed` becomes true.
        this.workerStartupCleanupTimer = globalThis.setTimeout(() => {
          this.disposeWorker();
        }, 5_000);
      }
    } else {
      this.scheduleWorkerUrlRevoke(0);
    }
  }

  private readonly handleMessage = (event: MessageEvent<WorkerResponse>): void => {
    if (event.data.type === 'ready') {
      this.workerReady = true;
      if (this.destroyed) {
        globalThis.setTimeout(() => this.disposeWorker(), 0);
      } else {
        // Yield long enough for Chromium to finish the successful blob-script
        // response before beginning a potentially long maximum-fixture STFT.
        this.workerInitializeTimer = globalThis.setTimeout(() => {
          this.initializeWorker();
        }, 100);
      }
      return;
    }
    if (this.destroyed || event.data.requestId !== this.latestRequestId) return;
    if (event.data.type === 'error') {
      this.switchToCooperativeFallback();
      return;
    }
    this.paint(event.data.requestId, event.data.width, event.data.height, event.data.pixels);
  };

  private readonly handleWorkerError = (): void => {
    if (this.destroyed) {
      this.disposeWorker();
    } else {
      this.switchToCooperativeFallback();
    }
  };

  private switchToCooperativeFallback(): void {
    this.disposeWorker();
    this.startCooperativeFallback();
  }

  private initializeWorker(): void {
    this.workerInitializeTimer = null;
    if (!this.worker || this.destroyed) return;
    try {
      const channels = this.audio.analysis.channels.map((channel) => channel.slice());
      this.worker.postMessage(
        {
          type: 'initialize',
          source: {
            sampleRateHz: this.audio.analysis.sampleRateHz,
            channelCount: this.audio.analysis.channelCount,
            channels,
          },
        },
        channels.map((channel) => channel.buffer),
      );
      if (this.latestCanvas && this.latestOptions) {
        this.renderWorker(this.latestCanvas.width, this.latestCanvas.height, this.latestOptions);
      }
    } catch {
      this.switchToCooperativeFallback();
    }
  }

  private renderWorker(width: number, height: number, options: SpectrogramRenderOptions): void {
    try {
      this.worker?.postMessage({
        type: 'render',
        requestId: this.latestRequestId,
        width,
        height,
        options,
      });
    } catch {
      this.switchToCooperativeFallback();
    }
  }

  private disposeWorker(): void {
    if (this.workerInitializeTimer !== null) {
      globalThis.clearTimeout(this.workerInitializeTimer);
      this.workerInitializeTimer = null;
    }
    if (this.workerStartupCleanupTimer !== null) {
      globalThis.clearTimeout(this.workerStartupCleanupTimer);
      this.workerStartupCleanupTimer = null;
    }
    if (this.worker) {
      this.worker.removeEventListener('message', this.handleMessage);
      this.worker.removeEventListener('error', this.handleWorkerError);
      this.worker.terminate();
      this.worker = null;
    }
    this.scheduleWorkerUrlRevoke(this.workerReady ? 250 : 0);
  }

  private scheduleWorkerUrlRevoke(delayMilliseconds = 250): void {
    if (!this.workerUrl || this.workerUrlRevokeTimer !== null) return;
    this.workerUrlRevokeTimer = globalThis.setTimeout(() => {
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      this.workerUrlRevokeTimer = null;
    }, delayMilliseconds);
  }

  private startCooperativeFallback(): void {
    if (this.fallbackController || this.fallbackAnalysis || this.destroyed) return;
    const controller = new AbortController();
    this.fallbackController = controller;
    void computeSpectrogramAnalysisCooperative(this.audio.analysis, {
      signal: controller.signal,
    })
      .then((analysis) => {
        if (this.destroyed || controller.signal.aborted) return;
        this.fallbackController = null;
        this.fallbackAnalysis = analysis;
        this.renderFallback();
      })
      .catch((error) => {
        if (!controller.signal.aborted && !this.destroyed) {
          const message = `Spectrogram analysis failed. ${error instanceof Error ? error.message : 'Unknown error'}`;
          this.onPhaseChange('error');
          this.onError(message);
        }
      });
  }

  private renderFallback(): void {
    const canvas = this.latestCanvas;
    const options = this.latestOptions;
    const analysis = this.fallbackAnalysis;
    if (!canvas || !options || !analysis) return;
    const pixels = renderSpectrogramPixels(analysis, canvas.width, canvas.height, options);
    this.paint(this.latestRequestId, canvas.width, canvas.height, pixels);
  }

  private paint(requestId: number, width: number, height: number, pixels: Uint8ClampedArray): void {
    if (requestId !== this.latestRequestId || this.destroyed) return;
    const canvas = this.latestCanvas;
    const context = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !context || canvas.width !== width || canvas.height !== height) return;
    const image = context.createImageData(width, height);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    // This signal is intentionally emitted only after the current request's
    // pixels have reached the live canvas. Decoding, worker readiness, and a
    // stale render completion are not sufficient annotation-readiness oracles.
    this.onPhaseChange('firstFrameReady');
  }
}

function rasterSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const density = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  return {
    width: Math.max(1, Math.min(1600, Math.round(canvas.clientWidth * density))),
    height: Math.max(1, Math.min(800, Math.round(canvas.clientHeight * density))),
  };
}
