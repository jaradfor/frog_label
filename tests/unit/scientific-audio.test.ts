import { describe, expect, it } from 'vitest';
import {
  analysisFftSize,
  computeSpectrogramAnalysis,
  computeSpectrogramAnalysisCooperative,
  computeWaveformEnvelope,
  createSpectrogramPaletteLut,
  poolSpectrogramDb,
  poolSpectrogramDbCooperative,
  poolSpectrogramDbRegion,
  poolSpectrogramDbRegionCooperative,
  powerToDb,
  prepareWaveformPeakIndexesCooperative,
  renderSpectrogramPreviewPixels,
  renderSpectrogramPreviewPixelsCooperative,
  SPECTROGRAM_DB_FLOOR,
  SPECTROGRAM_PALETTES,
  spectrogramPaletteCssGradient,
  type FrequencyScale,
  type SpectrogramAnalysis,
  type SpectrogramRenderOptions,
} from '../../src/audio/spectrogram';
import { AUDIO_LIMITS, decodePcmWav, parseWavHeader } from '../../src/audio/wav';
import type { AnalysisChannelMode, AudioAnalysisSource } from '../../src/domain/types';

describe('source-faithful WAV decoding', () => {
  it('allows five-minute 48 kHz stereo recordings', () => {
    expect(AUDIO_LIMITS.maximumDurationSeconds).toBe(300);
    expect(AUDIO_LIMITS.maximumDecodedChannelSamples).toBeGreaterThanOrEqual(300 * 48_000 * 2);
  });

  for (const fixture of [
    { format: 1 as const, bits: 8 as const },
    { format: 1 as const, bits: 16 as const },
    { format: 1 as const, bits: 24 as const },
    { format: 1 as const, bits: 32 as const },
    { format: 3 as const, bits: 32 as const },
  ]) {
    it(`decodes format ${fixture.format} at ${fixture.bits} bits`, () => {
      const bytes = wavFixture({
        sampleRateHz: 96_000,
        channels: [[-0.75, 0, 0.75]],
        formatCode: fixture.format,
        bitsPerSample: fixture.bits,
      });
      const header = parseWavHeader(bytes);
      const decoded = decodePcmWav(bytes);
      expect(header.sampleRateHz).toBe(96_000);
      expect(header.channelCount).toBe(1);
      expect(decoded.channels[0][0]).toBeCloseTo(-0.75, fixture.bits === 8 ? 1 : 4);
      expect(decoded.channels[0][2]).toBeCloseTo(0.75, fixture.bits === 8 ? 1 : 4);
    });
  }

  it('preserves two distinct playback-analysis channels through 192 kHz', () => {
    const bytes = wavFixture({
      sampleRateHz: 192_000,
      channels: [
        [0.5, 0.25],
        [-0.5, -0.25],
      ],
      formatCode: 1,
      bitsPerSample: 24,
    });
    const decoded = decodePcmWav(bytes);
    expect(decoded.header.channelCount).toBe(2);
    expect(decoded.channels[0][0]).toBeCloseTo(0.5, 5);
    expect(decoded.channels[1]![0]).toBeCloseTo(-0.5, 5);
  });

  it('rejects malformed, truncated, and over-limit headers distinctly', () => {
    expect(() => parseWavHeader(new ArrayBuffer(12))).toThrow(/RIFF\/WAVE markers/);
    const truncated = wavFixture({
      sampleRateHz: 48_000,
      channels: [[0.1, 0.2]],
      formatCode: 1,
      bitsPerSample: 16,
    }).slice(0, 45);
    expect(() => parseWavHeader(truncated)).toThrow(/truncated/);
    const tooFast = wavFixture({
      sampleRateHz: 192_001,
      channels: [[0]],
      formatCode: 1,
      bitsPerSample: 16,
    });
    expect(() => parseWavHeader(tooFast)).toThrow(/limit is 192000 Hz/);
  });
});

