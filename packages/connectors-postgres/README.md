# @pcc/connectors-postgres

Thin TS client for the Python `connectors-runtime` sidecar's postgres
source. Wraps `POST /sources`, `POST /pipelines/{id}/run`, and
`GET /pipelines/{id}/status` over plain `fetch()`.

The brain stays in TypeScript; the runtime keeps Python out of our
dependency tree.

## Usage

```ts
import {
  createPostgresSource,
  runPipeline,
  getPipelineStatus,
} from "@pcc/connectors-postgres";

const source = await createPostgresSource({
  credentials: "postgresql://user:pw@host/db",
  table_names: ["users", "orders"],
});

// (Create a destination via @pcc/connectors-* sibling, then `POST /pipelines`
// to bind them; the orchestrator-sdk does this end-to-end.)

const run = await runPipeline(pipelineId, { full_refresh: true });
const status = await getPipelineStatus(pipelineId);
```

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CONNECTORS_RUNTIME_URL` | `http://127.0.0.1:8766` | Where the Python sidecar listens. |

The runtime lives on Spark via `systemd --user`; see
[../connectors-runtime/deploy/README.md](../connectors-runtime/deploy/README.md).
