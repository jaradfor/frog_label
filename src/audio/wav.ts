import { ValidationError } from '../domain/errors';

export const AUDIO_LIMITS = Object.freeze({
  maximumFileBytes: 128 * 1024 * 1024,
  maximumDurationSeconds: 5 * 60,
  maximumChannels: 2,
  maximumSourceSampleRateHz: 192_000,
  // Enough for five minutes of stereo audio at 48 kHz, with a small margin.
  maximumDecodedChannelSamples: 30_000_000,
});

export interface WavHeader {
  encoding: 'pcm' | 'float32';
  formatCode: 1 | 3;
  channelCount: 1 | 2;
  sampleRateHz: number;
  bitsPerSample: 8 | 16 | 24 | 32;
  blockAlign: number;
  dataOffset: number;
  dataBytes: number;
  frameCount: number;
  durationSeconds: number;
}

export interface DecodedWav {
  header: WavHeader;
  channels: [Float32Array] | [Float32Array, Float32Array];
}

export function isPcmWav(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  const view = new DataView(bytes);
  return ascii(view, 0, 4) === 'RIFF' && ascii(view, 8, 4) === 'WAVE';
}

export function parseWavHeader(bytes: ArrayBuffer): WavHeader {
  if (bytes.byteLength > AUDIO_LIMITS.maximumFileBytes) {
    throw new ValidationError('Audio exceeds the 128 MiB file-size limit');
  }
  if (!isPcmWav(bytes)) throw new ValidationError('WAV header is missing RIFF/WAVE markers');
  const view = new DataView(bytes);
  const declaredEnd = Math.min(bytes.byteLength, view.getUint32(4, true) + 8);
  let format:
    | {
        formatCode: 1 | 3;
        channelCount: number;
        sampleRateHz: number;
        bitsPerSample: number;
        blockAlign: number;
      }
    | undefined;
  let dataOffset = -1;
  let dataBytes = -1;
  let offset = 12;
  while (offset + 8 <= declaredEnd) {
    const kind = ascii(view, offset, 4);
    const chunkBytes = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkBytes;
    if (chunkEnd > bytes.byteLength) {
      throw new ValidationError(`WAV ${kind.trim() || 'unknown'} chunk is truncated`);
    }
    if (kind === 'fmt ') {
      if (chunkBytes < 16) throw new ValidationError('WAV fmt chunk is truncated');
      let formatCode = view.getUint16(chunkStart, true);
      if (formatCode === 0xfffe && chunkBytes >= 40) {
        formatCode = view.getUint16(chunkStart + 24, true);
      }
      if (formatCode !== 1 && formatCode !== 3) {
        throw new ValidationError(`WAV encoding ${formatCode} is unsupported`);
      }
      format = {
        formatCode,
        channelCount: view.getUint16(chunkStart + 2, true),
        sampleRateHz: view.getUint32(chunkStart + 4, true),
        blockAlign: view.getUint16(chunkStart + 12, true),
        bitsPerSample: view.getUint16(chunkStart + 14, true),
      } as typeof format;
    } else if (kind === 'data' && dataOffset < 0) {
      dataOffset = chunkStart;
      dataBytes = chunkBytes;
    }
    offset = chunkEnd + (chunkBytes & 1);
  }
  if (!format) throw new ValidationError('WAV fmt chunk is missing');
  if (dataOffset < 0 || dataBytes <= 0) throw new ValidationError('WAV data chunk is missing');
  const { channelCount, sampleRateHz, bitsPerSample, blockAlign, formatCode } = format;
  if (channelCount < 1 || channelCount > AUDIO_LIMITS.maximumChannels) {
    throw new ValidationError(`Audio has ${channelCount} channels; the limit is 2`);
  }
  if (sampleRateHz <= 0 || sampleRateHz > AUDIO_LIMITS.maximumSourceSampleRateHz) {
    throw new ValidationError(`Audio sample rate is ${sampleRateHz} Hz; the limit is 192000 Hz`);
  }
  if (![8, 16, 24, 32].includes(bitsPerSample)) {
    throw new ValidationError(`WAV bit depth ${bitsPerSample} is unsupported`);
  }
  if (formatCode === 3 && bitsPerSample !== 32) {
    throw new ValidationError('Only IEEE float32 WAV is supported');
  }
  const expectedAlign = channelCount * (bitsPerSample / 8);
  if (blockAlign !== expectedAlign || dataBytes % blockAlign !== 0) {
    throw new ValidationError('WAV block alignment is invalid');
  }
  const frameCount = dataBytes / blockAlign;
  const durationSeconds = frameCount / sampleRateHz;
  if (durationSeconds > AUDIO_LIMITS.maximumDurationSeconds) {
    throw new ValidationError(
      `Decoded audio duration is ${durationSeconds.toFixed(3)} seconds; the limit is ${AUDIO_LIMITS.maximumDurationSeconds.toFixed(3)} seconds`,
    );
  }
  if (frameCount * channelCount > AUDIO_LIMITS.maximumDecodedChannelSamples) {
    throw new ValidationError(
      `Decoded audio contains ${frameCount * channelCount} channel-samples; the limit is ${AUDIO_LIMITS.maximumDecodedChannelSamples}`,
    );
  }
  return {
    encoding: formatCode === 3 ? 'float32' : 'pcm',
    formatCode,
    channelCount: channelCount as 1 | 2,
    sampleRateHz,
    bitsPerSample: bitsPerSample as 8 | 16 | 24 | 32,
    blockAlign,
    dataOffset,
    dataBytes,
    frameCount,
    durationSeconds,
  };
}

export function decodePcmWav(bytes: ArrayBuffer): DecodedWav {
  const header = parseWavHeader(bytes);
  const view = new DataView(bytes, header.dataOffset, header.dataBytes);
  const channels = Array.from(
    { length: header.channelCount },
    () => new Float32Array(header.frameCount),
  );
  const bytesPerSample = header.bitsPerSample / 8;
  for (let frame = 0; frame < header.frameCount; frame += 1) {
    for (let channel = 0; channel < header.channelCount; channel += 1) {
      const offset = frame * header.blockAlign + channel * bytesPerSample;
      channels[channel][frame] = readSample(view, offset, header);
    }
  }
  return {
    header,
    channels: channels as [Float32Array] | [Float32Array, Float32Array],
  };
}

function readSample(view: DataView, offset: number, header: WavHeader): number {
  if (header.formatCode === 3) {
    const value = view.getFloat32(offset, true);
    return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  }
  switch (header.bitsPerSample) {
    case 8:
      return (view.getUint8(offset) - 128) / 128;
    case 16:
      return view.getInt16(offset, true) / 32768;
    case 24: {
      let value =
        view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    case 32:
      return view.getInt32(offset, true) / 2147483648;
  }
}

function ascii(view: DataView, offset: number, length: number): string {
  if (offset < 0 || offset + length > view.byteLength) return '';
  return String.fromCharCode(
    ...Array.from({ length }, (_, index) => view.getUint8(offset + index)),
  );
}
