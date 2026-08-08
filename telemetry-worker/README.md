# frog-label-telemetry

Cloudflare Worker + D1 ingest endpoint for anonymous, automatic usage telemetry from the
FrogLabel web app. Kept as its own package so it never touches the frontend's `size-limit`
bundle budget.

- Live endpoint: `https://frog-label-telemetry.e4e-telemetry.workers.dev`
- `POST /events` — accepts a batch of events, validated and inserted into D1 (`events` table).
- `GET /health` — liveness check.
- CORS is restricted to `ALLOWED_ORIGINS` in `wrangler.jsonc` (the deployed GitHub Pages
  origin + local Vite dev ports). This is a courtesy filter for browser noise, not real
  access control — the endpoint is an intentionally public write-only ingest sink, same
  trust model as a PostHog/Sentry ingest key. No secret gates writes.

## Commands

```bash
npm install          # installs wrangler locally
npm run dev           # local dev server (uses local D1 simulation)
npm run deploy         # deploy to Cloudflare
npm run tail            # stream live logs from the deployed Worker
```

## Schema changes

```bash
npx wrangler d1 migrations create frog-label-telemetry <name>
npx wrangler d1 migrations apply frog-label-telemetry --local   # test locally first
npx wrangler d1 migrations apply frog-label-telemetry --remote  # then apply for real
```

## Querying collected data

```bash
npx wrangler d1 execute frog-label-telemetry --remote --command "SELECT * FROM events ORDER BY id DESC LIMIT 50;"
```

## Client wiring

The frontend's `src/telemetry/` module (`identity.js`, `telemetry.js`) posts here via
`navigator.sendBeacon` (falling back to `fetch(..., { keepalive: true })`). It only sends
from production builds by default — set `VITE_TELEMETRY_FORCE=true` locally to test the
pipeline from `npm run dev`. The endpoint URL can be overridden with `VITE_TELEMETRY_URL`.
