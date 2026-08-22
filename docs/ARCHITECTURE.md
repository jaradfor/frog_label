# Architecture

## One workspace, explicit boundaries

```text
FrogLabel workspace
  canonical document + reducer + geometry/audio services
  DocumentPort
    LocalFilePort | TutorialPort | ReactCodeSrcPort | EnterpriseInlineReactCodePort
  SpeciesCatalogPort
    session catalog | CE project catalog | Enterprise embedded/snapshot catalog
```

`src/domain` has no React, browser, audio, or Label Studio dependency. The shared workspace depends on domain and port contracts; adapters depend inward. Route/entry modules choose a context explicitly. Local or tutorial state is never a fallback for a failed host.

## Canonical document

An annotation contains at most one `reactcode` result with a `FrogLabelDocumentV1` value. Its scientific state is exactly one of:

- blank/unreviewed: no result;
- calls present: a result with one or more boxes;
- reviewed no calls: a result with no boxes and `reviewStatus: no_calls`.

Deleting the last box returns to blank. Only the explicit No calls action creates a reviewed negative. Each box has a stable UUID, full-precision finite seconds/hertz, and an immutable species identity snapshot. Viewport, selection, panels, formatting, tutorial, and playback never serialize.

## Host lifecycle

`ReactCodeSrcPort` uses exact parent origin/source/tag validation and an epoch per authoritative task/annotation context. Host `regions` replace local state; they are never merged. Completed gestures emit one immediate semantic mutation and resolve only after an equivalent host echo. Lock/read-only, malformed data, duplicates, timeouts, rejected echo, or epoch change fail visibly and cannot leak a stale write.

In CE, the adapter exposes the singleton FrogLabel document as one native Label Studio region with a box/species summary. Individual time-frequency boxes remain normalized inside that authoritative document and are listed in FrogLabel's Annotation Dataset; the native region is a container view, not a second copy of box data.

CE uses the external-source message protocol and the owned same-origin project-catalog overlay. Enterprise uses documented inline region methods and an embedded catalog. Neither embedded application has a task/annotation REST client, token, independent Submit, or task queue.

## Species catalog

Codes are uppercase three-letter ASCII and unique case-insensitively within a project. Full Species Name is required. `speciesId` is immutable; code/name are current mutable fields. Historical annotations remain interpretable through snapshots. Removal, merge, deprecation, aliases, and reserved old-code behavior are deliberately absent.

CE persists one descriptor plus project-linked species Label values inside a transaction and uses the authoritative project ID to detect clones. Enterprise embeds seed state in the XML; ecologist additions are annotation-local snapshots until an offline export reconciliation is reviewed and republished.

## Audio and rendering

One `AudioResource` fetches/decodes a task once and preserves native stereo playback. Scientific analysis is mono and selectable as Average energy, Max, Left, or Right. Complete overlapping STFT windows run in a task-scoped Blob worker when available and in a cancellable cooperative executor otherwise. The two paths share the same algorithm. The bounded POC accepts at most two channels, 192 kHz source rate, five minutes, 128 MiB, and 30 million decoded channel-samples.

## Packaging

- Standalone/Pages: Vite artifact using local/session ports at `/frog_label/`.
- CE 1.23.0: same workspace built at `/react-app/froglabel/`; a small upstream patch registers the custom tag early and fixes detached-entity lifecycle reads found by real-browser testing.
- Enterprise: one generated XML with compiled shared workspace code, CSS, schemas, synthetic tutorial audio, and embedded catalog; host React is injected, not bundled a second time.

Models are outside this human-demo pass. Optional versioned provenance in the canonical schema remains a future-compatible data boundary, without a supported compiler or prediction workflow.
