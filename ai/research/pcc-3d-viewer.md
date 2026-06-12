# PCC 3D Viewer — design, wiring, and data flow

A vitest-tested PointMap3DTrace player wired into the verifier dashboard.
Renders per-frame sparse point clouds plus the full camera trajectory and
exposes play / pause / seek / step / rate controls.

**Branch:** `feat/3d-viewer` off `feat/lingbot-pcc-wiring`
**Generated:** 2026-05-30 by `/go` on DGX Spark (gx10-dgx-spark, 119 GB RAM)

---

## 1. Routes touched

The task brief said "grep `packages/dashboard` for the current capture /
evidence detail route — do not invent the path." The actual dashboard lives
at `apps/dashboard` (not `packages/dashboard`); `packages/dashboard` does
not exist. The route slot was decided after enumerating every page-level
route in `apps/dashboard/src/App.tsx`:

| Path | Page component | Suitability for the 3D viewer |
|------|----------------|---------------------------------|
| `/evidence/:bundleId` | `EvidenceExplorerPage` | **Primary slot.** This is the evidence-record browser — bundles ARE the data the viewer renders. |
| `/jobs/:jobId` | `JobDetailPage` | **Secondary slot.** The evidence timeline already lives here; per-job 3D playback is a natural sibling panel. |
| `/traces` | `TracesPage` | Trace WATERFALL (Sentry/Jaeger-style spans). Different concept, not relevant. |
| `/telemetry` | `TelemetryPage` | Pipeline-event telemetry. Already crowded; not a fit. |

The viewer ended up wired into **both** primary slots — `EvidenceExplorerPage`
gets a full-width streaming-3D panel with a "Load demo trace" button (since
the page is mock-driven for now); `JobDetailPage` gets a smaller 300 px-tall
embedded viewer beside the evidence timeline.

### Files changed in `apps/dashboard/src/`

| File | Change |
|------|--------|
| `pages/EvidenceExplorerPage.tsx` | Import viewer + fixture; add local `pointMaps3D` state; render new "Streaming 3D Trace" panel before the decrypted evidence panel. |
| `pages/JobDetailPage.tsx` | Same imports; add embedded viewer panel in the evidence column. |
| `components/viewer/PointMap3DViewer.tsx` | NEW — main `<Canvas>` + transport controls + metadata strip. |
| `components/viewer/PointMap3DScene.tsx` | NEW — R3F scene (point cloud + camera-path polyline + marker + helpers + OrbitControls). |
| `components/viewer/usePointMap3DPlayback.ts` | NEW — play/pause/seek/step/rate state machine with RAF loop. |
| `components/viewer/pointmap-utils.ts` | NEW — pure helpers (buffer conversion, path extraction, time→frame lookup, bounding box). |
| `components/viewer/fixtures.ts` | NEW — deterministic 24-frame demo trace for dev / smoke tests. |
| `components/viewer/index.ts` | NEW — barrel exports. |
| `components/viewer/__tests__/pointmap-utils.test.ts` | NEW — 34 tests covering edge cases (NaN, empty traces, malformed matrices). |
| `components/viewer/__tests__/usePointMap3DPlayback.test.ts` | NEW — 21 tests covering controls, RAF integration, trace identity changes. |
| `components/viewer/__tests__/fixtures.test.ts` | NEW — 9 tests including round-trip validation against `PointMap3DTraceSchemaExport`. |
| `package.json` | +three ^0.184.0, +@react-three/fiber ^9.6.1, +@react-three/drei ^10.7.7, +@types/three ^0.184.1 (dev). |

No other dashboard files modified; the viewer is isolated behind a single
import path and adds a panel only — it doesn't restructure existing layouts.

---

## 2. Library choice rationale

The task allowed "three.js or react-three-fiber (whichever already in
dashboard deps; check package.json first)." Neither was present, so a
choice was required. Full landscape report:
`ai/research/landscape-pcc-3d-viewer.md`. Short version:

