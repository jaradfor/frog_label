import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedAudio } from '../../src/audio/AudioResource';
import { SpectrogramCanvas } from '../../src/components/workspace/SpectrogramCanvas';

const rendererHarness = vi.hoisted(() => ({
  behaviors: [] as Array<'ready' | 'refining' | 'error'>,
  render: vi.fn(),
  latest: null as null | { emitReady(): void },
}));

vi.mock('../../src/audio/SpectrogramRenderer', () => ({
  SpectrogramRenderer: class {
    private requestGeneration = 0;
    private paintGeneration = 0;

    constructor(
      _audio: unknown,
      _onError: (message: string) => void,
      private readonly onPhase: (phase: string) => void,
      private readonly onState: (state: object) => void,
    ) {
      rendererHarness.latest = { emitReady: () => this.emitReady() };
    }

    render(): number {
      this.requestGeneration += 1;
      rendererHarness.render(this.requestGeneration);
      const behavior = rendererHarness.behaviors.shift() ?? 'ready';
      if (behavior === 'error') {
        this.onPhase('error');
        this.onState({
          status: 'error',
          quality: 'none',
          requestGeneration: this.requestGeneration,
          paintedRequestGeneration: 0,
          paintGeneration: this.paintGeneration,
          hasFrame: false,
        });
      } else if (behavior === 'refining') {
        this.onState({
          status: 'refining',
          quality: 'exact',
          requestGeneration: this.requestGeneration,
          paintedRequestGeneration: this.requestGeneration - 1,
          paintGeneration: this.paintGeneration,
          hasFrame: true,
        });
      } else {
        this.emitReady();
      }
      return this.requestGeneration;
    }

    destroy(): void {}

    private emitReady(): void {
      this.paintGeneration += 1;
      this.onPhase('firstFrameReady');
      this.onState({
        status: 'ready',
        quality: 'exact',
        requestGeneration: this.requestGeneration,
        paintedRequestGeneration: this.requestGeneration,
        paintGeneration: this.paintGeneration,
        hasFrame: true,
      });
    }
  },
}));

let resizeCallback: ResizeObserverCallback;

beforeEach(() => {
  rendererHarness.behaviors.length = 0;
  rendererHarness.render.mockClear();
  rendererHarness.latest = null;
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    setTransform: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
  Reflect.deleteProperty(HTMLElement.prototype, 'hasPointerCapture');
  Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture');
});

