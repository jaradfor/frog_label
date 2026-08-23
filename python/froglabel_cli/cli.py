from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .admin_config import ProjectConfiguration, Target, load_project_configuration
from .ce_installer import CeSourceInstaller
from .ce_runtime import CeRuntime
from .enterprise import EnterpriseProjectAdministrator
from .errors import FrogLabelCliError
from .exports import export_label_studio_project


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="froglabel",
        description="FrogLabel human-labeling project administration",
    )
    root = parser.add_subparsers(dest="area", required=True)

    project = root.add_parser(
        "project",
        help="Initialize, synchronize, validate, or render a FrogLabel project",
    )
    commands = project.add_subparsers(dest="command", required=True)

    initialize = commands.add_parser("init", help="Initialize one project target")
    _target_args(initialize)
    _configuration_args(initialize, required=True)
    initialize.add_argument(
        "--repair-clone",
        action="store_true",
        help="CE only: replace catalog links copied from another project",
    )

    sync = commands.add_parser("sync", help="Plan or apply configuration intent")
    _target_args(sync)
    _configuration_args(sync, required=True)
    mode = sync.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true", help="Print a deterministic plan only")
    mode.add_argument("--apply", action="store_true", help="Apply the displayed plan")
    sync.add_argument(
        "--label-studio-export",
        type=Path,
        help="Enterprise only: offline native export to inspect for catalog additions",
    )
    sync.add_argument(
        "--reconciliation-output",
        type=Path,
        help="Enterprise only: write a proposed Hydra catalog fragment",
    )

    validate = commands.add_parser("validate", help="Read and validate current project state")
    _target_args(validate)
    _configuration_args(validate, required=False)

    render = commands.add_parser(
        "render",
        help="Regenerate Enterprise artifacts from already-applied local state",
    )
    _target_args(render, enterprise_only=True)
    _configuration_args(render, required=True)

    exports = root.add_parser("export", help="Validate and flatten a native project export")
    export_commands = exports.add_subparsers(dest="command", required=True)
    flat = export_commands.add_parser("flat", help="Write canonical JSON and flat CSV")
    flat.add_argument("--input", type=Path, required=True, help="Native Label Studio JSON export")
    flat.add_argument("--json-output", type=Path, required=True)
    flat.add_argument("--csv-output", type=Path, required=True)

    ce = root.add_parser("ls-ce", help="Build the exact supported CE source integration")
    ce_commands = ce.add_subparsers(dest="command", required=True)
    prepare = ce_commands.add_parser(
        "prepare",
        aliases=["install"],
        help="Apply the pinned patch, build CE, and install FrogLabel assets",
    )
    prepare.add_argument("--source", type=Path, required=True)
    prepare.add_argument("--assets", type=Path, required=True)
    prepare.add_argument(
        "--skip-build",
        action="store_true",
        help="Structural diagnostic only; does not produce a runnable derived build",
    )
    start = ce_commands.add_parser(
        "start", help="Run the supported CE overlay after fail-fast integration canaries"
    )
    start.add_argument("--source", type=Path, required=True)
    start.add_argument("--bind", default="127.0.0.1:8080")
    start.add_argument("--data-dir", type=Path)
    start.add_argument(
        "--check-only", action="store_true", help="Run canaries without starting the server"
    )
    return parser


def _target_args(parser: argparse.ArgumentParser, *, enterprise_only: bool = False) -> None:
    parser.add_argument(
        "--target",
        choices=("enterprise",) if enterprise_only else ("ce", "enterprise"),
        default="enterprise" if enterprise_only else "ce",
        help="CE mutates the local Django database; Enterprise only writes local artifacts",
    )
    parser.add_argument("--project", type=int, help="Authoritative CE project ID")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("dist/enterprise"),
        help="Enterprise local state and generated artifact directory",
    )
    if not enterprise_only:
        parser.add_argument(
            "--source",
            type=Path,
            help="CE only: exact prepared Label Studio source checkout",
        )
        parser.add_argument(
            "--data-dir",
            type=Path,
            help="CE only: Label Studio data directory used by the running server",
        )


def _configuration_args(parser: argparse.ArgumentParser, *, required: bool) -> None:
    parser.add_argument(
        "--config-dir",
        type=Path,
        help="Hydra configuration directory (packaged configs are used when omitted)",
    )
    parser.add_argument(
        "--config-name",
        required=required,
        help="Named Hydra root configuration; for example client_demo or base",
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = dispatch(args)
        if result is not None:
            print(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True))
        return 0
    except FrogLabelCliError as error:
        print(error.render(), file=sys.stderr)
        return 2


def dispatch(args: argparse.Namespace) -> dict[str, Any] | None:
    if args.area == "project":
        return _dispatch_project(args)
    if args.area == "export":
        if args.command != "flat":
            raise FrogLabelCliError("COMMAND_UNKNOWN", "Unknown export command")
        return export_label_studio_project(args.input, args.json_output, args.csv_output)
    if args.area == "ls-ce":
        if args.command in {"prepare", "install"}:
            installer = CeSourceInstaller(args.source, args.assets)
            return installer.install(build=not args.skip_build).as_dict()
        if args.command == "start":
            runtime = CeRuntime(args.source)
            return (
                runtime.canary(data_dir=args.data_dir)
                if args.check_only
                else runtime.start(bind=args.bind, data_dir=args.data_dir)
            )
        raise FrogLabelCliError("COMMAND_UNKNOWN", "Unknown Label Studio CE command")
    raise FrogLabelCliError("COMMAND_UNKNOWN", "Unknown command")


