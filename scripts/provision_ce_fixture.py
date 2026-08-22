#!/usr/bin/env python3
"""Provision one deterministic, disposable Label Studio CE browser fixture.

The caller owns database migration and supplies the normal FrogLabel CE Django
settings through the environment.  This helper intentionally refuses to reuse
state so browser evidence can never accumulate annotations between runs.
"""

from __future__ import annotations

import argparse
import json

import django


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument(
        "--task-audio-url",
        help="Optionally create one deterministic task for the restricted WSGI lane",
    )
    parser.add_argument(
        "--task-count",
        type=int,
        default=1,
        help="Number of deterministic tasks to create when --task-audio-url is supplied",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    django.setup()

    from organizations.models import Organization
    from projects.models import Project
    from tasks.models import Task
    from users.models import User

    if any(model.objects.exists() for model in (User, Organization, Project, Task)):
        raise RuntimeError("CE evidence fixture directory is not fresh")

    user = User.objects.create_user(email=args.email, password=args.password)
    organization = Organization.create_organization(
        created_by=user,
        title="FrogLabel disposable evidence organization",
    )
    user.active_organization = organization
    user.save(update_fields=["active_organization"])
    project = Project.objects.create(
        title=args.title,
        organization=organization,
        created_by=user,
    )
    project.add_collaborator(user)

    stock_project = Project.objects.create(
        title="Stock Label Studio regression canary",
        organization=organization,
        created_by=user,
        label_config=(
            '<View><Text name="text" value="$text"/>'
            '<Choices name="kind" toName="text" choice="single">'
            '<Choice value="Frog"/><Choice value="Other"/>'
            "</Choices></View>"
        ),
    )
    stock_project.add_collaborator(user)
    stock_task = Task.objects.create(
        project=stock_project,
        data={"text": "A stock Label Studio task, independent of FrogLabel."},
        inner_id=1,
        overlap=1,
    )

    outsider = User.objects.create_user(
        email="outsider@example.test",
        password=args.password,
    )
    outsider_organization = Organization.create_organization(
        created_by=outsider,
        title="Unprivileged evidence organization",
    )
    outsider.active_organization = outsider_organization
    outsider.save(update_fields=["active_organization"])

    tasks = []
    if args.task_audio_url:
        if args.task_count < 1 or args.task_count > 10:
            raise ValueError("--task-count must be between 1 and 10")
        for index in range(args.task_count):
            tasks.append(
                Task.objects.create(
                    project=project,
                    data={"froglabel": args.task_audio_url},
                    inner_id=index + 1,
                    overlap=1,
                )
            )

    if (user.id, organization.id, project.id, stock_project.id, stock_task.id) != (
        1,
        1,
        1,
        2,
        1,
    ):
        raise RuntimeError("Fresh CE fixture did not receive deterministic primary keys")

    print(
        json.dumps(
            {
                "organization": organization.id,
                "project": project.id,
                "stockProject": stock_project.id,
                "stockTask": stock_task.id,
                "task": tasks[0].id if tasks else None,
                "taskCount": len(tasks),
                "user": user.id,
                "outsider": outsider.id,
                "outsiderOrganization": outsider_organization.id,
                "isStaff": user.is_staff,
                "isSuperuser": user.is_superuser,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
