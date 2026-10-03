"""Evidence handler — Python ``logging.Handler`` that pushes PLR log records
out as JSON-RPC ``evidence`` notifications during a recording window.

Wired into the PLR root logger by the :class:`Server`. Outside an active
recording window the records are silently dropped (the TS adapter has no
job to attribute them to).
"""

from __future__ import annotations
import asyncio
import logging
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

NotificationWriter = Callable[[str, dict[str, Any]], Awaitable[None]]

# Not a logger the EvidenceHandler listens to, so a failure logged here is never itself evidence.
log = logging.getLogger("pcc_plr_sidecar.evidence")


@dataclass
class RecordingWindow:
    """A live evidence-recording window scoped to a (deviceId, jobId) pair."""

    device_id: str
    job_id: str
    started_at: datetime
    op_count: int = 0
    # Every notification scheduled into the window, and those whose write failed. Once the window
    # is closed and drained, evidence.stopRecording attests both, so the TS adapter can prove it
    # received each one: a write that fails is never silently lost (refvertical #5668).
    notified: int = 0
    failed_writes: int = 0


class RecordingWindowBusy(Exception):
    """Another job's recording window is open on the device (astra pack 473)."""

    def __init__(self, device_id: str, job_id: str) -> None:
        super().__init__(f"device {device_id} is recording job {job_id}")
        self.device_id = device_id
        self.job_id = job_id


