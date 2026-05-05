"""Settings module — 12-factor configuration via pydantic-settings.

The runtime resolves destinations (Postgres URLs, InsForge tokens, etc.)
at pipeline-create time, not startup, so destination credentials are NOT
required env vars here. Only the operational knobs are.

Loading order (lowest-to-highest precedence):
  1. defaults declared on the model
  2. .env file in the cwd (loaded by python-dotenv via pydantic-settings)
  3. real environment variables

Use `get_settings()` everywhere — it's lru_cached so the env is read once
per process. Tests should call `get_settings.cache_clear()` between cases
that mutate `os.environ`.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic import Field, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConnectorsRuntimeSettings(BaseSettings):
    """All runtime configuration for the connectors-runtime sidecar."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── Server runtime ────────────────────────────────────────────────────
    listen_host: str = Field(
        default="127.0.0.1",
        description=(
            "ASGI bind host. Default loopback — the gateway proxy or local TS "
            "shell on the same Spark box is the expected caller. Use 0.0.0.0 "
            "only behind a network policy / wireguard."
        ),
    )
    listen_port: int = Field(default=8766, description="ASGI bind port.")
    log_level: str = Field(default="INFO", description="Log level: DEBUG/INFO/WARNING/ERROR.")

    # ── Storage / staging ─────────────────────────────────────────────────
    storage_path: str = Field(
        default="/var/lib/pcc/connectors",
        description=(
            "Base directory where pipeline state, schemas, and load packages "
            "are written. Each pipeline gets a subdirectory named after its id. "
            "On Spark the systemd unit ensures this exists & is writable."
        ),
    )
    dlt_staging_path: str = Field(
        default="",
        description=(
            "Optional override for dlt's staging directory (where parquet/jsonl "
            "load packages land before the destination commit). Empty means "
            "dlt picks a sibling of storage_path. Useful when staging needs "
            "to be on a faster disk than the durable state."
        ),
    )

    # ── Pipeline tuning ───────────────────────────────────────────────────
    max_pipeline_seconds: int = Field(
        default=600,
        description=(
            "Hard ceiling for a single pipeline.run(). Prevents a runaway "
            "Salesforce backfill from holding a worker forever. Enforced by "
            "the runner (asyncio.wait_for); on timeout the run is marked "
            "failed with reason='timeout'."
        ),
    )

    # ── Safety: destroy endpoint guard ────────────────────────────────────
    enable_destroy_endpoint: bool = Field(
        default=False,
        description=(
            "DELETE /pipelines/{id} returns 403 unless this is True. Off by "
            "default because dropping a pipeline definition can cascade into "
            "lost staging data. Operations explicitly opt-in per environment."
        ),
    )

    # ── Optional destination defaults ─────────────────────────────────────
    # Real credentials are passed per-pipeline-create. These defaults are
    # purely a convenience for single-tenant deployments where one InsForge
    # / Postgres lives behind every connector.
    insforge_base_url: str = Field(default="", description="Default InsForge base URL when destination kind=insforge omits one.")
    insforge_api_key: str = Field(default="", description="Default InsForge API key. Per-pipeline overrides take precedence.")

    @field_validator("log_level")
    @classmethod
    def _normalize_log_level(cls, v: str) -> str:
        v_up = v.upper().strip()
        if v_up not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            return "INFO"
        return v_up

    @field_validator("storage_path", "dlt_staging_path")
    @classmethod
    def _strip_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/").rstrip("\\")


@lru_cache(maxsize=1)
def get_settings() -> ConnectorsRuntimeSettings:
    """Memoised settings accessor.

    Raises:
      pydantic.ValidationError if a required field can't be parsed. All
      fields have defaults right now, but adding a required field later
      will surface its absence here at first call rather than mid-request.
    """
    return ConnectorsRuntimeSettings()  # type: ignore[call-arg]


__all__ = ["ConnectorsRuntimeSettings", "get_settings", "ValidationError"]
