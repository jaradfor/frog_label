export type FrequencyScale = 'linear' | 'adjustable' | 'logarithmic';

export const DEFAULT_FREQUENCY_WARP = 0.5;

const MINIMUM_ADJUSTABLE_EXPONENT = 0.25;

export function clampFrequencyWarp(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_FREQUENCY_WARP;
  return Math.min(1, Math.max(0, value ?? DEFAULT_FREQUENCY_WARP));
}

/**
 * Convert a scientific frequency to its normalized vertical-axis position.
 * Zero is the viewport minimum and one is the viewport maximum.
 *
 * Adjustable mode uses a power-law axis. It is exactly linear at zero
 * emphasis, progressively grants more pixels to low frequencies, remains
 * defined at 0 Hz, and has a cheap exact inverse for rendering and gestures.
 */
export function frequencyToAxisRatio(
  frequencyHz: number,
  lowFrequencyHz: number,
  highFrequencyHz: number,
  scale: FrequencyScale = 'linear',
  warp = DEFAULT_FREQUENCY_WARP,
): number {
  const span = highFrequencyHz - lowFrequencyHz;
  if (!(span > 0)) return 0;
  if (scale === 'logarithmic' && lowFrequencyHz > 0) {
    const frequency = Math.max(lowFrequencyHz / 2, frequencyHz);
    return (
      (Math.log(frequency) - Math.log(lowFrequencyHz)) /
      (Math.log(highFrequencyHz) - Math.log(lowFrequencyHz))
    );
  }
  const linearRatio = (frequencyHz - lowFrequencyHz) / span;
  if (scale !== 'adjustable') return linearRatio;
  return signedPower(linearRatio, adjustableFrequencyExponent(warp));
}

/** Exact inverse of frequencyToAxisRatio. */
export function frequencyAtAxisRatio(
  rawRatio: number,
  lowFrequencyHz: number,
  highFrequencyHz: number,
  scale: FrequencyScale = 'linear',
  warp = DEFAULT_FREQUENCY_WARP,
): number {
  const ratio = Math.min(1, Math.max(0, rawRatio));
  if (scale === 'logarithmic' && lowFrequencyHz > 0) {
    return Math.exp(
      Math.log(lowFrequencyHz) + ratio * (Math.log(highFrequencyHz) - Math.log(lowFrequencyHz)),
    );
  }
  const adjustedRatio =
    scale === 'adjustable' ? ratio ** (1 / adjustableFrequencyExponent(warp)) : ratio;
  return lowFrequencyHz + adjustedRatio * (highFrequencyHz - lowFrequencyHz);
}

export function adjustableFrequencyExponent(warp: number | undefined): number {
  return 1 - clampFrequencyWarp(warp) * (1 - MINIMUM_ADJUSTABLE_EXPONENT);
}

function signedPower(value: number, exponent: number): number {
  return Math.sign(value) * Math.abs(value) ** exponent;
}