| Axis | three.js (raw) | react-three-fiber + drei | Decision |
|------|----------------|--------------------------|----------|
| Idiomatic with React 19 | No — imperative `requestAnimationFrame` loop, manual cleanup | Yes — declarative JSX, hooks-based | **R3F** |
| Test ergonomics with vitest | Need DOM stubs, mock the canvas context | Pure components, logic-level tests work | **R3F** |
| Camera-path polyline | Hand-roll `BufferGeometry` + `Line` | `<Line points={…}>` from drei | **R3F** |
| Orbit interaction | Hand-import three's example OrbitControls | `<OrbitControls makeDefault />` from drei | **R3F** |
| Bundle weight | three core ≈ 600 KB | three + R3F + drei tree-shaken ≈ 750 KB | Within tolerance (lazy-loaded route chunk) |
| Risk of cross-page regressions | Imperative side-effects across renders | Pure React components, isolated | **R3F** |

**Final pick:** `@react-three/fiber@^9.6.1` + `@react-three/drei@^10.7.7` +
`three@^0.184.0`. Reasoning notes:

- **R3F 9 supports React 19.** Earlier R3F majors only supported React 18.
  R3F 9 (released 2025-09) is the line we want with the dashboard on
  `react@^19.0.0`.
- **drei gives us `<Line>`, `<Points>` material primitives, `<OrbitControls>`,
  `<gridHelper>`/`<axesHelper>` host components.** Without drei the viewer
  would be twice as much code.
- **All three packages are MIT-licensed**, no copyleft. No constitutional
  conflict with PCC's policy (no `constitution.md` exists at repo root —
  CLAUDE.md governs).

The deps passed routine install (`pnpm --filter @pcc/dashboard add ...`)
on the workspace. No `/vet` gate run yet — that should be done before the
PR merges per the project's Gate A policy in `CLAUDE.md`.

---

## 3. Data flow from gateway through verifier to viewer

The full path from operator capture to dashboard render. Existing wiring
ends at the gateway; this PR adds the dashboard hop.

