"""PLR backend factory.

Maps PCC's ``plrBackend`` string to a concrete PLR Machine instance, holding
exclusive access while the adapter session is active.

Phase 1 supports two backends:
  - ``chatterbox`` — PLR's ChatterboxBackend (in-memory mock, always available)
  - ``ot2`` — Opentrons OT-2 via PLR's OpentronsBackend (requires ``pylabrobot``
    + optional ``opentrons`` extra)

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


def _create_chatterbox(config: dict[str, Any]) -> Any:
    """ChatterboxBackend — PLR's in-memory mock liquid handler.

    Imports PLR; ChatterboxBackend is part of the core distribution.
    """
    from pylabrobot.liquid_handling import LiquidHandler
    from pylabrobot.liquid_handling.backends import ChatterboxBackend
    from pylabrobot.resources import Deck

    deck = Deck()
    return LiquidHandler(backend=ChatterboxBackend(), deck=deck)


async def _create_ot2(config: dict[str, Any]) -> Any:
    """Opentrons OT-2 via PLR's OpentronsBackend.

    Requires ``backend_config`` with at minimum ``ot2Url`` (typically
    ``http://192.168.1.50:31950``). Optional ``ot2ApiKey``.
    """
    from pylabrobot.liquid_handling import LiquidHandler
    from pylabrobot.liquid_handling.backends import OpentronsBackend
    from pylabrobot.resources.opentrons import OTDeck

    ot2_url = config.get("ot2Url") or config.get("host") or config.get("url")
    if not ot2_url:
        raise ValueError(
            "OT-2 backendConfig must include 'ot2Url' (e.g. 'http://192.168.1.50:31950')",
        )
    api_key = config.get("ot2ApiKey") or config.get("apiKey")
    backend_kwargs: dict[str, Any] = {"host": ot2_url}
    if api_key:
        backend_kwargs["api_key"] = api_key

    backend = OpentronsBackend(**backend_kwargs)
    return LiquidHandler(backend=backend, deck=OTDeck())


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
