**Note: Apologies for the AI-Slop, we anticipate re-writing this for clarity. For now, an LLM can ingest this and make changes as needed.**

# Telemetry (Phase 1)

Automatic, anonymous usage telemetry for FrogLabel — built so testers (starting with the
Demo mode cohort) don't have to do anything to help us find UX and engineering problems.
No login, no export step, no consent form: identity and delivery are both automatic.

This covers what's implemented today (Phase 1: automatic collection of interaction and
lifecycle events). Phase 2 — scoring testers' boxes against known-correct reference
annotations on the demo clips — is scoped but not yet built; see "What's next" below.

## Why

Testers hit **Demo mode** first (`src/adapters/demoAdapter.js` — four fixed local audio
files, no backend). Prior art we grounded this in:

- Cartwright et al., ["Seeing Sound: Investigating the Effects of Visualizations and
  Complexity on Crowdsourced Audio Annotations"](https://doi.org/10.1145/3134664) (CSCW 2017) — the paper this app's predecessor (audio annotation over a spectrogram) is
  descended from. Its key methodological point: they didn't just grade final annotations,
  they replayed _interaction logs_ to reconstruct state over time and measure where errors
  happen (onset accurate, offset systematically late; recall hurt more than precision by
  complexity; quality improves over a tester's first 5–10 tasks).
- [CrowdCurio's `audio-annotator`](https://github.com/CrowdCurio/audio-annotator), the tool
  this app's spectrogram + region-annotation UI is architecturally descended from.

## Architecture

```
Browser (FrogLabel)                 Cloudflare Worker              D1 (SQLite)
┌───────────────────────┐   POST    ┌─────────────────┐    SQL     ┌───────────┐
│ src/telemetry/         │ /events  │ telemetry-worker/│  batch     │  events   │
│  identity.js            │ ───────▶ │  src/index.js    │ ─────────▶ │  table    │
│  telemetry.js (buffer,  │ (beacon/ │  validates, CORS-│            └───────────┘
│  sendBeacon delivery)   │  fetch)  │  checks, inserts │
└───────────────────────┘           └─────────────────┘
```

- **Client** — `src/telemetry/`. Fully static-site compatible (GitHub Pages serves this
  app; it cannot run server code), so all identity/buffering logic runs in the browser and
  only the final delivery hop leaves the page.
- **Ingest** — `telemetry-worker/`. A standalone Cloudflare Worker + D1 database, kept as
  its own package so it never counts against the frontend's `size-limit` bundle budget. See
  [`telemetry-worker/README.md`](../telemetry-worker/README.md) for deploy/migration/query
  commands.
- **Live endpoint**: `https://frog-label-telemetry.e4e-telemetry.workers.dev`

## Identity model (how testers are told apart with zero effort)

Implemented in `src/telemetry/identity.js`:

- **`device_id`** — a UUID generated on first load and persisted in `localStorage`. Stable
  across visits in the same browser, which is the closest to "who is this tester" achievable
  without accounts or logins.
- **`session_id`** — a fresh UUID per page load, grouping events within one visit.

**Known limitation, by design**: this identifies _browser profiles_, not people. Cleared
storage, private/incognito mode, or a different browser/device all produce a "new" tester.
That's an accepted tradeoff for zero-friction, non-account-based identification at this
testing scale — deliberately not solved with fingerprinting techniques (canvas/font
fingerprinting, etc.), which would be a disproportionate and covert response to a small
testing cohort.

**What's not collected**: no PII, no IP-based identity, no cross-site tracking. The Worker
does not log request IPs anywhere beyond Cloudflare's standard edge request metadata.
Testers should be told, in passing (a line in the app or README), that anonymous usage
data is collected — silent collection is fine for non-personal analytics, but should still
be disclosed rather than hidden.

## Delivery mechanics

`src/telemetry/telemetry.js`:

- Events are buffered client-side and flushed every 5 seconds, when the buffer hits 20
  events, or immediately on tab hide/unload (`visibilitychange` → hidden, `pagehide`).
- Delivery is via `navigator.sendBeacon` (survives tab close, fire-and-forget), falling back
  to `fetch(..., { keepalive: true })` if `sendBeacon` is unavailable.
- The request body is sent as `text/plain` (not `application/json`) so it qualifies as a
  CORS "simple request" — no preflight `OPTIONS` round trip needed for normal delivery.
- **Only sends from production builds by default** (`import.meta.env.PROD`), so routine
  `npm run dev` sessions don't pollute real tester data. To exercise the pipeline locally:
  set `VITE_TELEMETRY_FORCE=true` in a local `.env.local` (gitignored). The endpoint itself
  can be overridden with `VITE_TELEMETRY_URL` if ever needed (e.g. pointing at a local
  `wrangler dev` instance).

## Server-side validation (`telemetry-worker/src/index.js`)

- Request body capped at 64KB, batches capped at 200 events.
- `device_id`/`session_id` must be loosely UUID-shaped; event names must match
  `^[a-zA-Z0-9_]{1,64}$`; payloads must be plain objects.
- A `client: "frog-label-web"` field must be present — a soft filter against stray/junk
  traffic, not real security.
- **CORS origin allowlisting is a courtesy filter, not access control.** CORS is
  browser-enforced only; a direct server-to-server request can always reach the endpoint
  regardless of `Origin`. This endpoint is intentionally a public, write-only ingest sink —
  the same trust model as a PostHog or Sentry ingest key — so no secret gates writes.
  Hardening options (Cloudflare Rate Limiting rules, WAF) are a follow-up if abuse becomes a
  real problem, not built preemptively.

## Event catalog (Phase 1)

| Event                 | Fired from                                                             | Payload                                                                              | Signal                                                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login_screen_choice` | [`LoginScreen.jsx`](../src/components/LoginScreen.jsx)                 | `demoMode, success`                                                                  | Confirms/quantifies that testers pick Demo mode first                                                                                                                     |
| `task_started`        | [`useAnnotationSession.js`](../src/hooks/useAnnotationSession.js)      | `demoMode, startingBoxCount`                                                         | Per-task cadence; also tags all subsequent events with `task_id` until the next task loads                                                                                |
| `task_submitted`      | [`useAnnotationSession.js`](../src/hooks/useAnnotationSession.js)      | `success, boxCount, wallClockMs, demoMode`                                           | Completion time per task, comparable to the paper's per-complexity medians; failure path is explicitly tracked                                                            |
| `tasks_exhausted`     | [`useAnnotationSession.js`](../src/hooks/useAnnotationSession.js)      | `demoMode`                                                                           | Tester reached the end of the task queue (all 4 demo clips, or LS queue empty)                                                                                            |
| `tool_changed`        | [`Tools.jsx`](../src/components/Tools.jsx)                             | `fromTool, toTool, viaKeyboard`                                                      | Keyboard vs. mouse adoption for this left-hand-shortcut-first UI                                                                                                          |
| `code_entry_success`  | [`BoundingBoxControls.jsx`](../src/components/BoundingBoxControls.jsx) | `code, entryDurationMs`                                                              | Time-to-valid-code, keyboard fluency                                                                                                                                      |
| `code_entry_error`    | [`BoundingBoxControls.jsx`](../src/components/BoundingBoxControls.jsx) | `attemptedCode, validCodesCount`                                                     | Interface-clarity signal for the 3-letter code system                                                                                                                     |
| `box_created`         | [`BoundingBoxLayer.jsx`](../src/components/BoundingBoxLayer.jsx)       | `code, durationSec, bandwidthHz, drawDurationMs`                                     | Baseline annotation throughput                                                                                                                                            |
| `box_resized`         | [`BoundingBoxLayer.jsx`](../src/components/BoundingBoxLayer.jsx)       | `corner, code, deltaStartTimeSec, deltaEndTimeSec, deltaStartFreqHz, deltaEndFreqHz` | Proxy for onset/offset correction — the paper found offsets are the error-prone edge; a high resize rate concentrated on the _end_ edge would replicate that finding here |
| `box_deleted`         | [`BoundingBoxControls.jsx`](../src/components/BoundingBoxControls.jsx) | `code, ageMs`                                                                        | Fast deletes suggest mis-clicks/UI friction; late deletes suggest judgment reversal                                                                                       |

All events also carry `device_id`, `session_id`, `task_id` (when set), and a client
timestamp `ts`, added by `telemetry.js` — not repeated per row above.

## Querying collected data

```bash
cd telemetry-worker
npx wrangler d1 execute frog-label-telemetry --remote \
  --command "SELECT * FROM events ORDER BY id DESC LIMIT 50;"
```

Useful derived views once real data exists: time-to-first-box per task, correction rate
(resizes ÷ boxes created), code-entry error rate, keyboard-shortcut adoption over a
session, and boxes-per-minute as a function of task position (the learning-curve
replication of the paper's Fig. 7).

## What's next (not yet built)

**Phase 2 — ground-truth scoring.** The three local demo clips (`green_tree.mp3`,
`perons_tree.mp3`, `red_eyed_tree.mp3`) have no reference annotations yet. Once someone
with the domain knowledge (see `Frog_ID_Instructions.pdf`) annotates them once using the
app itself, those boxes become a small fixed reference set. Phase 2 would diff each
tester's boxes against that reference per clip and log precision/recall-style deviation —
turning "what testers did" into "how accurate testers were," without needing real Label
Studio data. Deferred until: (a) reference boxes are actually defined, and (b) Phase 1 has
collected enough real usage to be worth cross-referencing against.
