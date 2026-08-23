from __future__ import annotations

import json
import os
import subprocess
import sys
import tomllib
from pathlib import Path
from typing import Any

from . import __version__
from .ce_installer import (
    COMPATIBILITY_PATCH_SHA256,
    INTEGRATION_VERSION,
    SUPPORTED_COMMIT,
    SUPPORTED_VERSION,
    _git_commit,
    _repair_context,
    _validate_asset_tree,
)
from .errors import ErrorContext, FrogLabelCliError

_PROJECT_RESULT_PREFIX = "FROGLABEL_CE_PROJECT_RESULT="


class CeRuntime:
    """Fail-fast launcher for the exact FrogLabel CE derived build."""

    def __init__(self, source: Path):
        try:
            self.source = source.expanduser().resolve(strict=True)
        except (FileNotFoundError, OSError) as error:
            raise FrogLabelCliError(
                "CE_START_SOURCE", f"Label Studio source directory is unavailable: {error}"
            ) from error
        self.manage = self.source / "label_studio/manage.py"
        self.assets = self.source / "web/dist/apps/labelstudio/froglabel"
        self.manifest_path = self.assets / "froglabel-build-manifest.json"

    def canary(self, *, data_dir: Path | None = None) -> dict[str, Any]:
        for path in (self.manage, self.assets / "index.html", self.manifest_path):
            if not path.is_file():
                raise FrogLabelCliError(
                    "CE_START_CANARY_MISSING",
                    f"Required derived-build file is missing: {path.relative_to(self.source)}",
                    context=_repair_context(),
                )

        pyproject = self.source / "pyproject.toml"
        if not pyproject.is_file():
            raise FrogLabelCliError(
                "CE_START_CANARY_MISSING", "Label Studio pyproject.toml is missing"
            )
        with pyproject.open("rb") as stream:
            version = str(tomllib.load(stream).get("project", {}).get("version", ""))
        commit = _git_commit(self.source)
        if version != SUPPORTED_VERSION or commit != SUPPORTED_COMMIT:
            raise FrogLabelCliError(
                "CE_START_VERSION_MISMATCH",
                f"Expected Label Studio {SUPPORTED_VERSION} at {SUPPORTED_COMMIT}; "
                f"found {version or 'unknown'} at {commit or 'unknown'}",
                context=_repair_context(),
            )

        try:
            manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            raise FrogLabelCliError(
                "CE_START_MANIFEST_INVALID", f"Cannot read FrogLabel build manifest: {error}"
            ) from error
        expected = {
            "labelStudioVersion": SUPPORTED_VERSION,
            "labelStudioCommit": SUPPORTED_COMMIT,
            "frogLabelVersion": __version__,
            "compatibilityPatchSha256": COMPATIBILITY_PATCH_SHA256,
            "integrationVersion": INTEGRATION_VERSION,
            "staticAssetPath": "/react-app/froglabel/index.html",
            "buildStatus": "built-and-structurally-validated",
        }
        mismatches = [
            f"{name}={manifest.get(name)!r} (expected {value!r})"
            for name, value in expected.items()
            if manifest.get(name) != value
        ]
        if mismatches:
            raise FrogLabelCliError(
                "CE_START_MANIFEST_MISMATCH",
                "Installed FrogLabel build does not match this launcher: " + "; ".join(mismatches),
                context=_repair_context(),
            )
        _validate_asset_tree(self.assets)

        environment = self.environment(data_dir=data_dir)
        self._run_manage(
            [
                "shell",
                "-c",
                (
                    "from django.conf import settings; from django.urls import reverse; "
                    "assert settings.ROOT_URLCONF == 'froglabel_cli.ce_overlay.urls'; "
                    f"assert settings.FROGLABEL_CE_INTEGRATION_VERSION == {INTEGRATION_VERSION}; "
                    "assert reverse('froglabel-project-catalog', kwargs={'project_id': 7}) "
                    "== '/froglabel/api/projects/7/catalog/'"
                ),
            ],
            environment,
            "project catalog URL/settings canary",
        )
        return {
            "kind": "froglabel.label-studio-ce-start-canary",
            "schemaVersion": 1,
            "labelStudioVersion": SUPPORTED_VERSION,
            "labelStudioCommit": SUPPORTED_COMMIT,
            "frogLabelVersion": manifest.get("frogLabelVersion"),
            "integrationVersion": INTEGRATION_VERSION,
            "staticAssetPath": "/react-app/froglabel/index.html",
            "catalogPathProbe": "/froglabel/api/projects/7/catalog/",
            "settingsModule": "froglabel_cli.ce_overlay.settings",
        }

    def run_project_administration(
        self,
        *,
        command: str,
        project_id: int,
        candidate: dict[str, Any] | None,
        apply: bool,
        repair_clone: bool,
        data_dir: Path,
    ) -> dict[str, Any]:
        """Run one CE project operation in a clean derived-build subprocess."""

        self.canary(data_dir=data_dir)
        request = {
            "command": command,
            "project": project_id,
            "candidate": candidate,
            "apply": apply,
            "repairClone": repair_clone,
        }
        environment = self.environment(data_dir=data_dir)
        try:
            completed = subprocess.run(
                [sys.executable, "-m", "froglabel_cli.ce_admin"],
                cwd=self.source,
                env=environment,
                input=json.dumps(request),
                capture_output=True,
                text=True,
                check=False,
                timeout=300,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise FrogLabelCliError(
                "CE_PROJECT_COMMAND_FAILED",
                f"Cannot run FrogLabel CE project administration: {error}",
                context=_repair_context(),
            ) from error

        payload_line = next(
            (
                line[len(_PROJECT_RESULT_PREFIX) :]
                for line in reversed(completed.stdout.splitlines())
                if line.startswith(_PROJECT_RESULT_PREFIX)
            ),
            None,
        )
        if payload_line is None:
            detail = completed.stderr.strip() or completed.stdout.strip() or "no child output"
            raise FrogLabelCliError(
                "CE_PROJECT_COMMAND_FAILED",
                "Derived CE project administration did not return a valid result: " + detail,
                context=_repair_context(),
            )
        try:
            response = json.loads(payload_line)
        except ValueError as error:
            raise FrogLabelCliError(
                "CE_PROJECT_PROTOCOL_INVALID",
                f"Derived CE project administration returned invalid JSON: {error}",
                context=_repair_context(),
            ) from error
        if not isinstance(response, dict):
            raise FrogLabelCliError(
                "CE_PROJECT_PROTOCOL_INVALID",
                "Derived CE project administration returned a non-object result",
                context=_repair_context(),
            )
        if response.get("ok") is False:
            child_error = response.get("error")
            if not isinstance(child_error, dict):
                raise FrogLabelCliError(
                    "CE_PROJECT_PROTOCOL_INVALID",
                    "Derived CE project administration returned an invalid error",
                    context=_repair_context(),
                )
            raw_context = child_error.get("context")
            context = ErrorContext(
                **{
                    key: value
                    for key, value in (raw_context if isinstance(raw_context, dict) else {}).items()
                    if key in {"source", "record", "pointer", "repair"}
                }
            )
            raise FrogLabelCliError(
                str(child_error.get("code") or "CE_PROJECT_COMMAND_FAILED"),
                str(child_error.get("message") or "CE project administration failed"),
                context=context,
            )
        result = response.get("result")
        if response.get("ok") is not True or not isinstance(result, dict):
            raise FrogLabelCliError(
                "CE_PROJECT_PROTOCOL_INVALID",
                "Derived CE project administration returned an invalid success result",
                context=_repair_context(),
            )
        if completed.returncode != 0:
            raise FrogLabelCliError(
                "CE_PROJECT_COMMAND_FAILED",
                f"Derived CE project administration exited with status {completed.returncode}",
                context=_repair_context(),
            )
        return result

    def start(self, *, bind: str, data_dir: Path | None = None) -> dict[str, Any]:
        result = self.canary(data_dir=data_dir)
        environment = self.environment(data_dir=data_dir)
        self._run_manage(["migrate", "--noinput"], environment, "database migration", timeout=900)
        self._run_manage(
            ["collectstatic", "--noinput", "--verbosity", "0"],
            environment,
            "static asset collection",
            timeout=900,
        )
        self._run_manage(
            ["runserver", "--noreload", "--nostatic", bind],
            environment,
            "Label Studio server",
            timeout=None,
        )
        return {**result, "bind": bind, "status": "server-stopped"}

    def environment(self, *, data_dir: Path | None = None) -> dict[str, str]:
        environment = os.environ.copy()
        python_paths = [str(self.source / "label_studio"), str(self.source)]
        if environment.get("PYTHONPATH"):
            python_paths.append(environment["PYTHONPATH"])
        environment.update(
            {
                "COLLECT_ANALYTICS": "0",
                "DJANGO_SETTINGS_MODULE": "froglabel_cli.ce_overlay.settings",
                "FROGLABEL_SERVE_STATIC": "1",
                "LATEST_VERSION_CHECK": "0",
                "PYTHONPATH": os.pathsep.join(python_paths),
                "SENTRY_DSN": "",
            }
        )
        if data_dir is not None:
            environment["LABEL_STUDIO_BASE_DATA_DIR"] = str(data_dir.expanduser().resolve())
        return environment

    def _run_manage(
        self,
        arguments: list[str],
        environment: dict[str, str],
        action: str,
        *,
        timeout: int | None = 120,
    ) -> None:
        launcher = (
            "import runpy, sys; "
            f"sys.path.insert(0, {str(self.source / 'label_studio')!r}); "
            f"sys.argv = [{str(self.manage)!r}, *sys.argv[1:]]; "
            f"runpy.run_path({str(self.manage)!r}, run_name='__main__')"
        )
        try:
            subprocess.run(
                [sys.executable, "-c", launcher, *arguments],
                cwd=self.source,
                env=environment,
                check=True,
                timeout=timeout,
            )
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            raise FrogLabelCliError(
                "CE_START_FAILED",
                f"FrogLabel CE {action} failed before a usable labeling page was served: {error}",
                context=_repair_context(),
            ) from error
