"""Opentrons Python protocol importer.

Parses the ``metadata`` dict and common API calls
(``load_instrument``, ``load_labware``, ``load_module``) without
executing the protocol.
"""

import ast
import re
from pathlib import Path
from typing import Any, Dict, List


def _extract_metadata(content: str) -> Dict[str, Any]:
    """Use the AST to pull values from the top-level ``metadata`` dict."""
    result: Dict[str, Any] = {}
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return result

    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == "metadata":
                if isinstance(node.value, ast.Dict):
                    for k, v in zip(node.value.keys, node.value.values):
                        if isinstance(k, ast.Constant) and isinstance(v, ast.Constant):
                            result[k.value] = v.value
    return result


def _find_pipettes(content: str) -> List[Dict[str, str]]:
    pipettes: List[Dict[str, str]] = []
    for match in re.finditer(
        r"""load_instrument\(\s*['"](\w+)['"][^)]*['"](\w+)['"]""",
        content,
    ):
        pipettes.append({"name": match.group(1), "mount": match.group(2)})
    return pipettes


def _find_labware(content: str) -> List[str]:
    return [
        m.group(1)
        for m in re.finditer(r"""load_labware\(\s*['"]([^'"]+)['"]""", content)
    ]


def _find_modules(content: str) -> List[str]:
    return [
        m.group(1)
        for m in re.finditer(r"""load_module\(\s*['"]([^'"]+)['"]""", content)
    ]


def import_opentrons_protocol(filepath: str) -> Dict[str, Any]:
    """Parse an Opentrons Python protocol and return PCC job parameters."""
    path = Path(filepath)
    with open(path, "r", encoding="utf-8") as fh:
        content = fh.read()

    meta = _extract_metadata(content)

    params: Dict[str, Any] = {
        "type": "liquid-handler",
        "filename": path.name,
        "protocolContent": content,
        "apiLevel": meta.get("apiLevel"),
        "protocolName": meta.get("protocolName"),
        "pipettes": _find_pipettes(content),
        "labware": _find_labware(content),
        "modules": _find_modules(content),
    }

    return {
        "capabilityType": "liquid-handler",
        "parameters": params,
        "rawFile": str(path),
    }
