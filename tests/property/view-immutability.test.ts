import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deterministicSerialize } from '../../src/domain/document';
import { boxToPixelRect } from '../../src/domain/projection';
import { document } from '../fixtures';

describe('view operations cannot mutate scientific geometry', () => {
  it('keeps canonical bytes stable through 100 generated viewport projections', () => {
    const before = deterministicSerialize(document);
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 20, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 10, max: 30, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 300, max: 2400 }),
        fc.integer({ min: 200, max: 1400 }),
        (start, end, width, height) => {
          fc.pre(start < end);
          boxToPixelRect(document.boxes[0], {
            durationSeconds: 30,
            maximumFrequencyHz: 22050,
            timeStartSeconds: start,
            timeEndSeconds: end,
            lowFrequencyHz: 0,
            highFrequencyHz: 22050,
            widthPixels: width,
            heightPixels: height,
          });
          expect(deterministicSerialize(document)).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
