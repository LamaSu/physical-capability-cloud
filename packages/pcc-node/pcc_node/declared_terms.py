"""The terms an operator DECLARED for a device's capabilities (board N23, #3560).

The gateway registers a capability that a heartbeat announces only with
declared, well-formed terms (#437: ``declaredTiers`` and ``declaredPricing``
in packages/gateway/src/facades/kernel.facade.ts).  An announcement without
terms is skipped and reported in the heartbeat answer's
``capabilitiesSkipped``.  It is never completed with invented values.  This
node follows the same rule from its own side:

* terms come ONLY from the operator's local device config, a NodeConfig
  device entry's ``assuranceTiers`` and ``pricing``.  Discovery never writes
  them, a job never supplies them, and nothing defaults them;
* they are checked with the gateway's exact rules (:func:`declared_tiers`,
  :func:`declared_pricing`, same reason codes) when the config loads, and a
  malformed declaration is an error naming the device and the field
  (:func:`validate_device_terms`), never skipped silently.  The node is
  stricter than the gateway in two places: a pricing key the gateway would
  drop without a word (a typo such as ``perGrams``) is an error, and so is
  a device that declares tiers without pricing, or pricing without tiers;
* a device that declares nothing announces nothing, and
  :func:`announcement_plan` says so, so the log and ``pcc-node status``
  can name it;
* a capability type is announced only when this node can execute it on
  that device.  :func:`announceable_types` inverts the job executor's own
  routing map, so no type is offered that a job could not be routed to.
"""

import re
from typing import Any, Dict, List, Optional, Tuple

from .job_executor import CAPABILITY_PROTOCOL_MAP

# #437 kernel.facade.ts: ASSURANCE_TIERS, MAX_DECLARED_TIERS, DECLARED_DECIMAL,
# DECLARED_CURRENCY and PRICE_COMPONENTS.  Matched with fullmatch: a JS regex
# anchored with ^...$ (no m flag) does not accept a trailing newline, and a
# Python $ would.
ASSURANCE_TIERS = frozenset({0, 1, 2, 3})
MAX_DECLARED_TIERS = 16
DECLARED_DECIMAL = re.compile(r"[0-9]{1,30}(\.[0-9]{1,30})?")
DECLARED_CURRENCY = re.compile(r"[A-Za-z0-9]{1,16}")
PRICE_COMPONENTS = ("baseCost", "minimum", "perMinute", "perGram", "perCm3")
REQUIRED_PRICE_COMPONENTS = ("baseCost", "minimum")
PRICING_KEYS = ("currency",) + PRICE_COMPONENTS

# The gateway's HeartbeatSkipReason values, reused so a node log line and a
# gateway answer name a problem the same way.
NO_DECLARED_TIERS = "no-declared-tiers"
INVALID_TIERS = "invalid-tiers"
NO_DECLARED_PRICING = "no-declared-pricing"
INVALID_PRICING = "invalid-pricing"
ZERO_PRICE = "zero-price"


class DeclaredTermsError(ValueError):
    """A device's declared terms cannot be announced; the message names the
    device and the field."""


def declared_tiers(value: Any) -> Tuple[Optional[List[int]], Optional[str]]:
    """``(tiers, None)`` as a sorted set of integers 0..3, or ``(None, reason)``.

    #437 ``declaredTiers``: absent (None) is ``no-declared-tiers``; not a
    non-empty list of at most 16 entries, or any entry that is not a number
    in 0..3, is ``invalid-tiers``.  JS reads 1.0 as the number 1, so an
    integral float counts as its integer.  A bool is not a number in JS
    (``typeof true``) and is refused here too.
    """
    if value is None:
        return None, NO_DECLARED_TIERS
    if not isinstance(value, list) or not value or len(value) > MAX_DECLARED_TIERS:
        return None, INVALID_TIERS
    tiers = set()
    for tier in value:
        if isinstance(tier, bool) or not isinstance(tier, (int, float)) or tier not in ASSURANCE_TIERS:
            return None, INVALID_TIERS
        tiers.add(int(tier))
    return sorted(tiers), None


def declared_pricing(value: Any) -> Tuple[Optional[Dict[str, str]], Optional[str]]:
    """``(pricing, None)`` exactly as declared, or ``(None, reason)``.

    #437 ``declaredPricing``: absent (None) is ``no-declared-pricing``.  Not an
    object, a currency outside ``[A-Za-z0-9]{1,16}``, a missing ``baseCost``
    or ``minimum``, or any present component that is not a plain decimal
    string (no sign, exponent or trailing dot) is ``invalid-pricing``.
    Every component zero is ``zero-price``: "USDC 0" is not a price.  Only
    the known components are kept, as the gateway keeps them.
    """
    if value is None:
        return None, NO_DECLARED_PRICING
    if not isinstance(value, dict):
        return None, INVALID_PRICING
    currency = value.get("currency")
    if not isinstance(currency, str) or not DECLARED_CURRENCY.fullmatch(currency):
        return None, INVALID_PRICING
    if any(key not in value for key in REQUIRED_PRICE_COMPONENTS):
        return None, INVALID_PRICING
    pricing = {"currency": currency}
    non_zero = False
    for key in PRICE_COMPONENTS:
        if key not in value:
            continue
        amount = value[key]
        if not isinstance(amount, str) or not DECLARED_DECIMAL.fullmatch(amount):
            return None, INVALID_PRICING
        pricing[key] = amount
        if re.search(r"[1-9]", amount):
            non_zero = True
    if not non_zero:
        return None, ZERO_PRICE
    return pricing, None


