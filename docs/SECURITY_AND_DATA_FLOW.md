# Security and data flow

## CE external-source flow

```text
task audio URL -> validated ReactCode host message -> FrogLabel fetch/decode
project catalog <-> same-origin session/CSRF overlay <-> FrogLabel
completed semantic edit -> exact parent postMessage -> current annotation
outer Label Studio Submit/Update -> server persistence
```

The iframe accepts only the exact parent source/origin/tag and runtime-valid messages. Context epochs cancel stale sends, decode, pointers, tutorial, and playback. It has no login/token UI, browser token storage, Authorization builder, task queue, annotation selector, inner Submit, or task/annotation/export API path. Catalog pagination is same-origin, bounded, and validated.

Enterprise receives documented controlled Interface props and embedded seed data. It changes annotation state only through `addRegion`, `updateRegion`, and `deleteRegion`; the shell remains authoritative. Its generated JSX contains no external `src`, runtime package load, API endpoint, secret, telemetry, or application-controlled code evaluation. Offline FrogLabel CLI commands never contact the Enterprise website; validation, preview, sync, and publish are explicit Label Studio SDK operations.

## Local/tutorial

Local audio uses a revocable object URL and stays in the current tab. JSON contains a SHA-256 byte fingerprint, media metadata, catalog snapshot, and canonical document—not audio. Tutorial state uses isolated memory ports and synthetic bundled audio; it cannot call production ports or the network.

## Content security policy

CE's owned overlay starts from a restrictive policy and permits only same-origin application/media connections plus `blob:` for local media/workers. The Enterprise Interface works under the exact hosted editor CSP; SDK-embedded sample `data:` audio is decoded directly without a `fetch` request. No target depends on the GitHub Pages origin.

## Bounds and encoding

Runtime schemas and Pydantic reject unknown keys, malformed messages, duplicate IDs/results, non-finite/inverted geometry, and over-ceiling resources. The POC maximum is five minutes, two channels, 192 kHz source rate, 128 MiB input, 30 million decoded channel-samples, and 5,000 boxes. JSON and generated JavaScript values use library encoders; CSV cells beginning with `=`, `+`, `-`, or `@` are neutralized. Visible text is rendered by React without unsafe HTML.

Local browser evidence blocks unexpected external requests. A hosted or customer Enterprise instance is contacted only for an explicitly authorized SDK validation, preview, sync, publication, or project operation.
