import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LoadedAudio } from '../../audio/AudioResource';
import {
  SpectrogramRenderer,
  type SpectrogramRenderPhase,
  type SpectrogramRenderState,
} from '../../audio/SpectrogramRenderer';
import {
  computeWaveformEnvelope,
  prepareWaveformPeakIndexesCooperative,
  type FrequencyScale,
  type SpectrogramPalette,
  type SpectrogramWindowFunction,
} from '../../audio/spectrogram';
import type {
  AnalysisChannelMode,
  FrogLabelBoxV2,
  PixelPoint,
  ViewportTransform,
} from '../../domain/types';
import {
  boxToPixelRect,
  geometryForBoxEdit,
  geometryFromDrag,
  type BoxEditHandle,
} from '../../domain/projection';
import { frequencyAtAxisRatio } from '../../domain/frequencyScale';

type Tool = 'select' | 'draw' | 'pan';
type ResizeHandle = Exclude<BoxEditHandle, 'move'>;
const DENSE_ANNOTATION_THRESHOLD = 500;
const MOVE_GESTURE_THRESHOLD_PIXELS = 3;
const TIME_ZOOM_EPSILON_SECONDS = 0.000001;
const INITIAL_RENDER_STATE: SpectrogramRenderState = {
  status: 'initializing',
  quality: 'none',
  requestGeneration: 0,
  paintedRequestGeneration: 0,
  paintGeneration: 0,
  hasFrame: false,
};

interface ViewWindow {
  durationSeconds: number;
  maximumFrequencyHz: number;
  timeStartSeconds: number;
  timeEndSeconds: number;
  lowFrequencyHz: number;
  highFrequencyHz: number;
}

interface Gesture {
  kind: 'draw' | 'resize' | 'move' | 'pan';
  pointerId: number;
  start: PixelPoint;
  current: PixelPoint;
  viewport: ViewportTransform;
  box?: FrogLabelBoxV2;
  handle?: BoxEditHandle;
  moved?: boolean;
}

interface WaveformGesture {
  kind: 'detail-seek' | 'overview-seek' | 'playhead-seek' | 'viewport-pan';
  pointerId: number;
  startClientX: number;
  initialTimeStartSeconds: number;
  initialSeekSeconds?: number;
  lastSeekSeconds?: number;
  captureTarget: HTMLElement;
}

