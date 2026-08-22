import { describe, expect, it } from 'vitest';
import {
  analysisFftSize,
  computeSpectrogramAnalysis,
  computeSpectrogramAnalysisCooperative,
  computeWaveformEnvelope,
  poolSpectrogramDb,
  SPECTROGRAM_DB_FLOOR,
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
