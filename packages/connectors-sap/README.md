# @pcc/connectors-sap

Thin TS client for the Python `connectors-runtime` sidecar's SAP source.

> **v0.1 status**: the runtime recognises `kind: "sap"` but returns
> `501 vendor_sdk_not_wired` on creation. The vendor SDK pin (likely
> PyRFC or SAP OData via dlt's sql_database) lands in Wave 4. This shell
> ships now so the orchestrator-sdk has a stable import surface to
> depend on.

## Usage

```ts
import { createSapSource, runPipeline, getPipelineStatus } from "@pcc/connectors-sap";

const source = await createSapSource({
  base_url: "https://sap.acme.com/sap/opu/odata/sap/",
  username: "alice",
  password: "topsecret",
  entity_sets: ["MaterialSet"],
});
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CONNECTORS_RUNTIME_URL` | `http://127.0.0.1:8766` | Where the Python sidecar listens. |
