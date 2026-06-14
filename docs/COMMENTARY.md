# PCC Commentary — Live LLM Narration of the Substrate

The commentary layer turns PCC's existing SSE event streams into a live,
sports-broadcaster-style narration. When a job is dispatched, evidence is
captured, an attestation is minted, or an escrow milestone releases — a Claude
streaming call describes each phase as the network does it.

It is a thin layer over the in-process `StreamHub` that already aggregates
events from `/sse/notifications`, `/sse/stream/job/:id`, `/sse/stream/kernel/:id`,
and all the other gateway streams.

---

## Quick start

1. Set `ANTHROPIC_API_KEY` in the gateway's environment (Railway:
   `production` env vars, `staging` env vars):

   ```bash
   railway variables set ANTHROPIC_API_KEY=sk-ant-...
   ```

2. Boot or redeploy the gateway. No other config needed — the SDK is loaded
   lazily, so the route is registered either way.

3. Open `https://capability.network/commentary.html` (or
   `http://localhost:3200/commentary.html` if running the gateway with
   `SERVE_DASHBOARD=true` locally).

4. Pick a topic (`all`, `jobs`, `escrows`, `attestations`) and press **Start**.

5. The left column shows the raw event feed, color-coded by category. The
   right column shows the LLM narration, one line per ~1.5-second window.

6. Optional: toggle **voice** to have the narration spoken via the browser's
   built-in `SpeechSynthesisUtterance`.

If `ANTHROPIC_API_KEY` is missing, the page surfaces a friendly notice and
keeps streaming raw events so you can still watch the substrate light up.

---

## API

### `GET /api/commentary/status`

Returns the route's config snapshot. No auth required beyond the global API
gate.

```json
{
  "route": "/api/commentary/stream",
  "anthropic_configured": true,
  "default_model": "claude-sonnet-4-5",
  "default_window_ms": 1500,
  "supported_topics": ["jobs", "escrows", "attestations", "all"]
}
```

### `POST /api/commentary/stream` (or `GET` for `EventSource` callers)

Returns an SSE stream. Each event is a JSON-encoded `CommentaryChunk`:

| event       | description                                                                          |
|-------------|--------------------------------------------------------------------------------------|
| `connected` | Initial handshake. Confirms the route is wired and echoes the config.                |
| `ready`     | Subscription to the event stream is live.                                            |
| `needs_api_key` | `ANTHROPIC_API_KEY` is missing or the SDK could not load. Raw windows continue.    |
| `window`    | A batched set of raw events for the next narration line. Includes `raw_events`.      |
| `narration` | A streaming token delta of the narration text. Tied to its window via `window_id`.   |
| `heartbeat` | Periodic ping (~15s) to keep the connection alive when the event stream is quiet.    |
| `error`     | A non-fatal narration failure (e.g. one window's call to Claude timed out).          |

**Body** (POST) or **query string** (GET):

| field            | type     | default          | notes                                                  |
|------------------|----------|------------------|--------------------------------------------------------|
| `topic`          | string   | `all`            | One of `jobs`, `escrows`, `attestations`, `all`.       |
| `windowMs`       | number   | `1500`           | Event-batching window. Clamped to 250-15000 ms.        |
| `model`          | string   | `claude-sonnet-4-5` | Any Claude model id supported by the Anthropic SDK. |
| `historyWindows` | number   | `6`              | How many prior narration lines to feed back as context. |
| `since`          | string   | (none)           | ISO timestamp — drop events older than this.           |

---

## How it works

1. The route subscribes to the `streamHub` global topic — the same hub that
   every existing SSE endpoint publishes to. No round-trip through the network.
2. Incoming events are filtered by topic (`classifyEvent` keys off the event
   type string) and pushed into a per-session buffer.
3. Every `windowMs` the buffer flushes. The narrator emits a `window` chunk
   carrying the raw events, then sends them to Claude with the broadcaster
   system prompt plus the last `historyWindows` narration lines as context
   (so the LLM does not repeat itself).
4. The Anthropic stream is consumed token-by-token; each delta is forwarded
   to the client as a `narration` chunk tagged with the same `window_id`.
   When the next window arrives, the prior line is finalized in the UI.

---

## Architectural notes

- **No new event sources.** This layer is consume-only. It does not mutate
  any chain state, escrow, evidence bundle, or job. It only narrates.
- **Lazy SDK loading.** `@anthropic-ai/sdk` is loaded via dynamic `import()`
  with a graceful-degrade fallback. The gateway builds, boots, and serves
  the rest of the API even if the SDK is absent.
- **No emoji.** The narrator system prompt explicitly disallows emoji to
  match PCC's anti-emoji convention. The tone is calm and factual — no
  panic, no urgency adverbs, no fake brand names ("Tony's Pizza" only
  appears if a real event payload contains that string).
- **One LLM call per window.** A 1.5 s window at full sensor-tick load is
  ~3-10 events. The system prompt + 6 prior windows + event batch fits
  comfortably under 2k input tokens per call.
- **Cost shape.** At 1.5 s windows = 40 calls/min. At Sonnet pricing of
  `$3/M in, $15/M out`, a busy minute of narration runs roughly
  `40 * (2000 in + 200 out) / 1M * blended` — under a cent. Idle minutes
  (no events) skip the call entirely.

---

## Files

| Path                                                          | Role                                  |
|---------------------------------------------------------------|---------------------------------------|
| `packages/gateway/src/services/commentary-narrator.ts`        | Narrator service + session lifecycle |
| `packages/gateway/src/routes/commentary.ts`                   | `POST/GET /api/commentary/stream` + `/status` |
| `packages/gateway/src/__tests__/commentary.test.ts`           | Unit + integration tests              |
| `apps/dashboard/public/commentary.html`                       | Two-column live UI                    |

---

## Limitations / future work

- **No persistence.** Narration is ephemeral. A future "replay yesterday's
  greatest hits" view would write the narration to a small SQLite table.
- **Single model.** No fallback chain. If the Anthropic API is degraded the
  session emits `error` chunks and keeps trying the next window.
- **No client-side voice picker.** The browser picks a default voice. A
  future tweak could surface a `<select>` of available voices.
- **No multi-language narration.** The system prompt is English-only.
