from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import uuid4

from core.middleware import enforce_csrf_checks
from core.permissions import all_permissions
from django.db import OperationalError, close_old_connections, transaction
from django.http import JsonResponse
from django.utils.decorators import method_decorator
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
)
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.views import APIView

from froglabel_cli.admin_config import canonical_name
from froglabel_cli.catalog import LiveCatalog, StoredSpecies
from froglabel_cli.ce_store import CeProjectAdministrator
from froglabel_cli.errors import FrogLabelCliError


def offline_heidi_tips(_request: Request) -> JsonResponse:
    """Keep the derived CE target deterministic and safe in air-gapped deployments."""

    return JsonResponse(
        {
            "organizationPage": [],
            "projectCreation": [],
            "projectSettings": [],
        }
    )


class CreateSpeciesInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    code: Annotated[str, StringConstraints(min_length=1, max_length=16)]
    selectionPriority: int = Field(default=0, ge=0, le=1_000_000)
    speciesName: Annotated[str, StringConstraints(min_length=1, max_length=256)]
    scientificName: Annotated[str, StringConstraints(min_length=1, max_length=256)] | None = None

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        normalized = value.strip().upper()
        if not 1 <= len(normalized) <= 6 or any(
            letter not in "QWERTASDFGZXCVB" for letter in normalized
        ):
            raise ValueError("code must contain 1-6 left-hand letters")
        return normalized

    @field_validator("speciesName", "scientificName")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = canonical_name(value)
        if not normalized:
            raise ValueError("name is required")
        return normalized


class CreateSpeciesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    expectedRevision: int = Field(ge=1)
    species: CreateSpeciesInput


@method_decorator(enforce_csrf_checks, name="dispatch")
class ProjectCatalogView(APIView):
    authentication_classes = (SessionAuthentication,)
    permission_classes = (IsAuthenticated,)

    def get(self, request: Request, project_id: int) -> Response:
        administrator = CeProjectAdministrator()
        project = self._authorized_project(request, administrator, project_id, mutate=False)
        live = administrator._required_live(project)
        return Response(self._payload(request, project, live))

    def post(self, request: Request, project_id: int) -> Response:
        administrator = CeProjectAdministrator()
        self._authorized_project(request, administrator, project_id, mutate=True)
        try:
            command = CreateSpeciesRequest.model_validate(request.data)
        except ValidationError as error:
            return Response(
                {"error": {"code": "CATALOG_INPUT_INVALID", "message": str(error)}},
                status=400,
            )
        try:
            with transaction.atomic():
                project = administrator._locked_project(project_id)
                self._assert_project_access(request, project, mutate=True)
                live = administrator._required_live(project, lock=True)
                if live.descriptor.schema_version != 2:
                    return Response(
                        {
                            **self._payload(request, project, live),
                            "error": {
                                "code": "CATALOG_V2_MIGRATION_REQUIRED",
                                "message": (
                                    "Legacy species remain historical until an administrator "
                                    "maps every entry to a V2 code and priority."
                                ),
                            },
                        },
                        status=409,
                    )
                if command.expectedRevision != live.descriptor.catalog_revision:
                    return Response(
                        {
                            **self._payload(request, project, live),
                            "error": {
                                "code": "CATALOG_STALE",
                                "message": "Catalog changed in another session; refetch and retry.",
                            },
                        },
                        status=409,
                    )
                requested = command.species
                matches = [
                    item
                    for item in live.species
                    if item.code.casefold() == requested.code.casefold()
                ]
                if matches:
                    existing = matches[0]
                    if (
                        existing.species_name != requested.speciesName
                        or existing.scientific_name != requested.scientificName
                        or existing.selection_priority != requested.selectionPriority
                    ):
                        return Response(
                            {
                                **self._payload(request, project, live),
                                "error": {
                                    "code": "CATALOG_CODE_CONFLICT",
                                    "message": (
                                        f"Code {requested.code} already has different species "
                                        "metadata or selection priority; resolve explicitly."
                                    ),
                                },
                            },
                            status=409,
                        )
                    return Response(
                        {
                            **self._payload(request, project, live),
                            "createdSpeciesId": existing.species_id,
                            "created": False,
                        }
                    )

                now = datetime.now(UTC)
                entry = StoredSpecies(
                    host_project_id=project_id,
                    catalog_id=live.descriptor.catalog_id,
                    species_id=f"local:{uuid4()}",
                    code=requested.code,
                    selection_priority=requested.selectionPriority,
                    species_name=requested.speciesName,
                    scientific_name=requested.scientificName,
                    added_after_initialization=True,
                    created_at=now,
                    updated_at=now,
                )
                administrator._create_species_label(project, entry)
                descriptor = live.descriptor.model_copy(
                    update={
                        "schema_version": 2,
                        "adapter_version": 2,
                        "catalog_revision": live.descriptor.catalog_revision + 1,
                    }
                )
                updated = LiveCatalog(descriptor=descriptor, species=[*live.species, entry])
                descriptor_label = administrator._descriptor_label(project, lock=True)
                descriptor_label.value = descriptor.model_dump(
                    by_alias=True, mode="json", exclude_none=True
                )
                descriptor_label.save(update_fields=["value"])
            return Response(
                {
                    **self._payload(request, project, updated),
                    "createdSpeciesId": entry.species_id,
                    "created": True,
                },
                status=201,
            )
        except FrogLabelCliError as error:
            return Response({"error": {"code": error.code, "message": str(error)}}, status=409)
        except OperationalError as error:
            # PostgreSQL serializes contenders through select_for_update(). CE's
            # default SQLite database instead reports a transient lock to the
            # losing writer. Convert that bounded race into the same stale-catalog
            # response consumed by the browser adapter, after the winner commits.
            if "locked" not in str(error).casefold():
                raise
            for attempt in range(5):
                close_old_connections()
                time.sleep(0.05 * (attempt + 1))
                try:
                    administrator = CeProjectAdministrator()
                    project = self._authorized_project(
                        request, administrator, project_id, mutate=True
                    )
                    live = administrator._required_live(project)
                    return Response(
                        {
                            **self._payload(request, project, live),
                            "error": {
                                "code": "CATALOG_STALE",
                                "message": (
                                    "Catalog changed in another session; refetch and retry."
                                ),
                            },
                        },
                        status=409,
                    )
                except OperationalError as retry_error:
                    if "locked" not in str(retry_error).casefold():
                        raise
            raise

    def _authorized_project(
        self,
        request: Request,
        administrator: CeProjectAdministrator,
        project_id: int,
        *,
        mutate: bool,
    ) -> Any:
        project = administrator._project(project_id)
        self._assert_project_access(request, project, mutate=mutate)
        return project

    @staticmethod
    def _assert_project_access(request: Request, project: Any, *, mutate: bool) -> None:
        user = request.user
        if (
            not user.is_authenticated
            or user.active_organization_id != project.organization_id
            or not project.has_permission(user)
        ):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("Project is not available in the active organization")
        required = [all_permissions.labels_view]
        if mutate:
            required.extend([all_permissions.labels_create, all_permissions.labels_change])
        if not all(user.has_perm(permission, project) for permission in required):
            from rest_framework.exceptions import PermissionDenied

            raise PermissionDenied("Effective label permission is insufficient")

    def _payload(self, request: Request, project: Any, live: LiveCatalog) -> dict[str, Any]:
        can_create = live.descriptor.schema_version == 2 and all(
            request.user.has_perm(permission, project)
            for permission in (all_permissions.labels_create, all_permissions.labels_change)
        )
        return {
            "catalog": live.canonical().contract_dict(),
            "permissions": {"createSpecies": can_create},
        }
