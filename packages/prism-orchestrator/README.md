# @pcc/prism-orchestrator

End-to-end PRISM-style pipeline on PCC. The canonical upstream PRISM
([github.com/ramanathanlab/PRISM](https://github.com/ramanathanlab/PRISM), Argonne, MIT) is a **3-stage** planner-critique-validation loop. This package wires that loop into a **5-stage on-chain state machine** by adding escrow + execute + settle stages around it.

## Pipeline

```
   web procedure (text or URL)
              │
              ▼
   ┌────────────────────────┐
   │ Stage 1 — ingest       │ LLM planner emits StepDraft[]
   │  (any LlmPlanner impl) │
   └────────────────────────┘
              │
              ▼
   ┌────────────────────────┐
   │ Stage 2 — translate    │ StepDraft[] → MadsciWorkflow
   │  (@pcc/adapter-madsci) │
   └────────────────────────┘
              │
              ▼
   ┌────────────────────────┐
   │ Stage 3 — attest       │ digital-twin sim → signed SimAttestation
   │ (kernel-omniverse-sim) │  ── if verdict ≠ pass, STOP here
   └────────────────────────┘
              │
              ▼
   ┌────────────────────────┐
   │ Stage 4 — escrow       │ POST /api/jobs/submit + /api/escrow/fund
   │  (PCC gateway)         │
   └────────────────────────┘
              │
              ▼
   ┌────────────────────────┐
   │ Stage 5 — execute      │ kernel runs MADSci workflow
   │  (any execution kernel)│  evidence posted → ALCOA+ checks → release
   └────────────────────────┘
              │
              ▼
       settled / failed
```

## Quick start

```ts
import {
  PrismOrchestrator,
  REFERENCE_SYSTEM_PROMPT,
  type LlmPlanner,
  type PccClient,
} from "@pcc/prism-orchestrator";

// Bring-your-own planner — wrap Anthropic SDK, OpenAI SDK, Gemini, local.
const planner: LlmPlanner = {
  async plan({ procedureText, knownInstruments }) {
    // call your LLM with REFERENCE_SYSTEM_PROMPT, return parsed JSON array
    return [/* StepDraft[] */];
  },
};

// Bring-your-own PCC client — wrap fetch against https://capability.network.
const pcc: PccClient = {
  submitJob: (body) => fetch("/api/jobs/submit", { ... }).then(r => r.json()),
  getJob:    (id)   => fetch(`/api/jobs/${id}`).then(r => r.json()),
  fundEscrow:(body) => fetch("/api/escrow/fund", { ... }).then(r => r.json()),
};

const orch = new PrismOrchestrator({
  planner,
  knownInstruments: ["ot2", "pf400", "thermocycler"],
  pcc,
  simSecretKeyHex: process.env.SIM_KERNEL_SK!,
  workflowName: "luna-qpcr",
  kernelId: "kernel-rpl-argonne",
  capabilityId: "cap-pcr-luna",
  assuranceTier: 2,
  fundAmountUSDC: "25.00",
});

const state = await orch.run({
  text: "Add 20µL of Master Mix to each well of plate A1..A12, then run 40 cycles...",
});

console.log(state.phase);                 // "settled" or "failed"
console.log(state.attestation?.result);   // sim verdict + trace
console.log(state.escrow?.address);       // on-chain escrow address
console.log(state.pccJob?.id);            // PCC job for monitoring
```

## Stage isolation

Every stage is exported separately so the orchestrator can be sliced into a wave-execution pipeline (one PCC implementer per stage):

- `ingestProcedure(opts)`
- `translateStepsToMadsci(steps, opts)`
- `attestStage(opts)`
- `submitAndFund(opts)`

## Differences vs upstream PRISM

| PRISM (Argonne) | This package |
|---|---|
| Stage 1 = `ProtocolPlanner/run_stage1.py`, multi-agent or single-agent | `LlmPlanner` interface — caller chooses single or multi-agent |
| Stage 2 = `ProtocolGenerator/Code/run_agent.sh` (Claude Code subprocess) | Pure TS translation — no subprocess needed |
| Stage 3 = Isaac Sim 5.1 (Linux + RTX) | `@pcc/kernel-omniverse-sim` stub-first, real-mode when wired |
| No escrow / settlement | PCC gateway escrow + ALCOA+ evidence verification |
| Outputs Linux scripts | Outputs PCC job + on-chain escrow |

## License

Apache-2.0 (PCC monorepo default). PRISM upstream is MIT; this package is API-compatible but does not bundle PRISM code.
