from __future__ import annotations

import hashlib
import json
import shutil
import uuid
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .admin_config import ProjectConfiguration, configuration_fingerprint
from .errors import ErrorContext, FrogLabelCliError
from .models import (
    ExternalTaxon,
    LabelStudioResult,
    SpeciesCatalog,
    SpeciesEntry,
)

STATE_FILENAME = ".froglabel-enterprise-state.json"
FULL_INTERFACE_FILENAME = "froglabel.enterprise.jsx"
PREVIOUS_INTERFACE_FILENAME = "froglabel.enterprise.previous.jsx"


def _camel(name: str) -> str:
    head, *tail = name.split("_")
    return head + "".join(part.capitalize() for part in tail)


class EnterpriseState(BaseModel):
    model_config = ConfigDict(
        alias_generator=_camel,
        populate_by_name=True,
        extra="forbid",
    )

    schema_version: Literal[1] = 1
    kind: Literal["froglabel.enterprise-project-state"] = "froglabel.enterprise-project-state"
    catalog_id: str = Field(min_length=1, max_length=256)
    catalog_revision: int = Field(ge=1)
    initialized_at: datetime
    initialized_by: str = Field(min_length=1, max_length=256)
    default_species_id: str | None = Field(default=None, min_length=1, max_length=256)
    config_managed_species_ids: list[str] = Field(default_factory=list, max_length=10_000)
    species: list[SpeciesEntry] = Field(default_factory=list, max_length=10_000)

    @model_validator(mode="after")
    def validate_catalog_state(self) -> EnterpriseState:
        catalog = self.catalog()
        ids = {entry.species_id for entry in catalog.species}
        if not set(self.config_managed_species_ids).issubset(ids):
            raise ValueError("configManagedSpeciesIds references an absent species")
        return self

    def catalog(self) -> SpeciesCatalog:
        return SpeciesCatalog(
            catalog_id=self.catalog_id,
            initialized_at=self.initialized_at,
            initialized_by=self.initialized_by,
            catalog_revision=self.catalog_revision,
            default_species_id=self.default_species_id,
            species=self.species,
        )


class EnterpriseChange(BaseModel):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True, extra="forbid")

    action: Literal["add", "update", "retain"]
    species_id: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None
    note: str


class EnterprisePlan(BaseModel):
    model_config = ConfigDict(alias_generator=_camel, populate_by_name=True, extra="forbid")

    schema_version: Literal[1] = 1
    catalog_id: str
    current_revision: int
    next_revision: int
    semantic_change: bool
    species_changes: list[EnterpriseChange]
    default_change: dict[str, Any]
    managed_species_ids_after: list[str]

    def stable_dict(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True, mode="json", exclude_none=False)


