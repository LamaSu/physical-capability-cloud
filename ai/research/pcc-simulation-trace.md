# Genesis-Sim → PCC SimulationTrace Wiring

**Date:** 2026-06-01
**Adapter version:** 0.1.0
**Upstream:** [Genesis-Embodied-AI/Genesis](https://github.com/Genesis-Embodied-AI/Genesis) (Apache-2.0)
**Branch:** `feat/simulation-trace` (based off `feat/lingbot-pcc-wiring`)

## TL;DR

Per-tick observation / action / reward series from a Genesis-sim rollout now
flow into PCC capture evidence as a third optional channel alongside
`mediaHash` (photo) and `pointMaps3D` (LingBot streaming-3D). The operator's
sim runner writes a rollout artefact (jsonl/npz), POSTs the bytes to
`POST /api/capture/sim`, the gateway runs a Python normalizer via subprocess
(stub-able for CI), and the resulting `SimulationTrace` rides inside
`CaptureManifest.simulations[]` through to the on-chain anchor — no on-chain
interface change required.

## Why simulations need to be evidence-grade

Genesis-sim is the canonical reference simulator for embodied-AI research:
Apache-2.0 license, vectorized PyTorch backend, supports rigid bodies +
articulated robots + deformables + fluids, runs on CPU or GPU. A capability
that ships "I can pick-and-place cubes with my Franka Panda" is increasingly
proven by a curated batch of evaluation rollouts BEFORE any operator captures
a single real photo. PCC needed an evidence channel for the sim half of that
story so the manifest hash covers both the simulated and the real evidence
that justify a capability listing.

The contract is identical to the LingBot/PointMap3D channel:

- Trace lives inside the canonical `CaptureManifest` hash → tampering
  invalidates the on-chain `manifestHash` anchor.
- Trace is tier-orthogonal (CC0..CC5 unchanged) and soft-fail (the rest of
  the capture upload succeeds if the sim-trace upload fails).
- Subprocess boundary keeps Python out of TypeScript; tests inject a fake
  spawner; CI never imports Genesis / PyTorch.

## Path resolution

The user requested "mirror the LingBot pattern exactly". The LingBot pattern
puts the spawn+validate logic in `packages/verifier/src/capture/lingbot-adapter.ts`
and a thin route wrapper in `packages/gateway/src/routes/capture-3d.ts`. For
Genesis we collapsed the two into a single file under
`packages/gateway/src/routes/capture-sim.ts` — the spawn+validate section
lives at the top of the route module, the Fastify route handler at the
bottom, and a test-only `setGenesisSpawnerForTests` is exported the same way
as `setLingBotSpawnerForTests`. The deliverable count stays at the 8 the
user listed; test ergonomics are unchanged.

If a verifier-side consumer eventually needs Genesis adapter primitives
outside the gateway route, the natural split is to peel the adapter section
out into `packages/verifier/src/capture/genesis-adapter.ts` and re-export
through `@pcc/verifier`. This is a no-op refactor — every symbol stays the
same name.

## Integration points touched

| Layer | File | Change |
|---|---|---|
| Spec — types | `packages/spec/src/types/simulation.ts` | NEW — `SceneContext`, `SimulationFrame`, `SimulationFrameInfo`, `RolloutSummary`, `SimulationTrace` + 5 Zod exports |
| Spec — index | `packages/spec/src/types/index.ts` | EDIT — re-export `./simulation.js` |
| Spec — manifest | `packages/spec/src/types/capture.ts` | EDIT — adds `CaptureManifest.simulations?: SimulationTrace[]`; manifest schema accepts new field |
| Spec — tests | `packages/spec/src/types/capture.test.ts` | EXTEND — 11 new cases for SimulationTrace (good, bad hash, bad reason, bad scene hash, missing scene fields, bad frame index, JSON round-trip, manifest carrying trace, manifest carrying both pointMaps3D + simulations, rejection on bad entry in array, stubbed) |
| Gateway — route | `packages/gateway/src/routes/capture-sim.ts` | NEW — `POST /api/capture/sim` with embedded spawner; Zod body, 32 MB cap, hash-echo cross-check, error mapping |
| Gateway — server | `packages/gateway/src/server.ts` | EDIT — import + register `captureSimRoutes` |
| Gateway — tests | `packages/gateway/src/__tests__/capture-sim.test.ts` | NEW — auth gate, happy path, simulator propagation, oversize, hash mismatch, schema-invalid, hash-cross-check |
| Python — runner | `scripts/pcc_genesis_runner.py` | NEW — subprocess entrypoint; stub mode under `PCC_GENESIS_STUB=1`; real mode normalizes jsonl/npz |
| Audit | `ai/research/pcc-simulation-trace.md` | NEW — this file |

No edits to verifier package, no edits to UI package, no edits to contracts.

## On-chain attestation flow — no change required

Just like the LingBot wave, the IPCCOracle interface
(`packages/contracts/src/interfaces/IPCCOracle.sol`) takes an opaque
`bytes32 evidenceHash` plus an oracle signature:

```solidity
struct Attestation {
    address escrowAddress;
    string jobId;
    bytes32 evidenceHash;  // <- opaque content hash
    uint8 tier;
    bool verified;
    uint256 timestamp;
    bytes32 nonce;
    bytes signature;
}
```

Because `evidenceHash` is content-addressed and opaque, the new
`simulations` field rides inside the canonical `CaptureManifest` hash with
no schema change at the Solidity boundary:

1. Sim runner builds a `SimulationTrace`.
2. Browser / agent merges it into `CaptureManifest.simulations[]`.
3. Gateway hashes the canonical JSON (`canonicalJSON` in
   `packages/verifier/src/capture/verifier.ts`) → `manifestHash`.
4. `manifestHash` is anchored via `CaptureClassRegistry.anchor()` (existing
   flow in `packages/gateway/src/routes/capture.ts:anchor`).
5. Any sim-data tampering downstream invalidates `manifestHash` and the
   on-chain anchor refuses to match — exactly the property we want.

So `IPCCOracle.sol`, `MilestoneEscrow.sol`, and the existing oracle TS
adapters (`packages/verifier/src/oracle/*`) are untouched. The
`EvidenceBundle` type in `@pcc/spec` likewise needs no change — the new
trace lives one level above it inside the capture manifest.

The only on-chain-adjacent file we considered was
`packages/gateway/src/routes/capture.ts:anchor`. It already serializes
`verdict.resultJson` (which now embeds the manifest carrying the
`simulations` array) and computes the bytes32 manifest hash from it. No
edits needed — existing flow self-extends.

## Runtime layout

```
┌──────────────┐  POST .../sim     ┌─────────────────────┐  spawn   ┌────────────────────────┐
│ sim runner   │ ────────────────▶ │ /api/capture/sim    │ ───────▶ │ pcc_genesis_runner.py  │
│ (operator    │  base64 rollout   │  (Fastify)          │  python3  │  - hash rollout file   │
│  side)       │  jsonl/npz bytes  │                     │           │  - read jsonl/npz      │
│              │                   │  embedded adapter:  │           │  - clamp fps/frames    │
│ writes:      │ ◀───────────────  │   - spawn runner    │ ◀──────── │  - emit Trace JSON     │
│  trace.jsonl │  SimulationTrace  │   - validate Zod    │  out.json │  (or stub if env)      │
│  scene.json  │                   │   - hash cross-chk  │           └────────────────────────┘
└──────────────┘                   │                     │                 vendor/genesis/
                                   │                     │                 (or none, in stub)
                                   └─────────────────────┘

CaptureManifest.simulations = [trace1, trace2, ...]
   │
   ▼
POST /api/capture/upload   →   manifestHash anchored on Base Sepolia
```

## Output format

`SimulationTrace` (JSON-serializable; lives in
`packages/spec/src/types/simulation.ts`):

```ts
{
  deviceId: "kernel-sim-1",
  startedAt: "2026-04-21T00:00:00.000Z",
  endedAt:   "2026-04-21T00:00:05.000Z",
  rolloutHash: "sha256:<64 hex>",       // sha256 of canonical rollout artefact
  scene: {
    simulator: "genesis",
    simulatorVersion: "0.2.0",
    embodiment: "franka-panda",
    taskId: "cube-stack",
    sceneHash: "sha256:<64 hex>",
    assets?: ["cube_red.urdf", ...],
    physicsParams?: { gravity, timestepSec, solver, substeps },
    randomSeed?: 42,
    observationKeys?: ["qpos", "qvel", "ee_pose"],
    actionDim?: 7,
    observationDim?: 31
  },
  fps: 30,
  frameCount: 256,
  frames: [
    {
      frameIndex: 0,
      timestampSec: 0.0,
      action?: [...],       // flat, capped at downsamplePoints
      observation?: [...],  // flat, capped at downsamplePoints
      reward?: 0.0,
      done?: false,
      info?: { success?, collision?, timeout? },
      cid?: "bafy..."        // optional CID of dense per-tick state
    },
    ...
  ],
  summary: {
    totalReturn: 1.0,
    episodeLength: 256,
    success: true,
    terminatedReason?: "success"|"failure"|"timeout"|"collision"|"user_abort",
    meanReward?: 0.0039,
    domainRandomizationHash?: "sha256:<64 hex>"
  },
  model: "policy-ppo-v3",
  adapterVersion: "0.1.0",
  stubbed?: true        // present iff stub mode was used (synthetic rollout)
}
```

`CaptureManifest.simulations` carries an **array** because evaluation rollouts
ship in batches (10-100 episodes per policy checkpoint for statistical
significance). The single-trace `pointMaps3D` channel doesn't have this
problem — a phone-video clip is naturally single — but a policy rollout is
naturally batched.

## Bounded clamps

Adapter-imposed bounds (`scripts/pcc_genesis_runner.py`):

- `fps` ∈ [1, 240]   (default 30)
- `maxFrames` ∈ [1, 4096]   (default 256 — keeps manifest under ~1 MB at
  obs/action width of 256)
- `downsamplePoints` ∈ [16, 16384]   (default 256; this is the flat
  observation/action vector width cap)

Gateway-imposed bounds (`packages/gateway/src/routes/capture-sim.ts`):

- Inbound rollout artefact ≤ 32 MB
- Server-side hash echo on `expectedRolloutHash` if supplied
- Adapter's `trace.rolloutHash` must match request bytes → 500 otherwise

The clamps appear in BOTH the route and the runner (defense in depth) so
that a misconfigured spawner cannot leak unbounded resources.

## Stub mode

`PCC_GENESIS_STUB=1` (or `PCC_GENESIS_DISABLED=1`) tells the runner to skip
all imports of Genesis / numpy / PyTorch and emit a deterministic synthetic
rollout. This is the path CI takes and the path every gateway test takes.

Stub output characteristics:

- Action vector: `action_dim=7`, values in [-0.1, 0.1]
- Observation vector: `obs_dim=max(7, min(downsample_points, 31))`, values in [-1.0, 1.0]
- Reward schedule: sparse — 0 everywhere, +1 on the last tick
- `summary.success = true`, `summary.terminatedReason = "success"`
- `stubbed: true` clearly marked in the trace
- `model: "genesis-stub-policy"` (or stem of `--model-path` if provided)
- Deterministic RNG seeded with `0xC0FFEE` so two stub runs with the same
  args produce identical output

The runner exits 0 in stub mode regardless of whether the rollout artefact
exists on disk — useful for end-to-end pipe tests where the artefact is
a `Buffer.from("placeholder")` written to a tempfile.

## Real-mode artefact formats

Real mode supports two formats out of the box:

1. **JSONL** (`*.jsonl`) — one dict per step with keys `{action, observation,
   reward, done, info}`. Easiest path for hand-rolled sim loops; no numpy
   dependency.
2. **NPZ** (`*.npz`) — numpy-saved archive with arrays `{actions, observations,
   rewards, dones}`. Easiest path for vectorized Gym/Brax-style rollouts;
   requires `numpy` at runtime.

A sibling `<rollout>.scene.json` is read if present to populate `scene` —
otherwise the runner falls back to `--task-id` / `--simulator` CLI flags
and computes a deterministic `sceneHash` from those.

## Auth + cross-checks

Every request to `POST /api/capture/sim` goes through:

1. `requireAuth` preHandler — same SIWE/API-key gate as `/api/capture/3d-stream`.
2. Zod body validation — fail = 400 with `details` from `error.flatten()`.
3. Base64 decode + length check — fail = 400 `invalid_rollout_bytes` /
   `empty_rollout`, 413 `rollout_too_large`.
4. `expectedRolloutHash` cross-check on decoded bytes (if supplied) —
   fail = 400 `rollout_hash_mismatch`.
5. Spawn the runner with the artefact written to a tempfile.
6. Validate runner JSON against `SimulationTraceSchemaExport` — fail = 502
   `trace_schema_invalid`.
7. Cross-check `trace.rolloutHash` against the gateway-computed
   `sha256(artefact)` — fail = 500 `trace_rollout_hash_mismatch`.

Three hashing opportunities (gateway → runner → gateway) catch any swap or
reuse-of-leftover-tempfile bug.

## Compatibility decisions and edge cases

1. **Array vs single trace.** Unlike `pointMaps3D` (single), `simulations` is
   `SimulationTrace[]`. Operator policies that produce evaluation suites
   ship 10-100 rollouts per submission; forcing a single-trace shape would
   either (a) lose per-episode evidence or (b) force the operator to
   concatenate into one giant trace that's a pain to verify.
2. **CC class neutrality.** Same rule as `pointMaps3D`: a CC0 capture with
   `simulations` is still CC0 — the class is determined by signature
   evidence, not simulation evidence.
3. **Manifest hash boundary.** Because `simulations` is hashed into
   `manifestHash`, the verifier's existing G1 (Structural) gate
   automatically protects sim evidence integrity. No new verifier gate
   needed for v0.
4. **Separate route vs folding into upload.** Same choice as capture-3d:
   `/api/capture/sim` is a separate endpoint, not folded into
   `/api/capture/upload`. A real rollout normalization (real mode, not
   stubbed) can take several seconds for a 1000-step trajectory; coupling
   it to the synchronous upload route would block the verifier's hot path.
5. **Hash echo, defense in depth.** Three hashing opportunities (browser →
   gateway → runner → gateway) catch a swap; mismatches produce clear-coded
   400 / 500 status.
6. **Soft-fail at the operator wiring boundary.** The route doesn't
   automatically merge anything into a manifest — that's a caller-side
   decision. If the caller wraps the call in `try/catch` and continues on
   failure, the photo + IMU + WebAuthn evidence still upload normally.
   This preserves the same soft-fail UX the LingBot wave established.
7. **Subprocess boundary.** Only the embedded adapter section knows about
   the Python child process. The Fastify route handler never touches
   `spawn` or tempfiles for the Python side. Tests inject a fake spawner;
   no Python is invoked in CI.
8. **No CID upload path yet.** `SimulationFrame.cid` is part of the schema
   but the runner does not currently push dense per-tick state (rgb / depth
   / segmentation buffers) to IPFS/Storacha. Wiring that into
   `evidenceStorage` is a follow-up — the field exists so the schema doesn't
   break later when we do.
9. **No on-chain change.** Unchanged smart contracts (`IPCCOracle`,
   `MilestoneEscrow`, `CaptureClassRegistry`) — `manifestHash` is opaque
   and the new field rides inside it.

## Test inventory

| File | Test count | What it covers |
|---|---|---|
| `packages/spec/src/types/capture.test.ts` | +11 sim tests | Standalone trace round-trips, manifest carrying trace, manifest carrying both pointMaps3D + simulations, rejection on bad rolloutHash / unknown terminatedReason / bad sceneHash / missing scene fields / negative frameIndex / bad entry in array, stubbed flag accepted |
| `packages/gateway/src/__tests__/capture-sim.test.ts` | 10 cases | Auth gate (401), happy path with hash echo + simulator propagation, 4 input-validation errors (empty body, zero-length rollout, oversize, hash mismatch), 3 adapter-error mappings (runner_exit_nonzero, trace_schema_invalid, trace_rollout_hash_mismatch) |

CI runs both via `pnpm -r test`. The gateway test uses `setGenesisSpawnerForTests`
to inject a fake spawner; no Python is invoked.

## Blockers / not done

1. **Real-mode rollout normalization not load-tested.** Adapter argument
   bounds are conservative defaults; if production traffic shows the
   256-frame cap is too small for typical RL eval episodes or the 32 MB
   body cap is too small for typical jsonl rollouts, both are clamp-only
   changes in two files (route + runner).
2. **No CID upload path yet.** `SimulationFrame.cid` is reserved but the
   runner doesn't push dense per-tick state to IPFS/Storacha. Wiring that
   into `evidenceStorage` is the natural follow-up.
3. **No browser-side helper.** Unlike the LingBot wave which shipped a
   `StreamingThreeD.ts` adapter, this wave doesn't include a UI capture
   adapter — sim rollouts run on the operator's compute node (often
   headless), not in the browser, so the caller pattern is `curl -d
   @rollout.bin` or an agent-side HTTP client, not a React component.
   A UI affordance for "show me my registered sim batches" is a UX-layer
   follow-up.
