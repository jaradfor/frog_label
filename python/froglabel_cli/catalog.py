from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import ConfigDict, Field, field_validator, model_validator

from .admin_config import (
    ConfiguredExternalTaxon,
    ConfiguredSpecies,
    ProjectConfiguration,
    StrictModel,
)
from .errors import FrogLabelCliError
from .models import ExternalTaxon, SpeciesCatalog, SpeciesEntry


class StoredModel(StrictModel):
    """Strict keys with JSON-compatible scalar coercion for Label.value records."""

    model_config = ConfigDict(
        alias_generator=StrictModel.model_config["alias_generator"],
        populate_by_name=True,
        extra="forbid",
        strict=False,
    )


class CatalogDescriptor(StoredModel):
    schema_version: Literal[1] = 1
    kind: Literal["froglabel.species-catalog"] = "froglabel.species-catalog"
    host_project_id: int = Field(gt=0)
    catalog_id: str = Field(min_length=1, max_length=256)
    catalog_revision: int = Field(ge=1)
    initialized_at: datetime
    initialized_by: str = Field(min_length=1, max_length=256)
    default_species_id: str | None = Field(default=None, min_length=1, max_length=256)
    config_managed_species_ids: list[str] = Field(default_factory=list, max_length=10_000)
    adapter_version: Literal[1] = 1

    @model_validator(mode="after")
    def managed_ids_are_unique(self) -> CatalogDescriptor:
        if len(self.config_managed_species_ids) != len(set(self.config_managed_species_ids)):
            raise ValueError("configManagedSpeciesIds contains a duplicate")
        return self


class StoredSpecies(StoredModel):
    schema_version: Literal[1] = 1
    kind: Literal["froglabel.species"] = "froglabel.species"
    host_project_id: int = Field(gt=0)
    catalog_id: str = Field(min_length=1, max_length=256)
    species_id: str = Field(min_length=1, max_length=256)
    code: str = Field(pattern=r"^[A-Z]{3}$")
    species_name: str = Field(min_length=1, max_length=256)
    scientific_name: str | None = Field(default=None, min_length=1, max_length=256)
    external_taxon: ConfiguredExternalTaxon | None = None
    added_after_initialization: bool
    created_at: datetime
    updated_at: datetime

    @field_validator("species_name", "scientific_name")
    @classmethod
    def names_are_canonical(cls, value: str | None) -> str | None:
        from .admin_config import canonical_name

        if value is not None and canonical_name(value) != value:
            raise ValueError("species names must already be normalized")
        return value

    def canonical(self) -> SpeciesEntry:
        taxon = (
            ExternalTaxon.model_validate(self.external_taxon.model_dump(by_alias=True))
            if self.external_taxon
            else None
        )
        return SpeciesEntry(
            species_id=self.species_id,
            code=self.code,
            species_name=self.species_name,
            scientific_name=self.scientific_name,
            external_taxon=taxon,
            added_after_initialization=self.added_after_initialization,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )


class LiveCatalog(StoredModel):
    descriptor: CatalogDescriptor
    species: list[StoredSpecies] = Field(default_factory=list, max_length=10_000)

    @model_validator(mode="after")
    def consistent_identity(self) -> LiveCatalog:
        ids: set[str] = set()
        codes: set[str] = set()
        for entry in self.species:
            if entry.host_project_id != self.descriptor.host_project_id:
                raise ValueError(f"species {entry.species_id} has a mismatched hostProjectId")
            if entry.catalog_id != self.descriptor.catalog_id:
                raise ValueError(f"species {entry.species_id} has a mismatched catalogId")
            if entry.species_id in ids:
                raise ValueError(f"duplicate speciesId: {entry.species_id}")
            ids.add(entry.species_id)
            folded = entry.code.casefold()
            if folded in codes:
                raise ValueError(f"duplicate current code: {entry.code}")
            codes.add(folded)
        managed = set(self.descriptor.config_managed_species_ids)
        if not managed.issubset(ids):
            raise ValueError("configManagedSpeciesIds references a missing species")
        if self.descriptor.default_species_id not in ids | {None}:
            raise ValueError("defaultSpeciesId references a missing species")
        return self

    def canonical(self) -> SpeciesCatalog:
        return SpeciesCatalog(
            catalog_id=self.descriptor.catalog_id,
            initialized_at=self.descriptor.initialized_at,
            initialized_by=self.descriptor.initialized_by,
            catalog_revision=self.descriptor.catalog_revision,
            default_species_id=self.descriptor.default_species_id,
            species=[entry.canonical() for entry in self.species],
        )


class SpeciesChange(StrictModel):
    action: Literal["add", "update", "adopt", "retain"]
    species_id: str
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    note: str


class DefaultChange(StrictModel):
    action: Literal["leave", "set", "clear", "unchanged"]
    before: str | None
    after: str | None


class CatalogSyncPlan(StrictModel):
    schema_version: Literal[1] = 1
    host_project_id: int
    catalog_id: str
    current_revision: int
    next_revision: int
    species_changes: list[SpeciesChange]
    default_change: DefaultChange
    managed_species_ids_after: list[str]
    semantic_change: bool

    def stable_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json", exclude_none=False)


