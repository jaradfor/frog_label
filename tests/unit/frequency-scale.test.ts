import { describe, expect, it } from 'vitest';
import { frequencyAtAxisRatio, frequencyToAxisRatio } from '../../src/domain/frequencyScale';

describe('adjustable frequency scale', () => {
  it('moves continuously from linear toward logarithmic low-frequency emphasis', () => {
    const frequency = 1_000;
    const low = 20;
    const high = 24_000;
    const linear = frequencyToAxisRatio(frequency, low, high, 'linear');
    const gentle = frequencyToAxisRatio(frequency, low, high, 'adjustable', 0.25);
    const balanced = frequencyToAxisRatio(frequency, low, high, 'adjustable', 0.5);
    const strong = frequencyToAxisRatio(frequency, low, high, 'adjustable', 1);
    const logarithmic = frequencyToAxisRatio(frequency, low, high, 'logarithmic');

    expect(linear).toBeLessThan(gentle);
    expect(gentle).toBeLessThan(balanced);
    expect(balanced).toBeLessThan(strong);
    expect(strong).toBeLessThan(logarithmic);
  });

  it('round-trips exactly enough for annotation geometry at every emphasis', () => {
    for (const warp of [0, 0.25, 0.5, 0.75, 1]) {
      for (const frequency of [0, 20, 300, 1_000, 8_000, 24_000]) {
        const ratio = frequencyToAxisRatio(frequency, 0, 24_000, 'adjustable', warp);
        expect(frequencyAtAxisRatio(ratio, 0, 24_000, 'adjustable', warp)).toBeCloseTo(
          frequency,
          8,
        );
      }
    }
  });

  it('projects offscreen frequencies beyond the viewport instead of pinning boxes to an edge', () => {
    expect(frequencyToAxisRatio(-100, 0, 24_000, 'adjustable', 0.5)).toBeLessThan(0);
    expect(frequencyToAxisRatio(30_000, 0, 24_000, 'adjustable', 0.5)).toBeGreaterThan(1);
  });
});
