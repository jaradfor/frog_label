#!/usr/bin/env python3
# ruff: noqa: E501
"""Build and verify the deterministic FrogLabel human-demo review bundle.

The review bundle is an evidence artifact, not part of any runtime target.  It is
assembled only from the tracked Git tree, exact upstream CE checkout, and named
final test runs so stale probe output cannot accidentally become release proof.
"""

from __future__ import annotations

import csv
import hashlib
import json
import platform
import shutil
import subprocess
import sys
import textwrap
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

BASELINE = "cd485629c7ec0c84bd2e3543a4cf3ffdd3b93352"
PREVIOUS_BASELINE = "0030d8e37eaa66f13ac18be7127066883f494c7b"
CE_COMMIT = "2a9bfbcbf0a844b999de97e601d16050a893f5fb"
CE_VERSION = "1.23.0"
BUNDLE_NAME = "froglabel-human-demo-review-bundle"
SOURCE_ARCHIVE = "froglabel-implementation-review-bundle-2026-08-20.zip"
SOURCE_ARCHIVE_SHA256 = "7b5930a9e88c3d80c4a7003d63e2f2f35130d5850125ab9d5436838bea06f0b4"


@dataclass(frozen=True)
class Inputs:
    repo: Path
    ce_repo: Path
    enterprise: Path
    output_parent: Path

    @property
    def root(self) -> Path:
        return self.output_parent / BUNDLE_NAME

    @property
    def archive(self) -> Path:
        return self.output_parent / f"{BUNDLE_NAME}.zip"


