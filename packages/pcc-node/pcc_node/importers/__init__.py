"""Importer registry for PCC job file formats.

Auto-detects file type by extension and translates into standardized
PCC job parameters.  All importers use only the Python stdlib -- no
numpy, no pandas.

Supported formats:
  .gcode / .gco / .nc / .ngc  -- G-code (FDM / CNC)
  .py                          -- Opentrons Python protocols
  .stl                         -- STL mesh (needs slicing)
  .csv                         -- CSV plate layout (liquid handler)
"""

from pathlib import Path
from typing import Any, Callable, Dict, List

# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

IMPORTERS: Dict[str, Callable[[str], Dict[str, Any]]] = {}


def register(extension: str, importer_fn: Callable[[str], Dict[str, Any]]) -> None:
    """Register *importer_fn* for the given file *extension* (e.g. ".gcode")."""
    IMPORTERS[extension.lower()] = importer_fn


def detect_and_import(filepath: str) -> Dict[str, Any]:
    """Auto-detect file type by extension and import job parameters.

    Raises ``ValueError`` when no importer is registered for the extension.
    """
    ext = Path(filepath).suffix.lower()
    if ext in IMPORTERS:
        return IMPORTERS[ext](filepath)
    raise ValueError(f"No importer for {ext}")


def list_supported() -> List[str]:
    """Return a sorted list of registered file extensions."""
    return sorted(IMPORTERS.keys())


# ---------------------------------------------------------------------------
# Register built-in importers on first import
# ---------------------------------------------------------------------------

from .gcode import import_gcode  # noqa: E402
from .opentrons_protocol import import_opentrons_protocol  # noqa: E402
from .stl import import_stl  # noqa: E402
from .csv_plate import import_plate_csv  # noqa: E402

register(".gcode", import_gcode)
register(".gco", import_gcode)
register(".nc", import_gcode)
register(".ngc", import_gcode)
register(".py", import_opentrons_protocol)
register(".stl", import_stl)
register(".csv", import_plate_csv)
