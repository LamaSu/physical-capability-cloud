# LingBot-Map → PCC Operator-Capture Wiring

**Date:** 2026-05-29
**Adapter version:** 0.1.0
**Upstream:** [Robbyant/lingbot-map](https://github.com/Robbyant/lingbot-map) (Apache-2.0)

## TL;DR

Per-frame 3D point maps and camera poses from LingBot-Map streaming
inference now flow into PCC capture evidence alongside the existing
photo + `mediaHash`. The browser-side adapter records a short phone-video
clip, the gateway runs LingBot via a Python subprocess (stub-able for CI),
and the resulting `PointMap3DTrace` rides inside `CaptureManifest.pointMaps3D`
through to the on-chain anchor — no on-chain interface change required.

## Path resolution

`apps/mobile/streaming-3d.ts` does **not** exist in this repo. The user's
prompt allowed picking the closest existing operator-capture entry point;
the actual operator-capture surface lives under
`packages/ui/src/capture/` (six adapters: SensorFusion, FaceLandmarker,
C2PAReader, WebAuthnClient, VisualNonceRenderer, CaptureFlow). The new
streaming-3D adapter slots in there as a peer.

## Integration points touched

| Layer | File | Change |
|---|---|---|
| Vendor | `vendor/lingbot-map/` | NEW — shallow `git clone --depth 1`, 1326 files |
| Spec   | `packages/spec/src/types/capture.ts` | EXTEND — adds `CameraPose`, `Point3D`, `PointMap3DFrame`, `PointMap3DTrace` types + Zod (`PointMap3DTraceSchemaExport`); adds optional `CaptureManifest.pointMaps3D` field |
| Spec test | `packages/spec/src/types/capture.test.ts` | EXTEND — 6 new cases (good / bad pose matrix length / bad videoHash / out-of-range conf / unknown mode / manifest carrying trace / stubbed flag) |
| Verifier | `packages/verifier/src/capture/lingbot-adapter.ts` | NEW — `runLingBotInference(input)` returns validated `PointMap3DTrace`; spawns Python runner, validates output against Zod, supports test-injected spawner, stub-env short-circuit |
| Verifier index | `packages/verifier/src/capture/index.ts`, `packages/verifier/src/index.ts` | EXTEND — re-export `runLingBotInference`, `setLingBotSpawnerForTests`, `LingBotAdapterError`, related types |
| Verifier test | `packages/verifier/src/capture/lingbot-adapter.test.ts` | NEW — happy path, arg clamping, modelPath toggle, exit-nonzero, invalid JSON, schema-invalid, missing-videoPath, stub-env flag |
| Python | `scripts/pcc_lingbot_runner.py` | NEW — thin headless wrapper over `lingbot_map.models.gct_stream.GCTStream.inference_streaming`; stub mode (`PCC_LINGBOT_STUB=1`) emits deterministic synthetic trace |
| Gateway | `packages/gateway/src/routes/capture-3d.ts` | NEW — `POST /api/capture/3d-stream`; Zod-validated JSON body, 32 MB cap, hash-echo cross-check, adapter error → HTTP mapping |
| Gateway wire-up | `packages/gateway/src/server.ts` | EDIT — import + register `capture3dRoutes` |
| Gateway test | `packages/gateway/src/__tests__/capture-3d.test.ts` | NEW — auth gate, happy path, mode propagation, empty/oversize/hash-mismatch, adapter error mapping |
| Browser | `packages/ui/src/capture/StreamingThreeD.ts` | NEW — `StreamingThreeD.recordAndInfer(opts)`, `.inferFromBlob(opts)`, plus exported helpers `recordVideo`, `uploadAndInfer`, `sha256Blob`, `pickMimeType` |
| Browser barrel | `packages/ui/src/capture/index.ts` | EDIT — re-export the new symbols |
| Browser flow | `packages/ui/src/capture/CaptureFlow.tsx` | EDIT — opt-in `streaming3D?: { enabled, ... }` prop; runs `StreamingThreeD.recordAndInfer` inside the existing `Promise.all` evidence batch; merges result into `CaptureManifest.pointMaps3D` |
| Browser test | `packages/ui/src/capture/StreamingThreeD.test.ts` | NEW — pickMimeType, sha256Blob determinism, uploadAndInfer (success + non-2xx + hash mismatch), inferFromBlob surface |
| Audit | `ai/research/landscape-lingbot-adopt.md` | NEW — abbreviated wheel-scout note recording the user-preselected ADOPT decision |

## On-chain attestation flow — no change required

The IPCCOracle interface (`packages/contracts/src/interfaces/IPCCOracle.sol`)
takes an opaque `bytes32 evidenceHash` plus an oracle signature:

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
`pointMaps3D` field rides inside the canonical `CaptureManifest` hash with
no schema change at the Solidity boundary:

1. Browser builds `CaptureManifest` including `pointMaps3D`.
2. Gateway hashes the canonical JSON (`canonicalJSON` in
   `packages/verifier/src/capture/verifier.ts`) → `manifestHash`.
3. `manifestHash` is anchored via `CaptureClassRegistry.anchor()` (existing
   flow in `packages/gateway/src/routes/capture.ts:anchor`).
4. Any 3D-data tampering downstream invalidates `manifestHash` and the
   on-chain anchor refuses to match — exactly the property we want.

So `IPCCOracle.sol`, `MilestoneEscrow.sol`, and the existing oracle TS
adapters (`packages/verifier/src/oracle/*`) are untouched. The
`EvidenceBundle` type in `@pcc/spec` likewise needs no change — the new
trace lives one level above it inside the capture manifest.

The only on-chain-adjacent file we considered was
`packages/gateway/src/routes/capture.ts:anchor`. It already serializes
`verdict.resultJson` (which now embeds the manifest carrying the 3D
trace) and computes the bytes32 manifest hash from it. No edits needed —
existing flow self-extends.

## Runtime layout

```
┌───────────────┐  recordAndInfer()   ┌──────────────────────┐  spawn   ┌──────────────────────┐
│  CaptureFlow  │ ──────────────────▶ │ /api/capture/3d-     │ ───────▶ │ pcc_lingbot_runner.py │
│  (browser)    │  POST video bytes   │ stream  (Fastify)    │  python3  │  - load video        │
│               │                     │                      │           │  - GCTStream stream  │
│ Photo + IMU + │ ◀────────────────── │ runLingBotInference()│ ◀───────  │  - dump JSON trace   │
│ WebAuthn +    │  PointMap3DTrace    │  validate via Zod    │  JSON     │  (or stub if env)    │
│ 3D trace ──┐  │                     │                      │           └──────────────────────┘
│            │  │                     │                      │                vendor/lingbot-map
│ CaptureMan-│  │                     │                      │
│ ifest      │  │                     │                      │
│            ▼  │                     │                      │
│ POST /api/    │                     │ /api/capture/upload  │
│ capture/      │ ──────────────────▶ │  (unchanged route)   │
│ upload        │                     │  hashes manifest →   │
│               │                     │  CaptureClassRegistry│
└───────────────┘                     └──────────────────────┘
```

## Output format

`PointMap3DTrace` (JSON-serializable; lives in
`packages/spec/src/types/capture.ts`):

```ts
{
  deviceId: "kernel-3d-1",
  startedAt: "2026-04-21T00:00:00.000Z",
  endedAt:   "2026-04-21T00:00:05.000Z",
  videoHash: "sha256:<64 hex>",     // sha256 of the recorded phone video
  mode: "streaming" | "windowed",
  fps: 10,
  frameCount: 32,
  frames: [
    {
      frameIndex: 0,
      timestampSec: 0.0,
      pose: {
        matrix: [r00,r01,r02,t0, r10,r11,r12,t1, r20,r21,r22,t2],  // 3x4 c2w
        intrinsic: [fx,0,cx, 0,fy,cy, 0,0,1]                       // optional 3x3
      },
      points: [{ x, y, z, conf? }, ...],   // sparse, default ~256/frame
      cid?: "bafy...",                     // optional CID of full dense cloud
      meanConfidence?: 0.88
    },
    ...
  ],
  model: "lingbot-map-stage1" | "lingbot-map" | "lingbot-map-stub" | ...,
  adapterVersion: "0.1.0",
  stubbed?: true        // present iff stub mode was used (no real reconstruction)
}
```

Adapter-imposed bounds (`packages/verifier/src/capture/lingbot-adapter.ts`):

- `fps` ∈ [1, 60]   (default 10)
- `maxFrames` ∈ [1, 512]   (default 32 — keeps manifest under ~1 MB)
- `downsamplePoints` ∈ [16, 4096]   (default 256)

Gateway-imposed bounds (`packages/gateway/src/routes/capture-3d.ts`):

- Inbound video ≤ 32 MB
- Server-side hash echo on `expectedVideoHash` if supplied
- Adapter's `trace.videoHash` must match request bytes → 500 otherwise

## Install caveats on aarch64 (and other thin clients)

The LingBot dependency tree was authored against x86_64 + CUDA 12.8 + a
PyTorch 2.8 install with FlashInfer JIT. On aarch64 dev boxes (e.g. the
NVIDIA tablet this run targeted) the install path is partial:

| Component | Status on aarch64 | What to do |
|---|---|---|
| `torch==2.8.0 + CUDA 12.8` | OK with NVIDIA Jetson wheels — but not from `pytorch.org/whl/cu128` which doesn't ship aarch64 builds | Use `nvcr.io/nvidia/l4t-pytorch` container, or run on x86 hosts only |
| `flashinfer-python` | JIT-compiles CUDA kernels on first use; needs a working `nvcc` + CUDA dev libs at runtime | OK on CUDA-capable hosts; on hosts without `nvcc`, set `--use_sdpa` so LingBot falls back to PyTorch native attention (slower, no FlashInfer needed) |
| `flashinfer-jit-cache` | Available for `cu128`; the aarch64 build sometimes lags | Optional — first-use JIT is the fallback |
| `kaolin` | Required only for the **offline rendering pipeline** (`demo_render/`), NOT for `demo.py` streaming inference | **Skip Kaolin entirely** — the PCC adapter does not call `demo_render/`, only the streaming inference path. The runner doesn't import Kaolin and never will |
| `onnxruntime-gpu` (sky masking) | Optional; only fires when `--mask_sky` is passed | We never pass `--mask_sky` — sky masking is not relevant to per-frame point/pose evidence |
| `lingbot-map` itself | `pip install -e vendor/lingbot-map` works on aarch64 if torch is already installed — pure Python except for the optional CUDA hot paths | Run in stub mode for local testing |

The adapter handles all of this with the `PCC_LINGBOT_STUB=1` env (also
honored: `PCC_LINGBOT_DISABLED=1`). In stub mode the Python runner does
NOT import `torch` or `lingbot_map` at all — it emits a deterministic
synthetic trace (identity-pose-with-drift, seeded random sparse points,
`stubbed: true`). The rest of the pipeline is end-to-end exercisable on
any dev box without a GPU.

**Stub-mode env override (for `pnpm dev` on aarch64):**

```bash
export PCC_LINGBOT_STUB=1
pnpm --filter @pcc/gateway dev
```

For production on x86 + CUDA:

```bash
unset PCC_LINGBOT_STUB
export PCC_LINGBOT_PYTHON=/opt/conda/envs/lingbot-map/bin/python
export PCC_LINGBOT_RUNNER=/srv/pcc/scripts/pcc_lingbot_runner.py
export PCC_LINGBOT_ROOT=/srv/pcc/vendor/lingbot-map
# Optional model path; omit for random-weights smoke run.
# Per the user's directive we do NOT download lingbot-map-long.pt (4.6 GB)
# in CI/dev — prefer lingbot-map-stage1 in prod when added.
```

## Checkpoint policy (per user directive)

- ❌ **Do NOT download `lingbot-map-long.pt` (4.6 GB)** — neither at build time, in CI, nor in any test fixture
- ✅ For real inference on prod hosts, prefer `lingbot-map-stage1` (smaller)
- ✅ For the test path, use stub mode (`PCC_LINGBOT_STUB=1`) — adapter never opens a checkpoint
- ✅ For local dev sanity-check on a CUDA-capable host without a checkpoint, omit `--model-path` and the runner builds `GCTStream` with random weights via the same path `gct_profile.py` uses (`load_model(backend, ...)` with no checkpoint load). Marks the output `stubbed: false, model: "lingbot-map-random-init"` — geometrically invalid output but valid for pipeline shape/timing checks

## Compatibility decisions and edge cases

1. **CC class neutrality.** The 3D trace is orthogonal to the six CVP
   capture classes (CC0..CC5). A CC0 capture with `pointMaps3D` is still
   CC0 — the class is determined by signature evidence, not by the
   presence of geometric data. This matches the existing `sensorFusion`
   pattern.
2. **Manifest hash boundary.** Because `pointMaps3D` is hashed into
   `manifestHash`, the verifier's existing G1 (Structural) gate
   automatically protects 3D evidence integrity. No new verifier gate
   needed for v0.
3. **Two server hops vs one.** We chose to keep streaming-3D as a
   separate `/api/capture/3d-stream` endpoint instead of folding it into
   `/api/capture/upload`. Rationale: LingBot inference can take 10-30s on
   real hardware; coupling it to the synchronous upload route would block
   the verifier's hot path. Separate route lets the browser parallelize
   recording + inference with photo capture + IMU.
4. **Hash echo, defense-in-depth.** The browser hashes the video locally,
   sends the hash as `expectedVideoHash`, the gateway re-hashes and
   compares, the adapter writes the same hash into the trace, the gateway
   cross-checks again. Three opportunities to catch a swap; mismatches
   produce a clear-coded 400/500.
5. **Soft-fail in CaptureFlow.** If the streaming-3D adapter throws (no
   webcam, gateway 502, network error), `CaptureFlow` warns to console
   and continues without `pointMaps3D`. The photo + IMU + WebAuthn
   evidence still upload normally. This preserves CC1 baseline behavior
   for users who don't opt into 3D capture.
6. **Subprocess boundary.** Only `lingbot-adapter.ts` knows about the
   Python child process. The gateway route never touches `spawn` or
   tempfiles for the Python side. Tests inject a fake spawner; no Python
   is invoked in CI.

## Blockers / not done

1. **Tests not executed locally.** Test files are written but were not
   run in this session — pnpm/vitest are not installed on the dev box and
   `spark-check` (per CLAUDE.md's "MANDATORY DGX Spark offload" rule) was
   denied by the user when prompted at session start. To run:

   ```bash
   pnpm install   # one-time
   pnpm --filter @pcc/spec test capture.test.ts
   pnpm --filter @pcc/verifier build && pnpm --filter @pcc/verifier test
   pnpm --filter @pcc/gateway build && pnpm --filter @pcc/gateway test capture-3d.test.ts
   pnpm --filter @pcc/ui test StreamingThreeD.test.ts
   ```

   Or via Spark (preferred per the project's deploy policy):

   ```bash
   spark-run "cd ~/projects/physical-capability-cloud && pnpm install && pnpm -r build && pnpm --workspace-concurrency=1 -r test"
   ```

2. **No CI matrix update.** `.github/workflows/ci.yml` was not modified —
   the new tests will pick up automatically through `pnpm -r test`. If
   the gateway test starts hanging in CI, the most likely cause is the
   default spawner not getting replaced — check that the test imports
   `setLingBotSpawnerForTests` from `@pcc/verifier/dist/...` and that the
   verifier build ran before the gateway test.

3. **Real-mode integration not load-tested.** Adapter argument bounds
   are conservative defaults; if production traffic shows the 32-frame
   cap is too small or the 32 MB body cap is too small for typical 5-10s
   phone clips, both are clamp-only changes in two files.

4. **No CID upload path yet.** `PointMap3DFrame.cid` is part of the
   schema but the adapter does not currently push the full dense point
   cloud to IPFS/Storacha. Wiring that into `evidenceStorage` is a
   follow-up — the field exists so the schema doesn't break later when
   we do.

5. **CaptureFlow UI affordance is opt-in only.** Operators have to set
   `streaming3D={{ enabled: true }}` on the React component. No visible
   toggle in the existing dashboard UI yet — that's a UX-layer follow-up.

## Files added/modified summary

```
NEW  vendor/lingbot-map/                                  (shallow clone, 1326 files, Apache-2.0)
NEW  scripts/pcc_lingbot_runner.py                        (10 KB)
NEW  packages/verifier/src/capture/lingbot-adapter.ts     (10 KB)
NEW  packages/verifier/src/capture/lingbot-adapter.test.ts (8.3 KB)
NEW  packages/gateway/src/routes/capture-3d.ts            (8.1 KB)
NEW  packages/gateway/src/__tests__/capture-3d.test.ts    (8.6 KB)
NEW  packages/ui/src/capture/StreamingThreeD.ts           (11 KB)
NEW  packages/ui/src/capture/StreamingThreeD.test.ts      (8.8 KB)
NEW  ai/research/landscape-lingbot-adopt.md               (wheel-scout note)
NEW  ai/research/lingbot-pcc-wiring.md                    (this file)

EDIT packages/spec/src/types/capture.ts                   (+~120 lines: types + Zod)
EDIT packages/spec/src/types/capture.test.ts              (+~80 lines: 6 new test cases)
EDIT packages/verifier/src/capture/index.ts               (+10 lines: barrel re-exports)
EDIT packages/verifier/src/index.ts                       (+6 lines: top-level re-exports)
EDIT packages/gateway/src/server.ts                       (+2 lines: import + register)
EDIT packages/ui/src/capture/index.ts                     (+16 lines: barrel re-exports)
EDIT packages/ui/src/capture/CaptureFlow.tsx              (+~50 lines: opt-in prop + Promise.all wiring + manifest merge)
```

## License

LingBot-Map is Apache-2.0 — commercial use, sublicensing, and modification
are all permitted as long as we preserve the upstream `LICENSE.txt`
(present at `vendor/lingbot-map/LICENSE.txt`). All adapter code added in
this wave is original and inherits the PCC repo's existing license. The
Python runner header carries `License: Apache-2.0 (matches LingBot-Map
upstream)` since it imports from the vendored tree.
