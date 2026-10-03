"""Pure validation functions for operating-profile params and envelopes.

check_params: type/shape problems -- is this well-formed input for this op?
check_envelope: bound/enum/count problems -- is this input within the
safety envelope declared for this op?

Both are pure and deterministic: no side effects, and neither ever raises
on bad input -- every problem is reported as a string in the returned
list. An empty list means "no problems found". check_envelope makes no
assumption that check_params has already run; it is safe to call on its
own.
"""

from __future__ import annotations

from typing import Any, List


def check_params(op_spec: Any, params: Any) -> List[str]:
    """Type/shape problems in `params` against `op_spec.params`.

    Returns a list of detail strings; empty means OK. Never raises --
    any unexpected shape is reported as a problem string instead.
    """
    if not isinstance(params, dict):
        return [f"not_a_dict:{type(params).__name__}"]

    problems: List[str] = []
    declared_names = set()

    for spec_field in op_spec.params:
        declared_names.add(spec_field.name)
        if spec_field.name not in params:
            problems.append(f"missing:{spec_field.name}")
            continue

        value = params[spec_field.name]

        if spec_field.kind == "const":
            if not isinstance(value, str) or value != spec_field.literal:
                problems.append(
                    f"{spec_field.name}:expected {spec_field.literal!r}, got {value!r}"
                )
        elif spec_field.kind == "int":
            if isinstance(value, bool) or not isinstance(value, int):
                problems.append(
                    f"{spec_field.name}:expected int, got {type(value).__name__}"
                )
        elif spec_field.kind == "wells":
            problems.extend(_check_wells_shape(spec_field.name, value, spec_field.grid))
        else:
            problems.append(f"{spec_field.name}:unknown_param_kind:{spec_field.kind}")

    extra = sorted(set(params) - declared_names)
    if extra:
        problems.append(f"unexpected_params:{extra}")

    return problems


def _check_wells_shape(name: str, value: Any, grid: Any) -> List[str]:
    """Shape/membership/duplicate checks for the "wells" param kind.

    "all" is always shape-valid. A list must be non-empty, every element
    must be a string present in `grid`, and elements must be pairwise
    distinct. This does NOT check the list's length against any bound --
    that is an envelope concern (see check_envelope's max_wells check).
    """
    problems: List[str] = []

    if value == "all":
        return problems

    if not isinstance(value, list):
        problems.append(f"{name}:expected 'all' or a list, got {type(value).__name__}")
        return problems

    if len(value) == 0:
        problems.append(f"{name}:list must be non-empty")
        return problems

    grid = grid if grid is not None else frozenset()
    seen: set = set()
    bad: list = []
    dupes: set = set()
    for item in value:
        if not isinstance(item, str) or item not in grid:
            bad.append(item)
            continue
        if item in seen:
            dupes.add(item)
        else:
            seen.add(item)

    if bad:
        problems.append(f"{name}:invalid well name(s) {bad!r}")
    if dupes:
        problems.append(f"{name}:duplicate well name(s) {sorted(dupes)!r}")

    return problems


def check_envelope(op_spec: Any, params: Any) -> List[str]:
    """Bound/enum/count problems in `params` against `op_spec.envelope`.

    Assumes nothing about prior checks -- safe to call standalone. Returns
    a list of detail strings; empty means OK. Never raises.
    """
    if not isinstance(params, dict):
        return [f"not_a_dict:{type(params).__name__}"]

    problems: List[str] = []
    envelope = getattr(op_spec, "envelope", None) or {}

    if "wavelengthNm" in params:
        wl = params["wavelengthNm"]
        whitelist = envelope.get("wavelength_whitelist")
        # Only judge the enum if wl is actually an int; a non-int wl is a
        # check_params problem, not ours to report here.
        if whitelist is not None and isinstance(wl, int) and not isinstance(wl, bool):
            if wl not in whitelist:
                problems.append(
                    f"wavelengthNm:{wl} not in whitelist {sorted(whitelist)}"
                )

    if "wells" in params:
        wells = params["wells"]
        max_wells = envelope.get("max_wells")
        if max_wells is not None:
            distinct_count = None
            if wells == "all":
                # "all" is defined as exactly the bound -- never a violation.
                distinct_count = max_wells
            elif isinstance(wells, list):
                try:
                    distinct_count = len(set(wells))
                except TypeError:
                    # Unhashable entries -- fall back to raw length so the
                    # count check still degrades gracefully instead of
                    # raising.
                    distinct_count = len(wells)
            if distinct_count is not None and distinct_count > max_wells:
                problems.append(
                    f"wells:{distinct_count} distinct wells exceeds max {max_wells}"
                )

    return problems
