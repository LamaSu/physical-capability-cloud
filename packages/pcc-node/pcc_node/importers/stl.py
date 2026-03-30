"""STL mesh file importer.

Reads the 80-byte header and triangle count from binary STL files.
Also detects ASCII STL ("solid ..." header).
"""

import os
from pathlib import Path
from typing import Any, Dict


def import_stl(filepath: str) -> Dict[str, Any]:
    """Parse an STL file header and return PCC job parameters.

    The returned result includes ``needsSlicing: True`` because an STL
    mesh must be sliced into G-code before it can be printed.
    """
    path = Path(filepath)
    file_size = os.path.getsize(filepath)

    with open(filepath, "rb") as fh:
        header = fh.read(80)
        raw_count = fh.read(4)

    # A binary STL stores the triangle count as a uint32 at offset 80.
    # ASCII STL files start with "solid " but can be misdetected when a
    # binary header happens to begin with the same bytes.  A simple
    # heuristic: if the expected binary file size matches
    # 84 + (triangle_count * 50) then treat it as binary.
    triangle_count = int.from_bytes(raw_count, "little") if len(raw_count) == 4 else 0
    expected_binary_size = 84 + triangle_count * 50

    is_ascii = header.lstrip(b"\x00").startswith(b"solid") and expected_binary_size != file_size

    return {
        "capabilityType": "fdm",
        "parameters": {
            "filename": path.name,
            "format": "ascii" if is_ascii else "binary",
            "triangleCount": triangle_count,
            "fileSizeBytes": file_size,
        },
        "rawFile": str(filepath),
        "needsSlicing": True,
    }
