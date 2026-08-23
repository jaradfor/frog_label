from __future__ import annotations

import math

import pytest
from hypothesis import given
from hypothesis import strategies as st
from pydantic import ValidationError

from froglabel_cli.models import (
    FrogLabelBox,
    FrogLabelDocument,
    HumanProvenance,
    SpeciesSnapshot,
    migrate_document,
    species_snapshot,
)

SPECIES = SpeciesSnapshot(
    speciesId="fixture:gre",
    code="GRE",
    speciesName="Green Tree Frog",
    addedAfterInitialization=False,
)


@given(
    start=st.floats(min_value=0, max_value=100, allow_nan=False, allow_infinity=False),
    width=st.floats(min_value=0.001, max_value=10, allow_nan=False, allow_infinity=False),
    low=st.floats(min_value=0, max_value=20_000, allow_nan=False, allow_infinity=False),
    band=st.floats(min_value=0.001, max_value=5_000, allow_nan=False, allow_infinity=False),
)
def test_valid_finite_geometry_round_trips(
    start: float, width: float, low: float, band: float
) -> None:
    box = FrogLabelBox(
        id="box:one",
        species=SPECIES,
        startTimeSeconds=start,
        endTimeSeconds=start + width,
        lowFrequencyHz=low,
        highFrequencyHz=low + band,
        provenance=HumanProvenance(),
    )
    assert FrogLabelBox.model_validate(box.model_dump(by_alias=True)) == box


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_nonfinite_geometry_is_rejected(value: float) -> None:
    with pytest.raises(ValidationError):
        FrogLabelBox(
            id="box:one",
            species=SPECIES,
            startTimeSeconds=value,
            endTimeSeconds=2,
            lowFrequencyHz=10,
            highFrequencyHz=20,
            provenance=HumanProvenance(),
        )


def test_document_semantics_and_duplicate_ids_are_enforced() -> None:
    with pytest.raises(ValidationError, match="calls_present"):
        FrogLabelDocument(catalogId="fixture:catalog", reviewStatus="calls_present", boxes=[])
    with pytest.raises(ValidationError, match="no_calls"):
        FrogLabelDocument(
            catalogId="fixture:catalog",
            reviewStatus="no_calls",
            boxes=[
                FrogLabelBox(
                    id="one",
                    species=SPECIES,
                    startTimeSeconds=0,
                    endTimeSeconds=1,
                    lowFrequencyHz=0,
                    highFrequencyHz=1,
                    provenance=HumanProvenance(),
                )
            ],
        )


def test_dormant_model_provenance_round_trips_without_a_prediction_workflow() -> None:
    box = FrogLabelBox.model_validate(
        {
            "id": "model:box",
            "species": SPECIES.model_dump(by_alias=True),
            "startTimeSeconds": 0.5,
            "endTimeSeconds": 0.75,
            "lowFrequencyHz": 900,
            "highFrequencyHz": 1800,
            "provenance": {
                "source": "model",
                "model": {"name": "future-detector", "version": "0", "runId": "dry-run"},
                "sourceDetectionId": "detection:one",
                "confidence": 0.8,
                "mappingRuleId": "project:future",
                "humanModified": True,
                "candidates": [
                    {
                        "rawClass": "green-tree-frog",
                        "score": 0.8,
                        "mappedSpeciesId": "fixture:gre",
                    }
                ],
            },
        }
    )
    encoded = box.model_dump(by_alias=True, mode="json", exclude_none=True)
    assert encoded["provenance"]["humanModified"] is True
    assert FrogLabelBox.model_validate(encoded) == box


def test_v1_document_upgrade_preserves_historical_species_snapshot() -> None:
    legacy = {
        "kind": "froglabel.annotation-set",
        "schemaVersion": 1,
        "catalogId": "fixture:legacy",
        "reviewStatus": "calls_present",
        "boxes": [
            {
                "id": "legacy:box",
                "species": {
                    "speciesId": "fixture:perons",
                    "code": "PER",
                    "speciesName": "Peron's Tree Frog",
                    "addedAfterInitialization": False,
                },
                "startTimeSeconds": 0,
                "endTimeSeconds": 1,
                "lowFrequencyHz": 200,
                "highFrequencyHz": 1200,
                "provenance": {"source": "human"},
            }
        ],
    }

    migrated = migrate_document(legacy)

    assert migrated.schema_version == 2
    assert migrated.boxes[0].species.code == "PER"
    assert "selectionPriority" not in migrated.boxes[0].species.model_dump(
        by_alias=True, exclude_none=True
    )


def test_active_species_snapshot_preserves_priority_without_requiring_it_from_history(
    catalog,
) -> None:
    entry = catalog.species[0].model_copy(update={"selection_priority": 250})

    snapshot = species_snapshot(entry)

    assert snapshot.model_dump(by_alias=True, exclude_none=True)["selectionPriority"] == 250
    historical = SpeciesSnapshot.model_validate(
        {
            "speciesId": "fixture:historical",
            "code": "GRE",
            "speciesName": "Historical Frog",
            "addedAfterInitialization": True,
        }
    )
    assert historical.selection_priority is None
