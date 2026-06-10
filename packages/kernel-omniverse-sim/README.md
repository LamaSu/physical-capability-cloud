# @pcc/kernel-omniverse-sim

PCC kernel for **pre-flight digital-twin attestation** — replays a MADSci workflow against an NVIDIA Omniverse Kit headless simulation, signs the verdict, returns it as evidence.

Modeled on **PRISM's Stage 2** ([github.com/ramanathanlab/PRISM](https://github.com/ramanathanlab/PRISM) — Argonne, MIT-licensed). Use this kernel as an escrow milestone before any execution kernel runs the real protocol.

## Status

| Layer | Status |
|---|---|
| TS adapter, attestation signing, manifest builder | ✅ done |
| Stub Python runner (deterministic pass) | ✅ done |
| Real-mode runner (Omniverse Kit) | ❌ needs RTX + Kit license + USD scene |
| PRISM Stage-2 wiring | ❌ needs `ramanathanlab/PRISM` ProtocolGenerator imported |

The TS side is production-quality. The Python side is a stub by design so the end-to-end PCC pipeline can be wired up today. Replace the `_real_simulate` body in `python/omniverse_sim_runner.py` with PRISM's Stage-2 sim core when assets are wired up.

## Pipeline

```
MADSci workflow
   │
   ▼
runSim(workflow)  ───► spawns python omniverse_sim_runner.py --run
   │                       │
   │                       ▼
   │                  Stage-2 sim (PRISM) or stub
   │                       │
   ▼                       ▼
SimRunResult ◄─────────────┘
   │
   ▼
signAttestation({ result, workflow, runnerVersion, secretKeyHex })
   │
   ▼
SimAttestation ──► returned to PCC as job evidence
                   verified by gateway via verifyAttestation
```

## Quick start

```ts
import { attestWorkflow, verifyAttestation } from "@pcc/kernel-omniverse-sim";

const attestation = await attestWorkflow({
  workflow,
  secretKeyHex: process.env.KERNEL_SK_HEX!,
  runnerVersion: "omniverse-kit/5.1 + prism/0.1",
});

// Submit attestation as evidence to PCC
// Gateway verifies independently
console.log(verifyAttestation(attestation)); // true
```

## Real-mode setup (when ready)

1. Install NVIDIA Omniverse Kit (RTX-class GPU required).
2. `pip install omniverse-kit`.
3. Acquire a lab USD scene — either Isaac Sim sample, PRISM's `assets/`, or author your own.
4. Set env vars:
   - `OMNIVERSE_AVAILABLE=1`
   - `OMNIVERSE_KIT_PATH=/path/to/kit`
   - `OMNIVERSE_USD_SCENE=/path/to/lab.usd`
5. Replace `_real_simulate` in `python/omniverse_sim_runner.py` with the actual sim driver (port from PRISM `ProtocolGenerator/Code/`).

## License

Apache-2.0 (PCC monorepo default). Real-mode wiring inherits PRISM's MIT license terms.
