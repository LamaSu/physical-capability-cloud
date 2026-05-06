# Cypher Bio Integration

PCC ↔ Cypher Bio (cypherbio.ai) integration across three tracks.

**Reverse-engineered API spec** (origin, auth, full endpoint map, federation catalog schema, user identity, stack signals): `~/.cache/cypherbio/CYPHER-API-NOTES.md` (or wherever the user keeps it locally — not committed to this repo).

## What's shipping

### Track B — `@pcc/cypher-lims-bridge` (LIMS step-executor, ships today)

Path: `packages/cypher-lims-bridge/`

PCC operators take Cypher LIMS workflow steps as work and post measurements back. Works with the LIMS-scoped key `cyp_lims_*` you can mint from any Cypher tenant's `/api-keys` page.

- `CypherClient` — native-fetch HTTP client, `X-API-Key` auth, methods for every public + LIMS endpoint enumerated in CYPHER-API-NOTES.md
- `LimsPoller` — EventEmitter-based polling daemon for `/api/lims/requests`, deduplicates by request ID, errors don't crash
- `mapper.ts` — Cypher `Service` → PCC `Capability` mapping (one direction; reverse lives in Track A)
- 6 MCP tool handlers exported via `cypherToolDefinitions[]` (also surfaced in `apps/dashboard/public/agent-package.json` v2.12.0+)

Tests: 112 vitest unit tests, mocking via `vi.spyOn(global, 'fetch')`. Zero runtime deps.

### Track A — `@pcc/cypher-federation` (federation peer scaffolding)

Path: `packages/cypher-federation/`

Scaffolds PCC as a federated Cypher peer instance. **Cannot test live until Cypher grants federation peering** (`cyp_lims_*` keys return 403 on `/api/federation/instances/register`). Send the manifest to `info@cypherbio.ai` to request peering.

- `FederationPeer` — HTTP client for register/disconnect/status/browseServices/publishService
- `buildPccFederationManifest()` — generates PCC's federation manifest (instanceId, name, baseUrl, services from PCC's capability types)
- `mapper.ts` — bidirectional Cypher `Service` ↔ PCC `Capability` (extends Track B's one-way mapper)
- `OrderTranslator` — incoming Cypher `Order` → PCC A2A intent → MilestoneEscrow funding → operator fulfillment loop → CVP attestation → settle callback to Cypher
- `createPeerEndpoint(...)` — Express router for `/cypher/federation/{services,orders,status}` to mount on the PCC gateway
- `scripts/register-with-cypher.ts` — CLI: builds manifest, attempts register, prints redacted credentials on success or "email info@cypherbio.ai" on 403

Tests: 72 unit + 3 `it.todo` deferred to live integration time.

### Track C — Dashboard catalog mirror

Path: `apps/dashboard/src/pages/CypherCatalogPage.tsx` + tile component + types + fixture + tests.

Public read-only mirror of `https://cypherbio.ai/backend/api/federation/services/public`. Renders federated services as tiles with provider, pricing, turnaround, JSON-Schema order-form preview, terms link. Loading / error / empty states.

Routed at `/cypher-catalog`. CORS may block direct browser fetch in production — comment in the page documents the recommended `/api/proxy/cypher/federation-catalog` gateway proxy as a follow-up.

Tests: 12 vitest tests (`extractServices` parsing variants + fixture sanity + tile element shape).

## Cypher API in 30 seconds

| Layer | Detail |
|---|---|
| Origin | `https://cypherbio.ai/backend` (CloudFront → Express. The marketing site SPA is at the apex; the API lives under `/backend/*`.) |
| Auth | `X-API-Key: cyp_lims_*` header. **Not** `Authorization: Bearer`. |
| Public endpoints (no auth) | `/api/protocols/public`, `/api/protocolsets/public`, `/api/federation/services/public` |
| LIMS scope (`cyp_lims_*`) | `/api/lims/{workflows, steps, requests, executions, measurements, record-work}` — full CRUD on most |
| Federation scope (admin-only) | `/api/federation/instances/register`, `/api/federation/orders` — returns 403 on `cyp_lims_*` keys |
| Federation catalog (live) | 2 active providers as of 2026-05-06: WayBio (plasmid prep) + Flock Bio (pooled DNA libraries). Both quote-priced. |

Tenant subdomains exist (`enzidia.cypherbio.ai`, `flockbio.cypherbio.ai`, `pando.cypherbio.ai`, `waybio.cypherbio.ai`) — same backend, different SPA build per tenant.

## Auth scopes

The user-facing key prefix maps to scope:

- `cyp_lims_*` — LIMS module only (this is what every Cypher tenant user can mint from their `/api-keys` page). Sufficient for Track B and Track C. **Insufficient for Track A live integration.**
- `cyp_admin_*` (assumed naming) — full surface including federation registration. Requires Cypher peering grant. Not a self-serve mint.

## Open follow-ups

1. **Federation peering**: email Yaoyu Yang at `info@cypherbio.ai` with PCC's manifest (run `pnpm --filter @pcc/cypher-federation tsx scripts/register-with-cypher.ts` to print the manifest body). Until peered, Track A is scaffold-only.
2. **PCC gateway proxy**: add `/api/proxy/cypher/federation-catalog` that forwards `GET /backend/api/federation/services/public` so the dashboard works around CORS in production.
3. **`@pcc/spec` shared types**: Track A and B currently define overlapping Cypher types locally. Post-merge, lift them into `@pcc/spec` as `CypherFederationService`, `CypherLimsRequest`, etc.
4. **DRY mapper**: Track A's bidirectional mapper duplicates Track B's one-way mapper. Lift the shared half into a new `@pcc/cypher-types` package, or import Track B from Track A once both are stable.
5. **Live LIMS integration test**: gated behind a real `CYPHER_API_KEY` env. Implementer-bravo's test file marks integration cases as `it.todo`.
6. **Mobile money / fiat-bridge**: Cypher uses `pricingModel: 'quote'` exclusively today. PCC's milestone-escrow + fiat-ramps could let Cypher operators accept on-chain settlement directly.

## What is NOT shipped

- Live federation peering (waiting on Cypher signoff)
- The PCC gateway `/api/proxy/cypher/*` route (Track C documents the URL pattern as a TODO)
- DRY-ing of duplicated Cypher types across the two packages
- Cypher tool surfacing on the PCC dashboard agent-package endpoint UI (the JSON has them; no card-renderer yet)

## Test artifact

A test workflow `WFL-20260506-0002` was created in the user's Cypher LIMS tenant during API discovery. The `cyp_lims_*` key cannot DELETE workflow roots. Clean up via the Cypher LIMS UI when convenient.
