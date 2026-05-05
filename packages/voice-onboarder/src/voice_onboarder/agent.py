"""Pipecat agent pipeline.

Wires:

    Twilio media stream  →  Deepgram STT  →  Anthropic Claude (tool-use)
                                                       │
                                                       └→ OnboardTools (httpx → PCC gateway)
                                                       │
                                              Cartesia TTS  →  Twilio out

The brain stays in TypeScript (`@pcc/agent-onboarder`). This module owns
voice IO and the LLM-orchestration layer; every "do something useful"
call routes to the gateway via :class:`OnboardTools`.

Pipecat's Anthropic LLM service handles the tool-use loop natively — we
register tool schemas + async callables, Pipecat does the multi-turn dance
and only emits the final assistant text into the TTS pipeline.

Pipecat is a heavy dependency; we import it lazily inside :func:`build_pipeline`
so unit tests can `import voice_onboarder.agent` without paying the import
cost (and without needing Pipecat installed at test-collection time).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from loguru import logger

from .config import VoiceOnboarderSettings, get_settings
from .tools import OnboardTools

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pipecat.pipeline.pipeline import Pipeline


# ── System prompt for the voice agent ─────────────────────────────────────
# Frame: Claude is interviewing the operator about their shop. Tools are
# available; Claude should call them as it gathers info.
SYSTEM_PROMPT = """You are the voice agent for the Physical Capability Cloud (PCC).

You are speaking with a workshop / lab / factory operator over the phone.
Your job: walk them through a 3-5 minute onboarding conversation that gets
them registered on the network. You have backend tools available (start_session,
scrape_url, ingest_docs, build_agent, get_status). Use them as you go — don't
narrate what you're doing, just do it and respond to the operator.

Conversation arc:

1. Greet the caller. Ask their shop name and (optionally) their website.
   Call `start_session` with what you have.
