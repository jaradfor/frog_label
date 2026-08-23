from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from contextlib import nullcontext
from pathlib import Path
from typing import Annotated, Any, Literal

from hydra import compose, initialize_config_dir, initialize_config_module
from omegaconf import DictConfig, OmegaConf
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from .errors import ErrorContext, FrogLabelCliError

Identifier = Annotated[str, StringConstraints(min_length=1, max_length=256)]
SpeciesCode = Annotated[str, StringConstraints(pattern=r"^[QWERTASDFGZXCVB]{1,6}$")]
ShortText = Annotated[str, StringConstraints(min_length=1, max_length=256)]
Target = Literal["ce", "enterprise"]
SECRET_KEY = re.compile(r"(?:password|secret|token|credential|api[_-]?key)", re.IGNORECASE)


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class StrictModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        extra="forbid",
        strict=True,
    )


class ConfiguredExternalTaxon(StrictModel):
    authority: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    id: Identifier


class ConfiguredSpecies(StrictModel):
    species_id: Identifier
    code: SpeciesCode
    selection_priority: int = Field(default=0, ge=0, le=1_000_000)
    species_name: ShortText
    scientific_name: ShortText | None = None
    external_taxon: ConfiguredExternalTaxon | None = None
    adopt_existing: bool = False

    @field_validator("species_name", "scientific_name")
    @classmethod
    def names_are_canonical(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if canonical_name(value) != value:
            raise ValueError("value must already be Unicode-NFKC normalized and whitespace-trimmed")
        return value


class CatalogIntent(StrictModel):
    species: list[ConfiguredSpecies] = Field(default_factory=list, max_length=10_000)

    @model_validator(mode="after")
    def unique_identity_and_code(self) -> CatalogIntent:
        ids: set[str] = set()
        codes: set[str] = set()
        for entry in self.species:
            if entry.species_id in ids:
                raise ValueError(f"duplicate speciesId: {entry.species_id}")
            ids.add(entry.species_id)
            folded = entry.code.casefold()
            if folded in codes:
                raise ValueError(f"duplicate current code (case-insensitive): {entry.code}")
            codes.add(folded)
        return self


class ProjectIntent(StrictModel):
    host_project_id: int | None = Field(default=None, gt=0)
    default_species_id: Identifier | None = None

    @property
    def has_default_intent(self) -> bool:
        return "default_species_id" in self.model_fields_set


class AudioLimitsIntent(StrictModel):
    max_duration_seconds: float = Field(default=300, gt=0, le=300)
    max_file_bytes: int = Field(default=134_217_728, gt=0, le=134_217_728)
    max_channels: int = Field(default=2, ge=1, le=2)
    max_source_sample_rate_hz: int = Field(default=192_000, gt=0, le=192_000)
    max_decoded_channel_samples: int = Field(default=30_000_000, gt=0, le=30_000_000)


class UiIntent(StrictModel):
    default_analysis_channel_mode: Literal["average", "max", "left", "right"] = "average"


class ProjectConfiguration(StrictModel):
    # Configuration-envelope V1 remains readable, but every configured species
    # describes desired active V2 state. Legacy storage still requires explicit
    # code and selectionPriority intent during administrative promotion.
    schema_version: Literal[1, 2] = 2
    project: ProjectIntent = Field(default_factory=ProjectIntent)
    catalog: CatalogIntent = Field(default_factory=CatalogIntent)
    audio: AudioLimitsIntent = Field(default_factory=AudioLimitsIntent)
    ui: UiIntent = Field(default_factory=UiIntent)

    @model_validator(mode="after")
    def default_exists(self) -> ProjectConfiguration:
        default = self.project.default_species_id
        if default is not None and default not in {
            species.species_id for species in self.catalog.species
        }:
            raise ValueError("project.defaultSpeciesId does not exist in catalog.species")
        return self


def load_project_configuration(
    *,
    config_name: str,
    target: Target,
    config_dir: Path | None = None,
    project_id: int | None = None,
) -> tuple[ProjectConfiguration, dict[str, Any]]:
    """Compose Hydra once without changing cwd, then strictly validate the plain object."""

    if not config_name or Path(config_name).name != config_name:
        raise FrogLabelCliError(
            "CONFIG_NAME_INVALID",
            "--config-name must be one plain Hydra configuration name",
        )
    overrides = ["hydra.job.chdir=false"]
    if config_dir is not None:
        try:
            resolved = config_dir.expanduser().resolve(strict=True)
        except OSError as error:
            raise FrogLabelCliError(
                "CONFIG_DIRECTORY_INVALID",
                f"Cannot open configuration directory: {config_dir}",
                context=ErrorContext(source=str(config_dir)),
            ) from error
        if not resolved.is_dir():
            raise FrogLabelCliError(
                "CONFIG_DIRECTORY_INVALID", f"Configuration path is not a directory: {resolved}"
            )
        initializer = initialize_config_dir(
            config_dir=str(resolved), version_base="1.3", job_name="froglabel-project"
        )
    else:
        initializer = initialize_config_module(
            config_module="froglabel_cli.project_configs",
            version_base="1.3",
            job_name="froglabel-project",
        )
    with initializer if initializer is not None else nullcontext():
        try:
            composed: DictConfig = compose(config_name=config_name, overrides=overrides)
            raw = OmegaConf.to_container(composed, resolve=True, throw_on_missing=True)
        except Exception as error:
            raise FrogLabelCliError(
                "CONFIG_COMPOSE_FAILED",
                f"Hydra could not compose {config_name!r}: {error}",
                context=ErrorContext(source=str(config_dir) if config_dir else "packaged configs"),
            ) from error
    if not isinstance(raw, dict):
        raise FrogLabelCliError(
            "CONFIG_SHAPE_INVALID", "Composed project configuration is not an object"
        )
    try:
        candidate = ProjectConfiguration.model_validate(raw)
    except Exception as error:
        raise FrogLabelCliError("CONFIG_INVALID", str(error)) from error
    validate_target(candidate, target=target, project_id=project_id)
    return candidate, redacted_configuration(raw)


def validate_target(
    candidate: ProjectConfiguration, *, target: Target, project_id: int | None
) -> None:
    configured_id = candidate.project.host_project_id
    if target == "ce":
        if project_id is None or project_id <= 0:
            raise FrogLabelCliError(
                "PROJECT_ID_REQUIRED", "CE commands require --project PROJECT_ID"
            )
        if configured_id is None:
            raise FrogLabelCliError(
                "CONFIG_PROJECT_ID_REQUIRED",
                "CE configuration requires project.hostProjectId",
            )
        if configured_id != project_id:
            raise FrogLabelCliError(
                "CONFIG_PROJECT_MISMATCH",
                "Configuration targets project "
                f"{configured_id}, not requested project {project_id}",
            )
    elif configured_id is not None:
        raise FrogLabelCliError(
            "ENTERPRISE_PROJECT_ID_FORBIDDEN",
            "Enterprise configuration must omit project.hostProjectId",
        )
    if target == "enterprise" and project_id is not None:
        raise FrogLabelCliError(
            "ENTERPRISE_PROJECT_ARGUMENT_FORBIDDEN",
            "Enterprise generation has no authoritative website project ID; omit --project",
        )


def canonical_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split())


def configuration_fingerprint(candidate: ProjectConfiguration) -> str:
    payload = json.dumps(
        candidate.model_dump(by_alias=True, mode="json", exclude_none=False),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return f"sha256:{hashlib.sha256(payload.encode('utf-8')).hexdigest()}"


def redacted_configuration(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if SECRET_KEY.search(str(key)) else redacted_configuration(item)
            for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))
        }
    if isinstance(value, list):
        return [redacted_configuration(item) for item in value]
    return value
