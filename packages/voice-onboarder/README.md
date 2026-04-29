# @pcc/voice-onboarder

Voice IO sidecar for `@pcc/agent-onboarder`. A Python sidecar that puts a
phone number on the front of the existing TS onboarding brain.

## What it is

```
   PSTN call
      ↓
   Twilio (media stream)
      ↓
 ┌─────────────────────────────────────────┐
 │  pcc-voice-onboarder (this package)     │
 │  ┌──────────┐ ┌────────┐ ┌─────────┐    │
 │  │ Deepgram │→│ Claude │→│Cartesia │    │
 │  │   STT    │ │ (Anthr)│ │  TTS    │    │
 │  └──────────┘ └───┬────┘ └─────────┘    │
 │                   │ tools                │
 └───────────────────┼──────────────────────┘
                     ↓ httpx
              ┌──────────────────┐
              │  PCC gateway     │
              │  /api/onboard/*  │  ← brain stays in TS
              └──────────────────┘
```

The brain (state machine, business logic, DB writes) stays in
`@pcc/agent-onboarder` (TypeScript). This package is **only** the voice IO
doorway: telephony in, transcription, LLM tool-use loop, TTS, telephony out.
Every "do something useful" call routes back to the gateway via httpx.

## Architecture choice — why Python?

Pipecat (the voice-pipeline framework) is Python-native. Rewriting it in TS
would add weeks of work for no functional gain. Sidecar pattern keeps the
codebases small and lets each side keep its language conventions.

## Modules

| File | Purpose |
|---|---|
| `src/voice_onboarder/config.py` | pydantic-settings for env vars |
| `src/voice_onboarder/tools.py` | `OnboardTools` — async httpx wrappers around `/api/onboard/*` |
| `src/voice_onboarder/agent.py` | Pipecat pipeline factory: Twilio + Deepgram + Claude + Cartesia |
| `src/voice_onboarder/server.py` | FastAPI: `/twilio/inbound` (TwiML), `/ws` (Twilio media), `/health` |

## Local dev

```bash
cd packages/voice-onboarder
python3.11 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest tests/
```

The tests use `respx` to mock the gateway — no real network calls,
no Twilio/Deepgram/Anthropic/Cartesia keys required.

## Running locally (with mocks)

```bash
# Minimum env to boot the server (with mock keys).
export PCC_API_KEY=pcc_test
export ANTHROPIC_API_KEY=mock
export DEEPGRAM_API_KEY=mock
export CARTESIA_API_KEY=mock
export TWILIO_ACCOUNT_SID=ACmock
export TWILIO_AUTH_TOKEN=mock
export TWILIO_PHONE_NUMBER=+10000000000
export WEBHOOK_HOST=http://localhost:8765

.venv/bin/python -m voice_onboarder.server
```

Then:
- `curl http://localhost:8765/health` should return `{"status":"ok",...}`
- `curl -XPOST http://localhost:8765/twilio/inbound` should return TwiML

The `/ws` endpoint will accept connections but the pipeline will fail
when Pipecat tries to call Anthropic/Deepgram/Cartesia with the mock
keys. That's expected — local mock mode is for the FastAPI scaffolding,
not the audio pipeline.

## Deploying to Spark

See [`deploy/README.md`](deploy/README.md). systemd unit + cloudflared
tunnel template included.

## Pipecat version

Pinned to `pipecat-ai>=0.0.50,<1.0` with the `[twilio,deepgram,anthropic,cartesia,silero]`
extras. Pipecat's API has historically moved fast; if an import or method
name diverges from what's wired in `agent.py`, fix at the lazy-import
boundary inside `build_pipeline()`. The rest of the package (tools,
config, tests) is independent of Pipecat.

## Related

- `@pcc/agent-onboarder` (TypeScript) — the brain. Lives at
  `packages/agent-onboarder`.
- `docs/agent-onboarder/NAVI-V2-MIGRATION-PLAN.md` — Wave 3.1 spec for
  this package.
