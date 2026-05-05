"""Tool implementations — thin httpx wrappers around the gateway's
`/api/onboard/*` HTTP API.

These are extracted from `agent.py` so they can be unit-tested without
spinning up the whole Pipecat pipeline. Each tool is an `async def`
returning a JSON-serialisable dict (or an `{"error": "..."}` dict when
the backend call fails). Errors NEVER raise — the LLM gets a structured
error it can verbalise to the caller, the pipeline keeps running.

The function names + signatures are the source of truth for the tool
schemas Claude sees. `agent.py` registers them via Pipecat's tool API
with matching JSON-schema descriptions.

Routes called:
  POST /api/onboard/start                      body: {name, url?}
  POST /api/onboard/<id>/scrape                body: {url}
  POST /api/onboard/<id>/ingest-docs           body: {doc_urls: [str]}
  POST /api/onboard/<id>/build-agent           body: {}
  GET  /api/onboard/<id>/status
  GET  /api/onboard/<id>/live-data

All routes go through one shared `httpx.AsyncClient` initialised once at
startup with the Bearer token preset.
"""

from __future__ import annotations

from typing import Any, Optional

import httpx
from loguru import logger

from .config import VoiceOnboarderSettings


class OnboardTools:
    """Tool implementations bound to a single PCC gateway client.

    Construct once at startup; share the client across every Pipecat tool
    invocation. The client carries the Bearer token + a sane default timeout.

    Pattern matches `@pcc/orchestrator-sdk`'s tool style: every method
    returns a JSON-serialisable dict; errors are caught and returned as
    `{"error": "<msg>", "status": <int|None>}` so the calling LLM can
    relay them to the operator without crashing the audio pipeline.
    """

    def __init__(self, settings: VoiceOnboarderSettings, client: Optional[httpx.AsyncClient] = None):
        self._settings = settings
        if client is None:
            client = httpx.AsyncClient(
                base_url=settings.pcc_base_url,
                headers={
                    "Authorization": f"Bearer {settings.pcc_api_key}",
                    "Content-Type": "application/json",
                    "User-Agent": "pcc-voice-onboarder/0.1.0",
                },
                timeout=settings.http_timeout_seconds,
            )
        self._client = client

    @property
    def client(self) -> httpx.AsyncClient:
        """Expose the underlying client so callers (and tests) can replace
        it with a mock. Most consumers won't need this."""
        return self._client

    async def aclose(self) -> None:
        """Close the underlying HTTP client. Call on graceful shutdown."""
        await self._client.aclose()

    # ── Tool implementations ────────────────────────────────────────────

    async def start_session(self, name: str, url: Optional[str] = None) -> dict[str, Any]:
        """Begin a new onboarding session.

        Args:
            name: The operator/shop name the caller introduced themselves with.
            url: Optional initial company URL the caller mentioned.

        Returns:
            On success: {"session_id": str, "state": "started", ...}
            On failure: {"error": str, "status": int|None}
        """
        payload: dict[str, Any] = {"name": name}
        if url:
            payload["url"] = url
        return await self._post("/api/onboard/start", payload, op="start_session")

    async def scrape_url(self, session_id: str, url: str) -> dict[str, Any]:
        """Scrape an operator URL and extract structured data.

        Args:
            session_id: Session id returned by `start_session`.
            url: Full URL to scrape (https://...).

        Returns:
            {"ok": True, "scraped": {...}} on success.
            {"error": str, "status": int|None} on failure.
        """
        return await self._post(
            f"/api/onboard/{session_id}/scrape",
            {"url": url},
            op="scrape_url",
        )

    async def ingest_docs(self, session_id: str, doc_urls: list[str]) -> dict[str, Any]:
        """Queue a list of doc URLs for ingestion (PDFs, datasheets, etc).

        Args:
            session_id: Session id.
            doc_urls: Array of full URLs (or "local://name" sentinels) to ingest.

        Returns:
            {"ok": True, "ingested": int} on success.
            {"error": str, "status": int|None} on failure.
        """
        return await self._post(
            f"/api/onboard/{session_id}/ingest-docs",
            {"doc_urls": list(doc_urls)},
            op="ingest_docs",
        )

    async def build_agent(self, session_id: str) -> dict[str, Any]:
        """Finalise the onboarding — register operator, mint wallet, publish.

        This is the heavy step; the backend may take several seconds.

        Args:
            session_id: Session id.

        Returns:
            {"ok": True, "capabilities": [...], "publication": {...}}
            {"error": str, "status": int|None} on failure.
        """
        return await self._post(
            f"/api/onboard/{session_id}/build-agent",
            {},
            op="build_agent",
        )

    async def get_status(self, session_id: str) -> dict[str, Any]:
        """Cheap status poll for the session — state, progress, last event."""
        return await self._get(
            f"/api/onboard/{session_id}/status",
            op="get_status",
        )

    async def get_live_data(
        self, session_id: str, since: Optional[int] = None
    ) -> dict[str, Any]:
        """Full event log for the session, optionally cursored.

        Args:
            session_id: Session id.
            since: Optional UNIX millis cursor; only events after this are returned.

        Returns:
            {"events": [...], "cursor": int, ...} on success.
        """
        params: dict[str, Any] = {}
        if since is not None:
            params["since"] = since
        return await self._get(
            f"/api/onboard/{session_id}/live-data",
            params=params,
            op="get_live_data",
        )

    # ── Internal helpers ────────────────────────────────────────────────

    async def _post(
        self, path: str, json_body: dict[str, Any], *, op: str
    ) -> dict[str, Any]:
        try:
            resp = await self._client.post(path, json=json_body)
        except httpx.HTTPError as e:
            logger.warning("[{}] httpx error: {}", op, e)
            return {"error": f"backend_unreachable: {e!s}", "status": None}
        return self._parse(resp, op=op)

    async def _get(
        self,
        path: str,
        *,
        params: Optional[dict[str, Any]] = None,
        op: str,
    ) -> dict[str, Any]:
        try:
            resp = await self._client.get(path, params=params or {})
        except httpx.HTTPError as e:
            logger.warning("[{}] httpx error: {}", op, e)
            return {"error": f"backend_unreachable: {e!s}", "status": None}
        return self._parse(resp, op=op)

    @staticmethod
    def _parse(resp: httpx.Response, *, op: str) -> dict[str, Any]:
        """Normalise a response into a dict.

        Success (2xx): returns the parsed JSON body. If the body isn't a
        dict (e.g. a JSON array), wraps it as {"data": <body>}.

        Error (>=400): returns {"error": <msg>, "status": <int>} so the LLM
        can verbalise something useful instead of getting a HTTP error
        string. The original status code is included for telemetry.
        """
        if resp.status_code >= 400:
            try:
                body = resp.json()
                msg = body.get("message") or body.get("error") or resp.reason_phrase
            except Exception:
                msg = resp.text or resp.reason_phrase
            logger.info("[{}] backend returned {}: {}", op, resp.status_code, msg)
            return {"error": str(msg), "status": resp.status_code}

        try:
            data = resp.json()
        except Exception:
            return {"error": "invalid_json_response", "status": resp.status_code}

        if isinstance(data, dict):
            return data
        return {"data": data}


__all__ = ["OnboardTools"]
