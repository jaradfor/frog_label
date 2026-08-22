from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tomllib
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib.resources import files
from pathlib import Path
from typing import Any

from . import __version__
from .errors import FrogLabelCliError

IMPORT_LINE = 'import "./integrations/froglabel-reactcode-ce";'
ANCHOR_LINE = 'import { LabelStudio } from "./LabelStudio";'
SUPPORTED_VERSION = "1.23.0"
SUPPORTED_COMMIT = "2a9bfbcbf0a844b999de97e601d16050a893f5fb"
COMPATIBILITY_PATCH_SHA256 = "7fa73be6b3481249e83edaf2c8e7cf9595fff6bedce0a5f9025e45b1a8024bdb"
INTEGRATION_VERSION = 2
REQUIRED_NODE_MAJOR = 22
REQUIRED_YARN_SERIES = (1, 22)


@dataclass(frozen=True, slots=True)
class InstallManifest:
    label_studio_version: str
    label_studio_commit: str | None
    froglabel_version: str
    protocol_version: int
    schema_version: int
    installed_at: str
    source_import: str
    static_asset_path: str
    build_status: str
    compatibility_patch_sha256: str
    compatibility_patch_state: str
    integration_version: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": "froglabel.label-studio-ce-install",
            "schemaVersion": 1,
            "labelStudioVersion": self.label_studio_version,
            "labelStudioCommit": self.label_studio_commit,
            "frogLabelVersion": self.froglabel_version,
            "reactCodeProtocolVersion": self.protocol_version,
            "documentSchemaVersion": self.schema_version,
            "installedAt": self.installed_at,
            "sourceImport": self.source_import,
            "staticAssetPath": self.static_asset_path,
            "buildStatus": self.build_status,
            "compatibilityPatchSha256": self.compatibility_patch_sha256,
            "compatibilityPatchState": self.compatibility_patch_state,
            "integrationVersion": self.integration_version,
        }


