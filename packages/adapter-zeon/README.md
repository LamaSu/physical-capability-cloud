# @pcc/adapter-zeon

Zeon Systems adapter for PCC. Exposes Zeon project authoring and TEM-1 screen
analysis as a **digital kernel**.

Zeon has bench execution and no settlement layer. PCC has settlement and no bench.
This package wires them together without lying about which side did what.

## Why this is not a `MachineAdapter`

`MachineAdapter` (see `adapter-pylabrobot`, `kernel/src/adapters/hamilton-adapter.ts`)
models a device you can command: `execute({type: "start"})` kicks a run and evidence
streams back on a channel.

**Zeon cannot be commanded.** Its cloud API is a content-addressed authoring store —
blobs → trees → commits → refs, plus a mesh catalog and `/me`. There is no `/runs`,
`/execute`, `/simulate`, or `/jobs`; `ZEON_ROUTES` in `sync-client.ts` enumerates the
whole surface, and a test asserts none of those paths exist. A run is started by a
human pressing **Run** in the Workflow Editor, and a real-hardware run is gated on two
preflight checks the UI performs (a fresh frame from each wrist camera, and a pipette
home) that no API can satisfy.

Implementing `MachineAdapter.start` here would return success while starting nothing.
For a settlement layer that is the worst available failure mode, because PCC would
bill and receipt work that never happened. So starting a run is surfaced as
`prepareRun()`, which returns a `HumanStep` and never claims execution.

If Zeon ships an execution route — or `POST /sync/projects/{pid}/verify`, which is a
registered stub today after the per-user gateway that used to do it was retired —
`prepareRun` is the single place that changes.

## What it does

| Capability | Method | Notes |
|---|---|---|
| Resolve token → identity | `whoami()` | `GET /me`; cheapest liveness check |
| Labware readiness | `checkLabware()` | Mesh-catalog lookup for the 4 items a TEM-1 screen needs, with near-match candidates |
| List workflows | `listWorkflows()` | From the project snapshot, so you fail before staging against a missing workflow |
| Stage a run | `prepareRun()` | Returns staged files **and** the required `HumanStep` |
| Expression gate | `checkExpressionGate()` | sfGFP fold-over-no-template; the go/no-go before a screen slot |
| Plate analysis | `analyzePlate()` | Initial rates, Z′, percent inhibition, artifact flags, hits |
| Round-2 design | `designNextRound()` | Exploit/explore split with selection provenance |

The last three proxy to the `zeonkit` bridge (`C:\Users\globa\zeon-hack`), which owns
the science. They throw a clear error when no `bridgeUrl` is configured rather than
failing at call time.

## Usage

```ts
import { ZeonAdapter, buildZeonTem1Manifest } from "@pcc/adapter-zeon";

const zeon = new ZeonAdapter({
  apiToken: process.env.ZEON_API_TOKEN!,   // zat_…
  projectId: "…",
  bridgeUrl: "http://127.0.0.1:8765",
});

console.log(await zeon.whoami());

// Is the labware already in the shared catalog, or must we model it locally?
const labware = await zeon.checkLabware();
if (!labware.ready) console.warn("missing:", labware.missing, labware.candidates);

// Stage a screen. This does NOT start the robot.
const run = await zeon.prepareRun({
  workflowId: "screen_plate",
  files: { "inputs/screen_plate.json": JSON.stringify(platemap) },
});
console.log(run.humanStep.instructions);   // hand these to the operator
```

Register the kernel:

```ts
import { registerKernel } from "@pcc/kernel-sdk";

const manifest = buildZeonTem1Manifest({
  endpointURL: "https://your-host/kernel",
  builderAgentId: "eip155:8453:0x…",
});
await registerKernel(gatewayUrl, manifest);
```

## Two things to know about Zeon tokens

**They have no scopes.** A `zat_` token grants everything the owning user can do
across every project they can see. It cannot be narrowed — only revoked. Treat it as a
full credential; `ZeonSyncClient` rejects a value that isn't `zat_`-prefixed so a
malformed credential surfaces as a config error instead of a confusing 403.

**Mesh-catalog writes are admin-only**, server-enforced, and Zeon's docs route
requests through a human contact. So anything `checkLabware()` reports missing is not
something a team can add under time pressure — it must be modelled as a local project
object instead. Knowing which of those two paths you're on is the point of that call.

## Assurance tier

Capped at **1**. The physical half of this workflow is executed by a human at a UI and
attested by run artifacts, not by an instrumented machine under the kernel's control.
Claiming a higher tier would assert evidence quality this integration cannot produce.

## Tests

```bash
pnpm --filter @pcc/adapter-zeon test        # 15 tests
pnpm --filter @pcc/adapter-zeon typecheck
```

The suite includes two guard tests worth keeping: one asserts `ZEON_ROUTES` contains no
execution path, and one asserts no workflow step name claims to drive the robot. They
exist so a future edit can't quietly turn this into something that over-promises.

## Provenance

Every endpoint and constraint here was extracted from the installed `zeon==1.2.2`
package and the public `zeonsystems/zeon-project-skill` repo, not from prose docs.
Full write-up: `C:\Users\globa\zeon-hack\FINDINGS.md`.