describe('complete calibrated channel analysis', () => {
  const sampleRateHz = 8_000;
  const length = sampleRateHz;
  const frequencyHz = 1_000;
  const tone = Float32Array.from({ length }, (_, index) =>
    Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz),
  );
  const silence = new Float32Array(length);

  it('uses energy averaging so antiphase stereo cannot cancel', () => {
    const source = stereo(
      tone,
      Float32Array.from(tone, (value) => -value),
      sampleRateHz,
    );
    const analysis = computeSpectrogramAnalysis(source);
    const average = peakDb(analysis, 'average');
    const maximum = peakDb(analysis, 'max');
    expect(average).toBeCloseTo(maximum, 5);
    const envelope = computeWaveformEnvelope(source, 80, 'average');
    expect(Math.max(...envelope.maximum)).toBeGreaterThan(0.95);
  });

  it('makes right-only Average exactly Max minus 3.0103 dB', () => {
    const analysis = computeSpectrogramAnalysis(stereo(silence, tone, sampleRateHz));
    expect(peakDb(analysis, 'right')).toBeCloseTo(peakDb(analysis, 'max'), 5);
    expect(peakDb(analysis, 'average')).toBeCloseTo(peakDb(analysis, 'max') - 3.0103, 3);
    expect(peakDb(analysis, 'left')).toBe(SPECTROGRAM_DB_FLOOR);
  });

  it('makes identical-channel Average and Max identical', () => {
    const analysis = computeSpectrogramAnalysis(stereo(tone, tone, sampleRateHz));
    expect(peakDb(analysis, 'average')).toBeCloseTo(peakDb(analysis, 'max'), 6);
  });

  for (const startSeconds of [0, 0.217, 0.88]) {
    it(`detects a 120 ms edge/phase call beginning at ${startSeconds}s`, () => {
      const call = new Float32Array(length);
      const start = Math.round(startSeconds * sampleRateHz);
      const end = Math.min(length, start + Math.round(0.12 * sampleRateHz));
      for (let index = start; index < end; index += 1) {
        call[index] = 0.8 * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRateHz);
      }
      const analysis = computeSpectrogramAnalysis(mono(call, sampleRateHz));
      const silent = computeSpectrogramAnalysis(mono(silence, sampleRateHz));
      const peak = strongestCell(analysis);
      const silentPeak = strongestCell(silent);
      expect(10 * Math.log10(peak.power)).toBeGreaterThan(
        10 * Math.log10(Math.max(silentPeak.power, 1e-12)) + 20,
      );
      expect(Math.abs(peak.frame * analysis.hopSamples - start)).toBeLessThanOrEqual(
        Math.round(0.12 * sampleRateHz) + analysis.hopSamples,
      );
      expect(
        Math.abs((peak.bin * sampleRateHz) / analysis.fftSize - frequencyHz),
      ).toBeLessThanOrEqual(sampleRateHz / analysis.fftSize);
    });
  }

  it('keeps cooperative fallback numerically equivalent to the worker algorithm', async () => {
    const source = stereo(
      tone,
      Float32Array.from(tone, (value) => value * 0.5),
      sampleRateHz,
    );
    const synchronous = computeSpectrogramAnalysis(source);
    const cooperative = await computeSpectrogramAnalysisCooperative(source, { framesPerYield: 7 });
    expect(cooperative.fftSize).toBe(synchronous.fftSize);
    expect(cooperative.hopSamples).toBe(synchronous.hopSamples);
    expect(cooperative.channelPowers).toEqual(synchronous.channelPowers);
  });

  it('chooses an approximately 20 ms power-of-two Hann window at all supported rates', () => {
    expect(analysisFftSize(44_100)).toBe(1_024);
    expect(analysisFftSize(48_000)).toBe(1_024);
    expect(analysisFftSize(96_000)).toBe(2_048);
    expect(analysisFftSize(192_000)).toBe(4_096);
  });
});

