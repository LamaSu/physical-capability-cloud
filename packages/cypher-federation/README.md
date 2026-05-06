# @pcc/cypher-federation

PCC ↔ Cypher Bio federation peer.

This package makes PCC act as a Cypher Bio federation **instance**: it
registers PCC's identity with Cypher, advertises PCC's capability
catalog as Cypher `Service`s, accepts inbound `Order`s coming from
Cypher operators, translates them into PCC A2A intents + escrow
flows, and reports settlement back to Cypher when the work
completes.

The companion package `@pcc/cypher-lims-bridge` covers the **other**
direction: PCC operators picking up work from Cypher's LIMS and
posting measurements back. Together the two packages let work flow
both ways across the boundary.

## Architecture

```
            ┌──────────────┐                 ┌────────────┐
            │   Cypher     │   /api/        │   PCC      │
            │  federation  │ ─ federation/  ▶│  gateway   │
            │   registry   │   instances/   │            │
            │              │   register      │            │
            └──────────────┘                 └────────────┘
                                                   │
                                          A2A intent + escrow
                                                   ▼
                                              ┌─────────┐
                                              │ kernels │
                                              └─────────┘
                                                   │
                                              settlement
                                                   ▼
                                            ┌────────────┐
                                            │ Cypher     │
                                            │ order      │
                                            │ status     │
                                            │ update     │
                                            └────────────┘
```

PCC mounts a public router at `/cypher/federation/*` on the gateway
that Cypher's order-router calls into. Inbound orders are translated
to PCC A2A intents (`submit_workflow`) and POSTed to PCC's
`/api/jobs/submit` (or built first via `/api/build/contract` when the
order needs negotiation).

## Components

| File | Role |
|---|---|
| `src/types.ts` | Shared types (Cypher service/instance/order, manifest, credentials, PCC capability summary) |
| `src/peer.ts` | `FederationPeer` HTTP client for `register`, `disconnect`, `status`, `browseServices`, `publishService`, `unpublishService` |
| `src/manifest.ts` | `buildPccFederationManifest` — generates the JSON body Cypher expects at register time. Calls `fetchPccCapabilities()` (= `${gatewayUrl}/api/capabilities/types`) to populate the services list. |
| `src/mapper.ts` | Bidirectional map: `cypherServiceToPccCapability` / `pccCapabilityToCypherService` |
| `src/translator.ts` | `OrderTranslator`: `cypherOrderToPccA2aIntent` + `pccSettlementToCypherOrderUpdate` |
| `src/endpoint.ts` | `createPeerEndpoint(...)` — Express router mounted on the PCC gateway under `/cypher/federation`. Handles inbound order POSTs and surfaces published services. |
| `scripts/register-with-cypher.ts` | One-shot CLI: builds manifest, attempts register, prints credentials (or manifest if 403). |

## Auth model

Cypher's federation registry uses the same `X-API-Key:` header as
the rest of its API, but the federation endpoints require an
**admin-scoped** key. A LIMS-scoped key (`cyp_lims_*` — what most
PCC operators have today) returns `403 Insufficient scope` on
`/api/federation/instances/register`.

This package **expects** to fail at register time on a LIMS key. The
register CLI handles that gracefully: it prints the manifest body
that Cypher would have stored, so the user can email it to Cypher
support and request federation peering for their key.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CYPHER_FEDERATION_API_KEY` | Cypher API key with federation scope. Format: `cyp_admin_<base64>`. | none (required) |
| `CYPHER_BASE_URL` | Cypher backend base URL. | `https://cypherbio.ai/backend` |
| `PCC_GATEWAY_URL` | PCC gateway URL (used by the manifest builder to fetch `/api/capabilities/types`). | `https://capability.network` |
| `PCC_FEDERATION_INSTANCE_ID` | PCC's instance ID inside Cypher's federation registry. | `pcc` |
| `PCC_FEDERATION_NAME` | Human-readable name. | `PCC` |
| `PCC_FEDERATION_BASE_URL` | Public URL of the PCC peer endpoint. | `https://capability.network/cypher/federation` |
| `PCC_FEDERATION_CONTACT_EMAIL` | Contact email Cypher displays alongside the instance card. | none |

## Quick start

```ts
import {
  FederationPeer,
  OrderTranslator,
  buildPccFederationManifest,
  createPeerEndpoint,
} from '@pcc/cypher-federation';

const peer = new FederationPeer({ apiKey: process.env.CYPHER_FEDERATION_API_KEY! });

// 1. Build a manifest from the live PCC catalog
const manifest = await buildPccFederationManifest({
  gatewayUrl: process.env.PCC_GATEWAY_URL ?? 'https://capability.network',
  instanceId: process.env.PCC_FEDERATION_INSTANCE_ID ?? 'pcc',
  name: process.env.PCC_FEDERATION_NAME ?? 'PCC',
  baseUrl: process.env.PCC_FEDERATION_BASE_URL ?? 'https://capability.network/cypher/federation',
  contactEmail: process.env.PCC_FEDERATION_CONTACT_EMAIL ?? '',
});

// 2. Register with Cypher (will 403 on a LIMS key — see auth section above)
const credentials = await peer.register(manifest);

// 3. Mount the inbound router on the PCC gateway
const router = createPeerEndpoint({
  peer,
  translator: new OrderTranslator({ pccGatewayUrl: process.env.PCC_GATEWAY_URL! }),
  gatewayClient: { /* fetch wrapper */ },
});

// app.use('/cypher/federation', router);
```

## Endpoints exposed (mountable Express router)

Mount under `/cypher/federation` on the PCC gateway:

| Method | Path | Purpose |
|---|---|---|
| GET | `/services` | List published PCC services (from the manifest cache). Read-only, public. |
| POST | `/orders` | Inbound order from Cypher. Body: `CypherOrder`. Translates to PCC A2A intent and POSTs to `/api/jobs/submit`. Returns `{ orderNumber, orderId, status }`. |
| GET | `/status` | Federation health. Returns `{ registered, lastSyncAt, openOrders }`. |
| POST | `/orders/:id/status` | Cypher pushes status updates (no-op for now; logged). |

All inbound bodies are validated with Zod. Errors return `400` with
`{ error, details }`.

## Sibling package

- `@pcc/cypher-lims-bridge` — PCC operator picks up Cypher LIMS work
  (the other direction).

## License

Apache-2.0 (matches PCC monorepo).