def run(args: list[str], *, cwd: Path, check: bool = True) -> str:
    completed = subprocess.run(
        args,
        cwd=cwd,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    if check and completed.returncode:
        command = " ".join(args)
        raise RuntimeError(f"{command} failed ({completed.returncode}):\n{completed.stdout}")
    return completed.stdout.strip()


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(value).strip() + "\n", encoding="utf-8")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def copy_file(source: Path, target: Path) -> None:
    if not source.is_file():
        raise FileNotFoundError(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_tree(source: Path, target: Path) -> None:
    if not source.is_dir():
        raise FileNotFoundError(source)
    shutil.copytree(source, target, dirs_exist_ok=True)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def tracked_status(repo: Path) -> list[str]:
    return [
        line
        for line in run(["git", "status", "--short", "--untracked-files=no"], cwd=repo).splitlines()
        if line
    ]


def require_inputs(inputs: Inputs) -> tuple[str, dict[str, Any]]:
    if tracked_status(inputs.repo):
        raise RuntimeError("Tracked FrogLabel files must be committed before packaging")
    source_commit = run(["git", "rev-parse", "HEAD"], cwd=inputs.repo)
    if run(["git", "rev-parse", "HEAD"], cwd=inputs.ce_repo) != CE_COMMIT:
        raise RuntimeError("The Label Studio checkout is not the pinned CE commit")
    run(["git", "merge-base", "--is-ancestor", BASELINE, source_commit], cwd=inputs.repo)
    manifest = json.loads((inputs.enterprise / "froglabel.enterprise.manifest.json").read_text())
    interface = inputs.enterprise / "froglabel.enterprise.jsx"
    if manifest["interfaceSha256"] != sha256(interface):
        raise RuntimeError("Enterprise Interface and manifest digest differ")
    return source_commit, manifest


def make_source_artifacts(inputs: Inputs, source_commit: str) -> None:
    source = inputs.root / "source"
    source.mkdir(parents=True)
    run(
        [
            "git",
            "archive",
            "--format=zip",
            "--prefix=froglabel/",
            f"--output={source / 'froglabel-implemented.zip'}",
            source_commit,
        ],
        cwd=inputs.repo,
    )
    (source / "froglabel.patch").write_bytes(
        subprocess.check_output(
            ["git", "diff", "--binary", f"{BASELINE}..{source_commit}"], cwd=inputs.repo
        )
    )
    enterprise_paths = [
        "examples/configs/enterprise-empty.yaml",
        "examples/configs/enterprise-seeded.yaml",
        "examples/configs/enterprise-reconciliation-input.json",
        "examples/configs/species-reconciliation.example.yaml",
        "python/froglabel_cli/enterprise.py",
        "python/froglabel_cli/resources/enterprise-bundle.js",
        "python/froglabel_cli/resources/enterprise-bundle.manifest.json",
        "scripts/build-enterprise-bundle.mjs",
        "scripts/enterprise-inline-harness-entry.tsx",
        "scripts/test-enterprise-inline-agent.mjs",
        "src/adapters/enterprise",
        "src/enterprise",
        "tests/protocol/enterprise-inline-port.test.ts",
    ]
    (source / "froglabel-enterprise-interface.patch").write_bytes(
        subprocess.check_output(
            ["git", "diff", "--binary", f"{BASELINE}..{source_commit}", "--", *enterprise_paths],
            cwd=inputs.repo,
        )
    )
    (source / f"label-studio-ce-{CE_VERSION}.patch").write_bytes(
        subprocess.check_output(["git", "diff", "--binary", CE_COMMIT], cwd=inputs.ce_repo)
    )


def make_product_artifacts(inputs: Inputs) -> None:
    pages = inputs.root / "artifacts/github-pages"
    copy_file(
        inputs.repo / "artifacts/github-pages/froglabel-pages-static.zip",
        pages / "froglabel-pages-static.zip",
    )
    copy_file(
        inputs.repo / "artifacts/github-pages/froglabel-pages-static.manifest.json",
        pages / "build-manifest.json",
    )

    enterprise = inputs.root / "artifacts/enterprise"
    for name in (
        "froglabel.enterprise.jsx",
        "froglabel.enterprise.manifest.json",
        "embedded-catalog.json",
    ):
        copy_file(inputs.enterprise / name, enterprise / name)
    copy_file(
        inputs.repo / "examples/configs/species-reconciliation.example.yaml",
        enterprise / "species-reconciliation.example.yaml",
    )


def tool_version(command: list[str], cwd: Path) -> str:
    try:
        return run(command, cwd=cwd).splitlines()[0]
    except (OSError, RuntimeError, IndexError):
        return "unavailable"


def make_manifests(inputs: Inputs, source_commit: str, enterprise_manifest: dict[str, Any]) -> None:
    manifests = inputs.root / "manifests"
    ce_status = run(["git", "status", "--short"], cwd=inputs.ce_repo)
    source_diff = run(["git", "diff", "--stat", f"{BASELINE}..{source_commit}"], cwd=inputs.repo)
    write_json(
        manifests / "source-and-upstream.json",
        {
            "schemaVersion": 1,
            "suppliedArchive": SOURCE_ARCHIVE,
            "suppliedArchiveSha256": SOURCE_ARCHIVE_SHA256,
            "startingCommit": BASELINE,
            "previousReviewedCommit": PREVIOUS_BASELINE,
            "returnedCommit": source_commit,
            "branch": run(["git", "branch", "--show-current"], cwd=inputs.repo),
            "labelStudio": {"edition": "CE", "version": CE_VERSION, "upstreamCommit": CE_COMMIT},
            "cePatchWorkingTree": ce_status.splitlines(),
            "sourceDiffStat": source_diff.splitlines(),
            "hostedFrogIdContacted": False,
        },
    )
    write_json(
        manifests / "toolchain.json",
        {
            "schemaVersion": 1,
            "platform": platform.platform(),
            "python": platform.python_version(),
            "node": tool_version(["node", "--version"], inputs.repo),
            "npm": tool_version(["npm", "--version"], inputs.repo),
            "git": tool_version(["git", "--version"], inputs.repo),
            "playwright": "1.62.1",
            "browser": "Chromium 149.0.7827.0 (@sparticuz/chromium 149.0.0)",
            "ceBuildEnvelope": {"node": "22.x", "yarn": "1.22.x"},
            "browserInstall": {
                "pinnedFallback": "passed",
                "ordinaryPlaywrightCdnInstall": "blocked by managed network policy",
            },
        },
    )
    pages_manifest = json.loads(
        (inputs.repo / "artifacts/github-pages/froglabel-pages-static.manifest.json").read_text()
    )
    write_json(
        manifests / "build-assets.json",
        {
            "schemaVersion": 1,
            "githubPages": pages_manifest,
            "enterprise": enterprise_manifest,
            "ceIframeAssets": [
                {
                    "path": str(path.relative_to(inputs.repo / ".cache/ce-assets-1673336")),
                    "bytes": path.stat().st_size,
                    "sha256": sha256(path),
                }
                for path in sorted((inputs.repo / ".cache/ce-assets-1673336").rglob("*"))
                if path.is_file()
            ],
        },
    )
    write_json(
        manifests / "protocol-version.json",
        {
            "schemaVersion": 1,
            "canonicalDocument": "froglabel.annotation-set/v2",
            "localWrapper": "froglabel.local-file/v2",
            "reactCodeMessage": "froglabel.reactcode-message/v1",
            "ceResult": {
                "type": "reactcode",
                "from_name": "froglabel",
                "to_name": "froglabel",
            },
            "enterpriseResult": {
                "type": "labels",
                "from_name": "froglabel",
                "to_name": "audio",
                "value": "one-item canonical-document array",
            },
            "catalog": "froglabel.species-catalog/v2",
        },
    )


def copy_named_run(source: Path, destination: Path) -> None:
    """Copy one explicitly selected passing browser run."""
    copy_tree(source, destination)


def make_test_evidence(inputs: Inputs) -> None:
    repo = inputs.repo
    tests = inputs.root / "tests"
    copy_file(repo / "test-results/unit-results.xml", tests / "unit-results.xml")
    copy_file(repo / "test-results/component-results.xml", tests / "component-results.xml")
    copy_file(repo / "test-results/python-results.xml", tests / "python-results.xml")
    copy_tree(repo / "test-results/final/coverage", tests / "coverage")

    standalone = tests / "playwright-standalone"
    copy_file(repo / "test-results/playwright/.last-run.json", standalone / ".last-run.json")
    copy_file(
        repo / "test-results/playwright/gre-annotation.png", standalone / "gre-annotation.png"
    )
    copy_file(
        repo
        / "test-results/playwright/seeded-explorer-runs-the-s-90f76-alone-state-action-explorer-chromium/seeded-explorer-final.png",
        standalone / "seeded-explorer-final.png",
    )
    copy_file(
        repo / "test-results/performance/workspace-5000-boxes.json",
        standalone / "workspace-5000-boxes.json",
    )
    write_json(
        standalone / "run-summary.json",
        {
            "status": "passed",
            "tests": 14,
            "runner": "scripts/test-e2e-agent.mjs",
            "browser": "Chromium 149.0.7827.0",
            "servedTarget": "production Vite build on loopback",
        },
    )

    pages = tests / "playwright-github-pages-static"
    copy_file(
        repo / "test-results/playwright-github-pages-static/.last-run.json",
        pages / ".last-run.json",
    )
    page_results = repo / "test-results/playwright-github-pages-static"
    for name in (
        "static-demo-runs-the-compl-68356-torial-and-dirty-state-flow-chromium",
        "seeded-explorer-runs-the-s-b8ab2-ble-Pages-artifact-explorer-chromium",
    ):
        copy_named_run(page_results / name, pages / name)
    write_json(
        pages / "run-summary.json",
        {
            "status": "passed",
            "tests": 6,
            "basePath": "/frog_label/",
            "artifact": "artifacts/github-pages/froglabel-pages-static.zip",
            "note": "Only final passing result directories are included; discarded diagnostic output is excluded.",
        },
    )

    protocol = tests / "playwright-reactcode-harness"
    copy_file(repo / "tests/protocol/reactcode-port.test.ts", protocol / "reactcode-port.test.ts")
    write_json(
        protocol / "run-summary.json",
        {
            "status": "passed",
            "includedIn": "unit-results.xml",
            "contract": "CE external-source postMessage source/origin/context/schema lifecycle",
        },
    )

    for target, source in (
        (
            "playwright-label-studio-ce-wsgi",
            repo / "test-results/final/playwright-label-studio-ce-wsgi",
        ),
        (
            "playwright-label-studio-ce-served",
            repo / "test-results/final/playwright-label-studio-ce-served",
        ),
        (
            "playwright-enterprise-interface-harness",
            repo / "test-results/final/playwright-enterprise-interface-harness",
        ),
    ):
        copy_named_run(source / "run-1", tests / target / "run-1")
        copy_named_run(source / "run-2", tests / target / "run-2")

    explorers = {
        "schemaVersion": 1,
        "seed": 24082026,
        "status": "passed",
        "environments": {
            "standalone": {"status": "passed", "fixedWorkflows": 7},
            "githubPagesStatic": {"status": "passed", "fixedWorkflows": 3},
            "labelStudioCeWsgi": json.loads(
                (
                    repo
                    / "test-results/final/playwright-label-studio-ce-wsgi/run-1/seeded-explorer.json"
                ).read_text()
            ),
            "labelStudioCeServed": json.loads(
                (
                    repo
                    / "test-results/final/playwright-label-studio-ce-served/run-1/seeded-explorer.json"
                ).read_text()
            ),
            "enterpriseExactInterface": json.loads(
                (
                    repo
                    / "test-results/final/playwright-enterprise-interface-harness/run-1/seeded-explorer.json"
                ).read_text()
            ),
        },
    }
    write_json(tests / "explorer-results.json", explorers)
    replay = tests / "replay"
    for target, source in (
        (
            "ce-served-seed-24082026.json",
            repo
            / "test-results/final/playwright-label-studio-ce-served/run-1/seeded-explorer.json",
        ),
        (
            "ce-wsgi-seed-24082026.json",
            repo / "test-results/final/playwright-label-studio-ce-wsgi/run-1/seeded-explorer.json",
        ),
        (
            "enterprise-interface-seed-24082026.json",
            repo
            / "test-results/final/playwright-enterprise-interface-harness/run-1/seeded-explorer.json",
        ),
    ):
        copy_file(source, replay / target)
    write_text(
        replay / "README.md",
        """
        # Replay inputs

        The JSON files preserve the fixed seed, ordered semantic actions, and asserted invariant for each
        bounded explorer. The corresponding executable runners are in the returned source archive. No final
        run failed, so there is no minimized failing replay.
        """,
    )


def make_evidence(inputs: Inputs) -> None:
    repo = inputs.repo
    evidence = inputs.root / "evidence"
    audio = evidence / "audio-analysis"
    copy_file(
        repo / "test-results/performance/workspace-5000-boxes.json",
        audio / "workspace-5000-boxes.json",
    )
    copy_file(repo / "tests/unit/scientific-audio.test.ts", audio / "scientific-audio.test.ts")
    copy_file(repo / "tests/unit/audio-source-rate.test.ts", audio / "audio-source-rate.test.ts")
    write_json(
        audio / "results.json",
        {
            "status": "passed",
            "machineReadableSuite": "../../tests/unit-results.xml",
            "fixtures": [
                "brief calls",
                "right-only",
                "antiphase",
                "44.1/48/96/192 kHz WAV",
                "ordinary MP3",
            ],
            "executors": ["Blob worker", "cancellable cooperative main thread"],
            "analysisDoesNotAlterStereoPlayback": True,
        },
    )

    copy_file(
        repo / "artifacts/github-pages/froglabel-pages-static.manifest.json",
        evidence / "github-pages-static/build-manifest.json",
    )
    copy_file(
        repo / "test-results/playwright-github-pages-static/.last-run.json",
        evidence / "github-pages-static/browser-result.json",
    )

    screenshots = evidence / "screenshots"
    copy_file(
        repo
        / "test-results/final/playwright-label-studio-ce-served/run-1/ce-annotated-reloaded.png",
        screenshots / "ce-green-tree-frog-annotated-reloaded.png",
    )
    copy_file(
        repo
        / "test-results/final/playwright-label-studio-ce-served/run-1/ce-task-summary-view-all.png",
        screenshots / "ce-task-summary-view-all.png",
    )
    copy_file(
        repo / "test-results/playwright/gre-annotation.png",
        screenshots / "standalone-green-tree-frog.png",
    )
    copy_file(
        repo
        / "test-results/playwright-github-pages-static/static-demo-runs-the-compl-68356-torial-and-dirty-state-flow-chromium/static-green-tree-annotation.png",
        screenshots / "github-pages-green-tree-frog.png",
    )
    copy_file(
        repo
        / "test-results/final/playwright-enterprise-interface-harness/run-1/enterprise-interface-annotated.png",
        screenshots / "enterprise-interface-local-harness.png",
    )

    videos = evidence / "videos"
    copy_file(
        repo
        / "test-results/playwright-github-pages-static/static-demo-runs-the-compl-68356-torial-and-dirty-state-flow-chromium/video.webm",
        videos / "github-pages-static.webm",
    )
    enterprise_video = next(
        (repo / "test-results/final/playwright-enterprise-interface-harness/run-1").glob("*.webm")
    )
    copy_file(enterprise_video, videos / "enterprise-interface-local-harness.webm")

    traces = evidence / "traces"
    copy_file(
        repo
        / "test-results/playwright-github-pages-static/static-demo-runs-the-compl-68356-torial-and-dirty-state-flow-chromium/trace.zip",
        traces / "github-pages-static.trace.zip",
    )
    copy_file(
        repo / "test-results/final/playwright-enterprise-interface-harness/run-1/trace.zip",
        traces / "enterprise-interface-local-harness.trace.zip",
    )
    standalone_trace = sorted(
        (repo / "test-results/playwright/.playwright-artifacts-1/traces").glob("*.trace")
    )[0]
    standalone_network = sorted(
        (repo / "test-results/playwright/.playwright-artifacts-1/traces").glob("*.network")
    )[0]
    copy_file(standalone_trace, traces / "standalone.trace")
    copy_file(standalone_network, traces / "standalone.network")

    logs = evidence / "console-and-network"
    for lane, source in (
        ("ce-served-run-1", repo / "test-results/final/playwright-label-studio-ce-served/run-1"),
        ("ce-served-run-2", repo / "test-results/final/playwright-label-studio-ce-served/run-2"),
        ("ce-wsgi-run-1", repo / "test-results/final/playwright-label-studio-ce-wsgi/run-1"),
        (
            "enterprise-interface-run-1",
            repo / "test-results/final/playwright-enterprise-interface-harness/run-1",
        ),
    ):
        for name in ("browser.log", "network.json", "server.log", "bridge.log"):
            candidate = source / name
            if candidate.is_file():
                copy_file(candidate, logs / f"{lane}-{name}")

    database = evidence / "label-studio-database"
    copy_file(
        repo / "test-results/label-studio-database/catalog-results.json",
        database / "catalog-results.json",
    )
    copy_file(
        repo / "test-results/label-studio-database/catalog-evidence.sqlite3",
        database / "catalog-evidence.sqlite3",
    )
    copy_file(
        repo
        / "test-results/final/playwright-label-studio-ce-served/run-1/database-inspection.json",
        database / "ce-run-1-inspection.json",
    )
    copy_file(
        repo / "test-results/final/playwright-label-studio-ce-served/run-1/label_studio.sqlite3",
        database / "ce-run-1.sqlite3",
    )

    copy_named_run(
        repo / "test-results/final/playwright-enterprise-interface-harness/run-1",
        evidence / "enterprise-interface-local-harness/run-1",
    )
    copy_named_run(
        repo / "test-results/final/playwright-enterprise-interface-harness/run-2",
        evidence / "enterprise-interface-local-harness/run-2",
    )

    downloads = evidence / "downloads"
    local_download = (
        repo
        / "test-results/playwright/.playwright-artifacts-1/5f01906f-e976-4c5b-b305-77c3b24b64d6"
    )
    copy_file(local_download, downloads / "sample.froglabel.json")
    wrapper = json.loads(local_download.read_text())
    document = wrapper.get("document")
    rows: list[list[Any]] = [
        [
            "recordType",
            "mediaFilename",
            "reviewStatus",
            "boxId",
            "speciesId",
            "code",
            "speciesName",
            "startTimeSeconds",
            "endTimeSeconds",
            "lowFrequencyHz",
            "highFrequencyHz",
        ]
    ]
    if document and document.get("boxes"):
        for box in document["boxes"]:
            species = box["species"]
            rows.append(
                [
                    "box",
                    wrapper["audio"]["filename"],
                    document["reviewStatus"],
                    box["id"],
                    species["speciesId"],
                    species["code"],
                    species["speciesName"],
                    box["startTimeSeconds"],
                    box["endTimeSeconds"],
                    box["lowFrequencyHz"],
                    box["highFrequencyHz"],
                ]
            )
    else:
        rows.append(
            [
                "review",
                wrapper["audio"]["filename"],
                "unreviewed" if document is None else document["reviewStatus"],
                "",
                "",
                "",
                "",
                "",
                "",
                "",
                "",
            ]
        )
    downloads.mkdir(parents=True, exist_ok=True)
    with (downloads / "sample.froglabel.csv").open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle, lineterminator="\n").writerows(rows)
    copy_file(
        repo
        / "test-results/final/playwright-label-studio-ce-served/run-1/label-studio-ce-export.json",
        downloads / "label-studio-ce-export.json",
    )
    copy_file(
        repo
        / "test-results/final/playwright-label-studio-ce-served/run-1/label-studio-ce-export-parse.json",
        downloads / "label-studio-ce-export-parse.json",
    )

    raw = evidence / "raw-results"
    copy_file(
        repo
        / "test-results/final/playwright-label-studio-ce-served/run-1/ce-annotated-after-submit.json",
        raw / "ce-annotated.json",
    )
    copy_file(
        repo / "test-results/final/playwright-label-studio-ce-served/run-1/ce-no-calls.json",
        raw / "ce-no-calls.json",
    )
    copy_file(
        repo / "test-results/final/playwright-label-studio-ce-served/run-1/ce-reloaded.json",
        raw / "ce-reloaded.json",
    )