describe('SpectrogramCanvas camera gestures', () => {
  it('streams two-axis middle-button pan deltas during pointer movement', () => {
    const onPanView = vi.fn();
    const result = render(
      <SpectrogramCanvas
        audio={loadedAudio()}
        boxes={[]}
        selectedBoxId={null}
        tool="select"
        canDraw={false}
        disabled={false}
        view={{
          durationSeconds: 10,
          maximumFrequencyHz: 4_000,
          timeStartSeconds: 0,
          timeEndSeconds: 10,
          lowFrequencyHz: 0,
          highFrequencyHz: 4_000,
        }}
        settings={{
          fftSamples: 256,
          overlapPercent: 75,
          brightness: 1,
          contrast: 1,
          palette: 'viridis',
          channelMode: 'average',
          frequencyScale: 'linear',
        }}
        playheadSeconds={0}
        cancelVersion={0}
        onSelect={vi.fn()}
        onCreate={vi.fn()}
        onResize={vi.fn()}
        onPanView={onPanView}
        onError={vi.fn()}
        onSemanticEvent={vi.fn()}
      />,
    );
    const stage = result.container.querySelector('.spectrogram-stage') as HTMLDivElement;
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 200 });
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });
    act(() => resizeCallback([], {} as ResizeObserver));

    fireEvent.pointerDown(stage, {
      pointerId: 7,
      button: 1,
      buttons: 4,
      clientX: 100,
      clientY: 80,
    });
    expect(stage).toHaveFocus();
    fireEvent.pointerMove(stage, {
      pointerId: 7,
      button: -1,
      buttons: 4,
      clientX: 120,
      clientY: 90,
    });
    expect(onPanView).toHaveBeenCalledTimes(1);
    expect(onPanView).toHaveBeenLastCalledWith(-0.5, 0.05);
    fireEvent.pointerUp(stage, {
      pointerId: 7,
      button: 1,
      buttons: 0,
      clientX: 120,
      clientY: 90,
    });
    expect(onPanView).toHaveBeenCalledTimes(1);
  });

  it('keeps selection and secondary-button camera pan available when drawing is locked', () => {
    const onSelect = vi.fn();
    const onPanView = vi.fn();
    const result = render(
      <SpectrogramCanvas
        audio={loadedAudio()}
        boxes={[
          {
            id: 'box:read-only',
            species: {
              speciesId: 'species:green',
              code: 'GRE',
              speciesName: 'Green Tree Frog',
              addedAfterInitialization: false,
            },
            startTimeSeconds: 2,
            endTimeSeconds: 4,
            lowFrequencyHz: 1_000,
            highFrequencyHz: 3_000,
            provenance: { source: 'human' },
          },
        ]}
        selectedBoxId={null}
        tool="select"
        canDraw={false}
        disabled
        view={{
          durationSeconds: 10,
          maximumFrequencyHz: 4_000,
          timeStartSeconds: 0,
          timeEndSeconds: 10,
          lowFrequencyHz: 0,
          highFrequencyHz: 4_000,
        }}
        settings={{
          fftSamples: 256,
          overlapPercent: 75,
          brightness: 1,
          contrast: 1,
          palette: 'viridis',
          channelMode: 'average',
          frequencyScale: 'linear',
        }}
        playheadSeconds={0}
        cancelVersion={0}
        onSelect={onSelect}
        onCreate={vi.fn()}
        onResize={vi.fn()}
        onPanView={onPanView}
        onError={vi.fn()}
        onSemanticEvent={vi.fn()}
      />,
    );
    const stage = result.container.querySelector('.spectrogram-stage') as HTMLDivElement;
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 200 });
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 400,
      bottom: 200,
      width: 400,
      height: 200,
      toJSON: () => ({}),
    });
    act(() => resizeCallback([], {} as ResizeObserver));

    const annotation = result.container.querySelector('.annotation-box') as HTMLDivElement;
    fireEvent.pointerDown(annotation, {
      pointerId: 8,
      button: 0,
      buttons: 1,
      clientX: 100,
      clientY: 80,
    });
    expect(stage).toHaveFocus();
    expect(onSelect).toHaveBeenLastCalledWith('box:read-only');

    fireEvent.pointerDown(annotation, {
      pointerId: 9,
      button: 1,
      buttons: 4,
      clientX: 100,
      clientY: 80,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 9,
      button: -1,
      buttons: 4,
      clientX: 120,
      clientY: 90,
    });
    expect(onPanView).toHaveBeenCalledWith(-0.5, 0.05);
  });

  it('renders through Retry even when the viewport inputs are unchanged', async () => {
    // jsdom reports a 1px initial stage before the explicit resize below.
    rendererHarness.behaviors.push('error', 'error', 'ready');
    const result = renderCanvas();
    resizeStage(result.container);

    expect(await result.findByRole('alert')).toHaveTextContent('Spectrogram could not be built.');
    expect(rendererHarness.render).toHaveBeenCalledTimes(2);
    fireEvent.click(result.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(rendererHarness.render).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.queryByRole('alert')).toBeNull());
    expect(result.container.querySelector('.spectrogram-shell')).toHaveAttribute(
      'data-render-status',
      'ready',
    );
  });

  it('keeps boxes on the painted projection and gates gestures until a new scale paints', async () => {
    rendererHarness.behaviors.push('ready', 'ready', 'refining');
    const box = annotationBox();
    const common = canvasProps({ boxes: [box] });
    const result = render(<SpectrogramCanvas {...common} />);
    resizeStage(result.container);
    await waitFor(() =>
      expect(result.container.querySelector('.spectrogram-stage')).toHaveAttribute(
        'data-annotation-gestures-ready',
        'true',
      ),
    );
    const initialTop = (result.container.querySelector('.annotation-box') as HTMLElement).style.top;

    result.rerender(
      <SpectrogramCanvas
        {...common}
        view={{ ...common.view, lowFrequencyHz: 20 }}
        settings={{ ...common.settings, frequencyScale: 'logarithmic' }}
      />,
    );
    await waitFor(() => expect(rendererHarness.render).toHaveBeenCalledTimes(3));
    expect(result.container.querySelector('.spectrogram-stage')).toHaveAttribute(
      'data-annotation-gestures-ready',
      'false',
    );
    expect((result.container.querySelector('.annotation-box') as HTMLElement).style.top).toBe(
      initialTop,
    );

    act(() => rendererHarness.latest?.emitReady());
    await waitFor(() =>
      expect(result.container.querySelector('.spectrogram-stage')).toHaveAttribute(
        'data-annotation-gestures-ready',
        'true',
      ),
    );
    expect((result.container.querySelector('.annotation-box') as HTMLElement).style.top).not.toBe(
      initialTop,
    );
  });

  it('reports plot, waveform, and frequency-ruler zoom contexts without making them sticky', () => {
    const onPointerZoomContextChange = vi.fn();
    const result = render(
      <SpectrogramCanvas
        {...canvasProps()}
        onPointerZoomContextChange={onPointerZoomContextChange}
      />,
    );
    const shell = result.container.querySelector('.spectrogram-shell') as HTMLDivElement;
    const waveform = result.container.querySelector('.waveform-strip') as HTMLDivElement;
    const frequencyAxis = result.container.querySelector('.frequency-axis') as HTMLDivElement;
    const stage = result.container.querySelector('.spectrogram-stage') as HTMLDivElement;
    stubRectangle(shell, { left: 0, top: 0, width: 448, height: 258 });
    stubRectangle(waveform, { left: 48, top: 0, width: 400, height: 58 });
    stubRectangle(frequencyAxis, { left: 0, top: 58, width: 48, height: 200 });
    stubRectangle(stage, { left: 48, top: 58, width: 400, height: 200 });

    fireEvent.pointerMove(waveform, { clientX: 148, clientY: 29 });
    expect(onPointerZoomContextChange).toHaveBeenLastCalledWith({
      scope: 'time',
      timeRatio: 0.25,
      frequencyRatio: 0.5,
    });
    expect(shell).toHaveAttribute('data-pointer-zoom-scope', 'time');

    fireEvent.pointerMove(frequencyAxis, { clientX: 24, clientY: 108 });
    expect(onPointerZoomContextChange).toHaveBeenLastCalledWith({
      scope: 'frequency',
      timeRatio: 0.5,
      frequencyRatio: 0.75,
    });
    expect(shell).toHaveAttribute('data-pointer-zoom-scope', 'frequency');

    fireEvent.pointerMove(stage, { clientX: 348, clientY: 108 });
    expect(onPointerZoomContextChange).toHaveBeenLastCalledWith({
      scope: 'both',
      timeRatio: 0.75,
      frequencyRatio: 0.75,
    });
    expect(shell).toHaveAttribute('data-pointer-zoom-scope', 'both');

    fireEvent.pointerLeave(shell, { clientX: 500, clientY: 300 });
    expect(onPointerZoomContextChange).toHaveBeenLastCalledWith(null);
    expect(shell).toHaveAttribute('data-pointer-zoom-scope', 'idle');
  });
});

