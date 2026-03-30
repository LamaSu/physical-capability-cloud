"""G-code importer for 3D-printer and CNC files.

Parses slicer comments (PrusaSlicer, Cura, Simplify3D) and
temperature commands to extract job parameters.
"""

from pathlib import Path
from typing import Any, Dict, Optional


def _parse_temp(line: str) -> Optional[float]:
    """Extract the S-parameter (set-point) from a temperature command."""
    for part in line.split():
        if part.startswith("S"):
            try:
                return float(part[1:])
            except ValueError:
                pass
    return None


def import_gcode(filepath: str) -> Dict[str, Any]:
    """Parse a G-code file and return standardised PCC job parameters.

    Works with output from PrusaSlicer, Cura, Simplify3D, and most
    other common slicers.  Also handles basic CNC G-code (no extrusion).
    """
    path = Path(filepath)
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()

    params: Dict[str, Any] = {
        "type": "fdm",
        "filename": path.name,
        "lineCount": len(lines),
        "estimatedTime": None,
        "material": None,
        "nozzleTemp": None,
        "bedTemp": None,
        "layerHeight": None,
        "filamentUsed": None,
    }

    has_extrusion = False

    for line in lines:
        stripped = line.strip()

        # -- Slicer comment fields ----------------------------------------
        lower = stripped.lower()
        if "; estimated printing time" in lower:
            params["estimatedTime"] = stripped.split("=")[-1].strip()
        elif "; filament_type" in lower:
            params["material"] = stripped.split("=")[-1].strip()
        elif "; layer_height" in lower:
            try:
                params["layerHeight"] = float(stripped.split("=")[-1].strip())
            except ValueError:
                pass
        elif "; filament used" in lower:
            params["filamentUsed"] = stripped.split("=")[-1].strip()

        # -- Temperature commands -----------------------------------------
        if stripped.startswith("M104") or stripped.startswith("M109"):
            temp = _parse_temp(stripped)
            if temp is not None and temp > 0:
                # Keep the highest set-point (ignore S0 shutdown commands)
                if params["nozzleTemp"] is None or temp > params["nozzleTemp"]:
                    params["nozzleTemp"] = temp
        elif stripped.startswith("M140") or stripped.startswith("M190"):
            temp = _parse_temp(stripped)
            if temp is not None and temp > 0:
                if params["bedTemp"] is None or temp > params["bedTemp"]:
                    params["bedTemp"] = temp

        # -- Extrusion detection (FDM vs CNC) -----------------------------
        if stripped.startswith("G1") and "E" in stripped:
            has_extrusion = True

    if not has_extrusion:
        params["type"] = "cnc-3axis"

    return {
        "capabilityType": params["type"],
        "parameters": params,
        "rawFile": str(path),
    }
