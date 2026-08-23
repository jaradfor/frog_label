import type { LoadedAudio } from './AudioResource';
import spectrogramWorkerSource from 'virtual:froglabel-spectrogram-worker';
import {
  colorizeSpectrogramDb,
  computeSpectrogramAnalysisCooperative,
  renderSpectrogramPixelsCooperative,
  renderSpectrogramPreviewPixelsCooperative,
  type SpectrogramAnalysis,
  type SpectrogramRenderOptions,
} from './spectrogram';
import {
  createSpectralTilePlan,
  SpectralTileLru,
  SpectralWebGLAtlas,
  type SpectralTileDescriptor,
  type SpectralTilePlan,
} from './SpectralTileAtlas';
import { frequencyToAxisRatio } from '../domain/frequencyScale';

interface WorkerRenderResult {
  type: 'rendered';
  requestId: number;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  quality: 'preview' | 'exact';
  pixels: Uint8ClampedArray;
}

interface WorkerRenderFailure {
  type: 'error';
  requestId: number;
  message: string;
}

interface WorkerTileResult {
  type: 'tile';
  requestId: number;
  audioGeneration: number;
  descriptor: SpectralTileDescriptor;
  db: Float32Array;
}

interface WorkerTilesComplete {
  type: 'tiles-complete';
  requestId: number;
  audioGeneration: number;
  viewKey: string;
}

interface WorkerReady {
  type: 'ready';
}

type WorkerResponse =
  WorkerReady | WorkerRenderResult | WorkerRenderFailure | WorkerTileResult | WorkerTilesComplete;

interface CurrentTileRender {
  requestId: number;
  plan: SpectralTilePlan;
  options: SpectrogramRenderOptions;
  width: number;
  height: number;
}

let nextAudioGeneration = 1;

export type SpectrogramRenderPhase = 'analyzing' | 'firstFrameReady' | 'error';
export type SpectrogramRenderStatus = 'initializing' | 'preview' | 'refining' | 'ready' | 'error';
export type SpectrogramRenderQuality = 'none' | 'retained' | 'preview' | 'exact';

export interface SpectrogramRenderState {
  status: SpectrogramRenderStatus;
  quality: SpectrogramRenderQuality;
  requestGeneration: number;
  paintedRequestGeneration: number;
  paintGeneration: number;
  hasFrame: boolean;
}

/** Owns one complete-clip analysis executor for one decoded audio resource. */
export class SpectrogramRenderer {
  private readonly audioGeneration = nextAudioGeneration++;
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private workerUrlRevoke: ((url: string) => void) | null = null;
  private workerReady = false;
  private workerInitialized = false;
  private workerInitializationController: AbortController | null = null;
  private workerStartupCleanupTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private workerUrlRevokeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private fallbackAnalysis: SpectrogramAnalysis | null = null;
  private fallbackController: AbortController | null = null;
  private fallbackRenderController: AbortController | null = null;
  private startupPreviewController: AbortController | null = null;
  private tilePaintController: AbortController | null = null;
  private latestRequestId = 0;
  private latestCanvas: HTMLCanvasElement | null = null;
  private latestOptions: SpectrogramRenderOptions | null = null;
  private latestWidth = 1;
  private latestHeight = 1;
  private displayedCanvas: HTMLCanvasElement | null = null;
  private displayedOptions: SpectrogramRenderOptions | null = null;
  private displayedWidth = 0;
  private displayedHeight = 0;
  private pixelBuffer: HTMLCanvasElement | null = null;
  private compositeBuffer: HTMLCanvasElement | null = null;
  private webglAtlas: SpectralWebGLAtlas | null = null;
  private webglAttempted = false;
  private readonly tileCache = new SpectralTileLru(undefined, (key) =>
    this.webglAtlas?.releaseTile(key),
  );
  private currentTileRender: CurrentTileRender | null = null;
  private paintGeneration = 0;
  private paintedRequestGeneration = 0;
  private hasFrame = false;
  private quality: SpectrogramRenderQuality = 'none';
  private lifecyclePhase: SpectrogramRenderPhase | null = null;
  private destroyed = false;