```
┌──────────────────────────────────────────────────────────────────┐
│ Operator phone / browser                                         │
│                                                                  │
│   CaptureFlow.tsx (packages/ui/src/capture/)                    │
│     └─ StreamingThreeD.recordAndInfer(opts)                     │
│          - getUserMedia({video:{facingMode:'environment'}})     │
│          - MediaRecorder records ~3 s webm clip                 │
│          - sha256Blob(video) → "sha256:<hex>"                   │
│          - POST /api/capture/3d-stream  (base64 video + meta)   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  HTTPS, Bearer token
┌──────────────────────────────────────────────────────────────────┐
│ Gateway (packages/gateway/)                                      │
│                                                                  │
│   routes/capture-3d.ts                                           │
│     ├─ Zod validation on body (32 MB cap, hash echo check)       │
│     └─ runLingBotInference(input)                                │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  spawned subprocess
┌──────────────────────────────────────────────────────────────────┐
│ Verifier (packages/verifier/src/capture/lingbot-adapter.ts)      │
│                                                                  │
│   1. spawn python scripts/pcc_lingbot_runner.py                 │
│      (PCC_LINGBOT_STUB=1 in dev/test — random points + poses)   │
│   2. parse stdout JSON                                          │
│   3. Zod re-validate via PointMap3DTraceSchemaExport            │
│   4. return PointMap3DTrace                                      │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  JSON
┌──────────────────────────────────────────────────────────────────┐
│ Browser response handler                                         │
│                                                                  │
│   uploadAndInfer() in StreamingThreeD.ts                         │
│     └─ assert returned trace.videoHash matches sha256 we sent    │
│     └─ resolve { trace, durationMs, stubbed, ...}                │
│                                                                  │
│   CaptureFlow.tsx composes the full CaptureManifest             │
│     └─ pointMaps3D: trace  (one field on CaptureManifest)        │
│     └─ POST /api/capture/upload  (multipart manifest + media)    │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼  evidence flow (not in this PR)
                  encrypted bundle → IPFS / on-chain anchor

— — — — — — — NEW WORK IN THIS PR — — — — — — —

┌──────────────────────────────────────────────────────────────────┐
│ Verifier dashboard (apps/dashboard/)                             │
│                                                                  │
│   Route: /evidence/:bundleId  → EvidenceExplorerPage             │
│   Route: /jobs/:jobId        → JobDetailPage                     │
│                                                                  │
│   Both pages:                                                    │
│     ├─ load EncryptedEvidenceBundle from useEvidenceExplorer-    │
│     │   Store (currently mock data; real path: gateway query)   │
│     ├─ on "Load demo trace" click → setPointMaps3D(             │
│     │     makeDemoPointMap3DTrace(seed))                         │
│     │   (real path: resolve trace via IPFS CID or gateway       │
│     │    `/api/evidence/:id/point-maps-3d`)                     │
│     └─ render <PointMap3DViewer trace={pointMaps3D} />          │
│                                                                  │
│   PointMap3DViewer                                               │
│     ├─ usePointMap3DPlayback(trace, {loop, autoplay})           │
│     │   - currentFrame: number                                  │
│     │   - play / pause / step / seekFrame / seekTime / setRate  │
│     │   - RAF loop advances currentFrame at trace.fps × rate    │
│     │   - timeToFrameIndex() binary-search on scrub             │
│     │                                                            │
│     ├─ <Canvas> from @react-three/fiber                         │
│     │   └─ <PointMap3DScene trace={trace} currentFrame={…}>    │
│     │       ├─ <ambientLight /> + <directionalLight />          │
│     │       ├─ <gridHelper /> + <axesHelper />     (helpers)    │
│     │       ├─ <Line points={path} color="#34d399" /> (full     │
│     │       │   camera trajectory polyline from drei)           │
│     │       ├─ <mesh position={markerPos}>         (current     │
│     │       │     <sphereGeometry /><meshBasicMat/>  camera     │
│     │       │   </mesh>                              marker)    │
│     │       ├─ <points key={`pts-${currentFrame}`}>             │
│     │       │     <bufferGeometry>                              │
│     │       │       <primitive object={positionAttr} />          │
│     │       │       <primitive object={colorAttr} />             │
│     │       │     </bufferGeometry>                              │
│     │       │     <pointsMaterial vertexColors />               │
│     │       │   </points>                                       │
│     │       └─ <OrbitControls makeDefault />                    │
│     │                                                            │
│     └─ Transport controls (HTML — outside Canvas)               │
│        ├─ ⏮ reset · ◀ step-back · ▶/❚❚ play/pause · ▶ step    │
│        ├─ time display: m:ss / m:ss                             │
│        ├─ <select> rate (0.25x, 0.5x, 1x, 2x, 4x)               │
│        ├─ <input type="range"> frame seek (0 .. frameCount-1)   │
│        └─ metadata: N points · conf 0.xx · cid bafy…            │
└──────────────────────────────────────────────────────────────────┘
```

### How a frame change becomes pixels

1. `usePointMap3DPlayback`'s RAF loop calls `setCurrentFrame(nextIdx)`
   (only when index actually changes — frame rate-limited by trace.fps).
2. `PointMap3DScene` re-runs its memos:
   - `positions` and `colors` rebuilt via `pointsToBuffer(frame)` and
     `pointsToColorBuffer(frame)` (O(N) over the sparse cloud — default
     N≈256, ≪ 16 ms even on a slow GPU).
   - The full camera path is cached on `trace` identity (not frame) so it
     never rebuilds during playback.
   - The `<mesh>` marker reads frame's pose translation column.
3. R3F diffs the scene, three.js uploads only the changed
   `position` / `color` `BufferAttribute`s, and the WebGL renderer
   redraws into the canvas.

### Performance notes

- The point cloud is rebuilt per frame change but the camera-path
  polyline is rebuilt only on trace identity change (`useMemo(…, [trace])`).
- `BufferAttribute` is re-instanced when the underlying Float32Array
  changes (memo keyed on the rebuilt buffer) — three then uploads only
  the changed bytes, not the whole scene.
- For very dense clouds (≥ 5000 points), the renderer remains 60 fps
  because `<points>` uses a single draw call with `sizeAttenuation`.
- OrbitControls is set as `makeDefault` so R3F's `gl` knows about it
  and doesn't apply parallel mouse damping. Damping factor is 0.1.

---

## 4. Test coverage

```
src/components/viewer/__tests__/
├── pointmap-utils.test.ts        (34 tests)
├── usePointMap3DPlayback.test.ts (21 tests, @vitest-environment jsdom)
└── fixtures.test.ts              ( 9 tests, schema round-trip)
                                  ───────────
                                  64 viewer tests
```

