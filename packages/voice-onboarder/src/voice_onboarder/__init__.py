"""pcc-voice-onboarder: Voice-IO sidecar for @pcc/agent-onboarder.

Pipecat pipeline (Twilio transport + Deepgram STT + Anthropic Claude + Cartesia TTS)
that exposes the gateway's /api/onboard/* HTTP API as voice-callable tools.

The brain stays in TypeScript (@pcc/agent-onboarder). This package only handles
the voice IO doorway: telephony in, transcription, LLM tool-use loop, TTS, telephony out.
"""

__version__ = "0.1.0"
