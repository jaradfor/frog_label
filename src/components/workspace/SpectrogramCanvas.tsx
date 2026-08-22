import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoadedAudio } from '../../audio/AudioResource';
import { SpectrogramRenderer, type SpectrogramRenderPhase } from '../../audio/SpectrogramRenderer';
import {
  computeWaveformEnvelope,
  type FrequencyScale,
  type SpectrogramPalette,
} from '../../audio/spectrogram';
import type {
  AnalysisChannelMode,
  FrogLabelBoxV1,
  PixelPoint,
  ViewportTransform,
} from '../../domain/types';
import { canonicalToPixel, geometryFromDrag } from '../../domain/projection';

type Tool = 'select' | 'draw' | 'pan';
type ResizeHandle = 'nw' | 'ne' | 'sw' | 'se';
const DENSE_ANNOTATION_THRESHOLD = 500;

interface ViewWindow {
  durationSeconds: number;
  maximumFrequencyHz: number;
  timeStartSeconds: number;
  timeEndSeconds: number;
  lowFrequencyHz: number;
  highFrequencyHz: number;
}

interface Gesture {
  kind: 'draw' | 'resize' | 'pan';
  pointerId: number;
  start: PixelPoint;
  current: PixelPoint;
  viewport: ViewportTransform;
  boxId?: string;
}

interface SpectrogramCanvasProps {
  audio: LoadedAudio;
  boxes: FrogLabelBoxV1[];
  selectedBoxId: string | null;
  tool: Tool;
  canDraw: boolean;
  disabled: boolean;
  view: ViewWindow;
  settings: {
    fftSamples: number;
    overlapPercent: number;
    brightness: number;
    contrast: number;
    palette: SpectrogramPalette;
    channelMode: AnalysisChannelMode;
    frequencyScale: FrequencyScale;
  };
  playheadSeconds: number;
  onSelect(boxId: string | null): void;
  cancelVersion: number;
  onCreate(
    geometry: Pick<
      FrogLabelBoxV1,
      'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
    >,
  ): Promise<boolean> | boolean;
  onResize(
    boxId: string,
    geometry: Pick<
      FrogLabelBoxV1,
      'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
    >,
  ): Promise<boolean> | boolean;
  onPan(deltaSeconds: number): void;
  onError(message: string): void;
  onSemanticEvent(event: string, detail?: string): void;
  onLifecycleChange?(phase: SpectrogramRenderPhase): void;
}

