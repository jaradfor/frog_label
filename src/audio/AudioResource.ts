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

export type AudioFrequencyFilterMode = 'band-pass' | 'band-reject';

export interface AudioFrequencyFilter {
  mode: AudioFrequencyFilterMode;
  lowFrequencyHz: number;
  highFrequencyHz: number;
}

export interface AudioPlaybackRange {
  startTimeSeconds: number;
  endTimeSeconds: number;
  frequencyFilter?: AudioFrequencyFilter;
}

export interface AudioPlayback extends EventTarget {
  readonly paused: boolean;
  currentTime: number;
  playbackRate: number;
  playRange(range: AudioPlaybackRange): Promise<void>;
  play(): Promise<void>;
  pause(): void;
}

export function paddedAudioFrequencyWindow(
  lowFrequencyHz: number,
  highFrequencyHz: number,
  paddingHz: number,
  maximumFrequencyHz: number,
): Pick<AudioFrequencyFilter, 'lowFrequencyHz' | 'highFrequencyHz'> {
  if (
    !Number.isFinite(lowFrequencyHz) ||
    !Number.isFinite(highFrequencyHz) ||
    !Number.isFinite(paddingHz) ||
    !Number.isFinite(maximumFrequencyHz) ||
    lowFrequencyHz < 0 ||
    highFrequencyHz <= lowFrequencyHz ||
    paddingHz < 0 ||
    maximumFrequencyHz <= 0
  ) {
    throw new RangeError('Frequency-window values must be finite, ordered, and non-negative.');
  }
  const low = Math.min(maximumFrequencyHz, Math.max(0, lowFrequencyHz - paddingHz));
  const high = Math.min(maximumFrequencyHz, Math.max(0, highFrequencyHz + paddingHz));
  if (high <= low) throw new RangeError('The padded frequency window is empty.');
  return { lowFrequencyHz: low, highFrequencyHz: high };
}

export async function loadAudioResource(
  source: AudioSourceSnapshot,
  signal?: AbortSignal,
): Promise<LoadedAudio> {
  const bytes = source.url.startsWith('data:')
    ? await decodeBase64DataUrl(source.url, signal)
    : await downloadAudioBytes(source.url, signal);
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

async function downloadAudioBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, {
    credentials: sameOrigin(url) ? 'same-origin' : 'omit',
    signal,
  });
  if (!response.ok) throw audioResponseError(response.status);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > AUDIO_LIMITS.maximumFileBytes) {
    throw new ValidationError('Audio exceeds the 128 MiB file-size limit');
  }
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Audio load was cancelled', 'AbortError');
    throw new IntegrationError('AUDIO_DOWNLOAD_FAILED', 'Audio bytes could not be read.', {
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}

const BASE64_DECODE_CHUNK_CHARACTERS = 256 * 1024;

async function decodeBase64DataUrl(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) throw new DOMException('Audio load was cancelled', 'AbortError');
  const comma = url.indexOf(',');
  if (comma < 5 || !/;base64$/iu.test(url.slice(5, comma))) {
    throw new ValidationError('Embedded audio must use a base64 data URL');
  }
  const payloadStart = comma + 1;
  const encodedLength = url.length - payloadStart;
  const maximumEncodedBytes = Math.ceil((AUDIO_LIMITS.maximumFileBytes * 4) / 3) + 4;
  if (encodedLength > maximumEncodedBytes) {
    throw new ValidationError('Audio exceeds the 128 MiB file-size limit');
  }

  // Validate and size the payload cooperatively first. This preserves atob's
  // tolerance for ASCII whitespace without constructing one maximum-size
  // binary string on the UI thread.
  await yieldAudioDecode();
  let compactLength = 0;
  let paddingCount = 0;
  let paddingStarted = false;
  for (let start = 0; start < encodedLength; start += BASE64_DECODE_CHUNK_CHARACTERS) {
    throwIfAudioLoadAborted(signal);
    const raw = url.slice(
      payloadStart + start,
      payloadStart + Math.min(encodedLength, start + BASE64_DECODE_CHUNK_CHARACTERS),
    );
    const compact = raw.replace(/[\t\n\f\r ]/gu, '');
    if (/[^A-Za-z0-9+/=]/u.test(compact)) {
      throw new ValidationError('Embedded audio data is not valid base64');
    }
    for (const character of compact) {
      if (character === '=') {
        paddingStarted = true;
        paddingCount += 1;
      } else if (paddingStarted) {
        throw new ValidationError('Embedded audio data is not valid base64');
      }
    }
    if (paddingCount > 2) {
      throw new ValidationError('Embedded audio data is not valid base64');
    }
    compactLength += compact.length;
    await yieldAudioDecode();
  }

  const decodedLength = Math.floor((compactLength * 3) / 4) - paddingCount;
  if (decodedLength < 0 || decodedLength > AUDIO_LIMITS.maximumFileBytes) {
    throw new ValidationError('Audio exceeds the 128 MiB file-size limit');
  }
  const bytes = new Uint8Array(new ArrayBuffer(decodedLength));
  let written = 0;
  let carry = '';
  try {
    for (let start = 0; start < encodedLength; start += BASE64_DECODE_CHUNK_CHARACTERS) {
      throwIfAudioLoadAborted(signal);
      const end = Math.min(encodedLength, start + BASE64_DECODE_CHUNK_CHARACTERS);
      const compact =
        carry + url.slice(payloadStart + start, payloadStart + end).replace(/[\t\n\f\r ]/gu, '');
      const decodeLength =
        end === encodedLength ? compact.length : compact.length - (compact.length % 4);
      const encodedChunk = compact.slice(0, decodeLength);
      carry = compact.slice(decodeLength);
      if (encodedChunk) {
        const binary = atob(encodedChunk);
        if (written + binary.length > bytes.length) {
          throw new ValidationError('Embedded audio data is not valid base64');
        }
        for (let index = 0; index < binary.length; index += 1) {
          bytes[written + index] = binary.charCodeAt(index);
        }
        written += binary.length;
      }
      await yieldAudioDecode();
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
      throw new DOMException('Audio load was cancelled', 'AbortError');
    }
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('Embedded audio data is not valid base64');
  }
  throwIfAudioLoadAborted(signal);
  if (carry || written !== decodedLength) {
    throw new ValidationError('Embedded audio data is not valid base64');
  }
  return bytes.buffer;
}

function throwIfAudioLoadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Audio load was cancelled', 'AbortError');
}

function yieldAudioDecode(): Promise<void> {
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
  private filterNodes: AudioNode[] = [];
  private outputGain: GainNode | null = null;
  private frequencyFilter: AudioFrequencyFilter | null = null;
  private rangeStartSeconds: number | null = null;
  private rangeEndSeconds: number | null = null;
  private ticker: ReturnType<typeof globalThis.setInterval> | null = null;
  private positionSeconds = 0;
  private sourcePositionSeconds = 0;
  private sourceStartedAt = 0;
  private rate = 1;
  private playing = false;
  private disposed = false;
  private operationGeneration = 0;

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
      this.rangeEndSeconds ?? this.durationSeconds,
    );
  }

  set currentTime(value: number) {
    const rangeMinimum = this.rangeStartSeconds ?? 0;
    const rangeMaximum = this.rangeEndSeconds ?? this.durationSeconds;
    const next = Math.min(
      rangeMaximum,
      Math.max(rangeMinimum, clampTime(value, this.durationSeconds)),
    );
    this.positionSeconds = next;
    this.sourcePositionSeconds = next;
    if (this.playing && this.context) {
      if (next >= rangeMaximum) {
        this.operationGeneration += 1;
        this.playing = false;
        this.stopSource();
        this.stopTicker();
        this.cancelRange();
        this.dispatchEvent(new Event('timeupdate'));
        this.dispatchEvent(new Event('pause'));
        this.dispatchEvent(new Event('ended'));
        return;
      }
      this.stopSource();
      this.sourceStartedAt = this.context.currentTime;
      try {
        this.startSource();
      } catch (error) {
        this.playing = false;
        this.stopSource(true);
        this.stopTicker();
        this.cancelRange();
        this.dispatchEvent(new Event('pause'));
        throw error;
      }
    }
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('Playback rate must be a positive finite number.');
    }
    if (value === this.rate) return;
    const restart = this.playing && this.context;
    if (restart && this.context) {
      this.positionSeconds = this.currentTime;
      this.sourcePositionSeconds = this.positionSeconds;
      this.sourceStartedAt = this.context.currentTime;
    }
    this.rate = value;
    if (restart) {
      this.stopSource();
      try {
        this.startSource();
      } catch (error) {
        this.playing = false;
        this.stopSource(true);
        this.stopTicker();
        this.cancelRange();
        this.dispatchEvent(new Event('pause'));
        throw error;
      }
    }
  }

  async playRange(range: AudioPlaybackRange): Promise<void> {
    const normalized = normalizeAudioPlaybackRange(
      range,
      this.durationSeconds,
      this.analysis.sampleRateHz / 2,
    );
    this.pause();
    this.positionSeconds = normalized.startTimeSeconds;
    this.sourcePositionSeconds = normalized.startTimeSeconds;
    this.rangeStartSeconds = normalized.startTimeSeconds;
    this.rangeEndSeconds = normalized.endTimeSeconds;
    this.frequencyFilter = normalized.frequencyFilter ?? null;
    const operation = ++this.operationGeneration;
    try {
      await this.startPlayback(operation);
    } catch (error) {
      if (operation === this.operationGeneration) this.cancelRange();
      throw error;
    }
  }

  async play(): Promise<void> {
    if (this.playing) return;
    this.cancelRange();
    if (this.positionSeconds >= this.durationSeconds) this.positionSeconds = 0;
    const operation = ++this.operationGeneration;
    await this.startPlayback(operation);
  }

  private async startPlayback(operation: number): Promise<void> {
    if (this.disposed) throw new DOMException('Audio playback was disposed.', 'InvalidStateError');
    this.ensureAudioGraph();
    if (!this.context) throw new Error('Web Audio is unavailable.');
    await this.context.resume();
    if (this.disposed || operation !== this.operationGeneration) {
      throw new DOMException('Audio playback was superseded.', 'AbortError');
    }
    this.sourcePositionSeconds = this.positionSeconds;
    this.sourceStartedAt = this.context.currentTime;
    this.playing = true;
    try {
      this.startSource();
    } catch (error) {
      this.playing = false;
      this.stopSource(true);
      this.stopTicker();
      throw error;
    }
    this.stopTicker();
    this.ticker = globalThis.setInterval(() => {
      this.dispatchEvent(new Event('timeupdate'));
    }, 25);
    this.dispatchEvent(new Event('play'));
  }

  pause(): void {
    this.operationGeneration += 1;
    const wasPlaying = this.playing;
    if (wasPlaying) {
      this.positionSeconds = this.currentTime;
      this.sourcePositionSeconds = this.positionSeconds;
    }
    this.playing = false;
    this.stopSource();
    this.stopTicker();
    this.cancelRange();
    if (!wasPlaying) return;
    this.dispatchEvent(new Event('timeupdate'));
    this.dispatchEvent(new Event('pause'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.operationGeneration += 1;
    this.playing = false;
    this.stopSource(true);
    this.stopTicker();
    this.cancelRange();
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
    const endSeconds = this.rangeEndSeconds ?? this.durationSeconds;
    const sourceDurationSeconds = endSeconds - this.sourcePositionSeconds;
    if (sourceDurationSeconds <= 0) {
      throw new RangeError('Playback range has already ended.');
    }
    const source = this.context.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.playbackRate;
    const when = this.context.currentTime;
    this.connectPlaybackGraph(source, sourceDurationSeconds, when);
    source.onended = () => {
      if (source !== this.sourceNode || !this.playing) return;
      const completedPosition = this.rangeEndSeconds ?? this.durationSeconds;
      this.operationGeneration += 1;
      this.sourceNode = null;
      source.onended = null;
      source.disconnect();
      this.disconnectFilterGraph();
      this.positionSeconds = completedPosition;
      this.sourcePositionSeconds = this.positionSeconds;
      this.playing = false;
      this.stopTicker();
      this.cancelRange();
      this.dispatchEvent(new Event('timeupdate'));
      this.dispatchEvent(new Event('pause'));
      this.dispatchEvent(new Event('ended'));
    };
    this.sourceNode = source;
    source.start(when, this.sourcePositionSeconds, sourceDurationSeconds);
  }

  private connectPlaybackGraph(
    source: AudioBufferSourceNode,
    sourceDurationSeconds: number,
    when: number,
  ): void {
    if (!this.context) return;
    this.disconnectFilterGraph();
    const output = this.context.createGain();
    const wallDurationSeconds = sourceDurationSeconds / this.playbackRate;
    const fadeSeconds = Math.min(AUDIO_EDGE_FADE_SECONDS, wallDurationSeconds / 2);
    output.gain.setValueAtTime(0, when);
    output.gain.linearRampToValueAtTime(1, when + fadeSeconds);
    if (wallDurationSeconds > fadeSeconds * 2) {
      output.gain.setValueAtTime(1, when + wallDurationSeconds - fadeSeconds);
    }
    output.gain.linearRampToValueAtTime(0, when + wallDurationSeconds);
    output.connect(this.context.destination);
    this.outputGain = output;
    this.filterNodes.push(output);

    const sourceNyquistHz = this.analysis.sampleRateHz / 2;
    const outputNyquistHz = this.context.sampleRate / 2;
    const playableSourceMaximumHz = Math.min(sourceNyquistHz, outputNyquistHz / this.playbackRate);
    const filter = this.frequencyFilter
      ? normalizeAudioFrequencyFilter(this.frequencyFilter, sourceNyquistHz)
      : null;
    if (!filter) {
      source.connect(output);
      return;
    }

    if (filter.mode === 'band-pass') {
      if (filter.lowFrequencyHz >= playableSourceMaximumHz) {
        this.connectMutedBranch(source, output);
        return;
      }
      const highFrequencyHz = Math.min(filter.highFrequencyHz, playableSourceMaximumHz);
      const specifications: Array<{
        type: BiquadFilterType;
        frequencyHz: number;
      }> = [];
      if (filter.lowFrequencyHz > 0) {
        specifications.push({ type: 'highpass', frequencyHz: filter.lowFrequencyHz });
      }
      if (highFrequencyHz < playableSourceMaximumHz) {
        specifications.push({ type: 'lowpass', frequencyHz: highFrequencyHz });
      }
      this.connectFilterBranch(source, specifications, output, outputNyquistHz);
      return;
    }

    if (filter.lowFrequencyHz >= playableSourceMaximumHz) {
      source.connect(output);
      return;
    }
    const hasLowBranch = filter.lowFrequencyHz > 0;
    const hasHighBranch = filter.highFrequencyHz < playableSourceMaximumHz;
    if (!hasLowBranch && !hasHighBranch) {
      this.connectMutedBranch(source, output);
      return;
    }
    if (hasLowBranch) {
      this.connectFilterBranch(
        source,
        [{ type: 'lowpass', frequencyHz: filter.lowFrequencyHz }],
        output,
        outputNyquistHz,
      );
    }
    if (hasHighBranch) {
      this.connectFilterBranch(
        source,
        [{ type: 'highpass', frequencyHz: filter.highFrequencyHz }],
        output,
        outputNyquistHz,
      );
    }
  }

  private connectFilterBranch(
    source: AudioNode,
    specifications: readonly { type: BiquadFilterType; frequencyHz: number }[],
    destination: AudioNode,
    outputNyquistHz: number,
  ): void {
    if (!this.context) return;
    let tail = source;
    for (const specification of specifications) {
      for (let section = 0; section < FILTER_SECTIONS_PER_EDGE; section += 1) {
        const filter = this.context.createBiquadFilter();
        filter.type = specification.type;
        filter.frequency.value = Math.min(
          outputNyquistHz,
          specification.frequencyHz * this.playbackRate,
        );
        // Web Audio defines low/high-pass Q in decibels. -3.01 dB is the
        // 1/sqrt(2) Butterworth value; two sections make a 24 dB/oct edge.
        filter.Q.value = WEB_AUDIO_BUTTERWORTH_Q_DB;
        tail.connect(filter);
        tail = filter;
        this.filterNodes.push(filter);
      }
    }
    tail.connect(destination);
  }

  private connectMutedBranch(source: AudioNode, destination: AudioNode): void {
    if (!this.context) return;
    const mute = this.context.createGain();
    mute.gain.value = 0;
    source.connect(mute);
    mute.connect(destination);
    this.filterNodes.push(mute);
  }

  private stopSource(immediate = false): void {
    const source = this.sourceNode;
    this.sourceNode = null;
    if (!source) return;
    source.onended = null;
    const nodes = this.filterNodes.splice(0);
    const output = this.outputGain;
    this.outputGain = null;
    const context = this.context;
    const disconnect = () => {
      try {
        source.disconnect();
      } catch {
        // A source that ended during the edge fade may already be disconnected.
      }
      disconnectAudioNodes(nodes);
    };
    try {
      if (!immediate && context && output) {
        const now = context.currentTime;
        output.gain.cancelScheduledValues(now);
        output.gain.setTargetAtTime(0, now, AUDIO_EDGE_FADE_SECONDS / 3);
        source.stop(now + AUDIO_EDGE_FADE_SECONDS);
        globalThis.setTimeout(disconnect, AUDIO_EDGE_FADE_SECONDS * 2000);
        return;
      }
      source.stop();
    } catch {
      // A source that ended between scheduler ticks is already stopped.
    }
    disconnect();
  }

  private disconnectFilterGraph(): void {
    this.outputGain = null;
    disconnectAudioNodes(this.filterNodes.splice(0));
  }

  private cancelRange(): void {
    this.rangeStartSeconds = null;
    this.rangeEndSeconds = null;
    this.frequencyFilter = null;
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    globalThis.clearInterval(this.ticker);
    this.ticker = null;
  }
}

const FILTER_SECTIONS_PER_EDGE = 2;
const WEB_AUDIO_BUTTERWORTH_Q_DB = -3.010299956639812;
const AUDIO_EDGE_FADE_SECONDS = 0.004;

function disconnectAudioNodes(nodes: readonly AudioNode[]): void {
  for (const node of nodes) {
    try {
      node.disconnect();
    } catch {
      // The browser may already have disconnected nodes from an ended source.
    }
  }
}

export function normalizeAudioFrequencyFilter(
  filter: AudioFrequencyFilter,
  maximumFrequencyHz: number,
): AudioFrequencyFilter {
  if (
    (filter.mode !== 'band-pass' && filter.mode !== 'band-reject') ||
    !Number.isFinite(filter.lowFrequencyHz) ||
    !Number.isFinite(filter.highFrequencyHz) ||
    !Number.isFinite(maximumFrequencyHz) ||
    maximumFrequencyHz <= 0 ||
    filter.lowFrequencyHz < 0 ||
    filter.highFrequencyHz <= filter.lowFrequencyHz
  ) {
    throw new RangeError('Audio filter frequencies must be finite and strictly ordered.');
  }
  const lowFrequencyHz = Math.min(maximumFrequencyHz, filter.lowFrequencyHz);
  const highFrequencyHz = Math.min(maximumFrequencyHz, filter.highFrequencyHz);
  if (highFrequencyHz <= lowFrequencyHz) {
    throw new RangeError('Audio filter is outside the playable frequency range.');
  }
  return { mode: filter.mode, lowFrequencyHz, highFrequencyHz };
}

export function normalizeAudioPlaybackRange(
  range: AudioPlaybackRange,
  durationSeconds: number,
  maximumFrequencyHz: number,
): AudioPlaybackRange {
  const endToleranceSeconds =
    Number.isFinite(maximumFrequencyHz) && maximumFrequencyHz > 0
      ? 1 / (maximumFrequencyHz * 2)
      : 0;
  if (
    !Number.isFinite(range.startTimeSeconds) ||
    !Number.isFinite(range.endTimeSeconds) ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    range.startTimeSeconds < 0 ||
    range.endTimeSeconds <= range.startTimeSeconds ||
    range.endTimeSeconds > durationSeconds + endToleranceSeconds
  ) {
    throw new RangeError('Audio playback range must be inside the decoded recording.');
  }
  const endTimeSeconds = Math.min(range.endTimeSeconds, durationSeconds);
  if (endTimeSeconds <= range.startTimeSeconds) {
    throw new RangeError('Audio playback range must contain at least one decoded sample.');
  }
  return {
    startTimeSeconds: range.startTimeSeconds,
    endTimeSeconds,
    ...(range.frequencyFilter
      ? {
          frequencyFilter: normalizeAudioFrequencyFilter(range.frequencyFilter, maximumFrequencyHz),
        }
      : {}),
  };
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
