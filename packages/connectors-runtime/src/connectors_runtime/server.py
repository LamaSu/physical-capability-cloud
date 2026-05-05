"""FastAPI server — REST API for the connectors runtime.

Endpoints (all JSON in/out):

  GET  /health
       Liveness + dlt version + registry stats.

  POST /sources
       body: {kind, config}
       Validates `kind` against dlt_bridge.SUPPORTED_SOURCE_KINDS,
       constructs a source handle (or 501 if vendor SDK isn't wired),
       stores it, returns {source_id, kind, config_summary, ready}.

  GET  /sources/{id}
       Returns the source's safe summary, or 404.

  POST /destinations
       body: {kind, config}
       Mirrors /sources for destinations.

  GET  /destinations/{id}
       Returns the destination's safe summary, or 404.

  POST /pipelines
       body: {name, source_id, destination_id, dataset_name, table_name?}
       Creates a pipeline definition, status = 'created'. Doesn't run.

  POST /pipelines/{id}/run
       body (optional): {full_refresh?, table_name?}
       Spawns the background runner; returns immediately with run_id.

  GET  /pipelines/{id}/status
       Current pipeline status snapshot.

  GET  /pipelines
       List all pipeline definitions.

  DELETE /pipelines/{id}
       Only honored when settings.enable_destroy_endpoint is True.

The TS shells under @pcc/connectors-* call these endpoints; the gateway
proxy at /api/connectors/* (Wave 4) forwards public traffic.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import PlainTextResponse
from loguru import logger
from pydantic import BaseModel, Field

from .config import ConnectorsRuntimeSettings, get_settings
from . import dlt_bridge
from .registry import Registry, default_registry
from .runner import run_pipeline_async


# ── Request bodies ────────────────────────────────────────────────────────


class _CreateSourceBody(BaseModel):
    kind: str = Field(..., description="Source kind (postgres, sql_database, csv, ...).")
    config: dict[str, Any] = Field(default_factory=dict, description="Source-specific config (credentials, table_names, ...).")


class _CreateDestinationBody(BaseModel):
    kind: str = Field(..., description="Destination kind (postgres, filesystem, insforge).")
    config: dict[str, Any] = Field(default_factory=dict, description="Destination-specific config.")


class _CreatePipelineBody(BaseModel):
    name: str
    source_id: str
    destination_id: str
    dataset_name: str
    table_name: Optional[str] = None


class _RunPipelineBody(BaseModel):
    full_refresh: bool = False
    table_name: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────


_SECRET_KEY_HINTS = {"credentials", "api_key", "apikey", "password", "token", "secret"}


def _summarise_config(config: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of `config` with secret-looking fields redacted.

    Heuristic — any key whose lowercased name contains a hint from
    `_SECRET_KEY_HINTS` is replaced with the marker `'<redacted>'`. This
    is a safe-by-default summary returned to GETs and listings; the
    full config stays in the registry for the dlt bridge to use at run time.
    """
    out: dict[str, Any] = {}
    for k, v in config.items():
        kl = k.lower()
        if any(hint in kl for hint in _SECRET_KEY_HINTS):
            out[k] = "<redacted>"
        elif isinstance(v, dict):
            out[k] = _summarise_config(v)
        else:
            out[k] = v
    return out


# ── App factory ───────────────────────────────────────────────────────────