export function SpectrogramCanvas({
  audio,
  boxes,
  selectedBoxId,
  tool,
  canDraw,
  disabled,
  view,
  settings,
  playheadSeconds,
  cancelVersion,
  onSelect,
  onCreate,
  onResize,
  onPan,
  onError,
  onSemanticEvent,
  onLifecycleChange,
}: SpectrogramCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<SpectrogramRenderer | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [overlapStack, setOverlapStack] = useState<string[]>([]);
  const [renderPhase, setRenderPhase] = useState<SpectrogramRenderPhase>('analyzing');
  const [retryVersion, setRetryVersion] = useState(0);
  const clickCycleRef = useRef<{
    key: string;
    x: number;
    y: number;
    ids: string[];
    index: number;
  } | null>(null);

  const viewport = useMemo<ViewportTransform>(
    () => ({ ...view, widthPixels: size.width, heightPixels: size.height }),
    [size, view],
  );
  const visibleBoxes = useMemo(() => projectVisibleBoxes(boxes, viewport), [boxes, viewport]);
  const denseAnnotations = boxes.length > DENSE_ANNOTATION_THRESHOLD;
  const annotationGesturesReady = renderPhase === 'firstFrameReady';

  const reportPhase = useCallback(
    (phase: SpectrogramRenderPhase) => {
      setRenderPhase(phase);
      onLifecycleChange?.(phase);
    },
    [onLifecycleChange],
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      setSize((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    reportPhase('analyzing');
    const renderer = new SpectrogramRenderer(
      audio,
      (message) => {
        reportPhase('error');
        onError(message);
      },
      reportPhase,
    );
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [audio, onError, reportPhase, retryVersion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    reportPhase('analyzing');
    const timer = window.setTimeout(
      () => rendererRef.current?.render(canvas, { ...view, ...settings }),
      180,
    );
    return () => window.clearTimeout(timer);
  }, [audio, reportPhase, settings, size, view]);

  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas) return;
    paintWaveform(canvas, audio, view, settings.channelMode);
  }, [audio, settings.channelMode, size.width, view]);

  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !denseAnnotations) return;
    paintDenseAnnotations(canvas, visibleBoxes, size);
  }, [denseAnnotations, size, visibleBoxes]);

  const viewKey = `${view.timeStartSeconds}:${view.timeEndSeconds}:${view.lowFrequencyHz}:${view.highFrequencyHz}:${size.width}:${size.height}`;
  useEffect(() => {
    const active = gestureRef.current;
    if (!active) return;
    gestureRef.current = null;
    setGesture(null);
    const root = rootRef.current;
    if (root?.hasPointerCapture(active.pointerId)) root.releasePointerCapture(active.pointerId);
  }, [cancelVersion, disabled, tool, viewKey]);

  const pointForEvent = (event: React.PointerEvent): PixelPoint => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const point = pointForEvent(event);
    if (tool === 'select') {
      selectAtPoint(event, null);
      return;
    }
    if (tool === 'draw' && !canDraw) {
      onError('Select a species before drawing a new box. Existing boxes remain selectable.');
      return;
    }
    if (tool === 'draw' && !annotationGesturesReady) {
      onError('Building spectrogram… Drawing will be available after the first frame is ready.');
      return;
    }
    const next: Gesture = {
      kind: tool === 'pan' ? 'pan' : 'draw',
      pointerId: event.pointerId,
      start: point,
      current: point,
      viewport: structuredClone(viewport),
    };
    gestureRef.current = next;
    setGesture(next);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const selectAtPoint = (event: React.PointerEvent, fallbackId: string | null) => {
    const point = pointForEvent(event);
    const ids = visibleBoxes
      .filter(({ rect }) => pointInside(point, rect))
      .map(({ box }) => box.id)
      .sort();
    if (ids.length === 0) {
      clickCycleRef.current = null;
      setOverlapStack([]);
      onSelect(null);
      return;
    }
    const key = `${viewKey}:${ids.join('|')}`;
    const prior = clickCycleRef.current;
    const repeated =
      prior && prior.key === key && Math.hypot(prior.x - point.x, prior.y - point.y) <= 3;
    const index = repeated
      ? (prior.index + 1) % Math.max(1, ids.length)
      : Math.max(0, fallbackId ? ids.indexOf(fallbackId) : 0);
    const selected = ids[index] ?? fallbackId ?? ids[0];
    clickCycleRef.current = { key, x: point.x, y: point.y, ids, index };
    setOverlapStack(ids);
    onSelect(selected);
    onSemanticEvent('box.selected', selected);
  };

  const beginResize = (
    event: React.PointerEvent<HTMLButtonElement>,
    box: FrogLabelBoxV1,
    handle: ResizeHandle,
  ) => {
    if (disabled || !annotationGesturesReady || event.button !== 0) return;
    event.stopPropagation();
    onSelect(box.id);
    const opposite = {
      nw: { timeSeconds: box.endTimeSeconds, frequencyHz: box.lowFrequencyHz },
      ne: { timeSeconds: box.startTimeSeconds, frequencyHz: box.lowFrequencyHz },
      sw: { timeSeconds: box.endTimeSeconds, frequencyHz: box.highFrequencyHz },
      se: { timeSeconds: box.startTimeSeconds, frequencyHz: box.highFrequencyHz },
    }[handle];
    const next: Gesture = {
      kind: 'resize',
      pointerId: event.pointerId,
      start: canonicalToPixel(opposite, viewport),
      current: pointForEvent(event),
      viewport: structuredClone(viewport),
      boxId: box.id,
    };
    gestureRef.current = next;
    setGesture(next);
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gestureRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = { ...active, current: pointForEvent(event) };
    gestureRef.current = next;
    setGesture(next);
  };

  const finish = async (event: React.PointerEvent<HTMLDivElement>) => {
    const active = gestureRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const completed = { ...active, current: pointForEvent(event) };
    gestureRef.current = null;
    setGesture(null);
    if (rootRef.current?.hasPointerCapture(event.pointerId))
      rootRef.current.releasePointerCapture(event.pointerId);
    if (active.kind === 'pan') {
      const secondsPerPixel =
        (completed.viewport.timeEndSeconds - completed.viewport.timeStartSeconds) /
        completed.viewport.widthPixels;
      onPan(-(completed.current.x - completed.start.x) * secondsPerPixel);
      onSemanticEvent('viewport.panned');
      return;
    }
    try {
      const geometry = geometryFromDrag(completed.start, completed.current, completed.viewport);
      if (completed.kind === 'resize' && completed.boxId) {
        if (await onResize(completed.boxId, geometry))
          onSemanticEvent('box.resized', completed.boxId);
      } else {
        if (await onCreate(geometry)) onSemanticEvent('box.created');
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'The gesture could not be committed.');
    }
  };

  const cancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    setGesture(null);
  };

  const previewRect =
    gesture && gesture.kind !== 'pan' ? rectFromPoints(gesture.start, gesture.current) : null;

  return (
    <div
      className="spectrogram-shell"
      data-tutorial="spectrogram"
      data-spectrogram-state={renderPhase}
      aria-busy={renderPhase === 'analyzing'}
    >
      <div className="waveform-strip" role="img" aria-label="Waveform aligned with the spectrogram">
        <canvas ref={waveformRef} aria-hidden="true" />
        {playheadSeconds >= view.timeStartSeconds && playheadSeconds <= view.timeEndSeconds && (
          <span
            className="playhead-line waveform-playhead"
            style={{
              left: `${((playheadSeconds - view.timeStartSeconds) / (view.timeEndSeconds - view.timeStartSeconds)) * 100}%`,
            }}
          />
        )}
      </div>
      <div className="frequency-axis" aria-hidden="true">
        <span>{Math.round(view.highFrequencyHz / 1000)} kHz</span>
        <span>{Math.round((view.highFrequencyHz + view.lowFrequencyHz) / 2000)} kHz</span>
        <span>{Math.round(view.lowFrequencyHz / 1000)} kHz</span>
      </div>
      <div
        ref={rootRef}
        className={`spectrogram-stage tool-${tool}`}
        data-box-count={boxes.length}
        data-selected-box-id={selectedBoxId ?? ''}
        data-annotation-gestures-ready={annotationGesturesReady}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={(event) => void finish(event)}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
      >
        <canvas
          ref={canvasRef}
          className="spectrogram-canvas"
          role="img"
          aria-label={`Spectrogram from ${view.timeStartSeconds.toFixed(2)} to ${view.timeEndSeconds.toFixed(2)} seconds and ${Math.round(view.lowFrequencyHz)} to ${Math.round(view.highFrequencyHz)} hertz`}
        />
        {renderPhase !== 'firstFrameReady' && (
          <div
            className={`spectrogram-readiness-overlay ${renderPhase === 'error' ? 'error' : ''}`}
            role={renderPhase === 'error' ? 'alert' : 'status'}
          >
            <strong>
              {renderPhase === 'error'
                ? 'Spectrogram could not be built.'
                : 'Building spectrogram…'}
            </strong>
            {renderPhase === 'error' && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  reportPhase('analyzing');
                  setRetryVersion((version) => version + 1);
                }}
              >
                Retry
              </button>
            )}
          </div>
        )}
        {denseAnnotations && (
          <canvas
            ref={annotationCanvasRef}
            className="annotation-layer-canvas"
            aria-hidden="true"
          />
        )}
        {playheadSeconds >= view.timeStartSeconds && playheadSeconds <= view.timeEndSeconds && (
          <span
            className="playhead-line"
            style={{
              left: `${((playheadSeconds - view.timeStartSeconds) / (view.timeEndSeconds - view.timeStartSeconds)) * 100}%`,
            }}
          />
        )}
        {visibleBoxes
          .filter(({ box }) => !denseAnnotations || box.id === selectedBoxId)
          .map(({ box, rect }) => {
            const selected = box.id === selectedBoxId;
            return (
              <div
                key={box.id}
                className={`annotation-box ${selected ? 'selected' : ''}`}
                data-box-id={box.id}
                data-overlap-count={selected ? overlapStack.length : undefined}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  pointerEvents: tool === 'select' ? 'auto' : 'none',
                }}
                onPointerDown={(event) => {
                  if (tool !== 'select') return;
                  event.stopPropagation();
                  selectAtPoint(event, box.id);
                }}
              >
                <button
                  type="button"
                  className="box-label"
                  aria-label={`Select ${box.species.code}, ${box.species.speciesName} box`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(box.id);
                    onSemanticEvent('box.selected', box.id);
                  }}
                >
                  {box.species.code}
                  {selected && overlapStack.length > 1 ? ` · ${overlapStack.length}` : ''}
                </button>
                {selected &&
                  tool === 'select' &&
                  annotationGesturesReady &&
                  !disabled &&
                  (['nw', 'ne', 'sw', 'se'] as const).map((handle) => (
                    <button
                      type="button"
                      key={handle}
                      className={`resize-handle handle-${handle}`}
                      aria-label={`Resize ${box.species.code} box from ${handle.toUpperCase()} corner`}
                      onPointerDown={(event) => beginResize(event, box, handle)}
                    />
                  ))}
              </div>
            );
          })}
        {previewRect && (
          <div className="annotation-box preview" style={previewRect} aria-hidden="true" />
        )}
        <div className="time-axis" aria-hidden="true">
          <span>{view.timeStartSeconds.toFixed(1)}s</span>
          <span>{((view.timeStartSeconds + view.timeEndSeconds) / 2).toFixed(1)}s</span>
          <span>{view.timeEndSeconds.toFixed(1)}s</span>
        </div>
      </div>
    </div>
  );
}

