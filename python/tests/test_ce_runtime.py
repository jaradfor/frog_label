from __future__ import annotations

import json
from pathlib import Path

import pytest

import froglabel_cli.ce_runtime as ce_runtime
from froglabel_cli import __version__
from froglabel_cli.ce_installer import (
    COMPATIBILITY_PATCH_SHA256,
    INTEGRATION_VERSION,
    SUPPORTED_COMMIT,
)
from froglabel_cli.ce_runtime import CeRuntime
from froglabel_cli.errors import FrogLabelCliError


def runtime_source(root: Path) -> Path:
    source = root / "label-studio"
    manage = source / "label_studio/manage.py"
    assets = source / "web/dist/apps/labelstudio/froglabel"
    assets.mkdir(parents=True)
    manage.parent.mkdir(parents=True, exist_ok=True)
    manage.write_text("# fixture\n", encoding="utf-8")
    (source / "pyproject.toml").write_text('[project]\nversion = "1.23.0"\n', encoding="utf-8")
    (assets / "index.html").write_text("<!doctype html>", encoding="utf-8")
    (assets / "froglabel-build-manifest.json").write_text(
        json.dumps(
            {
                "labelStudioVersion": "1.23.0",
                "labelStudioCommit": SUPPORTED_COMMIT,
                "frogLabelVersion": __version__,
                "compatibilityPatchSha256": COMPATIBILITY_PATCH_SHA256,
                "integrationVersion": INTEGRATION_VERSION,
                "staticAssetPath": "/react-app/froglabel/index.html",
                "buildStatus": "built-and-structurally-validated",
            }
        ),
        encoding="utf-8",
    )
    return source


def test_start_canary_checks_packaged_build_and_overlay(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = runtime_source(tmp_path)
    monkeypatch.setattr(ce_runtime, "_git_commit", lambda _source: SUPPORTED_COMMIT)
    calls: list[tuple[list[str], str]] = []
    runtime = CeRuntime(source)
    monkeypatch.setattr(
        runtime,
        "_run_manage",
        lambda arguments, _environment, action, **_options: calls.append((arguments, action)),
    )
    result = runtime.canary()
    assert result["catalogPathProbe"] == "/froglabel/api/projects/7/catalog/"
    assert result["integrationVersion"] == INTEGRATION_VERSION
    assert calls[0][0][:2] == ["shell", "-c"]
    environment = runtime.environment(data_dir=tmp_path / "data")
    assert environment["DJANGO_SETTINGS_MODULE"] == "froglabel_cli.ce_overlay.settings"
    assert environment["FROGLABEL_SERVE_STATIC"] == "1"
    assert environment["LABEL_STUDIO_BASE_DATA_DIR"] == str((tmp_path / "data").resolve())
    assert environment["PYTHONPATH"].split(ce_runtime.os.pathsep)[:2] == [
        str(source / "label_studio"),
        str(source),
    ]


def test_start_canary_fails_before_django_when_manifest_is_missing(tmp_path: Path) -> None:
    source = runtime_source(tmp_path)
    (source / "web/dist/apps/labelstudio/froglabel/froglabel-build-manifest.json").unlink()
    with pytest.raises(FrogLabelCliError, match="Required derived-build file is missing"):
        CeRuntime(source).canary()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("buildStatus", "structural-only"),
        ("frogLabelVersion", "0.0.0-stale"),
    ],
)
def test_start_canary_rejects_non_runnable_manifest_fields(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    value: str,
) -> None:
    source = runtime_source(tmp_path)
    manifest_path = source / "web/dist/apps/labelstudio/froglabel/froglabel-build-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest[field] = value
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    monkeypatch.setattr(ce_runtime, "_git_commit", lambda _source: SUPPORTED_COMMIT)

    with pytest.raises(FrogLabelCliError, match=field):
        CeRuntime(source).canary()


def test_start_canary_rejects_missing_index_asset(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = runtime_source(tmp_path)
    index = source / "web/dist/apps/labelstudio/froglabel/index.html"
    index.write_text(
        '<!doctype html><script src="/react-app/froglabel/assets/missing.js"></script>',
        encoding="utf-8",
    )
    monkeypatch.setattr(ce_runtime, "_git_commit", lambda _source: SUPPORTED_COMMIT)

    with pytest.raises(FrogLabelCliError, match="does not resolve inside the bundle"):
        CeRuntime(source).canary()


def test_project_administration_runs_in_derived_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = runtime_source(tmp_path)
    runtime = CeRuntime(source)
    data_dir = tmp_path / "data"
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(runtime, "canary", lambda **_options: {})

    def run(command: list[str], **options: object) -> ce_runtime.subprocess.CompletedProcess[str]:
        calls.append({"command": command, **options})
        response = {
            "ok": True,
            "result": {"target": "ce", "project": 7, "valid": True},
        }
        return ce_runtime.subprocess.CompletedProcess(
            command,
            0,
            stdout=ce_runtime._PROJECT_RESULT_PREFIX + json.dumps(response) + "\n",
            stderr="",
        )

    monkeypatch.setattr(ce_runtime.subprocess, "run", run)
    result = runtime.run_project_administration(
        command="validate",
        project_id=7,
        candidate=None,
        apply=False,
        repair_clone=False,
        data_dir=data_dir,
    )

    assert result == {"target": "ce", "project": 7, "valid": True}
    call = calls[0]
    assert call["command"] == [ce_runtime.sys.executable, "-m", "froglabel_cli.ce_admin"]
    assert call["cwd"] == source
    environment = call["env"]
    assert isinstance(environment, dict)
    assert environment["DJANGO_SETTINGS_MODULE"] == "froglabel_cli.ce_overlay.settings"
    assert environment["LABEL_STUDIO_BASE_DATA_DIR"] == str(data_dir.resolve())
    assert json.loads(str(call["input"])) == {
        "command": "validate",
        "project": 7,
        "candidate": None,
        "apply": False,
        "repairClone": False,
    }


def test_project_administration_preserves_child_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = runtime_source(tmp_path)
    runtime = CeRuntime(source)
    monkeypatch.setattr(runtime, "canary", lambda **_options: {})
    response = {
        "ok": False,
        "error": {
            "code": "PROJECT_NOT_FOUND",
            "message": "Label Studio project 7 does not exist",
            "context": {"repair": "Create the project first"},
        },
    }
    monkeypatch.setattr(
        ce_runtime.subprocess,
        "run",
        lambda command, **_options: ce_runtime.subprocess.CompletedProcess(
            command,
            0,
            stdout=ce_runtime._PROJECT_RESULT_PREFIX + json.dumps(response) + "\n",
            stderr="",
        ),
    )

    with pytest.raises(FrogLabelCliError) as captured:
        runtime.run_project_administration(
            command="validate",
            project_id=7,
            candidate=None,
            apply=False,
            repair_clone=False,
            data_dir=tmp_path / "data",
        )
    assert captured.value.code == "PROJECT_NOT_FOUND"
    assert captured.value.context.repair == "Create the project first"
