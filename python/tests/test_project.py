from __future__ import annotations

import json
from pathlib import Path
from xml.etree import ElementTree

import pytest

import froglabel_cli.cli as cli
from froglabel_cli.admin_config import ProjectConfiguration, load_project_configuration
from froglabel_cli.catalog import CatalogDescriptor, LiveCatalog, StoredSpecies, plan_catalog_sync
from froglabel_cli.enterprise import (
    EnterpriseProjectAdministrator,
    EnterpriseState,
    plan_enterprise_sync,
)
from froglabel_cli.errors import FrogLabelCliError
from froglabel_cli.exports import export_label_studio_project
from froglabel_cli.label_config import generate_ce_label_config, load_document_schema


def configuration(*, target: str = "enterprise") -> ProjectConfiguration:
    project = (
        {"hostProjectId": 7, "defaultSpeciesId": "local:gre"}
        if target == "ce"
        else {"defaultSpeciesId": "local:gre"}
    )
    return ProjectConfiguration.model_validate(
        {
            "schemaVersion": 1,
            "project": project,
            "catalog": {
                "species": [
                    {
                        "speciesId": "local:gre",
                        "code": "GRE",
                        "speciesName": "Green Tree Frog",
                    }
                ]
            },
            "audio": {},
            "ui": {},
        }
    )


def test_packaged_hydra_config_loads_outside_repository() -> None:
    candidate, resolved = load_project_configuration(
        config_name="base",
        target="enterprise",
    )
    assert candidate.catalog.species == []
    assert resolved["audio"]["maxDurationSeconds"] == 300
    assert candidate.project.has_default_intent is False


def test_configuration_is_strict_and_validated_before_target_use() -> None:
    payload = configuration().model_dump(by_alias=True)
    payload["catalog"]["species"][0]["cod"] = payload["catalog"]["species"][0].pop("code")
    with pytest.raises(ValueError, match="Extra inputs"):
        ProjectConfiguration.model_validate(payload)


def test_ce_label_config_uses_complete_task_data_and_canonical_schema() -> None:
    schema = load_document_schema()
    xml = generate_ce_label_config(schema)
    root = ElementTree.fromstring(xml)
    tag = next(node for node in root.iter() if node.tag == "ReactCode")
    assert tag.attrib["name"] == tag.attrib["toName"] == "froglabel"
    assert tag.attrib["src"] == "/react-app/froglabel/index.html"
    assert "data" not in tag.attrib
    assert json.loads(tag.attrib["outputs"]) == schema


def test_catalog_sync_is_idempotent_and_retains_omitted_entries(catalog) -> None:
    descriptor = CatalogDescriptor(
        hostProjectId=7,
        catalogId=catalog.catalog_id,
        catalogRevision=3,
        initializedAt=catalog.initialized_at,
        initializedBy=catalog.initialized_by,
        defaultSpeciesId="fixture:gre",
        configManagedSpeciesIds=["fixture:gre"],
    )
    live = LiveCatalog(
        descriptor=descriptor,
        species=[
            StoredSpecies(
                hostProjectId=7,
                catalogId=catalog.catalog_id,
                **entry.model_dump(by_alias=True),
            )
            for entry in catalog.species
        ],
    )
    candidate = ProjectConfiguration.model_validate(
        {
            "schemaVersion": 1,
            "project": {"hostProjectId": 7, "defaultSpeciesId": "fixture:gre"},
            "catalog": {
                "species": [
                    {
                        "speciesId": "fixture:gre",
                        "code": "GRE",
                        "speciesName": "Green Tree Frog",
                        "scientificName": "Ranoidea caerulea",
                    }
                ]
            },
            "audio": {},
            "ui": {},
        }
    )
    plan = plan_catalog_sync(live, candidate)
    retained = {change.species_id: change for change in plan.species_changes}
    assert plan.semantic_change is False
    assert plan.next_revision == 3
    assert retained["fixture:per"].note == "retained (deletion unsupported)"


