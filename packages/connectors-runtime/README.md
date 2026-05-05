# pcc-connectors-runtime

REST sidecar wrapping [dlt](https://dlthub.com/) for PCC's TS connector
shells. Lives on Spark via `systemd --user`. The PCC gateway proxies
public traffic under `/api/connectors/*` (Wave 4); the TS shells under
`@pcc/connectors-*` call this runtime directly via
`CONNECTORS_RUNTIME_URL` until that proxy lands.

The split exists because dlt is Python and we don't want a Python
interpreter in our TS dependency tree. dlt itself is the workhorse —
schema inference, incremental loads, staging/loading orchestration; this
package just exposes its primitives as REST.

## Quick reference

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | dlt version + registry stats |
| POST | `/sources` | Build a dlt source from `{kind, config}` |
| GET | `/sources/{id}` | Read back a source's safe summary |
| POST | `/destinations` | Build a dlt destination from `{kind, config}` |
| GET | `/destinations/{id}` | Read back a destination's safe summary |
| POST | `/pipelines` | Define `{name, source_id, destination_id, dataset_name}` |
| GET | `/pipelines` | List all pipeline definitions |
| POST | `/pipelines/{id}/run` | Kick off `pipeline.run()` in the background |
| GET | `/pipelines/{id}/status` | Snapshot of current pipeline state |
| DELETE | `/pipelines/{id}` | Only honored when `ENABLE_DESTROY_ENDPOINT=true` |

Source kinds in v0.1: `postgres`, `sql_database`, `csv`. Recognised but
not yet wired: `salesforce`, `sharepoint`, `sap` (return 501).

Destination kinds in v0.1: `postgres`, `filesystem`. Recognised but not
yet wired: `insforge` (returns 501).

## Lifecycle

```
POST /sources          -> source_id
POST /destinations     -> destination_id
POST /pipelines        -> pipeline_id (status='created')
POST /pipelines/{id}/run  -> run_id (status='running')
                            (background runner kicks off pipeline.run())
GET  /pipelines/{id}/status (poll)  -> status='completed' | 'failed'
```

Status updates land on the in-memory registry. Wave 4 will move state to
Postgres so a runtime restart doesn't lose pipelines.

## Integration with TS connectors

The five thin TS shells under
`packages/connectors-{postgres,salesforce,sharepoint,sap,csv}` are
identical-shape clients around this REST API:

```ts
import { createPostgresSource, runPipeline, getPipelineStatus } from "@pcc/connectors-postgres";

const source = await createPostgresSource({ credentials: "postgres://...", table_names: ["users"] });
const pipeline = await runPipeline(source.source_id, destinationId, "staging");
const status = await getPipelineStatus(pipeline.pipeline_id);
```

All five shells read `CONNECTORS_RUNTIME_URL` (default
`http://127.0.0.1:8766`).

The escape hatch `@pcc/connectors-airbyte-bridge` does NOT route through
this runtime — it talks to an existing Airbyte deployment via Airbyte's
own REST API. Use it only when an enterprise has Airbyte already; new
deployments should prefer the dlt path.

## Local development

```bash
python3.11 -m venv .venv
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q tests/

# Run the server (defaults to 127.0.0.1:8766).
.venv/bin/python -m connectors_runtime.server
```

## Configuration

12-factor via `pydantic-settings`. All vars are optional with sane
defaults (see `src/connectors_runtime/config.py` for the source of
truth). Operationally important ones:

| Var | Default | Purpose |
|---|---|---|
| `LISTEN_HOST` | `127.0.0.1` | Bind interface. Loopback on purpose. |
| `LISTEN_PORT` | `8766` | Bind port. |
| `STORAGE_PATH` | `/var/lib/pcc/connectors` | dlt pipelines_dir base. |
| `MAX_PIPELINE_SECONDS` | `600` | Hard ceiling on a single run. |
| `ENABLE_DESTROY_ENDPOINT` | `false` | Guards `DELETE /pipelines/{id}`. |
| `LOG_LEVEL` | `INFO` | One of DEBUG/INFO/WARNING/ERROR/CRITICAL. |

## Deploy

See [deploy/README.md](deploy/README.md) for the systemd-on-Spark
installation walkthrough.

## What's next (Wave 4)

- Pipeline state persistence (Postgres).
- Gateway proxy at `/api/connectors/*` (TS shells stop reaching the
  runtime directly).
- Vendor SDK wiring for `salesforce` / `sharepoint` / `sap` sources and
  the `insforge` destination.
- Subprocess-isolated runs so we can actually cancel a stuck dlt run
  (current timeout marks it failed but lets the executor finish).