def device_label(device: Dict[str, Any]) -> str:
    """How a device is named in errors and status: its id, host or ip."""
    return str(device.get("id") or device.get("host") or device.get("ip") or device.get("name") or "?")


def device_protocol(device: Dict[str, Any]) -> str:
    """The protocol key the job executor routes by (JobExecutor.__init__)."""
    return device.get("protocol") or device.get("type") or "generic"


def announceable_types(device: Dict[str, Any]) -> List[str]:
    """The capability types the job executor can route to this device.

    The inverse of CAPABILITY_PROTOCOL_MAP for the device's protocol, so a
    type is only ever offered when a job of that type would be routed to a
    device like this one.  A protocol the executor maps no type to (a
    camera, a serial port) offers nothing.
    """
    protocol = device_protocol(device)
    return sorted(cap for cap, protocols in CAPABILITY_PROTOCOL_MAP.items() if protocol in protocols)


def validate_device_terms(device: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The device's declared terms, ``{"assuranceTiers", "pricing"}``, or None.

    None means the device declares no terms at all; it then announces
    nothing.  Raises DeclaredTermsError, naming the device and the field,
    for a declaration the gateway would skip or silently trim: invalid
    tiers or pricing, a zero price, an unknown pricing key, or only one of
    the two fields.
    """
    label = device_label(device)
    has_tiers = device.get("assuranceTiers") is not None
    has_pricing = device.get("pricing") is not None
    if not has_tiers and not has_pricing:
        return None
    if not has_pricing:
        raise DeclaredTermsError(
            f"device {label!r} declares assuranceTiers but no pricing; declare both, or neither"
        )
    if not has_tiers:
        raise DeclaredTermsError(
            f"device {label!r} declares pricing but no assuranceTiers; declare both, or neither"
        )
    tiers, reason = declared_tiers(device["assuranceTiers"])
    if tiers is None:
        raise DeclaredTermsError(
            f"device {label!r} assuranceTiers: {reason} (a non-empty list of at most "
            f"{MAX_DECLARED_TIERS} tiers, each 0, 1, 2 or 3)"
        )
    raw_pricing = device["pricing"]
    if isinstance(raw_pricing, dict):
        unknown = sorted(str(key) for key in raw_pricing if key not in PRICING_KEYS)
        if unknown:
            raise DeclaredTermsError(
                f"device {label!r} pricing has unknown key(s) {', '.join(unknown)} "
                f"(known: {', '.join(PRICING_KEYS)}); the gateway would drop them"
            )
    pricing, reason = declared_pricing(raw_pricing)
    if pricing is None:
        raise DeclaredTermsError(
            f"device {label!r} pricing: {reason} (currency [A-Za-z0-9]{{1,16}}; baseCost and "
            f"minimum required; every amount a plain decimal string such as \"12.50\"; "
            f"at least one amount above zero)"
        )
    return {"assuranceTiers": tiers, "pricing": pricing}


def announcement_plan(devices: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, str]]]:
    """``(capabilities, not_announced)`` for a heartbeat.

    ``capabilities``: one ``{"type", "assuranceTiers", "pricing"}`` per type,
    sorted by type, for every type a device with declared terms can execute.
    ``not_announced``: ``{"device", "reason"}`` for every device that
    offers nothing, and why.

    Raises DeclaredTermsError when a device's declaration is malformed, or
    when two devices offer the same type under different terms: the gateway
    keeps one row per kernel and type, so which terms won would depend on
    announcement order.
    """
    by_type: Dict[str, Tuple[str, Dict[str, Any]]] = {}
    not_announced: List[Dict[str, str]] = []
    for device in devices:
        label = device_label(device)
        terms = validate_device_terms(device)
        types = announceable_types(device)
        if not types:
            not_announced.append({
                "device": label,
                "reason": f"this node executes no capability on protocol {device_protocol(device)!r}",
            })
            continue
        if terms is None:
            not_announced.append({
                "device": label,
                "reason": "no declared terms: add assuranceTiers and pricing to this device in the node config",
            })
            continue
        for cap_type in types:
            if cap_type in by_type:
                other_label, other_terms = by_type[cap_type]
                if other_terms != terms:
                    raise DeclaredTermsError(
                        f"devices {other_label!r} and {label!r} both offer {cap_type!r} under different "
                        "terms; the gateway keeps one set per kernel and type, so declare the same terms"
                    )
                continue
            by_type[cap_type] = (label, terms)
    capabilities = [
        {"type": cap_type, "assuranceTiers": list(terms["assuranceTiers"]), "pricing": dict(terms["pricing"])}
        for cap_type, (_, terms) in sorted(by_type.items())
    ]
    return capabilities, not_announced


def skipped_by_gateway(answer: Any) -> List[Dict[str, str]]:
    """The heartbeat answer's ``capabilitiesSkipped``: ``[{"type", "reason"}]``.

    Anything unreadable in the answer yields no entries; a well-formed entry
    is kept with string fields only.
    """
    if not isinstance(answer, dict):
        return []
    skipped = answer.get("capabilitiesSkipped")
    if not isinstance(skipped, list):
        return []
    return [
        {"type": entry["type"], "reason": entry["reason"]}
        for entry in skipped
        if isinstance(entry, dict) and isinstance(entry.get("type"), str) and isinstance(entry.get("reason"), str)
    ]
