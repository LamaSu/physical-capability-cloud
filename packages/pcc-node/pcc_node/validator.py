"""Job-parameter validator for PCC.

Validates imported job parameters against a machine's declared
capabilities and device manifest.  Returns a result dict with
``valid``, ``errors``, and ``warnings`` fields.
"""

from typing import Any, Dict, List, Optional


def validate_job(
    imported_params: Dict[str, Any],
    device_manifest: Optional[Dict[str, Any]],
    kernel_capabilities: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Validate *imported_params* against *kernel_capabilities*.

    Parameters
    ----------
    imported_params:
        The dict returned by an importer (must contain ``capabilityType``
        and ``parameters``).
    device_manifest:
        Optional device manifest with hardware details.  May be *None*.
    kernel_capabilities:
        A list of capability dicts, each with at least a ``"type"`` key.

    Returns
    -------
    dict
        ``{"valid": bool, "errors": [...], "warnings": [...],
          "capabilityType": str, "parameters": dict}``
    """
    errors: List[str] = []
    warnings: List[str] = []

    cap_type = imported_params.get("capabilityType", "")
    params = imported_params.get("parameters", {})
    needs_slicing = imported_params.get("needsSlicing", False)

    # -- Capability-type match -------------------------------------------
    supported_types = [c.get("type") for c in kernel_capabilities]
    if cap_type not in supported_types:
        errors.append(f"Machine doesn't support {cap_type}")

    # -- Type-specific checks --------------------------------------------
    if cap_type == "fdm":
        _validate_fdm(params, needs_slicing, errors, warnings)
    elif cap_type == "liquid-handler":
        _validate_liquid_handler(params, errors, warnings)
    elif cap_type == "cnc-3axis":
        _validate_cnc(params, needs_slicing, errors, warnings)

    # -- Device-manifest checks ------------------------------------------
    if device_manifest is not None:
        _validate_against_manifest(params, device_manifest, errors, warnings)

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "capabilityType": cap_type,
        "parameters": params,
    }


# -----------------------------------------------------------------------
# Private helpers
# -----------------------------------------------------------------------

def _validate_fdm(
    params: Dict[str, Any],
    needs_slicing: bool,
    errors: List[str],
    warnings: List[str],
) -> None:
    if needs_slicing:
        warnings.append("STL file needs slicing before printing")

    nozzle_temp = params.get("nozzleTemp")
    if nozzle_temp is not None and nozzle_temp > 300:
        warnings.append(
            f"Nozzle temp {nozzle_temp}\u00b0C is very high \u2014 verify material"
        )

    material = (params.get("material") or "").upper()
    if material == "ABS":
        warnings.append("ABS requires enclosure \u2014 verify printer has one")

    bed_temp = params.get("bedTemp")
    if bed_temp is not None and bed_temp > 120:
        warnings.append(
            f"Bed temp {bed_temp}\u00b0C is very high \u2014 verify printer supports it"
        )


def _validate_liquid_handler(
    params: Dict[str, Any],
    errors: List[str],
    warnings: List[str],
) -> None:
    wells = params.get("wells", [])
    if len(wells) > 384:
        errors.append("More than 384 wells \u2014 exceeds plate capacity")

    for well in wells:
        vol = well.get("volume", 0)
        if vol < 0:
            errors.append(f"Negative volume in well {well.get('well', '?')}")
        elif vol > 1000:
            warnings.append(
                f"Well {well.get('well', '?')} volume {vol}\u00b5L exceeds 1000\u00b5L"
            )

    api_level = params.get("apiLevel")
    if api_level is not None:
        try:
            major = int(str(api_level).split(".")[0])
            if major < 2:
                warnings.append(f"API level {api_level} is very old \u2014 may not be supported")
        except (ValueError, IndexError):
            pass


def _validate_cnc(
    params: Dict[str, Any],
    needs_slicing: bool,
    errors: List[str],
    warnings: List[str],
) -> None:
    if needs_slicing:
        errors.append(
            "STL file needs to be sliced/CAM'd before CNC \u2014 provide G-code or toolpath"
        )


def _validate_against_manifest(
    params: Dict[str, Any],
    manifest: Dict[str, Any],
    errors: List[str],
    warnings: List[str],
) -> None:
    """Optional cross-check against a device-manifest dict."""
    max_nozzle = manifest.get("maxNozzleTemp")
    if max_nozzle is not None and params.get("nozzleTemp") is not None:
        if params["nozzleTemp"] > max_nozzle:
            errors.append(
                f"Nozzle temp {params['nozzleTemp']}\u00b0C exceeds device max {max_nozzle}\u00b0C"
            )

    max_bed = manifest.get("maxBedTemp")
    if max_bed is not None and params.get("bedTemp") is not None:
        if params["bedTemp"] > max_bed:
            errors.append(
                f"Bed temp {params['bedTemp']}\u00b0C exceeds device max {max_bed}\u00b0C"
            )