class EvidenceHandler(logging.Handler):
    """Routes PLR log records into JSON-RPC evidence notifications.

    Construction:
        handler = EvidenceHandler(writer=server.write_notification)
        logging.getLogger("pylabrobot").addHandler(handler)
        logging.getLogger("pcc_plr_sidecar.run").addHandler(handler)

    Lifecycle:
        handler.start_recording(device_id, job_id)
        ... PLR emits log records ...
        handler.stop_recording(device_id, job_id)
    """

    def __init__(self, writer: NotificationWriter, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        super().__init__(level=logging.DEBUG)
        self._writer = writer
        self._loop = loop
        self._windows: dict[str, RecordingWindow] = {}  # deviceId -> window
        # This sidecar process. A recording window is attested with it, so the TS adapter can
        # tell this process's answer from a restarted one's (astra pack 194).
        self.generation = uuid.uuid4().hex
        # Each notification is written by a task of its own, so it can be written after an
        # RPC answer sent later. Every one gets a sequence number when it is scheduled and
        # stays pending until written: evidence.stopRecording waits (drain_through) for all
        # scheduled before it, so its answer follows them (astra pack 186). The lock also
        # guards the windows, which logging can read from other threads.
        self._lock = threading.Lock()
        self._last_seq = 0
        self._pending: set[int] = set()
        self._drain_waiters: list[asyncio.Future[None]] = []
        self.setFormatter(logging.Formatter("%(message)s"))

    # ── recording window lifecycle ─────────────────────────────────────────

    def start_recording(self, device_id: str, job_id: str) -> RecordingWindow:
        """Open the device's recording window for ``job_id``. A device has one: while another
        job's is open the start is refused (RecordingWindowBusy), so that job's ops stay bound
        to it and its barrier finds it (astra pack 473). The same job's open window is returned
        as it is."""
        with self._lock:
            current = self._windows.get(device_id)
            if current is not None:
                if current.job_id == job_id:
                    return current
                raise RecordingWindowBusy(device_id, current.job_id)
            window = RecordingWindow(
                device_id=device_id,
                job_id=job_id,
                started_at=datetime.now(timezone.utc),
            )
            self._windows[device_id] = window
            return window

    def stop_recording(self, device_id: str, job_id: str) -> Optional[RecordingWindow]:
        """Close the device's window if it is this job's (another job's stays open). A
        notification for it not yet scheduled is dropped."""
        with self._lock:
            window = self._windows.get(device_id)
            if window is None or window.job_id != job_id:
                return None
            del self._windows[device_id]
            return window

    def watermark(self) -> int:
        """The sequence number of the last notification scheduled so far."""
        with self._lock:
            return self._last_seq

    async def drain_through(self, watermark: int) -> None:
        """Wait until every notification scheduled up to ``watermark`` has been written.

        Notifications scheduled after it are not waited for, so a busy logger cannot
        hold a caller here.
        """
        loop = asyncio.get_running_loop()
        while True:
            with self._lock:
                if not any(seq <= watermark for seq in self._pending):
                    return
                waiter: asyncio.Future[None] = loop.create_future()
                self._drain_waiters.append(waiter)
            await waiter

    def is_recording(self, device_id: str) -> bool:
        return device_id in self._windows

    def get_window(self, device_id: str) -> Optional[RecordingWindow]:
        return self._windows.get(device_id)

    # ── explicit atomic-op emission (called by commands.py) ───────────────

    def emit_atomic_op(
        self,
        device_id: str,
        op_type: str,
        payload: dict[str, Any],
    ) -> None:
        """Emit one atomic-op event for the active recording window.

        Called by command handlers around each PLR aspirate/dispense/etc.
        """
        window = self._windows.get(device_id)
        if not window:
            return
        window.op_count += 1
        self._schedule_notify(
            "evidence",
            {
                "type": op_type,
                "deviceId": device_id,
                "jobId": window.job_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "payload": dict(payload),
            },
            window,
        )

    def emit_event(self, device_id: str, event_type: str, payload: dict[str, Any]) -> None:
        """Emit a single non-atomic-op event (camera, sensor, calibration)."""
        window = self._windows.get(device_id)
        job_id = window.job_id if window else None
        self._schedule_notify(
            "evidence",
            {
                "type": event_type,
                "deviceId": device_id,
                "jobId": job_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "payload": dict(payload),
            },
            window,
        )

    # ── logging.Handler override ───────────────────────────────────────────

    def emit(self, record: logging.LogRecord) -> None:
        """Wrap every PLR log line into a ``log`` evidence notification.

        Without an active window we silently drop the record (the TS adapter
        has no PCC job context to attribute it to).
        """
        # The PLR log lines aren't device-scoped natively. We pick any active
        # window — if multiple devices are recording, each log gets routed to
        # *one* of them. Operators running multi-device sidecars should scope
        # device records via emit_atomic_op() instead.
        with self._lock:
            first = next(iter(self._windows.items()), None)
        if first is None:
            return
        device_id, window = first
        try:
            msg = self.format(record)
        except Exception:
            msg = record.getMessage()
        self._schedule_notify(
            "evidence",
            {
                "type": "log",
                "deviceId": device_id,
                "jobId": window.job_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "payload": {
                    "level": record.levelname,
                    "logger": record.name,
                    "line": msg,
                },
            },
            window,
        )

    # ── private ────────────────────────────────────────────────────────────

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the asyncio event loop used to schedule notify-writes.

        Called by Server during startup so the synchronous ``logging.Handler``
        machinery has a way back to the running loop.
        """
        self._loop = loop

    def _schedule_notify(
        self, method: str, params: dict[str, Any], window: Optional[RecordingWindow] = None,
    ) -> None:
        loop = self._loop
        if loop is None:
            return
        with self._lock:
            # The window closed after the caller read it (stop_recording on another thread):
            # its job's notifications end at that barrier, so this one is dropped.
            if window is not None and self._windows.get(window.device_id) is not window:
                return
            if window is not None:
                window.notified += 1
            self._last_seq += 1
            seq = self._last_seq
            self._pending.add(seq)
        # logging may be called from threads; schedule the async write
        # threadsafely onto the running loop.
        try:
            loop.call_soon_threadsafe(
                lambda: loop.create_task(self._write_tracked(seq, method, params, window))
            )
        except RuntimeError:
            # Loop is closed — drop silently. No drain can be waiting on a closed loop.
            with self._lock:
                self._pending.discard(seq)

    async def _write_tracked(
        self, seq: int, method: str, params: dict[str, Any], window: Optional[RecordingWindow] = None,
    ) -> None:
        try:
            await self._writer(method, params)
        except Exception:  # noqa: BLE001
            # Counted on its window before the drain can end, so the barrier attests it.
            with self._lock:
                if window is not None:
                    window.failed_writes += 1
            log.exception("an evidence notification could not be written")
        finally:
            with self._lock:
                self._pending.discard(seq)
                waiters, self._drain_waiters = self._drain_waiters, []
            for waiter in waiters:
                if not waiter.done():
                    waiter.set_result(None)
