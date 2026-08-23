import type { AnalysisChannelMode, AudioAnalysisSource } from '../domain/types';
import { frequencyAtAxisRatio, type FrequencyScale } from '../domain/frequencyScale';

export type { FrequencyScale } from '../domain/frequencyScale';

export const SPECTROGRAM_PALETTES = [
  { value: 'roseus', label: 'Roseus' },
  { value: 'inferno', label: 'Inferno' },
  { value: 'inverse-grayscale', label: 'Inverse gray' },
  { value: 'grayscale', label: 'Gray' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'magma', label: 'Magma' },
  { value: 'plasma', label: 'Plasma' },
] as const;

export type SpectrogramPalette = (typeof SPECTROGRAM_PALETTES)[number]['value'];

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
  frequencyWarp?: number;
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

interface WaveformPeakIndex {
  blockSamples: number;
  leafCount: number;
  blockCount: number;
  tree: Float32Array;
}

export interface SpectrogramPixelFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/** A rectangular subset of one globally defined output raster. */
export interface SpectrogramRasterRegion {
  rasterWidth: number;
  rasterHeight: number;
  pixelX: number;
  pixelY: number;
  width: number;
  height: number;
}

interface SpectrogramPoolPlan {
  width: number;
  height: number;
  output: Float32Array;
  firstFrames: Int32Array;
  lastFrames: Int32Array;
  firstBins: Int32Array;
  lastBins: Int32Array;
  firstVisibleBin: number;
  lastVisibleBin: number;
  valid: boolean;
}

interface SpectrogramPreviewPlan {
  source: AudioAnalysisSource;
  width: number;
  height: number;
  db: Float32Array;
  fftSize: number;
  hopSamples: number;
  startSeconds: number;
  endSeconds: number;
  channelMode: AnalysisChannelMode;
  window: Float64Array;
  coherentSum: number;
  real: Float64Array;
  imaginary: Float64Array;
  channelPowers: Float32Array[];
  firstBins: Int32Array;
  lastBins: Int32Array;
  valid: boolean;
}

