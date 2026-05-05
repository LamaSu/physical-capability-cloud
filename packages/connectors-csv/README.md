# @pcc/connectors-csv

Thin TS client for the Python `connectors-runtime` sidecar's CSV source.

Unlike `@pcc/connectors-{salesforce,sharepoint,sap}`, CSV is fully wired
in v0.1 — the runtime uses `dlt.sources.filesystem` underneath and
supports both local paths and (with the appropriate filesystem backend)
cloud URIs (s3://, gs://, etc).

## Usage

```ts
import { createCsvSource, runPipeline, getPipelineStatus } from "@pcc/connectors-csv";

// Local directory of CSVs.
const source = await createCsvSource({
  bucket_url: "/data/exports",
  file_glob: "*.csv",
});

// Or an S3 prefix (requires the runtime to have s3fs installed):
// const source = await createCsvSource({ bucket_url: "s3://acme-data/exports" });
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CONNECTORS_RUNTIME_URL` | `http://127.0.0.1:8766` | Where the Python sidecar listens. |