class EnterpriseProjectAdministrator:
    """Pure local Enterprise state and publishable Interface administrator."""

    def init(self, output_dir: Path, candidate: ProjectConfiguration) -> dict[str, Any]:
        output = output_dir.expanduser().resolve()
        state_path = output / STATE_FILENAME
        existing = read_state(state_path, allow_missing=True)
        if existing is None:
            now = datetime.now(UTC)
            species = [
                configured_species(entry, now, added=False) for entry in candidate.catalog.species
            ]
            state = EnterpriseState(
                catalog_id=f"local:{uuid.uuid4()}",
                catalog_revision=1,
                initialized_at=now,
                initialized_by="froglabel project init --target enterprise",
                default_species_id=(
                    candidate.project.default_species_id
                    if candidate.project.has_default_intent
                    else None
                ),
                config_managed_species_ids=sorted(entry.species_id for entry in species),
                species=species,
            )
            plan = None
            initialized = True
        else:
            plan = plan_enterprise_sync(existing, candidate)
            if plan.semantic_change:
                raise FrogLabelCliError(
                    "ENTERPRISE_INIT_DRIFT",
                    "Enterprise state already exists and configuration differs; "
                    "inspect project sync --dry-run",
                )
            state = existing
            initialized = False
        write_state(state_path, state)
        artifacts = render_enterprise_artifacts(output, state, candidate)
        return {
            "target": "enterprise",
            "initialized": initialized,
            "configurationFingerprint": configuration_fingerprint(candidate),
            "catalog": state.catalog().model_dump(by_alias=True, mode="json", exclude_none=True),
            "plan": plan.stable_dict() if plan else None,
            "artifacts": artifacts,
            "message": enterprise_unchanged_message(output),
        }

    def sync(
        self,
        output_dir: Path,
        candidate: ProjectConfiguration,
        *,
        apply: bool,
        label_studio_export: Path | None = None,
        reconciliation_output: Path | None = None,
    ) -> dict[str, Any]:
        output = output_dir.expanduser().resolve()
        state_path = output / STATE_FILENAME
        state = read_state(state_path)
        assert state is not None
        plan = plan_enterprise_sync(state, candidate)
        reconciliation = None
        if label_studio_export is not None:
            reconciliation = reconcile_enterprise_export(state, label_studio_export)
            if reconciliation_output is not None:
                write_yaml(reconciliation_output, reconciliation["proposedHydraFragment"])
        if not apply:
            return {
                "target": "enterprise",
                "applied": False,
                "configurationFingerprint": configuration_fingerprint(candidate),
                "plan": plan.stable_dict(),
                "reconciliation": reconciliation,
                "message": (
                    "Dry run only; local state, generated artifacts, Hydra, "
                    "and Enterprise were unchanged."
                ),
            }
        updated = apply_enterprise_plan(state, candidate, plan)
        write_state(state_path, updated)
        artifacts = render_enterprise_artifacts(output, updated, candidate)
        return {
            "target": "enterprise",
            "applied": True,
            "configurationFingerprint": configuration_fingerprint(candidate),
            "plan": plan.stable_dict(),
            "reconciliation": reconciliation,
            "catalog": updated.catalog().model_dump(by_alias=True, mode="json", exclude_none=True),
            "artifacts": artifacts,
            "message": enterprise_unchanged_message(output),
        }

    def validate(
        self,
        output_dir: Path,
        candidate: ProjectConfiguration | None = None,
    ) -> dict[str, Any]:
        output = output_dir.expanduser().resolve()
        state = read_state(output / STATE_FILENAME)
        assert state is not None
        validate_artifacts(output, state)
        plan = plan_enterprise_sync(state, candidate) if candidate else None
        return {
            "target": "enterprise",
            "valid": True,
            "catalog": state.catalog().model_dump(by_alias=True, mode="json", exclude_none=True),
            "plan": plan.stable_dict() if plan else None,
            "remoteProject": "unchanged and not contacted",
        }

    def render(
        self,
        output_dir: Path,
        candidate: ProjectConfiguration,
    ) -> dict[str, Any]:
        output = output_dir.expanduser().resolve()
        state = read_state(output / STATE_FILENAME)
        assert state is not None
        plan = plan_enterprise_sync(state, candidate)
        if plan.semantic_change:
            raise FrogLabelCliError(
                "ENTERPRISE_CONFIGURATION_DRIFT",
                "Configuration differs from applied local state; run project sync --dry-run first",
            )
        artifacts = render_enterprise_artifacts(output, state, candidate)
        return {
            "target": "enterprise",
            "rendered": True,
            "artifacts": artifacts,
            "message": enterprise_unchanged_message(output),
        }


