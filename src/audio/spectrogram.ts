import type { AnalysisChannelMode, AudioAnalysisSource } from '../domain/types';

export type SpectrogramPalette = 'viridis' | 'magma' | 'inferno' | 'plasma' | 'grayscale';
export type FrequencyScale = 'linear' | 'logarithmic';

export const SPECTROGRAM_DB_FLOOR = -120;
export const SPECTROGRAM_DB_CEILING = 0;

export interface SpectrogramRenderOptions {
  timeStartSeconds: number;
  timeEndSeconds: number;
  lowFrequencyHz: number;
  highFrequencyHz: number;
  brightness: number;
  contrast?: number;
  palette: SpectrogramPalette;
  channelMode?: AnalysisChannelMode;
  frequencyScale?: FrequencyScale;
}

export interface SpectrogramAnalysis {
  sampleRateHz: number;
  fftSize: number;
  hopSamples: number;
  frameCount: number;
  binCount: number;
  durationSeconds: number;
  channelPowers: readonly Float32Array[];
}

export interface WaveformEnvelope {
  minimum: Float32Array;
  maximum: Float32Array;
}

export function analysisFftSize(sampleRateHz: number): number {
  const target = Math.ceil(sampleRateHz * 0.02);
  return Math.min(4096, Math.max(256, nextPowerOfTwo(target)));
}

export function overlapSamples(fftSamples: number, overlapPercent: number): number {
  const bounded = Math.min(100, Math.max(0, overlapPercent));
  return Math.min(fftSamples - 1, Math.round((fftSamples * bounded) / 100));
}

export function computeSpectrogramAnalysis(source: AudioAnalysisSource): SpectrogramAnalysis {
  const builder = createBuilder(source);
  for (let channel = 0; channel < source.channelCount; channel += 1) {
    for (let frame = 0; frame < builder.frameCount; frame += 1) {
      analyzeFrame(builder, source.channels[channel], channel, frame);
    }
  }
  return finishBuilder(builder);
}