function rectFromPoints(left: PixelPoint, right: PixelPoint) {
  return {
    left: Math.min(left.x, right.x),
    top: Math.min(left.y, right.y),
    width: Math.abs(left.x - right.x),
    height: Math.abs(left.y - right.y),
  };
}

function pointInside(
  point: PixelPoint,
  rect: { left: number; top: number; width: number; height: number },
): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.left + rect.width &&
    point.y >= rect.top &&
    point.y <= rect.top + rect.height
  );
}

function paintDenseAnnotations(
  canvas: HTMLCanvasElement,
  boxes: Array<{
    box: FrogLabelBoxV1;
    rect: { left: number; top: number; width: number; height: number };
  }>,
  size: { width: number; height: number },
): void {
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(size.width * pixelRatio));
  const height = Math.max(1, Math.round(size.height * pixelRatio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  context.fillStyle = 'rgba(30, 200, 100, 0.16)';
  context.strokeStyle = '#70e6a1';
  context.lineWidth = 2;
  context.beginPath();
  for (const { rect } of boxes) {
    const boxWidth = Math.max(1, rect.width);
    const boxHeight = Math.max(1, rect.height);
    context.rect(rect.left, rect.top, boxWidth, boxHeight);
  }
  context.fill();
  context.stroke();
}

function projectVisibleBoxes(boxes: FrogLabelBoxV1[], viewport: ViewportTransform) {
  const timeScale = viewport.widthPixels / (viewport.timeEndSeconds - viewport.timeStartSeconds);
  const frequencyScale =
    viewport.heightPixels / (viewport.highFrequencyHz - viewport.lowFrequencyHz);
  return boxes
    .map((box) => {
      const left = (box.startTimeSeconds - viewport.timeStartSeconds) * timeScale;
      const top = (viewport.highFrequencyHz - box.highFrequencyHz) * frequencyScale;
      return {
        box,
        rect: {
          left,
          top,
          width: (box.endTimeSeconds - box.startTimeSeconds) * timeScale,
          height: (box.highFrequencyHz - box.lowFrequencyHz) * frequencyScale,
        },
      };
    })
    .filter(
      ({ rect }) =>
        rect.left + rect.width >= 0 &&
        rect.left <= viewport.widthPixels &&
        rect.top + rect.height >= 0 &&
        rect.top <= viewport.heightPixels,
    );
}

function paintWaveform(
  canvas: HTMLCanvasElement,
  audio: LoadedAudio,
  view: ViewWindow,
  mode: AnalysisChannelMode,
): void {
  const density = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(canvas.clientWidth * density));
  const height = Math.max(1, Math.round(canvas.clientHeight * density));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  const envelope = computeWaveformEnvelope(
    audio.analysis,
    width,
    mode,
    view.timeStartSeconds,
    view.timeEndSeconds,
  );
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#122019';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#8cdf75';
  context.lineWidth = Math.max(1, density);
  context.beginPath();
  for (let x = 0; x < width; x += 1) {
    const y = ((1 - envelope.maximum[x]) / 2) * height;
    if (x === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  for (let x = width - 1; x >= 0; x -= 1) {
    context.lineTo(x, ((1 - envelope.minimum[x]) / 2) * height);
  }
  context.closePath();
  context.globalAlpha = 0.62;
  context.fillStyle = '#65c96b';
  context.fill();
  context.globalAlpha = 1;
  context.stroke();
}
