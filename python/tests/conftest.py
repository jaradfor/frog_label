from __future__ import annotations

from datetime import UTC, datetime

import pytest

from froglabel_cli.models import SpeciesCatalog

collect_ignore = ["test_projection.py"]


@pytest.fixture
def catalog() -> SpeciesCatalog:
    now = datetime(2026, 8, 20, tzinfo=UTC)
    return SpeciesCatalog.model_validate(
        {
            "schemaVersion": 2,
            "kind": "froglabel.species-catalog",
            "catalogId": "fixture:catalog",
            "initializedAt": now,
            "initializedBy": "tests",
            "catalogRevision": 1,
            "defaultSpeciesId": None,
            "species": [
                {
                    "schemaVersion": 2,
                    "kind": "froglabel.species",
                    "speciesId": "fixture:gre",
                    "code": "GRE",
                    "selectionPriority": 0,
                    "speciesName": "Green Tree Frog",
                    "scientificName": "Ranoidea caerulea",
                    "addedAfterInitialization": False,
                    "createdAt": now,
                    "updatedAt": now,
                },
                {
                    "schemaVersion": 2,
                    "kind": "froglabel.species",
                    "speciesId": "fixture:per",
                    "code": "ETF",
                    "selectionPriority": 0,
                    "speciesName": "Peron's Tree Frog",
                    "addedAfterInitialization": False,
                    "createdAt": now,
                    "updatedAt": now,
                },
            ],
        }
    )
