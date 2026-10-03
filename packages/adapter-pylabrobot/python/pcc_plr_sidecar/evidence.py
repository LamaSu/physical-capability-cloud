"""Evidence handler — Python ``logging.Handler`` that pushes PLR log records
out as JSON-RPC ``evidence`` notifications during a recording window.

Wired into the PLR root logger by the :class:`Server`. Outside an active
recording window the records are silently dropped (the TS adapter has no
job to attribute them to).
"""

from __future__ import annotations
import asyncio
import threading
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional

NotificationWriter = Callable[[str, dict[str, Any]], Awaitable[None]]


@dataclass
class RecordingWindow:
    """A live evidence-recording window scoped to a (deviceId, jobId) pair."""

    device_id: str
    job_id: str
    started_at: datetime
    op_count: int = 0


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
        # R39 HIGH5: every notification scheduled via _schedule_notify for a
        # device, not yet confirmed written. drain() is the explicit
        # rendezvous backend.run uses before it reports success -- completion
        # must never outrun (or silently drop) the evidence it claims.
        self._pending: dict[str, list[asyncio.Task]] = {}
        # R39 r4: writes another thread queued with call_soon_threadsafe whose
        # task does not exist yet, per device. drain() waits for them too.
        self._queued: dict[str, int] = {}
        self._queued_lock = threading.Lock()
        # R39 r5: devices whose run has ended its evidence. A write for a sealed
        # device is dropped, never scheduled, so nothing can still be pending or
        # fail after backend.run reported success. Checked and set under
        # _queued_lock, the same lock that counts cross-thread writes.
        self._sealed: set[str] = set()
        self.setFormatter(logging.Formatter("%(message)s"))

    # ── recording window lifecycle ─────────────────────────────────────────

    def unseal(self, device_id: str) -> None:
        """Accept writes for ``device_id`` again (a run starts, or a window opens or closes)."""
        with self._queued_lock:
            self._sealed.discard(device_id)

    async def seal_and_drain(self, device_id: str) -> None:
        """End a run's evidence (R39 r5): seal the device, so no write can be
        accepted for it from here on, from any thread, then drain every write
        accepted before the seal. When this returns, none is pending."""
        with self._queued_lock:
            self._sealed.add(device_id)
        await self.drain(device_id)

    def start_recording(self, device_id: str, job_id: str) -> RecordingWindow:
        self.unseal(device_id)
        window = RecordingWindow(
            device_id=device_id,
            job_id=job_id,
            started_at=datetime.now(timezone.utc),
        )
        self._windows[device_id] = window
        return window

    def stop_recording(self, device_id: str, job_id: str) -> Optional[RecordingWindow]:
        """Close ``job_id``'s window. Another job's window is left open (R39 r4)."""
        window = self._windows.get(device_id)
        if window is None or window.job_id != job_id:
            return None
        self.unseal(device_id)
        return self._windows.pop(device_id)

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
            device_id=device_id,
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
            device_id=device_id,
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
        if not self._windows:
            return
        device_id, window = next(iter(self._windows.items()))
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
            device_id=device_id,
        )

    # ── private ────────────────────────────────────────────────────────────

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the asyncio event loop used to schedule notify-writes.

        Called by Server during startup so the synchronous ``logging.Handler``
        machinery has a way back to the running loop.
        """
        self._loop = loop

    def _schedule_notify(
        self, method: str, params: dict[str, Any], device_id: Optional[str] = None,
    ) -> None:
        if self._loop is None:
            return
        # logging may be called from threads, so cross-thread callers must go
        # through call_soon_threadsafe. But that defers task creation by at
        # least one loop tick — if a same-thread caller (emit_atomic_op, called
        # directly from commands.py's own async code) immediately awaited
        # drain() with no intervening await, drain would see nothing pending
        # yet (R39 HIGH5 regression). When we're already running on this
        # handler's own loop, create (and track) the task right now instead.
        try:
            running_loop: Optional[asyncio.AbstractEventLoop] = asyncio.get_running_loop()
        except RuntimeError:
            running_loop = None
        if running_loop is self._loop:
            if device_id is not None:
                with self._queued_lock:
                    if device_id in self._sealed:
                        return  # the run already ended its evidence (R39 r5)
            self._create_and_track(method, params, device_id)
        else:
            # Count it now, in the calling thread, so a drain() that starts
            # before the loop runs the callback still waits for it (R39 r4).
            # A sealed device takes no more writes (R39 r5): the check and the
            # count are one step under the lock seal_and_drain takes.
            if device_id is not None:
                with self._queued_lock:
                    if device_id in self._sealed:
                        return
                    self._queued[device_id] = self._queued.get(device_id, 0) + 1
            try:
                self._loop.call_soon_threadsafe(self._create_queued, method, params, device_id)
            except RuntimeError:
                # Loop is closed — drop silently.
                if device_id is not None:
                    with self._queued_lock:
                        self._queued[device_id] -= 1

    def _create_queued(
        self, method: str, params: dict[str, Any], device_id: Optional[str],
    ) -> None:
        if device_id is not None:
            with self._queued_lock:
                self._queued[device_id] -= 1
        self._create_and_track(method, params, device_id)

    def _create_and_track(
        self, method: str, params: dict[str, Any], device_id: Optional[str],
    ) -> None:
        task = self._loop.create_task(self._writer(method, params))
        if device_id is None:
            return
        pending = self._pending.setdefault(device_id, [])
        pending.append(task)

        def _done(t: asyncio.Task, *, _device_id: str = device_id) -> None:
            # A write that failed or was cancelled stays pending until drain()
            # reports it: finishing before the run reached drain() must not hide
            # it (R39 r3 review). Only a clean write leaves the bucket here.
            if t.cancelled() or t.exception() is not None:
                return
            bucket = self._pending.get(_device_id)
            if bucket and t in bucket:
                bucket.remove(t)

        task.add_done_callback(_done)

    async def drain(self, device_id: str) -> None:
        """R39 HIGH5: await every notification scheduled for ``device_id`` so
        far, including any that get scheduled while we're awaiting the first
        batch. Raises the first write failure encountered instead of
        swallowing it: a write failure means the caller (backend.run) must not
        report clean success.
        """
        while True:
            batch = list(self._pending.get(device_id) or ())
            with self._queued_lock:
                queued = self._queued.get(device_id, 0)
            if not batch:
                if not queued:
                    return
                # Writes queued from another thread whose tasks don't exist
                # yet: let the loop run their callbacks, then look again.
                await asyncio.sleep(0)
                continue
            results = await asyncio.gather(*batch, return_exceptions=True)
            # Everything in this batch is now accounted for, a failure included:
            # it is reported here, once.
            current = self._pending.get(device_id)
            if current is not None:
                for task in batch:
                    if task in current:
                        current.remove(task)
            failures = [r for r in results if isinstance(r, BaseException)]
            if failures:
                raise failures[0]
