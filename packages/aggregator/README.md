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
