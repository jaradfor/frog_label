# Project initialization and synchronization

Hydra composes operator intent once; strict Pydantic validation completes before any target mutation. Codes are uppercase three-letter ASCII and unique case-insensitively. Full Species Name and immutable `speciesId` are required. Empty catalog and no default are valid.

## CE 1.23.0

Run these commands with `froglabel-cli` installed in the same Python environment as the prepared
Label Studio checkout. Each command verifies the runnable derived build, then creates its own clean
Django subprocess using the supplied source and server data directory. Do not export Django
settings or `PYTHONPATH` manually.

```bash
froglabel project init --target ce --project 1 \
  --source /src/label-studio-1.23.0 --data-dir /var/lib/froglabel-ce \
  --config-dir /src/froglabel/examples/configs --config-name demo-seeded

froglabel project sync --target ce --project 1 \
  --source /src/label-studio-1.23.0 --data-dir /var/lib/froglabel-ce \
  --config-dir /src/froglabel/examples/configs --config-name sync-after --dry-run

froglabel project sync --target ce --project 1 \
  --source /src/label-studio-1.23.0 --data-dir /var/lib/froglabel-ce \
  --config-dir /src/froglabel/examples/configs --config-name sync-after --apply

froglabel project validate --target ce --project 1 \
  --source /src/label-studio-1.23.0 --data-dir /var/lib/froglabel-ce \
  --config-dir /src/froglabel/examples/configs --config-name sync-after
```

Initialization installs the supported label config, disables blank outer annotations, creates a project-scoped descriptor and species records, then fresh-reads and validates. Transactions and row locks prevent partial init/sync; semantic no-op and dry-run do not increment `catalogRevision`. Config removal retains species. Ecologist additions remain ordinary entries with `addedAfterInitialization: true`. An unmanaged immutable-ID collision requires explicit `adoptExisting: true`. Clone mismatch blocks with the explicit `--repair-clone` command.

## Enterprise offline state

```bash
froglabel project init --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise

froglabel project sync --target enterprise \
  --config-dir examples/configs --config-name enterprise-seeded \
  --output-dir dist/enterprise --dry-run
```

Enterprise commands only update local state/artifacts. They render `froglabel.enterprise.jsx`, its checksum manifest, and the embedded catalog. `catalogId` and initialization time remain stable; revision changes only after an applied semantic change. Native export reconciliation produces a proposed YAML fragment but never silently changes Hydra or the website. Use the Label Studio SDK commands in [Enterprise setup](ENTERPRISE_SETUP.md) for validation, preview, and explicit publication.

The packaged `base` config and schemas resolve through Python resources, so they work outside the
repository root. Demo/client configurations under `examples/configs` are source examples; pass an
absolute `--config-dir` when using them from another current directory.
