"""CSV plate-layout importer for liquid-handler workflows.

Expected CSV columns (case-insensitive):
  Well, Volume, Sample, Concentration

Any missing column is silently defaulted.
"""

import csv
from pathlib import Path
from typing import Any, Dict, List


def _get_field(row: Dict[str, str], *names: str) -> str:
    """Return the first matching field value (case-insensitive)."""
    lower_row = {k.lower(): v for k, v in row.items()}
    for name in names:
        val = lower_row.get(name.lower(), "")
        if val:
            return val
    return ""


def import_plate_csv(filepath: str) -> Dict[str, Any]:
    """Import a plate-layout CSV and return PCC job parameters."""
    path = Path(filepath)
    wells: List[Dict[str, Any]] = []

    with open(path, "r", newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            well_id = _get_field(row, "Well", "well")
            vol_str = _get_field(row, "Volume", "volume")
            sample = _get_field(row, "Sample", "sample")
            conc_str = _get_field(row, "Concentration", "concentration")

            try:
                volume = float(vol_str) if vol_str else 0.0
            except ValueError:
                volume = 0.0

            try:
                concentration = float(conc_str) if conc_str else None
            except ValueError:
                concentration = None

            wells.append({
                "well": well_id,
                "volume": volume,
                "sample": sample,
                "concentration": concentration,
            })

    well_count = len(wells)
    if well_count <= 96:
        plate_format = "96-well"
    else:
        plate_format = "384-well"

    return {
        "capabilityType": "liquid-handler",
        "parameters": {
            "filename": path.name,
            "wells": wells,
            "wellCount": well_count,
            "plateFormat": plate_format,
        },
        "rawFile": str(filepath),
    }
