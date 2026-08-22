import type { AudioSourceSnapshot } from '../ports/AudioSourcePort';
import type { AudioAnalysisSource } from '../domain/types';
import { IntegrationError, ValidationError } from '../domain/errors';
import { AUDIO_LIMITS, decodePcmWav, isPcmWav, parseWavHeader } from './wav';

export interface LoadedAudio {
  source: AudioSourceSnapshot;
  analysis: AudioAnalysisSource;
  /** HTML-media-compatible playback surface backed by the decoded PCM. */
  element: AudioPlayback;
  durationSeconds: number;
  decodedSampleRateHz: number;
  sourceSampleRateHz: number;
  maximumFrequencyHz: number;
  channelCount: 1 | 2;
  decoder: 'source-faithful-wav' | 'browser-decoded';
  dispose(): void;
}

export interface AudioPlayback extends EventTarget {
  readonly paused: boolean;
  currentTime: number;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
}

export async function loadAudioResource(
  source: AudioSourceSnapshot,
  signal?: AbortSignal,
): Promise<LoadedAudio> {
  const response = await fetch(source.url, {
    credentials: sameOrigin(source.url) ? 'same-origin' : 'omit',
    signal,
  });
  if (!response.ok) throw audioResponseError(response.status);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > AUDIO_LIMITS.maximumFileBytes) {
    throw new ValidationError('Audio exceeds the 128 MiB file-size limit');
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Audio load was cancelled', 'AbortError');
    throw new IntegrationError('AUDIO_DOWNLOAD_FAILED', 'Audio bytes could not be read.', {
      detail: error instanceof Error ? error.message : undefined,
    });
  }
  if (bytes.byteLength > AUDIO_LIMITS.maximumFileBytes) {
    throw new ValidationError('Audio exceeds the 128 MiB file-size limit');
  }
  if (signal?.aborted) throw new DOMException('Audio load was cancelled', 'AbortError');

  let analysis: AudioAnalysisSource;
  let durationSeconds: number;
  let decodedSampleRateHz: number;
  let sourceSampleRateHz: number;
  let decoder: LoadedAudio['decoder'];
  if (isPcmWav(bytes) || /\.wav$/iu.test(source.filename)) {
    // Preflight the container before allocating source-faithful PCM arrays.
    parseWavHeader(bytes);
    const wav = decodePcmWav(bytes);
    analysis = {
      sampleRateHz: wav.header.sampleRateHz,
      channels: wav.channels,
      channelCount: wav.header.channelCount,
    };
    durationSeconds = wav.header.durationSeconds;
    decodedSampleRateHz = wav.header.sampleRateHz;
    sourceSampleRateHz = wav.header.sampleRateHz;
    decoder = 'source-faithful-wav';
  } else {
    const context = new AudioContext();
    let buffer: AudioBuffer;
    try {
      buffer = await context.decodeAudioData(bytes.slice(0));
    } catch {
      await context.close();
      throw new ValidationError('MP3 is malformed or unsupported by this browser');
    }
    await context.close();
    if (signal?.aborted) throw new DOMException('Audio load was cancelled', 'AbortError');
    validateDecodedDimensions(buffer.length, buffer.numberOfChannels, buffer.sampleRate);
    analysis = {
      sampleRateHz: buffer.sampleRate,
      channelCount: buffer.numberOfChannels as 1 | 2,
      channels: Array.from({ length: buffer.numberOfChannels }, (_, index) =>
        buffer.getChannelData(index).slice(),
      ),
    };
    durationSeconds = buffer.length / buffer.sampleRate;
    decodedSampleRateHz = buffer.sampleRate;
    sourceSampleRateHz = detectSourceSampleRateHz(bytes, source.filename) ?? buffer.sampleRate;
    decoder = 'browser-decoded';
  }
  validateDecodedDimensions(
    analysis.channels[0].length,
    analysis.channelCount,
    analysis.sampleRateHz,
  );

  const element = new DecodedAudioPlayback(analysis);
  let disposed = false;
  return {
    source: structuredClone(source),
    analysis,
    element,
    durationSeconds,
    decodedSampleRateHz,
    sourceSampleRateHz,
    maximumFrequencyHz: analysis.sampleRateHz / 2,
    channelCount: analysis.channelCount,
    decoder,
    dispose() {
      if (disposed) return;
      disposed = true;
      element.dispose();
    },
  };
}

