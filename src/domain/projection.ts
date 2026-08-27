import type { CanonicalPoint, FrogLabelBoxV2, PixelPoint, ViewportTransform } from './types';
import { ValidationError } from './errors';
import { frequencyAtAxisRatio, frequencyToAxisRatio } from './frequencyScale';

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export type BoxGeometry = Pick<
  FrogLabelBoxV2,
  'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
>;

export type BoxEditHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

export function assertViewport(viewport: ViewportTransform): void {
  const values = [
    viewport.durationSeconds,
    viewport.maximumFrequencyHz,
    viewport.analysisSampleRateHz ?? 1,
    viewport.timeStartSeconds,
    viewport.timeEndSeconds,
    viewport.lowFrequencyHz,
    viewport.highFrequencyHz,
    viewport.widthPixels,
    viewport.heightPixels,
  ];
  if (!values.every(Number.isFinite)) throw new ValidationError('Viewport values must be finite');
  if (viewport.widthPixels <= 0 || viewport.heightPixels <= 0) {
    throw new ValidationError('Viewport dimensions must be positive');
  }
  if (viewport.timeStartSeconds < 0 || viewport.timeStartSeconds >= viewport.timeEndSeconds) {
    throw new ValidationError('Viewport time range is invalid');
  }
  if (viewport.lowFrequencyHz < 0 || viewport.lowFrequencyHz >= viewport.highFrequencyHz) {
    throw new ValidationError('Viewport frequency range is invalid');
  }
  if (viewport.frequencyScale === 'logarithmic' && viewport.lowFrequencyHz <= 0) {
    throw new ValidationError('Logarithmic viewports require a positive frequency minimum');
  }
  if (
    viewport.frequencyWarp !== undefined &&
    (!Number.isFinite(viewport.frequencyWarp) ||
      viewport.frequencyWarp < 0 ||
      viewport.frequencyWarp > 1)
  ) {
    throw new ValidationError('Frequency emphasis must be between zero and one');
  }
  if (
    viewport.timeEndSeconds > viewport.durationSeconds ||
    viewport.highFrequencyHz > viewport.maximumFrequencyHz
  ) {
    throw new ValidationError('Viewport exceeds trusted audio bounds');
  }
}

export function pixelToCanonical(point: PixelPoint, viewport: ViewportTransform): CanonicalPoint {
  assertViewport(viewport);
  const x = clamp(point.x, 0, viewport.widthPixels) / viewport.widthPixels;
  const y = clamp(point.y, 0, viewport.heightPixels) / viewport.heightPixels;
  const frequencyHz = frequencyAtAxisRatio(
    1 - y,
    viewport.lowFrequencyHz,
    viewport.highFrequencyHz,
    viewport.frequencyScale,
    viewport.frequencyWarp,
  );
  return {
    timeSeconds:
      viewport.timeStartSeconds + x * (viewport.timeEndSeconds - viewport.timeStartSeconds),
    frequencyHz,
  };
}

export function canonicalToPixel(point: CanonicalPoint, viewport: ViewportTransform): PixelPoint {
  assertViewport(viewport);
  const frequencyRatio =
    1 -
    frequencyToAxisRatio(
      point.frequencyHz,
      viewport.lowFrequencyHz,
      viewport.highFrequencyHz,
      viewport.frequencyScale,
      viewport.frequencyWarp,
    );
  return {
    x:
      ((point.timeSeconds - viewport.timeStartSeconds) /
        (viewport.timeEndSeconds - viewport.timeStartSeconds)) *
      viewport.widthPixels,
    y: frequencyRatio * viewport.heightPixels,
  };
}

export function geometryFromDrag(
  start: PixelPoint,
  end: PixelPoint,
  viewport: ViewportTransform,
  minimumPixels = 3,
): BoxGeometry {
  if (Math.abs(start.x - end.x) < minimumPixels || Math.abs(start.y - end.y) < minimumPixels) {
    throw new ValidationError('A box must have a visible width and height');
  }
  const first = pixelToCanonical(start, viewport);
  const second = pixelToCanonical(end, viewport);
  return {
    startTimeSeconds: Math.min(first.timeSeconds, second.timeSeconds),
    endTimeSeconds: Math.max(first.timeSeconds, second.timeSeconds),
    lowFrequencyHz: Math.min(first.frequencyHz, second.frequencyHz),
    highFrequencyHz: Math.max(first.frequencyHz, second.frequencyHz),
  };
}

/**
 * Derive a box edit from one immutable pointer gesture.
 *
 * Side handles change only their corresponding scientific coordinate. Corner
 * handles change one time and one frequency coordinate. A move translates the
 * two canonical intervals as units, preserving duration and bandwidth even on
 * a nonlinear display axis. Callers can render this result as a local preview
 * and commit it once on pointer-up.
 */
