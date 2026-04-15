# @pcc/workflow

Durable execution primitives for the Physical Capability Cloud.

Six concepts you can adopt incrementally without operating a separate workflow server:

| Primitive    | Solves                                                        |
| ------------ | ------------------------------------------------------------- |
| `Activity`   | Idempotent wrapper for side-effecting calls (HTTP, on-chain, evidence upload). Same input → same result, no double-spend on retry. |
| `Workflow`   | Event-sourced base class. Replay survives gateway crashes mid-protocol. |
| `EventStore` | Append-only event log, SQLite-backed by default, swap-in adapter for other backends. |
| `DataPort`   | Typed inputs/outputs with content-addressable handoff (Storacha CID, IPFS, etc). No shared filesystem assumption. |
| `getVersion` | Long-running workflow code evolution — survive deploys mid-execution. |
| `cwlExport`  | Serialize a `WorkflowDef` as Common Workflow Language YAML for interop with Galaxy / nf-core / StreamFlow / Cromwell. |

See `docs/WORKFLOW_RUNTIME.md` (in the repo root) for the architecture deep-dive and adoption guide.

This package is intentionally small (~1–2k LOC) and depends only on `better-sqlite3`, `yaml`, `zod`, and `@pcc/spec`. It is not a Temporal/Restate replacement — it borrows their proven patterns and ships the minimum that PCC needs.

## Quick start

```ts
import { Activity, Workflow, openSqliteStore } from "@pcc/workflow";

const store = openSqliteStore("./pcc-workflow.db");

// 1. Wrap a side-effect as an idempotent activity
const fundEscrow = Activity.define({
  name: "fund-escrow",
  store,
  async handler({ jobId, amountUsd }) {
    return submitOnChainTx(jobId, amountUsd);
  },
});

// 2. Compose into a workflow
class JobLifecycle extends Workflow {
  static name = "job-lifecycle";
  async run({ jobId }) {
    const escrowResult = await this.activity(fundEscrow, { jobId, amountUsd: 100 });
    // ... more steps ...
    return escrowResult;
  }
}
```

## Status

Initial scaffold (`feat/workflow-runtime` branch). Primitives land in subsequent commits — see `ai/research/pcc-workflow-runtime-design.md` for the architecture plan.
