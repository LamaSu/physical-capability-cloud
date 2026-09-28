"""Durable registry of accepted jobs awaiting device-reported completion.

JobExecutor tracks the jobs a device ACCEPTED -- an ``lp`` spool, an
OctoPrint print of the job's private copy -- until the device reports their
outcome.  Kept only in memory, a daemon restart forgot them, and they stayed
"running" upstream with nobody watching (r31 round-1 verdict, "Existing
dependencies": "a restart can strand a running job").  AwaitingStore keeps
them on disk, so a restarted daemon resumes observing where it stopped.

What is stored is PUBLIC: the job id and its evidence binding, the device
id, the completion kind, the handle (IPP printer host, queue and job id;
OctoPrint base URL, copy path and baseline) and the deadline.  Never the
device record itself, which can hold a credential (an OctoPrint API key): on
load the device is looked up again by id in the node's own configuration.

Deadlines are wall-clock times, because a monotonic clock restarts with the
machine.  A wall-clock jump can shorten or lengthen a budget; budgets are
clamped by the executor, and an expired record is dropped without a status,
never reported.

The file is written atomically (temp file, fsync, rename).  An unreadable
file is set aside as ``<path>.corrupt-<time>`` and the store starts empty,
as StatusOutbox does: losing the registry strands jobs (they stay
"running"), which is the safe side; reading a corrupt one could report them.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger("pcc-node.awaiting")

AWAITING_KINDS = ("ipp", "octoprint")


class AwaitingStore:
    """Accepted jobs whose device-reported outcome is still to be observed."""

    def __init__(self, path: str, *, clock: Callable[[], float] = time.time) -> None:
        self.path = path
        self._clock = clock
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
                    raise ValueError("awaiting registry file is not a list")
                for record in data:
                    if valid_record(record):
                        records.append(record)
                    else:
                        log.error("Awaiting registry %s: dropping a malformed record %r", self.path, record)
            except (OSError, ValueError) as exc:
                aside = f"{self.path}.corrupt-{int(self._clock())}"
                log.error(
                    "Awaiting registry %s is unreadable (%s); set aside as %s and starting "
                    "empty -- the jobs it held stay 'running' upstream",
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
        fd, tmp = tempfile.mkstemp(prefix=".awaiting-", dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(records, fh, sort_keys=True)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    # ── registry ────────────────────────────────────────────────────────

    def records(self) -> List[Dict[str, Any]]:
        """A copy of every stored record."""
        return [dict(r) for r in self._load()]

    def put(self, record: Dict[str, Any]) -> None:
        """Store ``record`` (replacing one for the same job).  Raises ValueError
        for a malformed record and OSError when the file cannot be written."""
        if not valid_record(record):
            raise ValueError(f"not a storable awaiting record: {record!r}")
        records = [r for r in self._load() if r["jobId"] != record["jobId"]]
        records.append(dict(record))
        self._records = records
        self._save()

    def remove(self, job_id: str) -> None:
        """Forget ``job_id``.  Raises OSError when the file cannot be written."""
        records = self._load()
        kept = [r for r in records if r["jobId"] != job_id]
        if len(kept) != len(records):
            self._records = kept
            self._save()


def valid_record(record: Any) -> bool:
    """A record this store can hold: public fields only, well typed."""
    if not isinstance(record, dict):
        return False
    if set(record) != {"jobId", "binding", "deviceId", "kind", "handle", "acceptedAt", "deadline"}:
        return False
    return (
        isinstance(record["jobId"], str) and bool(record["jobId"])
        and isinstance(record["binding"], dict)
        and record["binding"].get("jobId") == record["jobId"]
        and all(isinstance(k, str) and isinstance(v, str) for k, v in record["binding"].items())
        and isinstance(record["deviceId"], str) and bool(record["deviceId"])
        and record["kind"] in AWAITING_KINDS
        and isinstance(record["handle"], dict)
        and all(
            isinstance(record[key], (int, float)) and not isinstance(record[key], bool)
            for key in ("acceptedAt", "deadline")
        )
    )