describe('seamless spectrogram rasterization', () => {
  it('keeps every declared palette preview aligned with a non-degenerate renderer LUT', () => {
    expect(SPECTROGRAM_PALETTES.map((palette) => palette.label)).toEqual([
      'Roseus',
      'Inferno',
      'Inverse gray',
      'Gray',
      'Viridis',
      'Magma',
      'Plasma',
    ]);
    for (const palette of SPECTROGRAM_PALETTES) {
      const lut = createSpectrogramPaletteLut(palette.value, 16);
      expect(lut).toHaveLength(64);
      expect(Array.from({ length: 16 }, (_, index) => lut[index * 4 + 3])).toEqual(
        Array(16).fill(255),
      );
      expect(
        new Set(
          Array.from(
            { length: 16 },
            (_, index) => `${lut[index * 4]}:${lut[index * 4 + 1]}:${lut[index * 4 + 2]}`,
          ),
        ).size,
      ).toBeGreaterThan(1);
      expect(spectrogramPaletteCssGradient(palette.value)).toMatch(/^linear-gradient\(90deg,/);
    }
    const inverseGray = createSpectrogramPaletteLut('inverse-grayscale', 2);
    expect(Array.from(inverseGray.slice(0, 3))).toEqual([255, 255, 255]);
    expect(Array.from(inverseGray.slice(4, 7))).toEqual([0, 0, 0]);
  });

  const analysis = deterministicAnalysis();

  for (const frequencyScale of ['linear', 'adjustable', 'logarithmic'] as const) {
    for (const channelMode of ['average', 'max', 'left', 'right'] as const) {
      it(`preserves exact rectangular peaks for ${frequencyScale} ${channelMode}`, () => {
        const options: SpectrogramRenderOptions = {
          timeStartSeconds: 0.037,
          timeEndSeconds: 0.271,
          lowFrequencyHz: frequencyScale === 'logarithmic' ? 40 : 0,
          highFrequencyHz: 3_700,
          brightness: 1,
          contrast: 1,
          palette: 'viridis',
          channelMode,
          frequencyScale,
          frequencyWarp: 0.65,
        };
        expect(poolSpectrogramDb(analysis, 17, 13, options)).toEqual(
          poolSpectrogramDbNaive(analysis, 17, 13, options),
        );
      });
    }
  }

  it('keeps cooperative pooling bit-for-bit equal and honours cancellation', async () => {
    const options: SpectrogramRenderOptions = {
      timeStartSeconds: 0,
      timeEndSeconds: analysis.durationSeconds,
      lowFrequencyHz: 0,
      highFrequencyHz: 4_000,
      brightness: 1,
      palette: 'magma',
      channelMode: 'average',
      frequencyScale: 'adjustable',
      frequencyWarp: 0.65,
    };
    await expect(poolSpectrogramDbCooperative(analysis, 31, 19, options)).resolves.toEqual(
      poolSpectrogramDb(analysis, 31, 19, options),
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      poolSpectrogramDbCooperative(analysis, 31, 19, options, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stitches arbitrary tile boundaries bit-for-bit across offset frequency scales', async () => {
    const rasterWidth = 53;
    const rasterHeight = 41;
    const regions = [
      { pixelX: 0, pixelY: 0, width: 17, height: 13 },
      { pixelX: 17, pixelY: 0, width: 36, height: 13 },
      { pixelX: 0, pixelY: 13, width: 29, height: 28 },
      { pixelX: 29, pixelY: 13, width: 24, height: 28 },
    ];
    for (const frequencyScale of ['linear', 'adjustable', 'logarithmic'] as const) {
      for (const channelMode of ['average', 'max', 'left', 'right'] as const) {
        const options: SpectrogramRenderOptions = {
          timeStartSeconds: 0.031,
          timeEndSeconds: 0.263,
          lowFrequencyHz: frequencyScale === 'logarithmic' ? 37 : 0,
          highFrequencyHz: 3_713,
          brightness: 1,
          contrast: 1,
          palette: 'viridis',
          channelMode,
          frequencyScale,
          frequencyWarp: 0.65,
        };
        const full = poolSpectrogramDb(analysis, rasterWidth, rasterHeight, options);
        const stitched = new Float32Array(full.length);
        for (const bounds of regions) {
          const region = { rasterWidth, rasterHeight, ...bounds };
          const tile = poolSpectrogramDbRegion(analysis, region, options);
          const cooperativeTile = await poolSpectrogramDbRegionCooperative(
            analysis,
            region,
            options,
          );
          expect(cooperativeTile).toEqual(tile);
          for (let y = 0; y < bounds.height; y += 1) {
            stitched.set(
              tile.subarray(y * bounds.width, (y + 1) * bounds.width),
              (bounds.pixelY + y) * rasterWidth + bounds.pixelX,
            );
          }
        }
        expect(stitched).toEqual(full);
      }
    }

    const controller = new AbortController();
    controller.abort();
    await expect(
      poolSpectrogramDbRegionCooperative(
        analysis,
        { rasterWidth, rasterHeight, pixelX: 7, pixelY: 9, width: 23, height: 19 },
        {
          timeStartSeconds: 0,
          timeEndSeconds: analysis.durationSeconds,
          lowFrequencyHz: 0,
          highFrequencyHz: 4_000,
          brightness: 1,
          palette: 'magma',
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('preserves the exact seam at partial 256px tile edges', () => {
    const rasterWidth = 257;
    const rasterHeight = 257;
    const options: SpectrogramRenderOptions = {
      timeStartSeconds: 0.017,
      timeEndSeconds: 0.281,
      lowFrequencyHz: 31,
      highFrequencyHz: 3_941,
      brightness: 1,
      contrast: 1,
      palette: 'inferno',
      channelMode: 'max',
      frequencyScale: 'logarithmic',
    };
    const full = poolSpectrogramDb(analysis, rasterWidth, rasterHeight, options);
    for (const region of [
      { rasterWidth, rasterHeight, pixelX: 0, pixelY: 0, width: 256, height: 256 },
      { rasterWidth, rasterHeight, pixelX: 256, pixelY: 0, width: 1, height: 256 },
      { rasterWidth, rasterHeight, pixelX: 0, pixelY: 256, width: 256, height: 1 },
      { rasterWidth, rasterHeight, pixelX: 256, pixelY: 256, width: 1, height: 1 },
    ]) {
      const tile = poolSpectrogramDbRegion(analysis, region, options);
      for (let y = 0; y < region.height; y += 1) {
        expect(Array.from(tile.subarray(y * region.width, (y + 1) * region.width))).toEqual(
          Array.from(
            full.subarray(
              (region.pixelY + y) * rasterWidth + region.pixelX,
              (region.pixelY + y) * rasterWidth + region.pixelX + region.width,
            ),
          ),
        );
      }
    }
  });

  it('builds a bounded same-window preview before complete analysis is available', () => {
    const sampleRateHz = 8_000;
    const tone = Float32Array.from({ length: sampleRateHz }, (_, index) =>
      Math.sin((2 * Math.PI * 1_000 * index) / sampleRateHz),
    );
    const preview = renderSpectrogramPreviewPixels(mono(tone, sampleRateHz), 1_600, 800, {
      timeStartSeconds: 0,
      timeEndSeconds: 1,
      lowFrequencyHz: 0,
      highFrequencyHz: 4_000,
      brightness: 1,
      palette: 'grayscale',
    });
    expect(preview.width).toBeLessThanOrEqual(256);
    expect(preview.height).toBeLessThanOrEqual(160);
    expect(preview.pixels).toHaveLength(preview.width * preview.height * 4);
    expect(preview.pixels.reduce((maximum, value) => Math.max(maximum, value), 0)).toBe(255);
  });

  it('keeps the cooperative preview bit-for-bit equal and cancellable', async () => {
    const sampleRateHz = 8_000;
    const source = mono(
      Float32Array.from({ length: sampleRateHz }, (_, index) =>
        Math.sin((2 * Math.PI * 997 * index) / sampleRateHz),
      ),
      sampleRateHz,
    );
    const options: SpectrogramRenderOptions = {
      timeStartSeconds: 0.1,
      timeEndSeconds: 0.9,
      lowFrequencyHz: 20,
      highFrequencyHz: 3_800,
      brightness: 1.2,
      contrast: 1.1,
      palette: 'plasma',
      channelMode: 'average',
      frequencyScale: 'logarithmic',
    };
    await expect(
      renderSpectrogramPreviewPixelsCooperative(source, 1_600, 800, options),
    ).resolves.toEqual(renderSpectrogramPreviewPixels(source, 1_600, 800, options));
    const controller = new AbortController();
    const cancelled = renderSpectrogramPreviewPixelsCooperative(source, 1_600, 800, options, {
      signal: controller.signal,
      sliceMilliseconds: 1,
    });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('queries the cached waveform peak pyramid exactly across arbitrary views', async () => {
    const sampleRateHz = 8_000;
    const left = Float32Array.from(
      { length: 8_173 },
      (_, index) => Math.sin(index * 0.071) * ((index % 43) / 43),
    );
    const right = Float32Array.from(
      { length: 8_173 },
      (_, index) => Math.cos(index * 0.037) * ((index % 61) / 61),
    );
    const source = stereo(left, right, sampleRateHz);
    await prepareWaveformPeakIndexesCooperative(source, { sliceMilliseconds: 1 });
    for (const mode of ['average', 'max', 'left', 'right'] as const) {
      for (const view of [
        [0, left.length / sampleRateHz],
        [0.013, 0.731],
        [0.511, 0.893],
      ] as const) {
        expect(computeWaveformEnvelope(source, 137, mode, view[0], view[1])).toEqual(
          waveformEnvelopeNaive(source, 137, mode, view[0], view[1]),
        );
      }
    }
  });

  it('yields before indexing PCM and honours cancellation', async () => {
    const source = mono(new Float32Array(1_000_000), 8_000);
    const controller = new AbortController();
    const pending = prepareWaveformPeakIndexesCooperative(source, {
      signal: controller.signal,
      sliceMilliseconds: 1,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function peakDb(
  analysis: ReturnType<typeof computeSpectrogramAnalysis>,
  channelMode: AnalysisChannelMode,
): number {
  return poolSpectrogramDb(analysis, 1, 1, {
    timeStartSeconds: 0.25,
    timeEndSeconds: 0.75,
    lowFrequencyHz: 900,
    highFrequencyHz: 1_100,
    brightness: 1,
    palette: 'grayscale',
    channelMode,
  })[0];
}

function strongestCell(analysis: ReturnType<typeof computeSpectrogramAnalysis>) {
  let power = -1;
  let at = 0;
  analysis.channelPowers[0].forEach((value, index) => {
    if (value > power) {
      power = value;
      at = index;
    }
  });
  return {
    power,
    frame: Math.floor(at / analysis.binCount),
    bin: at % analysis.binCount,
  };
}

function deterministicAnalysis(): SpectrogramAnalysis {
  const frameCount = 37;
  const binCount = 129;
  let seed = 0x9e3779b9;
  const channelPowers = Array.from({ length: 2 }, () => {
    const values = new Float32Array(frameCount * binCount);
    for (let index = 0; index < values.length; index += 1) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      values[index] = (seed / 0xffffffff) ** 3;
    }
    return values;
  });
  return {
    sampleRateHz: 8_000,
    fftSize: 256,
    hopSamples: 64,
    frameCount,
    binCount,
    durationSeconds: (frameCount * 64) / 8_000,
    channelPowers,
  };
}

function poolSpectrogramDbNaive(
  analysis: SpectrogramAnalysis,
  width: number,
  height: number,
  options: SpectrogramRenderOptions,
): Float32Array {
  const output = new Float32Array(width * height);
  const start = Math.min(analysis.durationSeconds, Math.max(0, options.timeStartSeconds));
  const end = Math.min(analysis.durationSeconds, Math.max(start, options.timeEndSeconds));
  const low = Math.min(analysis.sampleRateHz / 2, Math.max(0, options.lowFrequencyHz));
  const high = Math.min(analysis.sampleRateHz / 2, Math.max(low, options.highFrequencyHz));
  const frameSeconds = analysis.hopSamples / analysis.sampleRateHz;
  const binHz = analysis.sampleRateHz / analysis.fftSize;
  for (let x = 0; x < width; x += 1) {
    const columnStart = start + (x / width) * (end - start);
    const columnEnd = start + ((x + 1) / width) * (end - start);
    let firstFrame = Math.floor(columnStart / frameSeconds);
    let lastFrame = Math.ceil(columnEnd / frameSeconds);
    if (lastFrame <= firstFrame) lastFrame = firstFrame + 1;
    firstFrame = clampTest(firstFrame, 0, analysis.frameCount - 1);
    lastFrame = clampTest(lastFrame, firstFrame + 1, analysis.frameCount);
    for (let y = 0; y < height; y += 1) {
      const upper = testFrequencyAtPixel(
        y,
        height,
        low,
        high,
        options.frequencyScale ?? 'linear',
        options.frequencyWarp,
      );
      const lower = testFrequencyAtPixel(
        y + 1,
        height,
        low,
        high,
        options.frequencyScale ?? 'linear',
        options.frequencyWarp,
      );
      let firstBin = Math.floor(lower / binHz);
      let lastBin = Math.ceil(upper / binHz);
      if (lastBin <= firstBin) lastBin = firstBin + 1;
      firstBin = clampTest(firstBin, 0, analysis.binCount - 1);
      lastBin = clampTest(lastBin, firstBin + 1, analysis.binCount);
      let peak = 0;
      for (let frame = firstFrame; frame < lastFrame; frame += 1) {
        for (let bin = firstBin; bin < lastBin; bin += 1) {
          const index = frame * analysis.binCount + bin;
          const left = analysis.channelPowers[0][index];
          const right = analysis.channelPowers[1][index];
          const power =
            options.channelMode === 'left'
              ? left
              : options.channelMode === 'right'
                ? right
                : options.channelMode === 'max'
                  ? Math.max(left, right)
                  : (left + right) / 2;
          peak = Math.max(peak, power);
        }
      }
      output[y * width + x] = powerToDb(peak);
    }
  }
  return output;
}

function testFrequencyAtPixel(
  edge: number,
  height: number,
  low: number,
  high: number,
  scale: FrequencyScale,
  warp = 0.5,
): number {
  const ratio = 1 - edge / height;
  if (scale === 'logarithmic' && low > 0) {
    return Math.exp(Math.log(low) + ratio * (Math.log(high) - Math.log(low)));
  }
  const adjustedRatio = scale === 'adjustable' ? ratio ** (1 / (1 - warp * 0.75)) : ratio;
  return low + adjustedRatio * (high - low);
}

function clampTest(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function waveformEnvelopeNaive(
  source: AudioAnalysisSource,
  width: number,
  mode: AnalysisChannelMode,
  timeStartSeconds: number,
  timeEndSeconds: number,
) {
  const minimum = new Float32Array(width);
  const maximum = new Float32Array(width);
  const start = clampTest(
    Math.floor(timeStartSeconds * source.sampleRateHz),
    0,
    source.channels[0].length - 1,
  );
  const end = clampTest(
    Math.ceil(timeEndSeconds * source.sampleRateHz),
    start + 1,
    source.channels[0].length,
  );
  for (let x = 0; x < width; x += 1) {
    const first = Math.floor(start + (x / width) * (end - start));
    const last = Math.min(
      source.channels[0].length,
      Math.max(first + 1, Math.ceil(start + ((x + 1) / width) * (end - start))),
    );
    const peaks = source.channels.map((samples) => {
      let peak = 0;
      for (let sample = first; sample < last; sample += 1) {
        peak = Math.max(peak, Math.abs(samples[sample]));
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

function mono(samples: Float32Array, sampleRateHz: number): AudioAnalysisSource {
  return { sampleRateHz, channelCount: 1, channels: [samples] };
}

function stereo(
  left: Float32Array,
  right: Float32Array,
  sampleRateHz: number,
): AudioAnalysisSource {
  return { sampleRateHz, channelCount: 2, channels: [left, right] };
}

function wavFixture(options: {
  sampleRateHz: number;
  channels: number[][];
  formatCode: 1 | 3;
  bitsPerSample: 8 | 16 | 24 | 32;
}): ArrayBuffer {
  const channelCount = options.channels.length;
  const frameCount = options.channels[0].length;
  const bytesPerSample = options.bitsPerSample / 8;
  const blockAlign = channelCount * bytesPerSample;
  const dataBytes = frameCount * blockAlign;
  const bytes = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(bytes);
  ascii(view, 0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(view, 8, 'WAVE');
  ascii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, options.formatCode, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, options.sampleRateHz, true);
  view.setUint32(28, options.sampleRateHz * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, options.bitsPerSample, true);
  ascii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      writeSample(
        view,
        44 + frame * blockAlign + channel * bytesPerSample,
        options.channels[channel][frame],
        options.formatCode,
        options.bitsPerSample,
      );
    }
  }
  return bytes;
}

function writeSample(
  view: DataView,
  offset: number,
  sample: number,
  formatCode: 1 | 3,
  bits: 8 | 16 | 24 | 32,
): void {
  if (formatCode === 3) {
    view.setFloat32(offset, sample, true);
    return;
  }
  if (bits === 8) view.setUint8(offset, Math.round((sample + 1) * 127.5));
  else if (bits === 16) view.setInt16(offset, Math.round(sample * 32767), true);
  else if (bits === 24) {
    const value = Math.round(sample * 8_388_607);
    view.setUint8(offset, value & 0xff);
    view.setUint8(offset + 1, (value >> 8) & 0xff);
    view.setUint8(offset + 2, (value >> 16) & 0xff);
  } else view.setInt32(offset, Math.round(sample * 2_147_483_647), true);
}

function ascii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
