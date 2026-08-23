import {
  computeSpectrogramAnalysisCooperative,
  poolSpectrogramDbRegionCooperative,
  renderSpectrogramPixelsCooperative,
  renderSpectrogramPreviewPixels,
  type SpectrogramAnalysis,
  type SpectrogramRenderOptions,
} from '../audio/spectrogram';
import type { SpectralTileDescriptor } from '../audio/SpectralTileAtlas';
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
  tileRequest?: {
    audioGeneration: number;
    viewKey: string;
    visible: SpectralTileDescriptor[];
    prefetch: SpectralTileDescriptor[];
  };
}

type WorkerRequest = InitializeMessage | RenderMessage;

const workerScope = self as unknown as Pick<Worker, 'onmessage' | 'postMessage'>;
let source: AudioAnalysisSource | null = null;
let analysis: SpectrogramAnalysis | null = null;
let initializationGeneration = 0;
let initializationController: AbortController | null = null;
let activeRenderController: AbortController | null = null;
let latestRender: RenderMessage | null = null;
let pendingRender: RenderMessage | null = null;
let draining = false;
const EXACT_FRAME_CACHE_BYTES = 16 * 1024 * 1024;
const exactFrameCache = new Map<string, Uint8ClampedArray>();
let exactFrameCacheBytes = 0;

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === 'initialize') {
    beginInitialization(message.source);
    return;
  }
  latestRender = message;
  pendingRender = message;
  activeRenderController?.abort();
  void drainLatestRender();
};

function beginInitialization(nextSource: AudioAnalysisSource): void {
  initializationGeneration += 1;
  const generation = initializationGeneration;
  initializationController?.abort();
  activeRenderController?.abort();
  const controller = new AbortController();
  initializationController = controller;
  source = nextSource;
  analysis = null;
  exactFrameCache.clear();
  exactFrameCacheBytes = 0;

  // Give the immediately-following render message a chance to request a
  // bounded preview before complete-clip STFT work begins.
  void yieldToWorker()
    .then(() =>
      computeSpectrogramAnalysisCooperative(nextSource, {
        signal: controller.signal,
        framesPerYield: 8,
        sliceMilliseconds: 8,
      }),
    )
    .then((nextAnalysis) => {
      if (controller.signal.aborted || generation !== initializationGeneration) return;
      analysis = nextAnalysis;
      source = null;
      initializationController = null;
      if (latestRender) {
        pendingRender = latestRender;
        activeRenderController?.abort();
        void drainLatestRender();
      }
    })
    .catch((error) => {
      if (isAbortError(error) || generation !== initializationGeneration) return;
      workerScope.postMessage({
        type: 'error',
        requestId: latestRender?.requestId ?? 0,
        message: error instanceof Error ? error.message : 'Unknown analysis error',
      });
    });
}

async function drainLatestRender(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pendingRender) {
      const message = pendingRender;
      pendingRender = null;
      const controller = new AbortController();
      activeRenderController = controller;
      try {
        if (analysis) {
          if (message.tileRequest) {
            await renderTiles(message, analysis, controller);
          } else {
            const cacheKey = exactFrameCacheKey(message);
            const cached = takeCachedExactFrame(cacheKey);
            const pixels =
              cached ??
              (await renderSpectrogramPixelsCooperative(
                analysis,
                message.width,
                message.height,
                message.options,
                { signal: controller.signal, sliceMilliseconds: 8 },
              ));
            if (controller.signal.aborted || message.requestId !== latestRender?.requestId)
              continue;
            if (!cached) cacheExactFrame(cacheKey, pixels);
            postFrame(message, message.width, message.height, pixels, 'exact');
          }
        } else if (source) {
          const preview = renderSpectrogramPreviewPixels(
            source,
            message.width,
            message.height,
            message.options,
          );
          if (controller.signal.aborted || message.requestId !== latestRender?.requestId) continue;
          postFrame(message, preview.width, preview.height, preview.pixels, 'preview');
        }
      } catch (error) {
        if (isAbortError(error)) continue;
        workerScope.postMessage({
          type: 'error',
          requestId: message.requestId,
          message: error instanceof Error ? error.message : 'Unknown render error',
        });
      }
    }
  } finally {
    activeRenderController = null;
    draining = false;
    // A message can arrive after the loop condition but before `draining` is
    // cleared. Re-enter once so that request cannot be stranded.
    if (pendingRender) void drainLatestRender();
  }
}