def plan_enterprise_sync(
    state: EnterpriseState,
    candidate: ProjectConfiguration,
) -> EnterprisePlan:
    configured = {entry.species_id: entry for entry in candidate.catalog.species}
    current = {entry.species_id: entry for entry in state.species}
    managed = set(state.config_managed_species_ids)
    managed_after = set(managed)
    changes: list[EnterpriseChange] = []
    codes: dict[str, str] = {}
    for species_id, prior in sorted(current.items()):
        desired = configured.get(species_id)
        before = species_fields(prior)
        if desired is None:
            changes.append(
                EnterpriseChange(
                    action="retain",
                    species_id=species_id,
                    before=before,
                    after=before,
                    note="retained (deletion unsupported)",
                )
            )
            reserve_code(codes, prior.code, species_id)
            continue
        if species_id not in managed and not desired.adopt_existing:
            raise FrogLabelCliError(
                "ENTERPRISE_UNMANAGED_ID_COLLISION",
                f"Species {species_id} exists outside configuration management; "
                "set adoptExisting: true",
            )
        managed_after.add(species_id)
        after = configured_fields(desired)
        changed = before != after or species_id not in managed
        changes.append(
            EnterpriseChange(
                action="update" if changed else "retain",
                species_id=species_id,
                before=before,
                after=after if changed else before,
                note=(
                    "update current fields by immutable ID"
                    if changed
                    else "configuration-managed entry unchanged"
                ),
            )
        )
        reserve_code(codes, desired.code, species_id)
    for species_id, desired in sorted(configured.items()):
        if species_id in current:
            continue
        if desired.adopt_existing:
            raise FrogLabelCliError(
                "ENTERPRISE_ADOPT_TARGET_MISSING",
                f"adoptExisting targets absent speciesId {species_id}",
            )
        reserve_code(codes, desired.code, species_id)
        managed_after.add(species_id)
        changes.append(
            EnterpriseChange(
                action="add",
                species_id=species_id,
                before=None,
                after=configured_fields(desired),
                note="append configured species after initialization",
            )
        )
    before_default = state.default_species_id
    if not candidate.project.has_default_intent:
        default_change = {
            "action": "leave",
            "before": before_default,
            "after": before_default,
        }
    else:
        after_default = candidate.project.default_species_id
        if after_default is not None and after_default not in set(current) | set(configured):
            raise FrogLabelCliError(
                "ENTERPRISE_DEFAULT_MISSING",
                f"Default speciesId does not exist: {after_default}",
            )
        default_change = {
            "action": (
                "unchanged"
                if after_default == before_default
                else "clear"
                if after_default is None
                else "set"
            ),
            "before": before_default,
            "after": after_default,
        }
    semantic = any(change.action != "retain" for change in changes) or default_change["action"] in {
        "set",
        "clear",
    }
    return EnterprisePlan(
        catalog_id=state.catalog_id,
        current_revision=state.catalog_revision,
        next_revision=state.catalog_revision + (1 if semantic else 0),
        semantic_change=semantic,
        species_changes=changes,
        default_change=default_change,
        managed_species_ids_after=sorted(managed_after),
    )


def apply_enterprise_plan(
    state: EnterpriseState,
    candidate: ProjectConfiguration,
    plan: EnterprisePlan,
) -> EnterpriseState:
    if not plan.semantic_change:
        return state
    configured = {entry.species_id: entry for entry in candidate.catalog.species}
    current = {entry.species_id: entry for entry in state.species}
    now = datetime.now(UTC)
    for change in plan.species_changes:
        if change.action == "retain":
            continue
        desired = configured[change.species_id]
        prior = current.get(change.species_id)
        if prior is None:
            current[change.species_id] = configured_species(desired, now, added=True)
        else:
            taxon = (
                ExternalTaxon.model_validate(desired.external_taxon.model_dump(by_alias=True))
                if desired.external_taxon
                else None
            )
            current[change.species_id] = prior.model_copy(
                update={
                    "code": desired.code,
                    "species_name": desired.species_name,
                    "scientific_name": desired.scientific_name,
                    "external_taxon": taxon,
                    "updated_at": now,
                }
            )
    return state.model_copy(
        update={
            "catalog_revision": plan.next_revision,
            "default_species_id": plan.default_change["after"],
            "config_managed_species_ids": plan.managed_species_ids_after,
            "species": sorted(current.values(), key=lambda entry: entry.species_id),
        }
    )


