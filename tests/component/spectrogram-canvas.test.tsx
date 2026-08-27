import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedAudio } from '../../src/audio/AudioResource';
import { SpectrogramCanvas } from '../../src/components/workspace/SpectrogramCanvas';
import type { FrogLabelBoxV2 } from '../../src/domain/types';

type BoxGeometry = Pick<
  FrogLabelBoxV2,
  'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
>;

const rendererHarness = vi.hoisted(() => ({
  behaviors: [] as Array<'ready' | 'refining' | 'error'>,
  construct: vi.fn(),
  destroy: vi.fn(),
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
      analysisOptions?: object,
    ) {
      rendererHarness.construct(analysisOptions);
      rendererHarness.latest = { emitReady: () => this.emitReady() };
    }

    render(_canvas: HTMLCanvasElement, options: object): number {
      this.requestGeneration += 1;
      rendererHarness.render(options, this.requestGeneration);
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

    destroy(): void {
      rendererHarness.destroy();
    }

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
  rendererHarness.construct.mockClear();
  rendererHarness.destroy.mockClear();
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

describe('SpectrogramCanvas waveform navigation', () => {
  it('shows a global overview only for time zoom and projects the visible window exactly', () => {
    const common = canvasProps();
    const result = render(<SpectrogramCanvas {...common} />);

    expect(result.container.querySelector('.waveform-stack')).toHaveAttribute(
      'data-waveform-tier-count',
      '1',
    );
    expect(result.container.querySelector('.waveform-overview')).toBeNull();

    result.rerender(
      <SpectrogramCanvas
        {...common}
        view={{ ...common.view, timeStartSeconds: 2, timeEndSeconds: 6 }}
      />,
    );

    expect(result.container.querySelector('.waveform-stack')).toHaveAttribute(
      'data-waveform-tier-count',
      '2',
    );
    const viewportWindow = result.getByRole('slider', { name: 'Visible time window' });
    expect(viewportWindow).toHaveStyle({ left: '20%', width: '40%' });
    expect(viewportWindow).toHaveAttribute('aria-valuetext', '2.000 to 6.000 seconds');
  });

  it('previews seek drags locally and commits only the final coordinate', async () => {
    const onSeek = vi.fn();
    const common = canvasProps();
    const result = render(
      <SpectrogramCanvas
        {...common}
        view={{ ...common.view, timeStartSeconds: 2, timeEndSeconds: 6 }}
        playheadSeconds={3}
        onSeek={onSeek}
      />,
    );
    const detail = result.container.querySelector('.waveform-detail') as HTMLDivElement;
    const overview = result.container.querySelector('.waveform-overview') as HTMLDivElement;
    mockRect(detail, 10, 400, 58);
    mockRect(overview, 10, 400, 32);

    const detailSeek = result.getByRole('slider', { name: 'Seek within the visible waveform' });
    fireEvent.pointerDown(detailSeek, { pointerId: 31, button: 0, clientX: 110 });
    fireEvent.pointerUp(detailSeek, { pointerId: 31, button: 0, clientX: 210 });
    expect(onSeek).toHaveBeenNthCalledWith(1, 3);
    expect(onSeek).toHaveBeenNthCalledWith(2, 4);

    const globalSeek = result.getByRole('slider', { name: 'Seek within the full recording' });
    fireEvent.pointerDown(globalSeek, { pointerId: 32, button: 0, clientX: 310 });
    fireEvent.pointerUp(globalSeek, { pointerId: 32, button: 0, clientX: 310 });
    expect(onSeek).toHaveBeenNthCalledWith(3, 7.5);

    const overviewPlayhead = result.getByTestId('overview-playhead-handle');
    fireEvent.pointerDown(overviewPlayhead, { pointerId: 33, button: 0, clientX: 136 });
    fireEvent.pointerUp(overviewPlayhead, { pointerId: 33, button: 0, clientX: 136 });
    expect(onSeek).toHaveBeenCalledTimes(3);
    fireEvent.pointerDown(overviewPlayhead, { pointerId: 34, button: 0, clientX: 136 });
    fireEvent.pointerMove(overviewPlayhead, { pointerId: 34, buttons: 1, clientX: 256 });
    await waitFor(() => expect(overviewPlayhead).toHaveStyle({ left: '60%' }));
    expect(onSeek).toHaveBeenCalledTimes(3);
    fireEvent.pointerUp(overviewPlayhead, { pointerId: 34, button: 0, clientX: 256 });
    expect(onSeek).toHaveBeenNthCalledWith(4, 6);

    fireEvent.pointerDown(detailSeek, { pointerId: 35, button: 0, clientX: 170 });
    fireEvent.pointerMove(detailSeek, { pointerId: 35, buttons: 1, clientX: 250 });
    fireEvent.pointerUp(detailSeek, { pointerId: 35, button: 0, clientX: 250 });
    expect(onSeek).toHaveBeenNthCalledWith(5, 3.6);
    expect(onSeek).toHaveBeenNthCalledWith(6, 4.4);
    expect(onSeek).toHaveBeenCalledTimes(6);
  });

  it('previews an overview drag locally and commits its final position once', async () => {
    const onTimeWindowStartChange = vi.fn();
    const common = canvasProps();
    const result = render(
      <SpectrogramCanvas
        {...common}
        view={{ ...common.view, timeStartSeconds: 2, timeEndSeconds: 6 }}
        onTimeWindowStartChange={onTimeWindowStartChange}
      />,
    );
    const overview = result.container.querySelector('.waveform-overview') as HTMLDivElement;
    mockRect(overview, 10, 400, 32);
    const viewportWindow = result.getByRole('slider', { name: 'Visible time window' });
    expect(viewportWindow.querySelector('.waveform-viewport-visual')).toHaveAttribute(
      'aria-hidden',
      'true',
    );

    fireEvent.pointerDown(viewportWindow, { pointerId: 41, button: 0, clientX: 110 });
    for (let clientX = 114; clientX <= 190; clientX += 4) {
      fireEvent.pointerMove(viewportWindow, { pointerId: 41, buttons: 1, clientX });
    }
    await waitFor(() => expect(viewportWindow).toHaveStyle({ left: '40%' }));
    expect(onTimeWindowStartChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(viewportWindow, { pointerId: 41, button: 0, clientX: 190 });

    expect(onTimeWindowStartChange).toHaveBeenCalledTimes(1);
    expect(onTimeWindowStartChange).toHaveBeenLastCalledWith(4);
  });

  it('starts detail keyboard seeking from the announced boundary when playhead is outside view', () => {
    const onSeek = vi.fn();
    const common = canvasProps();
    const result = render(
      <SpectrogramCanvas
        {...common}
        view={{ ...common.view, timeStartSeconds: 2, timeEndSeconds: 6 }}
        playheadSeconds={9}
        onSeek={onSeek}
      />,
    );
    const detailSeek = result.getByRole('slider', { name: 'Seek within the visible waveform' });
    expect(detailSeek).toHaveAttribute(
      'aria-valuetext',
      'Playhead is outside the visible window; nearest boundary 6.000 seconds',
    );

    fireEvent.keyDown(detailSeek, { key: 'ArrowLeft' });

    expect(onSeek).toHaveBeenCalledWith(5.96);
  });

  it('cancels a captured overview gesture when the workspace cancels gestures', () => {
    const onTimeWindowStartChange = vi.fn();
    const common = canvasProps();
    const zoomedView = { ...common.view, timeStartSeconds: 2, timeEndSeconds: 6 };
    const result = render(
      <SpectrogramCanvas
        {...common}
        view={zoomedView}
        onTimeWindowStartChange={onTimeWindowStartChange}
      />,
    );
    const overview = result.container.querySelector('.waveform-overview') as HTMLDivElement;
    mockRect(overview, 10, 400, 32);
    const viewportWindow = result.getByRole('slider', { name: 'Visible time window' });

    fireEvent.pointerDown(viewportWindow, { pointerId: 42, button: 0, clientX: 110 });
    result.rerender(
      <SpectrogramCanvas
        {...common}
        view={zoomedView}
        cancelVersion={1}
        onTimeWindowStartChange={onTimeWindowStartChange}
      />,
    );
    fireEvent.pointerMove(viewportWindow, { pointerId: 42, buttons: 1, clientX: 190 });
    fireEvent.pointerUp(viewportWindow, { pointerId: 42, button: 0, clientX: 190 });

    expect(onTimeWindowStartChange).not.toHaveBeenCalled();
  });
});

describe('SpectrogramCanvas box editing', () => {
  it('renders eight handles and lets a side handle change only one dimension in one commit', async () => {
    const box = annotationBox();
    const onResize = vi.fn<(boxId: string, geometry: BoxGeometry) => boolean>(() => true);
    const common = canvasProps({ boxes: [box] });
    const result = render(
      <SpectrogramCanvas {...common} selectedBoxId={box.id} tool="select" onResize={onResize} />,
    );
    resizeStage(result.container);
    await waitFor(() =>
      expect(result.container.querySelector('.spectrogram-stage')).toHaveAttribute(
        'data-annotation-gestures-ready',
        'true',
      ),
    );
    expect(result.container.querySelectorAll('.resize-handle')).toHaveLength(8);

    const east = result.getByRole('button', { name: 'Resize GRE box from its right edge' });
    const stage = result.container.querySelector('.spectrogram-stage') as HTMLDivElement;
    fireEvent.pointerDown(east, { pointerId: 51, button: 0, clientX: 160, clientY: 172 });
    fireEvent.pointerMove(stage, { pointerId: 51, buttons: 1, clientX: 180, clientY: 150 });
    fireEvent.pointerMove(stage, { pointerId: 51, buttons: 1, clientX: 200, clientY: 130 });
    fireEvent.pointerUp(stage, { pointerId: 51, button: 0, clientX: 200, clientY: 130 });

    await waitFor(() => expect(onResize).toHaveBeenCalledTimes(1));
    expect(onResize).toHaveBeenCalledWith(box.id, {
      startTimeSeconds: 2,
      endTimeSeconds: 5,
      lowFrequencyHz: 100,
      highFrequencyHz: 1_000,
    });
  });

  it('moves a box as a unit but treats a body click as selection only', async () => {
    const box = annotationBox();
    const onResize = vi.fn<(boxId: string, geometry: BoxGeometry) => boolean>(() => true);
    const onSelect = vi.fn();
    const common = canvasProps({ boxes: [box] });
    const result = render(
      <SpectrogramCanvas
        {...common}
        selectedBoxId={box.id}
        tool="select"
        onResize={onResize}
        onSelect={onSelect}
      />,
    );
    resizeStage(result.container);
    await waitFor(() =>
      expect(result.container.querySelector('.spectrogram-stage')).toHaveAttribute(
        'data-annotation-gestures-ready',
        'true',
      ),
    );
    const stage = result.container.querySelector('.spectrogram-stage') as HTMLDivElement;
    const annotation = result.container.querySelector('.annotation-box') as HTMLDivElement;

    fireEvent.pointerDown(annotation, {
      pointerId: 61,
      button: 0,
      clientX: 100,
      clientY: 170,
    });
    fireEvent.pointerUp(stage, { pointerId: 61, button: 0, clientX: 100, clientY: 170 });
    expect(onResize).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenLastCalledWith(box.id);

    const selectionsAfterClick = onSelect.mock.calls.length;
    fireEvent.pointerDown(annotation, {
      pointerId: 62,
      button: 0,
      clientX: 100,
      clientY: 170,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 62,
      buttons: 1,
      clientX: 140,
      clientY: 150,
    });
    fireEvent.pointerMove(stage, {
      pointerId: 62,
      buttons: 1,
      clientX: 100,
      clientY: 170,
    });
    fireEvent.pointerUp(stage, { pointerId: 62, button: 0, clientX: 100, clientY: 170 });
    expect(onResize).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(selectionsAfterClick + 1);

    // A browser may coalesce movement and deliver only the distant pointer-up.
    // That still counts as a drag rather than an overlap-cycling click.
    fireEvent.pointerDown(annotation, {
      pointerId: 63,
      button: 0,
      clientX: 100,
      clientY: 170,
    });
    fireEvent.pointerUp(stage, { pointerId: 63, button: 0, clientX: 140, clientY: 150 });

    await waitFor(() => expect(onResize).toHaveBeenCalledTimes(1));
    const moved = onResize.mock.calls[0][1];
    expect(moved.endTimeSeconds - moved.startTimeSeconds).toBeCloseTo(2);
    expect(moved.highFrequencyHz - moved.lowFrequencyHz).toBeCloseTo(900);
    expect(moved.startTimeSeconds).toBeCloseTo(3);
    expect(moved.endTimeSeconds).toBeCloseTo(5);
    expect(moved.lowFrequencyHz).toBeCloseTo(500);
    expect(moved.highFrequencyHz).toBeCloseTo(1_400);
  });
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
          windowMilliseconds: 20,
          overlapPercent: 75,
          windowFunction: 'hann',
          minimumDb: -120,
          brightness: 1,
          contrast: 1,
          palette: 'viridis',
          channelMode: 'average',
          frequencyScale: 'linear',
          frequencyWarp: 0.5,
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
          windowMilliseconds: 20,
          overlapPercent: 75,
          windowFunction: 'hann',
          minimumDb: -120,
          brightness: 1,
          contrast: 1,
          palette: 'viridis',
          channelMode: 'average',
          frequencyScale: 'linear',
          frequencyWarp: 0.5,
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

  it('rebuilds analysis only for STFT changes and passes display settings to every render', async () => {
    const common = canvasProps();
    const result = render(<SpectrogramCanvas {...common} />);
    resizeStage(result.container);

    await waitFor(() => expect(rendererHarness.render).toHaveBeenCalled());
    expect(rendererHarness.construct).toHaveBeenCalledTimes(1);
    expect(rendererHarness.construct).toHaveBeenLastCalledWith({
      windowMilliseconds: 20,
      overlapPercent: 75,
      windowFunction: 'hann',
    });
    expect(rendererHarness.render).toHaveBeenLastCalledWith(
      expect.objectContaining({
        windowMilliseconds: 20,
        overlapPercent: 75,
        windowFunction: 'hann',
        minimumDb: -120,
      }),
      expect.any(Number),
    );

    result.rerender(
      <SpectrogramCanvas
        {...common}
        settings={{ ...common.settings, brightness: 1.7, minimumDb: -80 }}
      />,
    );
    await waitFor(() =>
      expect(rendererHarness.render).toHaveBeenLastCalledWith(
        expect.objectContaining({ brightness: 1.7, minimumDb: -80 }),
        expect.any(Number),
      ),
    );
    expect(rendererHarness.construct).toHaveBeenCalledTimes(1);
    expect(rendererHarness.destroy).not.toHaveBeenCalled();

    result.rerender(
      <SpectrogramCanvas
        {...common}
        settings={{
          ...common.settings,
          windowMilliseconds: 40,
          overlapPercent: 50,
          windowFunction: 'blackman',
        }}
      />,
    );
    await waitFor(() => expect(rendererHarness.construct).toHaveBeenCalledTimes(2));
    expect(rendererHarness.destroy).toHaveBeenCalledTimes(1);
    expect(rendererHarness.construct).toHaveBeenLastCalledWith({
      windowMilliseconds: 40,
      overlapPercent: 50,
      windowFunction: 'blackman',
    });
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

function mockRect(element: HTMLElement, left: number, width: number, height: number): void {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: left,
    y: 0,
    left,
    top: 0,
    right: left + width,
    bottom: height,
    width,
    height,
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
      windowMilliseconds: 20,
      overlapPercent: 75,
      windowFunction: 'hann' as const,
      minimumDb: -120,
      brightness: 1,
      contrast: 1,
      palette: 'viridis' as const,
      channelMode: 'average' as const,
      frequencyScale: 'linear' as const,
      frequencyWarp: 0.5,
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
