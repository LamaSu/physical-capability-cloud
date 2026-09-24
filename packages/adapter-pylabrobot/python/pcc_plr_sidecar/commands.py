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

from .backend_loader import is_stub_machine
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
        if not is_stub_machine(handle.machine):
            # R39: a PLR LiquidHandler runs every op for real. The evidence is what
            # the machine did, never an echo of the request.
            op_count = await self._run_plr_ops(
                handle, device_id, job_id, protocol_source, protocol_inline,
            )
            return {
                "ok": True,
                "jobId": job_id,
                "opCount": op_count,
                "durationMs": int((time.monotonic() - started_at) * 1000),
                "summary": {},
            }
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

    # ── PLR dispatch (R39) ─────────────────────────────────────────────────

    async def _run_plr_ops(
        self,
        handle: Any,
        device_id: str,
        job_id: str,
        protocol_source: Any,
        protocol_inline: Any,
    ) -> int:
        """Run inline ops on a PLR LiquidHandler; one evidence event per completed op."""
        if protocol_source != "inline-ops":
            raise RpcException(
                RPC_ERROR_CODES["NOT_SUPPORTED"],
                f"protocolSource {protocol_source!r} is not supported on PLR backends; use inline-ops",
                {"protocolSource": protocol_source, "jobId": job_id},
            )
        ops = _inline_op_list(protocol_inline)
        if not ops:
            raise RpcException(
                RPC_ERROR_CODES["INVALID_PARAMS"],
                "inline-ops protocol has no ops",
                {"jobId": job_id},
            )
        lh = handle.machine
        done = 0
        for index, op in enumerate(ops):
            if not isinstance(op, dict):
                raise RpcException(
                    RPC_ERROR_CODES["INVALID_PARAMS"], "each op must be an object",
                    {"opIndex": index, "jobId": job_id},
                )
            if op.get("__delay_ms"):
                await asyncio.sleep(max(0.0, float(op["__delay_ms"]) / 1000.0))
                continue
            kind = op.get("op")
            try:
                record = await _run_plr_op(lh, kind, op, index)
            except RpcException as e:
                data = dict(e.data or {})
                data.update({"opIndex": index, "op": kind, "jobId": job_id, "opsCompleted": done})
                raise RpcException(e.code, e.message, data) from e
            except Exception as e:  # noqa: BLE001 — a PLR error stops the run, loudly
                raise RpcException(
                    RPC_ERROR_CODES["NON_RETRYABLE"],
                    f"{kind} failed: {e}",
                    {
                        "plrException": type(e).__name__, "opIndex": index, "op": kind,
                        "jobId": job_id, "opsCompleted": done,
                    },
                ) from e
            self.evidence.emit_atomic_op(device_id, kind, record)
            done += 1
        return done

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


_PLR_OPS = ("pickUpTips", "aspirate", "dispense", "dropTips")


def _inline_op_list(protocol_inline: Any) -> list[Any]:
    if isinstance(protocol_inline, list):
        return list(protocol_inline)
    if isinstance(protocol_inline, dict) and isinstance(protocol_inline.get("ops"), list):
        return list(protocol_inline["ops"])
    return []


def _bad_op(message: str, **data: Any) -> RpcException:
    return RpcException(RPC_ERROR_CODES["INVALID_PARAMS"], message, data or None)


def _resource(lh: Any, name: Any, field: str) -> Any:
    """Look up a deck resource by name; a missing one fails loud (-32002)."""
    from pylabrobot.resources import ResourceNotFoundError

    if not isinstance(name, str) or not name:
        raise _bad_op(f"{field} must be a non-empty string")
    try:
        return lh.deck.get_resource(name)
    except ResourceNotFoundError as e:
        raise RpcException(
            RPC_ERROR_CODES["NON_RETRYABLE"], f"resource not on deck: {name}",
            {"missingResource": name},
        ) from e


def _item(resource: Any, identifier: Any, field: str) -> Any:
    """A well or tip spot of a resource, e.g. plate["A1"]; unknown ones fail loud."""
    if not isinstance(identifier, str) or not identifier:
        raise _bad_op(f"{field} must be a non-empty string like 'A1'")
    try:
        items = resource[identifier]
    except (KeyError, IndexError, ValueError, TypeError) as e:
        raise RpcException(
            RPC_ERROR_CODES["NON_RETRYABLE"],
            f"{identifier} is not in {getattr(resource, 'name', resource)}",
            {"missingItem": identifier, "resource": getattr(resource, "name", None)},
        ) from e
    if isinstance(items, list):
        if len(items) != 1:
            raise _bad_op(f"{field} must name exactly one item", item=identifier)
        return items[0]
    return items


def _channels(op: dict[str, Any]) -> Any:
    channel = op.get("channel")
    if channel is None:
        return None
    if not isinstance(channel, int) or isinstance(channel, bool) or channel < 0:
        raise _bad_op("channel must be a non-negative integer")
    return [channel]


def _volume(op: dict[str, Any]) -> float:
    volume = op.get("volume_uL")
    if isinstance(volume, bool) or not isinstance(volume, (int, float)) or not volume > 0:
        raise _bad_op("volume_uL must be a positive number")
    return float(volume)


def _tip_spot_name(op: dict[str, Any]) -> Any:
    if op.get("tipSpot") is not None:
        return op["tipSpot"]
    column = op.get("tipColumn")
    if column is not None:
        if not isinstance(column, int) or isinstance(column, bool) or column < 1:
            raise _bad_op("tipColumn must be a positive integer")
        return f"A{column}"
    return None


async def _run_plr_op(lh: Any, kind: Any, op: dict[str, Any], index: int) -> dict[str, Any]:
    """Run one op on the LiquidHandler and return the evidence record for it."""
    channels = _channels(op)
    record: dict[str, Any] = {"op": kind, "opIndex": index}
    if channels is not None:
        record["channel"] = channels[0]
    if kind == "pickUpTips":
        rack = _resource(lh, op.get("tipRack"), "tipRack")
        spot_name = _tip_spot_name(op)
        if spot_name is None:
            raise _bad_op("pickUpTips needs tipSpot or tipColumn")
        spot = _item(rack, spot_name, "tipSpot")
        await lh.pick_up_tips([spot], use_channels=channels)
        record.update({"tipRack": op["tipRack"], "tipSpot": spot_name})
    elif kind in ("aspirate", "dispense"):
        labware = _resource(lh, op.get("labwareId"), "labwareId")
        well = _item(labware, op.get("well"), "well")
        volume = _volume(op)
        fn = lh.aspirate if kind == "aspirate" else lh.dispense
        await fn([well], vols=[volume], use_channels=channels)
        record.update({"labwareId": op["labwareId"], "well": op["well"], "volume_uL": volume})
    elif kind == "dropTips":
        if op.get("tipRack") is not None:
            rack = _resource(lh, op.get("tipRack"), "tipRack")
            spot_name = _tip_spot_name(op)
            if spot_name is None:
                raise _bad_op("dropTips with tipRack needs tipSpot or tipColumn")
            await lh.drop_tips([_item(rack, spot_name, "tipSpot")], use_channels=channels)
            record.update({"tipRack": op["tipRack"], "tipSpot": spot_name})
        else:
            # No destination named: put the tips back where they were picked up.
            await lh.return_tips(use_channels=channels)
            record["returned"] = True
    else:
        raise _bad_op(
            f"unknown op {kind!r}; supported: {', '.join(_PLR_OPS)}", op=kind,
        )
    return record


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
