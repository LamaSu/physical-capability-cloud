"""Tool tests — every OnboardTools method gets a happy-path + error-path
test using respx to mock the gateway. No real network calls."""

from __future__ import annotations

from typing import AsyncIterator

import httpx
import pytest
import respx

from voice_onboarder.config import VoiceOnboarderSettings
from voice_onboarder.tools import OnboardTools


def _make_settings() -> VoiceOnboarderSettings:
    """Settings fixture with explicit values — bypasses .env loading."""
    return VoiceOnboarderSettings(
        pcc_api_key="pcc_live_test",
        pcc_base_url="https://capability.network",
    )  # type: ignore[call-arg]


@pytest.fixture
async def tools() -> AsyncIterator[OnboardTools]:
    settings = _make_settings()
    t = OnboardTools(settings)
    yield t
    await t.aclose()


# ── start_session ──────────────────────────────────────────────────────────


@respx.mock
async def test_start_session_happy_path(tools: OnboardTools) -> None:
    route = respx.post("https://capability.network/api/onboard/start").mock(
        return_value=httpx.Response(
            200, json={"session_id": "s-1", "state": "started"}
        )
    )
    out = await tools.start_session(name="Acme Shop", url="https://acme.com")
    assert out["session_id"] == "s-1"
    assert out["state"] == "started"
    assert route.called
    # Body should contain both name and url.
    body = route.calls[0].request.content.decode()
    assert "Acme Shop" in body
    assert "acme.com" in body


@respx.mock
async def test_start_session_401(tools: OnboardTools) -> None:
    respx.post("https://capability.network/api/onboard/start").mock(
        return_value=httpx.Response(
            401, json={"error": "unauthorized", "message": "Bearer token required"}
        )
    )
    out = await tools.start_session(name="Acme")
    assert "error" in out
    assert out["status"] == 401
    assert "Bearer" in out["error"] or "unauthorized" in out["error"].lower()


# ── scrape_url ─────────────────────────────────────────────────────────────


@respx.mock
async def test_scrape_url_happy_path(tools: OnboardTools) -> None:
    respx.post("https://capability.network/api/onboard/s-1/scrape").mock(
        return_value=httpx.Response(
            200,
            json={"ok": True, "scraped": {"name": "Acme", "machines": ["MK4"]}},
        )
    )
    out = await tools.scrape_url(session_id="s-1", url="https://acme.com")
    assert out["ok"] is True
    assert out["scraped"]["name"] == "Acme"


@respx.mock
async def test_scrape_url_session_not_found(tools: OnboardTools) -> None:
    respx.post("https://capability.network/api/onboard/missing/scrape").mock(
        return_value=httpx.Response(404, json={"error": "session_not_found"})
    )
    out = await tools.scrape_url(session_id="missing", url="https://acme.com")
    assert out["error"] == "session_not_found"
    assert out["status"] == 404


# ── ingest_docs ────────────────────────────────────────────────────────────


@respx.mock
async def test_ingest_docs_happy_path(tools: OnboardTools) -> None:
    route = respx.post(
        "https://capability.network/api/onboard/s-1/ingest-docs"
    ).mock(return_value=httpx.Response(200, json={"ok": True, "ingested": 3}))
    out = await tools.ingest_docs(
        session_id="s-1", doc_urls=["https://a.pdf", "https://b.pdf", "local://c"]
    )
    assert out["ok"] is True
    assert out["ingested"] == 3
    body = route.calls[0].request.content.decode()
    assert "doc_urls" in body
    assert "a.pdf" in body


@respx.mock
async def test_ingest_docs_bad_request(tools: OnboardTools) -> None:
    respx.post("https://capability.network/api/onboard/s-1/ingest-docs").mock(
        return_value=httpx.Response(
            400, json={"error": "doc_urls_required", "message": "doc_urls is required"}
        )
    )
    out = await tools.ingest_docs(session_id="s-1", doc_urls=[])
    assert out["status"] == 400
    assert "doc_urls" in out["error"].lower() or "required" in out["error"].lower()


# ── build_agent ────────────────────────────────────────────────────────────