/**
 * Plays the already-decoded, source-faithful PCM without issuing a second
 * media request. The public surface intentionally mirrors only the HTML media
 * operations the workspace needs.
 */
class DecodedAudioPlayback extends EventTarget implements AudioPlayback {
  private readonly durationSeconds: number;
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private ticker: ReturnType<typeof globalThis.setInterval> | null = null;
  private positionSeconds = 0;
  private sourcePositionSeconds = 0;
  private sourceStartedAt = 0;
  private rate = 1;
  private playing = false;
  private disposed = false;

  constructor(private readonly analysis: AudioAnalysisSource) {
    super();
    this.durationSeconds = analysis.channels[0].length / analysis.sampleRateHz;
  }

  get paused(): boolean {
    return !this.playing;
  }

  get currentTime(): number {
    if (!this.playing || !this.context) return this.positionSeconds;
    return clampTime(
      this.sourcePositionSeconds +
        (this.context.currentTime - this.sourceStartedAt) * this.playbackRate,
      this.durationSeconds,
    );
  }

  set currentTime(value: number) {
    const next = clampTime(value, this.durationSeconds);
    this.positionSeconds = next;
    this.sourcePositionSeconds = next;
    if (this.playing && this.context) {
      this.stopSource();
      this.sourceStartedAt = this.context.currentTime;
      this.startSource();
    }
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('Playback rate must be a positive finite number.');
    }
    if (this.playing && this.context) {
      this.positionSeconds = this.currentTime;
      this.sourcePositionSeconds = this.positionSeconds;
      this.sourceStartedAt = this.context.currentTime;
      if (this.sourceNode) this.sourceNode.playbackRate.value = value;
    }
    this.rate = value;
  }

  async play(): Promise<void> {
    if (this.disposed) throw new DOMException('Audio playback was disposed.', 'InvalidStateError');
    if (this.playing) return;
    this.ensureAudioGraph();
    if (!this.context) throw new Error('Web Audio is unavailable.');
    await this.context.resume();
    if (this.disposed) throw new DOMException('Audio playback was disposed.', 'AbortError');
    if (this.positionSeconds >= this.durationSeconds) this.positionSeconds = 0;
    this.sourcePositionSeconds = this.positionSeconds;
    this.sourceStartedAt = this.context.currentTime;
    this.playing = true;
    this.startSource();
    this.ticker = globalThis.setInterval(() => {
      this.dispatchEvent(new Event('timeupdate'));
    }, 25);
    this.dispatchEvent(new Event('play'));
  }

  pause(): void {
    if (!this.playing) return;
    this.positionSeconds = this.currentTime;
    this.sourcePositionSeconds = this.positionSeconds;
    this.playing = false;
    this.stopSource();
    this.stopTicker();
    this.dispatchEvent(new Event('timeupdate'));
    this.dispatchEvent(new Event('pause'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    this.stopSource();
    this.stopTicker();
    const context = this.context;
    this.context = null;
    this.buffer = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
  }

  private ensureAudioGraph(): void {
    if (this.context && this.buffer) return;
    const context = new AudioContext();
    const buffer = context.createBuffer(
      this.analysis.channelCount,
      this.analysis.channels[0].length,
      this.analysis.sampleRateHz,
    );
    this.analysis.channels.forEach((channel, index) => buffer.getChannelData(index).set(channel));
    this.context = context;
    this.buffer = buffer;
  }

  private startSource(): void {
    if (!this.context || !this.buffer || !this.playing) return;
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;
    source.connect(this.context.destination);
    source.addEventListener(
      'ended',
      () => {
        if (source !== this.sourceNode || !this.playing) return;
        this.sourceNode = null;
        this.positionSeconds = this.durationSeconds;
        this.sourcePositionSeconds = this.positionSeconds;
        this.playing = false;
        this.stopTicker();
        this.dispatchEvent(new Event('timeupdate'));
        this.dispatchEvent(new Event('pause'));
        this.dispatchEvent(new Event('ended'));
      },
      { once: true },
    );
    this.sourceNode = source;
    source.start(0, this.sourcePositionSeconds);
  }

  private stopSource(): void {
    const source = this.sourceNode;
    this.sourceNode = null;
    if (!source) return;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // A source that ended between scheduler ticks is already stopped.
    }
    source.disconnect();
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    globalThis.clearInterval(this.ticker);
    this.ticker = null;
  }
}

