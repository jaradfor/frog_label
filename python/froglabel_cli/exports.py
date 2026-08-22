from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .errors import ErrorContext, FrogLabelCliError
from .models import FrogLabelDocument, LabelStudioResult

CSV_COLUMNS = (
    "task_id",
    "annotation_id",
    "catalog_id",
    "review_status",
    "box_id",
    "species_id",
    "species_code",
    "species_name",
    "scientific_name",
    "added_after_initialization",
    "start_time_seconds",
    "end_time_seconds",
    "low_frequency_hz",
    "high_frequency_hz",
)


def export_label_studio_project(
    input_path: Path,
    json_output: Path,
    csv_output: Path,
) -> dict[str, Any]:
    records = parse_label_studio_export(input_path)
    canonical = {
        "kind": "froglabel.project-export",
        "schemaVersion": 1,
        "annotations": records,
    }
    _write_json(json_output, canonical)
    rows = flatten_records(records)
    _write_csv(csv_output, rows)
    return {
        "valid": True,
        "annotationCount": len(records),
        "boxCount": sum(len(item["document"]["boxes"]) for item in records),
        "jsonOutput": str(json_output.expanduser().resolve()),
        "csvOutput": str(csv_output.expanduser().resolve()),
    }


def parse_label_studio_export(path: Path) -> list[dict[str, Any]]:
    resolved = path.expanduser().resolve()
    try:
        raw = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise FrogLabelCliError(
            "EXPORT_READ_FAILED",
            f"Cannot read native Label Studio JSON export: {error}",
            context=ErrorContext(source=str(resolved)),
        ) from error
    if not isinstance(raw, list):
        raise FrogLabelCliError("EXPORT_SHAPE_INVALID", "Native project export must be an array")

    parsed: list[dict[str, Any]] = []
    seen: set[tuple[Any, Any]] = set()
    for task_index, task in enumerate(raw):
        if not isinstance(task, dict):
            raise _shape_error(task_index, "task must be an object")
        task_id = task.get("id")
        annotations = task.get("annotations", [])
        if not isinstance(annotations, list):
            raise _shape_error(task_index, "annotations must be an array")
        for annotation_index, annotation in enumerate(annotations):
            if not isinstance(annotation, dict):
                raise _shape_error(task_index, f"annotation {annotation_index} must be an object")
            annotation_id = annotation.get("id")
            identity = (task_id, annotation_id)
            if identity in seen:
                raise _shape_error(task_index, f"duplicate task/annotation identity {identity!r}")
            seen.add(identity)
            result = annotation.get("result", [])
            if not isinstance(result, list):
                raise _shape_error(
                    task_index, f"annotation {annotation_id!r} result must be an array"
                )
            frog_results = [
                item
                for item in result
                if isinstance(item, dict)
                and item.get("from_name", item.get("fromName")) == "froglabel"
            ]
            if not frog_results:
                continue
            if len(frog_results) != 1:
                raise _shape_error(
                    task_index,
                    f"annotation {annotation_id!r} has {len(frog_results)} FrogLabel results",
                )
            try:
                envelope = LabelStudioResult.model_validate(frog_results[0])
            except ValidationError as error:
                raise FrogLabelCliError(
                    "EXPORT_RESULT_INVALID",
                    f"Task {task_id!r}, annotation {annotation_id!r}: {error}",
                    context=ErrorContext(source=str(resolved), record=task_index + 1),
                ) from error
            expected_target = "froglabel" if envelope.type == "reactcode" else "audio"
            if envelope.from_name != "froglabel" or envelope.to_name != expected_target:
                raise _shape_error(
                    task_index,
                    f"FrogLabel {envelope.type} result must target {expected_target}",
                )
            try:
                document = envelope.document()
            except (ValidationError, ValueError) as error:
                raise FrogLabelCliError(
                    "EXPORT_RESULT_INVALID",
                    f"Task {task_id!r}, annotation {annotation_id!r}: {error}",
                    context=ErrorContext(source=str(resolved), record=task_index + 1),
                ) from error
            parsed.append(
                {
                    "taskId": task_id,
                    "annotationId": annotation_id,
                    "outerResultId": envelope.id,
                    "document": document.model_dump(
                        by_alias=True,
                        mode="json",
                        exclude_none=True,
                    ),
                }
            )
    return parsed


def flatten_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for record in records:
        document = FrogLabelDocument.model_validate(record["document"])
        common = {
            "task_id": record["taskId"],
            "annotation_id": record["annotationId"],
            "catalog_id": document.catalog_id,
            "review_status": document.review_status,
        }
        if not document.boxes:
            rows.append({**common})
            continue
        for box in document.boxes:
            rows.append(
                {
                    **common,
                    "box_id": box.id,
                    "species_id": box.species.species_id,
                    "species_code": box.species.code,
                    "species_name": box.species.species_name,
                    "scientific_name": box.species.scientific_name,
                    "added_after_initialization": box.species.added_after_initialization,
                    "start_time_seconds": box.start_time_seconds,
                    "end_time_seconds": box.end_time_seconds,
                    "low_frequency_hz": box.low_frequency_hz,
                    "high_frequency_hz": box.high_frequency_hz,
                }
            )
    return rows


def _write_json(path: Path, value: Any) -> None:
    resolved = path.expanduser().resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    resolved = path.expanduser().resolve()
    resolved.parent.mkdir(parents=True, exist_ok=True)
    try:
        with resolved.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=CSV_COLUMNS, extrasaction="raise")
            writer.writeheader()
            writer.writerows(
                {key: _safe_csv_cell(value) for key, value in row.items()} for row in rows
            )
    except OSError as error:
        raise FrogLabelCliError("EXPORT_WRITE_FAILED", str(error)) from error


def _shape_error(task_index: int, message: str) -> FrogLabelCliError:
    return FrogLabelCliError(
        "EXPORT_SHAPE_INVALID",
        message,
        context=ErrorContext(record=task_index + 1),
    )


def _safe_csv_cell(value: Any) -> Any:
    """Prevent spreadsheet formula execution without changing numeric coordinates."""

    if isinstance(value, str) and value.startswith(("=", "+", "-", "@")):
        return f"'{value}"
    return value
