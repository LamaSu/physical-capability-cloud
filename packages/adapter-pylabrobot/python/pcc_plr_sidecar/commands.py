"""RPC command handlers.

Implements the five `backend.*` + three `evidence.*` + one `health.*`
methods the TS adapter calls. Each handler is registered with the
:class:`Dispatcher` by the :class:`Server`.

Method names + payload shapes mirror the TypeScript constants in
``packages/adapter-pylabrobot/src/protocol.ts``.
"""

from __future__ import annotations
import asyncio
import logging
import time
from typing import Any, TYPE_CHECKING

from .dispatcher import RPC_ERROR_CODES, RpcException

if TYPE_CHECKING:
    from .backend_loader import BackendLoader
    from .evidence import EvidenceHandler

log = logging.getLogger("pcc_plr_sidecar.commands")


class Commands:
    """Bundle of RPC handlers bound to a backend loader + evidence handler.

    Constructed by :class:`Server` and registered onto its :class:`Dispatcher`.
    """

    def __init__(
        self,
        loader: "BackendLoader",
        evidence: "EvidenceHandler",
    ) -> None:
        self.loader = loader
        self.evidence = evidence

    def register_all(self, dispatcher: Any) -> None:
        dispatcher.register("backend.init", self.backend_init)
        dispatcher.register("backend.run", self.backend_run)
        dispatcher.register("backend.status", self.backend_status)
        dispatcher.register("backend.calibrate", self.backend_calibrate)
        dispatcher.register("backend.shutdown", self.backend_shutdown)
        dispatcher.register("backend.abort", self.backend_abort)
        dispatcher.register("evidence.startRecording", self.evidence_start_recording)
        dispatcher.register("evidence.stopRecording", self.evidence_stop_recording)
        dispatcher.register("evidence.snapshot", self.evidence_snapshot)
        dispatcher.register("health.ping", self.health_ping)

    # ── backend.* ──────────────────────────────────────────────────────────

    async def backend_init(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        plr_backend = _require_str(params, "plrBackend")
        backend_config = params.get("backendConfig") or {}
        if not isinstance(backend_config, dict):
            raise RpcException(
                RPC_ERROR_CODES["INVALID_PARAMS"],
                "backendConfig must be an object",
            )

        try:
            handle = await self.loader.load(plr_backend, device_id, backend_config)
        except ValueError as e:
            raise RpcException(RPC_ERROR_CODES["INVALID_PARAMS"], str(e)) from e
        except ImportError as e:
            raise RpcException(
                RPC_ERROR_CODES["HARDWARE_UNREACHABLE"],
                f"PLR backend module unavailable: {e}",
                {"plrBackend": plr_backend},
            ) from e

        # PLR backends typically expose .setup() as a coroutine. The stub
        # backend follows the same shape. Skip if already done.
        if not handle.setup_done:
            setup_fn = getattr(handle.machine, "setup", None)
            if setup_fn:
                try:
                    meta = setup_fn()
                    if asyncio.iscoroutine(meta):
                        meta = await meta
                    if isinstance(meta, dict):
                        handle.metadata.update(meta)
                except Exception as e:  # noqa: BLE001
                    raise RpcException(
                        RPC_ERROR_CODES["HARDWARE_UNREACHABLE"],
                        f"backend setup failed: {e}",
                        {"plrException": type(e).__name__},
                    ) from e
            handle.setup_done = True

        # Optional deck snapshot for Tier-0 evidence
        deck_snapshot = _try_deck_snapshot(handle.machine)
        return {
            "ok": True,
            "deviceId": device_id,
            "plrBackend": plr_backend,
            "deckSnapshot": deck_snapshot,
            "metadata": dict(handle.metadata),
        }

    async def backend_run(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        job_id = _require_str(params, "jobId")
        protocol_source = params.get("protocolSource", "inline-ops")
        protocol_payload = params.get("protocolPayload")
        protocol_inline = params.get("protocolInline")
        run_params = params.get("params") or {}

        handle = self._require_handle(device_id)

        if not self.evidence.is_recording(device_id):
            # Auto-start recording window if the TS adapter didn't pre-arm it.
            self.evidence.start_recording(device_id, job_id)

        started_at = time.monotonic()
        try:
            ops = _normalise_ops(protocol_source, protocol_payload, protocol_inline, run_params)
            for op in ops:
                # Honor mid-protocol delay declarations for tests/demos.
                if isinstance(op, dict) and op.get("__delay_ms"):
                    await asyncio.sleep(max(0.0, float(op["__delay_ms"]) / 1000.0))
                    continue
                op_type = (op.get("op") if isinstance(op, dict) else None) or "atomic_op"
                payload = op if isinstance(op, dict) else {"op": op}
                self.evidence.emit_atomic_op(device_id, op_type, payload)

            # If the operator handed us inline-ops we have no further work.
            # If they handed us anything else we delegate to the backend's
            # run_protocol (defined on the stub; PLR machines need a per-
            # backend dispatcher that lives in protocols.py in Phase 2).
            summary: dict[str, Any] = {}
            run_fn = getattr(handle.machine, "run_protocol", None)
            if run_fn and protocol_source not in ("inline-ops",):
                try:
                    result = run_fn(protocol_payload or protocol_inline or run_params)
                    if asyncio.iscoroutine(result):
                        result = await result
                    if isinstance(result, dict):
                        summary = result
                except Exception as e:  # noqa: BLE001
                    raise RpcException(
                        RPC_ERROR_CODES["NON_RETRYABLE"],
                        f"protocol failed: {e}",
                        {"plrException": type(e).__name__, "jobId": job_id},
                    ) from e

            duration_ms = int((time.monotonic() - started_at) * 1000)
            return {
                "ok": True,
                "jobId": job_id,
                "opCount": summary.get("opCount", len(ops)),
                "durationMs": duration_ms,
                "summary": summary,
            }
        finally:
            # Recording window is closed explicitly by the TS adapter via
            # evidence.stopRecording — leave it open here.
            pass

    async def backend_status(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        if not self.loader.has(device_id):
            return {"status": "offline", "diagnostics": {"reason": "no backend loaded"}}
        handle = self.loader.get(device_id)
        status_fn = getattr(handle.machine, "status", None)
        if status_fn:
            try:
                s = status_fn()
                if asyncio.iscoroutine(s):
                    s = await s
                if isinstance(s, dict):
                    out = {"status": s.get("status", "idle"), "diagnostics": s}
                    if "progress" in s:
                        out["progress"] = s["progress"]
                    return out
            except Exception as e:  # noqa: BLE001
                log.warning("status query raised: %s", e)
                return {"status": "error", "diagnostics": {"reason": str(e)}}
        return {"status": "idle" if handle.setup_done else "offline"}

    async def backend_calibrate(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        kind = _require_str(params, "kind")
        cal_params = params.get("params") or {}
        handle = self._require_handle(device_id)
        cal_fn = getattr(handle.machine, "calibrate", None)
        if cal_fn is None:
            raise RpcException(
                RPC_ERROR_CODES["NOT_SUPPORTED"],
                f"calibrate not supported on {handle.plr_backend}",
                {"kind": kind},
            )
        result = cal_fn(kind, cal_params)
        if asyncio.iscoroutine(result):
            result = await result
        return {"ok": True, "kind": kind, "result": result if isinstance(result, dict) else {}}

    async def backend_shutdown(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = params.get("deviceId")
        if device_id:
            await self.loader.unload(device_id)
            return {"ok": True, "deviceId": device_id}
        for h in list(self.loader.list()):
            await self.loader.unload(h.device_id)
        return {"ok": True, "shutdown": "all"}

    async def backend_abort(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        handle = self._require_handle(device_id)
        abort_fn = getattr(handle.machine, "abort", None) or getattr(handle.machine, "stop", None)
        if abort_fn is None:
            raise RpcException(
                RPC_ERROR_CODES["NOT_SUPPORTED"],
                f"abort not supported on {handle.plr_backend} (cancel at instrument UI)",
            )
        result = abort_fn()
        if asyncio.iscoroutine(result):
            await result
        return {"ok": True, "deviceId": device_id}

    # ── evidence.* ─────────────────────────────────────────────────────────

    async def evidence_start_recording(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        job_id = _require_str(params, "jobId")
        window = self.evidence.start_recording(device_id, job_id)
        return {"ok": True, "jobId": window.job_id, "startedAt": window.started_at.isoformat()}

    async def evidence_stop_recording(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        job_id = _require_str(params, "jobId")
        window = self.evidence.stop_recording(device_id, job_id)
        return {
            "ok": True,
            "jobId": job_id,
            "opCount": window.op_count if window else 0,
        }

    async def evidence_snapshot(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        if self.loader.has(device_id):
            handle = self.loader.get(device_id)
            deck_snapshot = _try_deck_snapshot(handle.machine)
            self.evidence.emit_event(
                device_id,
                "calibration_record",
                {"deckSnapshot": deck_snapshot, "metadata": dict(handle.metadata)},
            )
            return {"ok": True, "deckSnapshot": deck_snapshot}
        return {"ok": True, "deckSnapshot": None}

    # ── health.* ───────────────────────────────────────────────────────────

    async def health_ping(self, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": True,
            "devices": [
                {
                    "deviceId": h.device_id,
                    "plrBackend": h.plr_backend,
                    "setupDone": h.setup_done,
                }
                for h in self.loader.list()
            ],
        }

    # ── helpers ────────────────────────────────────────────────────────────

    def _require_handle(self, device_id: str):
        if not self.loader.has(device_id):
            raise RpcException(
                RPC_ERROR_CODES["HARDWARE_UNREACHABLE"],
                f"deviceId not initialised: {device_id}",
            )
        return self.loader.get(device_id)


def _require_str(params: dict[str, Any], key: str) -> str:
    val = params.get(key)
    if not isinstance(val, str) or not val:
        raise RpcException(
            RPC_ERROR_CODES["INVALID_PARAMS"],
            f"missing or empty required string param: {key}",
        )
    return val


def _try_deck_snapshot(machine: Any) -> dict[str, Any] | None:
    """Best-effort serialize the PLR deck JSON for Tier-0 evidence."""
    deck = getattr(machine, "deck", None)
    if deck is None:
        return None
    serialize = getattr(deck, "serialize", None)
    if not callable(serialize):
        return None
    try:
        result = serialize()
        if isinstance(result, dict):
            return result
        return {"raw": str(result)[:1024]}
    except Exception:
        return None


def _normalise_ops(
    protocol_source: str,
    protocol_payload: Any,
    protocol_inline: Any,
    run_params: dict[str, Any],
) -> list[dict[str, Any]]:
    """Coerce the run payload into a list of inline op dicts.

    Phase 1 only supports inline ops in detail; other sources are passed
    through to the backend's ``run_protocol`` (handled in commands.backend_run).
    """
    if protocol_source == "inline-ops":
        if isinstance(protocol_inline, list):
            return [op if isinstance(op, dict) else {"op": op} for op in protocol_inline]
        if isinstance(protocol_inline, dict) and isinstance(protocol_inline.get("ops"), list):
            return [op if isinstance(op, dict) else {"op": op} for op in protocol_inline["ops"]]
        # Fall back to a single synthetic "noop" so the recording isn't empty.
        return [{"op": "noop"}]
    # Non-inline sources don't produce per-op events here; backend handles it.
    return []
