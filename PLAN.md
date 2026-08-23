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
- Recode bundled fixtures deterministically: GRE remains Green Tree Frog, PER becomes ETF, RED remains Red-Eyed Tree Frog, and COR becomes CRF. Their initial priority is 0 because their first-letter prefixes do not conflict.

## Expert Shell and Controls

- Replace the responsive stacking layout with a fixed 100dvh/host-height shell at every breakpoint. The application, toolbar, and canvas never scroll.
- Render numbered menus as bounded docks that push the spectrogram aside or upward without scrolling the application:

  - **1:** left Species drawer
  - **2:** right Details drawer
  - **3:** right Display drawer, mutually exclusive with Details
  - **4:** bottom Dataset tray

- Only dock bodies and large species/dataset lists may scroll. Virtualize long lists. Keep all docks closed initially, eliminate layout animations, and prevent wheel propagation to the application shell.
- Add a fixed-height Vim-style status line for tool, species, playback rate, viewport, render state, and persistence state. During capture it shows, for example, **SPECIES G\_ → GRE — Green Tree Frog · release Space**, including ambiguity count or rejected-input feedback without moving surrounding controls.
- Use this default command map:

  | Input                                | Action                                                                         |
  | ------------------------------------ | ------------------------------------------------------------------------------ |
  | Hold **Space** + left-side letters   | Preview species; release to commit and enter Draw                              |
  | **W** / **S**                        | Pan frequency up/down by 10% of the visible span                               |
  | **A** / **D**                        | Pan earlier/later by 10% of the visible span                                   |
  | **Q** / **E**                        | Zoom the pointer context: plot=both, waveform=time, frequency ruler=frequency  |
  | **X**                                | Fit complete time and frequency bounds                                         |
  | **V**                                | Play/pause                                                                     |
  | **F** / **R**                        | Faster/slower playback through the existing discrete rates                     |
  | **T**                                | Toggle Select/Draw                                                             |
  | **Shift+D**                          | Delete selected box                                                            |
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
- Put a compact audition bank at the top of Box Details: **Replay box** uses the raw selected time window, **Replay box / band-pass** passes the committed box frequency band plus a persistent administrator-style ±Hz margin, and **Play negative** removes the exact committed box band from that same time window. Keep audition available in read-only workspaces, show the effective bands and active mode without layout movement, and cancel stale playback on selection, geometry, task, Escape, or global-playback changes.
- Schedule box playback directly from the decoded PCM with `AudioBufferSourceNode.start(when, offset, duration)` instead of a 10 ms UI polling loop. Reuse one lazy audio context/buffer, preserve native channels, use cascaded fourth-order Linkwitz–Riley high/low edges with playback-rate-scaled cutoffs, parallel outside-band branches for the negative, and a 4 ms edge envelope to prevent clicks.
- Update help and tutorial content from the same shortcut registry. Tutorial advancement must no longer consume bare Space.
- Preserve the HumanSignal/Label Studio contract: controlled annotation regions, readOnly behavior, stable region IDs, and outer-shell-owned Submit/Update. Do not add duplicate submission or persistence controls.

## Seamless Spectrogram Architecture

- Preserve the complete ~20 ms Hann, 75%-overlap STFT, channel modes, linear/log scales, and exact peak pooling.
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
  - Apply palette, brightness, and contrast through a 256-entry lookup texture/shader so display changes do not rerun STFT or pooling.
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

- Final source checks pass: 153/153 Vitest tests across 20 files, 33/33 Python tests, TypeScript, ESLint, generated-validator drift, Prettier, and `git diff --check`.
- The production build remains within budget at 105,620 B Brotli JavaScript (150,000 B limit) and 5,225 B Brotli CSS (10,000 B limit). CE, Enterprise, and GitHub Pages artifacts were regenerated from commit `994e8ce2dadb` plus this working tree; the Pages archive SHA-256 is `4bd9dfcba45391ac7621a0c2036ff6ca107c54f458ad865ba1e1b2234a5f24cc`.
- The Chromium performance gate passed with a 60.3 ms first preview, 1.2 ms selection p95, 6.7 ms drag feedback, 8.6 ms pan feedback, 34.9 ms exact refinement, zero missed next-frame updates across 100 rapid camera actions, zero blank/opaque frames, and zero rendering long tasks.
- The complete standalone Chromium workspace suite passes 14/14, including pointer-context axis isolation, exact raw/band-pass/negative audition controls, reflowing dock geometry at 640×700, 844×720, 1280×720, and 1440×900; seven-palette switching without a blank frame; keyboard routing; tutorial isolation; and accessibility checks. The static Pages suite passes 6/6 and the exact generated Enterprise Interface passes its inline browser round trip.
- The CE frontend artifact was regenerated. A new CE browser rerun still requires the normal full `ls-ce prepare` build: the existing derived checkout correctly rejected the new compatibility-manifest hash, while a disposable pristine source correctly refused to run before its upstream Yarn build/canary existed.

## Pointer-Context Zoom — 2026-08-22

- `Q` and `E` retain one fast, repeatable command pair. Their axis follows the pointer without a mode-changing keystroke:
  - spectrogram plot: combined time + frequency zoom around the pointer;
  - waveform: time-only zoom around the pointer, preserving both frequency bounds exactly;
  - frequency ruler: frequency-only zoom around the pointer, preserving both time bounds exactly;
  - outside the visualization: centered combined zoom.
- The context is deliberately non-sticky and resets when the pointer leaves the spectrogram shell. `X` always fits both axes.
- A fixed-width `Q/E` target token in the docked expert status line reads `BOTH`, `TIME X`, or `FREQ Y`; the waveform and frequency ruler gain inset hover outlines without moving layout.
