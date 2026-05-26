# @pcc/intent-collector

Embeddable TypeScript SDK any agent app drops in to capture intent-shaped
outbound HTTP calls and POST them as `DemandEnvelope`s to PCC's
`/api/intents/ingest` endpoint.

Phase 2.2 of the **intent-network-interception** roadmap. Complements:

- `@pcc/intent-broker` (Phase 2.1) — MCP server the agent must explicitly
  call from a tool invocation
- the OpenTelemetry exporter (Phase 2.3, in flight) — for ambient capture
  via OTel spans an agent already emits

Where the broker captures only what the agent decides to broadcast, the
collector captures intent the agent is firing into the network WITHOUT
knowing PCC exists.

## Install

```bash
pnpm add @pcc/intent-collector
# or
npm install @pcc/intent-collector
```

Zero runtime peer dependencies. Only `@noble/hashes` (small, audited) and
`@pcc/spec` (workspace).

## Quick start (vanilla Node fetch wrap)

```ts
import { IntentCollectorClient } from "@pcc/intent-collector";

const client = new IntentCollectorClient(); // env-driven config

// Wrap globalThis.fetch ONCE at app boot. Any call your agent makes via
// fetch now gets pattern-matched against the URL pattern library and, on
// match, queued as a DemandEnvelope.
globalThis.fetch = client.wrap(globalThis.fetch);

// Or pass it to your HTTP client of choice (undici, isomorphic-fetch, etc):
// const myFetch = client.wrap(myFetch);
```

After this, agent code that already does this:

```ts
await fetch("https://www.amazon.com/dp/B07XJ8C8F5");
await fetch("https://www.doordash.com/store/big-mama-12345/");
await fetch("https://m.uber.com/ride/?lat=37.77&lng=-122.42");
```

…surfaces three matching DemandEnvelopes that get batch-posted to PCC's
ingest endpoint. The agent makes no other changes.

## Quick start (Express middleware)

For agents that proxy intent-shaped routes through their own surface
(e.g. `/buy/amazon/:asin` → upstream Amazon call):

```ts
import express from "express";
import { IntentCollectorClient } from "@pcc/intent-collector";
import { expressIntentMiddleware } from "@pcc/intent-collector/middleware/express";

const app = express();
const client = new IntentCollectorClient();
app.use(expressIntentMiddleware({ client }));
```

The middleware inspects the inbound request URL against the same pattern
library and fires capture before the request handler runs. Non-matching
URLs cost one regex pass per registered pattern (≈18 patterns; <100µs
per request typical).

## Quick start (Next.js middleware)

App Router or Pages Router — add a `middleware.ts` at the project root:

```ts
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { IntentCollectorClient } from "@pcc/intent-collector";
import { nextIntentMiddleware } from "@pcc/intent-collector/middleware/next";

const client = new IntentCollectorClient();
const capture = nextIntentMiddleware({ client });

export function middleware(req: NextRequest) {
  capture(req);
  return NextResponse.next();
}

export const config = { matcher: "/(.*)" };
```

## Manual capture

For events the URL pattern library doesn't surface yet (anything bespoke
or domain-specific), call `captureIntent` directly:

```ts
client.captureIntent({
  capabilityTypes: ["custom-pcb-fab", "fulfillment-2week-us"],
  summary: "10-piece 2-layer PCB, lead-free HASL",
  budgetBand: "100_1k",
  urgencyBand: "standard",
  originAgentVendor: "claude",
  // optional — collector will hash if raw, pass through if already a 64-char hex
  requesterIdHash: "user@example.com",
});
```

The collector fills `id`, `source` (`"sdk"`), `compositionSignature`
(from `capabilityTypes`) and `createdAt` if you don't pass them.

## Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `PCC_API_KEY` | (none) | Bearer token from `POST /api/auth/provision`. Required for live posts. If absent, batches are dropped + a warning goes to stderr. |
| `PCC_INTENT_INGEST_URL` | `https://capability.network/api/intents/ingest` | Override for self-hosted or staging PCC instances. |
| `PCC_INTENT_COLLECTOR_ENABLED` | `true` | Set to `false` to make the client a no-op. **Opt-out**, not opt-in. |
| `PCC_INTENT_COLLECTOR_BATCH_SIZE` | `50` | Envelopes per batch before a forced flush. |
| `PCC_INTENT_COLLECTOR_FLUSH_INTERVAL_MS` | `5000` | Max ms between flushes. |

