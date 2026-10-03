"""PLR backend factory.

Maps PCC's ``plrBackend`` string to a concrete PLR Machine instance, holding
exclusive access while the adapter session is active.

Phase 1 supports two backends:
  - ``chatterbox`` — PLR's ``LiquidHandlerChatterboxBackend`` (in-memory digital
    twin; part of core pylabrobot)
  - ``ot2`` — Opentrons OT-2 via PLR's ``OpentronsOT2Backend`` (requires the
    ``pylabrobot[opentrons]`` extra)

Both PLR backends need a declared deck: ``backendConfig.deckLayout`` (a
serialized PLR deck, as produced by ``deck.serialize()``) or
``backendConfig.deckLayoutPath`` (a JSON file holding one). Without a layout the
backend refuses to load, because an empty deck cannot run a protocol (status
board row R39). The layout is data, and it is checked as data BEFORE PLR builds
anything from it (:func:`checked_layout`):

- the root must be the expected deck type, and every typed object in the tree
  must be one of ``LAYOUT_TYPES``;
- serialized functions are stripped, never deserialized, and it is then loaded
  with ``Resource.deserialize(..., allow_marshal=False)`` on both paths;
- size, depth, key and number limits apply, and every labware placed on the deck
  must lie inside it without overlapping another.

``deckLayoutPath`` is operator configuration, never job input, and it must name
a ``.json`` file inside ``PCC_PLR_LAYOUT_DIR``.

PLR's tip and volume tracking are switched on for every PLR backend, so a missing
tip, a well without enough liquid or an overfilled well fails inside PLR before
it becomes a physical action. ``backendConfig.initialLiquids`` declares what the
operator loaded (``{"src": {"A1": 200}}``, in uL). On the simulator, tracking can
be switched off explicitly with ``backendConfig.tracking``; on hardware it can't.

Each backend is loaded lazily via inline imports so an operator can install
just the extras they need (``pip install pcc-plr-sidecar[ot2]``).

A small ``stub`` backend exists for tests. It is used only when ``plrBackend``
is ``"stub"``, never as a fallback, and every result it gives says
``executionMode: "stub"``.
"""

from __future__ import annotations
import json
import logging
import math
import os
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger("pcc_plr_sidecar.backend_loader")

# R39 CRIT1: the backend NAME never establishes physical execution. "simulated"
# covers chatterbox and every known simulator backend. Every hardware-capable
# backend (ot2, and any future one) is "unverified" — never "hardware" — until a
# hardware-identity provenance check exists (D1, queue item 19, out of scope
# here). ``.get(..., "unverified")`` in :meth:`BackendLoader.load` is the same
# fail-safe default: a backend added to ``_create_machine`` without an entry
# here is "unverified", never a silent ``None`` that could read as "hardware".
EXECUTION_MODES = {"chatterbox": "simulated", "chatter": "simulated", "ot2": "unverified", "stub": "stub"}
DEFAULT_MAX_VOLUME_UL = 1000.0  # the OT-2's largest pipette; backendConfig.maxVolumeUL may lower it

# Every object with a "type" in a deck layout must be one of these PLR resource
# (or geometry) classes. Anything else, including a serialized function, never
# reaches PLR's deserializer. Written from PLR's resource class names; the
# genuine-library test (test_plr_real.py) checks it once operator decision D1
# allows installing pylabrobot.
LAYOUT_TYPES = frozenset({
    "Deck", "OTDeck", "Resource", "Container", "Well", "Plate", "Lid", "TipRack", "TipSpot",
    "Tip", "HamiltonTip", "Trash", "Tube", "TubeRack", "Trough", "ResourceHolder",
    "ResourceStack", "PlateAdapter", "Coordinate", "Rotation",
})
MAX_LAYOUT_BYTES = 5 * 1024 * 1024
MAX_LAYOUT_DEPTH = 32
MAX_LAYOUT_NODES = 100_000
MAX_LAYOUT_STRING = 4096
_GEOMETRY_TOLERANCE_MM = 0.5


@dataclass
class BackendHandle:
    """A loaded backend instance + associated PLR objects.

    ``machine`` is a PLR ``LiquidHandler`` / ``PlateReader`` / ``Centrifuge``
    / etc. (depends on the backend). ``setup_done`` flips True after the
    backend's async ``setup()`` returns.
    """

    plr_backend: str
    device_id: str
    machine: Any
    backend_config: dict[str, Any] = field(default_factory=dict)
    setup_done: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    # "simulated" (PLR's chatterbox), "unverified" (ot2 or any other
    # hardware-capable backend — R39 CRIT1: never "hardware" without a
    # hardware-identity provenance check) or "stub". Every run result and
    # every evidence record carries it.
    execution_mode: str = "stub"
    # The largest volume one aspirate or dispense may move, in uL.
    max_volume_ul: float = DEFAULT_MAX_VOLUME_UL