const WAVEFORM_BLOCK_SAMPLES = 64;
const waveformPeakIndexes = new WeakMap<Float32Array, WaveformPeakIndex>();
const waveformPeakIndexBuilds = new WeakMap<Float32Array, Promise<WaveformPeakIndex>>();

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
  options: { signal?: AbortSignal; framesPerYield?: number; sliceMilliseconds?: number } = {},
): Promise<SpectrogramAnalysis> {
  const builder = createBuilder(source);
  const framesPerYield = Math.max(1, options.framesPerYield ?? 24);
  const sliceMilliseconds = Math.max(1, options.sliceMilliseconds ?? 8);
  let completed = 0;
  let sliceStartedAt = monotonicNow();
  for (let channel = 0; channel < source.channelCount; channel += 1) {
    for (let frame = 0; frame < builder.frameCount; frame += 1) {
      if (options.signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
      analyzeFrame(builder, source.channels[channel], channel, frame);
      completed += 1;
      if (completed % framesPerYield === 0) {
        const now = monotonicNow();
        if (now - sliceStartedAt >= sliceMilliseconds) {
          await yieldToMainThread();
          sliceStartedAt = monotonicNow();
        }
      }
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
  const plan = createPoolPlan(analysis, width, height, options);
  if (!plan.valid) return plan.output;
  const binPeaks = new Float64Array(analysis.binCount);
  for (let x = 0; x < plan.width; x += 1) {
    poolSpectrogramColumn(analysis, plan, options.channelMode ?? 'average', x, binPeaks);
  }
  return plan.output;
}

/**
 * Pools one tile against the global view raster. Global pixel coordinates are
 * intentionally part of the contract: independently rendered tiles therefore
 * have exactly the same frame/bin boundaries as a monolithic render.
 */
export function poolSpectrogramDbRegion(
  analysis: SpectrogramAnalysis,
  region: SpectrogramRasterRegion,
  options: SpectrogramRenderOptions,
): Float32Array {
  const plan = createPoolPlan(analysis, region.width, region.height, options, region);
  if (!plan.valid) return plan.output;
  const binPeaks = new Float64Array(analysis.binCount);
  for (let x = 0; x < plan.width; x += 1) {
    poolSpectrogramColumn(analysis, plan, options.channelMode ?? 'average', x, binPeaks);
  }
  return plan.output;
}

/**
 * Main-thread-safe exact pooling. It performs the same rectangular peak
 * reduction as `poolSpectrogramDb`, but yields between bounded column slices
 * so a worker failure cannot freeze annotation input.
 */
export async function poolSpectrogramDbCooperative(
  analysis: SpectrogramAnalysis,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
  cooperative: { signal?: AbortSignal; sliceMilliseconds?: number } = {},
): Promise<Float32Array> {
  const plan = createPoolPlan(analysis, width, height, options);
  if (!plan.valid) return plan.output;
  const binPeaks = new Float64Array(analysis.binCount);
  const sliceMilliseconds = Math.max(1, cooperative.sliceMilliseconds ?? 8);
  let sliceStartedAt = monotonicNow();
  for (let x = 0; x < plan.width; x += 1) {
    throwIfAborted(cooperative.signal, 'Spectrogram render cancelled');
    poolSpectrogramColumn(analysis, plan, options.channelMode ?? 'average', x, binPeaks);
    if (monotonicNow() - sliceStartedAt >= sliceMilliseconds) {
      await yieldToMainThread();
      sliceStartedAt = monotonicNow();
    }
  }
  return plan.output;
}

export async function poolSpectrogramDbRegionCooperative(
  analysis: SpectrogramAnalysis,
  region: SpectrogramRasterRegion,
  options: SpectrogramRenderOptions,
  cooperative: { signal?: AbortSignal; sliceMilliseconds?: number } = {},
): Promise<Float32Array> {
  const plan = createPoolPlan(analysis, region.width, region.height, options, region);
  if (!plan.valid) return plan.output;
  const binPeaks = new Float64Array(analysis.binCount);
  const sliceMilliseconds = Math.max(1, cooperative.sliceMilliseconds ?? 8);
  let sliceStartedAt = monotonicNow();
  for (let x = 0; x < plan.width; x += 1) {
    throwIfAborted(cooperative.signal, 'Spectrogram tile render cancelled');
    poolSpectrogramColumn(analysis, plan, options.channelMode ?? 'average', x, binPeaks);
    if (monotonicNow() - sliceStartedAt >= sliceMilliseconds) {
      await yieldToMainThread();
      sliceStartedAt = monotonicNow();
    }
  }
  return plan.output;
}

export function renderSpectrogramPixels(
  analysis: SpectrogramAnalysis,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
): Uint8ClampedArray {
  const db = poolSpectrogramDb(analysis, width, height, options);
  return colorizeSpectrogramDb(db, options);
}

export async function renderSpectrogramPixelsCooperative(
  analysis: SpectrogramAnalysis,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
  cooperative: { signal?: AbortSignal; sliceMilliseconds?: number } = {},
): Promise<Uint8ClampedArray> {
  const db = await poolSpectrogramDbCooperative(analysis, width, height, options, cooperative);
  throwIfAborted(cooperative.signal, 'Spectrogram render cancelled');
  return colorizeSpectrogramDbCooperative(db, options, cooperative);
}

/**
 * Produces a bounded, same-window spectral preview while the complete-clip
 * analysis is still being built. The exact frame replaces it automatically.
 */
export function renderSpectrogramPreviewPixels(
  source: AudioAnalysisSource,
  targetWidth: number,
  targetHeight: number,
  options: SpectrogramRenderOptions,
): SpectrogramPixelFrame {
  const plan = createSpectrogramPreviewPlan(source, targetWidth, targetHeight, options);
  if (plan.valid) {
    for (let x = 0; x < plan.width; x += 1) renderSpectrogramPreviewColumn(plan, x);
  }
  return {
    width: plan.width,
    height: plan.height,
    pixels: colorizeSpectrogramDb(plan.db, options),
  };
}

/** Main-thread-safe variant of the bounded same-window spectral preview. */
export async function renderSpectrogramPreviewPixelsCooperative(
  source: AudioAnalysisSource,
  targetWidth: number,
  targetHeight: number,
  options: SpectrogramRenderOptions,
  cooperative: { signal?: AbortSignal; sliceMilliseconds?: number } = {},
): Promise<SpectrogramPixelFrame> {
  // Let the retained canvas and surrounding application shell reach the
  // compositor before even the first preview FFT touches PCM.
  await yieldToMainThread();
  throwIfAborted(cooperative.signal, 'Spectrogram preview cancelled');
  const plan = createSpectrogramPreviewPlan(source, targetWidth, targetHeight, options);
  const sliceMilliseconds = Math.max(1, cooperative.sliceMilliseconds ?? 8);
  let sliceStartedAt = monotonicNow();
  if (plan.valid) {
    for (let x = 0; x < plan.width; x += 1) {
      throwIfAborted(cooperative.signal, 'Spectrogram preview cancelled');
      renderSpectrogramPreviewColumn(plan, x);
      if (monotonicNow() - sliceStartedAt >= sliceMilliseconds) {
        await yieldToMainThread();
        sliceStartedAt = monotonicNow();
      }
    }
  }
  const pixels = await colorizeSpectrogramDbCooperative(plan.db, options, cooperative);
  return { width: plan.width, height: plan.height, pixels };
}

function createSpectrogramPreviewPlan(
  source: AudioAnalysisSource,
  targetWidth: number,
  targetHeight: number,
  options: SpectrogramRenderOptions,
): SpectrogramPreviewPlan {
  const fftSize = analysisFftSize(source.sampleRateHz);
  const hopSamples = fftSize / 4;
  const binCount = fftSize / 2 + 1;
  const operationWeight = fftSize * Math.log2(fftSize) * source.channelCount;
  const maximumColumns = clampInteger(Math.floor(3_000_000 / operationWeight), 32, 256);
  const width = Math.max(1, Math.min(Math.round(targetWidth), maximumColumns));
  const height = Math.max(1, Math.min(Math.round(targetHeight), 160));
  const durationSeconds = source.channels[0].length / source.sampleRateHz;
  const nyquistHz = source.sampleRateHz / 2;
  const start = clamp(options.timeStartSeconds, 0, durationSeconds);
  const end = clamp(options.timeEndSeconds, start, durationSeconds);
  const requestedLow = options.lowFrequencyHz;
  const requestedHigh = options.highFrequencyHz;
  const db = new Float32Array(width * height);
  db.fill(SPECTROGRAM_DB_FLOOR);
  const valid = requestedLow < nyquistHz && requestedHigh > 0 && requestedHigh > requestedLow;
  const low = clamp(requestedLow, 0, nyquistHz);
  const high = clamp(requestedHigh, low, nyquistHz);
  const scale = options.frequencyScale ?? 'linear';
  const channelMode = options.channelMode ?? 'average';
  const binHz = source.sampleRateHz / fftSize;
  const window = hannWindow(fftSize);
  const coherentSum = window.reduce((sum, value) => sum + value, 0);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const channelPowers = Array.from(
    { length: source.channelCount },
    () => new Float32Array(binCount),
  );
  const firstBins = new Int32Array(height);
  const lastBins = new Int32Array(height);
  if (valid) {
    for (let y = 0; y < height; y += 1) {
      const upper = frequencyAtPixel(y, height, low, high, scale, options.frequencyWarp);
      const lower = frequencyAtPixel(y + 1, height, low, high, scale, options.frequencyWarp);
      const firstBin = Math.floor(lower / binHz);
      let lastBin = Math.ceil(upper / binHz);
      if (lastBin <= firstBin) lastBin = firstBin + 1;
      firstBins[y] = clampInteger(firstBin, 0, binCount - 1);
      lastBins[y] = clampInteger(lastBin, firstBins[y] + 1, binCount);
    }
  }
  return {
    source,
    width,
    height,
    db,
    fftSize,
    hopSamples,
    startSeconds: start,
    endSeconds: end,
    channelMode,
    window,
    coherentSum,
    real,
    imaginary,
    channelPowers,
    firstBins,
    lastBins,
    valid,
  };
}

function renderSpectrogramPreviewColumn(plan: SpectrogramPreviewPlan, x: number): void {
  const centerSeconds =
    plan.startSeconds + ((x + 0.5) / plan.width) * (plan.endSeconds - plan.startSeconds);
  const frame = Math.round((centerSeconds * plan.source.sampleRateHz) / plan.hopSamples);
  const firstSample = frame * plan.hopSamples - plan.fftSize / 2;
  for (let channel = 0; channel < plan.source.channelCount; channel += 1) {
    analyzeSamples(
      plan.source.channels[channel],
      firstSample,
      plan.window,
      plan.coherentSum,
      plan.real,
      plan.imaginary,
      plan.channelPowers[channel],
      0,
    );
  }
  for (let y = 0; y < plan.height; y += 1) {
    let peakPower = 0;
    for (let bin = plan.firstBins[y]; bin < plan.lastBins[y]; bin += 1) {
      peakPower = Math.max(
        peakPower,
        combinedChannelPower(plan.channelPowers, bin, plan.channelMode),
      );
    }
    plan.db[y * plan.width + x] = powerToDb(peakPower);
  }
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
    const last = Math.min(
      source.channels[0].length,
      Math.max(
        first + 1,
        Math.ceil(startSample + ((x + 1) / outputWidth) * (endSample - startSample)),
      ),
    );
    const leftPeak = waveformPeak(source.channels[0], first, last);
    const rightPeak =
      source.channelCount > 1 ? waveformPeak(source.channels[1], first, last) : leftPeak;
    const peak =
      source.channelCount === 1
        ? leftPeak
        : mode === 'left'
          ? leftPeak
          : mode === 'right'
            ? rightPeak
            : mode === 'max'
              ? Math.max(leftPeak, rightPeak)
              : (leftPeak + rightPeak) / 2;
    minimum[x] = -peak;
    maximum[x] = peak;
  }
  return { minimum, maximum };
}

/**
 * Builds the exact waveform range-max index without monopolizing the main
 * thread. Until it resolves, `computeWaveformEnvelope` uses bounded sampling.
 */
export async function prepareWaveformPeakIndexesCooperative(
  source: AudioAnalysisSource,
  options: { signal?: AbortSignal; sliceMilliseconds?: number } = {},
): Promise<void> {
  // Always yield before touching PCM so mounting a maximum-duration task can
  // paint its shell and bounded waveform preview first.
  await yieldToMainThread();
  for (const samples of source.channels) {
    throwIfAborted(options.signal, 'Waveform indexing cancelled');
    if (waveformPeakIndexes.has(samples)) continue;
    let build = waveformPeakIndexBuilds.get(samples);
    if (!build) {
      // The cached build belongs to the PCM source, not to whichever canvas
      // happened to request it first. Individual callers may stop waiting,
      // but must not cancel work shared by another mounted waveform.
      build = buildWaveformPeakIndexCooperative(samples, {
        sliceMilliseconds: options.sliceMilliseconds,
      });
      waveformPeakIndexBuilds.set(samples, build);
      const clearBuild = () => {
        if (waveformPeakIndexBuilds.get(samples) === build) {
          waveformPeakIndexBuilds.delete(samples);
        }
      };
      void build.then(clearBuild, clearBuild);
    }
    await waitForWaveformPeakIndex(build, options.signal);
  }
}

function waitForWaveformPeakIndex(
  build: Promise<WaveformPeakIndex>,
  signal?: AbortSignal,
): Promise<WaveformPeakIndex> {
  if (!signal) return build;
  if (signal.aborted) {
    return Promise.reject(new DOMException('Waveform indexing cancelled', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(new DOMException('Waveform indexing cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    void build.then(
      (index) => {
        cleanup();
        resolve(index);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function waveformPeak(samples: Float32Array, first: number, last: number): number {
  const boundedFirst = clampInteger(first, 0, samples.length);
  const boundedLast = clampInteger(last, boundedFirst, samples.length);
  if (boundedLast <= boundedFirst) return 0;
  const index = waveformPeakIndexes.get(samples);
  if (!index) return sampleAbsolutePeak(samples, boundedFirst, boundedLast, 32);
  const firstFullBlock = Math.ceil(boundedFirst / index.blockSamples);
  const lastFullBlock = Math.floor(boundedLast / index.blockSamples);
  if (firstFullBlock >= lastFullBlock) {
    return scanAbsolutePeak(samples, boundedFirst, boundedLast);
  }
  let peak = scanAbsolutePeak(
    samples,
    boundedFirst,
    Math.min(boundedLast, firstFullBlock * index.blockSamples),
  );
  peak = Math.max(peak, queryWaveformBlocks(index, firstFullBlock, lastFullBlock));
  peak = Math.max(
    peak,
    scanAbsolutePeak(
      samples,
      Math.max(boundedFirst, lastFullBlock * index.blockSamples),
      boundedLast,
    ),
  );
  return peak;
}

async function buildWaveformPeakIndexCooperative(
  samples: Float32Array,
  options: { sliceMilliseconds?: number },
): Promise<WaveformPeakIndex> {
  const blockCount = Math.ceil(samples.length / WAVEFORM_BLOCK_SAMPLES);
  const leafCount = nextPowerOfTwo(blockCount);
  const tree = new Float32Array(leafCount * 2);
  const sliceMilliseconds = Math.max(1, options.sliceMilliseconds ?? 8);
  let sliceStartedAt = monotonicNow();
  for (let block = 0; block < blockCount; block += 1) {
    tree[leafCount + block] = scanAbsolutePeak(
      samples,
      block * WAVEFORM_BLOCK_SAMPLES,
      Math.min(samples.length, (block + 1) * WAVEFORM_BLOCK_SAMPLES),
    );
    if (monotonicNow() - sliceStartedAt >= sliceMilliseconds) {
      await yieldToMainThread();
      sliceStartedAt = monotonicNow();
    }
  }
  for (let node = leafCount - 1; node > 0; node -= 1) {
    tree[node] = Math.max(tree[node * 2], tree[node * 2 + 1]);
    if ((node & 4_095) === 0 && monotonicNow() - sliceStartedAt >= sliceMilliseconds) {
      await yieldToMainThread();
      sliceStartedAt = monotonicNow();
    }
  }
  const created = {
    blockSamples: WAVEFORM_BLOCK_SAMPLES,
    leafCount,
    blockCount,
    tree,
  };
  waveformPeakIndexes.set(samples, created);
  return created;
}

function queryWaveformBlocks(index: WaveformPeakIndex, first: number, last: number): number {
  let left = index.leafCount + clampInteger(first, 0, index.blockCount);
  let right = index.leafCount + clampInteger(last, first, index.blockCount);
  let peak = 0;
  while (left < right) {
    if (left & 1) peak = Math.max(peak, index.tree[left++]);
    if (right & 1) peak = Math.max(peak, index.tree[--right]);
    left >>= 1;
    right >>= 1;
  }
  return peak;
}

function scanAbsolutePeak(samples: Float32Array, first: number, last: number): number {
  let peak = 0;
  for (let sample = first; sample < last; sample += 1) {
    peak = Math.max(peak, Math.abs(samples[sample]));
  }
  return peak;
}

function sampleAbsolutePeak(
  samples: Float32Array,
  first: number,
  last: number,
  maximumSamples: number,
): number {
  const count = last - first;
  if (count <= maximumSamples) return scanAbsolutePeak(samples, first, last);
  let peak = Math.max(Math.abs(samples[first]), Math.abs(samples[last - 1]));
  for (let sample = 0; sample < maximumSamples; sample += 1) {
    const index = Math.min(last - 1, Math.floor(first + ((sample + 0.5) / maximumSamples) * count));
    peak = Math.max(peak, Math.abs(samples[index]));
  }
  return peak;
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
  const window = hannWindow(fftSize);
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
  analyzeSamples(
    samples,
    first,
    builder.window,
    builder.coherentSum,
    builder.real,
    builder.imaginary,
    builder.channelPowers[channel],
    frame * builder.binCount,
  );
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

function analyzeSamples(
  samples: Float32Array,
  firstSample: number,
  window: Float64Array,
  coherentSum: number,
  real: Float64Array,
  imaginary: Float64Array,
  output: Float32Array,
  outputOffset: number,
): void {
  imaginary.fill(0);
  for (let index = 0; index < window.length; index += 1) {
    const sourceIndex = firstSample + index;
    real[index] =
      (sourceIndex >= 0 && sourceIndex < samples.length ? samples[sourceIndex] : 0) * window[index];
  }
  fft(real, imaginary);
  const binCount = window.length / 2 + 1;
  for (let bin = 0; bin < binCount; bin += 1) {
    const scale = (bin === 0 || bin === binCount - 1 ? 1 : 2) / coherentSum;
    output[outputOffset + bin] =
      (real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) * scale * scale;
  }
}

function hannWindow(fftSize: number): Float64Array {
  return Float64Array.from(
    { length: fftSize },
    (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1)),
  );
}

function createPoolPlan(
  analysis: SpectrogramAnalysis,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
  region?: SpectrogramRasterRegion,
): SpectrogramPoolPlan {
  const boundedWidth = Math.max(1, Math.round(width));
  const boundedHeight = Math.max(1, Math.round(height));
  const rasterWidth = Math.max(1, Math.round(region?.rasterWidth ?? boundedWidth));
  const rasterHeight = Math.max(1, Math.round(region?.rasterHeight ?? boundedHeight));
  const pixelX = Math.round(region?.pixelX ?? 0);
  const pixelY = Math.round(region?.pixelY ?? 0);
  const output = new Float32Array(boundedWidth * boundedHeight);
  output.fill(SPECTROGRAM_DB_FLOOR);
  const firstFrames = new Int32Array(boundedWidth);
  const lastFrames = new Int32Array(boundedWidth);
  const firstBins = new Int32Array(boundedHeight);
  const lastBins = new Int32Array(boundedHeight);
  const requestedLow = options.lowFrequencyHz;
  const requestedHigh = options.highFrequencyHz;
  const nyquistHz = analysis.sampleRateHz / 2;
  const valid = requestedLow < nyquistHz && requestedHigh > 0 && requestedHigh > requestedLow;
  if (!valid) {
    return {
      width: boundedWidth,
      height: boundedHeight,
      output,
      firstFrames,
      lastFrames,
      firstBins,
      lastBins,
      firstVisibleBin: 0,
      lastVisibleBin: 0,
      valid: false,
    };
  }
  const start = clamp(options.timeStartSeconds, 0, analysis.durationSeconds);
  const end = clamp(options.timeEndSeconds, start, analysis.durationSeconds);
  const low = clamp(requestedLow, 0, nyquistHz);
  const high = clamp(requestedHigh, low, nyquistHz);
  const frameSeconds = analysis.hopSamples / analysis.sampleRateHz;
  const binHz = analysis.sampleRateHz / analysis.fftSize;
  const scale = options.frequencyScale ?? 'linear';
  for (let x = 0; x < boundedWidth; x += 1) {
    const globalX = pixelX + x;
    const columnStart = start + (globalX / rasterWidth) * (end - start);
    const columnEnd = start + ((globalX + 1) / rasterWidth) * (end - start);
    const firstFrame = Math.floor(columnStart / frameSeconds);
    let lastFrame = Math.ceil(columnEnd / frameSeconds);
    if (lastFrame <= firstFrame) lastFrame = firstFrame + 1;
    firstFrames[x] = clampInteger(firstFrame, 0, analysis.frameCount - 1);
    lastFrames[x] = clampInteger(lastFrame, firstFrames[x] + 1, analysis.frameCount);
  }
  let firstVisibleBin = analysis.binCount - 1;
  let lastVisibleBin = 0;
  for (let y = 0; y < boundedHeight; y += 1) {
    const globalY = pixelY + y;
    const upper = frequencyAtPixel(globalY, rasterHeight, low, high, scale, options.frequencyWarp);
    const lower = frequencyAtPixel(
      globalY + 1,
      rasterHeight,
      low,
      high,
      scale,
      options.frequencyWarp,
    );
    const firstBin = Math.floor(lower / binHz);
    let lastBin = Math.ceil(upper / binHz);
    if (lastBin <= firstBin) lastBin = firstBin + 1;
    firstBins[y] = clampInteger(firstBin, 0, analysis.binCount - 1);
    lastBins[y] = clampInteger(lastBin, firstBins[y] + 1, analysis.binCount);
    firstVisibleBin = Math.min(firstVisibleBin, firstBins[y]);
    lastVisibleBin = Math.max(lastVisibleBin, lastBins[y]);
  }
  return {
    width: boundedWidth,
    height: boundedHeight,
    output,
    firstFrames,
    lastFrames,
    firstBins,
    lastBins,
    firstVisibleBin,
    lastVisibleBin,
    valid: true,
  };
}

/** Exact separable peak pooling: time-to-bin first, then bin-to-row. */
function poolSpectrogramColumn(
  analysis: SpectrogramAnalysis,
  plan: SpectrogramPoolPlan,
  mode: AnalysisChannelMode,
  x: number,
  binPeaks: Float64Array,
): void {
  binPeaks.fill(0, plan.firstVisibleBin, plan.lastVisibleBin);
  const left = analysis.channelPowers[0];
  const right = analysis.channelPowers[1];
  const firstFrame = plan.firstFrames[x];
  const lastFrame = plan.lastFrames[x];
  const firstBin = plan.firstVisibleBin;
  const lastBin = plan.lastVisibleBin;
  if (!right || mode === 'left') {
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const frameOffset = frame * analysis.binCount;
      for (let bin = firstBin; bin < lastBin; bin += 1) {
        const power = left[frameOffset + bin];
        if (power > binPeaks[bin]) binPeaks[bin] = power;
      }
    }
  } else if (mode === 'right') {
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const frameOffset = frame * analysis.binCount;
      for (let bin = firstBin; bin < lastBin; bin += 1) {
        const power = right[frameOffset + bin];
        if (power > binPeaks[bin]) binPeaks[bin] = power;
      }
    }
  } else if (mode === 'max') {
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const frameOffset = frame * analysis.binCount;
      for (let bin = firstBin; bin < lastBin; bin += 1) {
        const index = frameOffset + bin;
        const power = Math.max(left[index], right[index]);
        if (power > binPeaks[bin]) binPeaks[bin] = power;
      }
    }
  } else {
    for (let frame = firstFrame; frame < lastFrame; frame += 1) {
      const frameOffset = frame * analysis.binCount;
      for (let bin = firstBin; bin < lastBin; bin += 1) {
        const index = frameOffset + bin;
        const power = (left[index] + right[index]) / 2;
        if (power > binPeaks[bin]) binPeaks[bin] = power;
      }
    }
  }
  let priorFirstBin = -1;
  let priorLastBin = -1;
  let priorPeakPower = -1;
  let priorDb = SPECTROGRAM_DB_FLOOR;
  for (let y = 0; y < plan.height; y += 1) {
    const rowFirstBin = plan.firstBins[y];
    const rowLastBin = plan.lastBins[y];
    if (rowFirstBin !== priorFirstBin || rowLastBin !== priorLastBin) {
      let peakPower = 0;
      for (let bin = rowFirstBin; bin < rowLastBin; bin += 1) {
        if (binPeaks[bin] > peakPower) peakPower = binPeaks[bin];
      }
      priorFirstBin = rowFirstBin;
      priorLastBin = rowLastBin;
      if (peakPower !== priorPeakPower) {
        priorPeakPower = peakPower;
        priorDb = powerToDb(peakPower);
      }
    }
    plan.output[y * plan.width + x] = priorDb;
  }
}

function combinedChannelPower(
  powers: readonly Float32Array[],
  index: number,
  mode: AnalysisChannelMode,
): number {
  const left = powers[0][index];
  if (powers.length === 1) return left;
  const right = powers[1][index];
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
  warp?: number,
): number {
  const ratio = 1 - edge / height;
  return frequencyAtAxisRatio(ratio, low, high, scale, warp);
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

const COLOR_LUT_LEVELS = 4_096;
const colorLutCache = new Map<string, Uint8ClampedArray>();
const PALETTE_STOPS: Record<
  Exclude<SpectrogramPalette, 'grayscale' | 'inverse-grayscale'>,
  readonly (readonly [number, number, number])[]
> = {
  roseus: [
    [219, 198, 66],
    [243, 110, 28],
    [217, 79, 138],
    [122, 27, 108],
    [43, 10, 61],
  ],
  viridis: [
    [68, 1, 84],
    [48, 103, 141],
    [53, 183, 120],
    [253, 231, 36],
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
    [66, 10, 104],
    [147, 38, 103],
    [221, 81, 58],
    [252, 165, 10],
    [252, 255, 164],
  ],
  plasma: [
    [13, 8, 135],
    [106, 0, 168],
    [177, 42, 144],
    [225, 100, 98],
    [252, 166, 54],
    [240, 249, 33],
  ],
};

export function colorizeSpectrogramDb(
  db: Float32Array,
  options: SpectrogramRenderOptions,
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(db.length * 4);
  const lut = colorLut(options);
  const levelScale = (COLOR_LUT_LEVELS - 1) / (SPECTROGRAM_DB_CEILING - SPECTROGRAM_DB_FLOOR);
  for (let index = 0; index < db.length; index += 1) {
    const unboundedLevel = (db[index] - SPECTROGRAM_DB_FLOOR) * levelScale;
    const level =
      unboundedLevel <= 0
        ? 0
        : unboundedLevel >= COLOR_LUT_LEVELS - 1
          ? COLOR_LUT_LEVELS - 1
          : (unboundedLevel + 0.5) | 0;
    const sourceOffset = level * 3;
    const targetOffset = index * 4;
    pixels[targetOffset] = lut[sourceOffset];
    pixels[targetOffset + 1] = lut[sourceOffset + 1];
    pixels[targetOffset + 2] = lut[sourceOffset + 2];
    pixels[targetOffset + 3] = 255;
  }
  return pixels;
}

/** Palette-only RGBA lookup used by the WebGL tile compositor. */
export function createSpectrogramPaletteLut(
  palette: SpectrogramPalette,
  levels = 256,
): Uint8ClampedArray {
  const boundedLevels = Math.max(2, Math.round(levels));
  const lut = new Uint8ClampedArray(boundedLevels * 4);
  for (let level = 0; level < boundedLevels; level += 1) {
    const offset = level * 4;
    writePaletteColor(lut, offset, palette, level / (boundedLevels - 1));
    lut[offset + 3] = 255;
  }
  return lut;
}

/** CSS preview built from the same stops as the scientific raster compositor. */
export function spectrogramPaletteCssGradient(palette: SpectrogramPalette): string {
  if (palette === 'grayscale') return 'linear-gradient(90deg, rgb(0 0 0), rgb(255 255 255))';
  if (palette === 'inverse-grayscale') {
    return 'linear-gradient(90deg, rgb(255 255 255), rgb(0 0 0))';
  }
  return `linear-gradient(90deg, ${PALETTE_STOPS[palette]
    .map(([red, green, blue]) => `rgb(${red} ${green} ${blue})`)
    .join(', ')})`;
}

async function colorizeSpectrogramDbCooperative(
  db: Float32Array,
  options: SpectrogramRenderOptions,
  cooperative: { signal?: AbortSignal; sliceMilliseconds?: number },
): Promise<Uint8ClampedArray> {
  const pixels = new Uint8ClampedArray(db.length * 4);
  const lut = colorLut(options);
  const levelScale = (COLOR_LUT_LEVELS - 1) / (SPECTROGRAM_DB_CEILING - SPECTROGRAM_DB_FLOOR);
  const sliceMilliseconds = Math.max(1, cooperative.sliceMilliseconds ?? 8);
  let sliceStartedAt = monotonicNow();
  for (let index = 0; index < db.length; index += 1) {
    const unboundedLevel = (db[index] - SPECTROGRAM_DB_FLOOR) * levelScale;
    const level =
      unboundedLevel <= 0
        ? 0
        : unboundedLevel >= COLOR_LUT_LEVELS - 1
          ? COLOR_LUT_LEVELS - 1
          : (unboundedLevel + 0.5) | 0;
    const sourceOffset = level * 3;
    const targetOffset = index * 4;
    pixels[targetOffset] = lut[sourceOffset];
    pixels[targetOffset + 1] = lut[sourceOffset + 1];
    pixels[targetOffset + 2] = lut[sourceOffset + 2];
    pixels[targetOffset + 3] = 255;
    if ((index & 4_095) === 0 && monotonicNow() - sliceStartedAt >= sliceMilliseconds) {
      throwIfAborted(cooperative.signal, 'Spectrogram render cancelled');
      await yieldToMainThread();
      sliceStartedAt = monotonicNow();
    }
  }
  throwIfAborted(cooperative.signal, 'Spectrogram render cancelled');
  return pixels;
}

function colorLut(options: SpectrogramRenderOptions): Uint8ClampedArray {
  const contrast = clamp(options.contrast ?? 1, 0.25, 4);
  const brightness = clamp(options.brightness, 0.25, 3);
  const cacheKey = `${options.palette}:${brightness}:${contrast}`;
  const cached = colorLutCache.get(cacheKey);
  if (cached) return cached;
  const lut = new Uint8ClampedArray(COLOR_LUT_LEVELS * 3);
  const brightnessOffsetDb = (brightness - 1) * 18;
  for (let level = 0; level < COLOR_LUT_LEVELS; level += 1) {
    const db =
      SPECTROGRAM_DB_FLOOR +
      (level / (COLOR_LUT_LEVELS - 1)) * (SPECTROGRAM_DB_CEILING - SPECTROGRAM_DB_FLOOR);
    const shifted = db + brightnessOffsetDb;
    const normalized = clamp(
      ((shifted - SPECTROGRAM_DB_FLOOR) / (SPECTROGRAM_DB_CEILING - SPECTROGRAM_DB_FLOOR) - 0.5) *
        contrast +
        0.5,
      0,
      1,
    );
    writePaletteColor(lut, level * 3, options.palette, normalized);
  }
  colorLutCache.set(cacheKey, lut);
  if (colorLutCache.size > 16) {
    const oldest = colorLutCache.keys().next().value as string | undefined;
    if (oldest !== undefined) colorLutCache.delete(oldest);
  }
  return lut;
}

function writePaletteColor(
  target: Uint8ClampedArray,
  offset: number,
  palette: SpectrogramPalette,
  value: number,
): void {
  if (palette === 'grayscale' || palette === 'inverse-grayscale') {
    const intensity = Math.round((palette === 'inverse-grayscale' ? 1 - value : value) * 255);
    target[offset] = intensity;
    target[offset + 1] = intensity;
    target[offset + 2] = intensity;
    return;
  }
  const colors = PALETTE_STOPS[palette];
  const scaled = value * (colors.length - 1);
  const lower = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - lower;
  const first = colors[lower];
  const second = colors[lower + 1];
  target[offset] = Math.round(first[0] + (second[0] - first[0]) * mix);
  target[offset + 1] = Math.round(first[1] + (second[1] - first[1]) * mix);
  target[offset + 2] = Math.round(first[2] + (second[2] - first[2]) * mix);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) throw new DOMException(message, 'AbortError');
}

function yieldToMainThread(): Promise<void> {
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}