class CeSourceInstaller:
    """Idempotent derived-build installer for the exact pinned CE patch."""

    def __init__(self, source: Path, assets: Path, *, patch_source: Path | None = None):
        try:
            self.source = source.expanduser().resolve(strict=True)
            self.assets = assets.expanduser().resolve(strict=True)
        except (FileNotFoundError, OSError) as error:
            raise FrogLabelCliError(
                "CE_INSTALL_PATH", f"Source or compiled asset path is unavailable: {error}"
            ) from error
        if not self.source.is_dir() or not self.assets.is_dir():
            raise FrogLabelCliError(
                "CE_INSTALL_PATH", "Source and compiled asset paths must be directories"
            )
        if not (self.assets / "index.html").is_file():
            raise FrogLabelCliError(
                "CE_ASSETS_INVALID", "Compiled FrogLabel assets must contain index.html"
            )
        self.editor_entry = self.source / "web/libs/editor/src/index.js"
        self.registry = self.source / "web/libs/editor/src/core/Registry.ts"
        self.feature_flags = self.source / "label_studio/feature_flags.json"
        self.pyproject = self.source / "pyproject.toml"
        self.target_adapter = (
            self.source / "web/libs/editor/src/integrations/froglabel-reactcode-ce"
        )
        self.runtime_target = self.source / "web/dist/apps/labelstudio/froglabel"
        try:
            self.packaged_patch = patch_source is None
            self.patch_bytes = (
                patch_source.expanduser().resolve(strict=True).read_bytes()
                if patch_source is not None
                else files("froglabel_cli")
                .joinpath("resources/label-studio-ce-1.23.0.patch")
                .read_bytes()
            )
        except (FileNotFoundError, OSError) as error:
            raise FrogLabelCliError(
                "CE_PATCH_RESOURCE_MISSING",
                f"The packaged Label Studio CE compatibility patch is unavailable: {error}",
                context=_repair_context(),
            ) from error

    def inspect(self) -> str:
        for path in (self.editor_entry, self.registry, self.feature_flags, self.pyproject):
            if not path.is_file():
                raise FrogLabelCliError(
                    "CE_STRUCTURE_MISSING",
                    "Expected Label Studio source capability is missing: "
                    f"{path.relative_to(self.source)}",
                    context=_repair_context(),
                )
        with self.pyproject.open("rb") as stream:
            project = tomllib.load(stream).get("project", {})
        version = str(project.get("version", ""))
        if version != SUPPORTED_VERSION:
            raise FrogLabelCliError(
                "CE_VERSION_UNSUPPORTED",
                f"Detected Label Studio {version}; exact supported version is {SUPPORTED_VERSION}",
                context=_repair_context(),
            )
        commit = _git_commit(self.source)
        if commit != SUPPORTED_COMMIT:
            raise FrogLabelCliError(
                "CE_COMMIT_UNSUPPORTED",
                f"Detected source commit {commit or 'unavailable'}; exact supported commit is "
                f"{SUPPORTED_COMMIT}",
                context=_repair_context(),
            )
        registry = self.registry.read_text(encoding="utf-8")
        if "addCustomTag" not in registry or "customTags" not in registry:
            raise FrogLabelCliError(
                "CE_REGISTRY_CAPABILITY_MISSING",
                "Registry.addCustomTag/customTags support was not found",
                context=_repair_context(),
            )
        flags = json.loads(self.feature_flags.read_text(encoding="utf-8"))
        flag_store = flags.get("flags", flags) if isinstance(flags, dict) else {}
        flag = flag_store.get("fflag_feat_front_bros_194_custom_tags_short")
        if (
            not isinstance(flag, dict)
            or flag.get("on") is not True
            or flag.get("variations", [None])[0] is not True
        ):
            raise FrogLabelCliError(
                "CE_CUSTOM_TAGS_DISABLED",
                "Required custom-tags feature flag is absent or disabled by default",
                context=_repair_context(),
            )
        return version

    def install(self, *, build: bool = True) -> InstallManifest:
        version = self.inspect()
        patch_state = self._apply_compatibility_patch()
        self._validate_installed_structure()
        status = "structural-only"
        if build:
            self._build()
            status = "built-and-structurally-validated"
        # Nx owns and may clean web/dist during the build. Install FrogLabel only
        # after it succeeds, into the directory actually served at /react-app/.
        _replace_owned_tree(self.assets, self.runtime_target)
        if not (self.runtime_target / "index.html").is_file():
            raise FrogLabelCliError(
                "CE_RUNTIME_ASSETS_MISSING",
                "FrogLabel assets were not installed into Label Studio's /react-app output",
            )
        manifest = InstallManifest(
            label_studio_version=version,
            label_studio_commit=SUPPORTED_COMMIT,
            froglabel_version=__version__,
            protocol_version=1,
            schema_version=1,
            installed_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            source_import=str(self.editor_entry.relative_to(self.source)),
            static_asset_path="/react-app/froglabel/index.html",
            build_status=status,
            compatibility_patch_sha256=COMPATIBILITY_PATCH_SHA256,
            compatibility_patch_state=patch_state,
            integration_version=INTEGRATION_VERSION,
        )
        manifest_path = self.runtime_target / "froglabel-build-manifest.json"
        manifest_path.write_text(
            json.dumps(manifest.as_dict(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
        return manifest

    def _apply_compatibility_patch(self) -> str:
        import hashlib

        digest = hashlib.sha256(self.patch_bytes).hexdigest()
        if self.packaged_patch and digest != COMPATIBILITY_PATCH_SHA256:
            raise FrogLabelCliError(
                "CE_PATCH_RESOURCE_INVALID",
                f"Packaged CE patch digest {digest} does not match {COMPATIBILITY_PATCH_SHA256}",
                context=_repair_context(),
            )

        forward = self._git_apply("--check")
        if forward.returncode == 0:
            applied = self._git_apply()
            if applied.returncode != 0:
                raise FrogLabelCliError(
                    "CE_PATCH_APPLY_FAILED",
                    _patch_failure_message(applied),
                    context=_repair_context(),
                )
            return "applied"

        reverse = self._git_apply("--reverse", "--check")
        if reverse.returncode == 0:
            return "already-applied"

        raise FrogLabelCliError(
            "CE_PATCH_CONFLICT",
            _patch_failure_message(forward),
            context=_repair_context(),
        )

    def _git_apply(self, *arguments: str) -> subprocess.CompletedProcess[bytes]:
        try:
            return subprocess.run(
                ["git", "apply", "--whitespace=nowarn", *arguments, "-"],
                cwd=self.source,
                input=self.patch_bytes,
                capture_output=True,
                check=False,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise FrogLabelCliError(
                "CE_PATCH_TOOL_FAILED",
                f"Cannot inspect the pinned CE patch with git apply: {error}",
                context=_repair_context(),
            ) from error

    def _validate_installed_structure(self) -> None:
        text = self.editor_entry.read_text(encoding="utf-8")
        if text.count(IMPORT_LINE) != 1 or text.index(IMPORT_LINE) > text.index(ANCHOR_LINE):
            raise FrogLabelCliError(
                "CE_IMPORT_VALIDATION", "Installed side-effect import failed validation"
            )
        adapter = self.target_adapter / "index.jsx"
        if not adapter.is_file():
            raise FrogLabelCliError(
                "CE_ADAPTER_MISSING", "Owned CE adapter index.jsx was not copied"
            )
        source = adapter.read_text(encoding="utf-8")
        canaries = {
            "ReactCode registration": (
                "Registry.addCustomTag" in source
                and ("'ReactCode'" in source or '"ReactCode"' in source)
            ),
            "ReactCode model identity": ".compose('ReactCodeModel'" in source
            or '.compose("ReactCodeModel"' in source,
            "reactcode result": (
                "resultName: 'reactcode'" in source or 'resultName: "reactcode"' in source
            ),
            "frozen result value": "types.frozen()" in source,
            "native region model": "ReactCodeRegionModel" in source,
            "native region detector": "snapshot?.value?.reactcode" in source,
            "annotation binding": (
                "AnnotationMixin" in source
                and "ControlBase, ReactCodeAttrs, AnnotationMixin" in source
            ),
            "source-window guard": "event.source !== frame.contentWindow" in source,
            "same-origin guard": "event.origin !== window.location.origin" in source,
        }
        missing = [name for name, present in canaries.items() if not present]
        if missing:
            raise FrogLabelCliError(
                "CE_ADAPTER_CANARY", f"Adapter is missing required canaries: {', '.join(missing)}"
            )

    def _build(self) -> None:
        web = self.source / "web"
        if not (web / "yarn.lock").is_file():
            raise FrogLabelCliError("CE_BUILD_LOCKFILE", "Label Studio web/yarn.lock is missing")
        self._validate_build_tools(web)
        environment = os.environ.copy()
        build_defaults = {
            "CI": "1",
            "CYPRESS_INSTALL_BINARY": "0",
            "NX_DAEMON": "false",
            "NX_ISOLATE_PLUGINS": "false",
            "NX_NATIVE_COMMAND_RUNNER": "false",
            "NODE_OPTIONS": "--max-old-space-size=4096",
            "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1",
        }
        for name, value in build_defaults.items():
            environment.setdefault(name, value)
        commands = (["yarn", "install", "--frozen-lockfile"], ["yarn", "ls:build"])
        for command in commands:
            try:
                subprocess.run(
                    command,
                    cwd=web,
                    check=True,
                    env=environment,
                    timeout=3600,
                )
            except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                raise FrogLabelCliError(
                    "CE_BUILD_FAILED",
                    f"Derived Label Studio build failed while running {' '.join(command)}: {error}",
                    context=_repair_context(),
                ) from error

    def _validate_build_tools(self, web: Path) -> None:
        # Corepack chooses a package manager from the nearest package.json.
        # Probe from Label Studio's Yarn workspace rather than FrogLabel's npm
        # workspace, or a correct Yarn shim is rejected before the build starts.
        node_version = _command_version(["node", "--version"], "Node", cwd=web)
        yarn_version = _command_version(["yarn", "--version"], "Yarn", cwd=web)
        node = _numeric_version(node_version, "Node")
        yarn = _numeric_version(yarn_version, "Yarn")
        if node[0] != REQUIRED_NODE_MAJOR or yarn[:2] != REQUIRED_YARN_SERIES:
            raise FrogLabelCliError(
                "CE_BUILD_TOOLCHAIN",
                "Label Studio CE 1.23.0 requires Node 22.x and Yarn 1.22.x; "
                f"detected Node {node_version} and Yarn {yarn_version}",
                context=_repair_context(),
            )


def _copy_owned_tree(source: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    source_root = source.resolve(strict=True)
    target_root = target.resolve(strict=True)
    for path in sorted(source_root.rglob("*")):
        if path.is_symlink():
            raise FrogLabelCliError(
                "CE_INSTALL_SYMLINK", f"Symlinks are forbidden in copied assets: {path}"
            )
        relative = path.relative_to(source_root)
        destination = (target_root / relative).resolve()
        if target_root not in destination.parents and destination != target_root:
            raise FrogLabelCliError(
                "CE_INSTALL_TRAVERSAL", f"Copy path escaped owned target: {relative}"
            )
        if path.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
        elif path.is_file():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, destination)


def _replace_owned_tree(source: Path, target: Path) -> None:
    """Stage, validate, then atomically replace only FrogLabel's owned asset subtree."""

    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    stage = parent / f".{target.name}.stage-{uuid.uuid4().hex}"
    try:
        _copy_owned_tree(source, stage)
        _validate_asset_tree(stage)
        previous = parent / f".{target.name}.previous-{uuid.uuid4().hex}"
        if target.exists():
            target.replace(previous)
        try:
            stage.replace(target)
        except Exception:
            if previous.exists() and not target.exists():
                previous.replace(target)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    finally:
        if stage.exists():
            shutil.rmtree(stage)


def _validate_asset_tree(root: Path) -> None:
    entry = root / "index.html"
    if not entry.is_file():
        raise FrogLabelCliError("CE_ASSETS_INVALID", "Staged assets are missing index.html")
    text = entry.read_text(encoding="utf-8")
    references = re.findall(r'(?:src|href)=["\']([^"\']+)["\']', text)
    for reference in references:
        if reference.startswith(("data:", "#")):
            continue
        if reference.startswith(("http://", "https://", "//")):
            raise FrogLabelCliError(
                "CE_ASSET_EXTERNAL_REFERENCE",
                f"Staged index contains an external runtime asset: {reference}",
            )
        normalized = reference.split("?", 1)[0].split("#", 1)[0]
        prefix = "/react-app/froglabel/"
        relative = (
            normalized[len(prefix) :] if normalized.startswith(prefix) else normalized.lstrip("./")
        )
        candidate = (root / relative).resolve()
        resolved_root = root.resolve()
        if resolved_root not in candidate.parents or not candidate.is_file():
            raise FrogLabelCliError(
                "CE_ASSET_REFERENCE_MISSING",
                f"Staged index reference does not resolve inside the bundle: {reference}",
            )


def _git_commit(source: Path) -> str | None:
    try:
        value = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=source,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None
    return value or None


def _command_version(command: list[str], name: str, *, cwd: Path | None = None) -> str:
    try:
        value = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
            cwd=cwd,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise FrogLabelCliError(
            "CE_BUILD_TOOLCHAIN",
            f"Cannot run the required {name} tool: {error}",
            context=_repair_context(),
        ) from error
    return value


def _numeric_version(value: str, name: str) -> tuple[int, ...]:
    match = re.fullmatch(r"v?(\d+)\.(\d+)(?:\.(\d+))?.*", value)
    if match is None:
        raise FrogLabelCliError(
            "CE_BUILD_TOOLCHAIN",
            f"Cannot parse {name} version {value!r}",
            context=_repair_context(),
        )
    return tuple(int(part) for part in match.groups(default="0"))


def _repair_context():
    from .errors import ErrorContext

    return ErrorContext(
        repair=(
            "Use the clean official Label Studio CE 1.23.0 source at commit "
            f"{SUPPORTED_COMMIT} and rerun "
            "the installer; do not start the server on failure."
        )
    )


def _patch_failure_message(result: subprocess.CompletedProcess[bytes]) -> str:
    detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
    relevant = [
        line
        for line in detail.splitlines()
        if "patch failed:" in line or "does not apply" in line or "error:" in line
    ]
    concise = "; ".join(relevant[:4]) or detail[:800] or "git apply reported a conflict"
    return f"Pinned CE compatibility patch cannot be applied atomically: {concise}"
