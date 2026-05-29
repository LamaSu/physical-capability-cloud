# @pcc/kernel-automata-linq

PCC kernel binding for **Automata LINQ** — Automata's commercial lab-automation platform (LINQ Cloud + LINQ Bench + LINQ Canvas).

Upstream: [automata.tech](https://www.automata.tech/) · [docs.automata.tech](https://docs.automata.tech/)

## Status: enterprise gated

The LINQ resource model (Workcell → Instrument → Workflow → Task → Labware), the Python SDK verb-method surface, the Auth0 client-credentials auth flow, and the 5 per-Workflow webhook classes are all documented publicly and reflected here. **The literal REST endpoint paths underneath the SDK are not authoritative public surface** — Automata describes the Python SDK as the supported integration contract. This package implements the verb-method shape directly against a best-guess REST layer; paths may need adjustment once a sandbox confirms them.

The single point of update for endpoint paths is `src/client.ts`.

## What this package does

1. **Type the LINQ resource model** as zod schemas (Workcell, Instrument, Workflow, Task, Labware, Run).
2. **Talk to LINQ Cloud** via `LinqClient` — Auth0 client-credentials token exchange, snake_case verb methods mirroring `linq.client.Linq`.
3. **Translate** LINQ workflows ↔ MADSci workflows so the PCC pipeline only knows one schema (`@pcc/adapter-madsci`).
4. **Receive LINQ webhooks** via 5 typed Hook classes (`RunStateChangeHook`, `TaskStateChangeHook`, `SafetyStateChangeHook`, `LabwareMovementHook`, `NewPlanHook`) plus a `parseHook(eventType, payload)` dispatcher.
5. **Bind a LINQ lab as a PCC kernel** via `buildLinqKernelManifest`. Forward incoming PCC jobs to LINQ via `forwardJobToLinq`.

## Quick start

```ts
import {
  LinqClient,
  buildLinqKernelManifest,
  exportLinqWorkflowsAsMadsci,
} from "@pcc/kernel-automata-linq";
import { registerKernel } from "@pcc/kernel-sdk";

// Values from `linq configure` (provided by Automata Customer Success).
const linq = new LinqClient({
  apiDomain: process.env.LINQ_API_DOMAIN!,
  auth0Domain: process.env.LINQ_AUTH0_DOMAIN!,
  clientId: process.env.LINQ_CLIENT_ID!,
  clientSecret: process.env.LINQ_CLIENT_SECRET!,
});

// 1. Bulk-export LINQ workflows in the open MADSci dialect
const madsciWorkflows = await exportLinqWorkflowsAsMadsci(linq, "wc-bench-01");

// 2. Bind the workcell as a PCC kernel
const [workcell] = await linq.get_workcells();
const workflows = await linq.get_workflows(workcell.id);
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

## Handling webhooks

```ts
import { parseHook } from "@pcc/kernel-automata-linq";

app.post("/linq/hook", (req, res) => {
  const eventType = req.header("X-Linq-Event") ?? req.body?.event;
  const hook = parseHook(eventType, req.body);
  // hook is one of RunStateChangeHook | TaskStateChangeHook |
  //   SafetyStateChangeHook | LabwareMovementHook | NewPlanHook
  res.status(204).end();
});
```

## Blockers (need human-in-loop)

| Blocker | Owner | What to ask for |
|---|---|---|
| LINQ sandbox / dev account | Automata sales | `LINQ_CLIENT_ID` / `LINQ_CLIENT_SECRET` against a demo workcell |
| `linq configure` values | Automata Customer Success | `api_domain`, `auth0_domain`, `client_id` |
| Authoritative OpenAPI/REST schema | Automata engineering | `openapi.json` or equivalent so we can verify endpoint paths under the SDK verb methods |
| Webhook payload shapes | Automata engineering | Sample bodies + HMAC signing scheme for all 5 Hook classes |

Use `LINQ_COUPLING_STATUS` exported from `src/index.ts` to surface this in any UI that depends on the kernel.

Contact: `hello@automata.tech`.

## License

This adapter is part of the PCC monorepo (Apache-2.0). It does not bundle any LINQ proprietary code.