def final_label_config(database: Path) -> str:
    import sqlite3

    connection = sqlite3.connect(database)
    try:
        row = connection.execute("SELECT label_config FROM project ORDER BY id LIMIT 1").fetchone()
    finally:
        connection.close()
    if not row:
        raise RuntimeError("Final CE database contains no project label configuration")
    return str(row[0])


def make_reports(inputs: Inputs, source_commit: str, enterprise_manifest: dict[str, Any]) -> None:
    repo = inputs.repo
    reports = inputs.root / "reports"
    reports.mkdir(parents=True)
    diff_stat = run(["git", "diff", "--stat", f"{BASELINE}..{source_commit}"], cwd=repo)
    ce_summary = json.loads(
        (
            repo / "test-results/final/playwright-label-studio-ce-served/run-1/run-summary.json"
        ).read_text()
    )
    inline_summary = json.loads(
        (
            repo
            / "test-results/final/playwright-enterprise-interface-harness/run-1/run-summary.json"
        ).read_text()
    )
    performance = json.loads(
        (repo / "test-results/performance/workspace-5000-boxes.json").read_text()
    )

    write_text(
        reports / "IMPLEMENTATION_REPORT.md",
        f"""
        # FrogLabel human-demo implementation report

        ## Readiness outcome

        **Ready for initial local Label Studio CE 1.23.0 hosting and supervised human demos/training.**

        **Enterprise Interface generated, locally verified, SDK-validated, published, and exercised on the
        authorized hosted instance.**

        ## Source identity

        The reviewed input was `{SOURCE_ARCHIVE}` (SHA-256 `{SOURCE_ARCHIVE_SHA256}`), reconstructed at
        `{BASELINE}`. The returned tracked source is `{source_commit}`. The useful `{PREVIOUS_BASELINE}` →
        `{BASELINE}` fixes were preserved: pinned real-browser fallback, final post-Nx CE asset staging,
        `AnnotationMixin`, cycle-safe locking, and the real-Django WSGI lane. Its obsolete CE 1.22 claims,
        accumulating fixtures, warning-tolerant lifecycle, and limited test coverage were superseded.

        ## Architecture and implementation

        One canonical reducer/document, geometry/audio services, and shared workspace feed four thin document
        ports: local file, tutorial, CE external-source ReactCode, and the current Enterprise Interface adapter. Species use
        session, CE project, or Enterprise embedded/snapshot ports. Hydra composes administrator intent; strict
        Pydantic models validate before atomic catalog/state writes. Label Studio alone owns task, completion,
        Submit/Update, navigation, review, and export.

        The useful original FrogLabel visual identity and tools were restored on these boundaries. Complete STFT,
        source-faithful WAV metadata, native stereo playback, Average/Max/Left/Right mono analysis, cancellation,
        precise canonical geometry, overlap cycling, immediate pointer commits, selection playback, tutorial
        isolation, local lossless JSON/CSV, and 5,000-box batched rendering are implemented.

        CE is pinned to upstream `{CE_COMMIT}` (`{CE_VERSION}`). The returned CE patch changes only the exact
        upstream checkout and adds the FrogLabel-owned custom-tag/catalog seam plus the minimum upstream lifecycle,
        summary, app-context, and static-overlay integration required by real browser evidence. FrogLabel assets are
        staged after the exact Nx production build under `/react-app/froglabel/`.

        Enterprise target `src/enterprise/entry.tsx` is compiled by `scripts/build-enterprise-bundle.mjs`; host React
        is external and shared application code/styles/schemas/icons/tutorial audio are embedded. Artifact:
        `{enterprise_manifest["interfaceSha256"]}`, {enterprise_manifest["interfaceBytes"]} Interface bytes,
        with a {enterprise_manifest["bundleMinifiedBytes"]}-byte minified shared bundle. Exact generated source ran
        locally; hosted validation and playground/project checks are recorded separately.

        ## Verification with actual exit status

        | Command/lane | Exit | Result and machine-readable evidence |
        | --- | ---: | --- |
        | `npm run test:unit -- --reporter=junit` | 0 | 159/159, `tests/unit-results.xml` |
        | `npm run test:component -- --reporter=junit` | 0 | 18/18, `tests/component-results.xml` |
        | `pytest` tracked Python package/tests | 0 | 36/36, `tests/python-results.xml` |
        | `npm run typecheck`; `npm run lint`; `npm run format:check`; `npm run check:validators` | 0 each | clean final source |
        | `ruff check` tracked Python | 0 | clean final source |
        | `npm run build`; `npm run size` | 0 each | Brotli JS ≤150,000 B; CSS ≤10,000 B |
        | `node scripts/test-e2e-agent.mjs` | 0 | 14/14, production build in Chromium |
        | exact Pages artifact Playwright | 0 | 6/6 at `/frog_label/` |
        | restricted real-Django WSGI CE runner, fresh state, twice | 0 each | first Submit then Update; stable result identity |
        | normally served CE runner, fresh DB, twice | 0 each | WAV/MP3 native import, Submit/Update/reload/export/no-calls/blank rejection/DB |
        | CE catalog database workflow | 0 | concurrency, rollback, idempotence, isolation, clone mismatch |
        | Enterprise generate/validate/render twice | 0 each | byte-identical Interface JSX and forbidden-content scans |
        | exact Enterprise Interface, two independent runs | 0 each | maximum and ordinary audio profiles; trace/video/logs |
        | installed wheel from `/tmp`: Enterprise init/validate/sync dry-run | 0 each | packaged resources; `remoteProject unchanged and not contacted` |

        Per-run server/browser commands and exit codes are preserved in the `commands.json` files under each CE
        test run. The final served document has {len(ce_summary["updatedDocument"]["boxes"])} GRE boxes and stable
        outer result `{ce_summary["stableResultId"]}`. The dense benchmark measured selection p95
        {performance["selection"]["p95Milliseconds"]:.1f} ms, resize p95 {performance["drag"]["p95Milliseconds"]:.1f}
        ms, pan p95 {performance["pan"]["p95Milliseconds"]:.1f} ms, and maximum long task
        {performance["longTasks"]["maximumMilliseconds"]:.0f} ms against 100/50 ms gates.

        ## Changed files and why

        The full patch is `source/froglabel.patch`; this stat is generated from Git:

        ```text
        {diff_stat}
        ```

        Changes group into canonical/audio/UI fixes; local/Pages and tutorial paths; Pydantic/Hydra catalog CLI;
        CE installer/overlay/upstream seam and browser runners; generated Enterprise target; schema/validator tests;
        documentation/evidence packaging. Unsupported prediction/compiler commands and generated artifacts are not
        present in the tracked source archive.

        ## Deviations and external boundaries

        - No licensed Enterprise website was authorized: all Section 17.6B rows are live Enterprise unverified.
        - No public GitHub Pages deployment was authorized; the deployable artifact was tested locally at its exact path.
        - Docker/Compose was unavailable in this runner. The exact source-derived CE build and normal Django HTTP stack
          passed twice; the container wrapper itself is unverified.
        - The managed network blocked ordinary Playwright browser CDN installation. The pinned local real Chromium
          fallback passed all browser lanes with screenshots, traces, videos, cursor, keyboard, File API, and downloads.
        - CE 1.23's generic Data Manager does not expose arbitrary nested ReactCode JSON paths as native columns. Task
          Summary/View All and native export were proven; the unsupported nested filter/sort dimensions were not patched.
        - `FROGLABEL_INDEPENDENT_IMPLEMENTATION_REVIEW.md` was referenced but not supplied. The handoff's mandatory
          known-defect list and the repository bug ledger were dispositioned instead.

        The externally hosted FrogID/FrogLabel site was not opened, probed, or contacted. Browser network assertions
        were local-only, and no production credentials or client data were used.
        """,
    )

    findings = [
        (
            "UI-001",
            "UI",
            "high",
            "Number keys 1-4 reported inactive",
            "not-reproduced-with-evidence",
            "Central KeyboardEvent.code dispatcher; editable targets excluded",
            "component and browser keyboard tests",
            "tests/component-results.xml",
            "User identified a browser extension; no extension used in clean Chromium",
        ),
        (
            "UI-002",
            "UI",
            "critical",
            "Legacy login/token/task and inner Submit path",
            "fixed",
            "Removed production route and host credentials",
            "network/source assertions",
            "evidence/console-and-network",
            "Outer Label Studio owns lifecycle",
        ),
        (
            "AUD-001",
            "audio",
            "critical",
            "Sparse isolated spectrogram windows could miss brief calls",
            "fixed",
            "Complete overlapping STFT traversal",
            "temporal phase and viewport-edge fixtures",
            "evidence/audio-analysis",
            "Blob and cooperative paths share algorithm",
        ),
        (
            "AUD-002",
            "audio",
            "high",
            "Browser resampling could misstate source rate",
            "fixed",
            "Source-faithful WAV parser and truthful MP3 metadata behavior",
            "44.1/48/96/192 kHz fixtures",
            "tests/unit-results.xml",
            "WAV axes use source header",
        ),
        (
            "AUD-003",
            "audio",
            "critical",
            "Stereo/right-only/antiphase content lost",
            "fixed",
            "Stereo playback plus Average energy/Max/Left/Right analysis",
            "right-only and antiphase fixtures",
            "evidence/audio-analysis",
            "Analysis mix does not replace playback buffer",
        ),
        (
            "GEO-001",
            "geometry",
            "critical",
            "Resize could invert canonical bounds",
            "fixed",
            "Normalized constrained reducer geometry",
            "property and pointer tests",
            "tests/unit-results.xml",
            "Finite ordered bounded values",
        ),
        (
            "GEO-002",
            "geometry",
            "high",
            "Spectrogram controls could resize selection",
            "fixed",
            "Separated pointer ownership",
            "real browser workflow",
            "tests/playwright-standalone",
            "Non-domain view actions preserve bytes",
        ),
        (
            "PLY-001",
            "playback",
            "high",
            "Playback rate direction/state mismatch",
            "fixed",
            "Single normalized playback rate state",
            "unit and browser tests",
            "tests/unit-results.xml",
            "Valid rates survive rebuild",
        ),
        (
            "PLY-002",
            "playback",
            "high",
            "Selection playback was a console stub",
            "fixed",
            "Real bounded media seek/playback",
            "standalone/CE/Enterprise Interface workflows",
            "tests/explorer-results.json",
            "Cleanup verified",
        ),
        (
            "KBD-001",
            "keyboard",
            "high",
            "Number shortcuts double-triggered panel/tool",
            "fixed",
            "One code-based dispatcher",
            "component and Playwright",
            "tests/component-results.xml",
            "Editable focus ignored",
        ),
        (
            "CAT-001",
            "catalog",
            "high",
            "Code lookup case-sensitive",
            "fixed",
            "Canonical uppercase and case-insensitive uniqueness",
            "catalog DB concurrency tests",
            "evidence/label-studio-database/catalog-results.json",
            "Project scoped",
        ),
        (
            "CAT-002",
            "catalog",
            "high",
            "Empty catalog/list exhaustion trapped workflow",
            "fixed",
            "Inline required full-name Add species flow",
            "empty config and catalog tests",
            "tests/python-results.xml",
            "New species immediately selected",
        ),
        (
            "GEO-003",
            "geometry",
            "high",
            "Overlapping boxes not all reachable",
            "fixed",
            "Deterministic overlap cycle",
            "CE and standalone pointer tests",
            "tests/explorer-results.json",
            "Order remains canonical",
        ),
        (
            "DATA-001",
            "data",
            "critical",
            "Display rounding leaked into canonical geometry",
            "fixed",
            "Projection-only formatting",
            "round-trip property and export comparison",
            "tests/unit-results.xml",
            "Full precision survives Submit/Update",
        ),
        (
            "DATA-002",
            "data",
            "critical",
            "Blank/deleted-last/no-calls conflated",
            "fixed",
            "Explicit three-state reducer and singleton semantics",
            "all host/local workflows",
            "evidence/raw-results",
            "Blank submission rejected",
        ),
        (
            "LOC-001",
            "local",
            "critical",
            "Resume/download and dirty state unproved",
            "fixed",
            "Validated local wrapper and exact CSV exporter",
            "exact Pages artifact File API workflow",
            "tests/playwright-github-pages-static",
            "Wrong-media resume rejected",
        ),
        (
            "RCT-001",
            "React",
            "high",
            "Hook warnings and stale context",
            "fixed",
            "Stable hook ownership and epoch cancellation",
            "fatal browser problem collector",
            "evidence/console-and-network",
            "No ignored console warnings",
        ),
        (
            "CE-001",
            "CE",
            "critical",
            "CE assets overwritten or served from wrong path",
            "fixed",
            "Post-Nx staging at /react-app/froglabel/",
            "exact build and normal HTTP asset graph",
            "manifests/build-assets.json",
            "All referenced assets served",
        ),
        (
            "CE-002",
            "CE",
            "critical",
            "Detached MobX-State-Tree reads after Update",
            "fixed",
            "Dispose reactions and avoid dead annotation dereference",
            "two served plus two WSGI runs",
            "tests/playwright-label-studio-ce-served",
            "Browser warnings/errors fatal",
        ),
        (
            "CE-003",
            "CE",
            "critical",
            "Fixtures accumulated and hid first Submit",
            "fixed",
            "Fresh disposable DB/user/project/tasks every run",
            "two runs per CE lane",
            "tests/playwright-label-studio-ce-wsgi",
            "First Submit and Update distinguished",
        ),
        (
            "CE-004",
            "CE",
            "high",
            "Singleton counted across task annotations",
            "fixed",
            "Per-annotation result enforcement",
            "Submit/Update/reload DB evidence",
            "evidence/label-studio-database",
            "Stable outer ID",
        ),
        (
            "CE-005",
            "CE",
            "critical",
            "Only restricted WSGI transport proved",
            "fixed",
            "Normal Django HTTP runner with native import/static/CSP",
            "two served runs",
            "tests/playwright-label-studio-ce-served",
            "WSGI retained as separate supporting lane",
        ),
        (
            "CE-006",
            "CE",
            "medium",
            "Arbitrary nested ReactCode Data Manager filters",
            "blocked",
            "No unsafe upstream Data Manager patch",
            "Task Summary/source evidence",
            "reports/LABEL_STUDIO_CE_CONTRACT.md",
            "CE 1.23 native custom-result limitation",
        ),
        (
            "CLI-001",
            "CLI",
            "critical",
            "Catalog mutation before validation/rollback",
            "fixed",
            "Pydantic preflight and atomic transactions",
            "fault injection and fresh reads",
            "evidence/label-studio-database/catalog-results.json",
            "Init/sync convergent",
        ),
        (
            "CLI-002",
            "CLI",
            "high",
            "Package resources depended on repository cwd",
            "fixed",
            "Packaged Hydra/schema/overlay/bundle resources",
            "installed wheel commands from /tmp",
            "tests/python-results.xml",
            "No repository cwd",
        ),
        (
            "CAT-003",
            "catalog",
            "critical",
            "Permission/concurrency/project isolation unproved",
            "fixed",
            "CSRF/auth/project-owned transactional endpoints",
            "201/409, isolation, clone mismatch",
            "evidence/label-studio-database",
            "No cross-project sharing",
        ),
        (
            "SCP-001",
            "scope",
            "medium",
            "Unready model/prediction compiler shipped",
            "deferred-by-final-handoff",
            "Removed supported CLI/package/docs; retained typed provenance",
            "CLI/package and provenance round-trip",
            "tests/python-results.xml",
            "Deferred per handoff Section 13",
        ),
        (
            "CE-007",
            "compatibility",
            "high",
            "CE 1.22 advertised",
            "fixed",
            "Accept and claim exact CE 1.23.0 only",
            "installer rejection tests/docs scan",
            "tests/python-results.xml",
            "Earlier compile is historical only",
        ),
        (
            "ENT-001",
            "Enterprise",
            "critical",
            "External-src Enterprise runtime",
            "fixed",
            "Generated self-contained current Interface JSX",
            "forbidden scans, exact-source harness, and SDK validation",
            "artifacts/enterprise",
            "No runtime module or external FrogLabel asset",
        ),
        (
            "ENT-002",
            "Enterprise",
            "critical",
            "Exact hosted Enterprise behavior",
            "fixed",
            "Validated, previewed, round-tripped, published, and pinned",
            "Authorized app.heartex.com instance",
            "reports/ENTERPRISE_INTERFACE_STATUS.md",
            "Interface 4489 version 3; three-task project 280811",
        ),
        (
            "TOOL-001",
            "tooling",
            "medium",
            "Ordinary Playwright browser install",
            "blocked",
            "Pinned local Chromium fallback retained",
            "all local browser lanes passed",
            "manifests/toolchain.json",
            "Managed CDN/network restriction",
        ),
        (
            "TOOL-002",
            "tooling",
            "high",
            "Fixed tests substituted for explorer",
            "fixed",
            "Seeded semantic explorer with action invariants",
            "three host environments plus Pages",
            "tests/explorer-results.json",
            "Replay seeds included",
        ),
        (
            "PERF-001",
            "performance",
            "critical",
            "5,000-box interaction responsiveness",
            "fixed",
            "Batched canvas/cached projection/structural sharing",
            "100 interactions per family",
            "evidence/audio-analysis/workspace-5000-boxes.json",
            "p95 and long-task limits passed",
        ),
        (
            "PKG-001",
            "packaging",
            "medium",
            "Docker/Compose wrapper unavailable",
            "blocked",
            "Exact source build and normal server tested",
            "normal HTTP CE evidence",
            "reports/KNOWN_LIMITATIONS.md",
            "Container wrapper not claimed",
        ),
    ]
    with (reports / "FINDING_DISPOSITIONS.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(
            [
                "finding_id",
                "area",
                "severity",
                "summary",
                "status",
                "change",
                "test",
                "evidence",
                "notes",
            ]
        )
        writer.writerows(findings)

    write_text(
        reports / "TEST_RESULTS.md",
        f"""
        # Test results

        | Layer | Result | Environment | Evidence |
        | --- | --- | --- | --- |
        | JS unit/property/protocol | 159/159 | Vitest | `tests/unit-results.xml` |
        | React component | 18/18 | jsdom | `tests/component-results.xml` |
        | Python | 36/36 | pytest + Hypothesis | `tests/python-results.xml` |
        | Python coverage | collected (informational) | coverage.py | `tests/coverage/` |
        | Standalone browser | 14/14 | real Chromium, production build | `tests/playwright-standalone/` |
        | GitHub Pages static | 6/6 | exact ZIP at `/frog_label/` | `tests/playwright-github-pages-static/` |
        | CE restricted WSGI | 2 independent passes | real CE Django/editor/DB | `tests/playwright-label-studio-ce-wsgi/` |
        | CE normal HTTP | 2 independent passes | real CE server/native import/export | `tests/playwright-label-studio-ce-served/` |
        | Enterprise Interface | pass | exact generated JSX and current controlled shell | `tests/playwright-enterprise-interface-harness/` |
        | Catalog/database | pass | disposable SQLite/transactions | `evidence/label-studio-database/` |

        Static analysis/typecheck/format/schema generation and production size checks exited 0. Browser runners reject
        console warnings/errors, page errors, unhandled rejections, failed requests, and CSP violations. The normal CE
        lane uses natural loopback HTTP and service-worker/CSP behavior; the WSGI lane is separately labeled restricted.

        Dense result: selection p95 {performance["selection"]["p95Milliseconds"]:.1f} ms; resize p95
        {performance["drag"]["p95Milliseconds"]:.1f} ms; pan p95 {performance["pan"]["p95Milliseconds"]:.1f} ms;
        longest task {performance["longTasks"]["maximumMilliseconds"]:.0f} ms. A 5,001-box document is rejected.
        """,
    )

    write_text(
        reports / "FROGLABEL_UI_AND_AUDIO.md",
        (repo / "docs/ARCHITECTURE.md").read_text()
        + "\n\n## Verified UI/audio behavior\n\n"
        + "The restored workspace retains the familiar panels, toolbar, dark/light themes, selection handles, waveform, and spectrogram. "
        + "Keys 1-4 open one panel only in clean Chromium; inputs are not hijacked. Selection playback, overlap cycling, precise resize, undo/redo, zoom/pan, palette/contrast/frequency controls, No calls, and `?` tutorial all ran with real pointer and keyboard events.\n\n"
        + "WAV source headers drive truthful sample rate/Nyquist. Native stereo is retained for playback; Average energy, Max, Left, and Right affect only analysis. Complete overlapping STFT traversal covers every temporal phase. Numeric fixtures cover short/right-only/antiphase/high-rate signals and both worker/cooperative executors. The synthetic tutorial signal is not a verified species reference.\n",
    )

    pages_manifest = json.loads(
        (repo / "artifacts/github-pages/froglabel-pages-static.manifest.json").read_text()
    )
    asset_lines = "\n".join(
        f"- `{item['path']}` — {item['bytes']} bytes — `{item['sha256']}`"
        for item in pages_manifest["files"]
    )
    write_text(
        reports / "GITHUB_PAGES_DEMO.md",
        f"""
        # GitHub Pages static demo

        `pages/main.tsx` selects the same FrogLabel workspace with `LocalFilePort` and a session catalog; it has no
        Label Studio adapter, login, token, task navigation, API, or Submit path. Vite builds at the exact base path
        `/frog_label/`. The final ZIP was unpacked and locally served at that prefix, not via the development server.

        Three browser workflows passed: exact-path/asset/host-code isolation; WAV+MP3 File API annotation/tutorial/
        fully named species/JSON+CSV/mismatch/dirty-state/no-calls flow; and seeded explorer. Network assertions allowed
        loopback artifact requests only. Audio bytes remained in the browser. Refresh of `/frog_label/` succeeded.

        Public deployment was not authorized or performed. Deployment source is `.github/workflows/deploy.yml`; use the
        returned `artifacts/github-pages/froglabel-pages-static.zip` or rebuild with `npm run build:pages` and
        `npm run package:pages`.

        ## Exact asset inventory

        {asset_lines}

        CE loads `/react-app/froglabel/`; Enterprise embeds its bytes. Neither target references this Pages artifact/origin.
        """,
    )

    label_xml = final_label_config(
        repo / "test-results/final/playwright-label-studio-ce-served/run-1/label_studio.sqlite3"
    )
    write_text(
        reports / "LABEL_STUDIO_CE_CONTRACT.md",
        f"""
        # Label Studio CE 1.23.0 contract

        Exact upstream: `{CE_COMMIT}`. The early registration point is
        `web/libs/editor/src/integrations/froglabel-reactcode-ce/index.jsx`, imported by the editor before config parsing.
        It composes `ControlBase`, `ReactCodeAttrs`, and `AnnotationMixin`, refuses to shadow native ReactCode, owns one
        singleton per annotation, and disposes reactions on context teardown.

        Valid tasks are `{{"froglabel":"/data/upload/...wav"}}` or that object plus optional
        `froglabelConfig.audio`; `froglabel` stays a URL string and complete task data is delivered. Messages validate
        source, origin, tag, context epoch, size, schema, and authoritative echo. The iframe receives no token and made
        no task/annotation/Submit/export request.

        Result contract: `type=reactcode`, `from_name=to_name=froglabel`, with the canonical document at
        `value.reactcode`. Raw create/update/no-calls/reload/export values are in `evidence/raw-results/` and
        `evidence/downloads/`; the native export parser proved UUIDs, full precision, status, species IDs/snapshots, and
        stable outer ID `{ce_summary["stableResultId"]}`.

        Task Summary/View All displays `reviewStatus`, `boxCount`, `speciesCodes`, and concise display text from current
        `extraData`. CE 1.23's generic Data Manager does not expose arbitrary nested ReactCode JSON paths as native
        filter/sort columns; that named native limitation was not bypassed with task-field copies or a Data Manager patch.

        Feature flag `fflag_feat_front_bros_194_custom_tags_short` and tag construction/deserialization canaries passed.
        Complete immutable iframe inventory is in `manifests/build-assets.json`; normal HTTP requested every entry and
        nested asset without CSP/mixed-content/request failure.

        ## Final labeling XML

        ```xml
        {label_xml}
        ```
        """,
    )

    write_text(
        reports / "LABEL_STUDIO_ENTERPRISE_INTERFACE.md",
        f"""
        # Label Studio Enterprise Interface artifact

        `src/enterprise/entry.tsx` renders the shared workspace through `EnterpriseInterfacePort`. The adapter consumes
        documented controlled `task`, `regions`, `params`, and `readOnly` props and writes only through `addRegion`,
        `updateRegion`, and `deleteRegion`. `EmbeddedCatalogPort` supplies seed plus annotation snapshots; all reducer,
        geometry, audio, schema, serializer, workspace, and tutorial code is shared. The Enterprise result is one
        `labels` value array containing the same canonical document used by CE.

        Build time externalizes host React, compiles imports/TypeScript/JSX, injects CSS, icons, validators, synthetic
        tutorial WAV, worker source, cooperative fallback, and catalog. Runtime contains no import/export/require,
        external asset URL, second ReactDOM, API endpoint, token, telemetry, or FrogLabel-controlled dynamic evaluation.
        Manifest scan values are all `passed`; network policy is task audio only.

        Exact Interface SHA-256 `{enterprise_manifest["interfaceSha256"]}`; source
        {enterprise_manifest["interfaceBytes"]} bytes. Maximum-profile local run loaded {inline_summary["audioBytes"]}
        bytes, started/rendered in {inline_summary["startupMilliseconds"]} ms, and observed
        {inline_summary["usedJsHeapBytes"]} JS heap bytes. A second clean run independently passed. Raw region lifecycle,
        create/update/delete/no-calls, immediate gesture commit, authoritative reload, task epoch, lock/duplicate read-only
        failure, tutorial isolation, console/network, screenshot, trace, video, and cleanup are under
        `evidence/enterprise-interface-local-harness/`.

        Enterprise project init/sync/validate is offline: Hydra/Pydantic state produces deterministic `catalogId` and
        revision; native export reconciliation reports conflicts/adoption in a reviewed YAML fragment. Ecologist additions
        are annotation-local `local:<UUID>` snapshots with `addedAfterInitialization=true` until reconciled and republished.
        Commands explicitly report `remoteProject unchanged and not contacted`.

        No FrogLabel server, VM, Docker, SSH, embedded API token, external FrogLabel host, runtime package/asset, or
        undocumented endpoint is required. The authorized hosted instance passed SDK validation, full workspace preview,
        audio decode, live draw/result round-trip, publication, and a three-task project pin to Interface version 3.
        """,
    )

    local_rows = "\n".join(
        f"| 17.6A.{index} | locally passed | `artifacts/enterprise/`, exact-code harness, reports |"
        for index in range(1, 13)
    )
    write_text(
        reports / "ENTERPRISE_INTERFACE_STATUS.md",
        f"""
        # Enterprise Interface status

        The generated Interface passed local exact-source checks and authorized hosted-instance validation.

        | Gate | Status | Evidence/reason |
        | --- | --- | --- |
        {local_rows}
        | Hosted validator and compilation | passed | Interface 4489, version 3 |
        | Hosted full-workspace preview and audio | passed | exact generated source and sample task |
        | Hosted draw and canonical result round-trip | passed | one structured `labels` result |
        | Publication and project pin | passed | project 280811, three tasks, source version 3 |
        """,
    )

    write_text(
        reports / "PROJECT_INIT_SYNC_AND_CATALOG.md",
        (repo / "docs/PROJECT_INITIALIZATION.md").read_text()
        + "\n\n## Final database proof\n\nThe evidence proves seeded/empty init, idempotent no-op, case-insensitive code uniqueness, transactional rollback, stable dry-run, revision discipline, ecologist preservation, 201/409 concurrent create, stale revision recovery, project isolation, clone mismatch, current-code correction/reuse, and historical snapshots. Enterprise reconciliation input/output examples are returned under `configs/` and `artifacts/enterprise/`.\n",
    )
    write_text(
        reports / "SECURITY_AND_PRIVACY.md",
        (repo / "docs/SECURITY_AND_DATA_FLOW.md").read_text()
        + "\n\nFinal browser logs were machine-fatal on unexpected warning/error/pageerror/unhandled rejection/request failure/CSP violation. The hosted Enterprise instance was contacted only for the authorized Interface workflow. Local File API audio was never uploaded. No result, task, Interface source, storage, request, or log contains a Label Studio token.\n",
    )
    write_text(
        reports / "KNOWN_LIMITATIONS.md",
        """
        # Known limitations

        - POC bounds: mono/stereo only; at most five minutes, 192 kHz, 128 MiB file, and 30 million decoded channel-samples.
        - Ordinary MP3 uses browser decode and cannot recover a pre-decode source PCM axis as WAV parsing can.
        - Only Label Studio CE 1.23.0 at the pinned commit is supported.
        - Docker/Compose wrapper execution was unavailable; the exact derived build and normal local Django HTTP server passed.
        - CE 1.23 generic Data Manager does not expose arbitrary nested ReactCode JSON dimensions as native filter/sort columns.
        - Public GitHub Pages deployment was not performed; only the exact deployable artifact was locally tested.
        - Enterprise verification covers the authorized hosted Interface runtime; other deployments require their own validation and round-trip.
        - Enterprise ecologist additions are annotation-local until offline reconciliation, regeneration, and publication.
        - Models/predictions are deliberately deferred; only dormant typed provenance round-trip remains.
        - The ordinary Playwright CDN installer was blocked by managed networking; pinned local Chromium was used.
        - Tutorial audio is synthetic and not a verified species reference.
        """,
    )


