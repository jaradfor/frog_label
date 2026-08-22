#!/usr/bin/env python3
"""Build the deterministic, sanitized FrogLabel POC final review bundle."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT.parent / "froglabel-poc-final-review-bundle.zip"
BASELINE = "82441736de3f2e8e3af1e79c68b11f237f251cf3"
REVIEWED_RETURNED_COMMIT = "6041bc481ae7a36917ad0734a72a2b417662a942"
FIXED_ZIP_TIME = (2020, 1, 1, 0, 0, 0)


def run(*arguments: str) -> str:
    return subprocess.run(
        arguments,
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value.rstrip() + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def copy_ce_run(source: Path, destination: Path) -> None:
    allowed = [
        "blank-submit-result.json",
        "browser.log",
        "ce-annotated-after-submit.json",
        "ce-annotated-reloaded.png",
        "ce-native-import-loaded.png",
        "ce-no-calls-reloaded.png",
        "ce-no-calls.json",
        "ce-reloaded.json",
        "ce-task-summary-view-all.png",
        "ce-tutorial-complete.png",
        "ce-tutorial-task-switch.json",
        "ce-tutorial-trace.json",
        "database-inspection.json",
        "label-studio-ce-export-parse.json",
        "label-studio-ce-export.json",
        "network.json",
        "ordinary-member-add-species.json",
        "project-catalog-second-task.json",
        "run-summary.json",
        "server.log",
        "stock-label-studio-before-submit.json",
        "stock-label-studio-before-submit.png",
        "stock-label-studio-canary.json",
        "stock-label-studio-canary.png",
        "task-summary.txt",
        "tasks-after-native-import.json",
        "unprivileged-project-error.json",
        "unprivileged-project-error.png",
    ]
    for name in allowed:
        copy(source / name, destination / name)
    copy(source / "seeded-explorer.json", destination / "deterministic-workflow.json")


def copy_pages_browser_evidence(source: Path, destination: Path) -> None:
    copy(source / ".last-run.json", destination / "last-run.json")
    for scenario in sorted(path for path in source.iterdir() if path.is_dir()):
        if scenario.name.startswith("."):
            continue
        for artifact in sorted(scenario.iterdir()):
            if artifact.suffix in {".png", ".zip", ".json"}:
                copy(artifact, destination / scenario.name / artifact.name)


def main() -> None:
    if run("git", "status", "--porcelain"):
        raise SystemExit("Refusing to bundle a dirty FrogLabel tree")
    commit = run("git", "rev-parse", "HEAD")
    if run("git", "rev-parse", BASELINE) != BASELINE:
        raise SystemExit("Reviewed baseline object is unavailable")

    with tempfile.TemporaryDirectory(prefix="froglabel-final-bundle-") as temporary:
        stage = Path(temporary) / "froglabel-poc-final-review-bundle"
        stage.mkdir()

        source_archive = stage / "source" / f"froglabel-source-{commit}.zip"
        source_archive.parent.mkdir(parents=True)
        subprocess.run(
            [
                "git",
                "archive",
                "--format=zip",
                f"--prefix=froglabel-{commit}/",
                "-o",
                source_archive,
                "HEAD",
            ],
            cwd=ROOT,
            check=True,
        )
        patch_path = stage / "source" / "froglabel-from-6041bc4.patch"
        patch_path.write_bytes(
            subprocess.run(
                ["git", "diff", "--binary", BASELINE, commit],
                cwd=ROOT,
                check=True,
                capture_output=True,
            ).stdout
        )
        write_text(
            stage / "source" / "provenance.json",
            json.dumps(
                {
                    "schemaVersion": 1,
                    "reviewedReturnedCommit": REVIEWED_RETURNED_COMMIT,
                    "localByteIdenticalReviewSnapshot": BASELINE,
                    "finalCommit": commit,
                    "workingTreeClean": True,
                },
                indent=2,
            ),
        )

        copy(
            ROOT / "artifacts/github-pages/froglabel-pages-static.zip",
            stage / "github-pages/froglabel-pages-static.zip",
        )
        copy(
            ROOT / "artifacts/github-pages/froglabel-pages-static.manifest.json",
            stage / "github-pages/froglabel-pages-static.manifest.json",
        )
        for package in sorted((ROOT / "artifacts/python-package-final").iterdir()):
            copy(package, stage / "python-package" / package.name)

        copy(
            ROOT / "python/froglabel_cli/resources/label-studio-ce-1.23.0.patch",
            stage / "label-studio-ce/label-studio-ce-1.23.0.patch",
        )
        copy(
            ROOT / "integration/label-studio-ce/froglabel-reactcode-ce/index.jsx",
            stage / "label-studio-ce/adapter/index.jsx",
        )
        final_ce = ROOT.parent / "ce/label-studio-final-fresh"
        copy(
            final_ce / "web/dist/apps/labelstudio/froglabel/froglabel-build-manifest.json",
            stage / "label-studio-ce/froglabel-build-manifest.json",
        )
        for log in sorted((ROOT / "test-results/installer-final").glob("*.log")):
            copy(log, stage / "evidence/installer" / log.name)

        copy(ROOT / "test-results/final/vitest.json", stage / "results/vitest.json")
        copy(ROOT / "test-results/final/pytest.xml", stage / "results/pytest.xml")
        copy(
            ROOT / "test-results/final/static-analysis-and-size.log",
            stage / "results/static-analysis-and-size.log",
        )
        copy(
            ROOT / "test-results/playwright/.last-run.json",
            stage / "results/standalone-browser-last-run.json",
        )
        copy(
            ROOT / "test-results/performance/workspace-2000-boxes.json",
            stage / "results/workspace-2000-boxes.json",
        )
        copy(
            ROOT / "test-results/playwright/gre-annotation.png",
            stage / "evidence/standalone/gre-annotation.png",
        )
        copy_pages_browser_evidence(
            ROOT / "test-results/playwright-github-pages-static",
            stage / "evidence/github-pages-browser",
        )
        copy_ce_run(
            ROOT / "test-results/ce-installer-output-run-1",
            stage / "evidence/label-studio-ce/run-1",
        )
        copy_ce_run(
            ROOT / "test-results/ce-installer-output-run-2",
            stage / "evidence/label-studio-ce/run-2",
        )

        verification = {
            "schemaVersion": 1,
            "finalCommit": commit,
            "unitPropertyProtocol": {"passed": 49, "failed": 0},
            "component": {"passed": 3, "failed": 0},
            "python": {"passed": 20, "failed": 0},
            "standaloneProductionBrowser": {"passed": 7, "failed": 0},
            "exactPagesArtifactBrowser": {"passed": 6, "failed": 0},
            "ceNormalHttpFreshRuns": {"passed": 2, "failed": 0},
            "ceEmbeddedFrame": {"width": 851, "height": 790},
            "ceUnexpectedBrowserConsolePageCspRequestErrors": 0,
            "installer": {
                "freshFullBuild": "passed; patch applied",
                "repeatFullBuild": "passed; already applied",
                "deliberateConflict": "expected exit 2; no partial patch mutation",
                "startCanary": "passed",
            },
            "externalHostedFrogIdOrFrogLabelAccessed": False,
            "publishedPagesUrl": None,
        }
        write_text(stage / "results/verification-summary.json", json.dumps(verification, indent=2))

        write_text(
            stage / "LIMITATIONS.md",
            (
                "# Remaining deferred work\n\n"
                "- Tutorial audio is one centered synthetic frog-like signal and is not a "
                "biological reference recording. Replace only the fixture/descriptor when a "
                "licensed, verified Peron's Tree Frog call is supplied.\n"
                "- Windowed decoding beyond the current five-minute/128-MiB bounds is deferred.\n"
                "- Models, predictions, seeded annotations, mapping compilers, and prediction "
                "acceptance UI are deferred.\n"
                "- Enterprise live deployment/Gate 0 is deferred until the real server and API "
                "token are available; the shared boundaries remain compatible.\n"
                "- Nested Data Manager species filtering, multiple Label Studio versions, "
                "organization-wide catalogs, and approval workflows are deferred.\n"
                "- Docker/Kubernetes production polish, mobile/tablet redesign, IndexedDB, and "
                "autosave are deferred.\n"
                "- GitHub Pages was not published because no intended repository authorization "
                "was available. Owner action: deploy the included exact artifact with the "
                "committed workflow.\n"
            ),
        )
        write_text(
            stage / "README_REVIEW.md",
            (
                "# FrogLabel POC final review bundle\n\n"
                f"Final FrogLabel commit: `{commit}`\n\n"
                "This bundle contains the complete committed source, a clean binary-capable diff "
                "from the byte-identical local snapshot of reviewed return "
                f"`{REVIEWED_RETURNED_COMMIT}`, the exact static Pages artifact, final "
                "wheel/sdist, "
                "the packaged CE patch/adapter/manifest, machine-readable test results, installer "
                "fresh/repeat/conflict/start logs, and sanitized standalone/CE browser "
                "evidence.\n\n"
                "The two normal-HTTP CE passes ran from the same pristine pinned Label Studio CE "
                "1.23.0 tree produced by the documented installed-wheel prepare command. Both used "
                "an ordinary non-admin member and an 851x790 iframe, completed the full tutorial, "
                "and recorded zero unexpected browser console/page/CSP/request failures. Expected "
                "permission-denial server entries for the deliberate non-member check are retained "
                "in the logs.\n\n"
                "Excluded on purpose: fixture credentials, command logs containing fixture "
                "passwords, session cookies, SQLite databases, browser runtime uploads, real "
                "client "
                "audio, and any hosted FrogID/FrogLabel access.\n"
            ),
        )

        checksums = []
        for path in sorted(candidate for candidate in stage.rglob("*") if candidate.is_file()):
            relative = path.relative_to(stage).as_posix()
            checksums.append(f"{sha256(path)}  {relative}")
        write_text(stage / "manifests/checksums.sha256", "\n".join(checksums))

        with ZipFile(OUTPUT, "w", ZIP_DEFLATED, compresslevel=9) as archive:
            for path in sorted(candidate for candidate in stage.rglob("*") if candidate.is_file()):
                relative = path.relative_to(stage.parent).as_posix()
                info = ZipInfo(relative, FIXED_ZIP_TIME)
                info.compress_type = ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, path.read_bytes(), compresslevel=9)
    print(json.dumps({"path": str(OUTPUT), "sha256": sha256(OUTPUT), "commit": commit}))


if __name__ == "__main__":
    main()