function renderCanvas() {
  return render(<SpectrogramCanvas {...canvasProps()} />);
}

function resizeStage(container: HTMLElement): void {
  const stage = container.querySelector('.spectrogram-stage') as HTMLDivElement;
  Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 200 });
  act(() => resizeCallback([], {} as ResizeObserver));
}

function stubRectangle(
  element: HTMLElement,
  rectangle: { left: number; top: number; width: number; height: number },
): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: rectangle.left,
    y: rectangle.top,
    left: rectangle.left,
    top: rectangle.top,
    right: rectangle.left + rectangle.width,
    bottom: rectangle.top + rectangle.height,
    width: rectangle.width,
    height: rectangle.height,
    toJSON: () => ({}),
  });
}

function canvasProps(overrides: { boxes?: ReturnType<typeof annotationBox>[] } = {}) {
  return {
    audio: loadedAudio(),
    boxes: overrides.boxes ?? [],
    selectedBoxId: null,
    tool: 'draw' as const,
    canDraw: true,
    disabled: false,
    view: {
      durationSeconds: 10,
      maximumFrequencyHz: 4_000,
      timeStartSeconds: 0,
      timeEndSeconds: 10,
      lowFrequencyHz: 0,
      highFrequencyHz: 4_000,
    },
    settings: {
      fftSamples: 256,
      overlapPercent: 75,
      brightness: 1,
      contrast: 1,
      palette: 'viridis' as const,
      channelMode: 'average' as const,
      frequencyScale: 'linear' as const,
    },
    playheadSeconds: 0,
    cancelVersion: 0,
    onSelect: vi.fn(),
    onCreate: vi.fn(),
    onResize: vi.fn(),
    onError: vi.fn(),
    onSemanticEvent: vi.fn(),
  };
}

function annotationBox() {
  return {
    id: 'box:projection',
    species: {
      speciesId: 'species:green',
      code: 'GRE',
      speciesName: 'Green Tree Frog',
      addedAfterInitialization: false,
    },
    startTimeSeconds: 2,
    endTimeSeconds: 4,
    lowFrequencyHz: 100,
    highFrequencyHz: 1_000,
    provenance: { source: 'human' as const },
  };
}

function loadedAudio(): LoadedAudio {
  const samples = new Float32Array(80_000);
  return {
    source: {
      url: 'data:audio/wav;base64,',
      filename: 'test.wav',
      mimeType: 'audio/wav',
    },
    analysis: { sampleRateHz: 8_000, channelCount: 1, channels: [samples] },
    element: new EventTarget() as LoadedAudio['element'],
    durationSeconds: 10,
    decodedSampleRateHz: 8_000,
    sourceSampleRateHz: 8_000,
    maximumFrequencyHz: 4_000,
    channelCount: 1,
    decoder: 'source-faithful-wav',
    dispose: vi.fn(),
  };
}