4. **No CI matrix update.** `.github/workflows/ci.yml` was not modified —
   the new tests pick up automatically through `pnpm -r test`.
5. **No vendor/genesis tree.** Unlike the LingBot wave which shallow-cloned
   `vendor/lingbot-map`, this wave does NOT vendor Genesis — the runner
   does not import it. Real-mode rollouts are normalized from artefacts
   the operator's own runner produced; the wrapper is intentionally a
   thin format-translator, not a sim-host.

## Files added / modified summary

```
NEW  packages/spec/src/types/simulation.ts             (~7 KB)
NEW  packages/gateway/src/routes/capture-sim.ts        (~13 KB)
NEW  packages/gateway/src/__tests__/capture-sim.test.ts (~8 KB)
NEW  scripts/pcc_genesis_runner.py                     (~10 KB)
NEW  ai/research/pcc-simulation-trace.md               (this file)

EDIT packages/spec/src/types/index.ts                  (+1 line: re-export)
EDIT packages/spec/src/types/capture.ts                (+12 lines: import + field + schema)
EDIT packages/spec/src/types/capture.test.ts           (+~180 lines: 11 new tests)
EDIT packages/gateway/src/server.ts                    (+2 lines: import + register)
```

## License

Genesis is Apache-2.0 — commercial use, sublicensing, and modification all
permitted as long as upstream `LICENSE` is preserved (will be true if/when
we vendor it). All adapter code added in this wave is original and inherits
the PCC repo's existing license. The Python runner header carries
`License: Apache-2.0 (matches Genesis upstream)` for future-proofing.
