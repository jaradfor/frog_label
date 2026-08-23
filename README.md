# FrogLabel

FrogLabel is a spectrogram-first human annotation workspace for frog-call recordings. One React/TypeScript application supplies a browser demo, a private local-file workflow, Label Studio Community Edition 1.23.0, and a generated Label Studio Enterprise Interface.

## Try the demo

The [GitHub Pages demo](https://jaradfor.github.io/frog_label/) opens directly into the labeling workflow with the bundled `green_tree.mp3` Green Tree Frog recording and the `GRE — Green Tree Frog` species ready in the catalog. No login or Label Studio server is required. Demo annotations stay in memory and reset when the page reloads.

Hold `Space`, tap `G`, and release to select `GRE` and arm Draw, then drag over a call in the spectrogram. The `?` button opens isolated practice. `WASD` pans, `Q`/`E` zoom, `X` fits the recording, `T` toggles Select/Draw, and number keys `1`–`4` toggle Species, Details, Display, and Dataset unless a text field owns the key or a mouse button is held.

Use [Try your own audio](https://jaradfor.github.io/frog_label/?mode=local) for the private local workflow. WAV and MP3 bytes stay in the browser. FrogLabel accepts recordings up to five minutes, subject to the decoded channel-sample safety limit. JSON is the durable, lossless save format; CSV is a convenient flat export.

## Run locally

Requirements: Node.js 22–24, npm 11, Python 3.11+, and Chromium or Chrome.

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4175
```

Open:

- `http://127.0.0.1:4175/frog_label/` — the auto-loaded GRE demo.
- `http://127.0.0.1:4175/frog_label/froglabel-local/` — private local WAV/MP3 labeling.
- `http://127.0.0.1:4175/frog_label/fake-host/` — deterministic embedded-host development.

## Label Studio

Label Studio owns tasks, annotations, review, Submit/Update, history, and export. FrogLabel owns the canonical annotation document, scientific display, box editing, and semantic undo/redo. Embedded FrogLabel never asks an annotator for a token and never calls task, annotation, Submit, or export APIs.

The Python CLI composes operator configuration with Hydra, validates it with strict Pydantic models, and supports the pinned Label Studio CE source plus offline Enterprise artifact generation:

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'

froglabel project init --target ce --project 1 \
  --source /src/label-studio-1.23.0 --data-dir /var/lib/froglabel-ce \
  --config-dir examples/configs --config-name demo-seeded

# Website-only Enterprise artifact; this does not contact Enterprise.
froglabel project init --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise
```

Integration targets:

- Label Studio CE: exact version 1.23.0 at commit `2a9bfbcbf0a844b999de97e601d16050a893f5fb`, derived at build time with an owned custom-tag import, same-origin assets, native region summaries, and a project-catalog overlay.
- Label Studio Enterprise: deterministic, self-contained `specVersion: 1` Interface JSX generated from the same workspace, with current input/output schemas and `getResults`/`parseResults` serializers.
- GitHub Pages: deterministic static artifact built for `/frog_label/`; it has no Label Studio runtime dependency and auto-loads the GRE demo recording.

Start with [Architecture](docs/ARCHITECTURE.md), [CE installation](docs/CE_INSTALLATION.md), [Enterprise setup](docs/ENTERPRISE_SETUP.md), [project initialization](docs/PROJECT_INITIALIZATION.md), and [the ecologist guide](docs/ECOLOGIST_GUIDE.md).

## Validation

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run build:pages
npm run size
npm run test:e2e:agent
npm run test:e2e:pages:agent

.venv/bin/ruff check python
.venv/bin/pytest
```

GitHub Pages deployment repeats validator generation checks, TypeScript, lint, formatting, unit/component tests, the production build, bundle-size checks, and the Pages browser workflow before uploading `build/pages`.

All checked-in browser tests reject unexpected external requests. The pinned agent Chromium is a reproducible fallback when Playwright's browser CDN is unavailable.

## Scientific and privacy boundary

CE stores one singleton `reactcode` result. The Enterprise Interface stores one `labels` result from `froglabel` to `audio`, whose one-item value contains the same versioned canonical FrogLabel document. Geometry remains full-precision seconds/hertz; view and playback state never enter scientific data. Species boxes snapshot immutable identity, current code, and full name. Enterprise export parsing remains backward-compatible with the former ReactCode envelope.

Runtime assets are self-hosted. Private local audio never uploads, and the checked-in application contains no analytics or telemetry client. Host messages are source/origin/tag checked and runtime validated. See [Security and data flow](docs/SECURITY_AND_DATA_FLOW.md).