2. If they mentioned a website, call `scrape_url` to pull their machines/services.
   If you got something useful, mention 1-2 specifics back to them ("I see you
   run a Prusa MK4 and an Epilog laser, is that right?").
3. Ask if they have any equipment datasheets or PDFs. If yes, call `ingest_docs`
   with the URL list they give you.
4. Briefly confirm the capability set, then call `build_agent` to publish them.
5. Once `build_agent` returns, give them their discovery URL and tell them
   they're live.

Voice-style guidelines (you are speaking, not typing):
- Short sentences. Pauses are OK; the listener can't see you typing.
- Never read URLs character-by-character. Say "I'll text you the link" if needed.
- If a tool returns an error dict, briefly acknowledge ("hmm, the system
  hiccupped — let me try once more") and either retry or move on.
- Default to friendly, professional, concise. Match the caller's energy.

Stay focused on onboarding. Don't answer broad questions about the cloud or
recommend other services — say "let me get you set up first, then your operator
profile can answer that."
"""


def _build_anthropic_tool_schemas() -> list[dict[str, Any]]:
    """Anthropic-format tool schemas. Names + properties match
    :class:`OnboardTools` method signatures exactly so Pipecat can dispatch
    by name without a translation layer."""
    return [
        {
            "name": "start_session",
            "description": (
                "Start a new onboarding session. Call this first, as soon as the operator "
                "tells you their shop name. URL is optional — pass it if they mentioned it."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "Shop / company / lab name the caller introduced themselves with.",
                    },
                    "url": {
                        "type": "string",
                        "description": "Optional company website (https://...).",
                    },
                },
                "required": ["name"],
            },
        },
        {
            "name": "scrape_url",
            "description": (
                "Scrape an operator URL and return structured data (machines, hours, services, "
                "contact). Call after start_session if the caller mentioned a website."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string", "description": "Session id from start_session."},
                    "url": {"type": "string", "description": "Full URL (https://...) to scrape."},
                },
                "required": ["session_id", "url"],
            },
        },
        {
            "name": "ingest_docs",
            "description": (
                "Queue a list of doc URLs (PDFs, datasheets) for ingestion. The caller may "
                "say 'I'll send you a link' — accept the URLs they read out."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "session_id": {"type": "string"},
                    "doc_urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of doc URLs to ingest.",
                    },
                },
                "required": ["session_id", "doc_urls"],
            },
        },
        {
            "name": "build_agent",
            "description": (
                "Finalise the onboarding — registers the operator, mints a wallet, publishes "
                "to the network. Call once you've gathered enough info; backend may take several seconds."
            ),
            "input_schema": {
                "type": "object",
                "properties": {"session_id": {"type": "string"}},
                "required": ["session_id"],
            },
        },
        {
            "name": "get_status",
            "description": "Cheap progress check. Useful while build_agent is running.",
            "input_schema": {
                "type": "object",
                "properties": {"session_id": {"type": "string"}},
                "required": ["session_id"],
            },
        },
    ]


def _make_tool_dispatchers(tools: OnboardTools) -> dict[str, Any]:
    """Map tool names to async callables matching Pipecat's tool-callback signature."""

    async def _start(args: dict[str, Any]) -> dict[str, Any]:
        return await tools.start_session(name=args["name"], url=args.get("url"))

    async def _scrape(args: dict[str, Any]) -> dict[str, Any]:
        return await tools.scrape_url(session_id=args["session_id"], url=args["url"])

    async def _ingest(args: dict[str, Any]) -> dict[str, Any]:
        return await tools.ingest_docs(session_id=args["session_id"], doc_urls=args["doc_urls"])

    async def _build(args: dict[str, Any]) -> dict[str, Any]:
        return await tools.build_agent(session_id=args["session_id"])

    async def _status(args: dict[str, Any]) -> dict[str, Any]:
        return await tools.get_status(session_id=args["session_id"])

    return {
        "start_session": _start,
        "scrape_url": _scrape,
        "ingest_docs": _ingest,
        "build_agent": _build,
        "get_status": _status,
    }


def build_pipeline(
    *,
    websocket: Any,
    stream_sid: str,
    settings: Optional[VoiceOnboarderSettings] = None,
    tools: Optional[OnboardTools] = None,
) -> tuple["Pipeline", OnboardTools]:
    """Build a Pipecat pipeline ready to run for one Twilio call.

    Args:
        websocket: The Starlette WebSocket Twilio media stream connected to.
        stream_sid: Twilio's per-call stream sid (passed in the start frame).
        settings: Pre-loaded settings; falls back to :func:`get_settings`.
        tools: Pre-built :class:`OnboardTools`; constructed if omitted.

    Returns:
        (pipeline, tools) — caller is responsible for shutting down both.

    Notes:
        - This function lazy-imports Pipecat so unit tests don't need it.
        - The pipeline assumes one call → one pipeline. The caller drives a
          PipelineRunner around it.
        - Pipecat's API for service classes occasionally evolves; if an import
          path here is wrong on the installed version, this function is the
          single place to update — the rest of the package keeps working.
    """
    settings = settings or get_settings()
    tools = tools or OnboardTools(settings)

    # Lazy imports — keep package importable without Pipecat installed.
    # If Pipecat's API surface differs from what's wired here, fix at this
    # boundary; tools.py + config.py + tests don't depend on Pipecat.
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.processors.aggregators.openai_llm_context import (  # type: ignore[import-not-found]
        OpenAILLMContext,
    )
    from pipecat.serializers.twilio import TwilioFrameSerializer
    from pipecat.services.anthropic.llm import AnthropicLLMService
    from pipecat.services.cartesia.tts import CartesiaTTSService
    from pipecat.services.deepgram.stt import DeepgramSTTService
    from pipecat.transports.network.fastapi_websocket import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

    # Twilio websocket transport (μ-law @ 8 kHz, the format Twilio media streams use).
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            vad_enabled=True,
            serializer=TwilioFrameSerializer(stream_sid=stream_sid),
        ),
    )

    stt = DeepgramSTTService(api_key=settings.deepgram_api_key)
    llm = AnthropicLLMService(
        api_key=settings.anthropic_api_key,
        model="claude-sonnet-4-20250514",
    )

    # Register tools with the LLM service. Pipecat handles the tool-use loop.
    dispatchers = _make_tool_dispatchers(tools)
    for schema in _build_anthropic_tool_schemas():
        name = schema["name"]
        callback = dispatchers[name]
        # Pipecat's tool registration API. If the installed version uses a
        # different method name, replace this loop — it's the only place
        # that touches the Pipecat tool surface.
        try:
            llm.register_function(name, callback)  # type: ignore[attr-defined]
        except AttributeError:  # pragma: no cover
            # Older Pipecat used `register_tool`; future versions may rename
            # again. Surface a clear error so the deploy can be patched.
            logger.error(
                "AnthropicLLMService.register_function not found — Pipecat API changed; "
                "patch agent.py at the registration loop."
            )
            raise

    tts = CartesiaTTSService(
        api_key=settings.cartesia_api_key,
        voice_id=settings.cartesia_voice_id,
    )

    context = OpenAILLMContext(
        messages=[{"role": "system", "content": SYSTEM_PROMPT}],
        tools=_build_anthropic_tool_schemas(),
    )
    context_aggregator = llm.create_context_aggregator(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            context_aggregator.user(),
            llm,
            tts,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )
    return pipeline, tools


__all__ = ["build_pipeline", "SYSTEM_PROMPT"]
