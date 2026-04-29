"""Settings module — 12-factor configuration via pydantic-settings.

Required env vars are enforced at startup so a missing key produces a clear
error before the server takes its first call. Optional vars have sensible
defaults so a developer can run unit tests with mocks instead of real
API keys.

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


class VoiceOnboarderSettings(BaseSettings):
    """All runtime configuration for the voice-onboarder sidecar."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # ── PCC backend (the TS brain we proxy to) ────────────────────────────
    # PCC_API_KEY is REQUIRED — without it every backend tool call returns 401.
    pcc_base_url: str = Field(
        default="https://capability.network",
        description="PCC gateway URL. All onboard tools POST/GET here.",
    )
    pcc_api_key: str = Field(
        ...,  # required
        description="Bearer token for the PCC gateway. Get one from POST /api/auth/provision.",
    )

    # ── Sponsor STT/LLM/TTS keys ──────────────────────────────────────────
    # Required for the actual pipeline; tests mock these.
    deepgram_api_key: str = Field(
        default="",
        description="Deepgram API key for streaming STT. Required at runtime, optional for tests.",
    )
    anthropic_api_key: str = Field(
        default="",
        description="Anthropic API key for Claude tool-use. Required at runtime, optional for tests.",
    )
    cartesia_api_key: str = Field(
        default="",
        description="Cartesia API key for TTS. Required at runtime, optional for tests.",
    )
    cartesia_voice_id: str = Field(
        # `Sonic` stock voice — replace with the operator's preferred voice id.
        default="79a125e8-cd45-4c13-8a67-188112f4dd22",
        description="Cartesia voice id. Default is a Cartesia stock voice; pick a brand voice for production.",
    )

    # ── Twilio (telephony in/out) ─────────────────────────────────────────
    twilio_account_sid: str = Field(
        default="",
        description="Twilio Account SID. Required to validate inbound webhook signatures.",
    )
    twilio_auth_token: str = Field(
        default="",
        description="Twilio Auth Token. Required to validate inbound webhook signatures.",
    )
    twilio_phone_number: str = Field(
        default="",
        description="The Twilio number that callers dial. E.164 format, e.g. +16504480770.",
    )

    # ── Public webhook host (cloudflared tunnel URL) ──────────────────────
    webhook_host: str = Field(
        default="http://localhost:8765",
        description=(
            "Publicly-reachable host this server runs behind. Used to build the "
            "wss://... URL Twilio dials into via TwiML <Connect><Stream>. "
            "On Spark this is the cloudflared tunnel URL."
        ),
    )

    # ── Server runtime ────────────────────────────────────────────────────
    server_host: str = Field(default="0.0.0.0", description="ASGI bind host.")
    server_port: int = Field(default=8765, description="ASGI bind port.")
    log_level: str = Field(default="INFO", description="Log level: DEBUG/INFO/WARNING/ERROR.")

    # ── Pipeline tuning ───────────────────────────────────────────────────
    http_timeout_seconds: float = Field(
        default=30.0,
        description="Default httpx timeout for backend tool calls.",
    )
    max_tool_turns: int = Field(
        default=12,
        description="Max tool-use turns Claude can take per user utterance before forced summarisation.",
    )

    @field_validator("log_level")
    @classmethod
    def _normalize_log_level(cls, v: str) -> str:
        v_up = v.upper().strip()
        if v_up not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            return "INFO"
        return v_up

    @field_validator("webhook_host")
    @classmethod
    def _strip_trailing_slash(cls, v: str) -> str:
        return v.rstrip("/")

    @field_validator("pcc_base_url")
    @classmethod
    def _strip_trailing_slash_pcc(cls, v: str) -> str:
        return v.rstrip("/")


@lru_cache(maxsize=1)
def get_settings() -> VoiceOnboarderSettings:
    """Memoised settings accessor.

    Raises:
      pydantic.ValidationError if required fields (PCC_API_KEY) are missing
      from the environment AND the .env file. The error message names the
      missing field, e.g. "1 validation error … pcc_api_key Field required".
    """
    return VoiceOnboarderSettings()  # type: ignore[call-arg]


__all__ = ["VoiceOnboarderSettings", "get_settings", "ValidationError"]