| File | What it covers |
|------|----------------|
| `pointmap-utils.test.ts` | `extractCameraPath` (translation column extraction, malformed-matrix guard), `pointsToBuffer` / `pointsToColorBuffer` (NaN-safe, clamps conf to [0,1]), `traceDurationSec` (negative-timestamp guard), `timeToFrameIndex` (binary-search correctness, midpoint tie-break), `clampFrameIndex` (negative/over-length/NaN/empty), `pathBounds` (min-size clamp), `isFinitePoint` (NaN/Infinity rejection). |
| `usePointMap3DPlayback.test.ts` | Mounts the hook via `react-dom/client` + `act` so effects flush. Tests initial state for every option (rate clamping, autoplay vs. single-frame-no-autoplay, null trace). Tests every control (`setRate`, `seekFrame`, `seekTime`, `step`, `reset`, `toggle`, `pause`, `play`) including clamp boundaries and inert behaviour on null traces. Tests trace-identity change resets frame index. Tests RAF integration with deterministic clock stub: scheduler invoked when playback engages, cancelled on unmount, NOT invoked when autoplay=false or trace has only one frame. |
| `fixtures.test.ts` | Deterministic seed → identical traces, different seeds → different traces, monotonic timestamps, exactly-12-number pose matrices, finite x/y/z, conf in [0,1], schema validation against `PointMap3DTraceSchemaExport` (round-trip would succeed at the gateway). |

**Full suite:** `pnpm --filter @pcc/dashboard test` → **198 / 198 passing**
(64 of them mine; 134 pre-existing across `onboard`, `kernel-leaderboard`,
`assurance`).

**Typecheck:** `pnpm --filter @pcc/dashboard typecheck` → **clean**.

**Build:** `pnpm --filter @pcc/dashboard build` → **succeeds** in ~19 s.
The viewer-containing route chunk is 936 KB (gz 254 KB) — three + R3F +
drei is the bulk; only loaded when the user visits
EvidenceExplorerPage or JobDetailPage (both already lazy-loaded).

---

## 5. What's stubbed / what's next

1. **Real evidence wiring.** The dashboard currently loads a fixture trace
   via a button. The gateway side exists (`POST /api/capture/3d-stream`
   returns and `pointMaps3D` rides in the capture manifest), but there is
   no `GET /api/evidence/:id` path that yields the trace back to the
   viewer. Next step: extend the evidence-explorer store to fetch the
   trace via the manifest's IPFS CID, or expose a dedicated gateway endpoint.
2. **Dense cloud streaming.** The schema's `PointMap3DFrame.cid` is the
   pointer to the off-chain dense cloud (NPZ blob). A future viewer mode
   could optionally page in dense clouds for the focused frame.
3. **Gate A vetting.** `/vet` should be run on the three new deps (`three`,
   `@react-three/fiber`, `@react-three/drei`) before the PR merges, per
   project policy in `CLAUDE.md` ("All new tools, MCP servers, npm packages
   … MUST pass through Gate A vetting").
4. **Optional drei `vendor-three` chunk.** Adding a manual chunk for the
   3D rendering stack in `vite.config.ts` would lower the per-route chunk
   weight and let the same chunk be reused across both pages.

---

## 6. Reproducing this work

```bash
git checkout feat/3d-viewer
pnpm install            # adds three / r3f / drei to lockfile
pnpm --filter @pcc/spec build           # PointMap3DTraceSchemaExport for fixture test
pnpm --filter @pcc/ui build             # GlassPanel, GlowBadge for pages
pnpm --filter @pcc/contract-builder build  # transitive dep of dashboard stores
pnpm --filter @pcc/dashboard test        # 198/198
pnpm --filter @pcc/dashboard typecheck   # clean
pnpm --filter @pcc/dashboard build       # 18.57s on Spark
pnpm --filter @pcc/dashboard dev          # opens http://localhost:5173
# Navigate to /evidence (Evidence Explorer) or /jobs/job-001 (Job Detail)
# Click "Load demo trace" → viewer renders → play / pause / seek.
```
