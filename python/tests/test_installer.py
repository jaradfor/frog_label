# Patch fixtures preserve exact diff paths and source lines.
# ruff: noqa: E501

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

import froglabel_cli.ce_installer as ce_installer
from froglabel_cli.ce_installer import (
    ANCHOR_LINE,
    IMPORT_LINE,
    SUPPORTED_COMMIT,
    CeSourceInstaller,
)
from froglabel_cli.errors import FrogLabelCliError


def source_fixture(root: Path, *, version: str = "1.23.0", anchors: int = 1) -> Path:
    source = root / "label-studio"
    entry = source / "web/libs/editor/src/index.js"
    registry = source / "web/libs/editor/src/core/Registry.ts"
    flags = source / "label_studio/feature_flags.json"
    for path in (entry, registry, flags):
        path.parent.mkdir(parents=True, exist_ok=True)
    entry.write_text("\n".join([ANCHOR_LINE] * anchors) + "\n", encoding="utf-8")
    registry.write_text(
        "class Registry { addCustomTag() {} }\nconst customTags = [];\n", encoding="utf-8"
    )
    flags.write_text(
        json.dumps(
            {
                "fflag_feat_front_bros_194_custom_tags_short": {
                    "on": True,
                    "variations": [True, False],
                }
            }
        ),
        encoding="utf-8",
    )
    (source / "pyproject.toml").write_text(f'[project]\nversion = "{version}"\n', encoding="utf-8")
    return source


def owned_inputs(root: Path) -> tuple[Path, Path]:
    adapter = root / "adapter"
    assets = root / "assets"
    adapter.mkdir()
    assets.mkdir()
    adapter.joinpath("index.jsx").write_text(
        'const ReactCodeModel = types.compose("ReactCodeModel", '
        "ControlBase, ReactCodeAttrs, AnnotationMixin);\n"
        'const ReactCodeRegionModel = types.compose("ReactCodeRegionModel", RegionsMixin, AreaMixin);\n'
        'Registry.addCustomTag("ReactCode", { resultName: "reactcode", result: types.frozen() });\n'
        "const detector = (snapshot) => Boolean(snapshot?.value?.reactcode);\n"
        "if (event.source !== frame.contentWindow || "
        "event.origin !== window.location.origin) return;\n",
        encoding="utf-8",
    )
    assets.joinpath("index.html").write_text(
        "<!doctype html><title>FrogLabel</title>", encoding="utf-8"
    )
    return adapter, assets


def compatibility_patch(root: Path) -> Path:
    patch = root / "ce.patch"
    patch.write_text(
        """diff --git a/web/libs/editor/src/index.js b/web/libs/editor/src/index.js
--- a/web/libs/editor/src/index.js
+++ b/web/libs/editor/src/index.js
@@ -1 +1,2 @@
+import \"./integrations/froglabel-reactcode-ce\";
 import { LabelStudio } from \"./LabelStudio\";
diff --git a/web/libs/editor/src/integrations/froglabel-reactcode-ce/index.jsx b/web/libs/editor/src/integrations/froglabel-reactcode-ce/index.jsx
new file mode 100644
--- /dev/null
+++ b/web/libs/editor/src/integrations/froglabel-reactcode-ce/index.jsx
@@ -0,0 +1,6 @@
+const ReactCodeModel = types.compose(\"ReactCodeModel\", ControlBase, ReactCodeAttrs, AnnotationMixin);
+const ReactCodeRegionModel = types.compose(\"ReactCodeRegionModel\", RegionsMixin, AreaMixin);
+Registry.addCustomTag(\"ReactCode\", { resultName: \"reactcode\", result: types.frozen() });
+const detector = (snapshot) => Boolean(snapshot?.value?.reactcode);
+if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
+export default ReactCodeModel;
""",
        encoding="utf-8",
    )
    return patch


@pytest.fixture(autouse=True)
def exact_supported_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ce_installer, "_git_commit", lambda _source: SUPPORTED_COMMIT)