export async function computeSpectrogramAnalysisCooperative(
  source: AudioAnalysisSource,
  options: { signal?: AbortSignal; framesPerYield?: number } = {},
): Promise<SpectrogramAnalysis> {
  const builder = createBuilder(source);
  const framesPerYield = Math.max(1, options.framesPerYield ?? 24);
  let completed = 0;
  for (let channel = 0; channel < source.channelCount; channel += 1) {
    for (let frame = 0; frame < builder.frameCount; frame += 1) {
      if (options.signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
      analyzeFrame(builder, source.channels[channel], channel, frame);
      completed += 1;
      if (completed % framesPerYield === 0) await yieldToMainThread();
    }
  }
  return finishBuilder(builder);
}

export function poolSpectrogramDb(
  analysis: SpectrogramAnalysis,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
): Float32Array {
  const boundedWidth = Math.max(1, Math.round(width));
  const boundedHeight = Math.max(1, Math.round(height));
  const output = new Float32Array(boundedWidth * boundedHeight);
  output.fill(SPECTROGRAM_DB_FLOOR);
  const requestedLow = options.lowFrequencyHz;
  const requestedHigh = options.highFrequencyHz;
  const nyquistHz = analysis.sampleRateHz / 2;
  if (requestedLow >= nyquistHz || requestedHigh <= 0 || requestedHigh <= requestedLow) {
    return output;
  }
  const start = clamp(options.timeStartSeconds, 0, analysis.durationSeconds);
  const end = clamp(options.timeEndSeconds, start, analysis.durationSeconds);
  const low = clamp(requestedLow, 0, nyquistHz);
  const high = clamp(requestedHigh, low, nyquistHz);
  const frameSeconds = analysis.hopSamples / analysis.sampleRateHz;
  const binHz = analysis.sampleRateHz / analysis.fftSize;
  const mode = options.channelMode ?? 'average';
  const scale = options.frequencyScale ?? 'linear';
  for (let x = 0; x < boundedWidth; x += 1) {
    const columnStart = start + (x / boundedWidth) * (end - start);
    const columnEnd = start + ((x + 1) / boundedWidth) * (end - start);
    let firstFrame = Math.floor(columnStart / frameSeconds);
    let lastFrame = Math.ceil(columnEnd / frameSeconds);
    if (lastFrame <= firstFrame) lastFrame = firstFrame + 1;
    firstFrame = clampInteger(firstFrame, 0, analysis.frameCount - 1);
    lastFrame = clampInteger(lastFrame, firstFrame + 1, analysis.frameCount);
    for (let y = 0; y < boundedHeight; y += 1) {
      const upper = frequencyAtPixel(y, boundedHeight, low, high, scale);
      const lower = frequencyAtPixel(y + 1, boundedHeight, low, high, scale);
      let firstBin = Math.floor(lower / binHz);
      let lastBin = Math.ceil(upper / binHz);
      if (lastBin <= firstBin) lastBin = firstBin + 1;
      firstBin = clampInteger(firstBin, 0, analysis.binCount - 1);
      lastBin = clampInteger(lastBin, firstBin + 1, analysis.binCount);
      let peakPower = 0;
      for (let frame = firstFrame; frame < lastFrame; frame += 1) {
        const frameOffset = frame * analysis.binCount;
        for (let bin = firstBin; bin < lastBin; bin += 1) {
          peakPower = Math.max(peakPower, combinedPower(analysis, frameOffset + bin, mode));
        }
      }
      output[y * boundedWidth + x] = powerToDb(peakPower);
    }
  }
  return output;
}

export function renderSpectrogramPixels(
  analysis: SpectrogramAnalysis,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
): Uint8ClampedArray {
  const db = poolSpectrogramDb(analysis, width, height, options);
  const pixels = new Uint8ClampedArray(db.length * 4);
  const contrast = clamp(options.contrast ?? 1, 0.25, 4);
  const brightnessOffsetDb = (clamp(options.brightness, 0.25, 3) - 1) * 18;
  for (let index = 0; index < db.length; index += 1) {
    const shifted = db[index] + brightnessOffsetDb;
    const normalized = clamp(
      ((shifted - SPECTROGRAM_DB_FLOOR) / (SPECTROGRAM_DB_CEILING - SPECTROGRAM_DB_FLOOR) - 0.5) *
        contrast +
        0.5,
      0,
      1,
    );
    const [red, green, blue] = paletteColor(options.palette, normalized);
    const offset = index * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
  return pixels;
}

export function computeSpectrogramPixels(
  channel: Float32Array,
  sampleRateHz: number,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
): Uint8ClampedArray {
  const analysis = computeSpectrogramAnalysis({
    channels: [channel],
    channelCount: 1,
    sampleRateHz,
  });
  return renderSpectrogramPixels(analysis, width, height, options);
}

export function computeWaveformEnvelope(
  source: AudioAnalysisSource,
  width: number,
  mode: AnalysisChannelMode,
  timeStartSeconds = 0,
  timeEndSeconds = source.channels[0].length / source.sampleRateHz,
): WaveformEnvelope {
  const outputWidth = Math.max(1, Math.round(width));
  const minimum = new Float32Array(outputWidth);
  const maximum = new Float32Array(outputWidth);
  const startSample = clampInteger(
    Math.floor(timeStartSeconds * source.sampleRateHz),
    0,
    source.channels[0].length - 1,
  );
  const endSample = clampInteger(
    Math.ceil(timeEndSeconds * source.sampleRateHz),
    startSample + 1,
    source.channels[0].length,
  );
  for (let x = 0; x < outputWidth; x += 1) {
    const first = Math.floor(startSample + (x / outputWidth) * (endSample - startSample));
    const last = Math.max(
      first + 1,
      Math.ceil(startSample + ((x + 1) / outputWidth) * (endSample - startSample)),
    );
    const peaks = source.channels.map((samples) => {
      let peak = 0;
      for (let index = first; index < Math.min(last, samples.length); index += 1) {
        peak = Math.max(peak, Math.abs(samples[index]));
      }
      return peak;
    });
    const peak =
      source.channelCount === 1
        ? peaks[0]
        : mode === 'left'
          ? peaks[0]
          : mode === 'right'
            ? peaks[1]
            : mode === 'max'
              ? Math.max(peaks[0], peaks[1])
              : (peaks[0] + peaks[1]) / 2;
    minimum[x] = -peak;
    maximum[x] = peak;
  }
  return { minimum, maximum };
}

export function powerToDb(power: number): number {
  return Math.max(SPECTROGRAM_DB_FLOOR, 10 * Math.log10(Math.max(power, 1e-12)));
}

interface AnalysisBuilder extends Omit<SpectrogramAnalysis, 'channelPowers'> {
  channelPowers: Float32Array[];
  window: Float64Array;
  coherentSum: number;
  real: Float64Array;
  imaginary: Float64Array;
}

function createBuilder(source: AudioAnalysisSource): AnalysisBuilder {
  if (source.channelCount < 1 || source.channelCount > 2) throw new Error('Expected 1–2 channels');
  const length = source.channels[0]?.length ?? 0;
  if (length < 1 || source.channels.some((channel) => channel.length !== length)) {
    throw new Error('Analysis channels must have one equal positive length');
  }
  const fftSize = analysisFftSize(source.sampleRateHz);
  const hopSamples = fftSize / 4;
  const frameCount = Math.ceil(length / hopSamples) + 1;
  const binCount = fftSize / 2 + 1;
  const window = Float64Array.from(
    { length: fftSize },
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1)),
  );
  return {
    sampleRateHz: source.sampleRateHz,
    fftSize,
    hopSamples,
    frameCount,
    binCount,
    durationSeconds: length / source.sampleRateHz,
    channelPowers: Array.from(
      { length: source.channelCount },
      () => new Float32Array(frameCount * binCount),
    ),
    window,
    coherentSum: window.reduce((sum, value) => sum + value, 0),
    real: new Float64Array(fftSize),
    imaginary: new Float64Array(fftSize),
  };
}

