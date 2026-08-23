import { describe, expect, it, vi } from 'vitest';
import { detectSourceSampleRateHz, loadAudioResource } from '../../src/audio/AudioResource';
import { computeSpectrogramPixels, overlapSamples } from '../../src/audio/spectrogram';

describe('source sample-rate detection', () => {
  it('reads the trusted rate from a PCM WAV header', () => {
    const bytes = new ArrayBuffer(46);
    const view = new DataView(bytes);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 38, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 96_000, true);
    view.setUint32(28, 192_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, 2, true);
    expect(detectSourceSampleRateHz(bytes, 'ultrasonic.wav')).toBe(96_000);
  });

  it('reads an MPEG-1 Layer III frame sample rate', () => {
    const bytes = Uint8Array.from([0xff, 0xfb, 0x90, 0x64]).buffer;
    expect(detectSourceSampleRateHz(bytes, 'call.mp3')).toBe(44_100);
  });

  it('loads SDK-embedded base64 audio without a CSP-governed fetch', async () => {
    const bytes = new Uint8Array(46);
    const view = new DataView(bytes.buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 38, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 8_000, true);
    view.setUint32(28, 16_000, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, 2, true);
    const binary = String.fromCharCode(...bytes);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const loaded = await loadAudioResource({
      url: `data:audio/wav;base64,${btoa(binary)}`,
      filename: 'embedded.wav',
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(loaded).toMatchObject({
      durationSeconds: 1 / 8_000,
      decodedSampleRateHz: 8_000,
      channelCount: 1,
      decoder: 'source-faithful-wav',
    });
    loaded.dispose();
    fetch.mockRestore();
  });

  it('yields before decoding embedded audio and honours cancellation', async () => {
    const controller = new AbortController();
    const pending = loadAudioResource(
      {
        // The payload need not be a valid WAV: cancellation must win before
        // container parsing or a maximum-size synchronous atob can begin.
        url: `data:audio/wav;base64,${'AAAA'.repeat(100_000)}`,
        filename: 'cancelled.wav',
      },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('decodes large embedded payloads through bounded atob chunks', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    await expect(
      loadAudioResource({
        url: `data:audio/wav;base64,${'AAAA'.repeat(100_000)}`,
        filename: 'chunked.wav',
      }),
    ).rejects.toThrow(/RIFF\/WAVE markers/);
    expect(decode.mock.calls.length).toBeGreaterThan(1);
    decode.mockRestore();
  });
});

describe('spectrogram overlap conversion', () => {
  it('converts percent to bounded sample counts for each supported FFT size', () => {
    for (const fft of [256, 512, 1024, 2048]) {
      expect(overlapSamples(fft, 0)).toBe(0);
      expect(overlapSamples(fft, 50)).toBe(fft / 2);
      expect(overlapSamples(fft, 100)).toBe(fft - 1);
    }
  });

  it('renders deterministically and leaves frequencies above decoded Nyquist blank', () => {
    const samples = Float32Array.from({ length: 1024 }, (_, index) =>
      Math.sin((2 * Math.PI * 1000 * index) / 8000),
    );
    const common = {
      timeStartSeconds: 0,
      timeEndSeconds: 0.1,
      fftSamples: 256,
      overlapPercent: 50,
      brightness: 1,
      palette: 'grayscale' as const,
    };
    const audible = computeSpectrogramPixels(samples, 8000, 8, 4, {
      ...common,
      lowFrequencyHz: 0,
      highFrequencyHz: 4000,
    });
    const ultrasonic = computeSpectrogramPixels(samples, 8000, 8, 4, {
      ...common,
      lowFrequencyHz: 4000,
      highFrequencyHz: 8000,
    });
    expect(audible).toEqual(
      computeSpectrogramPixels(samples, 8000, 8, 4, {
        ...common,
        lowFrequencyHz: 0,
        highFrequencyHz: 4000,
      }),
    );
    expect([...audible].some((value, index) => index % 4 !== 3 && value > 0)).toBe(true);
    expect([...ultrasonic].every((value, index) => index % 4 === 3 || value === 0)).toBe(true);
  });
});

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