function clampTime(value: number, durationSeconds: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(durationSeconds, Math.max(0, value));
}

function validateDecodedDimensions(
  frameCount: number,
  channelCount: number,
  sampleRateHz: number,
): void {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0 || sampleRateHz > 192_000) {
    throw new ValidationError(`Decoded sample rate is ${sampleRateHz} Hz; the limit is 192000 Hz`);
  }
  if (channelCount < 1 || channelCount > AUDIO_LIMITS.maximumChannels) {
    throw new ValidationError(`Audio has ${channelCount} channels; the limit is 2`);
  }
  const durationSeconds = frameCount / sampleRateHz;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new ValidationError('Decoded audio has no playable samples');
  }
  if (durationSeconds > AUDIO_LIMITS.maximumDurationSeconds) {
    throw new ValidationError(
      `Decoded audio duration is ${durationSeconds.toFixed(3)} seconds; the limit is ${AUDIO_LIMITS.maximumDurationSeconds.toFixed(3)} seconds`,
    );
  }
  const channelSamples = frameCount * channelCount;
  if (channelSamples > AUDIO_LIMITS.maximumDecodedChannelSamples) {
    throw new ValidationError(
      `Decoded audio contains ${channelSamples} channel-samples; the limit is ${AUDIO_LIMITS.maximumDecodedChannelSamples}`,
    );
  }
}

function audioResponseError(status: number): IntegrationError {
  if (status === 401 || status === 403) {
    return new IntegrationError(
      'AUDIO_PERMISSION_DENIED',
      `Audio access was denied (${status}). Sign in or request task-media permission.`,
    );
  }
  if (status === 404) {
    return new IntegrationError('AUDIO_NOT_FOUND', 'Audio was not found (404).');
  }
  return new IntegrationError('AUDIO_FETCH_FAILED', `Audio could not be loaded (${status}).`);
}

export function detectSourceSampleRateHz(bytes: ArrayBuffer, filename = ''): number | null {
  const view = new DataView(bytes);
  if (view.byteLength >= 28 && ascii(view, 0, 4) === 'RIFF' && ascii(view, 8, 4) === 'WAVE') {
    try {
      return parseWavHeader(bytes).sampleRateHz;
    } catch {
      return null;
    }
  }
  if (/\.mp3$/iu.test(filename) || ascii(view, 0, 3) === 'ID3') {
    let offset = 0;
    if (view.byteLength >= 10 && ascii(view, 0, 3) === 'ID3') {
      const size =
        ((view.getUint8(6) & 0x7f) << 21) |
        ((view.getUint8(7) & 0x7f) << 14) |
        ((view.getUint8(8) & 0x7f) << 7) |
        (view.getUint8(9) & 0x7f);
      offset = 10 + size;
    }
    const limit = Math.min(view.byteLength - 3, offset + 64 * 1024);
    for (; offset < limit; offset += 1) {
      const first = view.getUint8(offset);
      const second = view.getUint8(offset + 1);
      const third = view.getUint8(offset + 2);
      if (first !== 0xff || (second & 0xe0) !== 0xe0) continue;
      const version = (second >> 3) & 0x03;
      const layer = (second >> 1) & 0x03;
      const rateIndex = (third >> 2) & 0x03;
      if (version === 1 || layer === 0 || rateIndex === 3) continue;
      const rates =
        version === 3
          ? [44_100, 48_000, 32_000]
          : version === 2
            ? [22_050, 24_000, 16_000]
            : [11_025, 12_000, 8_000];
      return rates[rateIndex];
    }
  }
  return null;
}

function ascii(view: DataView, offset: number, length: number): string {
  if (offset < 0 || offset + length > view.byteLength) return '';
  return String.fromCharCode(
    ...Array.from({ length }, (_, index) => view.getUint8(offset + index)),
  );
}

function sameOrigin(url: string): boolean {
  return new URL(url, window.location.href).origin === window.location.origin;
}