function analyzeFrame(
  builder: AnalysisBuilder,
  samples: Float32Array,
  channel: number,
  frame: number,
): void {
  const first = frame * builder.hopSamples - builder.fftSize / 2;
  builder.imaginary.fill(0);
  for (let index = 0; index < builder.fftSize; index += 1) {
    const sourceIndex = first + index;
    builder.real[index] =
      (sourceIndex >= 0 && sourceIndex < samples.length ? samples[sourceIndex] : 0) *
      builder.window[index];
  }
  fft(builder.real, builder.imaginary);
  const output = builder.channelPowers[channel];
  const offset = frame * builder.binCount;
  for (let bin = 0; bin < builder.binCount; bin += 1) {
    const edge = bin === 0 || bin === builder.binCount - 1;
    const amplitude =
      (Math.hypot(builder.real[bin], builder.imaginary[bin]) * (edge ? 1 : 2)) /
      builder.coherentSum;
    output[offset + bin] = amplitude * amplitude;
  }
}

function finishBuilder(builder: AnalysisBuilder): SpectrogramAnalysis {
  return {
    sampleRateHz: builder.sampleRateHz,
    fftSize: builder.fftSize,
    hopSamples: builder.hopSamples,
    frameCount: builder.frameCount,
    binCount: builder.binCount,
    durationSeconds: builder.durationSeconds,
    channelPowers: builder.channelPowers,
  };
}

function combinedPower(
  analysis: SpectrogramAnalysis,
  index: number,
  mode: AnalysisChannelMode,
): number {
  const left = analysis.channelPowers[0][index];
  if (analysis.channelPowers.length === 1) return left;
  const right = analysis.channelPowers[1][index];
  if (mode === 'left') return left;
  if (mode === 'right') return right;
  if (mode === 'max') return Math.max(left, right);
  return (left + right) / 2;
}

function frequencyAtPixel(
  edge: number,
  height: number,
  low: number,
  high: number,
  scale: FrequencyScale,
): number {
  const ratio = 1 - edge / height;
  if (scale === 'logarithmic' && low > 0) {
    return Math.exp(Math.log(low) + ratio * (Math.log(high) - Math.log(low)));
  }
  return low + ratio * (high - low);
}

function nextPowerOfTwo(value: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, value)));
}

function fft(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let unitReal = 1;
      let unitImaginary = 0;
      for (let index = 0; index < length / 2; index += 1) {
        const even = offset + index;
        const odd = even + length / 2;
        const oddReal = real[odd] * unitReal - imaginary[odd] * unitImaginary;
        const oddImaginary = real[odd] * unitImaginary + imaginary[odd] * unitReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = unitReal * cosine - unitImaginary * sine;
        unitImaginary = unitReal * sine + unitImaginary * cosine;
        unitReal = nextReal;
      }
    }
  }
}

function paletteColor(palette: SpectrogramPalette, value: number): [number, number, number] {
  if (palette === 'grayscale') {
    const level = Math.round(value * 255);
    return [level, level, level];
  }
  const stops: Record<Exclude<SpectrogramPalette, 'grayscale'>, Array<[number, number, number]>> = {
    viridis: [
      [68, 1, 84],
      [59, 82, 139],
      [33, 145, 140],
      [94, 201, 98],
      [253, 231, 37],
    ],
    magma: [
      [0, 0, 4],
      [81, 18, 124],
      [183, 55, 121],
      [252, 137, 97],
      [252, 253, 191],
    ],
    inferno: [
      [0, 0, 4],
      [87, 16, 110],
      [188, 55, 84],
      [249, 142, 9],
      [252, 255, 164],
    ],
    plasma: [
      [13, 8, 135],
      [126, 3, 168],
      [204, 71, 120],
      [248, 149, 64],
      [240, 249, 33],
    ],
  };
  const colors = stops[palette];
  const scaled = value * (colors.length - 1);
  const lower = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - lower;
  return colors[lower].map((component, index) =>
    Math.round(component + (colors[lower + 1][index] - component) * mix),
  ) as [number, number, number];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
