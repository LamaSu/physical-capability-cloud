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
import math
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TYPE_CHECKING

from .backend_loader import is_stub_machine, reassert_tracking
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

        # R39 CRIT2: one per-device execution lease, taken BEFORE anything else
        # -- a second run on the same device fails fast with DEVICE_BUSY and
        # touches nothing: no recording start, no backend call. It doesn't queue.
        if not handle.try_acquire(job_id):
            raise RpcException(
                RPC_ERROR_CODES["DEVICE_BUSY"],
                f"deviceId {device_id} is busy running job {handle.busy_job_id}",
                {"deviceId": device_id, "jobId": job_id, "busyJobId": handle.busy_job_id},
            )
        try:
            if not self.evidence.is_recording(device_id):
                # Auto-start recording window if the TS adapter didn't pre-arm it.
                self.evidence.start_recording(device_id, job_id)

            started_at = time.monotonic()
            if not is_stub_machine(handle.machine):
                # R39 CRIT3: re-assert + verify tracking immediately before every
                # non-simulated run (no-op for simulators -- see reassert_tracking).
                try:
                    reassert_tracking(handle)
                except RuntimeError as e:
                    raise RpcException(
                        RPC_ERROR_CODES["NON_RETRYABLE"], str(e),
                        {"jobId": job_id, "deviceId": device_id},
                    ) from e
                # R39: a PLR LiquidHandler runs every op for real. The evidence is
                # what the machine did, never an echo of the request.
                op_count = await self._run_plr_ops(
                    handle, device_id, job_id, protocol_source, protocol_inline,
                )
                # R39 HIGH5: completion never outruns the evidence it claims --
                # await every atomic-op write before reporting success. A write
                # failure here means this run does not report clean success.
                await self._drain_evidence(device_id, job_id)
                return {
                    "ok": True,
                    "jobId": job_id,
                    "opCount": op_count,
                    "executionMode": handle.execution_mode,
                    "durationMs": int((time.monotonic() - started_at) * 1000),
                    "summary": {},
                }
            # The stub moves nothing: its results and every event say executionMode "stub".
            ops = _normalise_ops(protocol_source, protocol_payload, protocol_inline, run_params)
            for op in ops:
                op_type = (op.get("op") if isinstance(op, dict) else None) or "atomic_op"
                payload = dict(op) if isinstance(op, dict) else {"op": op}
                payload["executionMode"] = "stub"
                payload["mock"] = True
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
            # R39 HIGH5: same rule on the stub path -- drain before success.
            await self._drain_evidence(device_id, job_id)
            return {
                "ok": True,
                "jobId": job_id,
                "opCount": summary.get("opCount", len(ops)),
                "executionMode": "stub",
                "durationMs": duration_ms,
                "summary": summary,
            }
            # Recording window is closed explicitly by the TS adapter via
            # evidence.stopRecording — leave it open here.
        finally:
            handle.release()

    async def _drain_evidence(self, device_id: str, job_id: str) -> None:
        """R39 HIGH5: await every atomic-op evidence write scheduled for this
        run before `backend.run` returns. If a write failed, surface it as an
        error rather than letting the caller report clean success."""
        try:
            await self.evidence.drain(device_id)
        except Exception as e:  # noqa: BLE001 — any drain failure voids success
            raise RpcException(
                RPC_ERROR_CODES["INTERNAL_ERROR"],
                f"evidence write failed: {e}",
                {"jobId": job_id, "deviceId": device_id, "plrException": type(e).__name__},
            ) from e

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
        # R39 CRIT2: a recording window is bound to the run holding the device's
        # lease. A different job may not open (or silently replace) a window
        # while that lease is held.
        if self.loader.has(device_id):
            handle = self.loader.get(device_id)
            if handle.busy and handle.busy_job_id != job_id:
                raise RpcException(
                    RPC_ERROR_CODES["DEVICE_BUSY"],
                    f"deviceId {device_id} is busy running job {handle.busy_job_id}",
                    {"deviceId": device_id, "jobId": job_id, "busyJobId": handle.busy_job_id},
                )
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
        """Run inline ops on a PLR LiquidHandler; one evidence event per completed op.

        Two phases. First every op is checked: its fields, its bounds, and the deck
        resources it names, all before anything moves. A protocol with one bad op
        runs no op at all. Then the checked ops run in order; a PLR error stops the
        run. ``opsCompleted`` in an error counts the calls that returned; it does not
        prove the failing call had no physical effect.
        """
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
        limits = _Limits(num_channels=_num_channels(lh), max_volume_ul=handle.max_volume_ul)
        steps: list[_Step] = []
        for index, op in enumerate(ops):
            kind = op.get("op") if isinstance(op, dict) else None
            try:
                steps.append(_prepare_plr_op(lh, op, index, limits))
            except RpcException as e:
                data = dict(e.data or {})
                data.update({"opIndex": index, "op": kind, "jobId": job_id, "opsCompleted": 0})
                raise RpcException(e.code, e.message, data) from e
        done = 0
        for step in steps:
            try:
                await step.run()
            except Exception as e:  # noqa: BLE001 — a PLR error stops the run, loudly
                raise RpcException(
                    RPC_ERROR_CODES["NON_RETRYABLE"],
                    f"{step.kind} failed: {e}",
                    {
                        "plrException": type(e).__name__, "opIndex": step.index, "op": step.kind,
                        "jobId": job_id, "opsCompleted": done, "executionMode": handle.execution_mode,
                    },
                ) from e
            record = dict(step.record, executionMode=handle.execution_mode)
            if handle.execution_mode != "hardware":
                record["mock"] = True  # a simulated op is never physical evidence
            self.evidence.emit_atomic_op(device_id, step.kind, record)
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
# The only fields each op may carry; anything else (a test hook, a typo, a field
# a later version adds) refuses the whole protocol before anything moves.
_OP_FIELDS = {
    "pickUpTips": frozenset({"op", "channel", "tipRack", "tipSpot", "tipColumn"}),
    "aspirate": frozenset({"op", "channel", "labwareId", "well", "volume_uL"}),
    "dispense": frozenset({"op", "channel", "labwareId", "well", "volume_uL"}),
    "dropTips": frozenset({"op", "channel", "tipRack", "tipSpot", "tipColumn"}),
}


