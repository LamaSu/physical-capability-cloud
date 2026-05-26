# @pcc/intent-otel-exporter

OpenTelemetry exporter that **detects intent-shaped spans** in any OTel
pipeline and forwards them to PCC's `/api/intents/ingest` as
`DemandEnvelope`s.

Use this when your agent (or the framework it runs in — LangChain,
LlamaIndex, OpenLLMetry, Semantic Kernel, enterprise SaaS) is **already
emitting OpenTelemetry traces**. You drop the exporter (or sidecar
SpanProcessor) into the existing pipeline and PCC starts seeing the
same demand signal it captures from `requests`, `negotiate`, `query`
APIs — no application code changes.

This is Phase 2.3 of the intent-network-interception roadmap.

| Tool | Use when | Sample integration |
|------|----------|--------------------|
| `@pcc/intent-broker` (MCP server) | Client agent is MCP-capable (Claude Desktop, Cursor, Goose, ChatGPT Apps) and you can ask it to call `register_intent` | Add to `mcpServers` config |
| `@pcc/intent-collector-sdk` *(Phase 2.2)* | Application code can wrap `fetch` / `axios` directly | `import { wrapFetch } from "@pcc/intent-collector-sdk"` |
| **`@pcc/intent-otel-exporter`** (this) | Agent already emits OTel spans and you don't want to instrument again | `BatchSpanProcessor(new IntentEnvelopeSpanExporter({...}))` |

## Install

```bash
pnpm add @opentelemetry/sdk-node @pcc/intent-otel-exporter
```

You also need `@opentelemetry/api` and `@opentelemetry/sdk-trace-base` in
your dependency graph — they are peer-of-peer deps of the SDK you already
use.

## Setup

### Option A — drop-in exporter (recommended for new pipelines)

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { IntentEnvelopeSpanExporter } from "@pcc/intent-otel-exporter";

const sdk = new NodeSDK({
  spanProcessors: [
    // Your existing trace pipeline — unchanged.
    new BatchSpanProcessor(new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    })),

    // PCC intent capture — composes alongside.
    new BatchSpanProcessor(new IntentEnvelopeSpanExporter({
      ingestUrl: process.env.PCC_INTENT_INGEST_URL ?? "https://capability.network/api/intents/ingest",
      apiKey: process.env.PCC_API_KEY,
    })),
  ],
});

sdk.start();
```

### Option B — sidecar processor (for pipelines you can't restructure)

```ts
import { IntentSpanProcessor } from "@pcc/intent-otel-exporter";

const sdk = new NodeSDK({
  spanProcessors: [
    // existing chain stays exactly as-is...
    new BatchSpanProcessor(new OTLPTraceExporter({...})),

    // ...and the sidecar runs in parallel
    new IntentSpanProcessor({
      ingestUrl: "https://capability.network/api/intents/ingest",
      apiKey: process.env.PCC_API_KEY,
      flushIntervalMs: 5000,
    }),
  ],
});
```

**Use Option A OR Option B**, not both — that would double-count every
span.

## Environment variables

| Var | Default | Required | Notes |
|-----|---------|----------|-------|
| `PCC_API_KEY` | (none) | yes for live POSTs | Bearer token from `POST /api/auth/provision`. If absent, the exporter validates locally but skips network — useful in dev. |
| `PCC_INTENT_INGEST_URL` | `https://capability.network/api/intents/ingest` | no | Override for self-hosted or staging PCC instances. |

This package reads neither of these env vars directly — you pass them into
the constructor. Use whatever name pattern your codebase already follows.

## What spans get captured

The default attribute mapper considers a span "intent-shaped" if any of:

- **Span name** matches `tool.*`, `mcp.*`, `agent.*`, `gen_ai.*`, or exactly
  `http.request`.
- **Span attributes** include any of:
  - `gen_ai.tool.name`
  - `gen_ai.operation.name`
  - `gen_ai.system`
  - `mcp.tool.name`
  - `agent.action`
  - `pcc.capability_types`

Spans that don't match are silently skipped and counted under
`exporter.getStats().skipped`.

## OTel semantic conventions honored

The default mapper reads (in precedence order):