def create_app(
    settings: Optional[ConnectorsRuntimeSettings] = None,
    registry: Optional[Registry] = None,
) -> FastAPI:
    """Build the FastAPI app. Factory pattern so tests can swap settings
    AND swap the registry (for isolation between cases).
    """
    settings = settings or get_settings()
    registry = registry or default_registry

    app = FastAPI(
        title="pcc-connectors-runtime",
        version="0.1.0",
        description="REST API wrapping dlt for PCC's TS connector shells.",
    )

    # ── /health ────────────────────────────────────────────────────────

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "pcc-connectors-runtime",
            "dlt_version": dlt_bridge.get_dlt_version(),
            "n_pipelines": registry.n_pipelines(),
            "n_running": registry.n_running(),
        }

    # ── /sources ────────────────────────────────────────────────────────

    @app.post("/sources")
    async def create_source(body: _CreateSourceBody) -> dict[str, Any]:
        try:
            # Build the source handle to validate kind + config shape now,
            # rather than discovering invalid configs at run time. We
            # discard the handle — make_source is cheap.
            dlt_bridge.make_source(body.kind, body.config)
        except NotImplementedError as e:
            raise HTTPException(status_code=501, detail={"error": "vendor_sdk_not_wired", "message": str(e)})
        except ValueError as e:
            raise HTTPException(status_code=400, detail={"error": "invalid_kind", "message": str(e)})

        summary = _summarise_config(body.config)
        rec = registry.add_source(body.kind, body.config, summary)
        logger.info("source created: id={} kind={}", rec.id, rec.kind)
        return {
            "source_id": rec.id,
            "kind": rec.kind,
            "config_summary": rec.config_summary,
            "ready": True,
        }

    @app.get("/sources/{source_id}")
    async def get_source(source_id: str) -> dict[str, Any]:
        rec = registry.get_source(source_id)
        if rec is None:
            raise HTTPException(status_code=404, detail={"error": "source_not_found", "source_id": source_id})
        return {
            "source_id": rec.id,
            "kind": rec.kind,
            "config_summary": rec.config_summary,
            "ready": True,
        }

    # ── /destinations ───────────────────────────────────────────────────

    @app.post("/destinations")
    async def create_destination(body: _CreateDestinationBody) -> dict[str, Any]:
        try:
            dlt_bridge.make_destination(body.kind, body.config)
        except NotImplementedError as e:
            raise HTTPException(status_code=501, detail={"error": "vendor_sdk_not_wired", "message": str(e)})
        except ValueError as e:
            raise HTTPException(status_code=400, detail={"error": "invalid_kind", "message": str(e)})

        summary = _summarise_config(body.config)
        rec = registry.add_destination(body.kind, body.config, summary)
        logger.info("destination created: id={} kind={}", rec.id, rec.kind)
        return {
            "destination_id": rec.id,
            "kind": rec.kind,
            "config_summary": rec.config_summary,
        }

    @app.get("/destinations/{destination_id}")
    async def get_destination(destination_id: str) -> dict[str, Any]:
        rec = registry.get_destination(destination_id)
        if rec is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "destination_not_found", "destination_id": destination_id},
            )
        return {
            "destination_id": rec.id,
            "kind": rec.kind,
            "config_summary": rec.config_summary,
        }

    # ── /pipelines ──────────────────────────────────────────────────────

    @app.post("/pipelines")
    async def create_pipeline(body: _CreatePipelineBody) -> dict[str, Any]:
        # Validate referenced source + destination exist before creating
        # the pipeline record — saves a 500 deep in the runner.
        if registry.get_source(body.source_id) is None:
            raise HTTPException(
                status_code=400,
                detail={"error": "source_not_found", "source_id": body.source_id},
            )
        if registry.get_destination(body.destination_id) is None:
            raise HTTPException(
                status_code=400,
                detail={"error": "destination_not_found", "destination_id": body.destination_id},
            )

        rec = registry.add_pipeline(
            name=body.name,
            source_id=body.source_id,
            destination_id=body.destination_id,
            dataset_name=body.dataset_name,
            table_name=body.table_name,
        )
        logger.info(
            "pipeline created: id={} name={} src={} dst={}",
            rec.id,
            rec.name,
            rec.source_id,
            rec.destination_id,
        )
        return {
            "pipeline_id": rec.id,
            "name": rec.name,
            "source_id": rec.source_id,
            "destination_id": rec.destination_id,
            "dataset_name": rec.dataset_name,
            "table_name": rec.table_name,
            "status": rec.status,
        }

    @app.get("/pipelines")
    async def list_pipelines() -> dict[str, Any]:
        return {
            "pipelines": [
                {
                    "pipeline_id": p.id,
                    "name": p.name,
                    "source_id": p.source_id,
                    "destination_id": p.destination_id,
                    "dataset_name": p.dataset_name,
                    "table_name": p.table_name,
                    "status": p.status,
                    "last_run_id": p.last_run_id,
                    "last_completed_at": p.last_completed_at,
                    "rows_loaded": p.rows_loaded,
                    "error": p.error,
                }
                for p in registry.list_pipelines()
            ],
        }

    @app.post("/pipelines/{pipeline_id}/run")
    async def run_pipeline(pipeline_id: str, body: Optional[_RunPipelineBody] = None) -> dict[str, Any]:
        body = body or _RunPipelineBody()
        rec = registry.get_pipeline(pipeline_id)
        if rec is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "pipeline_not_found", "pipeline_id": pipeline_id},
            )
        if rec.status == "running":
            raise HTTPException(
                status_code=409,
                detail={"error": "pipeline_already_running", "pipeline_id": pipeline_id, "last_run_id": rec.last_run_id},
            )

        src_rec = registry.get_source(rec.source_id)
        dst_rec = registry.get_destination(rec.destination_id)
        if src_rec is None or dst_rec is None:
            # Should have been caught at create time; defensive check.
            raise HTTPException(
                status_code=409,
                detail={
                    "error": "pipeline_dependencies_missing",
                    "source_present": src_rec is not None,
                    "destination_present": dst_rec is not None,
                },
            )

        try:
            source = dlt_bridge.make_source(src_rec.kind, src_rec.config)
            destination = dlt_bridge.make_destination(dst_rec.kind, dst_rec.config)
        except (NotImplementedError, ValueError) as e:
            raise HTTPException(
                status_code=409,
                detail={"error": "factory_unavailable", "message": str(e)},
            )

        run_id = await run_pipeline_async(
            registry=registry,
            pipeline_id=pipeline_id,
            source=source,
            destination=destination,
            name=rec.name,
            dataset=rec.dataset_name,
            table=body.table_name or rec.table_name,
            full_refresh=body.full_refresh,
            storage_path=settings.storage_path or None,
            timeout_seconds=settings.max_pipeline_seconds,
        )

        return {
            "pipeline_id": pipeline_id,
            "run_id": run_id,
            "status": "running",
        }

    @app.get("/pipelines/{pipeline_id}/status")
    async def pipeline_status(pipeline_id: str) -> dict[str, Any]:
        rec = registry.get_pipeline(pipeline_id)
        if rec is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "pipeline_not_found", "pipeline_id": pipeline_id},
            )
        return {
            "pipeline_id": rec.id,
            "name": rec.name,
            "status": rec.status,
            "last_run_id": rec.last_run_id,
            "last_completed_at": rec.last_completed_at,
            "rows_loaded": rec.rows_loaded,
            "error": rec.error,
        }

    @app.delete("/pipelines/{pipeline_id}")
    async def delete_pipeline(pipeline_id: str) -> dict[str, Any]:
        if not settings.enable_destroy_endpoint:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "destroy_endpoint_disabled",
                    "message": (
                        "Set ENABLE_DESTROY_ENDPOINT=true on the runtime to "
                        "permit pipeline deletion. Off by default."
                    ),
                },
            )
        if registry.get_pipeline(pipeline_id) is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "pipeline_not_found", "pipeline_id": pipeline_id},
            )
        registry.delete_pipeline(pipeline_id)
        return {"pipeline_id": pipeline_id, "deleted": True}

    @app.get("/")
    async def root() -> PlainTextResponse:
        return PlainTextResponse(
            "pcc-connectors-runtime. See /health for status. REST API: "
            "/sources, /destinations, /pipelines."
        )

    return app


# Module-level app for `uvicorn connectors_runtime.server:app`.
# Constructed lazily by main() so tests use create_app(test_settings) directly.
app: Optional[FastAPI] = None


def main() -> None:
    """Entry point for `pcc-connectors-runtime` CLI script.

    Loads settings, builds the app, runs uvicorn. Used by the systemd
    unit on Spark.
    """
    import uvicorn

    settings = get_settings()
    logger.info(
        "connectors-runtime starting | host={} | port={} | storage={}",
        settings.listen_host,
        settings.listen_port,
        settings.storage_path,
    )
    app_instance = create_app(settings)
    uvicorn.run(
        app_instance,
        host=settings.listen_host,
        port=settings.listen_port,
        log_level=settings.log_level.lower(),
    )


__all__ = ["create_app", "main", "app"]