@respx.mock
async def test_build_agent_happy_path(tools: OnboardTools) -> None:
    respx.post("https://capability.network/api/onboard/s-1/build-agent").mock(
        return_value=httpx.Response(
            200,
            json={
                "ok": True,
                "capabilities": ["3d-printing", "laser-cutting"],
                "publication": {"discovery_url": "https://capability.network/operators/acme"},
            },
        )
    )
    out = await tools.build_agent(session_id="s-1")
    assert out["ok"] is True
    assert "3d-printing" in out["capabilities"]
    assert out["publication"]["discovery_url"]


@respx.mock
async def test_build_agent_500_error(tools: OnboardTools) -> None:
    respx.post("https://capability.network/api/onboard/s-1/build-agent").mock(
        return_value=httpx.Response(
            500,
            json={"ok": False, "error": "build_failed", "message": "publishOperator threw"},
        )
    )
    out = await tools.build_agent(session_id="s-1")
    assert out["status"] == 500
    assert "build_failed" in out["error"] or "publishOperator" in out["error"]


# ── get_status ─────────────────────────────────────────────────────────────


@respx.mock
async def test_get_status_happy_path(tools: OnboardTools) -> None:
    respx.get("https://capability.network/api/onboard/s-1/status").mock(
        return_value=httpx.Response(
            200,
            json={
                "session_id": "s-1",
                "state": "building",
                "progress": 80,
                "last_event": {"type": "build_kicked_off", "message": "Build started"},
            },
        )
    )
    out = await tools.get_status(session_id="s-1")
    assert out["state"] == "building"
    assert out["progress"] == 80


@respx.mock
async def test_get_status_404(tools: OnboardTools) -> None:
    respx.get("https://capability.network/api/onboard/missing/status").mock(
        return_value=httpx.Response(404, json={"error": "session_not_found"})
    )
    out = await tools.get_status(session_id="missing")
    assert out["error"] == "session_not_found"
    assert out["status"] == 404


# ── get_live_data ──────────────────────────────────────────────────────────


@respx.mock
async def test_get_live_data_happy_path(tools: OnboardTools) -> None:
    route = respx.get(
        "https://capability.network/api/onboard/s-1/live-data"
    ).mock(
        return_value=httpx.Response(
            200,
            json={
                "session_id": "s-1",
                "events": [{"t": 1, "type": "session_started", "message": "ok"}],
                "cursor": 1,
                "updated_at": 1,
            },
        )
    )
    out = await tools.get_live_data(session_id="s-1")
    assert len(out["events"]) == 1
    assert out["cursor"] == 1
    # Without `since` param, no query string passed
    assert route.calls[0].request.url.query == b""


@respx.mock
async def test_get_live_data_with_since_cursor(tools: OnboardTools) -> None:
    route = respx.get(
        "https://capability.network/api/onboard/s-1/live-data"
    ).mock(
        return_value=httpx.Response(
            200,
            json={"session_id": "s-1", "events": [], "cursor": 999, "updated_at": 999},
        )
    )
    out = await tools.get_live_data(session_id="s-1", since=42)
    assert out["cursor"] == 999
    # With since=42, the GET must carry it as a query param
    assert b"since=42" in route.calls[0].request.url.query


# ── network failure path (httpx.HTTPError) ────────────────────────────────


async def test_network_error_returns_dict_not_raises() -> None:
    """If the backend is unreachable, the tool must NOT crash the pipeline.
    It must return an error dict so the LLM can verbalise something useful."""
    settings = _make_settings()
    # Construct a transport that always raises ConnectError.
    transport = httpx.MockTransport(lambda req: (_ for _ in ()).throw(httpx.ConnectError("boom")))
    client = httpx.AsyncClient(
        base_url=settings.pcc_base_url,
        headers={"Authorization": f"Bearer {settings.pcc_api_key}"},
        transport=transport,
    )
    t = OnboardTools(settings, client=client)
    try:
        out = await t.start_session(name="Acme")
        assert "error" in out
        assert "backend_unreachable" in out["error"] or "boom" in out["error"]
        assert out["status"] is None
    finally:
        await t.aclose()
