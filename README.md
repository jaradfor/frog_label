# FrogLabel

**Fast, precise bioacoustic annotation for people who work in spectrograms every day.**

FrogLabel helps ecologists turn long field recordings into consistent, reviewable time–frequency annotations. It is designed for expert annotators: the right hand can remain on the mouse while the left hand controls species, playback, tools, panels, panning, and zooming.

[Try the live demo](https://jaradfor.github.io/frog_label/) · [Label your own audio](https://jaradfor.github.io/frog_label/?mode=local) · [Read the ecologist quick guide](docs/ECOLOGIST_GUIDE.md)

The demo opens immediately with a real Green Treefrog (_Hyla cinerea_) field recording. No account or server is required; press `?` for a guided two-minute tutorial.

## Why FrogLabel

- **Move quickly without leaving the spectrogram.** The main workspace never scrolls. Numbered panels move the spectrogram aside when opened, and the full workflow is reachable from the left side of the keyboard.
- **Select species by muscle memory.** Hold `Space`, type the shortest useful prefix, and release. FrogLabel previews the likely match while you type and automatically arms Draw after selection.
- **Hear what is inside each annotation.** Every box offers **Play Call Only**, **Play Full Sound**, and **Play Outside Box**. A configurable frequency margin helps distinguish the focal call from insects, overlapping species, and background noise.
- **Navigate without losing visual context.** Panning and zooming preserve the previous spectrogram frame until the exact new view is ready. When time is zoomed, a global overview shows the visible window and lets you drag it left or right through the recording.
- **Adapt the analysis and display to the recording.** Tune the STFT window and overlap when needed, or adjust the dB floor, scientific colour palette, brightness, contrast, stereo-channel view, and Linear, Logarithmic, or Adjustable frequency spacing.
- **Review an entire recording from one place.** The Annotation Dataset panel lists every box with species, time, frequency, bandwidth, listening controls, and deletion.
- **Record true negatives explicitly.** “No calls present” is a deliberate reviewed state, distinct from an unfinished recording with no boxes.
- **Protect the measurements.** Display, zoom, playback, palette, and panel changes never alter stored annotation coordinates.

## Try it in one minute

1. Open the [live demo](https://jaradfor.github.io/frog_label/).
2. Press `V` to listen.
3. Hold `Space`, tap `G`, and release to select `GRE — Green Treefrog`.
4. Drag a box around one bright call.
5. Press `2` to compare the call-only, full-sound, and outside-box audio.
6. Press `4` to review and listen across all annotations.

The [private local workflow](https://jaradfor.github.io/frog_label/?mode=local) accepts WAV and MP3 recordings. Audio stays in the browser, JSON preserves the complete annotation for later work, and CSV provides a convenient flat export.

## Essential controls

| Task                                          | Control                                  |
| --------------------------------------------- | ---------------------------------------- |
| Play or pause                                 | `V`                                      |
| Toggle automatic playback follow              | `Shift+V`                                |
| Seek playback                                 | Click or drag the waveform               |
| Slower / faster playback                      | `R` / `F`                                |
| Choose a species                              | Hold `Space` + type prefix, then release |
| Draw / Select and edit                        | `T` / `G`                                |
| Resize or move the selected box               | Drag a handle / drag inside the box      |
| Pan through time and frequency                | `W` `A` `S` `D`                          |
| Pan the zoomed time window                    | Drag the viewport in the global overview |
| Zoom both axes out / in                       | `Q` / `E`                                |
| Zoom time out / in                            | `Shift+A` / `Shift+D`                    |
| Zoom frequency out / in                       | `Shift+S` / `Shift+W`                    |
| Fit the full recording                        | `X`                                      |
| Species / Box Details / Spectrogram / Dataset | `1` / `2` / `3` / `4`                    |
| Delete selected box                           | `Shift+R`                                |
| Mark a reviewed recording with no calls       | `Shift+X`                                |

Number shortcuts work after using buttons or the spectrogram. They are intentionally ignored only while typing in a field or holding a mouse button.

The detailed waveform seeks anywhere within the visible window. When time is zoomed, the global overview appears above it: drag the yellow playhead marker to scrub globally, click or drag outside the highlighted viewport to seek elsewhere, or drag the viewport itself left and right to pan without changing its duration or frequency range. Playback follow is off by default; turn on **Follow** or press `Shift+V` to page the time window as playback approaches its edge.

## Designed for ecological research

### Precise, stable annotations

Each box stores full-precision start and end times, low and high frequencies in hertz, a stable identifier, and a species identity snapshot. In Select mode, the selected box has eight resize handles: side handles change one dimension, corner handles change both, and dragging inside the box moves it while preserving duration and bandwidth. These edits update the same box rather than silently replacing it. Undo and redo apply to labeling changes, while view preferences remain separate from research data.

### Fast species switching at project scale

Species codes use one to six left-hand letters. Unique prefixes resolve immediately: if only one species begins with `G`, `Space` + `G` is enough. When codes share a prefix, an administrator-set priority chooses the most useful default while the full code remains available.

### Listening as part of quality control

FrogLabel makes acoustic comparison available both for the selected box and for every row in the Dataset panel:

- **Play Call Only** keeps the box frequency band, plus a configurable margin.
- **Play Full Sound** plays the same time window without filtering.
- **Play Outside Box** removes the boxed frequency band. If the suspected call disappears, the box is likely covering it well.

These are listening aids only. They do not transform the source recording or the stored annotation.

### Frequency views for different soundscapes

Linear spacing can devote too much screen area to high frequencies, while a fully logarithmic axis can overemphasize the lowest frequencies. FrogLabel adds an **Adjustable** scale between them, with a continuous low-frequency-emphasis control. All three views use the same exact annotation bounds in hertz.

### Configurable spectrogram analysis

The default remains complete ~20 ms power-of-two Hann analysis with 75% overlap and a −120 dBFS display floor. In the Spectrogram drawer, the target window duration can be set to 10, 20, 40, or 80 ms; the window can be Hann, Hamming, Blackman, or rectangular; overlap can be 0%, 25%, 50%, or 75%; and the display floor can be adjusted from −120 to −40 dBFS. FrogLabel reports the actual power-of-two FFT size and duration for the recording's sample rate.

Changing the target duration, window function, or overlap rebuilds the complete analysis. Palette, brightness, contrast, and dB-floor changes only recolour the existing pooled dB data, so they remain responsive and do not alter the exact peak-pooling result or any annotation coordinates.

## Ways to use FrogLabel

| Setting                            | Intended use                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Live demo**                      | Evaluate the workflow with the bundled Green Treefrog recording.                                  |
| **Private local mode**             | Label WAV or MP3 files without uploading audio. Save complete JSON or flat CSV.                   |
| **Label Studio Community Edition** | Use the same workspace inside a project with shared species and Label Studio review/submission.   |
| **Label Studio Enterprise**        | Generate a self-contained Interface JSX artifact using the same annotation contract and workflow. |

FrogLabel deliberately leaves task assignment, review, submission, history, and export ownership with Label Studio. The embedded interface does not request personal access tokens, advance tasks, or create a second submission path.

## Scientific and privacy boundaries

- Time and frequency geometry remains in full-precision seconds and hertz.
- Viewport, selection, playback, tutorial, spectrogram analysis/display preferences, and open-panel state are never written into scientific annotations.
- A final-box deletion returns the recording to unreviewed; only the explicit No Calls action creates a reviewed negative.
- Local audio is processed in the browser and is not uploaded by FrogLabel.
- Runtime assets are self-hosted, with no analytics or telemetry client.
- Host messages and imported files are bounded and validated before use.
- The current browser workflow supports WAV or MP3, up to two channels, 192 kHz, five minutes, and the documented decoded-sample safety limit.

See [Security and data flow](docs/SECURITY_AND_DATA_FLOW.md) and [Architecture](docs/ARCHITECTURE.md) for the detailed boundaries.

## Run locally

Requirements: Node.js 22–24, npm 11, Python 3.11+, and Chromium or Chrome.

```bash
npm ci
npm run dev -- --host 127.0.0.1 --port 4175
```

Open:

- `http://127.0.0.1:4175/frog_label/` — the Green Treefrog demo.
- `http://127.0.0.1:4175/frog_label/froglabel-local/` — private local WAV/MP3 labeling.
- `http://127.0.0.1:4175/frog_label/fake-host/` — the embedded-host development harness.

## Label Studio deployment

The Python CLI validates project configuration and prepares either the pinned Label Studio CE integration or the offline Enterprise artifact:

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'

froglabel project init --target ce --project 1 \
  --source /src/label-studio-1.23.0 --data-dir /var/lib/froglabel-ce \
  --config-dir examples/configs --config-name demo-seeded

# Produces files locally; it does not contact Label Studio Enterprise.
froglabel project init --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise
```

Integration targets:

- **Label Studio CE:** version 1.23.0 at commit `2a9bfbcbf0a844b999de97e601d16050a893f5fb`, with same-origin assets, native region summaries, and a project species catalog.
- **Label Studio Enterprise:** deterministic, self-contained `specVersion: 1` Interface JSX generated from the shared workspace, including schemas and result serializers.
- **GitHub Pages:** deterministic static artifact built for `/frog_label/`, with no Label Studio runtime dependency.

Setup references: [CE installation](docs/CE_INSTALLATION.md) · [Enterprise setup](docs/ENTERPRISE_SETUP.md) · [Project initialization](docs/PROJECT_INITIALIZATION.md)

## Validation and reproducibility

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

Automated checks cover the annotation domain, keyboard routing, audio decoding and filtering, spectrogram rendering, cache behaviour, accessibility, local file round trips, Label Studio boundaries, and complete browser workflows. Browser tests reject unexpected external requests.

## Demo recording and attribution

The demo and tutorial use an adult male Green Treefrog (_Hyla cinerea_) recorded at the University of Mississippi Field Station by Wikimedia Commons contributor Fredlyfish4. The excerpt is distributed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). See [audio provenance and edits](docs/TUTORIAL_AUDIO_PROVENANCE.md) and [dependencies and licenses](docs/DEPENDENCIES_AND_LICENSES.md).
