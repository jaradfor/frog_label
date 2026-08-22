# Dependencies and licenses

Lockfiles are authoritative for exact transitive versions.

## Browser runtime

| Package           | Purpose                                                                                   | License |
| ----------------- | ----------------------------------------------------------------------------------------- | ------- |
| React / React DOM | Shared workspace UI; Enterprise injects the host's React instead of bundling another copy | MIT     |
| Ajv / ajv-formats | Runtime schema validation                                                                 | MIT     |

The artifacts contain no runtime CDN, web font, analytics SDK, model runtime, or telemetry client.

## Development and operator runtime

Vite, TypeScript, Vitest, Playwright, axe-core, fast-check, ESLint, Prettier, and size-limit are development dependencies. The Python operator uses Pydantic v2, Hydra/OmegaConf, PyYAML, and Label Studio's own Django ORM in CE mode. pytest and Ruff are development-only. See `package-lock.json` and `pyproject.toml` for constraints.

Label Studio CE source is not included in the implemented source archive. The separate patch applies only to independently obtained Apache-2.0 Label Studio CE 1.23.0 source; preserve its LICENSE/NOTICE. The synthetic tutorial WAV is original deterministic synthesis and is described in `TUTORIAL_AUDIO_PROVENANCE.md` and `public/audio/LICENSE.txt`.

The repository software is licensed under the root `LICENSE`. The deployed demo includes the
FrogID/FrogLabel logo supplied with the baseline; the project owner must confirm authorization
to publish that client branding before making GitHub Pages public. Unused legacy audio and cursor
assets are not copied into Pages or CE runtime artifacts, but their provenance should be resolved
before redistributing the complete source repository outside the project team.
