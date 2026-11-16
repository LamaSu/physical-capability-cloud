# photo-camera-reg — G-8b: PhotoCameraAdapter registration

**Agent**: photo-camera-reg-implementer-1
**Branch**: `fix/photo-camera-adapter-registration` (off `lamasu/master` 7a864910)
**Date**: 2026-09-08
**Ledger**: G-8 / MS-11 / LO-SE-1 (memo S2 "frictionless nodes")

## Outcome

**DONE.** A kernel config can now name `adapterType: "photo"` on a camera device
and get the real `PhotoCameraAdapter` — never a silent mock. A missing photo
fails loud: the factory-built adapter with no bytes pushed rejects
`captureSnapshot()` and emits **zero** evidence events, so a tier-2 job fails
closed rather than settling on a fabricated hash.

- `pnpm --filter @pcc/kernel test` — **38 files / 875 tests passed**, 0 failed.
- `pnpm --filter @pcc/kernel exec tsc --noEmit -p .` — **clean, exit 0**.
- 12 new tests, all passing. No test weakened, skipped, or hardcoded.
- No new dependencies. All changes inside `packages/kernel`.
- 2 implement→test iterations used (of 6 budgeted); no red iterations — the
  only failures were pre-existing worktree ones (see "Environment" below).

## Design note (written before editing)

1. `AdapterType` gains `"photo"`; everything else about the union is untouched.
2. `buildPhotoCamera(device, cfg, kernelId)` mirrors the built-in pattern and is
   registered next to `mock` / `generic-http` in the camera registry.
3. **Storage: hash-only** (the `routes/photo-verification.ts:18` precedent) —
   `new PhotoCaptureService()` with no storage service, so `storageRef` is the
   hash-derived `photo:sha256:<hex>`. Two reasons, both load-bearing: (a) the
   factory has no way to receive an evidence storage service —
   `createEvidenceStorage()` is `async` while `CameraAdapterFactory` is sync;
   (b) wiring one would make it *worse*, because `PhotoCaptureService._uploadBytes`
   (photo-capture-service.ts:417-429) returns a hash string, not a CID, which
   `PhotoCameraAdapter` then prefixes `storacha://` (photo-camera-adapter.ts:79-81)
   — a misstated provenance claim inside a signed bundle.
4. **Gemini: opt-in only, never from nothing.** `cfg.gemini` may be `true`
   (key from `cfg.geminiApiKey` or `GEMINI_API_KEY`) or an injected service
   object with a `compare()` method. `gemini: true` with no key available
   **throws** — a keyless `GeminiComparisonService` silently degrades to local
   pHash+SSIM while the adapter still stamps `model: "gemini-2.0-flash"` on the
   emitted `cv_inspection_result` (photo-camera-adapter.ts:191). Downgrading
   there would mint fabricated model provenance.
5. Any other `cfg.gemini` / `cfg.geminiApiKey` shape throws a clear error naming
   the device and the valid forms. **No mock fallback**, per the repo's
   `unknownAdapterTypeError` contract.
6. `globalMock=true` still yields `MockCameraAdapter` — the existing global-mock
   contract, asserted by `adapter-honesty.test.ts:101-105`, is preserved.

## Files changed

| File | Lines | Change |
|---|---|---|
| `packages/kernel/src/kernel-config.ts` | 28-29 | `"photo"` added to `AdapterType` with a one-line doc comment |
| `packages/kernel/src/adapter-factory.ts` | 58-60 | imports: `PhotoCameraAdapter`, `PhotoCaptureService`, `GeminiComparisonService` |
| `packages/kernel/src/adapter-factory.ts` | 362-399 | `buildPhotoCamera()` + doc comment (recognised config keys, storage rationale) |
| `packages/kernel/src/adapter-factory.ts` | 401-448 | `resolvePhotoGeminiService()` — opt-in Gemini, fail-loud misconfig |
| `packages/kernel/src/adapter-factory.ts` | 598 | `registerCameraAdapter("photo", buildPhotoCamera)` |
| `packages/kernel/src/__tests__/photo-camera-registration.test.ts` | 1-283 (new) | 12 tests |
| `packages/kernel/src/__tests__/adapter-factory.test.ts` | 674 | built-ins assertion now expects `"photo"` |
| `packages/kernel/src/__tests__/kernel-config.test.ts` | 212 | supported-adapterType list now includes `"photo"` |

