# Label Studio CE 1.23.0 installation

FrogLabel supports exactly official Label Studio CE `1.23.0`, commit
`2a9bfbcbf0a844b999de97e601d16050a893f5fb`. Other versions fail before mutation. This
is a reproducible derived build, not a maintained Label Studio fork.

Requirements: Python 3.11+, Node 22.x, Yarn 1.22.x, and the exact upstream checkout. Work
in a disposable source copy or derived image.

Build the deterministic FrogLabel iframe assets from the FrogLabel source tree:

```bash
npm ci
npm run build:ce
```

Install `froglabel-cli` into the same Python environment as Label Studio, then run the one
supported prepare/build command. The patch and adapter are package resources, so the command
works from any current directory and does not accept repository-relative integration paths.

```bash
cd /tmp
froglabel ls-ce prepare \
  --source /src/label-studio-1.23.0 \
  --assets /src/froglabel/build/ce
```

`prepare` verifies the exact commit, detects pristine/already-applied/conflicting patch states,
atomically applies the pinned 14-file compatibility patch, verifies Node/Yarn, performs the
frozen upstream frontend build, installs FrogLabel assets after Nx finishes, and writes
`froglabel-build-manifest.json`. Repeating the command is idempotent. A conflict stops before
patch mutation and names the failing file/hunk. The `install` spelling remains an alias for
existing runbooks. `--skip-build` is a structural diagnostic and is not runnable-build proof.

For the locally hosted/trusted POC, start Label Studio through the supported wrapper:

```bash
froglabel ls-ce start \
  --source /src/label-studio-1.23.0 \
  --data-dir /var/lib/froglabel-ce \
  --bind 127.0.0.1:8080
```

Before serving, the wrapper verifies the runnable-build status, build manifest, iframe index and
all of its local asset references, exact Label Studio and FrogLabel integration versions, Django
overlay settings, and project-catalog URL namespace. It then migrates the database, collects static
files, and starts the overlay. Use `--check-only` for an administrator canary without starting the
server. There is no fallback UI or runtime source patching.

This wrapper deliberately uses Django's development `runserver` for the initial local human-demo
environment. Do not expose it as an Internet-facing production service; a later deployment pass
can place the same verified overlay behind the organization's normal WSGI/proxy stack.

Initialize and synchronize projects with the same explicit source and data directory; the command
constructs the derived Django environment itself:

```bash
cd /tmp
froglabel project init --target ce --project 1 \
  --source /src/label-studio-1.23.0 \
  --data-dir /var/lib/froglabel-ce \
  --config-dir /src/froglabel/examples/configs \
  --config-name demo-seeded
```

The generated labeling config is:

```xml
<View>
  <View style="display:none">
    <Text name="froglabel_data_key" value="$froglabel" />
  </View>
  <ReactCode
    name="froglabel"
    toName="froglabel"
    src="/react-app/froglabel/index.html"
    style='{"height":"calc(100vh - 210px)","minHeight":"620px"}'
    outputs="...canonical JSON schema..."
  />
</View>
```

Projects must set `enable_empty_annotation=false`; FrogLabel's explicit no-calls document is
nonempty while a truly blank task remains unreviewed and cannot submit.

Run `scripts/test-ce-served-agent.mjs` twice against a fresh installation produced by these exact
commands. A structural pass, WSGI-only pass, or static HTTP 200 is not sufficient.
