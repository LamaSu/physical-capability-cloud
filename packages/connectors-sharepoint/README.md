# @pcc/connectors-sharepoint

Thin TS client for the Python `connectors-runtime` sidecar's sharepoint
source.

> **v0.1 status**: the runtime recognises `kind: "sharepoint"` but
> returns `501 vendor_sdk_not_wired` on creation. The vendor SDK pin
> (Microsoft Graph) lands in Wave 4. This shell ships now so the
> orchestrator-sdk has a stable import surface to depend on.

## Usage

```ts
import { createSharepointSource, runPipeline, getPipelineStatus } from "@pcc/connectors-sharepoint";

const source = await createSharepointSource({
  site_url: "https://acme.sharepoint.com/sites/finance",
  access_token: graphAccessToken,
  libraries: ["Documents"],
});
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CONNECTORS_RUNTIME_URL` | `http://127.0.0.1:8766` | Where the Python sidecar listens. |
