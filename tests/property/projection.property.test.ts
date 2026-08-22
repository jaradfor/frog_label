import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalToPixel, geometryFromDrag, pixelToCanonical } from '../../src/domain/projection';
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
});