Total: 380 insertions, 1 deletion across 5 files. `job-runner.ts`, settlement,
escrow, evidence signing, gateway routes, and `packages/spec` were **not touched**.

## Negative control (the assertion the steward should rerun)

`packages/kernel/src/__tests__/photo-camera-registration.test.ts:102-112`:

```ts
it("captureSnapshot() with no bytes pushed rejects and emits no evidence", async () => {
  const adapter = createCameraAdapter(cameraDevice("photo"), false);
  const events = collect(adapter);

  await expect(adapter.captureSnapshot()).rejects.toThrow(/No image bytes available/);

  // No camera_snapshot event, so nothing fabricated can enter a signed bundle.
  expect(events).toHaveLength(0);

  await adapter.dispose();
});
```

The adapter under test is the one the **factory** built, not a hand-constructed
`new PhotoCameraAdapter(...)` — that is the whole point of the control.

## Test command + raw tail

```
$ pnpm --filter @pcc/kernel test

 ✓ src/__tests__/tier-enforcement.test.ts  (23 tests) 329ms
 ✓ src/__tests__/opentrons-operator.test.ts  (14 tests) 56ms
 ✓ src/__tests__/opentrons-bundle.test.ts  (17 tests) 6ms
 ✓ src/digital/__tests__/procurement-rfq-kernel.test.ts  (15 tests) 428ms
 ✓ src/__tests__/printer-job.test.ts  (9 tests) 133ms
 ✓ src/__tests__/kernel-registration-proof.test.ts  (4 tests) 173ms
 ✓ src/__tests__/log-capture.test.ts  (25 tests) 788ms
 ✓ src/__tests__/evidence-storage.test.ts  (9 tests) 901ms
 ✓ src/__tests__/printer-log-adapter.test.ts  (19 tests) 3251ms

 Test Files  38 passed (38)
      Tests  875 passed (875)
   Start at  15:52:26
   Duration  4.77s
```

Verbose run of the new file (all 12):

```
 ✓ photo camera registration > listRegisteredCameraAdapters includes 'photo'
 ✓ photo camera registration > createCameraAdapter('photo') returns the REAL PhotoCameraAdapter, not a mock
 ✓ photo camera negative control (fail loud, never fabricate) > captureSnapshot() with no bytes pushed rejects and emits no evidence
 ✓ photo camera negative control (fail loud, never fabricate) > a second captureSnapshot() after a consumed capture rejects (no stale reuse)
 ✓ photo camera push-fed capture > hashes exactly the pushed bytes and returns a storageRef
 ✓ photo camera push-fed capture > different bytes produce different hashes (hash tracks the actual image)
 ✓ createAdaptersFromConfig with a photo camera > mockMode:false produces exactly one REAL PhotoCameraAdapter
 ✓ createAdaptersFromConfig with a photo camera > mockMode:true still yields the mock camera (global-mock contract preserved)
 ✓ photo camera gemini configuration > uses an injected comparison service for runInspection
 ✓ photo camera gemini configuration > gemini:true with no API key anywhere throws instead of silently degrading
 ✓ photo camera gemini configuration > gemini:true with an explicit key builds the adapter
 ✓ photo camera gemini configuration > a malformed gemini config throws a clear error — never a mock fallback
```

Typecheck:

```
$ pnpm --filter @pcc/kernel exec tsc --noEmit -p .
(no output)
TYPECHECK: CLEAN (exit 0)
```

### Environment note (not caused by this change)

A fresh worktree has no `dist/` for the workspace deps. Before the first run,
15 kernel test files failed with `Failed to resolve entry for package "@pcc/spec"`
and `tsc` reported `src/opentrons/operator.ts(26,8): error TS2307: Cannot find
module '@pcc/a2a'`. Both cleared after `pnpm --filter @pcc/spec build` and
`pnpm --filter @pcc/a2a build`. The steward will need those two builds before
rerunning. (Consistent with the known "PCC worktree unbuilt deps" note.)

## Honest gaps

### (i) Nothing on the job path pushes bytes yet — this is the next blocker

