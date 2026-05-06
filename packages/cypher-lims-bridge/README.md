# @pcc/cypher-lims-bridge

Bridge package between Cypher Bio's LIMS and the PCC operator surface.

PCC operators take Cypher LIMS workflow steps as work, post measurements back as
evidence, and surface Cypher's federation catalog as PCC capabilities.

## What this package does

1. **Polls Cypher LIMS for new requests** — `LimsPoller` watches
   `GET /api/lims/requests` on a configurable interval and emits a
   `request-discovered` event when a new request appears.
2. **Wraps the Cypher REST API** — `CypherClient` provides typed methods for
   the LIMS, federation, and protocol endpoints documented in
   `~/.cache/cypherbio/CYPHER-API-NOTES.md`.
3. **Maps federation services to PCC capabilities** — `cypherServiceToPccCapability`
   translates Cypher's federation catalog entries (e.g., WayBio plasmid prep)
   into PCC's `Capability` shape, so they can be cross-listed in the PCC
   discovery layer. The reverse map is also exported.
4. **Exposes MCP-style tool handlers** — six handlers (`cypher_browse_federation_catalog`,
   `cypher_list_lims_requests`, `cypher_get_lims_request`, `cypher_advance_step`,
   `cypher_post_measurement`, `cypher_record_work`) each have a `definition`
   property with the input schema + endpoint mapping for cross-listing in the
   PCC agent package.

## Auth model

Cypher uses `X-API-Key: <key>` (NOT `Authorization: Bearer`). LIMS-scoped keys
have the `cyp_lims_*` prefix and can:

- Read & write the LIMS module (`/api/lims/*`)
- Read public federation catalog (`/api/federation/services/public`)
- Read public protocols (`/api/protocols/public`)

Keys CANNOT:

- Read `/api/docs/openapi.json` (403 Insufficient scope)
- Hit `/api/me` with a useful payload (returns the same 403 message)
- Register new federation instances (admin scope required)

The client surfaces these errors as `CypherApiError` with the status preserved.

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CYPHER_API_KEY` | LIMS-scoped key from Cypher settings UI. Format: `cyp_lims_<base64>`. | none (required) |
| `CYPHER_BASE_URL` | Cypher API base. | `https://cypherbio.ai/backend` |
| `CYPHER_POLL_INTERVAL_MS` | Poll interval for new LIMS requests, in milliseconds. | `30000` |
| `CYPHER_OPERATOR_ID` | Optional operator tag for record-work / advance-step calls. | none |

Copy `.env.example` to `.env` and fill in `CYPHER_API_KEY`.

## Quick start

```ts
import {
  CypherClient,
  LimsPoller,
  cypherServiceToPccCapability,
  cypherToolDefinitions,
} from '@pcc/cypher-lims-bridge';

const client = new CypherClient({
  apiKey: process.env.CYPHER_API_KEY!,
  baseUrl: process.env.CYPHER_BASE_URL,
});

// 1. Browse the federation catalog (no auth required)
const catalog = await client.browseFederationCatalogPublic();
const pccCapabilities = catalog.data.map(cypherServiceToPccCapability);

// 2. Poll for new LIMS requests
const poller = new LimsPoller({ client, intervalMs: 30000 });
poller.on('request-discovered', (req) => {
  console.log('New LIMS request:', req.requestNumber);
});
poller.start();

// 3. Use the MCP tool definitions in an agent package
console.log(cypherToolDefinitions.length); // 6 tools
```

## Endpoints wrapped (selected — see `src/client.ts` for all)

| Method | Path | Wrapper |
|--------|------|---------|
| GET | `/api/me` | `client.getMe()` |
| GET | `/api/lims/requests` | `client.listLimsRequests()` |
| GET | `/api/lims/requests/:requestNumber` | `client.getLimsRequest()` |
| GET | `/api/lims/workflows` | `client.listLimsWorkflows()` |
| POST | `/api/lims/workflows` | `client.createLimsWorkflow()` |
| POST | `/api/lims/steps` | `client.advanceStep()` |
| POST | `/api/lims/measurements/batches/preview` | `client.postMeasurementBatchPreview()` |
| POST | `/api/lims/measurements/batches/from-csv` | `client.postMeasurementsFromCsv()` |
| POST | `/api/lims/record-work` | `client.recordWork()` |
| GET | `/api/federation/services/public` (no auth) | `client.browseFederationCatalogPublic()` |
| GET | `/api/protocols/public` (no auth) | `client.getProtocolsPublic()` |

## Sibling packages

- `@pcc/cypher-federation` — peer package, registers PCC as a Cypher federation
  instance and provides the inbound HTTP receiver for orders coming the other
  way (Cypher → PCC).

## License

Apache-2.0 (matches PCC monorepo).
