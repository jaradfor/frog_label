# Label Studio Enterprise website-only setup

FrogLabel Enterprise is one deterministic self-contained inline ReactCode XML. It uses no external `src`, FrogLabel server, CDN, API token, VM access, SSH, Docker action, hidden endpoint, or parent-DOM manipulation.

## Generate offline

```bash
froglabel project init --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise

froglabel project validate --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise
```

These commands mutate only local files and explicitly report that the remote project was unchanged/not contacted. They generate minimal and capability canaries, `froglabel.enterprise.xml`, a manifest, and embedded catalog.

## Website Gate 0

Only with explicit authorization and a disposable synthetic-data project:

1. Sign in as a Manager, Administrator, or Owner.
2. Open Project Settings → Labeling Interface → Code and save the current XML for rollback.
3. Paste/save the minimal canary, then prove native add/update/delete/no-calls, Submit/Update, reload, and export.
4. Paste/save the capability canary and verify canvas, pointer, CSS/SVG, Web Audio, object URL, Blob worker or cooperative fallback, cleanup, CSP, and network behavior.
5. Paste/save `froglabel.enterprise.xml` and complete the full audio, task/annotation switch, lock/hide/review, Task Summary, history, export, and rapid edit→Submit checks.
6. Record the visible version, role, timings, artifact size, logs, and exact export. Roll back immediately on any hard stop.

Ecologist-added species are annotation-local snapshots. To promote them, export native JSON, run `project sync --target enterprise --dry-run --label-studio-export ... --reconciliation-output ...`, review the proposed Hydra fragment, then apply, regenerate, paste, and reopen an existing annotation. A cloned project needs a separate local state/catalog ID. Replacing the XML never rewrites existing annotation documents; rollback is restoring the saved prior XML.

Until those website checks pass, the only valid label is: **Enterprise paste-ready; exact-instance Gate 0 unverified.**
