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
``backendConfig.deckLayoutPath`` (a JSON file holding one). The layout is data:
it is loaded with ``Resource.deserialize(..., allow_marshal=False)``, so it can
never carry code. Without a layout the backend refuses to load, because an empty
deck cannot run a protocol (status board row R39).

Each backend is loaded lazily via inline imports so an operator can install
just the extras they need (``pip install pcc-plr-sidecar[ot2]``).

A small ``stub`` backend is also registered for test environments where PLR
is not installed — it implements the same surface (setup / run / stop /
status / dispose) with synthetic responses.
"""

from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

log = logging.getLogger("pcc_plr_sidecar.backend_loader")


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
        machine = await _create_machine(plr_backend, backend_config)
        handle = BackendHandle(
            plr_backend=plr_backend,
            device_id=device_id,
            machine=machine,
            backend_config=dict(backend_config),
            metadata={"loaded_via": "BackendLoader.load"},
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

async def _create_machine(plr_backend: str, config: dict[str, Any]) -> Any:
    """Dispatch on ``plr_backend`` to a concrete PLR Machine constructor.

    Imports are inline + per-branch so the operator only needs the vendor
    extras they actually use.
    """
    plr_backend = plr_backend.strip().lower()

    if plr_backend in ("chatterbox", "chatter"):
        return _create_chatterbox(config)

    if plr_backend == "stub":
        return _create_stub(config)

    if plr_backend == "ot2":
        return await _create_ot2(config)

    raise ValueError(
        f"unknown plrBackend: {plr_backend!r}. Phase 1 supports: chatterbox, ot2, stub",
    )


def _load_deck(config: dict[str, Any], expected_cls: type) -> Any:
    """Load the declared deck (R39). Raises ValueError, never returns an empty deck.

    ``deckLayout`` is a serialized PLR resource tree; ``deckLayoutPath`` names a
    JSON file holding one. PLR's loader resolves each child by ``type`` and
    assigns it to its parent, so the loaded deck is the populated deck.
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
    try:
        if layout is not None:
            if not isinstance(layout, dict):
                raise ValueError("deckLayout must be a serialized PLR resource object")
            # allow_marshal stays False: a layout is data and can never carry code.
            deck = Resource.deserialize(layout, allow_marshal=False)
        else:
            if not isinstance(path, str) or not path:
                raise ValueError("deckLayoutPath must be a non-empty string")
            deck = Resource.load_from_json_file(path)
    except ValueError:
        raise
    except Exception as e:  # noqa: BLE001 — any loader failure is an invalid layout
        raise ValueError(f"invalid deck layout: {type(e).__name__}: {e}") from e
    if not isinstance(deck, expected_cls):
        raise ValueError(
            f"deck layout loaded as {type(deck).__name__}, expected {expected_cls.__name__}",
        )
    return deck


def _create_chatterbox(config: dict[str, Any]) -> Any:
    """PLR's ``LiquidHandlerChatterboxBackend`` over the declared deck.

    ``ChatterboxBackend`` does not exist in pylabrobot 0.2.2, and
    ``ChatterBoxBackend`` raises NotImplementedError there (deprecated), so the
    only correct class is ``LiquidHandlerChatterboxBackend``.
    """
    from pylabrobot.liquid_handling import LiquidHandler
    from pylabrobot.liquid_handling.backends import LiquidHandlerChatterboxBackend
    from pylabrobot.resources import Deck

    deck = _load_deck(config, Deck)
    num_channels = config.get("numChannels", 8)
    if not isinstance(num_channels, int) or isinstance(num_channels, bool) or num_channels < 1:
        raise ValueError("backendConfig.numChannels must be a positive integer")
    return LiquidHandler(backend=LiquidHandlerChatterboxBackend(num_channels=num_channels), deck=deck)


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


async def _create_ot2(config: dict[str, Any]) -> Any:
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
    deck = _load_deck(config, OTDeck)
    return LiquidHandler(backend=OpentronsOT2Backend(host=host, port=port), deck=deck)


def is_stub_machine(machine: Any) -> bool:
    """True for the no-PLR stub; everything else is a PLR LiquidHandler."""
    return isinstance(machine, _StubMachine)


def _create_stub(config: dict[str, Any]) -> "_StubMachine":
    """Pure-Python no-PLR-required stub for environments without pylabrobot."""
    return _StubMachine(config=config)


class _StubMachine:
    """A fake PLR Machine — same surface, synthetic behavior.

    Used by tests that don't want a pylabrobot dependency, and as the
    default backend when ``import pylabrobot`` fails.
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