Constructor options override env vars:

```ts
new IntentCollectorClient({
  apiKey: process.env.MY_KEY,
  ingestUrl: "https://pcc-staging.example.com/api/intents/ingest",
  batchSize: 25,
  flushIntervalMs: 10_000,
  enabled: true,
  hasher: myCustomHasher, // (input: string) => string (hex)
});
```

## What gets captured

Per envelope (matches `@pcc/spec` `DemandEnvelope`):

- `id`, `source` (`"sdk"`), `createdAt` (ISO8601) — auto-filled
- `compositionSignature` — sha256 over sorted capabilityTypes + dep edges
- `capabilityTypes[]` — PCC-style kebab-case nouns (`food-delivery`,
  `rideshare`, etc.)
- `summary` — ≤200 chars, pattern-derived or caller-provided
- `budgetBand` / `urgencyBand` — coarse-grained buckets, no raw $
- Optional: `geographicRegion`, `assuranceTier`, `originAgentVendor`
- Hashed-when-passed: `originAgentId`, `requesterIdHash`

## What does NOT get captured

- HTTP request bodies / response data
- Raw PII — identifiers are sha256'd client-side before submission;
  already-hashed values (64-char hex) pass through unchanged
- Authentication headers / tokens / cookies
- Any URL the pattern library doesn't recognise (zero capture on
  no-match; wrap-fetch returns the underlying response unchanged)

## Submission behavior

- Batched: `batchSize` (50) or `flushIntervalMs` (5000ms), whichever
  fires first. Forced flush via `await client.flush()`.
- Dedup: within a batch, envelopes with identical
  `compositionSignature` are collapsed to one. Phase 1 schema supports
  cross-batch dedup at the gateway via the same signature.
- Retry: exponential backoff (≈100ms / 300ms / 900ms), max 3 attempts
  on 5xx, then drop + log to stderr.
- No retry on 4xx (caller bug) — drop + log immediately.
- Timer is `.unref()`'d — capture flushes won't keep your process
  alive past your other lifecycle hooks.
- `client.shutdown()` cancels the timer and clears the queue
  (graceful exit).

## Privacy

PCC's demand-intel store is **private**. Captured envelopes feed an
internal aggregator that produces hourly + daily snapshots for PCC
operators on the `PCC_DEMAND_ADMINS` allowlist. The data is **not**
published, **not** signed for external verification, and **not**
written on-chain.

Hash everything client-side. If you pass a raw value (e.g. an email)
to `originAgentId` or `requesterIdHash`, the collector hashes it
before submission. The gateway re-validates the schema; malformed
envelopes never reach the demand store.

See `packages/spec/src/types/demand.ts` for the full DemandEnvelope
contract and `packages/gateway/src/routes/intent-ingest.ts` for the
server gate (auth, rate-limit, idempotency).

## Pattern library

18 entries cover the major commerce, food, mobility, travel, and
scheduling surfaces (amazon, shopify, ebay, instacart, doordash,
ubereats, grubhub, postmates, caviar, uber, lyft, airbnb, booking,
expedia, kayak, calendly, opentable). To inspect:

```ts
import { URL_PATTERNS, matchUrlPattern } from "@pcc/intent-collector";

console.log(URL_PATTERNS.map((p) => p.name));
// → ["amazon-product", "amazon-cart", "shopify-cart", …]

console.log(matchUrlPattern("https://www.amazon.com/dp/B07XJ8C8F5"));
// → { pattern: { name: "amazon-product", … }, partial: { capabilityTypes: ["fulfillment-2day-us", "retail-purchase"], summary: "Amazon product page / order" } }
```

Patterns aim for high precision (no false positives on home pages,
unrelated routes, third-party docs) over high recall. Adding a new
pattern is a 3-line edit to `src/url-patterns.ts` + one positive +
one near-miss negative test.

## Related

- `@pcc/intent-broker` — MCP server for explicit `register_intent`
  calls from MCP-capable clients (Claude Desktop, Cursor, Goose,
  ChatGPT Apps).
- `@pcc/spec` — single source of truth for `DemandEnvelope` /
  `DemandSnapshot` types + `computeCompositionSignature`.
- `packages/gateway/src/routes/intent-ingest.ts` — server-side ingest
  endpoint (Bearer auth, per-operator rate limit, idempotency).