The adapter is push-fed by design, and **no job-path caller calls
`setNextCapture()`**. Wiring one was explicitly out of scope here (the brief
forbids touching `job-runner.ts`; another agent is editing it on a separate
branch). Concretely, today a tier-2 job with a `"photo"` camera **fails** at the
before-snapshot — which is the correct fail-closed behaviour, but it means
`"photo"` is not yet usable end-to-end.

Where the hook would go, in preference order:

1. **`packages/kernel/src/job-runner.ts:121-127`** — the before-snapshot span
   (`if (assuranceTier >= 2 && this.camera)` → `this.camera!.captureSnapshot()`).
   A byte source would have to be handed to the runner and pushed immediately
   before this call (and again before the after-snapshot). This is the load-bearing
   site; whoever owns job-runner.ts should own the hook.
2. **`packages/gateway/src/routes/photo-verification.ts:75-92`** —
   `POST /api/photo/upload` already decodes base64 → `Uint8Array` and runs its
   own module-level `PhotoCaptureService`. It has the bytes and does not know
   about any adapter. Routing that upload to the kernel's camera adapter for
   the job in question is the natural operator-relay path.
3. **pcc-node** — see (iii); it has no photo upload path at all today.

### (ii) Job-nonce binding is NOT done here (memo CP-0 measurement (c))

`PhotoCameraAdapter.captureSnapshot()` hashes whatever bytes it was handed and
binds them to nothing but the device/kernel id in `source`. There is no job id,
no nonce, no challenge in the hashed payload, so a photo captured for job A is
indistinguishable from the same photo replayed into job B. `PhotoCaptureService`
has anti-spoof checks for *format*, *size*, *EXIF freshness* and *GPS proximity*
(photo-capture-service.ts:294-372) — none of which is a job binding. Closing
CP-0 (c) requires a nonce to reach `capture()`'s hashed input, which is an
adapter + spec change, not a registration change.

### (iii) pcc-node (Python) has no equivalent

`packages/pcc-node/pcc_node/detect.py:66-82` (`detect_cameras()`) probes
`/dev/video*` via V4L2 and emits `{"type": "camera", "path", "name", "formats"}`
with **no `adapterType`**. `register.py:171` then falls back:
`device.get("adapterType") or device.get("protocol") or device_type` — so a
detected camera registers as `adapterType: "camera"`, which is not a registered
camera adapter type and would (correctly) throw at
`createCameraAdapter`. There is no photo-capture or byte-upload path anywhere in
`pcc_node/`. For a pcc-node operator to use this, `detect_cameras()` would need
to emit `"adapterType": "photo"` and the daemon would need an upload path
feeding (i). Out of scope for this lane (`packages/kernel` only).

### (iv) `packages/spec` divergence (not touched, by instruction)

Two spec-side lists do not know about `"photo"`:

- `packages/spec/src/types/kernel.ts:12` — a **separate** `AdapterType` union
  (`octoprint | modbus | opcua | sila | generic-http | opentrons`). It was
  already divergent before this change: it lacks `ipp`, `hamilton`, and `mock`.
  Nothing imports the kernel's `DeviceConfig` from it, so nothing breaks.
- `packages/spec/src/evidence/adapter-manifests.ts:67-105`
  (`ADAPTER_DEFAULT_MANIFESTS`, keyed by adapterType) has no `photo` entry, so a
  photo device gets no adapter-keyed evidence-primitive defaults. It is partly
  covered by `DEVICE_ROLE_DEFAULT_MANIFESTS.camera` (same file, :116) which
  applies by device **role**, so a photo camera is not left with nothing.

Both are one-line data additions in `packages/spec`. I stopped rather than
changing spec, per the brief. Verified that no test in `packages/spec` enumerates
the kernel's `AdapterType`, so this branch does not break the spec suite.

### (v) Documentation not updated

`CLAUDE.md` §4.3 lists "Valid adapter types: `octoprint`, `modbus`, `opcua`,
`sila`, `generic-http`, `mock`" — already stale (missing `ipp`, `opentrons`,
`hamilton`) and now also missing `photo`. Left alone: it is outside
`packages/kernel`.

## Commits

```
545f76d5 test(kernel): photo-camera-reg: cover photo camera registration + fail-loud capture
6b693056 feat(kernel): photo-camera-reg: register PhotoCameraAdapter as adapterType "photo"
```
