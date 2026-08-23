import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedAudio } from '../../src/audio/AudioResource';
import { SpectralWebGLAtlas } from '../../src/audio/SpectralTileAtlas';
import {
  cloneAudioChannelsCooperative,
  SpectrogramRenderer,
  type SpectrogramRenderState,
} from '../../src/audio/SpectrogramRenderer';
import type { SpectrogramRenderOptions } from '../../src/audio/spectrogram';

class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly messages: unknown[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === 'function'
        ? (listener as (event: MessageEvent) => void)
        : (event: MessageEvent) => listener.handleEvent(event);
    const callbacks = this.listeners.get(type) ?? new Set();
    callbacks.add(callback);
    this.listeners.set(type, callbacks);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(data: unknown): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent);
    }
  }
}

interface FakeCanvasContext {
  drawImage: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  putImageData: ReturnType<typeof vi.fn>;
  createImageData(width: number, height: number): { data: Uint8ClampedArray };
  fillStyle: string;
  imageSmoothingEnabled: boolean;
}

const contexts = new WeakMap<HTMLCanvasElement, FakeCanvasContext>();
let allContexts: FakeCanvasContext[] = [];
let originalCreateObjectUrl: typeof URL.createObjectURL | undefined;
let originalRevokeObjectUrl: typeof URL.revokeObjectURL | undefined;

beforeEach(() => {
  FakeWorker.instances = [];
  allContexts = [];
  vi.stubGlobal('Worker', FakeWorker);
  originalCreateObjectUrl = URL.createObjectURL;
  originalRevokeObjectUrl = URL.revokeObjectURL;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:froglabel-renderer-test'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    let context = contexts.get(this);
    if (!context) {
      context = {
        drawImage: vi.fn(),
        fillRect: vi.fn(),
        putImageData: vi.fn(),
        createImageData: (width, height) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        fillStyle: '',
        imageSmoothingEnabled: false,
      };
      contexts.set(this, context);
      allContexts.push(context);
    }
    return context as unknown as CanvasRenderingContext2D;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: originalCreateObjectUrl,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: originalRevokeObjectUrl,
  });
});

