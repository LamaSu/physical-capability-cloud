"""Async background runner — wraps the sync dlt run + status updates.

`run_pipeline_sync()` blocks for as long as the dlt pipeline takes (up to
hours for a large backfill). We run it inside `loop.run_in_executor()`
so the FastAPI request that kicked it off can return immediately with a
run_id, and the registry status is updated as the work progresses.

The timeout enforcement is asyncio.wait_for around the executor future;
on timeout we mark the pipeline failed with reason='timeout' and let dlt
finish naturally in the executor (we don't have a way to interrupt the
sync work safely; dlt isn't designed for cancel mid-flight). A future
improvement: switch to subprocess-isolated runs so we CAN kill them.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Optional

from loguru import logger

from .dlt_bridge import _DestinationHandle, _SourceHandle, run_pipeline_sync
from .registry import Registry


def _new_run_id() -> str:
    return f"run_{uuid.uuid4().hex[:12]}"


async def run_pipeline_async(
    *,
    registry: Registry,
    pipeline_id: str,
    source: _SourceHandle,
    destination: _DestinationHandle,
    name: str,
    dataset: str,
    table: Optional[str] = None,
    full_refresh: bool = False,
    storage_path: Optional[str] = None,
    timeout_seconds: int = 600,
) -> str:
    """Kick off a pipeline run in the background; return the run_id.

    The actual run happens in a background asyncio task — this function
    returns the moment the task is scheduled, not when the run completes.
    Status updates land on the registry record under `pipeline_id`.

    Returns:
        run_id (string) — unique id for this specific invocation. The
        registry's `last_run_id` field is updated to match.
    """
    run_id = _new_run_id()

    # Mark running BEFORE we spawn the task so a quick GET /status right
    # after returning sees status=running, not status=created.
    registry.update_pipeline_status(
        pipeline_id,
        status="running",
        last_run_id=run_id,
        error=None,
    )

    async def _do_run() -> None:
        loop = asyncio.get_running_loop()
        try:
            # asyncio.run_in_executor doesn't accept kwargs directly. We
            # wrap the sync call in a lambda so the keyword-only args on
            # run_pipeline_sync() (name, dataset, table, full_refresh,
            # storage_path) are bound at submission time.
            future = loop.run_in_executor(
                None,  # default ThreadPoolExecutor
                lambda: run_pipeline_sync(
                    source,
                    destination,
                    name=name,
                    dataset=dataset,
                    table=table,
                    full_refresh=full_refresh,
                    storage_path=storage_path,
                ),
            )
            result = await asyncio.wait_for(future, timeout=timeout_seconds)

            if result.error:
                logger.warning(
                    "pipeline {} run {} failed: {}", pipeline_id, run_id, result.error
                )
                registry.update_pipeline_status(
                    pipeline_id,
                    status="failed",
                    error=result.error,
                    rows_loaded=result.rows_loaded,
                    mark_completed=True,
                )
            else:
                logger.info(
                    "pipeline {} run {} completed: rows={} duration_ms={}",
                    pipeline_id,
                    run_id,
                    result.rows_loaded,
                    result.duration_ms,
                )
                registry.update_pipeline_status(
                    pipeline_id,
                    status="completed",
                    rows_loaded=result.rows_loaded,
                    mark_completed=True,
                )

        except asyncio.TimeoutError:
            logger.warning(
                "pipeline {} run {} timed out after {}s", pipeline_id, run_id, timeout_seconds
            )
            registry.update_pipeline_status(
                pipeline_id,
                status="failed",
                error=f"timeout: exceeded {timeout_seconds}s",
                mark_completed=True,
            )
        except Exception as e:  # noqa: BLE001 — final safety net for the runner task
            logger.exception("pipeline {} run {} crashed: {}", pipeline_id, run_id, e)
            registry.update_pipeline_status(
                pipeline_id,
                status="failed",
                error=f"runner_crash: {type(e).__name__}: {e}",
                mark_completed=True,
            )

    # Fire-and-forget. We don't keep the task — failures land in the
    # registry, which is the source of truth for status queries.
    asyncio.create_task(_do_run())

    return run_id


__all__ = ["run_pipeline_async"]
