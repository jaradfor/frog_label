from __future__ import annotations

import html
import json
from importlib import resources
from pathlib import Path
from typing import Any
from xml.etree import ElementTree

from .errors import FrogLabelCliError

CE_ASSET_PATH = "/react-app/froglabel/index.html"
REACTCODE_NAME = "froglabel"
DATA_KEY_NAME = "froglabel_data_key"
WORKSPACE_STYLE = {"height": "calc(100vh - 210px)", "minHeight": "620px"}


def load_document_schema() -> dict[str, Any]:
    packaged = resources.files("froglabel_cli").joinpath("resources/document.schema.json")
    candidates = [packaged, Path(__file__).resolve().parents[2] / "schemas/document.schema.json"]
    for candidate in candidates:
        try:
            if candidate.is_file():
                value = json.loads(candidate.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    return value
        except (OSError, json.JSONDecodeError):
            continue
    raise FrogLabelCliError(
        "DOCUMENT_SCHEMA_MISSING",
        "The installed canonical FrogLabel document schema is unavailable",
    )


def generate_ce_label_config(document_schema: dict[str, Any] | None = None) -> str:
    schema = document_schema or load_document_schema()
    outputs = json.dumps(schema, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    style = json.dumps(WORKSPACE_STYLE, ensure_ascii=False, separators=(",", ":"))
    hidden = _tag(
        "Text",
        {
            "name": DATA_KEY_NAME,
            "value": "$froglabel",
        },
        indent="    ",
    )
    reactcode = _tag(
        "ReactCode",
        {
            "name": REACTCODE_NAME,
            "toName": REACTCODE_NAME,
            "src": CE_ASSET_PATH,
            "style": style,
            "outputs": outputs,
        },
        indent="  ",
    )
    config = f'<View>\n  <View style="display:none">\n{hidden}\n  </View>\n\n{reactcode}\n</View>\n'
    validate_ce_label_config(config, schema)
    return config


def validate_ce_label_config(config: str, document_schema: dict[str, Any] | None = None) -> None:
    schema = document_schema or load_document_schema()
    try:
        root = ElementTree.fromstring(config)
    except ElementTree.ParseError as error:
        raise FrogLabelCliError(
            "LABEL_CONFIG_INVALID", f"Labeling config is not XML: {error}"
        ) from error
    reactcodes = [node for node in root.iter() if node.tag == "ReactCode"]
    if len(reactcodes) != 1:
        raise FrogLabelCliError("LABEL_CONFIG_INVALID", "Expected exactly one ReactCode tag")
    node = reactcodes[0]
    required = {
        "name": REACTCODE_NAME,
        "toName": REACTCODE_NAME,
        "src": CE_ASSET_PATH,
    }
    for key, expected in required.items():
        if node.attrib.get(key) != expected:
            raise FrogLabelCliError("LABEL_CONFIG_INVALID", f"ReactCode {key} must be {expected!r}")
    if "data" in node.attrib:
        raise FrogLabelCliError(
            "LABEL_CONFIG_INVALID",
            "ReactCode must receive the complete task data object; omit data",
        )
    if "?" in node.attrib["src"]:
        raise FrogLabelCliError(
            "LABEL_CONFIG_INVALID", "ReactCode src must not carry project context in a query string"
        )
    try:
        output = json.loads(node.attrib["outputs"])
        style = json.loads(node.attrib["style"])
    except (KeyError, json.JSONDecodeError) as error:
        raise FrogLabelCliError(
            "LABEL_CONFIG_INVALID", "ReactCode outputs/style is invalid JSON"
        ) from error
    if output != schema:
        raise FrogLabelCliError(
            "LABEL_CONFIG_SCHEMA_DRIFT", "ReactCode outputs differs from the canonical schema"
        )
    if style != WORKSPACE_STYLE:
        raise FrogLabelCliError(
            "LABEL_CONFIG_STYLE_DRIFT", "ReactCode workspace style is unsupported"
        )
    texts = [node for node in root.iter() if node.tag == "Text"]
    if not any(
        item.attrib.get("name") == DATA_KEY_NAME and item.attrib.get("value") == "$froglabel"
        for item in texts
    ):
        raise FrogLabelCliError(
            "LABEL_CONFIG_DATA_KEY_MISSING", "Hidden froglabel task-data declaration is missing"
        )


def normalized_xml(value: str) -> tuple[Any, ...] | str:
    try:
        root = ElementTree.fromstring(value)
    except ElementTree.ParseError:
        return value.strip()

    def normalize(element: ElementTree.Element) -> tuple[Any, ...]:
        return (
            element.tag,
            tuple(sorted(element.attrib.items())),
            (element.text or "").strip(),
            tuple(normalize(child) for child in element),
        )

    return normalize(root)


def _tag(name: str, attributes: dict[str, str], *, indent: str) -> str:
    rendered = "\n".join(
        f'{indent}  {key}="{html.escape(value, quote=True)}"' for key, value in attributes.items()
    )
    return f"{indent}<{name}\n{rendered}\n{indent}/>"