@dataclass(frozen=True)
class _Limits:
    num_channels: int
    max_volume_ul: float


@dataclass(frozen=True)
class _Step:
    """One checked op: the call to make and the evidence record for it."""

    index: int
    kind: str
    run: Callable[[], Awaitable[Any]]
    record: dict[str, Any]


def _num_channels(lh: Any) -> int:
    count = getattr(getattr(lh, "backend", None), "num_channels", None)
    if isinstance(count, bool) or not isinstance(count, int) or count < 1:
        raise RpcException(
            RPC_ERROR_CODES["HARDWARE_UNREACHABLE"],
            "the backend does not report how many channels it has, so no op can be checked",
        )
    return count


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


def _channels(op: dict[str, Any], num_channels: int) -> Any:
    channel = op.get("channel")
    if channel is None:
        return None
    if not isinstance(channel, int) or isinstance(channel, bool) or not 0 <= channel < num_channels:
        raise _bad_op(f"channel must be an integer from 0 to {num_channels - 1} (this backend has {num_channels})")
    return [channel]


def _volume(op: dict[str, Any], max_volume_ul: float) -> float:
    volume = op.get("volume_uL")
    if (
        isinstance(volume, bool) or not isinstance(volume, (int, float)) or not math.isfinite(volume)
        or not 0 < volume <= max_volume_ul
    ):
        raise _bad_op(f"volume_uL must be a finite number in (0, {max_volume_ul:g}]")
    return float(volume)


