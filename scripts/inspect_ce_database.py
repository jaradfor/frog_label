#!/usr/bin/env python3
"""Emit a deterministic read-only snapshot of a disposable CE evidence database."""

from __future__ import annotations

import json

import django


def main() -> int:
    django.setup()

    from labels_manager.models import Label, LabelLink
    from projects.models import Project
    from tasks.models import Annotation, Task

    payload = {
        "annotations": list(
            Annotation.objects.order_by("id").values(
                "id",
                "task_id",
                "project_id",
                "completed_by_id",
                "was_cancelled",
                "result",
            )
        ),
        "labelLinks": list(
            LabelLink.objects.order_by("id").values(
                "id",
                "label_id",
                "project_id",
                "from_name",
            )
        ),
        "labels": list(Label.objects.order_by("id").values("id", "title", "value")),
        "projects": list(
            Project.objects.order_by("id").values(
                "id",
                "title",
                "enable_empty_annotation",
                "label_config",
            )
        ),
        "tasks": list(Task.objects.order_by("id").values("id", "project_id", "data")),
    }
    print(json.dumps(payload, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
