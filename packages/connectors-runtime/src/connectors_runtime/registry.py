"""In-memory registry for sources, destinations, and pipelines.

Wave 3 ships an in-memory dict-backed registry. Wave 4 will persist
sources/destinations/pipelines to PCC's existing Postgres so a runtime
restart doesn't lose state. Until then the systemd unit's `Restart=always`
+ pipelines being recreated by the orchestrator on demand is the recovery
story; callers should treat the runtime as ephemeral state.

Thread-safety: every public method takes `_lock` because FastAPI runs
endpoints in a thread pool when they're sync, and the runner module
mutates pipeline status from a background asyncio task. The lock is a
plain threading.Lock — short critical sections only.

NOTE: Postgres persistence is Wave 4. Document any new fields here so the
migration to a SQL schema is mechanical.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional


# ── ID helpers ────────────────────────────────────────────────────────────
# Short prefixed ids so ops can tell at a glance what kind of object an id
# refers to. 12-char uuid suffix is plenty of entropy for an in-memory map.


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


# ── Records ───────────────────────────────────────────────────────────────


@dataclass
class SourceRecord:
    id: str
    kind: str  # "postgres" | "sql_database" | "salesforce" | "sharepoint" | "sap" | "csv"
    config: dict[str, Any]  # raw caller-provided config (credentials redacted in summary)
    config_summary: dict[str, Any]  # safe-to-return view, no secrets
    created_at: float


@dataclass
class DestinationRecord:
    id: str
    kind: str  # "postgres" | "filesystem" | "insforge"
    config: dict[str, Any]
    config_summary: dict[str, Any]
    created_at: float


@dataclass
class PipelineRecord:
    id: str
    name: str
    source_id: str
    destination_id: str
    dataset_name: str
    table_name: Optional[str] = None
    status: str = "created"  # "created" | "running" | "completed" | "failed"
    last_run_id: Optional[str] = None
    last_completed_at: Optional[float] = None
    rows_loaded: Optional[int] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)


# ── Registry ──────────────────────────────────────────────────────────────


class Registry:
    """Thread-safe in-memory store for all three entity kinds."""

    def __init__(self) -> None:
        self._sources: dict[str, SourceRecord] = {}
        self._destinations: dict[str, DestinationRecord] = {}
        self._pipelines: dict[str, PipelineRecord] = {}
        self._lock = threading.Lock()

    # ── sources ─────────────────────────────────────────────────────────

    def add_source(self, kind: str, config: dict[str, Any], config_summary: dict[str, Any]) -> SourceRecord:
        with self._lock:
            sid = _new_id("src")
            rec = SourceRecord(
                id=sid,
                kind=kind,
                config=config,
                config_summary=config_summary,
                created_at=time.time(),
            )
            self._sources[sid] = rec
            return rec

    def get_source(self, source_id: str) -> Optional[SourceRecord]:
        with self._lock:
            return self._sources.get(source_id)

    def list_sources(self) -> list[SourceRecord]:
        with self._lock:
            return list(self._sources.values())

    # ── destinations ────────────────────────────────────────────────────

    def add_destination(self, kind: str, config: dict[str, Any], config_summary: dict[str, Any]) -> DestinationRecord:
        with self._lock:
            did = _new_id("dst")
            rec = DestinationRecord(
                id=did,
                kind=kind,
                config=config,
                config_summary=config_summary,
                created_at=time.time(),
            )
            self._destinations[did] = rec
            return rec

    def get_destination(self, destination_id: str) -> Optional[DestinationRecord]:
        with self._lock:
            return self._destinations.get(destination_id)

    def list_destinations(self) -> list[DestinationRecord]:
        with self._lock:
            return list(self._destinations.values())

    # ── pipelines ───────────────────────────────────────────────────────

    def add_pipeline(
        self,
        name: str,
        source_id: str,
        destination_id: str,
        dataset_name: str,
        table_name: Optional[str] = None,
    ) -> PipelineRecord:
        with self._lock:
            pid = _new_id("pl")
            rec = PipelineRecord(
                id=pid,
                name=name,
                source_id=source_id,
                destination_id=destination_id,
                dataset_name=dataset_name,
                table_name=table_name,
            )
            self._pipelines[pid] = rec
            return rec

    def get_pipeline(self, pipeline_id: str) -> Optional[PipelineRecord]:
        with self._lock:
            return self._pipelines.get(pipeline_id)

    def list_pipelines(self) -> list[PipelineRecord]:
        with self._lock:
            return list(self._pipelines.values())

    def delete_pipeline(self, pipeline_id: str) -> bool:
        with self._lock:
            return self._pipelines.pop(pipeline_id, None) is not None

    def update_pipeline_status(
        self,
        pipeline_id: str,
        *,
        status: Optional[str] = None,
        last_run_id: Optional[str] = None,
        rows_loaded: Optional[int] = None,
        error: Optional[str] = None,
        mark_completed: bool = False,
    ) -> Optional[PipelineRecord]:
        """Atomically mutate run-state fields. Returns the updated record
        or None if the pipeline id is unknown."""
        with self._lock:
            rec = self._pipelines.get(pipeline_id)
            if rec is None:
                return None
            if status is not None:
                rec.status = status
            if last_run_id is not None:
                rec.last_run_id = last_run_id
            if rows_loaded is not None:
                rec.rows_loaded = rows_loaded
            if error is not None:
                rec.error = error
            if mark_completed:
                rec.last_completed_at = time.time()
            return rec

    # ── stats ───────────────────────────────────────────────────────────

    def n_running(self) -> int:
        with self._lock:
            return sum(1 for p in self._pipelines.values() if p.status == "running")

    def n_pipelines(self) -> int:
        with self._lock:
            return len(self._pipelines)


# Process-wide singleton. The server module imports this directly. Tests
# that need isolation can construct their own Registry() and inject it
# into the FastAPI app via dependency overrides.
default_registry = Registry()


__all__ = [
    "Registry",
    "SourceRecord",
    "DestinationRecord",
    "PipelineRecord",
    "default_registry",
]
