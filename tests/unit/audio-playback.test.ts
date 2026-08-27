import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadAudioResource,
  normalizeAudioFrequencyFilter,
  normalizeAudioPlaybackRange,
  paddedAudioFrequencyWindow,
} from '../../src/audio/AudioResource';

afterEach(() => {
  vi.unstubAllGlobals();
  FakeAudioContext.instances.length = 0;
  FakeAudioContext.resumeGate = null;
});

describe('audio playback ranges', () => {
  it('normalizes padded bands at source boundaries and rejects invalid input', () => {
    expect(paddedAudioFrequencyWindow(500, 2_500, 250, 4_000)).toEqual({
      lowFrequencyHz: 250,
      highFrequencyHz: 2_750,
    });
    expect(paddedAudioFrequencyWindow(100, 3_900, 250, 4_000)).toEqual({
      lowFrequencyHz: 0,
      highFrequencyHz: 4_000,
    });
    expect(() => paddedAudioFrequencyWindow(500, 500, 0, 4_000)).toThrow(RangeError);
  });

  it('schedules the exact decoded interval and a click-suppressing edge envelope', async () => {
    const loaded = await loadTestAudio();
    await loaded.element.playRange({ startTimeSeconds: 0.25, endTimeSeconds: 0.75 });

    const context = latestContext();
    expect(context.buffers[0].channelCount).toBe(2);
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].starts).toEqual([[10, 0.25, 0.5]]);
    expect(context.gains[0].gain.events).toEqual([
      ['set', 0, 10],
      ['linear', 1, 10.004],
      ['set', 1, 10.496],
      ['linear', 0, 10.5],
    ]);

    loaded.dispose();
  });

  it('builds a fourth-order two-edge band-pass and scales source cutoffs with rate', async () => {
    const loaded = await loadTestAudio();
    await loaded.element.playRange({
      startTimeSeconds: 0.1,
      endTimeSeconds: 0.9,
      frequencyFilter: {
        mode: 'band-pass',
        lowFrequencyHz: 1_000,
        highFrequencyHz: 2_000,
      },
    });

    const context = latestContext();
    expect(context.filters.map((filter) => filter.type)).toEqual([
      'highpass',
      'highpass',
      'lowpass',
      'lowpass',
    ]);
    expect(context.filters.map((filter) => filter.frequency.value)).toEqual([
      1_000, 1_000, 2_000, 2_000,
    ]);
    expect(context.filters.map((filter) => filter.Q.value)).toEqual([
      -3.010299956639812, -3.010299956639812, -3.010299956639812, -3.010299956639812,
    ]);

    loaded.element.playbackRate = 0.5;
    expect(context.sources).toHaveLength(2);
    expect(context.filters.slice(-4).map((filter) => filter.frequency.value)).toEqual([
      500, 500, 1_000, 1_000,
    ]);
    expect(context.sources[0].stops).toEqual([[10.004]]);

    loaded.dispose();
  });

  it('builds negative playback as parallel low and high branches around the exact box band', async () => {
    const loaded = await loadTestAudio();
    await loaded.element.playRange({
      startTimeSeconds: 0.25,
      endTimeSeconds: 0.75,
      frequencyFilter: {
        mode: 'band-reject',
        lowFrequencyHz: 1_000,
        highFrequencyHz: 2_000,
      },
    });

    const context = latestContext();
    expect(context.filters.map((filter) => filter.type)).toEqual([
      'lowpass',
      'lowpass',
      'highpass',
      'highpass',
    ]);
    expect(context.sources[0].connections).toEqual([context.filters[0], context.filters[2]]);

    loaded.dispose();
  });

  it('allows only the newest request to start after a delayed AudioContext resume', async () => {
    const gate = deferred<void>();
    FakeAudioContext.resumeGate = gate.promise;
    const loaded = await loadTestAudio();
    const first = loaded.element.playRange({ startTimeSeconds: 0.1, endTimeSeconds: 0.4 });
    const second = loaded.element.playRange({ startTimeSeconds: 0.5, endTimeSeconds: 0.75 });

    gate.resolve();
    const results = await Promise.allSettled([first, second]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { name: 'AbortError' } });
    expect(results[1]).toMatchObject({ status: 'fulfilled' });
    expect(latestContext().sources).toHaveLength(1);
    expect(latestContext().sources[0].starts[0].slice(1)).toEqual([0.5, 0.25]);

    loaded.dispose();
  });

  it('cancels a pending resume without starting stale audio', async () => {
    const gate = deferred<void>();
    FakeAudioContext.resumeGate = gate.promise;
    const loaded = await loadTestAudio();
    const pending = loaded.element.playRange({ startTimeSeconds: 0.1, endTimeSeconds: 0.4 });
    loaded.element.pause();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(latestContext().sources).toHaveLength(0);
    loaded.dispose();
  });

  it('finishes naturally at the selected endpoint and emits one completion sequence', async () => {
    const loaded = await loadTestAudio();
    const events: string[] = [];
    for (const name of ['timeupdate', 'pause', 'ended']) {
      loaded.element.addEventListener(name, () => events.push(name));
    }
    await loaded.element.playRange({ startTimeSeconds: 0.2, endTimeSeconds: 0.6 });
    latestContext().sources[0].finish();

    expect(loaded.element.paused).toBe(true);
    expect(loaded.element.currentTime).toBe(0.6);
    expect(events).toEqual(['timeupdate', 'pause', 'ended']);
    expect(latestContext().sources[0].disconnectCount).toBe(1);
    loaded.dispose();
  });
});