interface SpectrogramCanvasProps {
  audio: LoadedAudio;
  boxes: FrogLabelBoxV2[];
  selectedBoxId: string | null;
  tool: Tool;
  canDraw: boolean;
  disabled: boolean;
  view: ViewWindow;
  settings: {
    windowMilliseconds: number;
    overlapPercent: number;
    windowFunction: SpectrogramWindowFunction;
    minimumDb: number;
    brightness: number;
    contrast: number;
    palette: SpectrogramPalette;
    channelMode: AnalysisChannelMode;
    frequencyScale: FrequencyScale;
    frequencyWarp: number;
  };
  playheadSeconds: number;
  onSelect(boxId: string | null): void;
  cancelVersion: number;
  onCreate(
    geometry: Pick<
      FrogLabelBoxV2,
      'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
    >,
  ): Promise<boolean> | boolean;
  onResize(
    boxId: string,
    geometry: Pick<
      FrogLabelBoxV2,
      'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
    >,
  ): Promise<boolean> | boolean;
  onSeek?(timeSeconds: number): void;
  onTimeWindowStartChange?(timeStartSeconds: number): void;
  onPan?(deltaSeconds: number): void;
  onPanView?(deltaTimeSeconds: number, deltaFrequencyAxisFraction: number): void;
  onPointerAnchorChange?(
    anchor: {
      timeRatio: number;
      frequencyRatio: number;
    } | null,
  ): void;
  onError(message: string): void;
  onSemanticEvent(event: string, detail?: string): void;
  onLifecycleChange?(phase: SpectrogramRenderPhase): void;
  onRenderStateChange?(state: SpectrogramRenderState): void;
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
  onSeek,
  onTimeWindowStartChange,
  onPan,
  onPanView,
  onPointerAnchorChange,
  onError,
  onSemanticEvent,
  onLifecycleChange,
  onRenderStateChange,
}: SpectrogramCanvasProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const waveformRef = useRef<HTMLCanvasElement>(null);
  const detailWaveformRef = useRef<HTMLDivElement>(null);
  const overviewWaveformRef = useRef<HTMLCanvasElement>(null);
  const overviewRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SpectrogramRenderer | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const waveformGestureRef = useRef<WaveformGesture | null>(null);
  const viewportPanFrameRef = useRef<number | null>(null);
  const pendingViewportStartRef = useRef<number | null>(null);
  const waveformSeekFrameRef = useRef<number | null>(null);
  const pendingWaveformSeekRef = useRef<number | null>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [waveformGestureKind, setWaveformGestureKind] = useState<WaveformGesture['kind'] | null>(
    null,
  );
  const [draftSeekSeconds, setDraftSeekSeconds] = useState<number | null>(null);
  const [draftViewportStartSeconds, setDraftViewportStartSeconds] = useState<number | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [overlapStack, setOverlapStack] = useState<string[]>([]);
  const [renderPhase, setRenderPhase] = useState<SpectrogramRenderPhase>('analyzing');
  const [renderState, setRenderState] = useState<SpectrogramRenderState>(INITIAL_RENDER_STATE);
  const [paintedViewport, setPaintedViewport] = useState<ViewportTransform | null>(null);
  const [waveformIndexVersion, setWaveformIndexVersion] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);
  const clickCycleRef = useRef<{
    key: string;
    x: number;
    y: number;
    ids: string[];
    index: number;
  } | null>(null);

  const viewport = useMemo<ViewportTransform>(
    () => ({
      ...view,
      frequencyScale: settings.frequencyScale,
      frequencyWarp: settings.frequencyWarp,
      widthPixels: Math.max(1, size.width),
      heightPixels: Math.max(1, size.height),
    }),
    [settings.frequencyScale, settings.frequencyWarp, size, view],
  );
  const requestedViewportRef = useRef<ViewportTransform | null>(null);
  const projectionViewport = useMemo(() => {
    if (!paintedViewport || sameViewportProjection(paintedViewport, viewport)) return viewport;
    // The retained bitmap is CSS-scaled immediately with its stage. Preserve
    // its scientific transform while following the current stage dimensions
    // so boxes stay registered through a resize as well as a view transition.
    return {
      ...paintedViewport,
      widthPixels: viewport.widthPixels,
      heightPixels: viewport.heightPixels,
    };
  }, [paintedViewport, viewport]);
  const visibleBoxes = useMemo(
    () => projectVisibleBoxes(boxes, projectionViewport),
    [boxes, projectionViewport],
  );
  const denseAnnotations = boxes.length > DENSE_ANNOTATION_THRESHOLD;
  const annotationGesturesReady =
    renderState.hasFrame && sameViewportProjection(projectionViewport, viewport);
  const viewTimeSpan = view.timeEndSeconds - view.timeStartSeconds;
  const timeZoomed =
    viewTimeSpan <
    view.durationSeconds -
      Math.max(TIME_ZOOM_EPSILON_SECONDS, view.durationSeconds * Number.EPSILON * 16);
  const presentedPlayheadSeconds = draftSeekSeconds ?? playheadSeconds;
  const presentedViewportStartSeconds = draftViewportStartSeconds ?? view.timeStartSeconds;

  const reportPhase = useCallback(
    (phase: SpectrogramRenderPhase) => {
      setRenderPhase(phase);
      onLifecycleChange?.(phase);
    },
    [onLifecycleChange],
  );

  const reportRenderState = useCallback(
    (state: SpectrogramRenderState) => {
      setRenderState(state);
      if (
        state.hasFrame &&
        state.requestGeneration > 0 &&
        state.paintedRequestGeneration === state.requestGeneration &&
        requestedViewportRef.current
      ) {
        const painted = requestedViewportRef.current;
        setPaintedViewport((current) =>
          current && sameViewportProjection(current, painted) ? current : { ...painted },
        );
      }
      onRenderStateChange?.(state);
    },
    [onRenderStateChange],
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
    setRenderState(INITIAL_RENDER_STATE);
    setPaintedViewport(null);
    const renderer = new SpectrogramRenderer(
      audio,
      (message) => {
        reportPhase('error');
        onError(message);
      },
      reportPhase,
      reportRenderState,
      {
        windowMilliseconds: settings.windowMilliseconds,
        overlapPercent: settings.overlapPercent,
        windowFunction: settings.windowFunction,
      },
    );
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [
    audio,
    onError,
    reportPhase,
    reportRenderState,
    retryVersion,
    settings.overlapPercent,
    settings.windowFunction,
    settings.windowMilliseconds,
  ]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width < 1 || size.height < 1) return;
    requestedViewportRef.current = viewport;
    rendererRef.current?.render(canvas, { ...view, ...settings });
  }, [audio, retryVersion, settings, size, view, viewport]);

  useEffect(() => {
    const controller = new AbortController();
    setWaveformIndexVersion(0);
    void prepareWaveformPeakIndexesCooperative(audio.analysis, {
      signal: controller.signal,
      sliceMilliseconds: 8,
    })
      .then(() => {
        if (!controller.signal.aborted) setWaveformIndexVersion((version) => version + 1);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          onError(
            `Waveform indexing failed. ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      });
    return () => controller.abort();
  }, [audio, onError]);

  useEffect(() => {
    const canvas = waveformRef.current;
    if (!canvas || size.width < 1) return;
    paintWaveform(canvas, audio, view.timeStartSeconds, view.timeEndSeconds, settings.channelMode);
  }, [audio, settings.channelMode, size.width, view, waveformIndexVersion]);

  useEffect(() => {
    const canvas = overviewWaveformRef.current;
    if (!canvas || size.width < 1 || !timeZoomed) return;
    paintWaveform(canvas, audio, 0, view.durationSeconds, settings.channelMode);
  }, [
    audio,
    settings.channelMode,
    size.width,
    timeZoomed,
    view.durationSeconds,
    waveformIndexVersion,
  ]);

  useEffect(
    () => () => {
      if (viewportPanFrameRef.current !== null) {
        globalThis.cancelAnimationFrame?.(viewportPanFrameRef.current);
      }
      if (waveformSeekFrameRef.current !== null) {
        globalThis.cancelAnimationFrame?.(waveformSeekFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !denseAnnotations) return;
    const controller = new AbortController();
    void paintDenseAnnotationsCooperative(canvas, visibleBoxes, size, controller.signal);
    return () => controller.abort();
  }, [denseAnnotations, size, visibleBoxes]);

  const viewKey = `${view.timeStartSeconds}:${view.timeEndSeconds}:${view.lowFrequencyHz}:${view.highFrequencyHz}:${settings.frequencyScale}:${settings.frequencyWarp}:${size.width}:${size.height}`;
  useEffect(() => {
    const active = gestureRef.current;
    if (active) {
      gestureRef.current = null;
      setGesture(null);
      const root = rootRef.current;
      if (root?.hasPointerCapture(active.pointerId)) root.releasePointerCapture(active.pointerId);
    }
    const activeWaveform = waveformGestureRef.current;
    if (activeWaveform) {
      waveformGestureRef.current = null;
      setWaveformGestureKind(null);
      pendingViewportStartRef.current = null;
      pendingWaveformSeekRef.current = null;
      if (viewportPanFrameRef.current !== null) {
        globalThis.cancelAnimationFrame?.(viewportPanFrameRef.current);
        viewportPanFrameRef.current = null;
      }
      if (waveformSeekFrameRef.current !== null) {
        globalThis.cancelAnimationFrame?.(waveformSeekFrameRef.current);
        waveformSeekFrameRef.current = null;
      }
      setDraftSeekSeconds(null);
      setDraftViewportStartSeconds(null);
      if (activeWaveform.captureTarget.hasPointerCapture(activeWaveform.pointerId)) {
        activeWaveform.captureTarget.releasePointerCapture(activeWaveform.pointerId);
      }
    }
  }, [cancelVersion, disabled, tool]);

  useEffect(() => {
    const active = gestureRef.current;
    if (!active) return;
    if (active.kind === 'pan') {
      gestureRef.current = { ...active, viewport: structuredClone(viewport) };
      return;
    }
    gestureRef.current = null;
    setGesture(null);
    const root = rootRef.current;
    if (root?.hasPointerCapture(active.pointerId)) root.releasePointerCapture(active.pointerId);
  }, [viewKey, viewport]);

  const pointForEvent = (event: React.PointerEvent): PixelPoint => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  const reportPointerAnchor = (event: React.PointerEvent) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    onPointerAnchorChange?.({
      timeRatio: clampRatio((event.clientX - rect.left) / rect.width),
      frequencyRatio: clampRatio(1 - (event.clientY - rect.top) / rect.height),
    });
  };

  const requestViewportStart = (timeStartSeconds: number) => {
    const maximumStart = Math.max(0, view.durationSeconds - viewTimeSpan);
    pendingViewportStartRef.current = clamp(timeStartSeconds, 0, maximumStart);
    if (viewportPanFrameRef.current !== null) return;
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      const pending = pendingViewportStartRef.current;
      pendingViewportStartRef.current = null;
      if (pending !== null) setDraftViewportStartSeconds(pending);
      return;
    }
    viewportPanFrameRef.current = globalThis.requestAnimationFrame(() => {
      viewportPanFrameRef.current = null;
      const pending = pendingViewportStartRef.current;
      pendingViewportStartRef.current = null;
      if (pending !== null) setDraftViewportStartSeconds(pending);
    });
  };

  const flushViewportStart = (timeStartSeconds: number) => {
    if (viewportPanFrameRef.current !== null) {
      globalThis.cancelAnimationFrame(viewportPanFrameRef.current);
      viewportPanFrameRef.current = null;
    }
    pendingViewportStartRef.current = null;
    const maximumStart = Math.max(0, view.durationSeconds - viewTimeSpan);
    onTimeWindowStartChange?.(clamp(timeStartSeconds, 0, maximumStart));
    setDraftViewportStartSeconds(null);
  };

  const timeForWaveformClientX = (
    clientX: number,
    kind: WaveformGesture['kind'],
    active?: WaveformGesture,
  ): number => {
    const element = kind === 'detail-seek' ? detailWaveformRef.current : overviewRef.current;
    const rect = element?.getBoundingClientRect();
    if (
      kind === 'playhead-seek' &&
      active?.initialSeekSeconds !== undefined &&
      rect &&
      rect.width > 0
    ) {
      return clamp(
        active.initialSeekSeconds +
          ((clientX - active.startClientX) / rect.width) * view.durationSeconds,
        0,
        view.durationSeconds,
      );
    }
    const ratio = rect && rect.width > 0 ? clampRatio((clientX - rect.left) / rect.width) : 0;
    if (kind === 'detail-seek') {
      return view.timeStartSeconds + ratio * viewTimeSpan;
    }
    return ratio * view.durationSeconds;
  };

  const viewportStartForClientX = (clientX: number, active: WaveformGesture): number => {
    const rect = overviewRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return active.initialTimeStartSeconds;
    const deltaSeconds = ((clientX - active.startClientX) / rect.width) * view.durationSeconds;
    return active.initialTimeStartSeconds + deltaSeconds;
  };

  const dispatchWaveformSeek = (timeSeconds: number) => {
    const active = waveformGestureRef.current;
    if (!active || active.kind === 'viewport-pan') return;
    if (
      active.lastSeekSeconds !== undefined &&
      Math.abs(active.lastSeekSeconds - timeSeconds) <= 1e-9
    ) {
      return;
    }
    waveformGestureRef.current = { ...active, lastSeekSeconds: timeSeconds };
    onSeek?.(timeSeconds);
  };

  const requestWaveformSeek = (timeSeconds: number) => {
    pendingWaveformSeekRef.current = timeSeconds;
    if (waveformSeekFrameRef.current !== null) return;
    if (typeof globalThis.requestAnimationFrame !== 'function') {
      const pending = pendingWaveformSeekRef.current;
      pendingWaveformSeekRef.current = null;
      if (pending !== null) setDraftSeekSeconds(pending);
      return;
    }
    waveformSeekFrameRef.current = globalThis.requestAnimationFrame(() => {
      waveformSeekFrameRef.current = null;
      const pending = pendingWaveformSeekRef.current;
      pendingWaveformSeekRef.current = null;
      if (pending !== null) setDraftSeekSeconds(pending);
    });
  };

  const flushWaveformSeek = (timeSeconds: number) => {
    if (waveformSeekFrameRef.current !== null) {
      globalThis.cancelAnimationFrame(waveformSeekFrameRef.current);
      waveformSeekFrameRef.current = null;
    }
    pendingWaveformSeekRef.current = null;
    dispatchWaveformSeek(timeSeconds);
    setDraftSeekSeconds(null);
  };

  const beginWaveformSeek = (
    event: React.PointerEvent<HTMLElement>,
    kind: Extract<WaveformGesture['kind'], 'detail-seek' | 'overview-seek' | 'playhead-seek'>,
  ) => {
    if (event.button !== 0 || !onSeek) return;
    event.preventDefault();
    event.stopPropagation();
    const initialSeekSeconds =
      kind === 'playhead-seek'
        ? clamp(playheadSeconds, 0, view.durationSeconds)
        : timeForWaveformClientX(event.clientX, kind);
    const next: WaveformGesture = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      initialTimeStartSeconds: view.timeStartSeconds,
      initialSeekSeconds,
      lastSeekSeconds: initialSeekSeconds,
      captureTarget: event.currentTarget,
    };
    waveformGestureRef.current = next;
    setWaveformGestureKind(kind);
    setDraftSeekSeconds(initialSeekSeconds);
    if (kind !== 'playhead-seek') onSeek(initialSeekSeconds);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginViewportPan = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !onTimeWindowStartChange) return;
    event.preventDefault();
    event.stopPropagation();
    const next: WaveformGesture = {
      kind: 'viewport-pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      initialTimeStartSeconds: view.timeStartSeconds,
      captureTarget: event.currentTarget,
    };
    waveformGestureRef.current = next;
    setWaveformGestureKind(next.kind);
    setDraftViewportStartSeconds(view.timeStartSeconds);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveWaveformGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = waveformGestureRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (active.kind === 'viewport-pan') {
      requestViewportStart(viewportStartForClientX(event.clientX, active));
    } else {
      requestWaveformSeek(timeForWaveformClientX(event.clientX, active.kind, active));
    }
  };

  const finishWaveformGesture = (event: React.PointerEvent<HTMLElement>) => {
    const active = waveformGestureRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.kind === 'viewport-pan') {
      flushViewportStart(viewportStartForClientX(event.clientX, active));
      onSemanticEvent('viewport.panned');
    } else {
      flushWaveformSeek(timeForWaveformClientX(event.clientX, active.kind, active));
      onSemanticEvent('audio.seeked');
    }
    waveformGestureRef.current = null;
    setWaveformGestureKind(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const cancelWaveformGesture = (event: React.PointerEvent<HTMLElement>) => {
    if (waveformGestureRef.current?.pointerId !== event.pointerId) return;
    waveformGestureRef.current = null;
    setWaveformGestureKind(null);
    setDraftSeekSeconds(null);
    setDraftViewportStartSeconds(null);
    pendingViewportStartRef.current = null;
    pendingWaveformSeekRef.current = null;
    if (viewportPanFrameRef.current !== null) {
      globalThis.cancelAnimationFrame?.(viewportPanFrameRef.current);
      viewportPanFrameRef.current = null;
    }
    if (waveformSeekFrameRef.current !== null) {
      globalThis.cancelAnimationFrame?.(waveformSeekFrameRef.current);
      waveformSeekFrameRef.current = null;
    }
  };

  const handleSeekKeyDown = (
    event: React.KeyboardEvent<HTMLElement>,
    minimum: number,
    maximum: number,
  ) => {
    if (!onSeek) return;
    const span = maximum - minimum;
    const step = Math.max(0.01, span / 100) * (event.shiftKey ? 10 : 1);
    const current = clamp(playheadSeconds, minimum, maximum);
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = current - step;
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = current + step;
    if (event.key === 'Home') next = minimum;
    if (event.key === 'End') next = maximum;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onSeek(clamp(next, minimum, maximum));
    onSemanticEvent('audio.seeked');
  };

  const handleViewportKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!onTimeWindowStartChange) return;
    const maximumStart = Math.max(0, view.durationSeconds - viewTimeSpan);
    const step = viewTimeSpan * (event.shiftKey ? 0.5 : 0.1);
    let next: number | null = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      next = view.timeStartSeconds - step;
    }
    if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      next = view.timeStartSeconds + step;
    }
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = maximumStart;
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onTimeWindowStartChange(clamp(next, 0, maximumStart));
    onSemanticEvent('viewport.panned');
  };

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    event.currentTarget.focus({ preventScroll: true });
    reportPointerAnchor(event);
    const point = pointForEvent(event);
    const cameraPan = event.button === 1 || event.button === 2 || tool === 'pan';
    if (!cameraPan && tool === 'select') {
      selectAtPoint(event, null);
      return;
    }
    if (!cameraPan && disabled) {
      onError('Drawing is locked. Selection and camera controls remain available.');
      return;
    }
    if (!cameraPan && tool === 'draw' && !canDraw) {
      onError('Select a species before drawing a new box. Existing boxes remain selectable.');
      return;
    }
    if (!cameraPan && tool === 'draw' && !annotationGesturesReady) {
      onError('Building spectrogram… Drawing will be available after the first frame is ready.');
      return;
    }
    const next: Gesture = {
      kind: cameraPan ? 'pan' : 'draw',
      pointerId: event.pointerId,
      start: point,
      current: point,
      viewport: structuredClone(viewport),
    };
    gestureRef.current = next;
    setGesture(next);
    event.preventDefault();
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
      return null;
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
    return selected;
  };

  const beginResize = (
    event: React.PointerEvent<HTMLButtonElement>,
    box: FrogLabelBoxV2,
    handle: ResizeHandle,
  ) => {
    if (disabled || !annotationGesturesReady || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    rootRef.current?.focus({ preventScroll: true });
    onSelect(box.id);
    clickCycleRef.current = null;
    setOverlapStack([]);
    const point = pointForEvent(event);
    const next: Gesture = {
      kind: 'resize',
      pointerId: event.pointerId,
      start: point,
      current: point,
      viewport: structuredClone(viewport),
      box: structuredClone(box),
      handle,
    };
    gestureRef.current = next;
    setGesture(next);
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const beginBoxMove = (event: React.PointerEvent<HTMLDivElement>, box: FrogLabelBoxV2) => {
    if (tool !== 'select' || event.button !== 0) return;
    event.stopPropagation();
    rootRef.current?.focus({ preventScroll: true });
    if (disabled || !annotationGesturesReady) {
      selectAtPoint(event, box.id);
      return;
    }
    event.preventDefault();
    const point = pointForEvent(event);
    const next: Gesture = {
      kind: 'move',
      pointerId: event.pointerId,
      start: point,
      current: point,
      viewport: structuredClone(viewport),
      box: structuredClone(box),
      handle: 'move',
      moved: false,
    };
    gestureRef.current = next;
    setGesture(next);
    rootRef.current?.setPointerCapture(event.pointerId);
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    reportPointerAnchor(event);
    const active = gestureRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = pointForEvent(event);
    const crossedMoveThreshold =
      active.kind === 'move' &&
      (active.moved ||
        Math.hypot(point.x - active.start.x, point.y - active.start.y) >=
          MOVE_GESTURE_THRESHOLD_PIXELS);
    const next = {
      ...active,
      current: point,
      ...(active.kind === 'move' ? { moved: crossedMoveThreshold } : {}),
    };
    gestureRef.current = next;
    setGesture(next);
    if (active.kind === 'move' && crossedMoveThreshold && !active.moved && active.box) {
      clickCycleRef.current = null;
      setOverlapStack([active.box.id]);
      onSelect(active.box.id);
    }
    if (active.kind === 'pan') {
      const secondsPerPixel =
        (active.viewport.timeEndSeconds - active.viewport.timeStartSeconds) /
        active.viewport.widthPixels;
      const deltaTimeSeconds = -(point.x - active.current.x) * secondsPerPixel;
      const deltaFrequencyAxisFraction =
        (point.y - active.current.y) / active.viewport.heightPixels;
      if (deltaTimeSeconds !== 0 || deltaFrequencyAxisFraction !== 0) {
        if (onPanView) onPanView(deltaTimeSeconds, deltaFrequencyAxisFraction);
        else onPan?.(deltaTimeSeconds);
      }
    }
    event.preventDefault();
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
      onSemanticEvent('viewport.panned');
      return;
    }
    if (completed.kind === 'move') {
      const didMove =
        completed.moved ||
        Math.hypot(
          completed.current.x - completed.start.x,
          completed.current.y - completed.start.y,
        ) >= MOVE_GESTURE_THRESHOLD_PIXELS;
      if (!didMove) {
        selectAtPoint(event, completed.box?.id ?? null);
        return;
      }
      if (!completed.moved && completed.box) {
        clickCycleRef.current = null;
        setOverlapStack([completed.box.id]);
        onSelect(completed.box.id);
      }
    }
    try {
      if (
        (completed.kind === 'resize' || completed.kind === 'move') &&
        completed.box &&
        completed.handle
      ) {
        const geometry = geometryForBoxEdit(
          completed.box,
          completed.handle,
          completed.start,
          completed.current,
          completed.viewport,
        );
        if (sameBoxGeometry(completed.box, geometry)) return;
        if (await onResize(completed.box.id, geometry)) {
          onSemanticEvent('box.resized', completed.box.id);
        }
      } else {
        const geometry = geometryFromDrag(completed.start, completed.current, completed.viewport);
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
    onPointerAnchorChange?.(null);
    if (rootRef.current?.hasPointerCapture(event.pointerId)) {
      rootRef.current.releasePointerCapture(event.pointerId);
    }
  };

  const previewRect = previewRectForGesture(gesture);

  return (
    <div
      className={`spectrogram-shell ${timeZoomed ? 'time-zoomed' : ''}`}
      data-tutorial="spectrogram"
      data-spectrogram-state={renderPhase}
      data-render-status={renderState.status}
      data-render-quality={renderState.quality}
      data-render-generation={renderState.paintGeneration}
      data-render-request-generation={renderState.requestGeneration}
      data-render-painted-request-generation={renderState.paintedRequestGeneration}
      data-frequency-scale={settings.frequencyScale}
      data-frequency-warp={settings.frequencyWarp}
      data-window-milliseconds={settings.windowMilliseconds}
      data-window-function={settings.windowFunction}
      data-overlap-percent={settings.overlapPercent}
      data-minimum-db={settings.minimumDb}
      data-view-time-start-seconds={view.timeStartSeconds}
      data-view-time-end-seconds={view.timeEndSeconds}
      data-view-low-frequency-hz={view.lowFrequencyHz}
      data-view-high-frequency-hz={view.highFrequencyHz}
      data-time-zoomed={timeZoomed}
      aria-busy={!renderState.hasFrame && renderState.status !== 'error'}
    >
      <div
        className={`waveform-stack ${timeZoomed ? 'is-zoomed' : ''}`}
        data-waveform-tier-count={timeZoomed ? 2 : 1}
      >
        {timeZoomed && (
          <div
            ref={overviewRef}
            className={`waveform-strip waveform-overview ${waveformGestureKind === 'viewport-pan' ? 'is-panning' : ''}`}
            data-time-start-seconds={view.timeStartSeconds}
            data-time-end-seconds={view.timeEndSeconds}
          >
            <canvas ref={overviewWaveformRef} aria-hidden="true" />
            <div
              className="waveform-seek-surface overview-seek-surface"
              role="slider"
              tabIndex={0}
              aria-label="Seek within the full recording"
              aria-valuemin={0}
              aria-valuemax={view.durationSeconds}
              aria-valuenow={clamp(presentedPlayheadSeconds, 0, view.durationSeconds)}
              aria-valuetext={`${clamp(presentedPlayheadSeconds, 0, view.durationSeconds).toFixed(3)} seconds`}
              onPointerDown={(event) => beginWaveformSeek(event, 'overview-seek')}
              onPointerMove={moveWaveformGesture}
              onPointerUp={finishWaveformGesture}
              onPointerCancel={cancelWaveformGesture}
              onLostPointerCapture={cancelWaveformGesture}
              onKeyDown={(event) => handleSeekKeyDown(event, 0, view.durationSeconds)}
            />
            <div
              className="waveform-viewport-window"
              role="slider"
              tabIndex={0}
              aria-label="Visible time window"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, view.durationSeconds - viewTimeSpan)}
              aria-valuenow={presentedViewportStartSeconds}
              aria-valuetext={`${presentedViewportStartSeconds.toFixed(3)} to ${(presentedViewportStartSeconds + viewTimeSpan).toFixed(3)} seconds`}
              style={{
                left: `${(presentedViewportStartSeconds / view.durationSeconds) * 100}%`,
                width: `${(viewTimeSpan / view.durationSeconds) * 100}%`,
              }}
              onPointerDown={beginViewportPan}
              onPointerMove={moveWaveformGesture}
              onPointerUp={finishWaveformGesture}
              onPointerCancel={cancelWaveformGesture}
              onLostPointerCapture={cancelWaveformGesture}
              onKeyDown={handleViewportKeyDown}
            >
              <span className="waveform-viewport-visual" aria-hidden="true" />
            </div>
            <span
              className="playhead-line waveform-playhead overview-playhead"
              style={{
                left: `${(clamp(presentedPlayheadSeconds, 0, view.durationSeconds) / view.durationSeconds) * 100}%`,
              }}
              aria-hidden="true"
            />
            <span
              className="waveform-playhead-hit-target"
              data-testid="overview-playhead-handle"
              title="Drag playhead"
              aria-hidden="true"
              style={{
                left: `${(clamp(presentedPlayheadSeconds, 0, view.durationSeconds) / view.durationSeconds) * 100}%`,
              }}
              onPointerDown={(event) => beginWaveformSeek(event, 'playhead-seek')}
              onPointerMove={moveWaveformGesture}
              onPointerUp={finishWaveformGesture}
              onPointerCancel={cancelWaveformGesture}
              onLostPointerCapture={cancelWaveformGesture}
            />
          </div>
        )}
        <div
          ref={detailWaveformRef}
          className="waveform-strip waveform-detail"
          role="group"
          aria-label="Waveform aligned with the spectrogram"
        >
          <canvas ref={waveformRef} aria-hidden="true" />
          <div
            className="waveform-seek-surface detail-seek-surface"
            role="slider"
            tabIndex={0}
            aria-label="Seek within the visible waveform"
            aria-valuemin={view.timeStartSeconds}
            aria-valuemax={view.timeEndSeconds}
            aria-valuenow={clamp(
              presentedPlayheadSeconds,
              view.timeStartSeconds,
              view.timeEndSeconds,
            )}
            aria-valuetext={
              presentedPlayheadSeconds < view.timeStartSeconds ||
              presentedPlayheadSeconds > view.timeEndSeconds
                ? `Playhead is outside the visible window; nearest boundary ${clamp(presentedPlayheadSeconds, view.timeStartSeconds, view.timeEndSeconds).toFixed(3)} seconds`
                : `${presentedPlayheadSeconds.toFixed(3)} seconds`
            }
            onPointerDown={(event) => beginWaveformSeek(event, 'detail-seek')}
            onPointerMove={moveWaveformGesture}
            onPointerUp={finishWaveformGesture}
            onPointerCancel={cancelWaveformGesture}
            onLostPointerCapture={cancelWaveformGesture}
            onKeyDown={(event) =>
              handleSeekKeyDown(event, view.timeStartSeconds, view.timeEndSeconds)
            }
          />
          {presentedPlayheadSeconds >= view.timeStartSeconds &&
            presentedPlayheadSeconds <= view.timeEndSeconds && (
              <span
                className="playhead-line waveform-playhead"
                style={{
                  left: `${((presentedPlayheadSeconds - view.timeStartSeconds) / viewTimeSpan) * 100}%`,
                }}
              />
            )}
        </div>
      </div>
      <div className="frequency-axis" aria-hidden="true">
        <span>{Math.round(view.highFrequencyHz / 1000)} kHz</span>
        <span>
          {Math.round(
            frequencyAtAxisRatio(
              0.5,
              view.lowFrequencyHz,
              view.highFrequencyHz,
              settings.frequencyScale,
              settings.frequencyWarp,
            ) / 1000,
          )}{' '}
          kHz
        </span>
        <span>{Math.round(view.lowFrequencyHz / 1000)} kHz</span>
      </div>
      <div
        ref={rootRef}
        className={`spectrogram-stage tool-${tool}`}
        tabIndex={-1}
        data-workspace-command-surface
        data-box-count={boxes.length}
        data-selected-box-id={selectedBoxId ?? ''}
        data-annotation-gestures-ready={annotationGesturesReady}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={(event) => void finish(event)}
        onPointerCancel={cancel}
        onLostPointerCapture={cancel}
        onPointerLeave={() => {
          if (!gestureRef.current) onPointerAnchorChange?.(null);
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        <canvas
          ref={canvasRef}
          className="spectrogram-canvas"
          role="img"
          aria-label={`Spectrogram from ${view.timeStartSeconds.toFixed(2)} to ${view.timeEndSeconds.toFixed(2)} seconds and ${Math.round(view.lowFrequencyHz)} to ${Math.round(view.highFrequencyHz)} hertz`}
        />
        {renderPhase === 'error' && !renderState.hasFrame && (
          <div className="spectrogram-readiness-overlay error" role="alert">
            <strong>Spectrogram could not be built.</strong>
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
          </div>
        )}
        {denseAnnotations && (
          <canvas
            ref={annotationCanvasRef}
            className="annotation-layer-canvas"
            aria-hidden="true"
          />
        )}
        {presentedPlayheadSeconds >= view.timeStartSeconds &&
          presentedPlayheadSeconds <= view.timeEndSeconds && (
            <span
              className="playhead-line"
              style={{
                left: `${((presentedPlayheadSeconds - view.timeStartSeconds) / (view.timeEndSeconds - view.timeStartSeconds)) * 100}%`,
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
                className={`annotation-box ${selected ? 'selected' : ''} ${tool === 'select' && !disabled && annotationGesturesReady ? 'editable' : ''}`}
                data-box-id={box.id}
                data-overlap-count={selected ? overlapStack.length : undefined}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                  pointerEvents: tool === 'select' ? 'auto' : 'none',
                }}
                onPointerDown={(event) => beginBoxMove(event, box)}
              >
                <button
                  type="button"
                  className="box-label"
                  aria-label={`Select ${box.species.code}, ${box.species.speciesName} box`}
                  onPointerDown={(event) => event.stopPropagation()}
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
                  (['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const).map((handle) => (
                    <button
                      type="button"
                      key={handle}
                      className={`resize-handle handle-${handle}`}
                      aria-label={`Resize ${box.species.code} box from its ${resizeHandleLabel(handle)}`}
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

function previewRectForGesture(gesture: Gesture | null) {
  if (!gesture || gesture.kind === 'pan') return null;
  if (gesture.kind === 'draw') return rectFromPoints(gesture.start, gesture.current);
  if (gesture.kind === 'move' && !gesture.moved) return null;
  if (!gesture.box || !gesture.handle) return null;
  try {
    const geometry = geometryForBoxEdit(
      gesture.box,
      gesture.handle,
      gesture.start,
      gesture.current,
      gesture.viewport,
    );
    return boxToPixelRect({ ...gesture.box, ...geometry }, gesture.viewport);
  } catch {
    return null;
  }
}

function sameBoxGeometry(
  left: FrogLabelBoxV2,
  right: Pick<
    FrogLabelBoxV2,
    'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
  >,
): boolean {
  return (
    left.startTimeSeconds === right.startTimeSeconds &&
    left.endTimeSeconds === right.endTimeSeconds &&
    left.lowFrequencyHz === right.lowFrequencyHz &&
    left.highFrequencyHz === right.highFrequencyHz
  );
}

function resizeHandleLabel(handle: ResizeHandle): string {
  return {
    nw: 'top-left corner',
    n: 'top edge',
    ne: 'top-right corner',
    e: 'right edge',
    se: 'bottom-right corner',
    s: 'bottom edge',
    sw: 'bottom-left corner',
    w: 'left edge',
  }[handle];
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

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function sameViewportProjection(left: ViewportTransform, right: ViewportTransform): boolean {
  return (
    left.timeStartSeconds === right.timeStartSeconds &&
    left.timeEndSeconds === right.timeEndSeconds &&
    left.lowFrequencyHz === right.lowFrequencyHz &&
    left.highFrequencyHz === right.highFrequencyHz &&
    left.frequencyScale === right.frequencyScale &&
    left.frequencyWarp === right.frequencyWarp &&
    left.widthPixels === right.widthPixels &&
    left.heightPixels === right.heightPixels
  );
}

async function paintDenseAnnotationsCooperative(
  canvas: HTMLCanvasElement,
  boxes: Array<{
    box: FrogLabelBoxV2;
    rect: { left: number; top: number; width: number; height: number };
  }>,
  size: { width: number; height: number },
  signal: AbortSignal,
): Promise<void> {
  // Effects run after React commits but still share the originating browser
  // task. Start dense raster work in a fresh task so a large-document reducer
  // commit and its annotation repaint cannot combine into one >50 ms task.
  await yieldToAnnotationHost();
  if (signal.aborted) return;
  const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(size.width * pixelRatio));
  const height = Math.max(1, Math.round(size.height * pixelRatio));
  const buffer = canvas.ownerDocument.createElement('canvas');
  buffer.width = width;
  buffer.height = height;
  const context = buffer.getContext('2d');
  if (!context) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  context.fillStyle = 'rgba(30, 200, 100, 0.16)';
  context.strokeStyle = '#70e6a1';
  context.lineWidth = 2;
  let sliceStartedAt = performance.now();
  const boxesPerBatch = 128;
  for (let start = 0; start < boxes.length; start += boxesPerBatch) {
    if (signal.aborted) return;
    context.beginPath();
    const end = Math.min(boxes.length, start + boxesPerBatch);
    for (let index = start; index < end; index += 1) {
      const rect = boxes[index].rect;
      context.rect(rect.left, rect.top, Math.max(1, rect.width), Math.max(1, rect.height));
    }
    context.fill();
    context.stroke();
    if (performance.now() - sliceStartedAt >= 4) {
      await yieldToAnnotationHost();
      sliceStartedAt = performance.now();
    }
  }
  if (signal.aborted) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const visibleContext = canvas.getContext('2d');
  if (!visibleContext) return;
  visibleContext.setTransform(1, 0, 0, 1, 0, 0);
  visibleContext.clearRect(0, 0, width, height);
  visibleContext.drawImage(buffer, 0, 0);
}

function yieldToAnnotationHost(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function projectVisibleBoxes(boxes: FrogLabelBoxV2[], viewport: ViewportTransform) {
  return boxes
    .map((box) => {
      return { box, rect: boxToPixelRect(box, viewport) };
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
  timeStartSeconds: number,
  timeEndSeconds: number,
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
    timeStartSeconds,
    timeEndSeconds,
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