def render_enterprise_artifacts(
    output: Path,
    state: EnterpriseState,
    candidate: ProjectConfiguration,
) -> dict[str, Any]:
    output.mkdir(parents=True, exist_ok=True)
    bundle, bundle_manifest = load_enterprise_bundle()
    catalog = state.catalog().model_dump(by_alias=True, mode="json", exclude_none=True)
    source = enterprise_interface(bundle, catalog)
    validate_enterprise_interface(source)
    full_path = output / FULL_INTERFACE_FILENAME
    if full_path.is_file() and full_path.read_bytes() != source.encode("utf-8"):
        shutil.copy2(full_path, output / PREVIOUS_INTERFACE_FILENAME)
    atomic_text(full_path, source)
    atomic_json(output / "embedded-catalog.json", catalog)
    manifest = {
        "kind": "froglabel.enterprise-interface-artifact",
        "schemaVersion": 1,
        "buildVersion": bundle_manifest["buildVersion"],
        "sourceCommit": bundle_manifest["sourceCommit"],
        "catalogId": state.catalog_id,
        "catalogRevision": state.catalog_revision,
        "configurationFingerprint": configuration_fingerprint(candidate),
        "interfaceSha256": sha256_text(source),
        "interfaceBytes": len(source.encode("utf-8")),
        "bundleMinifiedBytes": bundle_manifest["minifiedBytes"],
        "bundleUnminifiedBytes": bundle_manifest["unminifiedBytes"],
        "hostReactExternal": True,
        "networkPolicy": "task audio only",
        "forbiddenContentScan": scan_enterprise_interface(source),
        "audioLimits": candidate.audio.model_dump(by_alias=True, mode="json"),
        "ui": candidate.ui.model_dump(by_alias=True, mode="json"),
    }
    atomic_json(output / "froglabel.enterprise.manifest.json", manifest)
    return {
        "interface": str(full_path),
        "manifest": str(output / "froglabel.enterprise.manifest.json"),
        "catalog": str(output / "embedded-catalog.json"),
        "interfaceSha256": manifest["interfaceSha256"],
        "interfaceBytes": manifest["interfaceBytes"],
    }


def validate_artifacts(output: Path, state: EnterpriseState) -> None:
    required = [
        FULL_INTERFACE_FILENAME,
        "froglabel.enterprise.manifest.json",
        "embedded-catalog.json",
    ]
    missing = [name for name in required if not (output / name).is_file()]
    if missing:
        raise FrogLabelCliError(
            "ENTERPRISE_ARTIFACT_MISSING", f"Missing generated artifacts: {', '.join(missing)}"
        )
    source = (output / FULL_INTERFACE_FILENAME).read_text(encoding="utf-8")
    validate_enterprise_interface(source)
    manifest = json.loads((output / "froglabel.enterprise.manifest.json").read_text())
    catalog = SpeciesCatalog.model_validate_json((output / "embedded-catalog.json").read_text())
    if manifest.get("interfaceSha256") != sha256_text(source):
        raise FrogLabelCliError(
            "ENTERPRISE_MANIFEST_DRIFT", "Enterprise Interface checksum differs"
        )
    if catalog.catalog_id != state.catalog_id or catalog.catalog_revision != state.catalog_revision:
        raise FrogLabelCliError(
            "ENTERPRISE_CATALOG_DRIFT", "Embedded catalog differs from local state"
        )


