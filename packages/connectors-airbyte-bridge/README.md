# @pcc/connectors-airbyte-bridge

Escape hatch for enterprises that already run [Airbyte](https://airbyte.com).
This package does **not** provision sources or destinations — Airbyte's
own UI/API owns that. The bridge is the thin glue (~100 LoC) that lets
a PCC orchestrator trigger an existing Airbyte connection and poll its
status.

This is an **optional** dependency. New PCC deployments should prefer
the dlt-based connectors (`@pcc/connectors-postgres` etc) — they don't
require any external services. Only load this when an enterprise
specifically needs to integrate with their existing Airbyte deployment.

## Usage

```ts
import { triggerAirbyteJob, getAirbyteJobStatus } from "@pcc/connectors-airbyte-bridge";

const job = await triggerAirbyteJob("connection-uuid", { jobType: "sync" });
// poll periodically...
const status = await getAirbyteJobStatus(job.jobId);
if (status.status === "succeeded") { /* ... */ }
```

## Configuration

Both env vars are **required** at call time. The bridge throws
`AirbyteError("airbyte_not_configured", ...)` if either is missing — by
design, so a fresh PCC install with no Airbyte deployment never tries
to talk to an Airbyte that doesn't exist.

| Env var | Purpose |
|---|---|
| `AIRBYTE_API_URL` | Full base URL including version segment, e.g. `https://airbyte.acme.com/api/v1` (open-source) or `https://api.airbyte.com/v1` (Cloud). |
| `AIRBYTE_API_KEY` | Bearer token for the Airbyte API. |

## When to use this vs the dlt shells

| Situation | Use |
|---|---|
| Greenfield PCC deployment, no existing ETL | `@pcc/connectors-{postgres,salesforce,sharepoint,sap,csv}` (dlt-based) |
| Enterprise has Airbyte already, wants to keep using it | this bridge |
| Need a connector dlt doesn't offer (e.g. niche SaaS) | this bridge (Airbyte has 350+ connectors) |
