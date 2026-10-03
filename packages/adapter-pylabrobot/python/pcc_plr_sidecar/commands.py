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
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TYPE_CHECKING

from .backend_loader import DeviceBusy, is_stub_machine, reassert_tracking
from .dispatcher import RPC_ERROR_CODES, RpcException
from .evidence import RecordingWindow, RecordingWindowBusy

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
        # Windows this process closed, by (deviceId, jobId): the drain's watermark and the window
        # (its counts are final once that drain is done), so a retried evidence.stopRecording
        # answers as the first did. The last 64.
        self._closed: "OrderedDict[tuple[str, str], tuple[int, RecordingWindow]]" = OrderedDict()
        # Devices with a backend.run in flight: one run per device (astra pack 473).
        self._running: set[str] = set()

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
            handle, created = await self.loader.load_for_init(plr_backend, device_id, backend_config)
        except DeviceBusy as e:
            raise RpcException(RPC_ERROR_CODES["DEVICE_BUSY"], str(e), {"deviceId": device_id}) from e
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
        # R39 r4: setup runs under the device's lease. A handle this call
        # created already holds it; otherwise take it, or refuse when a run,
        # another setup or a shutdown holds it.
        if not handle.setup_done:
            if not created and not handle.begin_setup():
                raise RpcException(
                    RPC_ERROR_CODES["DEVICE_BUSY"],
                    f"deviceId {device_id} is busy",
                    {"deviceId": device_id},
                )
            try:
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
            finally:
                handle.end_setup()

        # Optional deck snapshot for Tier-0 evidence
        deck_snapshot = _try_deck_snapshot(handle.machine)
        return {
            "ok": True,
            "deviceId": device_id,
            "plrBackend": plr_backend,
            "deckSnapshot": deck_snapshot,
            "generation": self.evidence.generation,
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
        # touches nothing: no backend call. It doesn't queue.
        if not handle.try_acquire(job_id):
            raise RpcException(
                RPC_ERROR_CODES["DEVICE_BUSY"],
                f"deviceId {device_id} is busy running job {handle.busy_job_id}",
                {"deviceId": device_id, "jobId": job_id, "busyJobId": handle.busy_job_id},
            )
        marked = False
        try:
            # One run per device (#526, astra pack 473): the mark evidence.stopRecording reads,
            # so a running device keeps its window. Under R39's lease above it is always free;
            # checked anyway, and cleared below only if this run set it.
            if device_id in self._running:
                raise RpcException(
                    RPC_ERROR_CODES["DEVICE_BUSY"],
                    f"device {device_id} is already running a protocol, so job {job_id} does not run",
                    {"jobId": job_id},
                )
            self._running.add(device_id)
            marked = True
            if not handle.setup_done:
                raise RpcException(
                    RPC_ERROR_CODES["NON_RETRYABLE"],
                    f"deviceId {device_id} has not finished setup; call backend.init first",
                    {"deviceId": device_id, "jobId": job_id},
                )
            # A run records only into its own job's window, which the adapter opened (and saw
            # attested) first. No window, or another job's, is refused: nothing runs unrecorded,
            # and no op is attributed to another job (astra pack 194; there is no auto-open).
            window = self.evidence.get_window(device_id)
            if window is None or window.job_id != job_id:
                raise RpcException(
                    RPC_ERROR_CODES["NO_RECORDING_WINDOW"],
                    f"no recording window for job {job_id} on device {device_id}",
                    {"generation": self.evidence.generation},
                )

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
                # The job's evidence is complete once evidence.stopRecording answers:
                # that close is the barrier (#502's model).
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
            return {
                "ok": True,
                "jobId": job_id,
                "opCount": summary.get("opCount", len(ops)),
                "executionMode": "stub",
                "durationMs": duration_ms,
                "summary": summary,
            }
        finally:
            # The run is over: the device takes another. Its recording window is closed
            # explicitly by the TS adapter via evidence.stopRecording, so it stays open here.
            if marked:
                self._running.discard(device_id)
            handle.release()

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
        try:
            window = self.evidence.start_recording(device_id, job_id)
        except RecordingWindowBusy as busy:
            raise RpcException(
                RPC_ERROR_CODES["DEVICE_BUSY"],
                f"device {device_id} is recording job {busy.job_id}, so job {job_id} cannot open a window",
                {"jobId": busy.job_id, "generation": self.evidence.generation},
            ) from busy
        return {
            "ok": True,
            "jobId": window.job_id,
            "startedAt": window.started_at.isoformat(),
            "generation": self.evidence.generation,
        }

    async def evidence_stop_recording(self, params: dict[str, Any]) -> dict[str, Any]:
        device_id = _require_str(params, "deviceId")
        job_id = _require_str(params, "jobId")
        # A device whose run is in flight keeps its window (astra pack 204). A client-side run
        # timeout does not stop the run here: closing the window would attest a job whose run
        # can still emit, and let another job's window open under it. Refused until the run
        # ends; the adapter holds the device and retries this barrier until it answers.
        if device_id in self._running:
            raise RpcException(
                RPC_ERROR_CODES["DEVICE_BUSY"],
                f"device {device_id} is still running, so job {job_id}'s window stays open until its run ends",
                {"jobId": job_id, "generation": self.evidence.generation},
            )
        window = self.evidence.stop_recording(device_id, job_id)
        key = (device_id, job_id)
        if window is not None:
            self._closed[key] = (self.evidence.watermark(), window)
            while len(self._closed) > 64:
                self._closed.popitem(last=False)
        elif key not in self._closed:
            # No window of this job was ever open in this process: nothing to attest. A
            # restarted sidecar says so, with its own generation (astra pack 194).
            raise RpcException(
                RPC_ERROR_CODES["NO_RECORDING_WINDOW"],
                f"no recording window for job {job_id} on device {device_id} in this sidecar",
                {"generation": self.evidence.generation},
            )
        mark, closed = self._closed[key]
        # A barrier: every notification scheduled before the window closed is written
        # before this answer, so once the TS adapter has it, it has all of the job's
        # evidence (astra pack 186). A retried close of the same window answers the same
        # way, once that drain is done. Notifications scheduled later are not waited for.
        await self.evidence.drain_through(mark)
        # After the drain, the window's counts are final: how many notifications it scheduled,
        # and how many of their writes failed. The TS adapter proves it received every one.
        return {
            "ok": True,
            "jobId": job_id,
            "opCount": closed.op_count,
            "notified": closed.notified,
            "failedWrites": closed.failed_writes,
            "generation": self.evidence.generation,
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


# R39 MED6: the stub shares the wire vocabulary with the PLR path (_OP_FIELDS),
# but — unlike _prepare_plr_op — doesn't require a specific op's own fields
# (no deck to check a labwareId/tipRack against on the stub). A field valid
# for ANY real op is accepted on ANY stub op; anything else is unknown.
_STUB_OP_FIELDS = frozenset({"op"}).union(*_OP_FIELDS.values())


def _validate_stub_op(op: Any, index: int) -> dict[str, Any]:
    """Check one stub op is a known op with no unrecognized fields. Never
    invents one: malformed input is a validation error, not a synthetic noop.
    """
    if not isinstance(op, dict):
        raise _bad_op(f"each op must be an object (op {index} is a {type(op).__name__})", opIndex=index)
    kind = op.get("op")
    if kind not in _PLR_OPS:
        raise _bad_op(f"unknown op {kind!r}; supported: {', '.join(_PLR_OPS)}", opIndex=index, op=kind)
    unknown = sorted(str(k) for k in set(op) - _STUB_OP_FIELDS)
    if unknown:
        raise _bad_op(f"{kind} does not take {', '.join(unknown)}", opIndex=index, unknownFields=unknown)
    return op


def _normalise_ops(
    protocol_source: str,
    protocol_payload: Any,
    protocol_inline: Any,
    run_params: dict[str, Any],
) -> list[dict[str, Any]]:
    """Coerce the run payload into a list of inline op dicts, or fail loud.

    Phase 1 only supports inline ops in detail; other sources are passed
    through to the backend's ``run_protocol`` (handled in commands.backend_run).

    R39 MED6: missing/null ops, a non-list/non-{"ops":[...]} shape, an unknown
    op, or an unknown field is a validation error -- never a synthetic "noop"
    standing in for what the caller actually asked for.
    """
    if protocol_source == "inline-ops":
        if isinstance(protocol_inline, list):
            ops = protocol_inline
        elif isinstance(protocol_inline, dict) and isinstance(protocol_inline.get("ops"), list):
            ops = protocol_inline["ops"]
        else:
            found = "null" if protocol_inline is None else type(protocol_inline).__name__
            raise _bad_op(f'protocolInline must be a list of ops (or {{"ops": [...]}}); got {found}')
        if not ops:
            raise _bad_op("inline-ops protocol has no ops")
        return [_validate_stub_op(op, index) for index, op in enumerate(ops)]
    # Non-inline sources don't produce per-op events here; backend handles it.
    return []