def plan_catalog_sync(
    live: LiveCatalog,
    candidate: ProjectConfiguration,
) -> CatalogSyncPlan:
    configured = {entry.species_id: entry for entry in candidate.catalog.species}
    current = {entry.species_id: entry for entry in live.species}
    managed_before = set(live.descriptor.config_managed_species_ids)
    managed_after = set(managed_before)
    changes: list[SpeciesChange] = []
    final_codes: dict[str, str] = {}

    for species_id, entry in sorted(current.items()):
        desired = configured.get(species_id)
        if desired is None:
            changes.append(
                SpeciesChange(
                    action="retain",
                    species_id=species_id,
                    before=_stored_fields(entry),
                    after=_stored_fields(entry),
                    note="retained (deletion unsupported)",
                )
            )
            _reserve_code(final_codes, entry.code, species_id)
            continue

        if species_id not in managed_before and not desired.adopt_existing:
            raise FrogLabelCliError(
                "CATALOG_UNMANAGED_ID_COLLISION",
                f"Configured speciesId {species_id} already exists but is not "
                "configuration-managed; "
                "set adoptExisting: true and inspect a dry-run",
            )
        desired_fields = _configured_fields(desired)
        before_fields = _stored_fields(entry)
        if species_id not in managed_before:
            managed_after.add(species_id)
            action: Literal["adopt", "update"] = "adopt"
            note = "adopt existing immutable ID into configuration management"
        else:
            action = "update"
            note = "update current fields by immutable ID"
        if desired_fields != before_fields or action == "adopt":
            changes.append(
                SpeciesChange(
                    action=action,
                    species_id=species_id,
                    before=before_fields,
                    after=desired_fields,
                    note=note,
                )
            )
        else:
            changes.append(
                SpeciesChange(
                    action="retain",
                    species_id=species_id,
                    before=before_fields,
                    after=before_fields,
                    note="configuration-managed entry unchanged",
                )
            )
        _reserve_code(final_codes, desired.code, species_id)

    for species_id, desired in sorted(configured.items()):
        if species_id in current:
            continue
        if desired.adopt_existing:
            raise FrogLabelCliError(
                "CATALOG_ADOPT_TARGET_MISSING",
                f"adoptExisting was requested for absent speciesId {species_id}",
            )
        _reserve_code(final_codes, desired.code, species_id)
        managed_after.add(species_id)
        changes.append(
            SpeciesChange(
                action="add",
                species_id=species_id,
                before=None,
                after=_configured_fields(desired),
                note="append configured species after initialization",
            )
        )

    current_default = live.descriptor.default_species_id
    if not candidate.project.has_default_intent:
        default_change = DefaultChange(
            action="leave", before=current_default, after=current_default
        )
    else:
        desired_default = candidate.project.default_species_id
        if desired_default is not None and desired_default not in set(current) | set(configured):
            raise FrogLabelCliError(
                "DEFAULT_SPECIES_MISSING",
                f"Configured default speciesId does not exist: {desired_default}",
            )
        if desired_default == current_default:
            default_change = DefaultChange(
                action="unchanged", before=current_default, after=current_default
            )
        elif desired_default is None:
            default_change = DefaultChange(action="clear", before=current_default, after=None)
        else:
            default_change = DefaultChange(
                action="set", before=current_default, after=desired_default
            )

    semantic_change = any(
        change.action != "retain" for change in changes
    ) or default_change.action in {
        "set",
        "clear",
    }
    revision = live.descriptor.catalog_revision
    return CatalogSyncPlan(
        host_project_id=live.descriptor.host_project_id,
        catalog_id=live.descriptor.catalog_id,
        current_revision=revision,
        next_revision=revision + (1 if semantic_change else 0),
        species_changes=sorted(changes, key=lambda change: (change.species_id, change.action)),
        default_change=default_change,
        managed_species_ids_after=sorted(managed_after),
        semantic_change=semantic_change,
    )


def initial_catalog(
    candidate: ProjectConfiguration,
    *,
    host_project_id: int,
    catalog_id: str,
    now: datetime,
    initialized_by: str = "froglabel project init",
) -> LiveCatalog:
    species = [
        StoredSpecies(
            host_project_id=host_project_id,
            catalog_id=catalog_id,
            species_id=entry.species_id,
            code=entry.code,
            species_name=entry.species_name,
            scientific_name=entry.scientific_name,
            external_taxon=entry.external_taxon,
            added_after_initialization=False,
            created_at=now,
            updated_at=now,
        )
        for entry in candidate.catalog.species
    ]
    descriptor = CatalogDescriptor(
        host_project_id=host_project_id,
        catalog_id=catalog_id,
        catalog_revision=1,
        initialized_at=now,
        initialized_by=initialized_by,
        default_species_id=(
            candidate.project.default_species_id if candidate.project.has_default_intent else None
        ),
        config_managed_species_ids=sorted(entry.species_id for entry in species),
    )
    return LiveCatalog(descriptor=descriptor, species=species)


def _configured_fields(entry: ConfiguredSpecies) -> dict[str, Any]:
    return {
        "code": entry.code,
        "speciesName": entry.species_name,
        "scientificName": entry.scientific_name,
        "externalTaxon": (
            entry.external_taxon.model_dump(by_alias=True, mode="json")
            if entry.external_taxon
            else None
        ),
    }


def _stored_fields(entry: StoredSpecies) -> dict[str, Any]:
    return {
        "code": entry.code,
        "speciesName": entry.species_name,
        "scientificName": entry.scientific_name,
        "externalTaxon": (
            entry.external_taxon.model_dump(by_alias=True, mode="json")
            if entry.external_taxon
            else None
        ),
    }


def _reserve_code(codes: dict[str, str], code: str, species_id: str) -> None:
    folded = code.casefold()
    other = codes.get(folded)
    if other is not None and other != species_id:
        raise FrogLabelCliError(
            "CATALOG_CODE_COLLISION",
            f"Current code {code} would belong to both {other} and {species_id}",
        )
    codes[folded] = species_id