class BackendLoader:
    """Per-deviceId registry of loaded backends.

    The same sidecar process can hold multiple devices (e.g. STAR + HHS +
    iSWAP on one operator deck) — each gets its own handle by ``deviceId``.
    """

    def __init__(self) -> None:
        self._handles: dict[str, BackendHandle] = {}

    def has(self, device_id: str) -> bool:
        return device_id in self._handles

    def get(self, device_id: str) -> BackendHandle:
        h = self._handles.get(device_id)
        if h is None:
            raise KeyError(f"unknown deviceId: {device_id}")
        return h

    def list(self) -> list[BackendHandle]:
        return list(self._handles.values())

    async def load(
        self,
        plr_backend: str,
        device_id: str,
        backend_config: dict[str, Any],
    ) -> BackendHandle:
        """Instantiate the backend + return a handle. Idempotent per deviceId."""
        if device_id in self._handles:
            existing = self._handles[device_id]
            if existing.plr_backend != plr_backend:
                raise ValueError(
                    f"deviceId {device_id} already registered as {existing.plr_backend}; "
                    f"requested {plr_backend}",
                )
            return existing

        log.info("loading backend %s for device %s", plr_backend, device_id)
        mode = EXECUTION_MODES.get(plr_backend.strip().lower(), "unverified")
        machine, metadata = await _create_machine(plr_backend, backend_config)
        handle = BackendHandle(
            plr_backend=plr_backend,
            device_id=device_id,
            machine=machine,
            backend_config=dict(backend_config),
            metadata={"loaded_via": "BackendLoader.load", "executionMode": mode, **metadata},
            execution_mode=mode,
            max_volume_ul=_max_volume(backend_config),
        )
        self._handles[device_id] = handle
        return handle

    async def unload(self, device_id: str) -> None:
        h = self._handles.pop(device_id, None)
        if h is None:
            return
        # PLR backends typically expose .stop() (async). Stub doesn't.
        stop_fn = getattr(h.machine, "stop", None)
        if stop_fn:
            try:
                result = stop_fn()
                if hasattr(result, "__await__"):
                    await result
            except Exception as e:  # noqa: BLE001
                log.warning("backend.stop raised on unload: %s", e)


# ── private — backend instantiation ────────────────────────────────────────

