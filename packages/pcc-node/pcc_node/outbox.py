"""Durable retry queue for terminal job status reports (r31 astra finding 7).

A terminal report ('failed' or 'completed') that the gateway does not
acknowledge used to be logged and dropped, which left the job non-terminal
upstream.  StatusOutbox keeps such reports on disk and retries them with
capped exponential backoff until the gateway acknowledges one, or until it is
too old to matter, when it gives up loudly.

Only terminal STATUS reports are queued.  Status updates are idempotent: the
same terminal status twice is harmless.  Evidence pushes are deliberately not
retried here: the gateway's evidence relay does not deduplicate, so a push
whose acknowledgement was lost could be stored twice.  The 'running' claim is
not queued either, because it must land before the device is touched.

The file is written atomically (temp file, fsync, rename).  Nothing is
touched on disk until there is something to store.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger("pcc-node.outbox")

TERMINAL_STATUSES = ("failed", "completed")

DEFAULT_BASE_DELAY_S = 5.0
DEFAULT_MAX_DELAY_S = 600.0
DEFAULT_MAX_AGE_S = 24 * 3600.0
DEFAULT_MAX_RECORDS = 500

ReportFn = Callable[[str, str, Optional[dict]], bool]


class StatusOutbox:
    """Terminal status reports waiting for the gateway's acknowledgement."""

    def __init__(
        self,
        path: str,
        *,
        clock: Callable[[], float] = time.time,
        base_delay_s: float = DEFAULT_BASE_DELAY_S,
        max_delay_s: float = DEFAULT_MAX_DELAY_S,
        max_age_s: float = DEFAULT_MAX_AGE_S,
        max_records: int = DEFAULT_MAX_RECORDS,
    ) -> None:
        self.path = path
        self._clock = clock
        self._base = base_delay_s
        self._max_delay = max_delay_s
        self._max_age = max_age_s
        self._max_records = max_records
        self._records: Optional[List[Dict[str, Any]]] = None  # loaded lazily

    # ── storage ─────────────────────────────────────────────────────────

    def _load(self) -> List[Dict[str, Any]]:
        if self._records is not None:
            return self._records
        records: List[Dict[str, Any]] = []
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if not isinstance(data, list):
                    raise ValueError("outbox file is not a list")
                records = [r for r in data if _valid_record(r)]
            except (OSError, ValueError) as exc:
                aside = f"{self.path}.corrupt-{int(self._clock())}"
                log.error(
                    "Status outbox %s is unreadable (%s); set aside as %s and starting empty",
                    self.path, exc, aside,
                )
                try:
                    os.replace(self.path, aside)
                except OSError:
                    pass
        self._records = records
        return records

    def _save(self) -> None:
        records = self._records or []
        directory = os.path.dirname(self.path) or "."
        os.makedirs(directory, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".outbox-", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(records, fh, sort_keys=True, default=str)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # ── queue ───────────────────────────────────────────────────────────

    def pending(self) -> List[Dict[str, Any]]:
        """A copy of the queued reports, oldest first."""
        return [dict(r) for r in self._load()]

    def enqueue(self, job_id: str, status: str, metadata: Optional[dict] = None) -> bool:
        """Queue a terminal report for retry.  False (logged) when it cannot be queued."""
        if status not in TERMINAL_STATUSES:
            raise ValueError(f"only terminal statuses are queued, not {status!r}")
        records = self._load()
        now = self._clock()
        for record in records:
            if record["jobId"] == job_id:
                if record["status"] != status:
                    log.warning(
                        "Job %s: replacing the queued %r report with %r",
                        job_id, record["status"], status,
                    )
                record.update(status=status, metadata=metadata, nextAttemptAt=now + self._base)
                self._save()
                return True
        if len(records) >= self._max_records:
            log.error(
                "Status outbox is full (%d reports); the %r report for job %s is NOT queued",
                len(records), status, job_id,
            )
            return False
        records.append({
            "jobId": job_id,
            "status": status,
            "metadata": metadata,
            "createdAt": now,
            "attempts": 0,
            "nextAttemptAt": now + self._base,
        })
        self._save()
        log.warning("Job %s: the %r report is queued for retry", job_id, status)
        return True

    def flush(self, report: ReportFn) -> int:
        """Retry every report that is due.  Returns how many were acknowledged."""
        records = self._load()
        if not records:
            return 0
        now = self._clock()
        delivered = 0
        changed = False
        kept: List[Dict[str, Any]] = []
        for record in records:
            if now - record["createdAt"] > self._max_age:
                log.error(
                    "Job %s: giving up on the %r report after %d attempts; the job "
                    "stays non-terminal upstream",
                    record["jobId"], record["status"], record["attempts"],
                )
                changed = True
                continue
            if record["nextAttemptAt"] > now:
                kept.append(record)
                continue
            try:
                ok = bool(report(record["jobId"], record["status"], record["metadata"]))
            except Exception as exc:  # the retry loop must survive a failing report
                log.warning("Job %s: report raised %s: %s", record["jobId"], type(exc).__name__, exc)
                ok = False
            changed = True
            if ok:
                delivered += 1
                log.info("Job %s: the queued %r report was acknowledged", record["jobId"], record["status"])
                continue
            record["attempts"] += 1
            delay = min(self._max_delay, self._base * (2 ** record["attempts"]))
            record["nextAttemptAt"] = now + delay
            kept.append(record)
        if changed:
            self._records = kept
            self._save()
        return delivered


def _valid_record(record: Any) -> bool:
    return (
        isinstance(record, dict)
        and isinstance(record.get("jobId"), str)
        and record.get("status") in TERMINAL_STATUSES
        and isinstance(record.get("createdAt"), (int, float))
        and isinstance(record.get("attempts"), int)
        and isinstance(record.get("nextAttemptAt"), (int, float))
        and (record.get("metadata") is None or isinstance(record.get("metadata"), dict))
    )
