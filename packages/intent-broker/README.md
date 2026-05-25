# @pcc/intent-broker

MCP server that captures **external demand-intent** from any client agent and
forwards it to PCC's `/api/intents/ingest` endpoint.

Today PCC captures intent at its own `/api/*` surface (requests, negotiate,
query). This broker extends capture to agents that go elsewhere — Amazon,
DoorDash, custom MCPs — by exposing a single MCP tool, `register_intent`,
that the calling agent invokes when it fires any intent-shaped action.

## Install

```bash
npx @pcc/intent-broker
```

or pin it as a dev dep / add it to your MCP client config (below).

## MCP client config

### Claude Desktop / Cursor / Goose / ChatGPT Apps

Add to your client's MCP server config (Claude Desktop:
`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "pcc-intent-broker": {
      "command": "npx",
      "args": ["-y", "@pcc/intent-broker"],
      "env": {
        "PCC_API_KEY": "pcc_live_..."
      }
    }
  }
}
```

Restart the client. The `register_intent` tool will appear in its tool list.

## Environment variables

| Var | Default | Required | Notes |
|-----|---------|----------|-------|
| `PCC_API_KEY` | (none) | yes for live posts | Bearer token from `POST /api/auth/provision`. If absent, the broker validates calls but returns `{accepted:false, reason:"no_api_key"}`. |
| `PCC_INTENT_INGEST_URL` | `https://capability.network/api/intents/ingest` | no | Override for self-hosted or staging PCC instances. |
| `INTENT_BROKER_LOG_LEVEL` | `warn` | no | `silent` / `warn` / `info`. All output goes to stderr. |

## What it captures

Only the `DemandEnvelope` fields from `@pcc/spec`:

- `id` — client-chosen unique ID
- `source` — one of `requests_api`, `negotiate_api`, `query_api_synthetic`,
  `sdk`, `mcp_broker`, `otel`
- `compositionSignature` — `sha256` over sorted capability types + dependency
  edges (deterministic across requesters)
- `capabilityTypes[]` — atomic capability types in this composite
- `summary` — ≤200 chars
- `budgetBand` / `urgencyBand` — coarse-grained buckets, NOT raw dollar
  amounts
- Optional: `geographicRegion`, `assuranceTier`, `originAgentId`,
  `originAgentVendor`, `requesterIdHash`

## What it does NOT capture

- Request bodies, HTTP payloads, response data
- Raw PII — hash identities client-side (`requesterIdHash` is
  `sha256(email|wallet)`) before passing them in
- Tool call arguments or model outputs

## What this iteration does NOT do

- **Proxy other MCP servers.** Routing intents from a downstream MCP through
  the broker needs a transport-routing design and lands in a separate sprint.
  This iteration exposes a single callable tool only — the calling agent is
  responsible for deciding when to invoke it.
- **Offer a fetch/axios SDK wrapper.** That's `@pcc/intent-collector`
  (Phase 2.2).
- **Export OpenTelemetry spans.** That's the OTel exporter (Phase 2.3).
- **Run as a browser extension.** That's Phase 2.4.

## Tool surface

### `register_intent`

Input:
```json
{
  "envelope": {
    "id": "intent-amz-2026-05-23-001",
    "source": "mcp_broker",
    "compositionSignature": "0xabc...",
    "capabilityTypes": ["fulfillment-2day-us"],
    "summary": "Order 4-pack AA batteries via Amazon",
    "budgetBand": "under_100",
    "urgencyBand": "standard",
    "createdAt": "2026-05-23T10:15:00Z",
    "originAgentVendor": "claude"
  }
}
```

Output (on success):
```json
{
  "accepted": true,
  "status": 202,
  "envelopeId": "intent-amz-2026-05-23-001",
  "dedupeKey": "op-acme:0xabc..."
}
```

Output (on rejection):
```json
{
  "accepted": false,
  "reason": "invalid_envelope | no_api_key | upstream_error | transport_error",
  "error": "...details..."
}
```

The broker validates the envelope against `DemandEnvelopeSchema` client-side
and the gateway re-validates server-side — a malformed payload never reaches
the network.

## Privacy

PCC's demand-intel store is **private**. Captured envelopes feed an internal
aggregator that produces hourly + daily snapshots for PCC operators on the
`PCC_DEMAND_ADMINS` allowlist. The data is **not** published, **not** signed
for external verification, and **not** written on-chain.

See `packages/spec/src/types/demand.ts` for the full field-level data
contract and `packages/gateway/src/routes/intent-ingest.ts` for the server
gate (auth, rate-limit, idempotency).