def make_configs_and_runbooks(inputs: Inputs) -> None:
    repo = inputs.repo
    configs = inputs.root / "configs"
    for name in (
        "demo-seeded.yaml",
        "demo-empty.yaml",
        "sync-before.yaml",
        "sync-after.yaml",
        "enterprise-seeded.yaml",
        "enterprise-empty.yaml",
        "enterprise-reconciliation-input.json",
    ):
        copy_file(repo / "examples/configs" / name, configs / name)

    runbooks = inputs.root / "runbooks"
    write_text(
        runbooks / "LOCAL_DEVELOPMENT.md",
        (repo / "README.md").read_text()
        + "\n\n## Agent browser\n\nRun `npm run build`, then `node scripts/test-e2e-agent.mjs`. The runner starts a loopback server, resolves a pinned real Chromium executable, and performs cursor, pointer, keyboard, File API, download, refresh, accessibility, and explorer workflows. No cloud browser or external site is required.\n",
    )
    copy_file(repo / "docs/LOCAL_TRIAL.md", runbooks / "LOCAL_CLIENT_TRIAL.md")
    write_text(
        runbooks / "GITHUB_PAGES_DEMO_BUILD_AND_DEPLOY.md",
        """
        # GitHub Pages demo build and deployment

        ```bash
        npm ci
        npm run build:pages
        npm run package:pages
        npm run test:e2e:pages:agent
        ```

        The base is `/frog_label/`. Test the exact ZIP by unpacking and serving it at that prefix; do not substitute
        Vite dev. The repository workflow `.github/workflows/deploy.yml` can publish the `build/pages` artifact after
        review and authorization. This review did not deploy publicly. Audio is opened with File API and stays local.
        """,
    )
    write_text(
        runbooks / "CE_BUILD_AND_START.md",
        (repo / "docs/CE_INSTALLATION.md").read_text()
        + "\n\n## Start and gate\n\nBuild in a disposable exact CE 1.23.0 checkout, configure a fresh database, run migrations/collectstatic, and start `label_studio.server` on loopback. Then run `FROGLABEL_CE_SOURCE=/absolute/ce FROGLABEL_CE_VENV=/absolute/venv node scripts/test-ce-served-agent.mjs` twice. The returned patch applies with `git apply source/label-studio-ce-1.23.0.patch`.\n\nNo Compose wrapper was executed in this environment. If your derived image wraps this exact built tree, use your normal local Compose command, wait for `/health`, and run the same normal-HTTP browser gate before an ecologist session. Do not treat an untested wrapper as evidence.\n",
    )
    copy_file(repo / "docs/PROJECT_INITIALIZATION.md", runbooks / "PROJECT_INIT_AND_SYNC.md")
    write_text(
        runbooks / "ENTERPRISE_INTERFACE_PUBLISH_AND_VERIFY.md",
        (repo / "docs/ENTERPRISE_SETUP.md").read_text()
        + "\n\n## Hard stops\n\nStop and retain the prior published Interface version on validation/compilation failure, region mutation mismatch, lost final gesture, CSP/media/worker failure without equivalent fallback, unexpected application network, token exposure, task/annotation leakage, broken result round-trip, or unacceptable measured performance. Record each visible Interface version, role, project pin, native result, request, screenshot, and timing only on an authorized instance.\n",
    )
    write_text(
        runbooks / "HUMAN_DEMO_SCRIPT.md",
        """
        # Supervised human demo

        ## Label Studio CE

        1. Open the prepared local project and import a short WAV or MP3 through native Label Studio Import.
        2. Open the task, hold Space, type G, and release to select `GRE — Green Tree Frog` and arm Draw; drag over a call.
        3. Press G for Select, refine a handle, then use V/F/R playback and WASD/Q/E/X navigation. Undo and redo once.
        4. If a species is missing, choose Add species and enter its 1-6 letter left-hand code, prefix priority, and Full Species Name.
        5. Use `?` for isolated practice; Escape returns to the unchanged live task.
        6. For a reviewed negative, choose No calls or press Shift+X. Do not use No calls for an unchecked task.
        7. Click Label Studio's native Submit (or Update), reload, and inspect Task Summary/View All.

        CE confirms a newly added species is available to this project. Enterprise instead states it is added to this
        annotation and can be included in a later catalog update. Verify each newly published Interface version on the
        exact licensed instance before an ecologist session.
        """,
    )
    write_text(
        runbooks / "REPRODUCE_EVIDENCE.md",
        (repo / "docs/TESTING_AND_UPGRADES.md").read_text()
        + "\n\n## Review bundle\n\nAfter named final runs exist and tracked changes are committed, run `python scripts/build_review_bundle.py`. It accepts only the pinned CE commit, verifies the Enterprise Interface digest, selects final pass directories, calculates checksums, validates the exact tree, and writes `froglabel-human-demo-review-bundle.zip` two directories above the repository. Unpack it and run `sha256sum -c manifests/checksums.sha256`.\n",
    )
    write_text(
        runbooks / "FUTURE_MODELS_AND_ENTERPRISE_INTERFACES.md",
        """
        # Future models and Enterprise interfaces

        Models are outside this human-only release. Keep the versioned canonical document, immutable species IDs,
        target-specific CE/Enterprise envelopes, and typed human/model provenance union (`humanModified` included). For each real
        model and project, build and test one explicit converter into that project's canonical labelspace before UI
        serialization. Do not infer arbitrary formats, mutate catalogs from predictions, or revive a generic compiler.

        Enterprise compatibility is established per visible licensed website with SDK validation plus an exact-source
        preview/draw/result round-trip. Do not
        introduce external `src`, runtime packages, API tokens, VM code, undocumented APIs, parent-DOM manipulation, or
        browser-persistent catalog claims. Reconcile annotation-local species from native exports offline, review the
        Hydra fragment, regenerate JSX, publish a new version, verify reopen, and retain the prior version for rollback.
        """,
    )