def test_legacy_ce_catalog_is_readable_history_but_requires_complete_admin_mapping(catalog) -> None:
    descriptor = CatalogDescriptor(
        schemaVersion=1,
        adapterVersion=1,
        hostProjectId=7,
        catalogId="fixture:legacy",
        catalogRevision=4,
        initializedAt=catalog.initialized_at,
        initializedBy="legacy tests",
        defaultSpeciesId="fixture:red",
        configManagedSpeciesIds=[],
    )
    live = LiveCatalog(
        descriptor=descriptor,
        species=[
            StoredSpecies(
                schemaVersion=1,
                hostProjectId=7,
                catalogId="fixture:legacy",
                speciesId="fixture:red",
                code="RED",
                speciesName="Legacy Red Frog",
                addedAfterInitialization=False,
                createdAt=catalog.initialized_at,
                updatedAt=catalog.initialized_at,
            )
        ],
    )

    readable = live.canonical()
    assert readable.species == []
    assert readable.default_species_id is None
    assert readable.historical_species is not None
    assert readable.historical_species[0].code == "RED"

    with pytest.raises(FrogLabelCliError, match=r"must appear in catalog\.species"):
        plan_catalog_sync(live, configuration(target="ce"))

    implicit_priority = ProjectConfiguration.model_validate(
        {
            "schemaVersion": 2,
            "project": {"hostProjectId": 7},
            "catalog": {
                "species": [
                    {
                        "speciesId": "fixture:red",
                        "code": "RED",
                        "speciesName": "Legacy Red Frog",
                        "adoptExisting": True,
                    }
                ]
            },
            "audio": {},
            "ui": {},
        }
    )
    with pytest.raises(FrogLabelCliError, match="explicit selectionPriority"):
        plan_catalog_sync(live, implicit_priority)

    explicit_priority = ProjectConfiguration.model_validate(
        {
            **implicit_priority.model_dump(by_alias=True),
            "catalog": {
                "species": [
                    {
                        **implicit_priority.catalog.species[0].model_dump(by_alias=True),
                        "selectionPriority": 0,
                    }
                ]
            },
        }
    )
    assert plan_catalog_sync(live, explicit_priority).semantic_change is True


def test_legacy_enterprise_state_embeds_history_without_activating_it(catalog) -> None:
    state = EnterpriseState.model_validate(
        {
            "schemaVersion": 1,
            "catalogId": "fixture:legacy-enterprise",
            "catalogRevision": 2,
            "initializedAt": catalog.initialized_at,
            "initializedBy": "legacy tests",
            "defaultSpeciesId": "fixture:red",
            "configManagedSpeciesIds": [],
            "species": [
                {
                    "schemaVersion": 1,
                    "kind": "froglabel.species",
                    "speciesId": "fixture:red",
                    "code": "RED",
                    "speciesName": "Legacy Red Frog",
                    "addedAfterInitialization": False,
                    "createdAt": catalog.initialized_at,
                    "updatedAt": catalog.initialized_at,
                }
            ],
        }
    )

    readable = state.catalog()
    assert readable.species == []
    assert readable.default_species_id is None
    assert readable.historical_species is not None
    assert readable.historical_species[0].species_id == "fixture:red"

    implicit_priority = ProjectConfiguration.model_validate(
        {
            "schemaVersion": 2,
            "project": {},
            "catalog": {
                "species": [
                    {
                        "speciesId": "fixture:red",
                        "code": "RED",
                        "speciesName": "Legacy Red Frog",
                        "adoptExisting": True,
                    }
                ]
            },
            "audio": {},
            "ui": {},
        }
    )
    with pytest.raises(FrogLabelCliError, match="explicit selectionPriority"):
        plan_enterprise_sync(state, implicit_priority)


def test_enterprise_artifact_render_is_byte_deterministic_from_applied_state(
    tmp_path: Path,
) -> None:
    administrator = EnterpriseProjectAdministrator()
    candidate = configuration()
    first = administrator.init(tmp_path, candidate)
    first_interface = (tmp_path / "froglabel.enterprise.jsx").read_bytes()
    second = administrator.render(tmp_path, candidate)
    assert (tmp_path / "froglabel.enterprise.jsx").read_bytes() == first_interface
    assert "Enterprise project is unchanged" in first["message"]
    assert second["artifacts"]["interfaceSha256"] == first["artifacts"]["interfaceSha256"]
    source = first_interface.decode("utf-8")
    assert source.rstrip().endswith(");")
    assert "default:FrogLabelEnterpriseInterface" in source
    assert "outputSchema:FrogLabelEnterpriseBundle.outputSchema" in source