async def _create_machine(plr_backend: str, config: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    """Dispatch on ``plr_backend`` to a concrete PLR Machine constructor.

    Returns the machine and what the loader learned while building it (for the
    handle's metadata). Imports are inline + per-branch so the operator only
    needs the vendor extras they actually use.
    """
    plr_backend = plr_backend.strip().lower()

    if plr_backend in ("chatterbox", "chatter"):
        return _create_chatterbox(config)

    if plr_backend == "stub":
        return _create_stub(config), {}

    if plr_backend == "ot2":
        return await _create_ot2(config)

    raise ValueError(
        f"unknown plrBackend: {plr_backend!r}. Phase 1 supports: chatterbox, ot2, stub",
    )


def _max_volume(config: dict[str, Any]) -> float:
    value = config.get("maxVolumeUL", DEFAULT_MAX_VOLUME_UL)
    if (
        isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
        or not 0 < value <= DEFAULT_MAX_VOLUME_UL
    ):
        raise ValueError(f"backendConfig.maxVolumeUL must be a number in (0, {DEFAULT_MAX_VOLUME_UL:g}] uL")
    return float(value)


def _read_layout_file(path: Any) -> Any:
    """Read ``deckLayoutPath``: a .json file inside PCC_PLR_LAYOUT_DIR, at most 5 MB."""
    if not isinstance(path, str) or not path:
        raise ValueError("deckLayoutPath must be a non-empty string")
    root = os.environ.get("PCC_PLR_LAYOUT_DIR")
    if not root:
        raise ValueError(
            "deckLayoutPath needs PCC_PLR_LAYOUT_DIR, the directory the operator keeps deck layouts in",
        )
    base = os.path.realpath(root)
    real = os.path.realpath(path if os.path.isabs(path) else os.path.join(base, path))
    if os.path.commonpath([base, real]) != base:
        raise ValueError("deckLayoutPath must name a file inside PCC_PLR_LAYOUT_DIR")
    if not real.endswith(".json") or not os.path.isfile(real):
        raise ValueError("deckLayoutPath must name an existing .json file")
    with open(real, "rb") as f:
        raw = f.read(MAX_LAYOUT_BYTES + 1)
    if len(raw) > MAX_LAYOUT_BYTES:
        raise ValueError(f"deck layout file is larger than {MAX_LAYOUT_BYTES} bytes")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise ValueError(f"deck layout file is not JSON: {e}") from e


def checked_layout(layout: Any, root_types: frozenset) -> tuple[dict[str, Any], int]:
    """Check a serialized deck as data before anything is built from it.

    Returns a cleaned copy and the number of serialized functions stripped from it
    (a function is code, so it is replaced by None and never deserialized).
    Raises ValueError for anything outside the rules in the module docstring.
    """
    if not isinstance(layout, dict) or layout.get("type") not in root_types:
        found = layout.get("type") if isinstance(layout, dict) else type(layout).__name__
        raise ValueError(f"deck layout is a {found!r}, expected {' or '.join(sorted(root_types))}")
    counts = {"nodes": 0, "stripped": 0}

    def walk(value: Any, depth: int) -> Any:
        counts["nodes"] += 1
        if counts["nodes"] > MAX_LAYOUT_NODES:
            raise ValueError(f"deck layout has more than {MAX_LAYOUT_NODES} values")
        if depth > MAX_LAYOUT_DEPTH:
            raise ValueError(f"deck layout is nested deeper than {MAX_LAYOUT_DEPTH} levels")
        if isinstance(value, dict):
            if value.get("type") == "function":
                counts["stripped"] += 1
                return None
            if "type" in value and value["type"] not in LAYOUT_TYPES:
                raise ValueError(f"deck layout holds a {value['type']!r}, which is not an allowed resource type")
            cleaned = {}
            for key, item in value.items():
                if not isinstance(key, str) or key.startswith("__"):
                    raise ValueError(f"deck layout key {key!r} is not allowed")
                cleaned[key] = walk(item, depth + 1)
            return cleaned
        if isinstance(value, list):
            return [walk(item, depth + 1) for item in value]
        if isinstance(value, str):
            if len(value) > MAX_LAYOUT_STRING:
                raise ValueError(f"deck layout holds a string longer than {MAX_LAYOUT_STRING} characters")
            return value
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("deck layout holds a non-finite number")
        if value is None or isinstance(value, (bool, int, float)):
            return value
        raise ValueError(f"deck layout holds a {type(value).__name__}, which is not JSON data")

    cleaned = walk(layout, 0)
    _check_deck_geometry(cleaned)
    return cleaned, counts["stripped"]


def _box(resource: dict[str, Any], what: str) -> tuple[float, float, float]:
    dims = []
    for axis in ("size_x", "size_y", "size_z"):
        v = resource.get(axis)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not v > 0:
            raise ValueError(f"{what} needs a positive {axis} to be placed on the deck")
        dims.append(float(v))
    return dims[0], dims[1], dims[2]


def _check_deck_geometry(deck: dict[str, Any]) -> None:
    """Every labware on the deck lies inside it, and no two overlap."""
    deck_x, deck_y, _ = _box(deck, "the deck")
    tol = _GEOMETRY_TOLERANCE_MM
    placed: list[tuple[str, tuple[float, ...]]] = []
    for child in deck.get("children") or []:
        if child is None:
            continue
        if not isinstance(child, dict):
            raise ValueError("every deck child must be a serialized resource")
        name = child.get("name") if isinstance(child.get("name"), str) else "a deck child"
        loc = child.get("location")
        if not isinstance(loc, dict) or not all(
            isinstance(loc.get(a), (int, float)) and not isinstance(loc.get(a), bool) for a in ("x", "y", "z")
        ):
            raise ValueError(f"{name} needs a location with numeric x, y and z")
        sx, sy, sz = _box(child, name)
        x, y, z = float(loc["x"]), float(loc["y"]), float(loc["z"])
        if x < -tol or y < -tol or x + sx > deck_x + tol or y + sy > deck_y + tol:
            raise ValueError(f"{name} does not fit on the deck")
        box = (x, x + sx, y, y + sy, z, z + sz)
        for other, obox in placed:
            if all(box[2 * i] < obox[2 * i + 1] - tol and obox[2 * i] < box[2 * i + 1] - tol for i in range(3)):
                raise ValueError(f"{name} overlaps {other} on the deck")
        placed.append((name, box))


def _load_deck(config: dict[str, Any], expected_cls: type, root_types: frozenset) -> tuple[Any, int]:
    """Load the declared deck (R39). Raises ValueError, never returns an empty deck.

    ``deckLayout`` is a serialized PLR resource tree; ``deckLayoutPath`` names a
    JSON file holding one. Both go through :func:`checked_layout` and then the
    same ``Resource.deserialize(..., allow_marshal=False)``. PLR's loader resolves
    each child by ``type`` and assigns it to its parent, so the loaded deck is the
    populated deck. Returns the deck and the number of functions stripped.
    """
    from pylabrobot.resources import Resource

    layout = config.get("deckLayout")
    path = config.get("deckLayoutPath")
    if layout is not None and path is not None:
        raise ValueError("backendConfig takes deckLayout or deckLayoutPath, not both")
    if layout is None and path is None:
        raise ValueError(
            "backendConfig.deckLayout (a serialized PLR deck) or deckLayoutPath is required: "
            "an empty deck cannot run a protocol",
        )
    if layout is not None and not isinstance(layout, dict):
        raise ValueError("deckLayout must be a serialized PLR resource object")
    data = layout if layout is not None else _read_layout_file(path)
    cleaned, stripped = checked_layout(data, root_types)
    try:
        # allow_marshal stays False: a layout is data and can never carry code.
        deck = Resource.deserialize(cleaned, allow_marshal=False)
    except Exception as e:  # noqa: BLE001 — any loader failure is an invalid layout
        raise ValueError(f"invalid deck layout: {type(e).__name__}: {e}") from e
    if not isinstance(deck, expected_cls):
        raise ValueError(
            f"deck layout loaded as {type(deck).__name__}, expected {expected_cls.__name__}",
        )
    return deck, stripped


def _configure_tracking(config: dict[str, Any], hardware: bool) -> dict[str, bool]:
    """Switch on PLR's tip and volume tracking (process-wide; one sidecar per device).

    On hardware both are required. On the simulator either may be switched off
    explicitly with ``backendConfig.tracking = {"tips": false}`` and the like.
    """
    from pylabrobot.resources import set_tip_tracking, set_volume_tracking

    requested = config.get("tracking") or {}
    if not isinstance(requested, dict) or set(requested) - {"tips", "volume"} or not all(
        isinstance(v, bool) for v in requested.values()
    ):
        raise ValueError('backendConfig.tracking must look like {"tips": true, "volume": true}')
    tracking = {"tips": requested.get("tips", True), "volume": requested.get("volume", True)}
    if hardware and not all(tracking.values()):
        raise ValueError("tip and volume tracking cannot be switched off on a hardware backend")
    set_tip_tracking(tracking["tips"])
    set_volume_tracking(tracking["volume"])
    return tracking


def _declare_liquids(deck: Any, config: dict[str, Any]) -> int:
    """Apply ``backendConfig.initialLiquids``: {resource: {well: uL}}, what the operator loaded."""
    declared = config.get("initialLiquids") or {}
    if not isinstance(declared, dict):
        raise ValueError("backendConfig.initialLiquids must map a resource to {well: uL}")
    count = 0
    for resource_name, wells in declared.items():
        if not isinstance(wells, dict):
            raise ValueError(f"initialLiquids[{resource_name!r}] must map a well to uL")
        try:
            resource = deck.get_resource(resource_name)
        except Exception as e:  # noqa: BLE001 — a missing resource is an invalid declaration
            raise ValueError(f"initialLiquids names {resource_name!r}, which is not on the deck") from e
        for well_name, volume in wells.items():
            if isinstance(volume, bool) or not isinstance(volume, (int, float)) or not math.isfinite(volume) or volume < 0:
                raise ValueError(f"initialLiquids[{resource_name!r}][{well_name!r}] must be a finite volume >= 0")
            try:
                items = resource[well_name]
            except Exception as e:  # noqa: BLE001
                raise ValueError(f"initialLiquids names {well_name!r}, which is not in {resource_name!r}") from e
            items = items if isinstance(items, list) else [items]
            if len(items) != 1 or getattr(items[0], "tracker", None) is None:
                raise ValueError(f"initialLiquids[{resource_name!r}][{well_name!r}] is not one well")
            items[0].tracker.set_liquids([(None, float(volume))])
            count += 1
    return count


def _create_chatterbox(config: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    """PLR's ``LiquidHandlerChatterboxBackend`` over the declared deck.

    ``ChatterboxBackend`` does not exist in pylabrobot 0.2.2, and
    ``ChatterBoxBackend`` raises NotImplementedError there (deprecated), so the
    only correct class is ``LiquidHandlerChatterboxBackend``.
    """
    from pylabrobot.liquid_handling import LiquidHandler
    from pylabrobot.liquid_handling.backends import LiquidHandlerChatterboxBackend
    from pylabrobot.resources import Deck

    num_channels = config.get("numChannels", 8)
    if not isinstance(num_channels, int) or isinstance(num_channels, bool) or not 1 <= num_channels <= 96:
        raise ValueError("backendConfig.numChannels must be an integer from 1 to 96")
    _max_volume(config)
    tracking = _configure_tracking(config, hardware=False)
    deck, stripped = _load_deck(config, Deck, frozenset({"Deck", "OTDeck"}))
    liquids = _declare_liquids(deck, config)
    machine = LiquidHandler(backend=LiquidHandlerChatterboxBackend(num_channels=num_channels), deck=deck)
    return machine, {"tracking": tracking, "strippedFunctions": stripped, "declaredWells": liquids}


def _parse_ot2_url(url: str) -> tuple[str, int]:
    """``http://10.0.0.5:31950`` or ``10.0.0.5`` -> (host, port)."""
    from urllib.parse import urlparse

    parsed = urlparse(url if "://" in url else f"http://{url}")
    host = parsed.hostname
    if not host:
        raise ValueError(f"ot2Url has no host: {url!r}")
    try:
        port = parsed.port or 31950
    except ValueError as e:
        raise ValueError(f"ot2Url has an invalid port: {url!r}") from e
    return host, port


async def _create_ot2(config: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    """Opentrons OT-2 via PLR's ``OpentronsOT2Backend(host, port)``.

    Requires ``ot2Url`` (for example ``http://192.168.1.50:31950``) and a
    declared ``OTDeck`` layout. ``OpentronsBackend`` does not exist in
    pylabrobot 0.2.2, and the backend takes no API key.
    """
    from pylabrobot.liquid_handling import LiquidHandler
    from pylabrobot.liquid_handling.backends import OpentronsOT2Backend
    from pylabrobot.resources.opentrons import OTDeck

    ot2_url = config.get("ot2Url") or config.get("host") or config.get("url")
    if not ot2_url or not isinstance(ot2_url, str):
        raise ValueError(
            "OT-2 backendConfig must include 'ot2Url' (e.g. 'http://192.168.1.50:31950')",
        )
    if config.get("ot2ApiKey") or config.get("apiKey"):
        log.warning("ot2ApiKey is not used: OpentronsOT2Backend takes no API key")
    host, port = _parse_ot2_url(ot2_url)
    _max_volume(config)
    tracking = _configure_tracking(config, hardware=True)
    deck, stripped = _load_deck(config, OTDeck, frozenset({"OTDeck"}))
    liquids = _declare_liquids(deck, config)
    machine = LiquidHandler(backend=OpentronsOT2Backend(host=host, port=port), deck=deck)
    return machine, {"tracking": tracking, "strippedFunctions": stripped, "declaredWells": liquids}


def is_stub_machine(machine: Any) -> bool:
    """True for the no-PLR stub; everything else is a PLR LiquidHandler."""
    return isinstance(machine, _StubMachine)


def _create_stub(config: dict[str, Any]) -> "_StubMachine":
    """Pure-Python no-PLR-required stub for environments without pylabrobot."""
    return _StubMachine(config=config)


class _StubMachine:
    """A fake PLR Machine — same surface, synthetic behavior.

    Used only when ``plrBackend`` is ``"stub"`` (tests that don't want a
    pylabrobot dependency). Nothing falls back to it: a missing pylabrobot fails
    ``backend.init``.
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config
        self.setup_done = False
        self.last_protocol: dict[str, Any] | None = None
        self.op_log: list[dict[str, Any]] = []

    async def setup(self) -> dict[str, Any]:
        self.setup_done = True
        return {"stub": True, "deckSlots": int(self.config.get("deckSlots", 11))}

    async def stop(self) -> None:
        self.setup_done = False

    async def run_protocol(self, payload: Any) -> dict[str, Any]:
        """Synthesize a protocol run. Counts ops; emits no real hardware calls."""
        self.last_protocol = {"payload": payload}
        # If payload is a list of ops, count them. Otherwise default to 3.
        if isinstance(payload, list):
            op_count = len(payload)
            self.op_log.extend({"op": op, "stub": True} for op in payload)
        else:
            op_count = 3
            for action in ("pickUpTips", "aspirate", "dispense"):
                self.op_log.append({"op": action, "stub": True})
        return {"opCount": op_count, "ops": list(self.op_log)}

    async def status(self) -> dict[str, Any]:
        return {
            "status": "idle" if self.setup_done else "offline",
            "stub": True,
            "ops_run": len(self.op_log),
        }
