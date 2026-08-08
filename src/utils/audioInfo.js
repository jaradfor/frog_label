import { fetchAuthenticatedAudioBuffer } from '../api/labelStudio';

export async function getAudioInfo(audioSrc) {
  const buf = await fetchAuthenticatedAudioBuffer(audioSrc);

  // --- Step 1: Decode audio to get sample rate and channel data ---
  // Use a standard AudioContext just for decoding
  const tempContext = new AudioContext();
  const audioBuffer = await tempContext.decodeAudioData(buf.slice(0));
  await tempContext.close();

  const sampleRate = audioBuffer.sampleRate;

  // --- Step 2: Proper FFT using OfflineAudioContext ---
  const fftSize = 8192;
  
  // Create OfflineAudioContext with the file's actual sample rate
  // This preserves ultrasound frequencies if sample rate > 44100
  const offlineCtx = new OfflineAudioContext(
    audioBuffer.numberOfChannels,
    audioBuffer.length,
    sampleRate  // use actual file sample rate, not browser default
  );

  const analyser = offlineCtx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0;

  const source = offlineCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  analyser.connect(offlineCtx.destination);
  source.start();

  await offlineCtx.startRendering();

  // Get frequency domain data (in dB)
  const freqData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(freqData);

  // Find highest frequency bin above noise floor
  const NOISE_FLOOR_DB = -60; // dB, adjust if needed
  let maxFrequency = sampleRate / 2; // fallback to Nyquist

  for (let i = freqData.length - 1; i >= 0; i--) {
    if (freqData[i] > NOISE_FLOOR_DB) {
      maxFrequency = Math.round((i / freqData.length) * (sampleRate / 2));
      break;
    }
  }

  // --- Step 3: Parse header for metadata (MP3 and WAV) ---
  const bytes = new Uint8Array(buf);
  let channels = null, bitrate = null, version = null;

  // WAV header parsing
  if (bytes[0] === 0x52 && bytes[1] === 0x49 &&
      bytes[2] === 0x46 && bytes[3] === 0x46) { // "RIFF"
    channels = bytes[22] | (bytes[23] << 8);
    const bitDepth = bytes[34] | (bytes[35] << 8);
    bitrate = sampleRate * channels * bitDepth;
    version = 'WAV';
  } else {
    // MP3 header parsing
    let start = 0;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) { // "ID3"
      const id3Size = ((bytes[6] & 0x7F) << 21) | ((bytes[7] & 0x7F) << 14) |
                      ((bytes[8] & 0x7F) << 7)  |  (bytes[9] & 0x7F);
      start = 10 + id3Size;
    }

    for (let i = start; i < bytes.length - 3; i++) {
      if (bytes[i] === 0xFF && (bytes[i + 1] & 0xE0) === 0xE0) {
        const b1 = bytes[i + 1];
        const b2 = bytes[i + 2];
        const b3 = bytes[i + 3];

        const layer = (b1 >> 1) & 0x03;
        const bitrateIdx = (b2 >> 4) & 0x0F;
        const sampleIdx = (b2 >> 2) & 0x03;
        if (layer === 0 || bitrateIdx === 0 || bitrateIdx === 15 || sampleIdx === 3) continue;

        const versionBits = (b1 >> 3) & 0x03;
        version = versionBits === 3 ? 'MPEG1' : versionBits === 2 ? 'MPEG2' : 'MPEG2.5';

        const bitrates = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
        bitrate = bitrates[bitrateIdx];

        const channelMode = (b3 >> 6) & 0x03;
        channels = channelMode === 3 ? 'mono' : 'stereo';
        break;
      }
    }
  }

  return { sampleRate, channels, bitrate, version, maxFrequency };
}