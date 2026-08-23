# FrogLabel Expert Workflow Overhaul

> Implementation status: the catalog V2 contract, expert keyboard shell, reflowing panel docks, retained/tiled spectrogram renderer, host adapters, generated artifacts, and regression/performance gates described below have been implemented. Final verification evidence and any environment-limited reruns are recorded in the handoff.

## Summary

- Rebuild the shared production workspace under **froglabel/src**, leaving the unrelated **my-interface/Screen.jsx** artifact untouched.
- Restore the fixed, shortcut-driven character of the [deployed legacy interface](https://ucsd-e4e.github.io/frog_label/) while retaining the current renderer's more reliable STFT and peak-preserving analysis. The legacy [persistent spectrogram surface](https://github.com/UCSD-E4E/frog_label/blob/main/src/components/WaveformSpectrogram.jsx) is the responsiveness model, not the scientific implementation.
- Measured cause of the current delay: every view change waits 180 ms, then spends roughly 120–300 ms rebuilding a full raster, while an opaque overlay hides the valid prior frame. Current pan/zoom took 300–371 ms in-browser.
- Pre-implementation baseline: 54/54 Vitest tests, typecheck, lint, and production build passed. Five of six selected Playwright checks passed; one draw test raced the first spectrogram frame and needed an explicit readiness wait. No source files were modified during that measurement phase.

## Species and Catalog Contract

- Introduce version-2 catalog/species contracts:

      type SpeciesCodeV2 = string; // /^[QWERTASDFGZXCVB]{1,6}$/

      interface SpeciesEntryV2 {
        schemaVersion: 2;
        speciesId: string;          // immutable internal identity
        code: SpeciesCodeV2;        // canonical, admin-assigned code
        selectionPriority: number;  // integer 0–1,000,000; higher wins
        // existing descriptive fields remain
      }

- Keep exact codes unique. Prefixes may overlap. Build a prefix index once per catalogRevision; rank candidates by exact-code match, descending administrator priority, shorter code, lexical code, then stable speciesId.
- Do not add adaptive learning, browser persistence, or telemetry. Shortcut results must remain stable enough to become muscle memory.
- Add document/schema version 2 so new boxes can snapshot variable-length codes while historical three-letter snapshots such as PER remain valid. V1 documents remain readable and upgrade only when next written; existing box snapshots are never rewritten.
- Provide a dual-read, explicit-migration path for V1 catalogs. Administrative sync must supply a valid new code and priority for every active legacy entry, update records transactionally by immutable speciesId, and reject partial or colliding migrations.
- Update TypeScript/Python models, generated schemas, Hydra configuration, CE storage/API, Enterprise embedding, local imports, and CreateSpeciesInput. Legacy catalog entries without a mapping remain visible as historical species but cannot participate in Space selection.
- Recode bundled fixtures deterministically: GRE remains Green Treefrog, PER becomes ETF, RED remains Red-Eyed Tree Frog, and COR becomes CRF. Their initial priority is 0 because their first-letter prefixes do not conflict.

## Expert Shell and Controls

- Replace the responsive stacking layout with a fixed 100dvh/host-height shell at every breakpoint. The application, toolbar, and canvas never scroll.
- Render numbered menus as bounded docks that push the spectrogram aside or upward without scrolling the application:

  - **1:** left Species drawer
  - **2:** right Details drawer
  - **3:** right Display drawer, mutually exclusive with Details
  - **4:** bottom Dataset tray

- Only dock bodies and large species/dataset lists may scroll. Virtualize long lists. Keep all docks closed initially, eliminate layout animations, and prevent wheel propagation to the application shell.
- Add a fixed-height Vim-style status line for tool, species, playback rate, viewport, render state, and persistence state. During capture it shows, for example, **SPECIES G\_ → GRE — Green Treefrog · release Space**, including ambiguity count or rejected-input feedback without moving surrounding controls.
- Use this default command map:

  | Input                                | Action                                                                         |
  | ------------------------------------ | ------------------------------------------------------------------------------ |
  | Hold **Space** + left-side letters   | Preview species; release to commit and enter Draw                              |
  | **W** / **S**                        | Pan frequency up/down by 10% of the visible span                               |
  | **A** / **D**                        | Pan earlier/later by 10% of the visible span                                   |
  | **E** / **Q**                        | Zoom both axes in/out by 1.25× around the mouse pointer, or viewport center    |
  | **Shift+D** / **Shift+A**            | Zoom time only in/out, preserving the frequency window exactly                 |
  | **Shift+W** / **Shift+S**            | Zoom frequency only in/out, preserving the time window exactly                 |
  | **X**                                | Fit complete time and frequency bounds                                         |
  | **V**                                | Play/pause                                                                     |
  | **F** / **R**                        | Faster/slower playback through the existing discrete rates                     |
  | **T**                                | Activate Draw                                                                  |
  | **G**                                | Activate Select                                                                |
  | **Shift+R**                          | Remove selected box                                                            |
  | **Tab** / **Shift+Tab**              | Cycle boxes when the command surface owns focus; remain native inside controls |
  | **C** / **Shift+C**                  | Cycle overlapping boxes forward/backward                                       |
  | **Shift+X**                          | Mark no-calls, retaining the existing destructive confirmation                 |
  | **1**–**4**                          | Toggle panel docks                                                             |
  | **Escape**                           | Cancel chord/gesture or deselect                                               |
  | **Ctrl/Cmd+Z**, **Ctrl/Cmd+Shift+Z** | Undo/redo                                                                      |

- Allow key repeat only for camera controls. Secondary- or middle-button drag pans from any tool, leaving primary drag available for drawing and selection.
- Implement Space selection as a state machine using physical QWERTY-side key positions:

  - Start on non-repeating Space-down, snapshot the current catalog, and mask ordinary commands.
  - Accept QWERTASDFGZXCVB; ignore modifiers and reject any input that would eliminate all candidates while retaining the last valid query/winner.
  - Display the provisional winner immediately. A unique prefix resolves immediately but capture continues until Space-up.
  - Space-up commits the displayed candidate; an empty chord or no candidate is a no-op. Escape, blur, catalog revision change, or pointer cancellation aborts.
  - Successful selection enters Draw when editable; read-only workspaces change only the current species and announce that drawing is locked.

- Replace the broad focus guard with command-aware routing. Digits are suppressed only for input, textarea, select, contenteditable content, or while any pointer button is held. Focused buttons/forms no longer suppress them. Track pointer IDs through up, cancel, lost capture, blur, and visibility changes, and deliberately focus the spectrogram command surface after pointer interaction.
- Keep the playback button's visible text permanently **Play**; only highlight, aria-pressed, and the status line change during playback. Its dimensions and icon remain fixed.
- Put a compact audition bank at the top of Box Details: **Play Full Sound** uses the raw selected time window, **Play Call Only** passes the committed box frequency band plus a persistent administrator-style ±Hz margin, and **Play Outside Box** removes the exact committed box band from that same time window. Keep audition available in read-only workspaces, show the effective bands and active mode without layout movement, and cancel stale playback on selection, geometry, task, Escape, or global-playback changes.
- Schedule box playback directly from the decoded PCM with `AudioBufferSourceNode.start(when, offset, duration)` instead of a 10 ms UI polling loop. Reuse one lazy audio context/buffer, preserve native channels, use cascaded fourth-order Linkwitz–Riley high/low edges with playback-rate-scaled cutoffs, parallel outside-band branches for the negative, and a 4 ms edge envelope to prevent clicks.
- Update help and tutorial content from the same shortcut registry. Tutorial advancement must no longer consume bare Space.
- Preserve the HumanSignal/Label Studio contract: controlled annotation regions, readOnly behavior, stable region IDs, and outer-shell-owned Submit/Update. Do not add duplicate submission or persistence controls.

## Seamless Spectrogram Architecture

- Default to complete ~20 ms power-of-two Hann analysis with 75% overlap and a −120 dBFS display floor, while preserving channel modes, linear/log scales, and exact peak pooling. The Display drawer exposes 10/20/40/80 ms target windows, Hann/Hamming/Blackman/rectangular window functions, 0/25/50/75% overlap, and a −120 to −40 dBFS display floor.
- Rebuild the task-scoped STFT and its dependent exact tiles when window duration, window function, or overlap changes. Keep palette, brightness, contrast, and the dB floor display-only so they recolor existing pooled dB tiles without rerunning analysis or changing exact viewport-grid cache semantics.
- Create one task-scoped worker session with a single initialization request. Remove the arbitrary 100 ms worker delay, 180 ms view debounce, duplicate initial renders, and FIFO processing of obsolete full-frame requests.
- Use lifecycle states **initializing**, **preview**, **ready**, **refining**, and **error**. Never place an opaque overlay over valid pixels. After the first preview, navigation, playback, and annotation controls remain usable while exact pixels refine.
- Use a retained front compositor and background surface:

  - Reproject the current frame on the next animation frame for immediate pan/zoom feedback.
  - Render replacement content offscreen and atomically swap it.
  - Never resize or clear the visible front surface before replacement pixels exist.
  - On a new audio task, show the waveform and neutral stage immediately rather than retaining pixels from the wrong recording.

- Implement a WebGL2 single-channel spectral-tile atlas with Canvas2D fallback:

  - Use exact 256×256 viewport-grid dB tiles keyed by audio generation, channel mode, frequency scale, zoom level, full view bounds, raster size, and global pixel coordinates. Fixed pooled world tiles are not scientifically exact for arbitrary fractional offsets because those offsets change the half-open STFT frame/bin range of nearly every output pixel.
  - Prioritize visible misses, then adjacent centered Q/E zoom views. Do not schedule an out-of-grid overscan ring: exact viewport keys make those tiles scientifically valid but impossible to reuse. Retained-frame reprojection supplies immediate feedback for fractional camera moves whose exact keys cannot be reused.
  - Store tiles in a byte-accounted 48 MiB LRU and explicitly dispose evicted ImageBitmap/GPU resources.
  - Apply palette, brightness, contrast, and the selected dB floor through a 256-entry lookup texture/shader so display changes do not rerun STFT or pooling.
  - Do not construct a whole-file mip pyramid; maximum supported audio already consumes roughly 240 MiB for analysis data.

- Optimize without changing scientific behavior: use direct real² + imag² power, precomputed frame/bin ranges, allocation-free channel loops, separable rectangular max pooling, and LUT color mapping. The separable prototype already matched current pooling bit-for-bit while reducing 1600×800 pooling from about 105 ms to 20–31 ms.
- Generate the first whole-duration preview from a bounded, evenly distributed STFT pass and label preview state unobtrusively in the status line. Exact viewport tiles begin after the shared full-clip STFT initializes; until then, retained/preview pixels keep navigation and annotation inspection live without blacking out the surface.
- Coalesce rapid camera requests by generation, interrupt obsolete work between bounded jobs, and cache still-valid completed tiles. The main-thread fallback must yield every 4–8 ms rather than performing a final synchronous raster.
- Build a min/max waveform envelope pyramid once per audio task so waveform navigation is proportional to canvas width rather than visible PCM sample count.

## Verification and Rollout

- Add resolver/schema tests for every prefix rule, exact matches, priorities, variable-length codes, rejected continuations, key repeat, catalog revision changes, V1/V2 migration, and untouched historical snapshots.
- Add keyboard regressions for digits after toolbar focus, spectrogram interaction after editing, actual field focus, all held-pointer exit paths, modal/tutorial routing, read-only behavior, and the complete left-hand keymap.
- Add layout tests at 640×700, 844×720, 1280×720, and 1440×900 proving zero page/app scrolling, scroll confined to dock bodies, panel/canvas non-overlap, and exact canvas restoration when a dock closes.
- Add renderer parity tests across tile boundaries, arbitrary view offsets, mono/stereo modes, linear/log frequency, brief calls, Nyquist edges, cache eviction, cancellation, fallback scheduling, and resource disposal.
- Replace the misleading ARIA-label latency test with render-generation instrumentation advanced only after a preview transform or exact atomic swap. On the reference CI browser require:

  - Camera feedback by the next animation frame.
  - No blank/opaque frame during 100 rapid WASD/Q/E actions.
  - First preview within 100 ms of decoded PCM for bundled/reference audio.
  - Warm exact refinement p95 at or below 100 ms.
  - The newest view not blocked by stale work.
  - No main-thread task longer than 50 ms from rendering.

- Verify static Play text and stable control geometry across playback, CE/Enterprise/local catalog round trips, outer Submit/Update ownership, production build size, and the complete existing unit/component/browser suite.
- Roll out in order: dual-read schemas and CLI support, administrator dry-run, transactional catalog recode, frontend deployment, then regenerated CE/Enterprise/Pages artifacts. No annotation rewrite, telemetry, automatic ranking, or scientific-analysis downgrade is included.

## Implementation Verification — 2026-08-22

- Final source checks pass: 186/186 Vitest tests across 25 files, 36/36 Python tests, TypeScript, ESLint, generated-validator drift, Prettier, and `git diff --check`.
- The production build remains within budget at 107,338 B Brotli JavaScript (150,000 B limit) and 5,339 B Brotli CSS (10,000 B limit). CE, Enterprise, and GitHub Pages artifacts were regenerated from this working tree; the Pages archive SHA-256 is `e2cda8f6ee4bec2017b85e297ac9bf28302de7094457173d7cdbb2912f4494da`.
- The Chromium performance gate passed with a 53.2 ms first preview, 1.4 ms selection p95, 7.0 ms drag feedback, 13.2 ms pan feedback, 19.1 ms exact refinement, zero missed next-frame updates across 100 rapid camera actions, zero blank/opaque frames, and zero rendering long tasks.
- The fresh standalone Chromium suite passes 14/14, including the 5,000-box performance gate, seeded replay explorer, modifier-driven axis isolation, adjustable frequency-emphasis repainting with a changed canvas hash and no blank frame, reflowing dock geometry at 640×700, 844×720, 1280×720, and 1440×900, keyboard routing, tutorial isolation, and accessibility checks. The exact packaged static Pages suite passes 6/6. The exact generated Enterprise Interface passes offline SDK validation and its inline Chromium round trip with licensed audio, drawing, controlled host echo, and result serialization.
- A pristine checkout of the pinned Label Studio CE 1.23.0 commit passes the full normal-user HTTP/browser/database/export workflow with the regenerated frontend artifact, including all 12 tutorial steps, draft echo, submit/update, no-calls, and catalog-permission checks.
- Label Studio Enterprise Interface `4489` version 5 was published and pulled back byte-for-byte (SHA-256 `ef16cb6ccc7e6d4c4939198640ed9db0265867f7e14592d5856b8712c04b0a63`), and project `280811` was pinned to version 5.

## Stateless Axis Zoom — 2026-08-22

- `E` zooms both axes in and `Q` zooms both axes out; both commands are fast and repeatable.
- `Shift+D` zooms time in and `Shift+A` zooms time out, preserving both frequency bounds exactly.
- `Shift+W` zooms frequency in and `Shift+S` zooms frequency out, preserving both time bounds exactly.
- Delete moves from `Shift+D` to the unused mnemonic `Shift+R` (remove), keeping the complete command set on the left hand.
- All zoom commands remain pointer-anchored when the pointer is over the spectrogram and centered otherwise. `X` always fits both axes.

## Adjustable Frequency Axis — 2026-08-22

- Keep Linear and Logarithmic as exact presets and add an Adjustable scale with a continuous 0–100% low-frequency-emphasis control, defaulting to a balanced 50%.
- Use an exactly invertible power-law transform: emphasis continuously changes the exponent from 1.0 (linear) to 0.25 (strong low-frequency expansion). Unlike logarithmic scaling, it remains defined at 0 Hz.
- Use the same shared transform for scientific raster pooling, annotation projection, pointer conversion, axis labels, frequency pan/zoom, retained-frame placement, tile identity, and worker cache identity.
- Preserve canonical annotation frequencies in hertz. Scale and emphasis remain display settings and never alter saved boxes.
- Verify forward/inverse round trips, offscreen projection, naive/exact pooling parity, arbitrary tile seams, adjustable cache invalidation, no-blank browser switching, and axis-isolated zoom under the adjustable scale.
