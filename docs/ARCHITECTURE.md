# Architecture

## One workspace, explicit boundaries

```text
FrogLabel workspace
  canonical document + reducer + geometry/audio services
  DocumentPort
    LocalFilePort | TutorialPort | ReactCodeSrcPort | EnterpriseInterfacePort
  SpeciesCatalogPort
    session catalog | CE project catalog | Enterprise embedded/snapshot catalog
```

`src/domain` has no React, browser, audio, or Label Studio dependency. The shared workspace depends on domain and port contracts; adapters depend inward. Route/entry modules choose a context explicitly. Local or tutorial state is never a fallback for a failed host.

## Canonical document

An annotation contains at most one canonical `FrogLabelDocumentV1`. CE wraps it in a singleton `reactcode` result. The Enterprise Interface wraps it in one `labels` result from `froglabel` to `audio`, with the document as the only array item. Its scientific state is exactly one of:

- blank/unreviewed: no result;
- calls present: a result with one or more boxes;
- reviewed no calls: a result with no boxes and `reviewStatus: no_calls`.

Deleting the last box returns to blank. Only the explicit No calls action creates a reviewed negative. Each box has a stable UUID, full-precision finite seconds/hertz, and an immutable species identity snapshot. Viewport, selection, panels, formatting, tutorial, and playback never serialize.

## Host lifecycle

`ReactCodeSrcPort` uses exact parent origin/source/tag validation for CE. `EnterpriseInterfacePort` consumes the current controlled Interface props (`task`, `regions`, `params`, and `readOnly`) and mutates only through `addRegion`, `updateRegion`, and `deleteRegion`. Both adapters use an epoch per authoritative task/annotation context. Host regions replace local state; they are never merged. Completed gestures emit one immediate semantic mutation and resolve only after an equivalent host echo. Lock/read-only, malformed data, duplicates, timeouts, rejected echo, or epoch change fail visibly and cannot leak a stale write.

In CE, the adapter exposes the singleton FrogLabel document as one native Label Studio region with a box/species summary. Individual time-frequency boxes remain normalized inside that authoritative document and are listed in FrogLabel's Annotation Dataset; the native region is a container view, not a second copy of box data.

CE uses the external-source message protocol and the owned same-origin project-catalog overlay. Enterprise uses the documented Interface region callbacks, exported schemas/serializers, and an embedded catalog. Neither embedded application has a task/annotation REST client, token, independent Submit, or task queue.

## Species catalog

Active V2 codes are 1–6 uppercase letters from `QWERTASDFGZXCVB` and are unique within a project. `selectionPriority` is an administrator-set integer from 0 to 1,000,000; it affects ambiguous prefix selection but is excluded from annotation snapshots. Full Species Name is required. `speciesId` is immutable, while code/name/priority are current mutable catalog fields. A V2 catalog's optional `historicalSpecies` lane contains validated V1 records for display only; those records are never offered to the Space prefix index, even when an old code happens to use left-hand letters. V1 documents remain readable and are upgraded in memory; historical box snapshots retain codes such as `PER` and `COR` unchanged.

Reading and promotion are deliberately separate. Local files and CE/Enterprise runtime catalogs can expose an unmapped V1 catalog as `historicalSpecies` while keeping the active `species` array empty. Administrative synchronization is the only promotion path and requires an explicit code and priority for every legacy immutable ID in one transaction; partial mappings fail without changing storage.

CE persists one descriptor plus project-linked species Label values inside a transaction and uses the authoritative project ID to detect clones. Enterprise embeds seed state in the generated JSX; ecologist additions are annotation-local snapshots until an offline export reconciliation is reviewed and a new Interface version is published.

## Audio and rendering

One `AudioResource` fetches/decodes a task once and preserves native stereo playback. Scientific analysis is mono and selectable as Average energy, Max, Left, or Right. Complete overlapping STFT windows run in a task-scoped Blob worker when available and in a cancellable cooperative executor otherwise. The two paths share the same algorithm. The bounded POC accepts at most two channels, 192 kHz source rate, five minutes, 128 MiB, and 30 million decoded channel-samples.

Exact replacement frames are partitioned into palette-independent 256×256 dB tiles and assembled offscreen before one atomic Canvas2D front-surface commit. WebGL2 stores those tiles in one slot-based `R32F` atlas capped at 48 MiB and applies palette, brightness, and contrast through a 256-entry lookup texture; the fallback retains the same dB tiles and colorizes cooperatively in Canvas2D. The CPU tile LRU is independently byte-capped at 48 MiB. Visible misses run first, followed by best-effort adjacent center-zoom prefetch, and all background work is preemptible by a newer view generation. Out-of-grid rings are deliberately omitted because an exact view-grid key can never reuse them after a pan.

The authoritative tiles are deliberately keyed to the exact viewport grid: audio generation, channel mode, frequency scale, Q/E zoom level, full IEEE-754 view bounds, raster dimensions, and tile coordinates. A fixed pooled world raster cannot preserve FrogLabel's peak-pooling result at arbitrary fractional pan offsets because nearly every output pixel's half-open frame/bin rectangle changes. Each view tile is therefore computed using its global pixel offset and the full raster dimensions, which makes seams and arbitrary offsets bit-for-bit equivalent to monolithic pooling. Overscan and adjacent-zoom tiles are only best-effort warmups; retained-frame reprojection supplies immediate feedback when a new fractional view has a different exact key. Display-only settings are excluded from the scientific key and never rerun pooling.

## Packaging

- Standalone/Pages: Vite artifact using local/session ports at `/frog_label/`.
- CE 1.23.0: same workspace built at `/react-app/froglabel/`; a small upstream patch registers the custom tag early and fixes detached-entity lifecycle reads found by real-browser testing.
- Enterprise: one generated Interface JSX file with compiled shared workspace code, CSS, schemas, synthetic tutorial audio, and embedded catalog; host React is injected, not bundled a second time.

Models are outside this human-demo pass. Optional versioned provenance in the canonical schema remains a future-compatible data boundary, without a supported compiler or prediction workflow.