| Source | Attribute | Maps to `DemandEnvelope` field |
|--------|-----------|-------------------------------|
| Client override | `pcc.capability_types` (array or comma-separated string) | `capabilityTypes` |
| GenAI semconv | `gen_ai.tool.name` | `capabilityTypes` (fallback) |
| MCP convention | `mcp.tool.name` | `capabilityTypes` (fallback) |
| Span name | `tool.search`, etc. | `capabilityTypes` (last resort) |
| Client override | `pcc.summary` | `summary` (truncated to 200 chars) |
| GenAI semconv | `gen_ai.operation.name + gen_ai.tool.name` | `summary` (composed) |
| HTTP semconv | `http.method + url.full \| http.url \| http.target` | `summary` (fallback) |
| Span name | (raw) | `summary` (last resort) |
| Client override | `pcc.origin_agent_vendor` | `originAgentVendor` |
| GenAI semconv | `gen_ai.system` | `originAgentVendor` (fallback) |
| Resource | `service.name` | `originAgentVendor` (fallback) |
| Client override | `pcc.origin_agent_id` | `originAgentId` |
| Client override | `pcc.budget_band` | `budgetBand` (or `under_100` default) |
| Client override | `pcc.urgency_band` | `urgencyBand` (or `standard` default) |
| Client override | `pcc.assurance_tier` (0/1/2/3) | `assuranceTier` |
| Client override | `pcc.geographic_region` | `geographicRegion` |
| Client override | `pcc.requester_id_hash` (sha256 hex) | `requesterIdHash` |
| Auto | `sha256(sorted capabilityTypes + [])` | `compositionSignature` |
| Auto | `span.startTime` | `createdAt` (ISO 8601) |

Reference: <https://opentelemetry.io/docs/specs/semconv/gen-ai/>

## What it does NOT do

- **Read span bodies, events, links, or status.** Only span name +
  attributes + resource attributes.
- **Forward raw PII.** Hash identities upstream and stamp the hash as
  `pcc.requester_id_hash` if you want them attached.
- **Break your trace pipeline.** `export()` returns SUCCESS the moment we
  accept the spans for forwarding; transport hiccups route through the
  configurable `onError` callback so they never bubble out of the OTel SDK.
- **Replace your existing exporter.** You compose it alongside whatever
  you're using today (OTLP, Honeycomb, Jaeger, Sentry, etc.).
- **Auto-publish OTel spans to PCC for other consumers.** This is a
  ONE-WAY capture path. PCC reads; nothing flows back into your traces.

## Counters

Both `IntentEnvelopeSpanExporter` and `IntentSpanProcessor` expose
`getStats()` for ops dashboards:

```ts
exporter.getStats();
// {
//   exported: 142,               // spans mapped to envelopes
//   skipped: 88,                 // non-intent spans filtered
//   rejected: 0,                 // mapper threw / failed validation
//   forwardedAccepted: 140,      // POST returned 2xx
//   forwardedRejected: 2,        // POST returned non-2xx or transport err
// }
```

Counters are best-effort and reset only by constructing a new instance.

## Custom attribute mapper

Override the default if your platform stamps attributes under a
proprietary namespace:

```ts
import { IntentEnvelopeSpanExporter, type MinimalSpan } from "@pcc/intent-otel-exporter";
import { computeCompositionSignature, type DemandEnvelope } from "@pcc/spec";

const exporter = new IntentEnvelopeSpanExporter({
  ingestUrl: "https://capability.network/api/intents/ingest",
  apiKey: process.env.PCC_API_KEY,
  attributeMapper: (span: MinimalSpan): DemandEnvelope | null => {
    // your platform stamps the capability as 'acme.capability'
    const cap = span.attributes["acme.capability"];
    if (typeof cap !== "string") return null;
    return {
      id: `acme-${Date.now()}`,
      source: "otel",
      compositionSignature: computeCompositionSignature([cap], []),
      capabilityTypes: [cap],
      summary: span.name,
      budgetBand: "under_100",
      urgencyBand: "standard",
      createdAt: span.startTimeISO ?? new Date().toISOString(),
    };
  },
});
```

Returning `null` skips the span without bumping the rejected counter.

## Filtering by span kind

If your codebase emits a lot of `INTERNAL` spans you don't want to scan,
constrain the exporter:

```ts
new IntentEnvelopeSpanExporter({
  ingestUrl: "...",
  apiKey: "...",
  intentSpanKindFilter: new Set(["CLIENT", "SERVER"]),
});
```

Valid names: `"INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER"`.

## Python integration

Python agents with `opentelemetry-python` should use the Python sibling
package (Phase 2.3.b — landing later). The wire contract is identical:
POST a `DemandEnvelope` JSON body with `Authorization: Bearer <key>` to
the same ingest URL. Until the Python package ships, hand-roll a
`SpanExporter` that mirrors the precedence rules in the OTel-semconv table
above.

## Privacy

PCC's demand-intel store is **private**. Captured envelopes feed an
internal aggregator that produces hourly + daily snapshots for PCC
operators on the `PCC_DEMAND_ADMINS` allowlist. The data is **not**
published, **not** signed for external verification, and **not** written
on-chain.

See `packages/spec/src/types/demand.ts` for the full field-level data
contract and `packages/gateway/src/routes/intent-ingest.ts` for the server
gate (auth, rate-limit, idempotency).
