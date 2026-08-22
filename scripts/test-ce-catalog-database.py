#!/usr/bin/env python3
"""Exercise FrogLabel catalog administration against a real disposable CE database."""

from __future__ import annotations

import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from typing import Any

import django


def candidate(
    project_id: int,
    species: list[dict[str, Any]],
    *,
    default: str | None = None,
) -> Any:
    from froglabel_cli.admin_config import ProjectConfiguration

    return ProjectConfiguration.model_validate(
        {
            "schemaVersion": 1,
            "project": {"hostProjectId": project_id, "defaultSpeciesId": default},
            "catalog": {"species": species},
            "audio": {},
            "ui": {},
        }
    )


def database_snapshot(project_id: int) -> dict[str, Any]:
    from labels_manager.models import Label, LabelLink
    from projects.models import Project
    from tasks.models import Annotation

    return {
        "annotations": list(
            Annotation.objects.filter(project_id=project_id).order_by("id").values("id", "result")
        ),
        "labelLinks": list(
            LabelLink.objects.filter(project_id=project_id)
            .order_by("id")
            .values("id", "label_id", "from_name")
        ),
        "labels": list(
            Label.objects.filter(links__project_id=project_id)
            .order_by("id")
            .values("id", "title", "value", "approved")
        ),
        "project": Project.objects.values("label_config", "enable_empty_annotation").get(
            id=project_id
        ),
    }


def catalog_post(
    user: Any,
    project_id: int,
    revision: int,
    code: str,
    name: str,
    barrier: threading.Barrier | None = None,
) -> tuple[int, dict[str, Any]]:
    from django.db import close_old_connections
    from rest_framework.test import APIRequestFactory, force_authenticate

    from froglabel_cli.ce_overlay.views import ProjectCatalogView

    close_old_connections()
    request = APIRequestFactory().post(
        f"/froglabel/api/projects/{project_id}/catalog/",
        {
            "expectedRevision": revision,
            "species": {"code": code, "speciesName": name},
        },
        format="json",
    )
    force_authenticate(request, user=user)
    if barrier is not None:
        barrier.wait(timeout=10)
    response = ProjectCatalogView.as_view()(request, project_id=project_id)
    response.render()
    close_old_connections()
    return response.status_code, deepcopy(response.data)


def assert_raises_code(callable_: Any, code: str) -> str:
    from froglabel_cli.errors import FrogLabelCliError

    try:
        callable_()
    except FrogLabelCliError as error:
        assert error.code == code, (error.code, code)
        return error.render()
    raise AssertionError(f"Expected FrogLabelCliError {code}")


