"""Types for operating profiles.

An OperatingProfile describes one device: its kernel/device identifiers and
the typed operations it exposes. An OperationSpec describes one operation:
its parameter schema, its envelope (the safety bounds checked before any
actuation), and its output shape.

Plain dataclasses only -- no behavior lives here. envelope.py holds the pure
validation logic that reads these structures; loop.py holds the
orchestration that calls it in order.

Note on the module name: inside the package this module is
`pcc_node.operating.profile`, so nothing is shadowed -- it does not collide
with the stdlib `profile` (deterministic profiling) module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, FrozenSet, Optional, Tuple


def well_grid_96() -> FrozenSet[str]:
    """The 96 valid well names for a 96-well plate: rows A-H, columns 1-12."""
    return frozenset(f"{row}{col}" for row in "ABCDEFGH" for col in range(1, 13))


@dataclass(frozen=True)
class ParamField:
    """One parameter's type/shape contract.

    kind:
      "const" -- value must equal `literal` exactly (type + value match).
      "int"   -- value must be an int (bool excluded, since bool is a
                 subclass of int in Python and would otherwise sneak past
                 an isinstance(value, int) check).
      "wells" -- value must be the literal "all", or a non-empty list of
                 distinct, valid well names drawn from `grid`.
    """

    name: str
    kind: str
    literal: Any = None
    grid: Optional[FrozenSet[str]] = None


@dataclass(frozen=True)
class OperationSpec:
    """A single operation's param schema, envelope bounds, and output shape."""

    name: str
    params: Tuple[ParamField, ...]
    envelope: dict
    output_shape: dict


@dataclass(frozen=True)
class OperatingProfile:
    """A device's kernel/device identity plus the operations it exposes."""

    kernel_id: str
    device_id: str
    operations: dict = field(default_factory=dict)  # name -> OperationSpec


def build_r0_plate_reader_profile(
    *, kernel_id: str = "r0-plate-reader", device_id: str = "r0-device-1"
) -> OperatingProfile:
    """The R0 plate reader profile: one read-only operation, runPlate.

    params: plateFormat must equal "96-well"; wavelengthNm must be an int
    (checked against the {405,450,600} whitelist in the envelope -- see
    envelope.py -- not here); wells must be "all" or a non-empty list of
    distinct, valid 96-well names (A1..H12).

    envelope: the wavelength whitelist, a cap of 96 distinct wells, and
    actuates=False (this operation is read-only -- it declares no
    actuation).
    """
    grid = well_grid_96()
    op = OperationSpec(
        name="runPlate",
        params=(
            ParamField(name="plateFormat", kind="const", literal="96-well"),
            ParamField(name="wavelengthNm", kind="int"),
            ParamField(name="wells", kind="wells", grid=grid),
        ),
        envelope={
            "wavelength_whitelist": frozenset({405, 450, 600}),
            "max_wells": 96,
            "actuates": False,
        },
        output_shape={"readings": "dict[str, float]"},
    )
    return OperatingProfile(
        kernel_id=kernel_id,
        device_id=device_id,
        operations={"runPlate": op},
    )
