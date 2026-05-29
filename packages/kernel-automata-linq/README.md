# @pcc/kernel-automata-linq

PCC kernel binding for **Automata LINQ** — Automata's commercial lab-automation platform (LINQ Cloud + LINQ Bench + LINQ Canvas).

Upstream: [automata.tech](https://www.automata.tech/) · [docs.automata.tech](https://docs.automata.tech/)

## Status: enterprise gated

The LINQ resource model (Workcell → Instrument → Workflow → Task → Labware) is documented publicly. **The literal endpoint paths and authentication scheme are not.** This package ships with best-guess SaaS-CRUD paths (`/v1/workcells`, `/v1/workflows/{id}/runs`, …) and Bearer-token auth.

Re-verify against the live API once a LINQ Cloud account is in hand. The single point of update is `src/client.ts`.

## What this package does

1. **Type the LINQ resource model** as zod schemas.
2. **Talk to LINQ Cloud** via `LinqClient` (CRUD on workcells/workflows/runs).
3. **Translate** LINQ workflows ↔ MADSci workflows so the PCC pipeline only knows one schema (`@pcc/adapter-madsci`).
4. **Bind a LINQ lab as a PCC kernel** via `buildLinqKernelManifest`. Forward incoming PCC jobs to LINQ via `forwardJobToLinq`.

## Quick start

```ts
import {
  LinqClient,
  buildLinqKernelManifest,
  exportLinqWorkflowsAsMadsci,
} from "@pcc/kernel-automata-linq";
import { registerKernel } from "@pcc/kernel-sdk";

const linq = new LinqClient({ apiKey: process.env.LINQ_API_KEY! });

// 1. Bulk-export LINQ workflows in the open MADSci dialect
const madsciWorkflows = await exportLinqWorkflowsAsMadsci(linq, "wc-bench-01");

// 2. Bind the workcell as a PCC kernel
const [workcell] = await linq.listWorkcells();
const workflows = await linq.listWorkflows(workcell.id);
const manifest = buildLinqKernelManifest({
  kernelId: "kernel-linq-bench-01",
  name: workcell.name,
  builder: { agentId: "agent-pcc-onboarder" },
  capabilityType: "lab-automation/v1",
  endpointURL: "https://my-linq-kernel.example.com",
  maxAssuranceTier: 2,
  touchstoneLibraryId: "lib-pcr-touchstones",
  workcell,
  workflows,
});

await registerKernel("https://capability.network", manifest);
```

## Blockers (need human-in-loop)

| Blocker | Owner | What to ask for |
|---|---|---|
| LINQ sandbox / dev account | Automata sales | Read-only API key against a demo workcell |
| Authoritative OpenAPI/REST schema | Automata engineering | `openapi.json` or equivalent so we can drop best-guess paths |
| Webhook payload shapes | Automata engineering | Sample webhook bodies for run-started, run-step-completed, run-failed |

Use `LINQ_COUPLING_STATUS` exported from `src/index.ts` to surface this in any UI that depends on the kernel.

## License

This adapter is part of the PCC monorepo (Apache-2.0). It does not bundle any LINQ proprietary code.
