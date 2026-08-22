from __future__ import annotations

import json
import sys
from dataclasses import asdict
from typing import Any

from .admin_config import ProjectConfiguration
from .ce_runtime import _PROJECT_RESULT_PREFIX
from .ce_store import CeProjectAdministrator
from .errors import FrogLabelCliError


def execute(request: dict[str, Any]) -> dict[str, Any]:
    """Execute a validated CE administration request inside the derived environment."""

    command = request.get("command")
    project_id = request.get("project")
    if command not in {"init", "sync", "validate"}:
        raise FrogLabelCliError("COMMAND_TARGET_UNSUPPORTED", f"Unsupported CE command: {command}")
    if not isinstance(project_id, int) or isinstance(project_id, bool) or project_id <= 0:
        raise FrogLabelCliError("PROJECT_ID_REQUIRED", "CE commands require a positive project ID")

    raw_candidate = request.get("candidate")
    candidate = (
        ProjectConfiguration.model_validate(raw_candidate) if raw_candidate is not None else None
    )
    administrator = CeProjectAdministrator()
    if command == "validate":
        return administrator.validate(project_id, candidate=candidate)
    if candidate is None:
        raise FrogLabelCliError(
            "CONFIG_NAME_REQUIRED", f"CE project {command} requires a project configuration"
        )
    if command == "init":
        return (
            administrator.repair_clone(project_id, candidate)
            if request.get("repairClone") is True
            else administrator.init(project_id, candidate)
        )
    return administrator.sync(project_id, candidate, apply=request.get("apply") is True)


def main() -> int:
    try:
        request = json.loads(sys.stdin.read())
        if not isinstance(request, dict):
            raise FrogLabelCliError(
                "CE_PROJECT_PROTOCOL_INVALID", "CE project request must be a JSON object"
            )
        response: dict[str, Any] = {"ok": True, "result": execute(request)}
    except FrogLabelCliError as error:
        response = {
            "ok": False,
            "error": {
                "code": error.code,
                "message": str(error),
                "context": asdict(error.context),
            },
        }
    print(_PROJECT_RESULT_PREFIX + json.dumps(response, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
