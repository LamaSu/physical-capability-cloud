# `@pcc/aggregator`

Universal tool aggregator engine for the Physical Capability Cloud.

Ingests tool descriptors from MCP servers, OpenAPI documents, and public MCP
registries, normalizes them into the `IndexedTool` shape from `@pcc/spec`,
runs them through a 6-stage pipeline (discover → fetch → transform → enrich
→ verify → publish), and stores them in an in-memory registry.

The gateway consumes this engine via `/api/aggregator/*` routes; the
crawler-worker drives it from a separate process so a slow crawl never
blocks a request.

## Pipeline

```
adapter.fetch  -> transform -> enrich (cid + trustTier) -> verify (Phase-1 stub)
              -> publish (upsert into IndexedToolRegistry)
```

Defined in `src/pipeline.ts`. Stage report emitted per run; per-tool errors
keyed by `IndexedTool.id`.

## Source adapters

| Adapter | File | Source type | Notes |
|---|---|---|---|
| MCP HTTP | `src/sources/mcp.ts` | `mcp-directory` (default) | JSON-RPC `tools/list` over HTTP. Stdio MCP servers deferred. |
| OpenAPI | `src/sources/openapi.ts` | `openapi-doc` | One IndexedTool per (path, method). JSON-only Phase 1. |
| Registry crawler | `src/sources/mcp-registry-crawler.ts` | per-registry | Polls Smithery / Glama / mcp.directory / mcp.so and chains the MCP HTTP adapter. |
| AGNTCY ADS | `src/sources/agntcy-ads.ts` | `agntcy-dht` | Pulls OASF v1.0.0 agent records from the AGNTCY Agent Directory Service via REST `POST /v1/search` (Phase 1). Skill filter required per AGNTCY G6. Round-trip detection via `physical-capability/v1` module. |

## Crawler worker

`src/crawler-worker.ts` is a standalone long-running process that polls every
configured MCP registry on a schedule and pushes each registry's drafts
through the pipeline.

### Run it

```bash
# After `pnpm --filter @pcc/aggregator build`:
node packages/aggregator/dist/crawler-worker.js
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PCC_CRAWLER_INTERVAL_MS` | `3600000` (1h) | Polling interval. Floor 60s. |
| `PCC_CRAWLER_REGISTRIES` | (all 4) | CSV. Subset of `smithery,glama,mcp.directory,mcp.so`. |
| `PCC_CRAWLER_QUERY` | (none) | Optional search query appended as `?q=`. |
| `PCC_CRAWLER_MAX_SERVERS` | `50` | Per-registry cap on servers crawled. |
| `PCC_CRAWLER_RUN_ONCE` | `0` | If `1`/`true`, crawl once and exit (cron mode). |
| `PCC_SMITHERY_API_KEY` | (none) | Smithery API key. Without it, listing is lower-resolution. |

### Cron-style one-shot

```bash
PCC_CRAWLER_RUN_ONCE=1 \
PCC_CRAWLER_REGISTRIES=smithery,glama \
node packages/aggregator/dist/crawler-worker.js
```

### Systemd unit (sketch)

```ini
[Service]
Environment=PCC_CRAWLER_INTERVAL_MS=900000
Environment=PCC_SMITHERY_API_KEY=...
ExecStart=/usr/bin/node /opt/pcc/packages/aggregator/dist/crawler-worker.js
Restart=on-failure
```

### Logs

The worker emits one JSON line per event on stdout — pipe into your log
aggregator of choice (Loki / Honeycomb / CloudWatch). Event types:

- `startup`
- `crawl_start` (per registry)
- `crawl_listing_done` (per registry)
- `crawl_pipeline_done` (per registry)
- `crawl_complete` (per crawl loop)
- `crawl_error` (top-level)
- `shutdown_signal`
- `exit`

## Phase 2 hand-off

The Phase 1 worker keeps the published tools in its own process-local
registry. Phase 2 will POST each batch to `/api/aggregator/ingest` so the
gateway-side registry stays in sync. Track via the issue tagged
`aggregator-phase-2-sync`.

## AGNTCY ADS + OASF bridge (Phase 1)

Bidirectional bridge between PCC and the AGNTCY Agent Directory Service.
Spec: `ai/scoping/agntcy-ads-oasf-bridge-2026-05-23.md`.

### Inbound

```typescript
import { makeAgntcyAdsSourceAdapter } from "@pcc/aggregator";

const adapter = makeAgntcyAdsSourceAdapter({
  skill: "manufacturing/cnc-5axis", // REQUIRED per AGNTCY G6
  domains: ["manufacturing/cnc"],
  limit: 50,
});
const drafts = await adapter.fetch({
  url: "https://prod.api.ads.outshift.io",
});
```