def _dispatch_project(args: argparse.Namespace) -> dict[str, Any]:
    target: Target = args.target
    _validate_target_arguments(args, target)
    candidate = None
    resolved = None
    if args.config_name is not None:
        candidate, resolved = load_project_configuration(
            config_name=args.config_name,
            target=target,
            config_dir=args.config_dir,
            project_id=args.project,
        )

    if target == "ce":
        # Complete Hydra/Pydantic validation before initializing Django or beginning a mutation.
        assert args.project is not None
        assert args.source is not None
        assert args.data_dir is not None
        runtime = CeRuntime(args.source)
        result = runtime.run_project_administration(
            command=args.command,
            project_id=args.project,
            candidate=_ce_candidate_payload(candidate),
            apply=getattr(args, "apply", False),
            repair_clone=getattr(args, "repair_clone", False),
            data_dir=args.data_dir,
        )
    else:
        administrator = EnterpriseProjectAdministrator()
        if args.command == "validate":
            result = administrator.validate(args.output_dir, candidate=candidate)
        else:
            assert candidate is not None
            if args.command == "init":
                result = administrator.init(args.output_dir, candidate)
            elif args.command == "sync":
                result = administrator.sync(
                    args.output_dir,
                    candidate,
                    apply=args.apply,
                    label_studio_export=args.label_studio_export,
                    reconciliation_output=args.reconciliation_output,
                )
            elif args.command == "render":
                result = administrator.render(args.output_dir, candidate)
            else:
                raise FrogLabelCliError("COMMAND_UNKNOWN", "Unknown Enterprise project command")

    if resolved is not None:
        result = {**result, "resolvedConfiguration": resolved}
    return result


def _ce_candidate_payload(candidate: ProjectConfiguration | None) -> dict[str, Any] | None:
    if candidate is None:
        return None
    return candidate.model_dump(
        by_alias=True,
        mode="json",
        exclude_unset=True,
    )


def _validate_target_arguments(args: argparse.Namespace, target: Target) -> None:
    if target == "ce":
        if args.project is None or args.project <= 0:
            raise FrogLabelCliError(
                "PROJECT_ID_REQUIRED", "CE commands require --project PROJECT_ID"
            )
        if args.output_dir != Path("dist/enterprise"):
            raise FrogLabelCliError(
                "CE_OUTPUT_DIRECTORY_FORBIDDEN", "CE commands do not accept --output-dir"
            )
        if getattr(args, "source", None) is None:
            raise FrogLabelCliError(
                "CE_SOURCE_REQUIRED", "CE project commands require --source LABEL_STUDIO_SOURCE"
            )
        if getattr(args, "data_dir", None) is None:
            raise FrogLabelCliError(
                "CE_DATA_DIRECTORY_REQUIRED",
                "CE project commands require --data-dir LABEL_STUDIO_DATA_DIR",
            )
        if getattr(args, "label_studio_export", None) is not None:
            raise FrogLabelCliError(
                "CE_RECONCILIATION_FORBIDDEN",
                "--label-studio-export is an offline Enterprise reconciliation input",
            )
        if getattr(args, "reconciliation_output", None) is not None:
            raise FrogLabelCliError(
                "CE_RECONCILIATION_FORBIDDEN",
                "--reconciliation-output is available only for Enterprise",
            )
    else:
        if args.project is not None:
            raise FrogLabelCliError(
                "ENTERPRISE_PROJECT_ARGUMENT_FORBIDDEN",
                "Enterprise generation has no authoritative website project ID; omit --project",
            )
        if getattr(args, "repair_clone", False):
            raise FrogLabelCliError(
                "ENTERPRISE_REPAIR_CLONE_FORBIDDEN",
                "Enterprise clones require a separate output state and regenerated artifact",
            )
        if getattr(args, "source", None) is not None:
            raise FrogLabelCliError(
                "ENTERPRISE_CE_SOURCE_FORBIDDEN", "Enterprise commands do not accept --source"
            )
        if getattr(args, "data_dir", None) is not None:
            raise FrogLabelCliError(
                "ENTERPRISE_CE_DATA_DIRECTORY_FORBIDDEN",
                "Enterprise commands do not accept --data-dir",
            )
    if args.command == "validate" and args.config_dir is not None and args.config_name is None:
        raise FrogLabelCliError(
            "CONFIG_NAME_REQUIRED", "--config-dir requires --config-name during validation"
        )
    if (
        getattr(args, "reconciliation_output", None) is not None
        and getattr(args, "label_studio_export", None) is None
    ):
        raise FrogLabelCliError(
            "RECONCILIATION_INPUT_REQUIRED",
            "--reconciliation-output requires --label-studio-export",
        )


if __name__ == "__main__":
    raise SystemExit(main())