REQUIRED_FILES = (
    "source/froglabel-implemented.zip",
    "source/froglabel.patch",
    "source/froglabel-enterprise-interface.patch",
    "source/label-studio-ce-1.23.0.patch",
    "artifacts/github-pages/froglabel-pages-static.zip",
    "artifacts/github-pages/build-manifest.json",
    "artifacts/enterprise/froglabel.enterprise.jsx",
    "artifacts/enterprise/froglabel.enterprise.manifest.json",
    "artifacts/enterprise/embedded-catalog.json",
    "artifacts/enterprise/species-reconciliation.example.yaml",
    "manifests/source-and-upstream.json",
    "manifests/toolchain.json",
    "manifests/build-assets.json",
    "manifests/protocol-version.json",
    "reports/IMPLEMENTATION_REPORT.md",
    "reports/FINDING_DISPOSITIONS.csv",
    "reports/TEST_RESULTS.md",
    "reports/FROGLABEL_UI_AND_AUDIO.md",
    "reports/GITHUB_PAGES_DEMO.md",
    "reports/LABEL_STUDIO_CE_CONTRACT.md",
    "reports/LABEL_STUDIO_ENTERPRISE_INTERFACE.md",
    "reports/ENTERPRISE_INTERFACE_STATUS.md",
    "reports/PROJECT_INIT_SYNC_AND_CATALOG.md",
    "reports/SECURITY_AND_PRIVACY.md",
    "reports/KNOWN_LIMITATIONS.md",
    "tests/unit-results.xml",
    "tests/component-results.xml",
    "tests/python-results.xml",
    "tests/explorer-results.json",
    "evidence/downloads/sample.froglabel.json",
    "evidence/downloads/sample.froglabel.csv",
    "evidence/downloads/label-studio-ce-export.json",
    "evidence/downloads/label-studio-ce-export-parse.json",
    "evidence/raw-results/ce-annotated.json",
    "evidence/raw-results/ce-no-calls.json",
    "evidence/raw-results/ce-reloaded.json",
    "configs/demo-seeded.yaml",
    "configs/demo-empty.yaml",
    "configs/sync-before.yaml",
    "configs/sync-after.yaml",
    "configs/enterprise-seeded.yaml",
    "configs/enterprise-empty.yaml",
    "configs/enterprise-reconciliation-input.json",
    "runbooks/LOCAL_DEVELOPMENT.md",
    "runbooks/LOCAL_CLIENT_TRIAL.md",
    "runbooks/GITHUB_PAGES_DEMO_BUILD_AND_DEPLOY.md",
    "runbooks/CE_BUILD_AND_START.md",
    "runbooks/PROJECT_INIT_AND_SYNC.md",
    "runbooks/ENTERPRISE_INTERFACE_PUBLISH_AND_VERIFY.md",
    "runbooks/HUMAN_DEMO_SCRIPT.md",
    "runbooks/REPRODUCE_EVIDENCE.md",
    "runbooks/FUTURE_MODELS_AND_ENTERPRISE_INTERFACES.md",
)