describe('audio playback seeking', () => {
  it('clamps paused seeks and emits one time update without starting playback', async () => {
    const loaded = await loadTestAudio();
    const events: string[] = [];
    loaded.element.addEventListener('timeupdate', () => events.push('timeupdate'));

    loaded.element.seek(0.625);
    expect(loaded.element.paused).toBe(true);
    expect(loaded.element.currentTime).toBe(0.625);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(events).toEqual(['timeupdate']);

    loaded.element.seek(99);
    expect(loaded.element.currentTime).toBe(2);
    expect(events).toEqual(['timeupdate', 'timeupdate']);
    loaded.dispose();
  });

  it('restarts active playback at the seek target and leaves a box audition range', async () => {
    const loaded = await loadTestAudio();
    const events: string[] = [];
    for (const name of ['timeupdate', 'pause', 'ended']) {
      loaded.element.addEventListener(name, () => events.push(name));
    }
    await loaded.element.playRange({
      startTimeSeconds: 0.25,
      endTimeSeconds: 0.75,
      frequencyFilter: {
        mode: 'band-pass',
        lowFrequencyHz: 1_000,
        highFrequencyHz: 2_000,
      },
    });

    const context = latestContext();
    loaded.element.seek(1.25);

    expect(loaded.element.paused).toBe(false);
    expect(loaded.element.currentTime).toBe(1.25);
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0].stops).toEqual([[10.004]]);
    expect(context.sources[1].starts).toEqual([[10, 1.25, 0.75]]);
    expect(context.filters).toHaveLength(4);
    expect(events).toEqual(['timeupdate']);

    loaded.element.seek(2);
    expect(loaded.element.paused).toBe(true);
    expect(loaded.element.currentTime).toBe(2);
    expect(events).toEqual(['timeupdate', 'timeupdate', 'pause', 'ended']);
    loaded.dispose();
  });

  it('supersedes a playback request that is still waiting to start', async () => {
    const gate = deferred<void>();
    FakeAudioContext.resumeGate = gate.promise;
    const loaded = await loadTestAudio();
    const pending = loaded.element.playRange({ startTimeSeconds: 0.25, endTimeSeconds: 0.75 });

    loaded.element.seek(1.25);
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(loaded.element.paused).toBe(true);
    expect(loaded.element.currentTime).toBe(1.25);
    expect(latestContext().sources).toHaveLength(0);
    loaded.dispose();
  });
});

