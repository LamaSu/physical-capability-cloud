"""Settings tests — verify env loading + required-field enforcement."""

from __future__ import annotations

import os

import pytest
from pydantic import ValidationError

from voice_onboarder.config import VoiceOnboarderSettings, get_settings


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    """Reset the lru_cache before AND after each test so env mutations
    actually re-run the validator instead of returning a stale cached
    Settings instance."""
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_settings_load_with_all_required_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    """Happy path — required field present, optional fields take defaults."""
    monkeypatch.setenv("PCC_API_KEY", "pcc_live_test_abc123")
    monkeypatch.delenv("PCC_BASE_URL", raising=False)
    monkeypatch.delenv("WEBHOOK_HOST", raising=False)

    settings = get_settings()

    assert settings.pcc_api_key == "pcc_live_test_abc123"
    # Default base url
    assert settings.pcc_base_url == "https://capability.network"
    # Default cartesia voice id is non-empty
    assert settings.cartesia_voice_id
    # Default port
    assert settings.server_port == 8765


def test_settings_missing_pcc_api_key_raises(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """If PCC_API_KEY is missing AND no .env exists, validation fails with
    a clear pointer at the missing field."""
    monkeypatch.delenv("PCC_API_KEY", raising=False)
    # Run from a tmp dir so any local .env doesn't leak into the test.
    monkeypatch.chdir(tmp_path)
    with pytest.raises(ValidationError) as exc_info:
        VoiceOnboarderSettings()  # type: ignore[call-arg]
    err_str = str(exc_info.value).lower()
    assert "pcc_api_key" in err_str


def test_settings_strip_trailing_slashes(monkeypatch: pytest.MonkeyPatch) -> None:
    """URLs with trailing slashes get normalised so httpx joins cleanly."""
    monkeypatch.setenv("PCC_API_KEY", "x")
    monkeypatch.setenv("PCC_BASE_URL", "https://capability.network/")
    monkeypatch.setenv("WEBHOOK_HOST", "https://voice.example.com//")

    settings = get_settings()

    assert settings.pcc_base_url == "https://capability.network"
    assert settings.webhook_host == "https://voice.example.com"


def test_settings_log_level_normalised(monkeypatch: pytest.MonkeyPatch) -> None:
    """Lowercase log level becomes uppercase; bad value falls back to INFO."""
    monkeypatch.setenv("PCC_API_KEY", "x")
    monkeypatch.setenv("LOG_LEVEL", "debug")
    settings = get_settings()
    assert settings.log_level == "DEBUG"

    get_settings.cache_clear()
    monkeypatch.setenv("LOG_LEVEL", "wat")
    settings2 = get_settings()
    assert settings2.log_level == "INFO"


def test_settings_optional_sponsor_keys_default_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sponsor keys (Deepgram/Anthropic/Cartesia/Twilio) default to '' so
    the package can be imported in test envs without them."""
    monkeypatch.setenv("PCC_API_KEY", "x")
    for k in (
        "DEEPGRAM_API_KEY",
        "ANTHROPIC_API_KEY",
        "CARTESIA_API_KEY",
        "TWILIO_ACCOUNT_SID",
        "TWILIO_AUTH_TOKEN",
        "TWILIO_PHONE_NUMBER",
    ):
        monkeypatch.delenv(k, raising=False)
    settings = get_settings()
    assert settings.deepgram_api_key == ""
    assert settings.anthropic_api_key == ""
    assert settings.cartesia_api_key == ""
    assert settings.twilio_account_sid == ""
    assert settings.twilio_auth_token == ""
    assert settings.twilio_phone_number == ""
