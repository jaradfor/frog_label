# Baseline static results

Baseline source: `cc521dbb12d449fb4c7af8930782ff672996f1c1`

- `npm ci --cache .npm-cache`: passed (163 packages).
- Production build: passed; JS 352.67 kB raw / 110.83 kB gzip; CSS 20.74 kB raw / 5.13 kB gzip.
- Size limit: passed; JS 92.41 kB Brotli / 150 kB limit; CSS 4.45 kB Brotli / 10 kB limit.
- Prettier: passed.
- ESLint: exited zero with eight React hook-dependency warnings.
- Vite reported the pre-existing WaveSurfer spectrogram `worker_threads` browser-externalization warning.

The original browser behavior and discovered defects are recorded separately in `BUG_LEDGER.md` so unverified reports are not conflated with static findings.
