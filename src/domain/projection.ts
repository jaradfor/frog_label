import type { CanonicalPoint, FrogLabelBoxV1, PixelPoint, ViewportTransform } from './types';
import { ValidationError } from './errors';

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

export function assertViewport(viewport: ViewportTransform): void {
  const values = Object.values(viewport);
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
  return {
    timeSeconds:
      viewport.timeStartSeconds + x * (viewport.timeEndSeconds - viewport.timeStartSeconds),
    frequencyHz:
      viewport.highFrequencyHz - y * (viewport.highFrequencyHz - viewport.lowFrequencyHz),
  };
}

export function canonicalToPixel(point: CanonicalPoint, viewport: ViewportTransform): PixelPoint {
  assertViewport(viewport);
  return {
    x:
      ((point.timeSeconds - viewport.timeStartSeconds) /
        (viewport.timeEndSeconds - viewport.timeStartSeconds)) *
      viewport.widthPixels,
    y:
      ((viewport.highFrequencyHz - point.frequencyHz) /
        (viewport.highFrequencyHz - viewport.lowFrequencyHz)) *
      viewport.heightPixels,
  };
}

export function geometryFromDrag(
  start: PixelPoint,
  end: PixelPoint,
  viewport: ViewportTransform,
  minimumPixels = 3,
): Pick<
  FrogLabelBoxV1,
  'startTimeSeconds' | 'endTimeSeconds' | 'lowFrequencyHz' | 'highFrequencyHz'
> {
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

export function boxToPixelRect(box: FrogLabelBoxV1, viewport: ViewportTransform) {
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