def test_flat_export_validates_singleton_and_neutralizes_csv_formula(
    tmp_path: Path,
) -> None:
    document = {
        "kind": "froglabel.annotation-set",
        "schemaVersion": 1,
        "catalogId": "fixture:catalog",
        "reviewStatus": "calls_present",
        "boxes": [
            {
                "id": "box:one",
                "species": {
                    "speciesId": "fixture:gre",
                    "code": "GRE",
                    "speciesName": "=Green Tree Frog",
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
    source = tmp_path / "native.json"
    source.write_text(
        json.dumps(
            [
                {
                    "id": 1,
                    "annotations": [
                        {
                            "id": 2,
                            "result": [
                                {
                                    "id": "outer:stable",
                                    "from_name": "froglabel",
                                    "to_name": "froglabel",
                                    "type": "reactcode",
                                    "value": {"reactcode": document},
                                }
                            ],
                        }
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )
    json_output = tmp_path / "canonical.json"
    csv_output = tmp_path / "flat.csv"
    summary = export_label_studio_project(source, json_output, csv_output)
    assert summary == {
        "valid": True,
        "annotationCount": 1,
        "boxCount": 1,
        "jsonOutput": str(json_output),
        "csvOutput": str(csv_output),
    }
    assert "'=Green Tree Frog" in csv_output.read_text(encoding="utf-8")


def test_flat_export_accepts_enterprise_interface_textarea_result(tmp_path: Path) -> None:
    document = {
        "kind": "froglabel.annotation-set",
        "schemaVersion": 1,
        "catalogId": "fixture:catalog",
        "reviewStatus": "no_calls",
        "boxes": [],
    }
    source = tmp_path / "native-interface.json"
    source.write_text(
        json.dumps(
            [
                {
                    "id": 1,
                    "annotations": [
                        {
                            "id": 2,
                            "result": [
                                {
                                    "id": "outer:stable",
                                    "from_name": "froglabel",
                                    "to_name": "audio",
                                    "type": "textarea",
                                    "value": {"text": [json.dumps(document)]},
                                }
                            ],
                        }
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )
    summary = export_label_studio_project(
        source,
        tmp_path / "canonical-interface.json",
        tmp_path / "flat-interface.csv",
    )
    assert summary["annotationCount"] == 1
    assert summary["boxCount"] == 0


def test_flat_export_accepts_enterprise_interface_structured_result(tmp_path: Path) -> None:
    document = {
        "kind": "froglabel.annotation-set",
        "schemaVersion": 1,
        "catalogId": "fixture:catalog",
        "reviewStatus": "no_calls",
        "boxes": [],
    }
    source = tmp_path / "native-structured-interface.json"
    source.write_text(
        json.dumps(
            [
                {
                    "id": 1,
                    "annotations": [
                        {
                            "id": 2,
                            "result": [
                                {
                                    "id": "outer:stable",
                                    "from_name": "froglabel",
                                    "to_name": "audio",
                                    "type": "labels",
                                    "value": [document],
                                }
                            ],
                        }
                    ],
                }
            ]
        ),
        encoding="utf-8",
    )
    summary = export_label_studio_project(
        source,
        tmp_path / "canonical-structured-interface.json",
        tmp_path / "flat-structured-interface.csv",
    )
    assert summary["annotationCount"] == 1
    assert summary["boxCount"] == 0


def test_enterprise_rejects_ce_project_identity(tmp_path: Path) -> None:
    config = tmp_path / "bad.yaml"
    config.write_text(
        "schemaVersion: 1\nproject:\n  hostProjectId: 7\ncatalog:\n  species: []\n",
        encoding="utf-8",
    )
    with pytest.raises(FrogLabelCliError, match=r"omit project\.hostProjectId"):
        load_project_configuration(
            config_name="bad",
            config_dir=tmp_path,
            target="enterprise",
        )


def test_ce_project_commands_require_explicit_runtime_paths() -> None:
    args = cli.build_parser().parse_args(
        [
            "project",
            "init",
            "--target",
            "ce",
            "--project",
            "7",
            "--config-name",
            "base",
        ]
    )
    with pytest.raises(FrogLabelCliError) as captured:
        cli.dispatch(args)
    assert captured.value.code == "CE_SOURCE_REQUIRED"


def test_enterprise_project_commands_reject_ce_runtime_paths(tmp_path: Path) -> None:
    args = cli.build_parser().parse_args(
        [
            "project",
            "init",
            "--target",
            "enterprise",
            "--source",
            str(tmp_path / "label-studio"),
            "--config-name",
            "base",
        ]
    )
    with pytest.raises(FrogLabelCliError) as captured:
        cli.dispatch(args)
    assert captured.value.code == "ENTERPRISE_CE_SOURCE_FORBIDDEN"


def test_ce_project_command_forwards_to_clean_derived_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "label-studio"
    data_dir = tmp_path / "label-studio-data"
    observed: dict[str, object] = {}

    class Runtime:
        def __init__(self, selected_source: Path):
            observed["source"] = selected_source

        def run_project_administration(self, **options: object) -> dict[str, object]:
            observed.update(options)
            return {"target": "ce", "project": 7, "valid": True}

    monkeypatch.setattr(cli, "CeRuntime", Runtime)
    monkeypatch.setattr(
        cli,
        "load_project_configuration",
        lambda **_options: (configuration(target="ce"), {"fixture": True}),
    )
    monkeypatch.chdir(tmp_path)
    args = cli.build_parser().parse_args(
        [
            "project",
            "init",
            "--target",
            "ce",
            "--source",
            str(source),
            "--data-dir",
            str(data_dir),
            "--project",
            "7",
            "--config-name",
            "base",
        ]
    )

    result = cli.dispatch(args)

    assert result["target"] == "ce"
    assert result["resolvedConfiguration"] == {"fixture": True}
    assert observed["source"] == source
    assert observed["data_dir"] == data_dir
    assert observed["command"] == "init"
    assert observed["project_id"] == 7