def main() -> int:
    django.setup()

    from labels_manager.models import LabelLink
    from organizations.models import Organization
    from projects.models import Project
    from tasks.models import Annotation, Task
    from users.models import User

    from froglabel_cli.ce_store import (
        DESCRIPTOR_FROM_NAME,
        SPECIES_FROM_NAME,
        CeProjectAdministrator,
        descriptor_title,
        species_title,
    )

    assert not any(model.objects.exists() for model in (User, Organization, Project, Task))
    owner = User.objects.create_superuser(email="catalog-owner@example.test", password="local-only")
    organization = Organization.create_organization(created_by=owner, title="Catalog evidence")
    owner.active_organization = organization
    owner.save(update_fields=["active_organization"])

    def new_project(title: str) -> Project:
        return Project.objects.create(
            title=title,
            organization=organization,
            created_by=owner,
            enable_empty_annotation=True,
        )

    seed = [
        {
            "speciesId": "local:green-tree-frog",
            "code": "GRE",
            "speciesName": "Green Tree Frog",
            "scientificName": "Ranoidea caerulea",
        }
    ]
    administrator = CeProjectAdministrator()
    first = new_project("Catalog project one")
    second = new_project("Catalog project two")
    first_config = candidate(first.id, seed, default="local:green-tree-frog")
    second_config = candidate(second.id, seed, default="local:green-tree-frog")
    first_init = administrator.init(first.id, first_config)
    second_init = administrator.init(second.id, second_config)
    assert first_init["initialized"] is True and second_init["initialized"] is True

    first_live = administrator.read_catalog(first.id)
    second_live = administrator.read_catalog(second.id)
    assert first_live.descriptor.catalog_id != second_live.descriptor.catalog_id
    first_species_link = LabelLink.objects.get(project=first, from_name=SPECIES_FROM_NAME)
    second_species_link = LabelLink.objects.get(project=second, from_name=SPECIES_FROM_NAME)
    assert first_species_link.label_id != second_species_link.label_id
    assert first_species_link.id != second_species_link.id

    before_repeat = database_snapshot(first.id)
    repeat = administrator.init(first.id, first_config)
    assert repeat["initialized"] is False
    assert repeat["plan"]["semanticChange"] is False
    assert database_snapshot(first.id) == before_repeat

    task = Task.objects.create(
        project=first,
        data={"froglabel": "/react-app/froglabel/audio/synthetic-frog-practice.wav"},
        overlap=1,
    )
    historical_document = {
        "kind": "froglabel.annotation-set",
        "schemaVersion": 1,
        "catalogId": first_live.descriptor.catalog_id,
        "reviewStatus": "calls_present",
        "boxes": [
            {
                "id": "box:historical",
                "species": {
                    "speciesId": "local:green-tree-frog",
                    "code": "GRE",
                    "speciesName": "Green Tree Frog",
                    "addedAfterInitialization": False,
                },
                "startTimeSeconds": 0.123456789012345,
                "endTimeSeconds": 0.987654321098765,
                "lowFrequencyHz": 700.125,
                "highFrequencyHz": 2400.875,
                "provenance": {"source": "human"},
            }
        ],
    }
    annotation = Annotation.objects.create(
        task=task,
        project=first,
        completed_by=owner,
        result=[
            {
                "id": "outer:stable",
                "from_name": "froglabel",
                "to_name": "froglabel",
                "type": "reactcode",
                "value": {"reactcode": historical_document},
            }
        ],
    )

    add_status, add_body = catalog_post(
        owner,
        first.id,
        first_live.descriptor.catalog_revision,
        "per",
        "Peron's Tree Frog",
    )
    assert add_status == 201
    assert add_body["catalog"]["catalogRevision"] == 2
    ecologist_species = next(
        item for item in add_body["catalog"]["species"] if item["code"] == "PER"
    )
    assert ecologist_species["addedAfterInitialization"] is True

    sync_species = [
        {
            "speciesId": "local:green-tree-frog",
            "code": "GTF",
            "speciesName": "Australian Green Tree Frog",
            "scientificName": "Ranoidea caerulea",
        },
        {
            "speciesId": "local:white-lipped-tree-frog",
            "code": "WHI",
            "speciesName": "White-lipped Tree Frog",
        },
    ]
    sync_config = candidate(first.id, sync_species, default="local:green-tree-frog")
    before_dry_run = database_snapshot(first.id)
    dry_one = administrator.sync(first.id, sync_config, apply=False)
    dry_two = administrator.sync(first.id, sync_config, apply=False)
    assert dry_one["plan"] == dry_two["plan"]
    assert dry_one["catalog"]["catalogRevision"] == 2
    assert database_snapshot(first.id) == before_dry_run
    applied = administrator.sync(first.id, sync_config, apply=True)
    assert applied["catalog"]["catalogRevision"] == 3
    assert {item["code"] for item in applied["catalog"]["species"]} == {"GTF", "PER", "WHI"}
    assert (
        next(item for item in applied["catalog"]["species"] if item["code"] == "WHI")[
            "addedAfterInitialization"
        ]
        is True
    )
    stored_document = Annotation.objects.get(id=annotation.id).result[0]["value"]["reactcode"]
    assert stored_document == historical_document
    noop = administrator.sync(first.id, sync_config, apply=True)
    assert noop["catalog"]["catalogRevision"] == 3
    assert noop["plan"]["semanticChange"] is False

    released_status, released_body = catalog_post(owner, first.id, 3, "gre", "Greater Frog")
    assert released_status == 201
    assert released_body["catalog"]["catalogRevision"] == 4
    current_by_id = {item["speciesId"]: item for item in released_body["catalog"]["species"]}
    assert current_by_id["local:green-tree-frog"]["code"] == "GTF"
    assert any(item["code"] == "GRE" for item in current_by_id.values())
    stored_document = Annotation.objects.get(id=annotation.id).result[0]["value"]["reactcode"]
    assert stored_document == historical_document

    empty = new_project("Concurrent empty catalog")
    administrator.init(empty.id, candidate(empty.id, []))
    barrier = threading.Barrier(2)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                catalog_post,
                owner,
                empty.id,
                1,
                "per",
                "Peron's Tree Frog",
                barrier,
            )
            for _ in range(2)
        ]
        concurrent = [future.result(timeout=30) for future in futures]
    assert sorted(status for status, _body in concurrent) == [201, 409]
    concurrent_live = administrator.read_catalog(empty.id)
    assert [item.code for item in concurrent_live.species] == ["PER"]
    loser_body = next(body for status, body in concurrent if status == 409)
    assert loser_body["error"]["code"] == "CATALOG_STALE"
    assert len(loser_body["catalog"]["species"]) == 1
    conflict_status, conflict_body = catalog_post(
        owner,
        empty.id,
        concurrent_live.descriptor.catalog_revision,
        "PER",
        "Different Frog",
    )
    assert conflict_status == 409
    assert conflict_body["error"]["code"] == "CATALOG_CODE_CONFLICT"

    outsider = User.objects.create_user(email="outsider@example.test", password="local-only")
    outsider_org = Organization.create_organization(created_by=outsider, title="Other organization")
    outsider.active_organization = outsider_org
    outsider.save(update_fields=["active_organization"])
    previous_log_disable = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        denied_status, _denied_body = catalog_post(
            outsider,
            first.id,
            4,
            "DEN",
            "Denied Frog",
        )
    finally:
        logging.disable(previous_log_disable)
    assert denied_status == 403

    fault_project = new_project("Init rollback")
    before_fault_init = database_snapshot(fault_project.id)

    def fail_before_descriptor(stage: str) -> None:
        if stage == "before-descriptor":
            raise RuntimeError("injected init failure")

    try:
        CeProjectAdministrator(fault_hook=fail_before_descriptor).init(
            fault_project.id,
            candidate(fault_project.id, seed, default="local:green-tree-frog"),
        )
    except RuntimeError as error:
        assert str(error) == "injected init failure"
    else:
        raise AssertionError("Injected init failure did not fire")
    assert database_snapshot(fault_project.id) == before_fault_init

    before_fault_sync = database_snapshot(first.id)
    fault_sync_species = [
        *sync_species,
        {"speciesId": "local:aaa", "code": "AAA", "speciesName": "A Frog"},
        {"speciesId": "local:bbb", "code": "BBB", "speciesName": "B Frog"},
    ]

    def fail_mid_sync(stage: str) -> None:
        if stage.startswith("after-species:local:a"):
            raise RuntimeError("injected sync failure")

    try:
        CeProjectAdministrator(fault_hook=fail_mid_sync).sync(
            first.id,
            candidate(first.id, fault_sync_species, default="local:green-tree-frog"),
            apply=True,
        )
    except RuntimeError as error:
        assert str(error) == "injected sync failure"
    else:
        raise AssertionError("Injected sync failure did not fire")
    assert database_snapshot(first.id) == before_fault_sync

    clone = new_project("Cloned project")
    first.refresh_from_db()
    clone.label_config = first.label_config
    clone.enable_empty_annotation = first.enable_empty_annotation
    clone.save(update_fields=["label_config", "enable_empty_annotation"])
    for link in LabelLink.objects.filter(
        project=first, from_name__in=(DESCRIPTOR_FROM_NAME, SPECIES_FROM_NAME)
    ):
        LabelLink.objects.create(project=clone, label=link.label, from_name=link.from_name)
    clone_message = assert_raises_code(
        lambda: administrator.validate(clone.id), "CATALOG_CLONE_MISMATCH"
    )
    assert "--repair-clone" in clone_message
    source_catalog_id = administrator.read_catalog(first.id).descriptor.catalog_id
    repaired = administrator.repair_clone(clone.id, candidate(clone.id, seed))
    assert repaired["catalog"]["catalogId"] != source_catalog_id
    assert repaired["catalog"]["catalogRevision"] == 1

    for project in (first, second, empty, clone):
        descriptor_link = LabelLink.objects.get(project=project, from_name=DESCRIPTOR_FROM_NAME)
        assert descriptor_link.label.title == descriptor_title(project.id)
        assert descriptor_link.label.approved is True
        assert descriptor_link.label.value["kind"] == "froglabel.species-catalog"
        for link in LabelLink.objects.filter(project=project, from_name=SPECIES_FROM_NAME):
            species_id = link.label.value["speciesId"]
            assert link.label.title == species_title(project.id, species_id)
            assert link.label.approved is True
            assert link.label.value["kind"] == "froglabel.species"
            assert link.label.value["hostProjectId"] == project.id

    final_first = administrator.validate(first.id)
    output = {
        "cloneMismatch": "detected-and-repaired",
        "concurrentCreateStatuses": sorted(status for status, _body in concurrent),
        "dryRunStable": True,
        "ecologistAdditionPreserved": True,
        "faultInjection": {"initRollback": True, "syncRollback": True},
        "finalCatalogRevision": final_first["catalog"]["catalogRevision"],
        "historicalSnapshotPreserved": True,
        "idempotentInitAndSync": True,
        "projectIsolation": True,
        "releasedCodeReuse": True,
        "schemaVersion": 1,
        "staleRevisionRecovery": True,
        "storageContract": True,
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