describe('SpectrogramRenderer retained surface', () => {
  it('keeps the current bitmap until paint and ignores stale worker frames', async () => {
    const phases: string[] = [];
    const states: SpectrogramRenderState[] = [];
    const errors: string[] = [];
    const renderer = new SpectrogramRenderer(
      loadedAudio(),
      (message) => errors.push(message),
      (phase) => phases.push(phase),
      (state) => states.push(state),
    );
    const worker = FakeWorker.instances[0];
    const canvas = document.createElement('canvas');
    canvas.width = 17;
    canvas.height = 11;
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 320 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 180 });

    expect(renderer.render(canvas, renderOptions())).toBe(1);
    expect(canvas.width).toBe(17);
    expect(canvas.height).toBe(11);
    expect(states.at(-1)).toMatchObject({
      status: 'initializing',
      requestGeneration: 1,
      paintGeneration: 0,
      hasFrame: false,
    });

    await vi.waitFor(() => {
      expect(states.at(-1)).toMatchObject({ status: 'preview', quality: 'preview' });
    });
    const startupPaintGeneration = states.at(-1)?.paintGeneration ?? 0;
    expect(worker.messages).toEqual([]);

    worker.emit({ type: 'ready' });
    await vi.waitFor(() => {
      expect(worker.messages.map((message) => (message as { type: string }).type)).toEqual([
        'initialize',
        'render',
      ]);
    });
    worker.emit({
      type: 'rendered',
      requestId: 1,
      width: 2,
      height: 2,
      targetWidth: 320,
      targetHeight: 180,
      quality: 'preview',
      pixels: new Uint8ClampedArray(16),
    });
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    expect(phases).toEqual(['analyzing', 'firstFrameReady']);
    expect(states.at(-1)).toMatchObject({
      status: 'preview',
      quality: 'preview',
      paintedRequestGeneration: 1,
      paintGeneration: startupPaintGeneration + 1,
      hasFrame: true,
    });

    expect(
      renderer.render(canvas, {
        ...renderOptions(),
        timeStartSeconds: 0.1,
        timeEndSeconds: 1.1,
      }),
    ).toBe(2);
    expect(states.at(-1)).toMatchObject({
      status: 'refining',
      quality: 'retained',
      requestGeneration: 2,
      paintedRequestGeneration: 2,
      paintGeneration: startupPaintGeneration + 2,
    });
    expect(allContexts.some((context) => context.fillStyle === '#101713')).toBe(true);
    expect(
      allContexts.some((context) =>
        context.drawImage.mock.calls.some((call) => call.length === 9 && call[3] === 1),
      ),
    ).toBe(true);

    worker.emit({
      type: 'rendered',
      requestId: 1,
      width: 320,
      height: 180,
      targetWidth: 320,
      targetHeight: 180,
      quality: 'exact',
      pixels: new Uint8ClampedArray(320 * 180 * 4),
    });
    expect(states.at(-1)?.paintGeneration).toBe(startupPaintGeneration + 2);

    worker.emit({
      type: 'rendered',
      requestId: 2,
      width: 320,
      height: 180,
      targetWidth: 320,
      targetHeight: 180,
      quality: 'exact',
      pixels: new Uint8ClampedArray(320 * 180 * 4),
    });
    expect(states.at(-1)).toMatchObject({
      status: 'ready',
      quality: 'exact',
      requestGeneration: 2,
      paintedRequestGeneration: 2,
      paintGeneration: startupPaintGeneration + 3,
    });
    expect(errors).toEqual([]);
    renderer.destroy();
    expect(worker.terminated).toBe(true);
  });

  it('assembles exact view tiles and reuses their dB data for palette-only renders', async () => {
    const states: SpectrogramRenderState[] = [];
    const renderer = new SpectrogramRenderer(
      loadedAudio(),
      () => undefined,
      () => undefined,
      (state) => states.push(state),
    );
    const worker = FakeWorker.instances[0];
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 32 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 18 });
    renderer.render(canvas, renderOptions());
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => {
      expect(worker.messages.map((message) => (message as { type: string }).type)).toEqual([
        'initialize',
        'render',
      ]);
    });
    const renderMessage = worker.messages[1] as {
      requestId: number;
      tileRequest: {
        audioGeneration: number;
        viewKey: string;
        visible: Array<{
          width: number;
          height: number;
        }>;
      };
    };
    expect(renderMessage.tileRequest.visible).toHaveLength(1);
    for (const descriptor of renderMessage.tileRequest.visible) {
      worker.emit({
        type: 'tile',
        requestId: renderMessage.requestId,
        audioGeneration: renderMessage.tileRequest.audioGeneration,
        descriptor,
        db: new Float32Array(descriptor.width * descriptor.height).fill(-60),
      });
    }
    worker.emit({
      type: 'tiles-complete',
      requestId: renderMessage.requestId,
      audioGeneration: renderMessage.tileRequest.audioGeneration,
      viewKey: renderMessage.tileRequest.viewKey,
    });
    await vi.waitFor(() => {
      expect(states.at(-1)).toMatchObject({ status: 'ready', quality: 'exact' });
    });

    const workerMessageCount = worker.messages.length;
    renderer.render(canvas, {
      ...renderOptions(),
      palette: 'magma',
      brightness: 1.7,
      contrast: 1.2,
    });
    await vi.waitFor(() => {
      expect(states.at(-1)).toMatchObject({
        status: 'ready',
        quality: 'exact',
        requestGeneration: 2,
        paintedRequestGeneration: 2,
      });
    });
    expect(worker.messages).toHaveLength(workerMessageCount);
    renderer.destroy();
  });

  it('keeps the shared WebGL atlas when a newer render cancels an upload', async () => {
    const states: SpectrogramRenderState[] = [];
    const renderer = new SpectrogramRenderer(
      loadedAudio(),
      () => undefined,
      () => undefined,
      (state) => states.push(state),
    );
    const worker = FakeWorker.instances[0];
    const canvas = sizedCanvas(32, 18);
    renderer.render(canvas, renderOptions());
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
    const renderMessage = tileRenderMessage(worker);
    const atlas = fakeAtlas(document.createElement('canvas'));
    vi.spyOn(SpectralWebGLAtlas, 'create').mockReturnValue(atlas.value);
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 9));

    emitVisibleTiles(worker, renderMessage);
    worker.emit({
      type: 'tiles-complete',
      requestId: renderMessage.requestId,
      audioGeneration: renderMessage.tileRequest.audioGeneration,
      viewKey: renderMessage.tileRequest.viewKey,
    });
    renderer.render(canvas, { ...renderOptions(), palette: 'magma' });

    await vi.waitFor(() => {
      expect(states.at(-1)).toMatchObject({
        status: 'ready',
        quality: 'exact',
        requestGeneration: 2,
        paintedRequestGeneration: 2,
      });
    });
    expect(atlas.destroy).not.toHaveBeenCalled();
    expect(atlas.render).toHaveBeenCalled();
    renderer.destroy();
    expect(atlas.destroy).toHaveBeenCalledOnce();
  });

  it('releases worker-only tile and GPU caches when it permanently falls back', async () => {
    const renderer = new SpectrogramRenderer(loadedAudio(), () => undefined);
    const worker = FakeWorker.instances[0];
    const canvas = sizedCanvas(32, 18);
    renderer.render(canvas, renderOptions());
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.messages).toHaveLength(2));
    const renderMessage = tileRenderMessage(worker);
    const atlas = fakeAtlas(document.createElement('canvas'));
    vi.spyOn(SpectralWebGLAtlas, 'create').mockReturnValue(atlas.value);
    emitVisibleTiles(worker, renderMessage);
    worker.emit({
      type: 'tiles-complete',
      requestId: renderMessage.requestId,
      audioGeneration: renderMessage.tileRequest.audioGeneration,
      viewKey: renderMessage.tileRequest.viewKey,
    });
    await vi.waitFor(() => expect(atlas.render).toHaveBeenCalled());

    worker.emit({ type: 'error', requestId: renderMessage.requestId, message: 'worker failed' });
    expect(worker.terminated).toBe(true);
    expect(atlas.releaseTile).toHaveBeenCalledTimes(renderMessage.tileRequest.visible.length);
    expect(atlas.destroy).toHaveBeenCalledOnce();
    renderer.destroy();
    expect(atlas.destroy).toHaveBeenCalledOnce();
  });

  it('copies PCM cooperatively without sharing or touching it after cancellation', async () => {
    const source = Float32Array.from({ length: 300_000 }, (_, index) => index / 300_000);
    const cloned = await cloneAudioChannelsCooperative([source], { sliceMilliseconds: 1 });
    expect(cloned[0]).toHaveLength(source.length);
    expect(Array.from(cloned[0].subarray(0, 32))).toEqual(Array.from(source.subarray(0, 32)));
    expect(cloned[0].at(-1)).toBe(source.at(-1));
    expect(cloned[0].buffer).not.toBe(source.buffer);
    source[0] = -1;
    expect(cloned[0][0]).toBe(0);

    const controller = new AbortController();
    const cancelled = cloneAudioChannelsCooperative([source], {
      signal: controller.signal,
      sliceMilliseconds: 1,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function renderOptions(): SpectrogramRenderOptions {
  return {
    timeStartSeconds: 0,
    timeEndSeconds: 1,
    lowFrequencyHz: 0,
    highFrequencyHz: 4_000,
    brightness: 1,
    contrast: 1,
    palette: 'viridis',
    channelMode: 'average',
    frequencyScale: 'linear',
  };
}

function loadedAudio(): LoadedAudio {
  const samples = new Float32Array(8_000);
  return {
    source: {
      url: 'data:audio/wav;base64,',
      filename: 'test.wav',
      mimeType: 'audio/wav',
    },
    analysis: { sampleRateHz: 8_000, channelCount: 1, channels: [samples] },
    element: new EventTarget() as LoadedAudio['element'],
    durationSeconds: 1,
    decodedSampleRateHz: 8_000,
    sourceSampleRateHz: 8_000,
    maximumFrequencyHz: 4_000,
    channelCount: 1,
    decoder: 'source-faithful-wav',
    dispose: vi.fn(),
  };
}

function sizedCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: height });
  return canvas;
}

function tileRenderMessage(worker: FakeWorker) {
  return worker.messages[1] as {
    requestId: number;
    tileRequest: {
      audioGeneration: number;
      viewKey: string;
      visible: Array<{ width: number; height: number }>;
    };
  };
}

function emitVisibleTiles(worker: FakeWorker, message: ReturnType<typeof tileRenderMessage>): void {
  for (const descriptor of message.tileRequest.visible) {
    worker.emit({
      type: 'tile',
      requestId: message.requestId,
      audioGeneration: message.tileRequest.audioGeneration,
      descriptor,
      db: new Float32Array(descriptor.width * descriptor.height).fill(-60),
    });
  }
}

function fakeAtlas(surface: HTMLCanvasElement) {
  const prepareTile = vi.fn(() => true);
  const render = vi.fn(() => surface);
  const releaseTile = vi.fn();
  const destroy = vi.fn();
  return {
    value: { prepareTile, render, releaseTile, destroy } as unknown as SpectralWebGLAtlas,
    prepareTile,
    render,
    releaseTile,
    destroy,
  };
}
