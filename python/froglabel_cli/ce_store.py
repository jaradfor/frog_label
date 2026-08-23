from __future__ import annotations

import importlib.metadata
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError

from .admin_config import ProjectConfiguration, configuration_fingerprint
from .catalog import (
    CatalogDescriptor,
    CatalogSyncPlan,
    LiveCatalog,
    StoredSpecies,
    initial_catalog,
    plan_catalog_sync,
)
from .ce_installer import INTEGRATION_VERSION
from .errors import ErrorContext, FrogLabelCliError
from .label_config import generate_ce_label_config, normalized_xml, validate_ce_label_config

SUPPORTED_LABEL_STUDIO_VERSION = "1.23.0"
DESCRIPTOR_FROM_NAME = "froglabel_catalog_v1"
SPECIES_FROM_NAME = "froglabel_species_v1"
ADAPTER_VERSION = INTEGRATION_VERSION


class CeProjectAdministrator:
    """Narrow, transaction-safe ORM boundary used only inside Label Studio CE."""

    def __init__(self, *, fault_hook: Callable[[str], None] | None = None):
        self.fault_hook = fault_hook or (lambda _stage: None)
        self._load_django()

    def init(self, project_id: int, candidate: ProjectConfiguration) -> dict[str, Any]:
        self._preflight(project_id, candidate)
        desired_config = generate_ce_label_config()
        with self.transaction.atomic():
            project = self._locked_project(project_id)
            live = self._read(project, lock=True, allow_missing=True)
            if live is not None and live.descriptor.host_project_id != project_id:
                raise FrogLabelCliError(
                    "CATALOG_CLONE_MISMATCH",
                    f"Project {project_id} carries catalog identity for project "
                    f"{live.descriptor.host_project_id}",
                    context=ErrorContext(
                        repair=(
                            f"Run froglabel project init --target ce --project {project_id} "
                            "--source LABEL_STUDIO_SOURCE --data-dir LABEL_STUDIO_DATA_DIR "
                            "--config-dir DIR --config-name NAME --repair-clone"
                        )
                    ),
                )
            config_changed = self._configure_project(project, desired_config)
            self.fault_hook("after-project-config")
            if live is None:
                now = datetime.now(UTC)
                live = initial_catalog(
                    candidate,
                    host_project_id=project_id,
                    catalog_id=f"local:{uuid.uuid4()}",
                    now=now,
                )
                for entry in live.species:
                    self._create_species_label(project, entry)
                self.fault_hook("before-descriptor")
                self._create_descriptor_label(project, live.descriptor)
                plan = None
                initialized = True
            else:
                plan = plan_catalog_sync(live, candidate)
                if plan.semantic_change:
                    live = self._apply_plan(project, live, candidate, plan)
                initialized = False
        verified = self.validate(project_id, candidate=candidate)
        return {
            "target": "ce",
            "project": project_id,
            "initialized": initialized,
            "labelConfigChanged": config_changed,
            "configurationFingerprint": configuration_fingerprint(candidate),
            "catalog": verified["catalog"],
            "plan": plan.stable_dict() if plan is not None else None,
            "message": "FrogLabel CE project state is initialized and validated.",
        }

    def sync(
        self,
        project_id: int,
        candidate: ProjectConfiguration,
        *,
        apply: bool,
    ) -> dict[str, Any]:
        self._preflight(project_id, candidate)
        desired_config = generate_ce_label_config()
        if not apply:
            project = self._project(project_id)
            live = self._required_live(project)
            plan = plan_catalog_sync(live, candidate)
            config_changed = (
                normalized_xml(project.label_config or "") != normalized_xml(desired_config)
                or project.enable_empty_annotation
            )
            return self._sync_result(
                project_id,
                candidate,
                live,
                plan,
                applied=False,
                config_changed=config_changed,
            )

        with self.transaction.atomic():
            project = self._locked_project(project_id)
            live = self._required_live(project, lock=True)
            plan = plan_catalog_sync(live, candidate)
            config_changed = self._configure_project(project, desired_config)
            self.fault_hook("after-project-config")
            if plan.semantic_change:
                live = self._apply_plan(project, live, candidate, plan)
        self.validate(project_id, candidate=candidate)
        return self._sync_result(
            project_id,
            candidate,
            live,
            plan,
            applied=True,
            config_changed=config_changed,
        )

    def validate(
        self,
        project_id: int,
        *,
        candidate: ProjectConfiguration | None = None,
    ) -> dict[str, Any]:
        self._verify_installation()
        project = self._project(project_id)
        desired = generate_ce_label_config()
        validate_ce_label_config(project.label_config or "")
        if normalized_xml(project.label_config or "") != normalized_xml(desired):
            raise FrogLabelCliError(
                "LABEL_CONFIG_DRIFT",
                f"Project {project_id} labeling configuration differs from the supported CE config",
                context=ErrorContext(
                    repair=(
                        f"Run froglabel project sync --target ce --project {project_id} "
                        "--source LABEL_STUDIO_SOURCE --data-dir LABEL_STUDIO_DATA_DIR "
                        "--config-dir DIR --config-name NAME --apply"
                    )
                ),
            )
        if project.enable_empty_annotation:
            raise FrogLabelCliError(
                "EMPTY_ANNOTATION_POLICY_DRIFT",
                "Project must reject truly blank outer annotations; explicit No calls is nonempty",
            )
        live = self._required_live(project)
        if live.descriptor.host_project_id != project_id:
            raise FrogLabelCliError(
                "CATALOG_CLONE_MISMATCH",
                f"Catalog hostProjectId {live.descriptor.host_project_id} "
                f"does not match project {project_id}",
            )
        plan = plan_catalog_sync(live, candidate) if candidate is not None else None
        return {
            "target": "ce",
            "project": project_id,
            "valid": True,
            "adapterVersion": live.descriptor.adapter_version,
            "catalog": live.canonical().contract_dict(),
            "managedSpeciesIds": live.descriptor.config_managed_species_ids,
            "plan": plan.stable_dict() if plan is not None else None,
        }

    def read_catalog(self, project_id: int) -> LiveCatalog:
        self._verify_installation()
        project = self._project(project_id)
        return self._required_live(project)

    def repair_clone(self, project_id: int, candidate: ProjectConfiguration) -> dict[str, Any]:
        """Explicitly detach copied links and initialize a fresh project-local identity."""

        self._preflight(project_id, candidate)
        with self.transaction.atomic():
            project = self._locked_project(project_id)
            existing = self._read(
                project,
                lock=True,
                allow_missing=True,
                allow_clone_mismatch=True,
            )
            if existing is None or existing.descriptor.host_project_id == project_id:
                raise FrogLabelCliError(
                    "CATALOG_NOT_A_CLONE",
                    "--repair-clone is only valid when the descriptor hostProjectId mismatches",
                )
            self.LabelLink.objects.filter(
                project=project,
                from_name__in=(DESCRIPTOR_FROM_NAME, SPECIES_FROM_NAME),
            ).delete()
            self.fault_hook("after-clone-detach")
            now = datetime.now(UTC)
            live = initial_catalog(
                candidate,
                host_project_id=project_id,
                catalog_id=f"local:{uuid.uuid4()}",
                now=now,
                initialized_by="froglabel project init --repair-clone",
            )
            for entry in live.species:
                self._create_species_label(project, entry)
            self._configure_project(project, generate_ce_label_config())
            self._create_descriptor_label(project, live.descriptor)
        return self.validate(project_id, candidate=candidate)

    def _apply_plan(
        self,
        project: Any,
        live: LiveCatalog,
        candidate: ProjectConfiguration,
        plan: CatalogSyncPlan,
    ) -> LiveCatalog:
        configured = {entry.species_id: entry for entry in candidate.catalog.species}
        current = {entry.species_id: entry for entry in live.species}
        labels = self._species_labels(project)
        now = datetime.now(UTC)
        for change in plan.species_changes:
            if change.action == "retain":
                continue
            desired = configured[change.species_id]
            if change.action == "add":
                entry = StoredSpecies(
                    host_project_id=project.id,
                    catalog_id=live.descriptor.catalog_id,
                    species_id=desired.species_id,
                    code=desired.code,
                    selection_priority=desired.selection_priority,
                    species_name=desired.species_name,
                    scientific_name=desired.scientific_name,
                    external_taxon=desired.external_taxon,
                    added_after_initialization=True,
                    created_at=now,
                    updated_at=now,
                )
                self._create_species_label(project, entry)
                current[entry.species_id] = entry
            else:
                prior = current[change.species_id]
                entry = prior.model_copy(
                    update={
                        "schema_version": 2,
                        "code": desired.code,
                        "selection_priority": desired.selection_priority,
                        "species_name": desired.species_name,
                        "scientific_name": desired.scientific_name,
                        "external_taxon": desired.external_taxon,
                        "updated_at": now,
                    }
                )
                label = labels.get(entry.species_id)
                if label is None:
                    raise FrogLabelCliError(
                        "CATALOG_STORAGE_MISSING",
                        f"Species label is missing for {entry.species_id}",
                    )
                label.value = entry.model_dump(by_alias=True, mode="json", exclude_none=True)
                label.save(update_fields=["value"])
                current[entry.species_id] = entry
            self.fault_hook(f"after-species:{change.species_id}")

        descriptor = live.descriptor.model_copy(
            update={
                "schema_version": 2,
                "adapter_version": 2,
                "catalog_revision": plan.next_revision,
                "default_species_id": plan.default_change.after,
                "config_managed_species_ids": plan.managed_species_ids_after,
            }
        )
        candidate_live = LiveCatalog(
            descriptor=descriptor,
            species=sorted(current.values(), key=lambda entry: entry.species_id),
        )
        descriptor_label = self._descriptor_label(project, lock=True)
        self.fault_hook("before-descriptor")
        descriptor_label.value = descriptor.model_dump(
            by_alias=True, mode="json", exclude_none=True
        )
        descriptor_label.save(update_fields=["value"])
        return candidate_live

    def _read(
        self,
        project: Any,
        *,
        lock: bool = False,
        allow_missing: bool = False,
        allow_clone_mismatch: bool = False,
    ) -> LiveCatalog | None:
        query = self.LabelLink.objects.filter(
            project=project,
            from_name__in=(DESCRIPTOR_FROM_NAME, SPECIES_FROM_NAME),
        ).select_related("label")
        if lock:
            query = query.select_for_update()
        links = list(query.order_by("id"))
        descriptor_values: list[dict[str, Any]] = []
        species_values: list[dict[str, Any]] = []
        title_mismatches: list[tuple[str, str]] = []
        for link in links:
            if link.label.organization_id != project.organization_id:
                raise FrogLabelCliError(
                    "CATALOG_ORGANIZATION_MISMATCH", "Catalog label belongs to another organization"
                )
            value = link.label.value
            if not isinstance(value, dict) or value.get("schemaVersion") not in (1, 2):
                raise FrogLabelCliError(
                    "CATALOG_SCHEMA_UNSUPPORTED",
                    "A reserved FrogLabel catalog link has an unsupported value/schemaVersion",
                )
            expected_kind = (
                "froglabel.species-catalog"
                if link.from_name == DESCRIPTOR_FROM_NAME
                else "froglabel.species"
            )
            if value.get("kind") != expected_kind:
                raise FrogLabelCliError(
                    "CATALOG_STORAGE_KIND_MISMATCH",
                    f"Reserved {link.from_name} link contains {value.get('kind')!r}",
                )
            if expected_kind == "froglabel.species-catalog":
                descriptor_values.append(value)
                expected_title = descriptor_title(project.id)
            else:
                species_values.append(value)
                expected_title = species_title(project.id, str(value.get("speciesId", "")))
            if link.label.title != expected_title:
                title_mismatches.append((link.label.title, expected_title))
        if not descriptor_values:
            if allow_missing and not species_values:
                return None
            raise FrogLabelCliError(
                "CATALOG_NOT_INITIALIZED", f"Project {project.id} has no catalog descriptor"
            )
        if len(descriptor_values) != 1:
            raise FrogLabelCliError(
                "CATALOG_DESCRIPTOR_COUNT",
                f"Project {project.id} has {len(descriptor_values)} catalog descriptors",
            )
        try:
            descriptor = CatalogDescriptor.model_validate(descriptor_values[0])
        except ValidationError as error:
            raise FrogLabelCliError("CATALOG_INVALID", str(error)) from error
        # A cloned Label Studio project can carry links whose stable titles still
        # name the source project. Diagnose the authoritative descriptor identity
        # before reporting those secondary title mismatches so the operator gets
        # the actionable clone-repair command.
        is_clone_mismatch = descriptor.host_project_id != project.id
        if is_clone_mismatch and not allow_clone_mismatch:
            raise FrogLabelCliError(
                "CATALOG_CLONE_MISMATCH",
                f"Project {project.id} carries catalog identity for project "
                f"{descriptor.host_project_id}",
                context=ErrorContext(
                    repair=(
                        f"Run froglabel project init --target ce --project {project.id} "
                        "--source LABEL_STUDIO_SOURCE --data-dir LABEL_STUDIO_DATA_DIR "
                        "--config-dir DIR --config-name NAME --repair-clone"
                    )
                ),
            )
        if title_mismatches and not is_clone_mismatch:
            actual, expected = title_mismatches[0]
            raise FrogLabelCliError(
                "CATALOG_STORAGE_TITLE_MISMATCH",
                f"Catalog label title {actual!r} is not the stable expected title {expected!r}",
            )
        try:
            return LiveCatalog(
                descriptor=descriptor,
                species=[StoredSpecies.model_validate(value) for value in species_values],
            )
        except ValidationError as error:
            raise FrogLabelCliError("CATALOG_INVALID", str(error)) from error

    def _required_live(self, project: Any, *, lock: bool = False) -> LiveCatalog:
        live = self._read(project, lock=lock)
        assert live is not None
        return live

    def _species_labels(self, project: Any) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for link in self.LabelLink.objects.filter(
            project=project, from_name=SPECIES_FROM_NAME
        ).select_related("label"):
            value = link.label.value
            if isinstance(value, dict) and isinstance(value.get("speciesId"), str):
                result[value["speciesId"]] = link.label
        return result

    def _descriptor_label(self, project: Any, *, lock: bool) -> Any:
        query = self.Label.objects.filter(
            links__project=project,
            links__from_name=DESCRIPTOR_FROM_NAME,
            title=descriptor_title(project.id),
        )
        if lock:
            query = query.select_for_update()
        try:
            return query.get()
        except self.Label.DoesNotExist as error:
            raise FrogLabelCliError(
                "CATALOG_DESCRIPTOR_MISSING", "Catalog descriptor label is missing"
            ) from error

    def _create_species_label(self, project: Any, entry: StoredSpecies) -> Any:
        return self._create_label(
            project,
            title=species_title(project.id, entry.species_id),
            from_name=SPECIES_FROM_NAME,
            value=entry.model_dump(by_alias=True, mode="json", exclude_none=True),
        )

    def _create_descriptor_label(self, project: Any, descriptor: CatalogDescriptor) -> Any:
        return self._create_label(
            project,
            title=descriptor_title(project.id),
            from_name=DESCRIPTOR_FROM_NAME,
            value=descriptor.model_dump(by_alias=True, mode="json", exclude_none=True),
        )

    def _create_label(
        self, project: Any, *, title: str, from_name: str, value: dict[str, Any]
    ) -> Any:
        actor = project.created_by
        if actor is None:
            raise FrogLabelCliError(
                "PROJECT_ACTOR_MISSING",
                f"Project {project.id} has no created_by user for catalog ownership",
            )
        if self.Label.objects.filter(organization=project.organization, title=title).exists():
            raise FrogLabelCliError(
                "CATALOG_LABEL_TITLE_COLLISION",
                f"Stable project-local label title already exists: {title}",
            )
        label = self.Label.objects.create(
            organization=project.organization,
            created_by=actor,
            approved_by=actor,
            approved=True,
            title=title,
            description="FrogLabel project catalog record",
            value=value,
        )
        self.LabelLink.objects.create(project=project, label=label, from_name=from_name)
        return label

    def _configure_project(self, project: Any, desired: str) -> bool:
        changes: list[str] = []
        if normalized_xml(project.label_config or "") != normalized_xml(desired):
            project.label_config = desired
            changes.append("label_config")
        if project.enable_empty_annotation:
            project.enable_empty_annotation = False
            changes.append("enable_empty_annotation")
        if changes:
            project.save(update_fields=changes)
        return bool(changes)

    def _project(self, project_id: int) -> Any:
        try:
            return self.Project.objects.select_related("organization", "created_by").get(
                id=project_id
            )
        except self.Project.DoesNotExist as error:
            raise FrogLabelCliError(
                "PROJECT_NOT_FOUND", f"Label Studio project {project_id} does not exist"
            ) from error

    def _locked_project(self, project_id: int) -> Any:
        try:
            return (
                self.Project.objects.select_for_update()
                .select_related("organization", "created_by")
                .get(id=project_id)
            )
        except self.Project.DoesNotExist as error:
            raise FrogLabelCliError(
                "PROJECT_NOT_FOUND", f"Label Studio project {project_id} does not exist"
            ) from error

    def _preflight(self, project_id: int, candidate: ProjectConfiguration) -> None:
        self._verify_installation()
        if candidate.project.host_project_id != project_id:
            raise FrogLabelCliError(
                "CONFIG_PROJECT_MISMATCH",
                f"Configuration hostProjectId {candidate.project.host_project_id} "
                f"does not match {project_id}",
            )
        generate_ce_label_config()
        self._project(project_id)

    def _verify_installation(self) -> None:
        try:
            version = importlib.metadata.version("label-studio")
        except importlib.metadata.PackageNotFoundError as error:
            raise FrogLabelCliError(
                "LABEL_STUDIO_NOT_INSTALLED",
                "CE project commands must run inside the derived Label Studio container",
            ) from error
        if version != SUPPORTED_LABEL_STUDIO_VERSION:
            raise FrogLabelCliError(
                "LABEL_STUDIO_VERSION_UNSUPPORTED",
                f"Detected Label Studio {version}; exact supported version is "
                f"{SUPPORTED_LABEL_STUDIO_VERSION}",
            )
        if getattr(self.settings, "FROGLABEL_CE_INTEGRATION_VERSION", None) != ADAPTER_VERSION:
            raise FrogLabelCliError(
                "CE_INTEGRATION_MARKER_MISSING",
                "FrogLabel CE settings/URL overlay marker is missing or unsupported",
            )

    def _load_django(self) -> None:
        try:
            import django
            from django.apps import apps

            if not apps.ready:
                django.setup()
            from django.conf import settings
            from django.db import transaction
            from labels_manager.models import Label, LabelLink
            from projects.models import Project
        except Exception as error:
            raise FrogLabelCliError(
                "DJANGO_ENVIRONMENT_UNAVAILABLE",
                "CE commands require Label Studio's configured Django environment",
                context=ErrorContext(
                    repair="Run this command with docker compose exec label-studio ..."
                ),
            ) from error
        self.settings = settings
        self.transaction = transaction
        self.Label = Label
        self.LabelLink = LabelLink
        self.Project = Project

    @staticmethod
    def _sync_result(
        project_id: int,
        candidate: ProjectConfiguration,
        live: LiveCatalog,
        plan: CatalogSyncPlan,
        *,
        applied: bool,
        config_changed: bool,
    ) -> dict[str, Any]:
        return {
            "target": "ce",
            "project": project_id,
            "applied": applied,
            "configurationFingerprint": configuration_fingerprint(candidate),
            "labelConfigChanged": config_changed,
            "catalog": live.canonical().contract_dict(),
            "plan": plan.stable_dict(),
            "message": (
                "Applied and validated FrogLabel CE project changes."
                if applied
                else "Dry run only; Label Studio was not changed."
            ),
        }


def descriptor_title(project_id: int) -> str:
    return f"froglabel:v1:project:{project_id}:catalog"


def species_title(project_id: int, species_id: str) -> str:
    return f"froglabel:v1:project:{project_id}:species:{species_id}"