describe('audio range validation', () => {
  it('validates runtime filter modes and clamps one decoded sample of end tolerance', () => {
    expect(() =>
      normalizeAudioFrequencyFilter(
        { mode: 'not-a-mode' as 'band-pass', lowFrequencyHz: 100, highFrequencyHz: 200 },
        4_000,
      ),
    ).toThrow(RangeError);
    expect(
      normalizeAudioPlaybackRange({ startTimeSeconds: 0.5, endTimeSeconds: 1.0001 }, 1, 4_000),
    ).toMatchObject({ startTimeSeconds: 0.5, endTimeSeconds: 1 });
    expect(() =>
      normalizeAudioPlaybackRange({ startTimeSeconds: 0.5, endTimeSeconds: 1.001 }, 1, 4_000),
    ).toThrow(RangeError);
  });
});

async function loadTestAudio() {
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  return loadAudioResource({
    url: pcmWavDataUrl(8_000, 2, 2),
    filename: 'audition.wav',
    mimeType: 'audio/wav',
  });
}

function latestContext(): FakeAudioContext {
  const context = FakeAudioContext.instances.at(-1);
  if (!context) throw new Error('Expected a fake AudioContext instance.');
  return context;
}

class FakeAudioParam {
  value = 0;
  events: Array<[string, number, number]> = [];

  setValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push(['set', value, time]);
    return this as unknown as AudioParam;
  }

  linearRampToValueAtTime(value: number, time: number) {
    this.value = value;
    this.events.push(['linear', value, time]);
    return this as unknown as AudioParam;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number) {
    this.value = value;
    this.events.push(['target', value, time + timeConstant]);
    return this as unknown as AudioParam;
  }

  cancelScheduledValues(time: number) {
    this.events.push(['cancel', this.value, time]);
    return this as unknown as AudioParam;
  }
}

class FakeAudioNode {
  connections: FakeAudioNode[] = [];
  disconnectCount = 0;

  connect(destination: FakeAudioNode) {
    this.connections.push(destination);
    return destination;
  }

  disconnect() {
    this.disconnectCount += 1;
    this.connections = [];
  }
}

class FakeGainNode extends FakeAudioNode {
  gain = new FakeAudioParam();
}

class FakeBiquadNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeAudioParam();
  Q = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  playbackRate = new FakeAudioParam();
  onended: (() => void) | null = null;
  starts: Array<[number, number, number]> = [];
  stops: Array<[number | undefined]> = [];

  start(when: number, offset: number, duration: number) {
    this.starts.push([when, offset, duration]);
  }

  stop(when?: number) {
    this.stops.push([when]);
  }

  finish() {
    this.onended?.();
  }
}

class FakeAudioBuffer {
  readonly channels: Float32Array[];

  constructor(
    readonly channelCount: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: channelCount }, () => new Float32Array(length));
  }

  getChannelData(index: number) {
    return this.channels[index];
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumeGate: Promise<void> | null = null;

  readonly currentTime = 10;
  readonly sampleRate = 48_000;
  readonly destination = new FakeAudioNode();
  state: AudioContextState = 'suspended';
  buffers: FakeAudioBuffer[] = [];
  sources: FakeBufferSourceNode[] = [];
  gains: FakeGainNode[] = [];
  filters: FakeBiquadNode[] = [];

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  createBuffer(channelCount: number, length: number, sampleRate: number) {
    const buffer = new FakeAudioBuffer(channelCount, length, sampleRate);
    this.buffers.push(buffer);
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource() {
    const source = new FakeBufferSourceNode();
    this.sources.push(source);
    return source as unknown as AudioBufferSourceNode;
  }

  createGain() {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain as unknown as GainNode;
  }

  createBiquadFilter() {
    const filter = new FakeBiquadNode();
    this.filters.push(filter);
    return filter as unknown as BiquadFilterNode;
  }

  async resume() {
    await FakeAudioContext.resumeGate;
    this.state = 'running';
  }

  async close() {
    this.state = 'closed';
  }
}

function pcmWavDataUrl(sampleRate: number, durationSeconds: number, channelCount: 1 | 2): string {
  const frameCount = sampleRate * durationSeconds;
  const dataBytes = frameCount * channelCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