def reconcile_enterprise_export(state: EnterpriseState, source: Path) -> dict[str, Any]:
    try:
        raw = json.loads(source.expanduser().resolve(strict=True).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FrogLabelCliError(
            "ENTERPRISE_EXPORT_INVALID",
            str(error),
            context=ErrorContext(source=str(source)),
        ) from error
    tasks = raw if isinstance(raw, list) else raw.get("tasks") if isinstance(raw, dict) else None
    if not isinstance(tasks, list):
        raise FrogLabelCliError("ENTERPRISE_EXPORT_INVALID", "Expected a native task export array")
    discovered: dict[str, dict[str, Any]] = {}
    conflicts: list[dict[str, Any]] = []
    documents = 0
    for task_index, task in enumerate(tasks):
        if not isinstance(task, dict):
            conflicts.append({"type": "invalidTask", "taskIndex": task_index})
            continue
        for annotation in task.get("annotations", []):
            for result in annotation.get("result", []):
                if not isinstance(result, dict):
                    continue
                if result.get("from_name", result.get("fromName")) != "froglabel":
                    continue
                try:
                    envelope = LabelStudioResult.model_validate(result)
                    document = envelope.document()
                except (ValidationError, ValueError) as error:
                    conflicts.append(
                        {"type": "invalidDocument", "taskIndex": task_index, "detail": str(error)}
                    )
                    continue
                documents += 1
                if document.catalog_id != state.catalog_id:
                    conflicts.append(
                        {
                            "type": "catalogIdMismatch",
                            "taskIndex": task_index,
                            "catalogId": document.catalog_id,
                        }
                    )
                    continue
                for box in document.boxes:
                    snapshot = box.species.model_dump(by_alias=True, mode="json", exclude_none=True)
                    if not snapshot["addedAfterInitialization"]:
                        continue
                    prior = discovered.get(snapshot["speciesId"])
                    if prior is not None and prior != snapshot:
                        conflicts.append(
                            {
                                "type": "sameIdDifferentSnapshot",
                                "speciesId": snapshot["speciesId"],
                                "before": prior,
                                "after": snapshot,
                            }
                        )
                    else:
                        discovered[snapshot["speciesId"]] = snapshot
    seed_by_id = {entry.species_id: entry for entry in state.species}
    code_owners = {entry.code.casefold(): entry.species_id for entry in state.species}
    additions: list[dict[str, Any]] = []
    for species_id, snapshot in sorted(discovered.items()):
        seed = seed_by_id.get(species_id)
        if seed is not None:
            current_snapshot = {
                "speciesId": seed.species_id,
                "code": seed.code,
                "speciesName": seed.species_name,
                **({"scientificName": seed.scientific_name} if seed.scientific_name else {}),
                "addedAfterInitialization": seed.added_after_initialization,
            }
            if current_snapshot != snapshot:
                conflicts.append(
                    {
                        "type": "exactIdDifference",
                        "speciesId": species_id,
                        "embedded": current_snapshot,
                        "exported": snapshot,
                    }
                )
            continue
        other = code_owners.get(snapshot["code"].casefold())
        if other and other != species_id:
            conflicts.append(
                {
                    "type": "codeCollision",
                    "code": snapshot["code"],
                    "speciesIds": [other, species_id],
                }
            )
            continue
        code_owners[snapshot["code"].casefold()] = species_id
        additions.append(
            {
                "speciesId": species_id,
                "code": snapshot["code"],
                "speciesName": snapshot["speciesName"],
                **(
                    {"scientificName": snapshot["scientificName"]}
                    if snapshot.get("scientificName")
                    else {}
                ),
            }
        )
    return {
        "documentsValidated": documents,
        "discoveredSpecies": len(discovered),
        "proposedAdditions": additions,
        "conflicts": conflicts,
        "requiresExplicitHydraAdoption": True,
        "proposedHydraFragment": {"catalog": {"species": additions}},
    }


def enterprise_interface(bundle: str, catalog: dict[str, Any]) -> str:
    catalog_json = json.dumps(catalog, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return (
        "var __FROGLABEL_HOST_REACT__=React;\n"
        f"{bundle.strip()}\n"
        f"var __FROGLABEL_CATALOG__={catalog_json};\n"
        "function FrogLabelEnterpriseInterface(props){\n"
        "  return FrogLabelEnterpriseBundle.renderEnterpriseFrogLabel("
        "props,__FROGLABEL_CATALOG__);\n"
        "}\n"
        "function getResults(regions,relations){\n"
        "  return FrogLabelEnterpriseBundle.getResults(regions,relations);\n"
        "}\n"
        "function parseResults(results){\n"
        "  return FrogLabelEnterpriseBundle.parseResults(results);\n"
        "}\n"
        "({\n"
        "  default:FrogLabelEnterpriseInterface,\n"
        "  specVersion:1,\n"
        "  paramsSchema:FrogLabelEnterpriseBundle.paramsSchema,\n"
        "  inputSchema:FrogLabelEnterpriseBundle.inputSchema,\n"
        "  outputSchema:FrogLabelEnterpriseBundle.outputSchema,\n"
        "  getResults:getResults,\n"
        "  parseResults:parseResults\n"
        "});\n"
    )


def validate_enterprise_interface(source: str) -> None:
    if "function FrogLabelEnterpriseInterface" not in source:
        raise FrogLabelCliError("ENTERPRISE_INTERFACE_INVALID", "Generated component is absent")
    required = [
        "default:",
        "paramsSchema:",
        "inputSchema:",
        "outputSchema:",
        "getResults:",
        "parseResults:",
    ]
    missing = [name for name in required if name not in source]
    if missing:
        raise FrogLabelCliError(
            "ENTERPRISE_INTERFACE_INVALID",
            f"Generated Interface exports are absent: {', '.join(missing)}",
        )
    if not source.rstrip().endswith(");"):
        raise FrogLabelCliError(
            "ENTERPRISE_INTERFACE_INVALID", "Interface must end with a parenthesized object"
        )
    scan_enterprise_interface(source)


def scan_enterprise_interface(source: str) -> dict[str, str]:
    checks = {
        "moduleImport": " import " not in source and "import(" not in source,
        "moduleExport": " export " not in source,
        "commonJsRequire": "require(" not in source,
        "dynamicEvaluation": "eval(" not in source and "new Function(" not in source,
        "reactDom": "ReactDOM" not in source,
        "parentDocument": "parent.document" not in source,
        "runtimeFrogLabelEndpoint": "/froglabel/api/" not in source,
        "serviceWorker": "serviceWorker.register" not in source,
    }
    failures = [name for name, passed in checks.items() if not passed]
    if failures:
        raise FrogLabelCliError(
            "ENTERPRISE_FORBIDDEN_CONTENT", f"Forbidden-content scan failed: {', '.join(failures)}"
        )
    return {name: "passed" for name in checks}


def configured_species(configured: Any, now: datetime, *, added: bool) -> SpeciesEntry:
    taxon = (
        ExternalTaxon.model_validate(configured.external_taxon.model_dump(by_alias=True))
        if configured.external_taxon
        else None
    )
    return SpeciesEntry(
        species_id=configured.species_id,
        code=configured.code,
        species_name=configured.species_name,
        scientific_name=configured.scientific_name,
        external_taxon=taxon,
        added_after_initialization=added,
        created_at=now,
        updated_at=now,
    )


def configured_fields(entry: Any) -> dict[str, Any]:
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


def species_fields(entry: SpeciesEntry) -> dict[str, Any]:
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


def reserve_code(codes: dict[str, str], code: str, species_id: str) -> None:
    folded = code.casefold()
    other = codes.get(folded)
    if other is not None and other != species_id:
        raise FrogLabelCliError(
            "ENTERPRISE_CODE_COLLISION",
            f"Current code {code} would belong to both {other} and {species_id}",
        )
    codes[folded] = species_id


def load_enterprise_bundle() -> tuple[str, dict[str, Any]]:
    root = resources.files("froglabel_cli").joinpath("resources")
    try:
        bundle = root.joinpath("enterprise-bundle.js").read_text(encoding="utf-8")
        manifest = json.loads(
            root.joinpath("enterprise-bundle.manifest.json").read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError) as error:
        raise FrogLabelCliError(
            "ENTERPRISE_BUNDLE_MISSING",
            "Installed Enterprise component bundle is missing; rebuild the froglabel-cli package",
        ) from error
    return bundle, manifest


def read_state(path: Path, *, allow_missing: bool = False) -> EnterpriseState | None:
    if allow_missing and not path.is_file():
        return None
    try:
        return EnterpriseState.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError as error:
        raise FrogLabelCliError(
            "ENTERPRISE_STATE_MISSING", f"Cannot read local Enterprise state: {path}"
        ) from error
    except ValidationError as error:
        raise FrogLabelCliError("ENTERPRISE_STATE_INVALID", str(error)) from error


def write_state(path: Path, state: EnterpriseState) -> None:
    atomic_json(path, state.model_dump(by_alias=True, mode="json", exclude_none=False))


def write_yaml(path: Path, value: Any) -> None:
    resolved = path.expanduser().resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    temporary = resolved.with_suffix(f"{resolved.suffix}.tmp")
    temporary.write_text(
        yaml.safe_dump(value, sort_keys=False, allow_unicode=True), encoding="utf-8"
    )
    temporary.replace(resolved)


def atomic_json(path: Path, value: Any) -> None:
    atomic_text(
        path,
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(value, encoding="utf-8")
    temporary.replace(path)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def enterprise_unchanged_message(output: Path) -> str:
    return (
        f"Generated {output / FULL_INTERFACE_FILENAME}. The Enterprise project is unchanged. "
        "Validate or publish it with `label-studio-sdk interface`."
    )
