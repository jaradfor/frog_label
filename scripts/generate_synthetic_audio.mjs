import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sampleRate = 44_100;
const durationSeconds = 8;
const sampleCount = sampleRate * durationSeconds;
const samples = new Float32Array(sampleCount);

// One centered deterministic call-like signal for UI testing. It is
// deliberately synthetic and must never be represented as a verified
// biological recording.
for (let index = 0; index < sampleCount; index += 1) {
  const time = index / sampleRate;
  const background = 0.006 * Math.sin(2 * Math.PI * 83 * time);
  samples[index] = background;
  const relative = time - durationSeconds / 2;
  if (Math.abs(relative) > 0.4) continue;
  const envelope = Math.sin((Math.PI * (relative + 0.4)) / 0.8) ** 2;
  const pulse = 0.45 + 0.55 * Math.max(0, Math.sin(2 * Math.PI * 18 * relative));
  const sweep = 1_050 + (1_500 * (relative + 0.4)) / 0.8;
  samples[index] +=
    envelope *
    pulse *
    (0.42 * Math.sin(2 * Math.PI * sweep * relative) +
      0.2 * Math.sin(2 * Math.PI * sweep * 2.03 * relative));
}

const bytesPerSample = 2;
const dataBytes = sampleCount * bytesPerSample;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + dataBytes, 4);
wav.write('WAVE', 8);
wav.write('fmt ', 12);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24);
wav.writeUInt32LE(sampleRate * bytesPerSample, 28);
wav.writeUInt16LE(bytesPerSample, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(dataBytes, 40);
for (let index = 0; index < sampleCount; index += 1) {
  const clamped = Math.max(-1, Math.min(1, samples[index]));
  wav.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2);
}

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, '../public/audio/synthetic-frog-practice.wav');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, wav);
console.log(`${output}: ${wav.byteLength} bytes`);