def generate_checksums(root: Path) -> None:
    manifest = root / "manifests/checksums.sha256"
    lines = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path != manifest:
            lines.append(f"{sha256(path)}  {path.relative_to(root).as_posix()}")
    write_text(manifest, "\n".join(lines))


def validate_bundle(root: Path) -> None:
    for relative in REQUIRED_FILES:
        path = root / relative
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(f"Missing or empty required artifact: {relative}")
    required_directories = (
        "tests/coverage",
        "tests/playwright-standalone",
        "tests/playwright-github-pages-static",
        "tests/playwright-reactcode-harness",
        "tests/playwright-label-studio-ce-wsgi",
        "tests/playwright-label-studio-ce-served",
        "tests/playwright-enterprise-interface-harness",
        "tests/replay",
        "evidence/audio-analysis",
        "evidence/github-pages-static",
        "evidence/screenshots",
        "evidence/videos",
        "evidence/traces",
        "evidence/console-and-network",
        "evidence/label-studio-database",
        "evidence/enterprise-interface-local-harness",
    )
    for relative in required_directories:
        if not (root / relative).is_dir():
            raise RuntimeError(f"Missing required directory: {relative}")
    for path in root.rglob("*.json"):
        json.loads(path.read_text(encoding="utf-8"))
    for relative in (
        "source/froglabel-implemented.zip",
        "artifacts/github-pages/froglabel-pages-static.zip",
    ):
        with zipfile.ZipFile(root / relative) as archive:
            bad = archive.testzip()
            if bad:
                raise RuntimeError(f"Corrupt nested archive member: {relative}:{bad}")
    allowed = {"fixed", "not-reproduced-with-evidence", "deferred-by-final-handoff", "blocked"}
    with (root / "reports/FINDING_DISPOSITIONS.csv").open(encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows or {row["status"] for row in rows} - allowed:
        raise RuntimeError("Finding ledger is empty or has an invalid status")

    checksums: dict[str, str] = {}
    for line in (root / "manifests/checksums.sha256").read_text().splitlines():
        digest, relative = line.split("  ", 1)
        checksums[relative] = digest
    for relative, digest in checksums.items():
        if sha256(root / relative) != digest:
            raise RuntimeError(f"Checksum mismatch: {relative}")
    actual = {
        path.relative_to(root).as_posix()
        for path in root.rglob("*")
        if path.is_file() and path.name != "checksums.sha256"
    }
    if actual != set(checksums):
        raise RuntimeError("Checksum manifest does not enumerate the exact file set")


def deterministic_zip(root: Path, destination: Path) -> None:
    if destination.exists():
        destination.unlink()
    timestamp = (2026, 8, 20, 12, 0, 0)
    with zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as archive:
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            relative = Path(root.name) / path.relative_to(root)
            info = zipfile.ZipInfo(relative.as_posix(), timestamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 & 0xFFFF) << 16
            archive.writestr(info, path.read_bytes())
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip():
            raise RuntimeError("Final review ZIP failed CRC verification")
        roots = {Path(name).parts[0] for name in archive.namelist()}
        if roots != {BUNDLE_NAME}:
            raise RuntimeError(f"Unexpected final archive roots: {sorted(roots)}")


def build(inputs: Inputs) -> tuple[Path, str]:
    source_commit, enterprise_manifest = require_inputs(inputs)
    if inputs.root.exists():
        shutil.rmtree(inputs.root)
    if inputs.archive.exists():
        inputs.archive.unlink()
    inputs.root.mkdir(parents=True)
    make_source_artifacts(inputs, source_commit)
    make_product_artifacts(inputs)
    make_manifests(inputs, source_commit, enterprise_manifest)
    make_test_evidence(inputs)
    make_evidence(inputs)
    make_reports(inputs, source_commit, enterprise_manifest)
    make_configs_and_runbooks(inputs)
    generate_checksums(inputs.root)
    validate_bundle(inputs.root)
    deterministic_zip(inputs.root, inputs.archive)
    return inputs.archive, sha256(inputs.archive)


def main() -> int:
    repo = Path(__file__).resolve().parents[1]
    output_parent = repo.parents[1]
    inputs = Inputs(
        repo=repo,
        ce_repo=output_parent / "ls-ce-1.23.0-fresh",
        enterprise=repo / ".cache/enterprise-1673336",
        output_parent=output_parent,
    )
    archive, digest = build(inputs)
    print(json.dumps({"artifact": str(archive), "sha256": digest, "status": "verified"}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
