# Label Studio Enterprise Interface setup

FrogLabel Enterprise is one deterministic, self-contained HumanSignal Interface JSX file. It renders the same `FrogLabelWorkspace` used by the standalone and CE targets; only the host adapter differs. The Interface exports `specVersion`, parameter/input/output schemas, and lossless `getResults`/`parseResults` serializers. It has no external `src`, FrogLabel server, CDN, embedded API token, parent-DOM manipulation, or task/annotation REST client.

## Build and validate locally

Rebuild the shared application bundle whenever TypeScript, CSS, schemas, icons, or tutorial audio change, then render the project-specific embedded catalog:

```bash
npm run build:enterprise-bundle

froglabel project init --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise

froglabel project validate --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise

label-studio-sdk interface validate dist/enterprise/froglabel.enterprise.jsx
```

The FrogLabel CLI commands above mutate only local files and explicitly report that Enterprise was not contacted. They generate:

- `froglabel.enterprise.jsx` — the publishable single-file Interface;
- `froglabel.enterprise.manifest.json` — source/build identity, checksum, size, and policy scans;
- `embedded-catalog.json` — the catalog compiled into the Interface;
- `.froglabel-enterprise-state.json` — stable local catalog administration state.

## Preview the exact artifact

Set credentials in the shell without committing them:

```bash
export LABEL_STUDIO_URL="https://app.heartex.com"
export LABEL_STUDIO_API_KEY="<your token>"

label-studio-sdk interface preview \
  dist/enterprise/froglabel.enterprise.jsx \
  --task examples/enterprise-interface-task.json
```

The sample task references checked-in audio. The SDK embeds it for preview, and FrogLabel decodes that `data:` URL directly so the hosted editor CSP does not need to allow a `fetch(data:...)` request.

Verify the full workspace—not a reduced mockup—including the toolbar, species/details/display/dataset panels, spectrogram, waveform, playback, tutorial, drawing, resize, delete, explicit No calls, read-only state, and task switch. After a draw, the shell result must be one `labels` result with `from_name: "froglabel"`, `to_name: "audio"`, and a one-item value containing the canonical `froglabel.annotation-set` document.

## Publish without creating duplicates

For the first publication, create one saved Interface:

```bash
label-studio-sdk interface sync \
  dist/enterprise/froglabel.enterprise.jsx \
  --title "FrogLabel Enterprise" \
  --workspace <workspace-id> \
  --publish
```

The SDK writes `froglabel.enterprise.jsx.ls-interface.json`. Keep that sidecar with the generated artifact. Subsequent publications should update the same saved Interface by sidecar lookup, or explicitly pass its existing ID:

```bash
label-studio-sdk interface sync \
  dist/enterprise/froglabel.enterprise.jsx \
  --id <interface-id> \
  --publish \
  --message "Describe the verified change"
```

Pin projects to the newly published stable version only after preview and result round-trip checks. Rollback is changing the project pin to its prior Interface version; it does not rewrite existing annotation documents.

## Catalog reconciliation

Ecologist-added species are annotation-local snapshots. To promote them, export native JSON and run:

```bash
froglabel project sync --target enterprise --dry-run \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise \
  --label-studio-export <export.json> \
  --reconciliation-output <proposed-species.yaml>
```

Review and adopt the proposed Hydra fragment explicitly, apply the catalog change, rebuild the Interface, preview it, and publish a new version of the same saved Interface. A cloned project needs a distinct local state/catalog ID. Existing annotations remain readable, including exports created by the retired ReactCode envelope.
