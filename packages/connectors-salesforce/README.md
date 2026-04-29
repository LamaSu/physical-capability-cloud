# @pcc/connectors-salesforce

Thin TS client for the Python `connectors-runtime` sidecar's salesforce
source.

> **v0.1 status**: the runtime recognises `kind: "salesforce"` but
> returns `501 vendor_sdk_not_wired` on creation. The vendor SDK pin
> lands in Wave 4. This shell ships now so the orchestrator-sdk has a
> stable import surface to depend on.

## Usage

```ts
import { createSalesforceSource, runPipeline, getPipelineStatus } from "@pcc/connectors-salesforce";

const source = await createSalesforceSource({
  instance_url: "https://acme.my.salesforce.com",
  access_token: oauthAccessToken,
  objects: ["Account", "Opportunity"],
});
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CONNECTORS_RUNTIME_URL` | `http://127.0.0.1:8766` | Where the Python sidecar listens. |
