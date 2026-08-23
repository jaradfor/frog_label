# Tutorial audio provenance

`public/audio/synthetic-frog-practice.wav` is an original deterministic test signal generated in this repository by `scripts/generate_synthetic_audio.mjs`.

- SHA-256: `87f07fbd056bccc8354e0dfb3c781ff35025fc468f9be8d562a1bf38cc377f17`
- Format: PCM WAV, mono, 44,100 Hz, 16-bit
- Duration: 8.0 seconds
- Source: mathematical oscillator/noise envelopes written by the generator; no field recording, human performance, third-party sample, or model output
- License: CC0-1.0 (`public/audio/LICENSE.txt`); safe to redistribute with FrogLabel

The fixture contains deliberately visible chirp-like energy bands so the production audio decoder, STFT renderer, tools, and box editor can be practiced and tested. It is not a recording of Peron's Tree Frog, Green Tree Frog, or any other species and must not be used as a biological identification reference or training datum.

Regenerate and verify:

```bash
node scripts/generate_synthetic_audio.mjs
sha256sum public/audio/synthetic-frog-practice.wav
```

The tutorial labels its exercise ETF only to demonstrate the UI workflow. Tutorial annotation/catalog state is isolated in memory, never sent to the live host, and discarded on close or host epoch switch.
