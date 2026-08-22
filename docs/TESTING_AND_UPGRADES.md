# Testing and upgrades

All browser tests are local-only. Route guards permit only the harness origin, local Label Studio, and declared local audio fixtures. Unexpected console warnings/errors, page errors, failed requests, CSP reports, or external requests fail integration evidence runs.

## Fixed gates

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

.venv/bin/pytest --junitxml=test-results/python-results.xml
.venv/bin/ruff check python
```

The standalone agent runner and Pages runner use real Chromium, real pointer/keyboard/File API actions, and the production artifact. The pinned `@sparticuz/chromium` binary is used when a Playwright-managed browser is unavailable.

`scripts/test-ce-browser-agent.mjs` is the restricted real-Django WSGI lane. `scripts/test-ce-served-agent.mjs` provisions a fresh database, migrates it, collects static assets, imports WAV/MP3 through native Label Studio, starts ordinary HTTP with service worker/CSP/static middleware, and exercises Submit, reload, Update, Task Summary, no-calls, blank rejection, export parsing, and direct ORM inspection.

`scripts/test-enterprise-inline-agent.mjs` extracts and executes the exact JavaScript CDATA from the generated Enterprise XML. This is local artifact evidence only, never evidence for a licensed website.

## CE 1.23.0 evidence

```bash
FROGLABEL_CE_SOURCE=/src/label-studio-1.23.0 \
FROGLABEL_CE_VENV=/src/label-studio-venv \
FROGLABEL_CE_EVIDENCE=test-results/playwright-label-studio-ce-served/run-1 \
node scripts/test-ce-served-agent.mjs
```

Run twice with distinct ports and evidence directories. Omit `FROGLABEL_CE_DATABASE_TEMPLATE` for at least one run so migration and provisioning begin from an empty directory. Evidence includes raw native export, canonical parse, screenshots, network/console logs, commands, and a SQLite snapshot.

The WSGI lane uses a disposable database copy and disables service-worker registration because transport is intercepted in-process. It is deliberately reported separately from normal HTTP.

## Adding a host version

Do not widen the CE allowlist from exact `1.23.0` without a clean upstream source audit, production Nx build, all fixed tests, two fresh normal-HTTP flows, direct database inspection, and export comparison. Unknown versions must fail before mutation. Enterprise compatibility is established per visible licensed website with the supplied Gate 0 canaries; a local harness cannot widen that claim.