def _tip_spot_name(op: dict[str, Any]) -> Any:
    if op.get("tipSpot") is not None and op.get("tipColumn") is not None:
        raise _bad_op("give tipSpot or tipColumn, not both")
    if op.get("tipSpot") is not None:
        return op["tipSpot"]
    column = op.get("tipColumn")
    if column is not None:
        if not isinstance(column, int) or isinstance(column, bool) or column < 1:
            raise _bad_op("tipColumn must be a positive integer")
        return f"A{column}"
    return None


def _tip_spot(rack: Any, name: Any) -> Any:
    from pylabrobot.resources import TipSpot

    spot = _item(rack, name, "tipSpot")
    if not isinstance(spot, TipSpot):
        raise _bad_op(f"{name} in {getattr(rack, 'name', rack)} is not a tip spot", item=name)
    return spot


def _liquid_container(labware: Any, name: Any) -> Any:
    from pylabrobot import resources

    kinds = tuple(k for k in (getattr(resources, "Container", None), getattr(resources, "Well", None)) if isinstance(k, type))
    well = _item(labware, name, "well")
    if not kinds or not isinstance(well, kinds):
        raise _bad_op(f"{name} in {getattr(labware, 'name', labware)} is not a well or container", item=name)
    return well


def _prepare_plr_op(lh: Any, op: Any, index: int, limits: _Limits) -> _Step:
    """Check one op completely, without moving anything, and return the call to make."""
    if not isinstance(op, dict):
        raise _bad_op("each op must be an object")
    kind = op.get("op")
    if kind not in _OP_FIELDS:
        raise _bad_op(f"unknown op {kind!r}; supported: {', '.join(_PLR_OPS)}", op=kind)
    unknown = sorted(str(k) for k in set(op) - _OP_FIELDS[kind])
    if unknown:
        raise _bad_op(f"{kind} does not take {', '.join(unknown)}", unknownFields=unknown)
    channels = _channels(op, limits.num_channels)
    record: dict[str, Any] = {"op": kind, "opIndex": index}
    if channels is not None:
        record["channel"] = channels[0]
    if kind == "pickUpTips":
        rack = _resource(lh, op.get("tipRack"), "tipRack")
        spot_name = _tip_spot_name(op)
        if spot_name is None:
            raise _bad_op("pickUpTips needs tipSpot or tipColumn")
        spot = _tip_spot(rack, spot_name)
        record.update({"tipRack": op["tipRack"], "tipSpot": spot_name})
        return _Step(index, kind, lambda: lh.pick_up_tips([spot], use_channels=channels), record)
    if kind in ("aspirate", "dispense"):
        labware = _resource(lh, op.get("labwareId"), "labwareId")
        well = _liquid_container(labware, op.get("well"))
        volume = _volume(op, limits.max_volume_ul)
        fn = lh.aspirate if kind == "aspirate" else lh.dispense
        record.update({"labwareId": op["labwareId"], "well": op["well"], "volume_uL": volume})
        return _Step(index, kind, lambda: fn([well], vols=[volume], use_channels=channels), record)
    # dropTips
    if op.get("tipRack") is not None:
        rack = _resource(lh, op.get("tipRack"), "tipRack")
        spot_name = _tip_spot_name(op)
        if spot_name is None:
            raise _bad_op("dropTips with tipRack needs tipSpot or tipColumn")
        spot = _tip_spot(rack, spot_name)
        record.update({"tipRack": op["tipRack"], "tipSpot": spot_name})
        return _Step(index, kind, lambda: lh.drop_tips([spot], use_channels=channels), record)
    if op.get("tipSpot") is not None or op.get("tipColumn") is not None:
        raise _bad_op("dropTips names a tip spot without a tipRack")
    # No destination named: put the tips back where they were picked up.
    record["returned"] = True
    return _Step(index, kind, lambda: lh.return_tips(use_channels=channels), record)


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
