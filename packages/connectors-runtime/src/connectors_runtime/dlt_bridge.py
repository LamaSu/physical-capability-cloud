"""dlt bridge — the only module that imports `dlt`.

We isolate dlt behind this thin facade so:
  1. Tests can mock the entire bridge with a single patch.
  2. The `dlt` package (heavy: brings sqlalchemy, pyarrow, etc.) is only
     loaded when an actual run kicks off, not on every health-check.
  3. If a future dlt major-version migration changes the API shape, only
     this file changes.

Design choice: `dlt` is imported INSIDE each function. Top-level imports
would defeat the lazy-load goal and make `import connectors_runtime` slow.

Supported sources:
  - postgres / sql_database -> dlt.sources.sql_database.sql_database
  - csv                    -> dlt.sources.filesystem (treated as a dlt resource)
  - salesforce / sharepoint / sap -> NotImplementedError in v0.1, returns a
    helpful error stub so the TS shell can verbalise "vendor connector not
    yet wired in this runtime version" instead of 500ing.

Supported destinations:
  - postgres   -> dlt.destinations.postgres
  - filesystem -> dlt.destinations.filesystem (parquet on local disk)
  - insforge   -> custom REST destination, lazy-implemented in v0.1 as
    "not yet wired" — Wave 4 picks this up after the InsForge SDK lands.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Optional


# ── Public dataclasses ────────────────────────────────────────────────────


@dataclass
class RunResult:
    """Outcome of a single pipeline.run()."""
    rows_loaded: int
    schema_changes: int
    duration_ms: int
    error: Optional[str] = None


@dataclass
class _SourceHandle:
    """Opaque handle wrapping a dlt source. Pickled on a per-pipeline
    basis so the runner can pass it across the asyncio→thread boundary."""
    kind: str
    factory: Any  # Callable -> dlt.Resource | dlt.Source


@dataclass
class _DestinationHandle:
    kind: str
    factory: Any


# ── Public API ────────────────────────────────────────────────────────────


SUPPORTED_SOURCE_KINDS = {"postgres", "sql_database", "salesforce", "sharepoint", "sap", "csv"}
SUPPORTED_DESTINATION_KINDS = {"postgres", "filesystem", "insforge"}


def make_source(kind: str, config: dict[str, Any]) -> _SourceHandle:
    """Build a dlt source handle for `kind` from `config`.

    Args:
        kind: one of SUPPORTED_SOURCE_KINDS.
        config: kind-specific configuration (e.g. for postgres:
            `{credentials: "postgresql://...", table_names: ["..."], schema: "public"}`).

    Returns:
        A `_SourceHandle` whose `factory` is a zero-arg callable that
        produces the actual dlt source/resource at run time.

    Raises:
        ValueError: when `kind` isn't supported.
        NotImplementedError: when `kind` is in SUPPORTED_SOURCE_KINDS but
            the v0.1 runtime hasn't wired the vendor SDK yet (salesforce,
            sharepoint, sap). The caller should surface this as a 501.
    """
    if kind not in SUPPORTED_SOURCE_KINDS:
        raise ValueError(f"unsupported source kind: {kind!r} (allowed: {sorted(SUPPORTED_SOURCE_KINDS)})")

    if kind in {"postgres", "sql_database"}:
        # Both kinds map to dlt's sql_database verified source. `postgres`
        # is just a friendlier alias for the common case.
        def _factory() -> Any:
            from dlt.sources.sql_database import sql_database  # type: ignore[import-not-found]
            return sql_database(
                credentials=config.get("credentials"),
                schema=config.get("schema"),
                table_names=config.get("table_names"),
                metadata=config.get("metadata"),
            )

        return _SourceHandle(kind=kind, factory=_factory)

    if kind == "csv":
        def _factory() -> Any:
            # `dlt.sources.filesystem` reads a directory of files; for a
            # single CSV the orchestrator passes the directory + file_glob.
            from dlt.sources.filesystem import filesystem  # type: ignore[import-not-found]
            return filesystem(
                bucket_url=config.get("bucket_url") or config.get("path"),
                file_glob=config.get("file_glob", "*.csv"),
            )

        return _SourceHandle(kind=kind, factory=_factory)

    # Vendor connectors that need their SDK wired in a follow-up.
    if kind in {"salesforce", "sharepoint", "sap"}:
        raise NotImplementedError(
            f"source kind {kind!r} is recognised but not wired in v0.1; "
            f"connectors-runtime ships postgres/sql_database/csv only. "
            f"Track Wave 4 for vendor-SDK wiring."
        )

    # Defensive — should be unreachable given the membership check above.
    raise ValueError(f"unhandled source kind: {kind!r}")


def make_destination(kind: str, config: dict[str, Any]) -> _DestinationHandle:
    """Build a dlt destination handle for `kind` from `config`."""
    if kind not in SUPPORTED_DESTINATION_KINDS:
        raise ValueError(
            f"unsupported destination kind: {kind!r} (allowed: {sorted(SUPPORTED_DESTINATION_KINDS)})"
        )

    if kind == "postgres":
        def _factory() -> Any:
            import dlt  # type: ignore[import-not-found]
            return dlt.destinations.postgres(credentials=config.get("credentials"))

        return _DestinationHandle(kind=kind, factory=_factory)

    if kind == "filesystem":
        def _factory() -> Any:
            import dlt  # type: ignore[import-not-found]
            return dlt.destinations.filesystem(bucket_url=config.get("bucket_url") or config.get("path"))

        return _DestinationHandle(kind=kind, factory=_factory)

    if kind == "insforge":
        raise NotImplementedError(
            "destination kind 'insforge' is recognised but not wired in v0.1; "
            "connectors-runtime ships postgres/filesystem only. "
            "Track Wave 4 for the InsForge custom destination."
        )

    raise ValueError(f"unhandled destination kind: {kind!r}")


def run_pipeline_sync(
    source: _SourceHandle,
    destination: _DestinationHandle,
    *,
    name: str,
    dataset: str,
    table: Optional[str] = None,
    full_refresh: bool = False,
    storage_path: Optional[str] = None,
) -> RunResult:
    """Build a dlt pipeline and run it synchronously to completion.

    This is the only function that actually invokes dlt. The runner module
    wraps this in a `run_in_executor` call so it can be awaited from the
    FastAPI request loop without blocking.

    Args:
        source: handle from `make_source()`.
        destination: handle from `make_destination()`.
        name: pipeline name (becomes a directory under storage_path).
        dataset: target dataset (schema in postgres, top-level dir in fs).
        table: optional target table name override (per-resource setting
            in dlt; if None, dlt picks the resource's own name).
        full_refresh: pass-through to dlt; True drops & reloads.
        storage_path: optional dlt pipelines_dir override.

    Returns:
        RunResult with row count, schema change count, duration. On dlt
        failure the run is converted to a RunResult with .error set; we
        never raise from this function so the caller can treat it as data.
    """
    started_at = time.monotonic()
    try:
        import dlt  # type: ignore[import-not-found]
    except ImportError as e:
        return RunResult(
            rows_loaded=0,
            schema_changes=0,
            duration_ms=int((time.monotonic() - started_at) * 1000),
            error=f"dlt_not_installed: {e}",
        )

    try:
        kwargs: dict[str, Any] = {
            "pipeline_name": name,
            "destination": destination.factory(),
            "dataset_name": dataset,
        }
        if storage_path:
            kwargs["pipelines_dir"] = storage_path
        if full_refresh:
            kwargs["full_refresh"] = True

        pipeline = dlt.pipeline(**kwargs)
        source_obj = source.factory()

        # Per-table override is set on the resource, not the run call.
        # If a `table` was given, attempt to apply it; dlt sources expose
        # `with_resources` differently across kinds, so we apply this
        # opportunistically and fall through if the source doesn't support it.
        if table is not None:
            apply_hints = getattr(source_obj, "apply_hints", None)
            if callable(apply_hints):
                try:
                    apply_hints(table_name=table)
                except Exception:
                    # Not all dlt sources accept a table override — fine.
                    pass

        info = pipeline.run(source_obj)

        # `info.metrics` is a per-load dict; we sum row counts across loads.
        rows_loaded = 0
        schema_changes = 0
        try:
            metrics_list = getattr(info, "metrics", None) or []
            for m in metrics_list:
                # metrics shape: {'job_metrics': {...}, ...} -- be tolerant.
                rl = m.get("rows_loaded") if isinstance(m, dict) else None
                if isinstance(rl, int):
                    rows_loaded += rl
            schema_changes = len(getattr(info, "schema_changes", []) or [])
        except Exception:
            # Metrics extraction is best-effort; the run already succeeded.
            pass

        return RunResult(
            rows_loaded=rows_loaded,
            schema_changes=schema_changes,
            duration_ms=int((time.monotonic() - started_at) * 1000),
        )

    except Exception as e:  # noqa: BLE001 — we genuinely want any dlt failure as data
        return RunResult(
            rows_loaded=0,
            schema_changes=0,
            duration_ms=int((time.monotonic() - started_at) * 1000),
            error=f"{type(e).__name__}: {e}",
        )


def get_dlt_version() -> str:
    """Return the installed dlt version string, or 'not-installed'."""
    try:
        import dlt  # type: ignore[import-not-found]
        return getattr(dlt, "__version__", "unknown")
    except ImportError:
        return "not-installed"


__all__ = [
    "RunResult",
    "SUPPORTED_SOURCE_KINDS",
    "SUPPORTED_DESTINATION_KINDS",
    "make_source",
    "make_destination",
    "run_pipeline_sync",
    "get_dlt_version",
]