async function renderTiles(
  message: RenderMessage,
  currentAnalysis: SpectrogramAnalysis,
  controller: AbortController,
): Promise<void> {
  const request = message.tileRequest;
  if (!request) return;
  for (const descriptor of request.visible) {
    const db = await renderTile(currentAnalysis, descriptor, controller.signal);
    if (controller.signal.aborted || message.requestId !== latestRender?.requestId) return;
    postTile(message.requestId, request.audioGeneration, descriptor, db);
  }
  if (controller.signal.aborted || message.requestId !== latestRender?.requestId) return;
  workerScope.postMessage({
    type: 'tiles-complete',
    requestId: message.requestId,
    audioGeneration: request.audioGeneration,
    viewKey: request.viewKey,
  });
  for (const descriptor of request.prefetch) {
    const db = await renderTile(currentAnalysis, descriptor, controller.signal);
    if (controller.signal.aborted || message.requestId !== latestRender?.requestId) return;
    postTile(message.requestId, request.audioGeneration, descriptor, db);
  }
}

function renderTile(
  currentAnalysis: SpectrogramAnalysis,
  descriptor: SpectralTileDescriptor,
  signal: AbortSignal,
): Promise<Float32Array> {
  return poolSpectrogramDbRegionCooperative(
    currentAnalysis,
    {
      rasterWidth: descriptor.rasterWidth,
      rasterHeight: descriptor.rasterHeight,
      pixelX: descriptor.pixelX,
      pixelY: descriptor.pixelY,
      width: descriptor.width,
      height: descriptor.height,
    },
    descriptor.options,
    { signal, sliceMilliseconds: 8 },
  );
}

function postTile(
  requestId: number,
  audioGeneration: number,
  descriptor: SpectralTileDescriptor,
  db: Float32Array,
): void {
  workerScope.postMessage(
    {
      type: 'tile',
      requestId,
      audioGeneration,
      descriptor,
      db,
    },
    [db.buffer],
  );
}

function exactFrameCacheKey(message: RenderMessage): string {
  const options = message.options;
  return JSON.stringify([
    message.width,
    message.height,
    options.timeStartSeconds,
    options.timeEndSeconds,
    options.lowFrequencyHz,
    options.highFrequencyHz,
    options.brightness,
    options.contrast ?? 1,
    options.palette,
    options.channelMode ?? 'average',
    options.frequencyScale ?? 'linear',
    options.frequencyWarp ?? 0.5,
  ]);
}

function takeCachedExactFrame(key: string): Uint8ClampedArray | null {
  const cached = exactFrameCache.get(key);
  if (!cached) return null;
  exactFrameCache.delete(key);
  exactFrameCache.set(key, cached);
  // Transferring detaches the posted array; retain the cache-owned buffer.
  return cached.slice();
}

function cacheExactFrame(key: string, pixels: Uint8ClampedArray): void {
  if (pixels.byteLength > EXACT_FRAME_CACHE_BYTES) return;
  const prior = exactFrameCache.get(key);
  if (prior) {
    exactFrameCacheBytes -= prior.byteLength;
    exactFrameCache.delete(key);
  }
  const retained = pixels.slice();
  exactFrameCache.set(key, retained);
  exactFrameCacheBytes += retained.byteLength;
  while (exactFrameCacheBytes > EXACT_FRAME_CACHE_BYTES) {
    const oldestKey = exactFrameCache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    const oldest = exactFrameCache.get(oldestKey);
    exactFrameCache.delete(oldestKey);
    exactFrameCacheBytes -= oldest?.byteLength ?? 0;
  }
}

function postFrame(
  message: RenderMessage,
  pixelWidth: number,
  pixelHeight: number,
  pixels: Uint8ClampedArray,
  quality: 'preview' | 'exact',
): void {
  workerScope.postMessage(
    {
      type: 'rendered',
      requestId: message.requestId,
      width: pixelWidth,
      height: pixelHeight,
      targetWidth: message.width,
      targetHeight: message.height,
      quality,
      pixels,
    },
    [pixels.buffer],
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function yieldToWorker(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

workerScope.postMessage({ type: 'ready' });
