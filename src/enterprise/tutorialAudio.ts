let cached: string | null = null;

/** Small deterministic PCM WAV used only inside the isolated Enterprise tutorial. */
export function embeddedTutorialAudioUrl(): string {
  if (cached) return cached;
  const sampleRate = 8_000;
  const seconds = 2;
  const samples = sampleRate * seconds;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  ascii(bytes, 0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(bytes, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(bytes, 36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    const time = index / sampleRate;
    const inCall = (time >= 0.38 && time < 0.63) || (time >= 1.08 && time < 1.34);
    const envelope = inCall ? Math.sin(Math.PI * ((time * 4) % 1)) ** 2 : 0;
    const signal =
      envelope *
      (0.55 * Math.sin(2 * Math.PI * 820 * time) + 0.25 * Math.sin(2 * Math.PI * 1_640 * time));
    view.setInt16(44 + index * 2, Math.round(Math.max(-1, Math.min(1, signal)) * 32_767), true);
  }
  let binary = '';
  for (let start = 0; start < bytes.length; start += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8_192));
  }
  cached = `data:audio/wav;base64,${btoa(binary)}`;
  return cached;
}

function ascii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}