export function geometryForBoxEdit(
  box: BoxGeometry,
  handle: BoxEditHandle,
  start: PixelPoint,
  current: PixelPoint,
  viewport: ViewportTransform,
  minimumPixels = 3,
): BoxGeometry {
  assertBoxGeometry(box, viewport);
  if (!Number.isFinite(minimumPixels) || minimumPixels < 0) {
    throw new ValidationError('Minimum box size must be a non-negative finite pixel count');
  }
  const original: BoxGeometry = {
    startTimeSeconds: box.startTimeSeconds,
    endTimeSeconds: box.endTimeSeconds,
    lowFrequencyHz: box.lowFrequencyHz,
    highFrequencyHz: box.highFrequencyHz,
  };
  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  if (deltaX === 0 && deltaY === 0) return original;

  if (handle === 'move') {
    const first = pixelToCanonical(start, viewport);
    const second = pixelToCanonical(current, viewport);
    const [startTimeSeconds, endTimeSeconds] = translateInterval(
      box.startTimeSeconds,
      box.endTimeSeconds,
      second.timeSeconds - first.timeSeconds,
      viewport.durationSeconds,
    );
    const [lowFrequencyHz, highFrequencyHz] = translateInterval(
      box.lowFrequencyHz,
      box.highFrequencyHz,
      second.frequencyHz - first.frequencyHz,
      viewport.maximumFrequencyHz,
    );
    return { startTimeSeconds, endTimeSeconds, lowFrequencyHz, highFrequencyHz };
  }

  const rect = boxToPixelRect(box, viewport);
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const minimumWidth = Math.min(minimumPixels, rect.width);
  const minimumHeight = Math.min(minimumPixels, rect.height);
  const next = original;

  if (deltaX !== 0 && handle.includes('w')) {
    const maximumLeft = Math.max(0, Math.min(viewport.widthPixels, right - minimumWidth));
    const left = clamp(rect.left + deltaX, 0, maximumLeft);
    next.startTimeSeconds = pixelToCanonical({ x: left, y: 0 }, viewport).timeSeconds;
  } else if (deltaX !== 0 && handle.includes('e')) {
    const minimumRight = Math.min(viewport.widthPixels, Math.max(0, rect.left + minimumWidth));
    const nextRight = clamp(right + deltaX, minimumRight, viewport.widthPixels);
    next.endTimeSeconds = pixelToCanonical({ x: nextRight, y: 0 }, viewport).timeSeconds;
  }

  if (deltaY !== 0 && handle.includes('n')) {
    const maximumTop = Math.max(0, Math.min(viewport.heightPixels, bottom - minimumHeight));
    const top = clamp(rect.top + deltaY, 0, maximumTop);
    next.highFrequencyHz = pixelToCanonical({ x: 0, y: top }, viewport).frequencyHz;
  } else if (deltaY !== 0 && handle.includes('s')) {
    const minimumBottom = Math.min(viewport.heightPixels, Math.max(0, rect.top + minimumHeight));
    const nextBottom = clamp(bottom + deltaY, minimumBottom, viewport.heightPixels);
    next.lowFrequencyHz = pixelToCanonical({ x: 0, y: nextBottom }, viewport).frequencyHz;
  }

  return next;
}

export function boxToPixelRect(box: BoxGeometry, viewport: ViewportTransform) {
  const upperLeft = canonicalToPixel(
    { timeSeconds: box.startTimeSeconds, frequencyHz: box.highFrequencyHz },
    viewport,
  );
  const lowerRight = canonicalToPixel(
    { timeSeconds: box.endTimeSeconds, frequencyHz: box.lowFrequencyHz },
    viewport,
  );
  return {
    left: upperLeft.x,
    top: upperLeft.y,
    width: lowerRight.x - upperLeft.x,
    height: lowerRight.y - upperLeft.y,
  };
}

function translateInterval(
  lower: number,
  upper: number,
  delta: number,
  maximum: number,
): [number, number] {
  const span = upper - lower;
  const nextLower = clamp(lower + delta, 0, maximum - span);
  return [nextLower, nextLower + span];
}

function assertBoxGeometry(box: BoxGeometry, viewport: ViewportTransform): void {
  assertViewport(viewport);
  const values = [
    box.startTimeSeconds,
    box.endTimeSeconds,
    box.lowFrequencyHz,
    box.highFrequencyHz,
  ];
  if (!values.every(Number.isFinite)) throw new ValidationError('Box coordinates must be finite');
  if (
    box.startTimeSeconds < 0 ||
    box.startTimeSeconds >= box.endTimeSeconds ||
    box.endTimeSeconds > viewport.durationSeconds ||
    box.lowFrequencyHz < 0 ||
    box.lowFrequencyHz >= box.highFrequencyHz ||
    box.highFrequencyHz > viewport.maximumFrequencyHz
  ) {
    throw new ValidationError('Box geometry exceeds trusted audio bounds');
  }
}