Trust defaults: `VERIFIED_PARTNER / DCC4`. Round-tripped PCC records
(detected by the `physical-capability/v1` module's `pcc_facets` block)
get `PCC_NATIVE / DCC5` instead.

### Outbound

```typescript
import {
  AgntcyAdsPublisher,
  cosignShellSpawn,
} from "@pcc/aggregator";

const pub = new AgntcyAdsPublisher({
  endpoint: process.env.AGNTCY_API_URL,
});
const result = await pub.publish(tool, {
  authToken: process.env.AGNTCY_OIDC_TOKEN,
  cosignSpawn: cosignShellSpawn,
});
// result.externalCid, result.announced, result.sigstoreBundle, result.errors
```

Sigstore (Phase 1) shells out to `cosign sign-blob --new-bundle-format`.
Phase 2 will swap in `@sigstore/sign` in-process.

### Gateway routes (admin)

All gated by the `PCC_AGGREGATOR_ADMINS` allowlist (same as MCP/OpenAPI
ingest routes):

- `GET  /api/aggregator/agntcy/status`     — bridge state + counters
- `POST /api/aggregator/ingest/agntcy`     — `{skill, domains?, features?, limit?, url?, runVerify?}`
- `POST /api/aggregator/publish/agntcy`    — `{tool, endpoint?, announce?, enableSigstore?}`

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `AGNTCY_API_URL` | `https://prod.api.ads.outshift.io` | ADS REST endpoint |
| `AGNTCY_OIDC_CLIENT_ID` | (unset) | OIDC client id, reported in `/status` |
| `AGNTCY_OIDC_TOKEN` | (unset) | OIDC bearer for publish (required) |
| `AGNTCY_SIGSTORE_DISABLED` | `false` | Set to `"true"` to skip Sigstore signing |
| `COSIGN_BINARY_PATH` | `cosign` | Path to cosign binary |
| `COSIGN_OIDC_ISSUER` | `https://oauth2.sigstore.dev/auth` | Sigstore Fulcio OIDC issuer |
| `COSIGN_OIDC_CLIENT_ID` | `sigstore` | Sigstore Fulcio client id |
| `ERC8004_REGISTRY` | (unset) | Projected into `pcc_facets.erc8004_registry` |

### Trust mapping

`src/trust/agntcy-publisher-map.ts` maps a Sigstore identity to a PCC
trust tier (spec doc §6.1):

| OIDC identity | Trust tier | DCC |
|---|---|---|
| LF founder org (anthropic / cisco / outshift / dell / google / oracle / redhat) | `VERIFIED_PARTNER` | DCC4 |
| GitHub Actions OIDC | `VERIFIED_PUBLISHER` | DCC3 |
| Any other verified Sigstore identity | `VERIFIED_PUBLISHER` | DCC3 |
| Sigstore present, unverified (Phase 1 default) | `VERIFIED_PARTNER` | DCC4 |
| No Sigstore bundle | `AUTO_INDEXED` | DCC2 |
| Rekor proof failed | `QUARANTINED` | DCC0 |

### OASF catalog

`src/oasf/catalog.ts` is a small subset of the OASF v1.0.0 skill /
domain / module catalog used by the publisher to fill the `id` field
on `skills[]` and `domains[]`. Unknown slugs fall back to top-level
category IDs (1001 / 1500) and the full PCC taxonomy rides on the
`physical-capability/v1` module instead. Phase 3 will contribute a
`manufacturing/*` and `biotech/*` skill subtree to
https://github.com/agntcy/oasf so PCC's full taxonomy gets real OASF
IDs.

### Phase 2+ deferral list

- gRPC integration via `@buf/agntcy_oasf-sdk.grpc_node`
- `@sigstore/sign` in-process (vs cosign shell-out)
- `MCPRegistryCrawler` integration (adding AGNTCY as the 5th polled target)
- Per-tenant publisher identity (operators publish under their own OIDC)
- Local DHT participation (running our own `dirctl daemon`)
- OASF `manufacturing/*` and `biotech/*` skill subtree contribution

## Receipt signer

`src/receipt-signer.ts` produces HMAC-SHA256 receipts for DCC1
invocations. Ed25519 + Sigstore-backed signing arrives in Phase 2.

## Tests

```bash
pnpm --filter @pcc/aggregator test
```

Suites:

- `__tests__/registry.test.ts` — IndexedToolRegistry
- `__tests__/pipeline.test.ts` — 6-stage pipeline + cid stability
- `__tests__/receipt-signer.test.ts` — HMAC + receipt CID round-trip
- `__tests__/crawler-worker.test.ts` — env config + one-crawl publish
- `sources/__tests__/mcp.test.ts` — MCP HTTP adapter
- `sources/__tests__/openapi.test.ts` — OpenAPI adapter
- `sources/__tests__/mcp-registry-crawler.test.ts` — 4-registry crawler
- `sources/__tests__/agntcy-ads.test.ts` — AGNTCY ADS source adapter
- `publishers/__tests__/agntcy-ads.test.ts` — AGNTCY ADS publisher
- `oasf/__tests__/catalog.test.ts` — OASF catalog lookups + locator inference
- `trust/__tests__/agntcy-publisher-map.test.ts` — Sigstore identity → trust tier mapping
