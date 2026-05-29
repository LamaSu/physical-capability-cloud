"""Evidence handler — Python ``logging.Handler`` that pushes PLR log records
out as JSON-RPC ``evidence`` notifications during a recording window.

Wired into the PLR root logger by the :class:`Server`. Outside an active
recording window the records are silently dropped (the TS adapter has no
job to attribute them to).
"""

from __future__ import annotations
import asyncio
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
        self.setFormatter(logging.Formatter("%(message)s"))

    # ── recording window lifecycle ─────────────────────────────────────────

    def start_recording(self, device_id: str, job_id: str) -> RecordingWindow:
        window = RecordingWindow(
            device_id=device_id,
            job_id=job_id,
            started_at=datetime.now(timezone.utc),
        )
        self._windows[device_id] = window
        return window

    def stop_recording(self, device_id: str, job_id: str) -> Optional[RecordingWindow]:
        window = self._windows.pop(device_id, None)
        return window

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
        )

    # ── private ────────────────────────────────────────────────────────────

    def attach_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Bind the asyncio event loop used to schedule notify-writes.

        Called by Server during startup so the synchronous ``logging.Handler``
        machinery has a way back to the running loop.
        """
        self._loop = loop

    def _schedule_notify(self, method: str, params: dict[str, Any]) -> None:
        if self._loop is None:
            return
        # logging may be called from threads; schedule the async write
        # threadsafely onto the running loop.
        try:
            self._loop.call_soon_threadsafe(
                lambda: self._loop.create_task(self._writer(method, params))
            )
        except RuntimeError:
            # Loop is closed — drop silently.
            pass