def test_structural_install_is_idempotent(tmp_path: Path) -> None:
    source = source_fixture(tmp_path)
    _, assets = owned_inputs(tmp_path)
    installer = CeSourceInstaller(source, assets, patch_source=compatibility_patch(tmp_path))
    first = installer.install(build=False)
    second = installer.install(build=False)
    entry = (source / "web/libs/editor/src/index.js").read_text(encoding="utf-8")
    assert entry.count(IMPORT_LINE) == 1
    assert entry.index(IMPORT_LINE) < entry.index(ANCHOR_LINE)
    assert first.label_studio_version == second.label_studio_version == "1.23.0"
    assert first.label_studio_commit == second.label_studio_commit == SUPPORTED_COMMIT
    assert first.compatibility_patch_state == "applied"
    assert second.compatibility_patch_state == "already-applied"
    assert (source / "web/dist/apps/labelstudio/froglabel/index.html").is_file()


def test_installer_fails_before_mutation_on_patch_conflict(tmp_path: Path) -> None:
    source = source_fixture(tmp_path)
    entry = source / "web/libs/editor/src/index.js"
    entry.write_text(
        'import { LabelStudio as HostLabelStudio } from "./LabelStudio";\n', encoding="utf-8"
    )
    _, assets = owned_inputs(tmp_path)
    original = entry.read_bytes()
    with pytest.raises(FrogLabelCliError, match="cannot be applied atomically"):
        CeSourceInstaller(source, assets, patch_source=compatibility_patch(tmp_path)).install(
            build=False
        )
    assert entry.read_bytes() == original
    assert IMPORT_LINE not in entry.read_text(encoding="utf-8")


def test_installer_rejects_any_other_ce_version(tmp_path: Path) -> None:
    source = source_fixture(tmp_path, version="1.22.0")
    _, assets = owned_inputs(tmp_path)
    with pytest.raises(FrogLabelCliError, match=r"exact supported version is 1\.23\.0"):
        CeSourceInstaller(source, assets, patch_source=compatibility_patch(tmp_path)).install(
            build=False
        )


def test_build_uses_verified_ce_toolchain_and_sandbox_safe_nx_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = source_fixture(tmp_path)
    _, assets = owned_inputs(tmp_path)
    (source / "web/yarn.lock").write_text("# fixture\n", encoding="utf-8")
    calls: list[tuple[list[str], dict[str, object]]] = []

    def run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        output = {("node", "--version"): "v22.23.0", ("yarn", "--version"): "1.22.22"}.get(
            tuple(command), ""
        )
        return subprocess.CompletedProcess(command, 0, stdout=output)

    monkeypatch.setattr(subprocess, "run", run)
    CeSourceInstaller(source, assets, patch_source=compatibility_patch(tmp_path))._build()

    build_calls = calls[2:]
    for _, options in calls[:2]:
        assert options["cwd"] == source / "web"
    assert [command for command, _ in build_calls] == [
        ["yarn", "install", "--frozen-lockfile"],
        ["yarn", "ls:build"],
    ]
    for _, options in build_calls:
        environment = options["env"]
        assert isinstance(environment, dict)
        assert environment["NX_DAEMON"] == "false"
        assert environment["NX_ISOLATE_PLUGINS"] == "false"
        assert environment["NX_NATIVE_COMMAND_RUNNER"] == "false"
        assert environment["PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD"] == "1"


def test_build_rejects_wrong_node_major_before_yarn_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = source_fixture(tmp_path)
    _, assets = owned_inputs(tmp_path)
    (source / "web/yarn.lock").write_text("# fixture\n", encoding="utf-8")
    commands: list[list[str]] = []

    def run(command: list[str], **_: object) -> subprocess.CompletedProcess[str]:
        commands.append(command)
        output = "v24.7.0" if command[0] == "node" else "1.22.22"
        return subprocess.CompletedProcess(command, 0, stdout=output)

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(FrogLabelCliError, match=r"requires Node 22\.x and Yarn 1\.22\.x"):
        CeSourceInstaller(source, assets, patch_source=compatibility_patch(tmp_path))._build()
    assert commands == [["node", "--version"], ["yarn", "--version"]]
