"""FastAPI server — Twilio inbound webhook + media-stream WebSocket.

Twilio's flow when someone dials our number:

  1. Twilio HTTP-POSTs to our `/twilio/inbound` webhook with the call metadata.
  2. We respond with TwiML that says: "open a media stream to wss://<host>/ws".
  3. Twilio opens that WebSocket and starts pumping μ-law audio.
  4. We hand the WebSocket to a fresh Pipecat pipeline; Pipecat handles
     STT → LLM tool-use → TTS and pumps audio back over the same socket.

Public endpoints:

  POST /twilio/inbound    – TwiML <Connect><Stream> directive.
  WS   /ws                – Twilio media stream socket. One pipeline per call.
  GET  /health            – Liveness check.
"""

from __future__ import annotations

import json
from typing import Optional

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, Response
from loguru import logger

from .config import VoiceOnboarderSettings, get_settings
from .tools import OnboardTools


def create_app(settings: Optional[VoiceOnboarderSettings] = None) -> FastAPI:
    """Build the FastAPI app. Factory pattern so tests can swap settings."""
    settings = settings or get_settings()

    app = FastAPI(
        title="pcc-voice-onboarder",
        version="0.1.0",
        description="Voice IO sidecar for @pcc/agent-onboarder.",
    )

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {
            "status": "ok",
            "service": "pcc-voice-onboarder",
            "pcc_base_url": settings.pcc_base_url,
            "webhook_host": settings.webhook_host,
        }

    @app.post("/twilio/inbound")
    async def twilio_inbound(request: Request) -> Response:
        """Return TwiML that tells Twilio to open a media stream to /ws.

        Twilio POSTs form-encoded data here when a call comes in. We don't
        actually need any of the form fields to construct the TwiML; we just
        echo back the stream-open directive. Twilio itself supplies the
        per-call StreamSid in the WebSocket's first frame.
        """
        # Build the wss:// URL Twilio dials into. webhook_host should be the
        # publicly-reachable host (the cloudflared tunnel URL on Spark).
        host = settings.webhook_host
        # Strip protocol → swap to wss / ws as appropriate.
        if host.startswith("https://"):
            ws_url = "wss://" + host[len("https://"):] + "/ws"
        elif host.startswith("http://"):
            ws_url = "ws://" + host[len("http://"):] + "/ws"
        else:  # bare host (e.g. set in env without scheme)
            ws_url = "wss://" + host.lstrip("/") + "/ws"

        twiml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            "<Response>"
            "<Connect>"
            f'<Stream url="{ws_url}" />'
            "</Connect>"
            "</Response>"
        )
        return Response(content=twiml, media_type="application/xml")

    @app.websocket("/ws")
    async def twilio_ws(websocket: WebSocket) -> None:
        """One Twilio call → one Pipecat pipeline.

        Twilio sends a sequence of JSON frames over this socket; the first
        useful one is the `start` frame which carries `streamSid`. We grab
        that, build a Pipecat pipeline bound to this websocket, and run it
        until the call ends.
        """
        await websocket.accept()
        stream_sid: Optional[str] = None
        try:
            # Pull the first message — Twilio's "connected" frame.
            await websocket.receive_text()
            # Pull the second — "start" frame with streamSid.
            start_msg = await websocket.receive_text()
            start_data = json.loads(start_msg)
            stream_sid = start_data.get("start", {}).get("streamSid")
            if not stream_sid:
                logger.warning("No streamSid in start frame; dropping call.")
                await websocket.close(code=1011)
                return
            logger.info("New voice call: streamSid={}", stream_sid)
        except (WebSocketDisconnect, json.JSONDecodeError, KeyError) as e:
            logger.warning("Twilio handshake failed: {}", e)
            return

        # Lazy import the pipeline factory — keeps Pipecat off the import path
        # for non-call requests (notably `/health` checks at startup time).
        from .agent import build_pipeline
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineTask

        tools: Optional[OnboardTools] = None
        try:
            pipeline, tools = build_pipeline(
                websocket=websocket,
                stream_sid=stream_sid,
                settings=settings,
            )
            task = PipelineTask(pipeline)
            runner = PipelineRunner()
            await runner.run(task)
        except Exception as e:  # pragma: no cover (integration only)
            logger.exception("Pipeline crashed: {}", e)
        finally:
            if tools is not None:
                await tools.aclose()

    @app.get("/")
    async def root() -> PlainTextResponse:
        return PlainTextResponse(
            "pcc-voice-onboarder. POST Twilio inbound to /twilio/inbound. "
            "Health at /health."
        )

    return app


# Module-level app for `uvicorn voice_onboarder.server:app`.
# Constructed lazily on first import only when env is loaded; in tests we
# use create_app(test_settings) directly.
app: Optional[FastAPI] = None


def main() -> None:
    """Entry point for `pcc-voice-onboarder` CLI script.

    Loads settings, builds the app, and runs uvicorn. Used by the systemd
    unit on Spark.
    """
    import uvicorn

    settings = get_settings()
    logger.info(
        "voice-onboarder starting | pcc={} | webhook_host={} | port={}",
        settings.pcc_base_url,
        settings.webhook_host,
        settings.server_port,
    )
    app_instance = create_app(settings)
    uvicorn.run(
        app_instance,
        host=settings.server_host,
        port=settings.server_port,
        log_level=settings.log_level.lower(),
    )


__all__ = ["create_app", "main", "app"]