  constructor(
    private readonly audio: LoadedAudio,
    private readonly onError: (message: string) => void,
    private readonly onPhaseChange: (phase: SpectrogramRenderPhase) => void = () => undefined,
    private readonly onStateChange: (state: SpectrogramRenderState) => void = () => undefined,
  ) {
    if (typeof Worker !== 'undefined') {
      try {
        const revokeObjectUrl = URL.revokeObjectURL.bind(URL);
        this.workerUrl = URL.createObjectURL(
          new Blob([spectrogramWorkerSource], { type: 'text/javascript' }),
        );
        this.workerUrlRevoke = revokeObjectUrl;
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

  render(canvas: HTMLCanvasElement, options: SpectrogramRenderOptions): number {
    if (this.destroyed) return this.latestRequestId;
    const { width, height } = rasterSize(canvas);
    this.latestCanvas = canvas;
    this.latestOptions = { ...options };
    this.latestWidth = width;
    this.latestHeight = height;
    this.latestRequestId += 1;
    this.fallbackRenderController?.abort();
    this.startupPreviewController?.abort();
    this.tilePaintController?.abort();

    if (!this.hasFrame) this.emitLifecycle('analyzing');
    const retained = this.reprojectDisplayedFrame(canvas, width, height, options);
    this.emitState(
      this.hasFrame ? 'refining' : 'initializing',
      retained ? 'retained' : this.quality,
    );

    if (this.worker) {
      if (this.workerReady && this.workerInitialized) this.renderWorker(width, height, options);
      else this.renderStartupPreview();
    } else {
      this.renderFallback();
    }
    return this.latestRequestId;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.latestCanvas = null;
    this.latestOptions = null;
    this.displayedCanvas = null;
    this.displayedOptions = null;
    this.pixelBuffer = null;
    this.compositeBuffer = null;
    this.fallbackController?.abort();
    this.fallbackController = null;
    this.fallbackRenderController?.abort();
    this.fallbackRenderController = null;
    this.startupPreviewController?.abort();
    this.startupPreviewController = null;
    this.tilePaintController?.abort();
    this.tilePaintController = null;
    this.fallbackAnalysis = null;
    this.currentTileRender = null;
    this.tileCache.clear();
    this.webglAtlas?.destroy();
    this.webglAtlas = null;
    if (this.worker) {
      if (this.workerReady) {
        this.disposeWorker();
      } else {
        // Avoid Chromium reporting intentional blob bootstrap cancellation as
        // a failed resource while still guaranteeing eventual cleanup.
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
      if (this.destroyed) globalThis.setTimeout(() => this.disposeWorker(), 0);
      else void this.initializeWorker();
      return;
    }
    if (this.destroyed) return;
    if (event.data.type === 'error') {
      if (event.data.requestId === 0 || event.data.requestId === this.latestRequestId) {
        this.switchToCooperativeFallback();
      }
      return;
    }
    if (event.data.type === 'tile') {
      if (
        event.data.audioGeneration === this.audioGeneration &&
        validTileResult(event.data.descriptor, event.data.db)
      ) {
        this.tileCache.set({ descriptor: event.data.descriptor, db: event.data.db });
      }
      return;
    }
    if (event.data.type === 'tiles-complete') {
      const current = this.currentTileRender;
      if (
        event.data.audioGeneration === this.audioGeneration &&
        event.data.requestId === this.latestRequestId &&
        current?.requestId === event.data.requestId &&
        current.plan.viewKey === event.data.viewKey
      ) {
        void this.paintTileRender(current);
      }
      return;
    }
    if (event.data.requestId !== this.latestRequestId) return;
    this.startupPreviewController?.abort();
    this.startupPreviewController = null;
    this.paint(event.data);
  };

  private readonly handleWorkerError = (): void => {
    if (this.destroyed) this.disposeWorker();
    else this.switchToCooperativeFallback();
  };

  private switchToCooperativeFallback(): void {
    this.disposeWorker();
    this.startupPreviewController?.abort();
    this.startupPreviewController = null;
    this.tilePaintController?.abort();
    this.tilePaintController = null;
    this.currentTileRender = null;
    // Tile frames are worker-only. Once this renderer permanently abandons
    // its worker, retaining either cache would strand up to 96 MiB precisely
    // when memory or graphics pressure may have caused the failure.
    this.tileCache.clear();
    this.webglAtlas?.destroy();
    this.webglAtlas = null;
    this.startCooperativeFallback();
    this.renderFallback();
    this.emitState(this.hasFrame ? 'refining' : 'initializing', this.quality);
  }

  private async initializeWorker(): Promise<void> {
    if (!this.worker || this.destroyed) return;
    this.workerInitializationController?.abort();
    const controller = new AbortController();
    this.workerInitializationController = controller;
    const worker = this.worker;
    try {
      const channels = await cloneAudioChannelsCooperative(this.audio.analysis.channels, {
        signal: controller.signal,
        sliceMilliseconds: 8,
      });
      if (controller.signal.aborted || this.destroyed || worker !== this.worker) return;
      this.workerInitializationController = null;
      worker.postMessage(
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
      this.workerInitialized = true;
      if (this.latestCanvas && this.latestOptions) {
        this.renderWorker(this.latestWidth, this.latestHeight, this.latestOptions);
      }
    } catch {
      if (!controller.signal.aborted && !this.destroyed && worker === this.worker) {
        this.switchToCooperativeFallback();
      }
    }
  }

  private renderWorker(width: number, height: number, options: SpectrogramRenderOptions): void {
    const plan = createSpectralTilePlan(
      this.audioGeneration,
      this.audio.durationSeconds,
      this.audio.maximumFrequencyHz,
      width,
      height,
      options,
    );
    const current: CurrentTileRender = {
      requestId: this.latestRequestId,
      plan,
      options: { ...options },
      width,
      height,
    };
    this.currentTileRender = current;
    const missingVisible = plan.visible.filter((tile) => !this.tileCache.has(tile.key));
    if (missingVisible.length === 0) {
      void this.paintTileRender(current);
      return;
    }
    const missingPrefetch = plan.prefetch.filter((tile) => !this.tileCache.has(tile.key));
    try {
      this.worker?.postMessage({
        type: 'render',
        requestId: this.latestRequestId,
        width,
        height,
        options,
        tileRequest: {
          audioGeneration: this.audioGeneration,
          viewKey: plan.viewKey,
          visible: missingVisible,
          prefetch: missingPrefetch,
        },
      });
    } catch {
      this.switchToCooperativeFallback();
    }
  }

  private disposeWorker(): void {
    this.workerInitializationController?.abort();
    this.workerInitializationController = null;
    this.workerInitialized = false;
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
    const workerUrl = this.workerUrl;
    const revoke = this.workerUrlRevoke;
    this.workerUrlRevokeTimer = globalThis.setTimeout(() => {
      revoke?.(workerUrl);
      if (this.workerUrl === workerUrl) this.workerUrl = null;
      this.workerUrlRevoke = null;
      this.workerUrlRevokeTimer = null;
    }, delayMilliseconds);
  }

  private renderStartupPreview(): void {
    const canvas = this.latestCanvas;
    const options = this.latestOptions;
    if (!canvas || !options || this.destroyed) return;
    this.startupPreviewController?.abort();
    const controller = new AbortController();
    this.startupPreviewController = controller;
    const requestId = this.latestRequestId;
    const targetWidth = this.latestWidth;
    const targetHeight = this.latestHeight;
    void renderSpectrogramPreviewPixelsCooperative(
      this.audio.analysis,
      targetWidth,
      targetHeight,
      options,
      { signal: controller.signal, sliceMilliseconds: 8 },
    )
      .then((frame) => {
        if (controller.signal.aborted || this.destroyed || requestId !== this.latestRequestId)
          return;
        this.startupPreviewController = null;
        this.paint({
          type: 'rendered',
          requestId,
          width: frame.width,
          height: frame.height,
          targetWidth,
          targetHeight,
          quality: 'preview',
          pixels: frame.pixels,
        });
      })
      .catch(() => {
        // Worker initialization remains authoritative. Cancellation and a
        // failed best-effort startup preview must not turn a viable worker
        // render into an error screen.
      });
  }

  private startCooperativeFallback(): void {
    if (this.fallbackController || this.fallbackAnalysis || this.destroyed) return;
    const controller = new AbortController();
    this.fallbackController = controller;
    void computeSpectrogramAnalysisCooperative(this.audio.analysis, {
      signal: controller.signal,
      framesPerYield: 8,
      sliceMilliseconds: 8,
    })
      .then((analysis) => {
        if (this.destroyed || controller.signal.aborted) return;
        this.fallbackController = null;
        this.fallbackAnalysis = analysis;
        this.renderFallback();
      })
      .catch((error) => {
        if (!controller.signal.aborted && !this.destroyed) {
          this.fail(
            `Spectrogram analysis failed. ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      });
  }

  private renderFallback(): void {
    const canvas = this.latestCanvas;
    const options = this.latestOptions;
    const analysis = this.fallbackAnalysis;
    if (!canvas || !options) return;
    this.fallbackRenderController?.abort();
    const controller = new AbortController();
    this.fallbackRenderController = controller;
    const requestId = this.latestRequestId;
    const targetWidth = this.latestWidth;
    const targetHeight = this.latestHeight;
    const render = analysis
      ? renderSpectrogramPixelsCooperative(analysis, targetWidth, targetHeight, options, {
          signal: controller.signal,
          sliceMilliseconds: 8,
        }).then((pixels) => ({
          width: targetWidth,
          height: targetHeight,
          quality: 'exact' as const,
          pixels,
        }))
      : renderSpectrogramPreviewPixelsCooperative(
          this.audio.analysis,
          targetWidth,
          targetHeight,
          options,
          { signal: controller.signal, sliceMilliseconds: 8 },
        ).then((frame) => ({ ...frame, quality: 'preview' as const }));
    void render
      .then((frame) => {
        if (controller.signal.aborted || this.destroyed || requestId !== this.latestRequestId)
          return;
        this.fallbackRenderController = null;
        this.paint({
          type: 'rendered',
          requestId,
          width: frame.width,
          height: frame.height,
          targetWidth,
          targetHeight,
          quality: frame.quality,
          pixels: frame.pixels,
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted && !this.destroyed) {
          this.fail(
            `Spectrogram render failed. ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      });
  }

  private paint(frame: WorkerRenderResult): void {
    if (frame.requestId !== this.latestRequestId || this.destroyed) return;
    const canvas = this.latestCanvas;
    const options = this.latestOptions;
    if (!canvas || !options) return;
    const painted =
      frame.width === frame.targetWidth && frame.height === frame.targetHeight
        ? putPixels(canvas, frame.pixels, frame.width, frame.height)
        : this.paintScaledFrame(canvas, frame);
    if (!painted) {
      this.fail('Spectrogram canvas rendering is unavailable in this browser.');
      return;
    }
    this.finishPaint(
      canvas,
      frame.requestId,
      frame.targetWidth,
      frame.targetHeight,
      options,
      frame.quality,
    );
  }

  private finishPaint(
    canvas: HTMLCanvasElement,
    requestId: number,
    width: number,
    height: number,
    options: SpectrogramRenderOptions,
    quality: 'preview' | 'exact',
  ): void {
    this.displayedCanvas = canvas;
    this.displayedOptions = { ...options };
    this.displayedWidth = width;
    this.displayedHeight = height;
    this.hasFrame = true;
    this.quality = quality;
    this.paintGeneration += 1;
    this.paintedRequestGeneration = requestId;
    this.emitLifecycle('firstFrameReady');
    this.emitState(quality === 'preview' ? 'preview' : 'ready', quality);
  }

  private paintScaledFrame(canvas: HTMLCanvasElement, frame: WorkerRenderResult): boolean {
    const pixelBuffer = this.bufferCanvas(canvas, 'pixels', frame.width, frame.height);
    const composite = this.bufferCanvas(canvas, 'composite', frame.targetWidth, frame.targetHeight);
    const compositeContext = composite?.getContext('2d', { alpha: false });
    if (
      !pixelBuffer ||
      !composite ||
      !compositeContext ||
      !putPixels(pixelBuffer, frame.pixels, frame.width, frame.height)
    ) {
      return false;
    }
    compositeContext.fillStyle = '#030805';
    compositeContext.fillRect(0, 0, frame.targetWidth, frame.targetHeight);
    compositeContext.imageSmoothingEnabled = true;
    compositeContext.drawImage(pixelBuffer, 0, 0, frame.targetWidth, frame.targetHeight);
    return commitCanvas(canvas, composite, frame.targetWidth, frame.targetHeight);
  }

  private async paintTileRender(current: CurrentTileRender): Promise<void> {
    if (current.requestId !== this.latestRequestId || this.destroyed) return;
    this.tilePaintController?.abort();
    const controller = new AbortController();
    this.tilePaintController = controller;
    const tiles = current.plan.visible.map((descriptor) => this.tileCache.get(descriptor.key));
    if (tiles.some((tile) => !tile)) return;
    const completeTiles = tiles.filter((tile) => tile !== undefined);
    const canvas = this.latestCanvas;
    if (!canvas) return;
    try {
      let surface: HTMLCanvasElement | null = null;
      if (!this.webglAttempted) {
        this.webglAttempted = true;
        this.webglAtlas = SpectralWebGLAtlas.create(canvas.ownerDocument);
      }
      if (this.webglAtlas) {
        const atlas = this.webglAtlas;
        try {
          let sliceStartedAt = rendererNow();
          for (const tile of completeTiles) {
            throwRendererAbort(controller.signal, 'Spectrogram GPU upload cancelled');
            if (!atlas.prepareTile(tile)) {
              throw new Error('Spectrogram WebGL context was lost.');
            }
            if (rendererNow() - sliceStartedAt >= 8) {
              await yieldToRendererHost();
              sliceStartedAt = rendererNow();
            }
          }
          throwRendererAbort(controller.signal, 'Spectrogram GPU upload cancelled');
          surface = atlas.render(completeTiles, current.width, current.height, current.options);
          if (!surface) throw new Error('Spectrogram WebGL context was lost.');
        } catch (error) {
          // A newer view owns the same atlas. Cancellation is ordinary
          // latest-wins scheduling and must never tear down that shared GPU
          // resource underneath the replacement painter.
          if (isRendererAbortError(error)) throw error;
          atlas.destroy();
          if (this.webglAtlas === atlas) this.webglAtlas = null;
        }
      }
      if (!surface) {
        surface = await this.composeTilesCanvas2d(completeTiles, current, controller.signal);
      }
      if (
        controller.signal.aborted ||
        this.destroyed ||
        current.requestId !== this.latestRequestId ||
        current.plan.viewKey !== this.currentTileRender?.plan.viewKey
      ) {
        return;
      }
      if (!surface || !commitCanvas(canvas, surface, current.width, current.height)) {
        this.fail('Spectrogram tile composition is unavailable in this browser.');
        return;
      }
      this.startupPreviewController?.abort();
      this.startupPreviewController = null;
      this.tilePaintController = null;
      this.finishPaint(
        canvas,
        current.requestId,
        current.width,
        current.height,
        current.options,
        'exact',
      );
    } catch (error) {
      if (!controller.signal.aborted && !this.destroyed) {
        this.fail(
          `Spectrogram tile composition failed. ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  private async composeTilesCanvas2d(
    tiles: Array<NonNullable<ReturnType<SpectralTileLru['get']>>>,
    current: CurrentTileRender,
    signal: AbortSignal,
  ): Promise<HTMLCanvasElement | null> {
    const canvas = this.latestCanvas;
    if (!canvas) return null;
    const composite = this.bufferCanvas(canvas, 'composite', current.width, current.height);
    const context = composite?.getContext('2d', { alpha: false });
    if (!composite || !context) return null;
    context.fillStyle = '#101713';
    context.fillRect(0, 0, current.width, current.height);
    context.imageSmoothingEnabled = false;
    let sliceStartedAt = rendererNow();
    for (const tile of tiles) {
      throwRendererAbort(signal, 'Spectrogram tile composition cancelled');
      const descriptor = tile.descriptor;
      const pixels = colorizeSpectrogramDb(tile.db, current.options);
      const pixelBuffer = this.bufferCanvas(canvas, 'pixels', descriptor.width, descriptor.height);
      if (!pixelBuffer || !putPixels(pixelBuffer, pixels, descriptor.width, descriptor.height)) {
        return null;
      }
      context.drawImage(
        pixelBuffer,
        descriptor.pixelX,
        descriptor.pixelY,
        descriptor.width,
        descriptor.height,
      );
      if (rendererNow() - sliceStartedAt >= 8) {
        await yieldToRendererHost();
        sliceStartedAt = rendererNow();
      }
    }
    throwRendererAbort(signal, 'Spectrogram tile composition cancelled');
    return composite;
  }

  private reprojectDisplayedFrame(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    next: SpectrogramRenderOptions,
  ): boolean {
    const prior = this.displayedOptions;
    if (
      !this.hasFrame ||
      this.displayedCanvas !== canvas ||
      !prior ||
      this.displayedWidth < 1 ||
      this.displayedHeight < 1 ||
      prior.palette !== next.palette ||
      prior.brightness !== next.brightness ||
      prior.contrast !== next.contrast ||
      prior.channelMode !== next.channelMode ||
      (prior.frequencyScale ?? 'linear') !== (next.frequencyScale ?? 'linear') ||
      (prior.frequencyWarp ?? 0.5) !== (next.frequencyWarp ?? 0.5)
    ) {
      return false;
    }
    const snapshot = this.bufferCanvas(canvas, 'pixels', this.displayedWidth, this.displayedHeight);
    const snapshotContext = snapshot?.getContext('2d', { alpha: false });
    const composite = this.bufferCanvas(canvas, 'composite', width, height);
    const compositeContext = composite?.getContext('2d', { alpha: false });
    if (!snapshot || !snapshotContext || !composite || !compositeContext) return false;
    snapshotContext.drawImage(canvas, 0, 0, this.displayedWidth, this.displayedHeight);
    compositeContext.fillStyle = '#101713';
    compositeContext.fillRect(0, 0, width, height);
    compositeContext.imageSmoothingEnabled = true;

    const nextTimeSpan = next.timeEndSeconds - next.timeStartSeconds;
    const destinationLeft =
      ((prior.timeStartSeconds - next.timeStartSeconds) / nextTimeSpan) * width;
    const destinationRight =
      ((prior.timeEndSeconds - next.timeStartSeconds) / nextTimeSpan) * width;
    const destinationTop = frequencyToPixel(
      prior.highFrequencyHz,
      next.lowFrequencyHz,
      next.highFrequencyHz,
      next.frequencyScale ?? 'linear',
      next.frequencyWarp,
      height,
    );
    const destinationBottom = frequencyToPixel(
      prior.lowFrequencyHz,
      next.lowFrequencyHz,
      next.highFrequencyHz,
      next.frequencyScale ?? 'linear',
      next.frequencyWarp,
      height,
    );
    if (
      !Number.isFinite(destinationLeft) ||
      !Number.isFinite(destinationRight) ||
      !Number.isFinite(destinationTop) ||
      !Number.isFinite(destinationBottom) ||
      destinationRight <= destinationLeft ||
      destinationBottom <= destinationTop
    ) {
      return false;
    }
    paintRetainedEdges(
      compositeContext,
      snapshot,
      this.displayedWidth,
      this.displayedHeight,
      destinationLeft,
      destinationTop,
      destinationRight,
      destinationBottom,
      width,
      height,
    );
    if (!commitCanvas(canvas, composite, width, height)) return false;
    this.displayedOptions = { ...next };
    this.displayedWidth = width;
    this.displayedHeight = height;
    this.quality = 'retained';
    this.paintGeneration += 1;
    this.paintedRequestGeneration = this.latestRequestId;
    return true;
  }

  private bufferCanvas(
    owner: HTMLCanvasElement,
    kind: 'pixels' | 'composite',
    width: number,
    height: number,
  ): HTMLCanvasElement | null {
    let buffer = kind === 'pixels' ? this.pixelBuffer : this.compositeBuffer;
    if (!buffer) {
      buffer = owner.ownerDocument?.createElement('canvas') ?? null;
      if (!buffer) return null;
      if (kind === 'pixels') this.pixelBuffer = buffer;
      else this.compositeBuffer = buffer;
    }
    if (buffer.width !== width) buffer.width = width;
    if (buffer.height !== height) buffer.height = height;
    return buffer;
  }

  private fail(message: string): void {
    if (!this.hasFrame) this.emitLifecycle('error');
    this.emitState('error', this.quality);
    this.onError(message);
  }

  private emitLifecycle(phase: SpectrogramRenderPhase): void {
    if (this.lifecyclePhase === phase) return;
    this.lifecyclePhase = phase;
    this.onPhaseChange(phase);
  }

  private emitState(status: SpectrogramRenderStatus, quality: SpectrogramRenderQuality): void {
    this.onStateChange({
      status,
      quality,
      requestGeneration: this.latestRequestId,
      paintedRequestGeneration: this.paintedRequestGeneration,
      paintGeneration: this.paintGeneration,
      hasFrame: this.hasFrame,
    });
  }
}

function validTileResult(descriptor: SpectralTileDescriptor, db: Float32Array): boolean {
  return (
    descriptor.width >= 1 &&
    descriptor.width <= 256 &&
    descriptor.height >= 1 &&
    descriptor.height <= 256 &&
    Number.isInteger(descriptor.width) &&
    Number.isInteger(descriptor.height) &&
    db instanceof Float32Array &&
    db.length === descriptor.width * descriptor.height
  );
}

/** Copies decoded PCM without one task monopolizing the UI thread. */
export async function cloneAudioChannelsCooperative(
  channels: readonly Float32Array[],
  cooperative: { signal?: AbortSignal; sliceMilliseconds?: number } = {},
): Promise<Float32Array[]> {
  await yieldToRendererHost();
  throwRendererAbort(cooperative.signal, 'Worker initialization cancelled');
  const cloned: Float32Array[] = [];
  const sliceMilliseconds = Math.max(1, cooperative.sliceMilliseconds ?? 8);
  const samplesPerChunk = 262_144;
  let sliceStartedAt = rendererNow();
  for (const source of channels) {
    const target = new Float32Array(source.length);
    for (let start = 0; start < source.length; start += samplesPerChunk) {
      throwRendererAbort(cooperative.signal, 'Worker initialization cancelled');
      const end = Math.min(source.length, start + samplesPerChunk);
      target.set(source.subarray(start, end), start);
      if (rendererNow() - sliceStartedAt >= sliceMilliseconds) {
        await yieldToRendererHost();
        sliceStartedAt = rendererNow();
      }
    }
    cloned.push(target);
  }
  throwRendererAbort(cooperative.signal, 'Worker initialization cancelled');
  return cloned;
}

function paintRetainedEdges(
  context: CanvasRenderingContext2D,
  snapshot: HTMLCanvasElement,
  sourceWidth: number,
  sourceHeight: number,
  destinationLeft: number,
  destinationTop: number,
  destinationRight: number,
  destinationBottom: number,
  width: number,
  height: number,
): void {
  const destinationWidth = destinationRight - destinationLeft;
  const destinationHeight = destinationBottom - destinationTop;
  const rightGap = Math.max(0, width - destinationRight);
  const bottomGap = Math.max(0, height - destinationBottom);

  if (destinationLeft > 0) {
    context.drawImage(
      snapshot,
      0,
      0,
      1,
      sourceHeight,
      0,
      destinationTop,
      destinationLeft,
      destinationHeight,
    );
  }
  if (rightGap > 0) {
    context.drawImage(
      snapshot,
      sourceWidth - 1,
      0,
      1,
      sourceHeight,
      destinationRight,
      destinationTop,
      rightGap,
      destinationHeight,
    );
  }
  if (destinationTop > 0) {
    context.drawImage(
      snapshot,
      0,
      0,
      sourceWidth,
      1,
      destinationLeft,
      0,
      destinationWidth,
      destinationTop,
    );
  }
  if (bottomGap > 0) {
    context.drawImage(
      snapshot,
      0,
      sourceHeight - 1,
      sourceWidth,
      1,
      destinationLeft,
      destinationBottom,
      destinationWidth,
      bottomGap,
    );
  }
  if (destinationLeft > 0 && destinationTop > 0) {
    context.drawImage(snapshot, 0, 0, 1, 1, 0, 0, destinationLeft, destinationTop);
  }
  if (rightGap > 0 && destinationTop > 0) {
    context.drawImage(
      snapshot,
      sourceWidth - 1,
      0,
      1,
      1,
      destinationRight,
      0,
      rightGap,
      destinationTop,
    );
  }
  if (destinationLeft > 0 && bottomGap > 0) {
    context.drawImage(
      snapshot,
      0,
      sourceHeight - 1,
      1,
      1,
      0,
      destinationBottom,
      destinationLeft,
      bottomGap,
    );
  }
  if (rightGap > 0 && bottomGap > 0) {
    context.drawImage(
      snapshot,
      sourceWidth - 1,
      sourceHeight - 1,
      1,
      1,
      destinationRight,
      destinationBottom,
      rightGap,
      bottomGap,
    );
  }
  context.drawImage(snapshot, destinationLeft, destinationTop, destinationWidth, destinationHeight);
}

function rendererNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function throwRendererAbort(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw new DOMException(message, 'AbortError');
}

function isRendererAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function yieldToRendererHost(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

function commitCanvas(
  target: HTMLCanvasElement,
  source: HTMLCanvasElement,
  width: number,
  height: number,
): boolean {
  const context = target.getContext('2d', { alpha: false });
  if (!context) return false;
  // Resize and copy occur in one JavaScript task, so the compositor can never
  // expose the cleared intermediate bitmap.
  if (target.width !== width) target.width = width;
  if (target.height !== height) target.height = height;
  context.imageSmoothingEnabled = true;
  context.drawImage(source, 0, 0, width, height);
  return true;
}

function putPixels(
  canvas: HTMLCanvasElement,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return false;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const image =
    typeof ImageData === 'undefined'
      ? context.createImageData(width, height)
      : new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height);
  if (image.data !== pixels) image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return true;
}

function frequencyToPixel(
  frequencyHz: number,
  lowFrequencyHz: number,
  highFrequencyHz: number,
  scale: SpectrogramRenderOptions['frequencyScale'],
  warp: number | undefined,
  height: number,
): number {
  return (
    (1 - frequencyToAxisRatio(frequencyHz, lowFrequencyHz, highFrequencyHz, scale, warp)) * height
  );
}

function rasterSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const density = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  return {
    width: Math.max(1, Math.min(1600, Math.round(canvas.clientWidth * density))),
    height: Math.max(1, Math.min(800, Math.round(canvas.clientHeight * density))),
  };
}
