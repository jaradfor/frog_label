from __future__ import annotations

import math
import unicodedata
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, StringConstraints, model_validator

Identifier = Annotated[str, StringConstraints(min_length=1, max_length=256)]
SpeciesCode = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]
ShortText = Annotated[str, StringConstraints(min_length=1, max_length=256)]
AttributeText = Annotated[str, StringConstraints(max_length=1024)]
AttributeValue = AttributeText | int | float | bool | None


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class FrogModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=lambda name: _camel(name), populate_by_name=True, extra="forbid"
    )


class ExternalTaxon(FrogModel):
    authority: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    id: Identifier


class SpeciesEntry(FrogModel):
    schema_version: Literal[1] = 1
    kind: Literal["froglabel.species"] = "froglabel.species"
    species_id: Identifier
    code: SpeciesCode
    species_name: ShortText
    scientific_name: ShortText | None = None
    external_taxon: ExternalTaxon | None = None
    added_after_initialization: bool
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def normalized_names(self) -> SpeciesEntry:
        if _normalized_name(self.species_name) != self.species_name:
            raise ValueError("speciesName must already be Unicode-normalized and trimmed")
        if self.scientific_name and _normalized_name(self.scientific_name) != self.scientific_name:
            raise ValueError("scientificName must already be Unicode-normalized and trimmed")
        return self


class SpeciesCatalog(FrogModel):
    schema_version: Literal[1] = 1
    kind: Literal["froglabel.species-catalog"] = "froglabel.species-catalog"
    catalog_id: Identifier
    initialized_at: datetime
    initialized_by: ShortText
    catalog_revision: int = Field(ge=1)
    default_species_id: Identifier | None = None
    species: list[SpeciesEntry] = Field(max_length=10_000)

    @model_validator(mode="after")
    def validate_references(self) -> SpeciesCatalog:
        ids: set[str] = set()
        codes: set[str] = set()
        by_id = {entry.species_id: entry for entry in self.species}
        for entry in self.species:
            if entry.species_id in ids:
                raise ValueError(f"duplicate species ID: {entry.species_id}")
            ids.add(entry.species_id)
            folded_code = entry.code.casefold()
            if folded_code in codes:
                raise ValueError(f"duplicate current species code: {entry.code}")
            codes.add(folded_code)
        if self.default_species_id and not by_id.get(self.default_species_id):
            raise ValueError("defaultSpeciesId does not exist")
        return self


class SpeciesSnapshot(FrogModel):
    species_id: Identifier
    code: SpeciesCode
    species_name: ShortText
    scientific_name: ShortText | None = None
    added_after_initialization: bool

    @model_validator(mode="after")
    def normalized_names(self) -> SpeciesSnapshot:
        if _normalized_name(self.species_name) != self.species_name:
            raise ValueError("speciesName must already be Unicode-normalized and trimmed")
        if self.scientific_name and _normalized_name(self.scientific_name) != self.scientific_name:
            raise ValueError("scientificName must already be Unicode-normalized and trimmed")
        return self


class ModelCandidate(FrogModel):
    raw_class: ShortText
    score: float | None = Field(default=None, ge=0, le=1)
    mapped_species_id: Identifier | None = None


class ModelIdentity(FrogModel):
    name: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    version: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    run_id: Identifier | None = None


class HumanProvenance(FrogModel):
    source: Literal["human"] = "human"


class ModelProvenance(FrogModel):
    source: Literal["model"] = "model"
    model: ModelIdentity
    source_detection_id: Identifier
    confidence: float | None = Field(default=None, ge=0, le=1)
    mapping_rule_id: Annotated[str, StringConstraints(min_length=1, max_length=128)] | None = None
    human_modified: bool
    candidates: list[ModelCandidate] = Field(max_length=20)
    attributes: dict[
        Annotated[str, StringConstraints(min_length=1, max_length=128)], AttributeValue
    ] = Field(default_factory=dict, max_length=32)


class FrogLabelBox(FrogModel):
    id: Identifier
    species: SpeciesSnapshot
    start_time_seconds: float = Field(ge=0)
    end_time_seconds: float = Field(gt=0)
    low_frequency_hz: float = Field(ge=0)
    high_frequency_hz: float = Field(gt=0)
    created_at: datetime | None = None
    updated_at: datetime | None = None
    provenance: HumanProvenance | ModelProvenance = Field(discriminator="source")

    @model_validator(mode="after")
    def validate_geometry(self) -> FrogLabelBox:
        values = (
            self.start_time_seconds,
            self.end_time_seconds,
            self.low_frequency_hz,
            self.high_frequency_hz,
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError("box coordinates must be finite")
        if self.start_time_seconds >= self.end_time_seconds:
            raise ValueError("box time bounds are inverted")
        if self.low_frequency_hz >= self.high_frequency_hz:
            raise ValueError("box frequency bounds are inverted")
        return self


class FrogLabelDocument(FrogModel):
    kind: Literal["froglabel.annotation-set"] = "froglabel.annotation-set"
    schema_version: Literal[1] = 1
    catalog_id: Identifier
    review_status: Literal["calls_present", "no_calls"]
    boxes: list[FrogLabelBox] = Field(max_length=5_000)

    @model_validator(mode="after")
    def validate_document(self) -> FrogLabelDocument:
        if self.review_status == "calls_present" and not self.boxes:
            raise ValueError("calls_present requires at least one box")
        if self.review_status == "no_calls" and self.boxes:
            raise ValueError("no_calls requires zero boxes")
        ids = [box.id for box in self.boxes]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate box ID")
        return self


class LabelStudioResult(FrogModel):
    id: Identifier
    from_name: Identifier = Field(
        validation_alias=AliasChoices("from_name", "fromName"), serialization_alias="from_name"
    )
    to_name: Identifier = Field(
        validation_alias=AliasChoices("to_name", "toName"), serialization_alias="to_name"
    )
    type: Literal["reactcode", "textarea", "labels"]
    value: Any

    def document(self) -> FrogLabelDocument:
        if self.type == "reactcode":
            if not isinstance(self.value, dict):
                raise ValueError("FrogLabel ReactCode result value must be an object")
            return FrogLabelDocument.model_validate(self.value.get("reactcode"))
        if self.type == "labels":
            if isinstance(self.value, list) and len(self.value) == 1:
                return FrogLabelDocument.model_validate(self.value[0])
            raise ValueError("FrogLabel Interface result must contain one document object")
        if not isinstance(self.value, dict):
            raise ValueError("FrogLabel textarea result value must be an object")
        text = self.value.get("text")
        if isinstance(text, list) and len(text) == 1 and isinstance(text[0], str):
            return FrogLabelDocument.model_validate_json(text[0])
        if isinstance(text, str):
            return FrogLabelDocument.model_validate_json(text)
        raise ValueError("FrogLabel textarea result must contain one JSON document string")


def species_snapshot(entry: SpeciesEntry) -> SpeciesSnapshot:
    return SpeciesSnapshot(
        species_id=entry.species_id,
        code=entry.code,
        species_name=entry.species_name,
        scientific_name=entry.scientific_name,
        added_after_initialization=entry.added_after_initialization,
    )


def _normalized_name(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).split())
