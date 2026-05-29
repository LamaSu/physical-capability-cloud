# @pcc/adapter-madsci

PCC adapter for **MADSci** (Modular Autonomous Discovery for Science) — Argonne National Laboratory's MIT-licensed framework for self-driving labs.

Upstream: [github.com/AD-SDL/MADSci](https://github.com/AD-SDL/MADSci)

## What this package does

1. **Parse** MADSci `workflow.yaml` files into typed objects (`parseMadsciWorkflow`).
2. **Translate** them into PCC job submissions (`madsciWorkflowToPccJob`) targeting `POST /api/jobs/submit`.
3. **Discover** nodes in a running MADSci lab via Workcell Manager REST (`discoverMadsciLab`) and emit PCC device registrations.
4. **Run** workflows directly on a Workcell Manager via `MadsciClient`.

## Quick start

```ts
import {
  parseMadsciWorkflow,
  madsciWorkflowToPccJob,
  MadsciClient,
} from "@pcc/adapter-madsci";

// 1. Parse a MADSci workflow YAML
const workflow = parseMadsciWorkflow(yamlText);

// 2. Translate to a PCC job submission
const job = madsciWorkflowToPccJob(workflow, {
  kernelId: "kernel-rpl-argonne",
  capabilityId: "cap-pcr-luna",
  assuranceTier: 2,
});

// POST job to https://capability.network/api/jobs/submit

// 3. Or run directly on a MADSci Workcell Manager
const client = new MadsciClient({ baseUrl: "http://localhost:8005" });
const { run_id } = await client.runWorkflow(workflow);
```

## Upstream coupling notes

- The MADSci REST route table is not fully documented in the upstream README as of the reference fetch (2026-05-27). Routes here track observable conventions in `MADSci_Examples` and `RestNode`. If upstream changes paths, `src/client.ts` is the single point of update.
- MADSci has no auth manager today (it's on their roadmap); `MadsciClient` already accepts an optional `token` so we land cleanly when it ships.
- The translator uses `madsci-workflow/v1` as the embedded schema tag so PCC kernels can fan out to other dialects later (`pylabrobot/v1`, `linq-workflow/v1`).

## License

MIT (matches upstream MADSci).
