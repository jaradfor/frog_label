import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boxToPixelRect,
  canonicalToPixel,
  geometryForBoxEdit,
  geometryFromDrag,
  pixelToCanonical,
  type BoxEditHandle,
  type BoxGeometry,
} from '../../src/domain/projection';
import type { ViewportTransform } from '../../src/domain/types';

const viewport: ViewportTransform = {
  durationSeconds: 60,
  maximumFrequencyHz: 24000,
  timeStartSeconds: 5,
  timeEndSeconds: 35,
  lowFrequencyHz: 100,
  highFrequencyHz: 12000,
  widthPixels: 1200,
  heightPixels: 600,
};

const logarithmicViewport: ViewportTransform = {
  ...viewport,
  frequencyScale: 'logarithmic',
};

const adjustableViewport: ViewportTransform = {
  ...viewport,
  lowFrequencyHz: 0,
  frequencyScale: 'adjustable',
  frequencyWarp: 0.65,
};

const editBox: BoxGeometry = {
  startTimeSeconds: 10,
  endTimeSeconds: 20,
  lowFrequencyHz: 1_000,
  highFrequencyHz: 8_000,
};

const resizeHandles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const scaledViewports = [viewport, logarithmicViewport, adjustableViewport] as const;

describe('viewport projection properties', () => {
  it('round-trips canonical points within floating point tolerance', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 5, max: 35, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 100, max: 12000, noNaN: true, noDefaultInfinity: true }),
        (timeSeconds, frequencyHz) => {
          const roundTrip = pixelToCanonical(
            canonicalToPixel({ timeSeconds, frequencyHz }, viewport),
            viewport,
          );
          expect(roundTrip.timeSeconds).toBeCloseTo(timeSeconds, 9);
          expect(roundTrip.frequencyHz).toBeCloseTo(frequencyHz, 7);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('round-trips logarithmic-frequency points without shifting annotations', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 5, max: 35, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 100, max: 12000, noNaN: true, noDefaultInfinity: true }),
        (timeSeconds, frequencyHz) => {
          const roundTrip = pixelToCanonical(
            canonicalToPixel({ timeSeconds, frequencyHz }, logarithmicViewport),
            logarithmicViewport,
          );
          expect(roundTrip.timeSeconds).toBeCloseTo(timeSeconds, 9);
          expect(roundTrip.frequencyHz).toBeCloseTo(frequencyHz, 7);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('round-trips adjustable-frequency points without shifting annotations', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 5, max: 35, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0, max: 12000, noNaN: true, noDefaultInfinity: true }),
        (timeSeconds, frequencyHz) => {
          const roundTrip = pixelToCanonical(
            canonicalToPixel({ timeSeconds, frequencyHz }, adjustableViewport),
            adjustableViewport,
          );
          expect(roundTrip.timeSeconds).toBeCloseTo(timeSeconds, 9);
          expect(roundTrip.frequencyHz).toBeCloseTo(frequencyHz, 7);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('rejects out-of-range adjustable emphasis in viewport contracts', () => {
    expect(() =>
      pixelToCanonical({ x: 0, y: 0 }, { ...adjustableViewport, frequencyWarp: 1.01 }),
    ).toThrow(/between zero and one/i);
  });

  it('always normalizes a drag into ordered canonical geometry', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1190 }),
        fc.integer({ min: 0, max: 590 }),
        fc.integer({ min: 4, max: 1200 }),
        fc.integer({ min: 4, max: 600 }),
        (x, y, deltaX, deltaY) => {
          const end = { x: Math.min(1200, x + deltaX), y: Math.min(600, y + deltaY) };
          fc.pre(Math.abs(x - end.x) >= 3 && Math.abs(y - end.y) >= 3);
          const geometry = geometryFromDrag({ x, y }, end, viewport);
          expect(geometry.startTimeSeconds).toBeLessThan(geometry.endTimeSeconds);
          expect(geometry.lowFrequencyHz).toBeLessThan(geometry.highFrequencyHz);
          expect(geometry.startTimeSeconds).toBeGreaterThanOrEqual(viewport.timeStartSeconds);
          expect(geometry.endTimeSeconds).toBeLessThanOrEqual(viewport.timeEndSeconds);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('keeps side-handle dimensions independent and prevents every handle from inverting a box', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...scaledViewports),
        fc.constantFrom(...resizeHandles),
        fc.integer({ min: -2_000, max: 2_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        (scaledViewport, handle, deltaX, deltaY) => {
          const start = pointForHandle(editBox, handle, scaledViewport);
          const edited = geometryForBoxEdit(
            editBox,
            handle,
            start,
            { x: start.x + deltaX, y: start.y + deltaY },
            scaledViewport,
          );
          const rect = boxToPixelRect(edited, scaledViewport);

          expect(edited.startTimeSeconds).toBeGreaterThanOrEqual(0);
          expect(edited.startTimeSeconds).toBeLessThan(edited.endTimeSeconds);
          expect(edited.endTimeSeconds).toBeLessThanOrEqual(scaledViewport.durationSeconds);
          expect(edited.lowFrequencyHz).toBeGreaterThanOrEqual(0);
          expect(edited.lowFrequencyHz).toBeLessThan(edited.highFrequencyHz);
          expect(edited.highFrequencyHz).toBeLessThanOrEqual(scaledViewport.maximumFrequencyHz);

          if (!handle.includes('w')) expect(edited.startTimeSeconds).toBe(editBox.startTimeSeconds);
          if (!handle.includes('e')) expect(edited.endTimeSeconds).toBe(editBox.endTimeSeconds);
          if (!handle.includes('n')) expect(edited.highFrequencyHz).toBe(editBox.highFrequencyHz);
          if (!handle.includes('s')) expect(edited.lowFrequencyHz).toBe(editBox.lowFrequencyHz);
          if (handle.includes('w') || handle.includes('e')) {
            expect(rect.width).toBeGreaterThanOrEqual(3 - 1e-9);
          }
          if (handle.includes('n') || handle.includes('s')) {
            expect(rect.height).toBeGreaterThanOrEqual(3 - 1e-9);
          }
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('maps vertical resize handles through each nonlinear frequency inverse', () => {
    for (const scaledViewport of scaledViewports) {
      const top = pointForHandle(editBox, 'n', scaledViewport);
      const movedTop = { ...top, y: top.y + 20 };
      const fromTop = geometryForBoxEdit(editBox, 'n', top, movedTop, scaledViewport);
      expect(fromTop.highFrequencyHz).toBeCloseTo(
        pixelToCanonical(movedTop, scaledViewport).frequencyHz,
        8,
      );
      expect(fromTop.lowFrequencyHz).toBe(editBox.lowFrequencyHz);
      expect(fromTop.startTimeSeconds).toBe(editBox.startTimeSeconds);
      expect(fromTop.endTimeSeconds).toBe(editBox.endTimeSeconds);

      const bottom = pointForHandle(editBox, 's', scaledViewport);
      const movedBottom = { ...bottom, y: bottom.y - 20 };
      const fromBottom = geometryForBoxEdit(editBox, 's', bottom, movedBottom, scaledViewport);
      expect(fromBottom.lowFrequencyHz).toBeCloseTo(
        pixelToCanonical(movedBottom, scaledViewport).frequencyHz,
        8,
      );
      expect(fromBottom.highFrequencyHz).toBe(editBox.highFrequencyHz);
      expect(fromBottom.startTimeSeconds).toBe(editBox.startTimeSeconds);
      expect(fromBottom.endTimeSeconds).toBe(editBox.endTimeSeconds);
    }
  });

  it('moves boxes as canonical intervals while preserving duration and hertz bandwidth', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...scaledViewports),
        fc.integer({ min: -2_000, max: 2_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        (scaledViewport, deltaX, deltaY) => {
          const start = canonicalToPixel({ timeSeconds: 15, frequencyHz: 4_000 }, scaledViewport);
          const moved = geometryForBoxEdit(
            editBox,
            'move',
            start,
            { x: start.x + deltaX, y: start.y + deltaY },
            scaledViewport,
          );

          expect(moved.endTimeSeconds - moved.startTimeSeconds).toBeCloseTo(10, 10);
          expect(moved.highFrequencyHz - moved.lowFrequencyHz).toBeCloseTo(7_000, 8);
          expect(moved.startTimeSeconds).toBeGreaterThanOrEqual(0);
          expect(moved.endTimeSeconds).toBeLessThanOrEqual(scaledViewport.durationSeconds);
          expect(moved.lowFrequencyHz).toBeGreaterThanOrEqual(0);
          expect(moved.highFrequencyHz).toBeLessThanOrEqual(scaledViewport.maximumFrequencyHz);
        },
      ),
      { numRuns: 1_000 },
    );
  });

  it('clamps whole-box translation at every audio boundary without shrinking it', () => {
    const fullViewport: ViewportTransform = {
      ...viewport,
      timeStartSeconds: 0,
      timeEndSeconds: 60,
      lowFrequencyHz: 0,
      highFrequencyHz: 24_000,
    };
    const center = canonicalToPixel({ timeSeconds: 15, frequencyHz: 4_000 }, fullViewport);
    const leftAndDown = geometryForBoxEdit(
      editBox,
      'move',
      center,
      { x: -10_000, y: 10_000 },
      fullViewport,
    );
    expect(leftAndDown).toEqual({
      startTimeSeconds: 0,
      endTimeSeconds: 10,
      lowFrequencyHz: 0,
      highFrequencyHz: 7_000,
    });

    const rightAndUp = geometryForBoxEdit(
      editBox,
      'move',
      center,
      { x: 10_000, y: -10_000 },
      fullViewport,
    );
    expect(rightAndUp).toEqual({
      startTimeSeconds: 50,
      endTimeSeconds: 60,
      lowFrequencyHz: 17_000,
      highFrequencyHz: 24_000,
    });
  });

  it('returns exact original coordinates for a no-movement edit', () => {
    const point = pointForHandle(editBox, 'se', logarithmicViewport);
    for (const handle of [...resizeHandles, 'move'] as const) {
      expect(geometryForBoxEdit(editBox, handle, point, point, logarithmicViewport)).toEqual(
        editBox,
      );
    }
  });
});

function pointForHandle(
  box: BoxGeometry,
  handle: Exclude<BoxEditHandle, 'move'>,
  targetViewport: ViewportTransform,
) {
  const rect = boxToPixelRect(box, targetViewport);
  const horizontal = handle.includes('w')
    ? rect.left
    : handle.includes('e')
      ? rect.left + rect.width
      : rect.left + rect.width / 2;
  const vertical = handle.includes('n')
    ? rect.top
    : handle.includes('s')
      ? rect.top + rect.height
      : rect.top + rect.height / 2;
  return { x: horizontal, y: vertical };
}
