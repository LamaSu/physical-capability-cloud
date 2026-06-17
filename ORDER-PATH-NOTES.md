# Buyer order-path fix — verification notes

Branch: `fix/driver-order-path`. Scope: gateway buyer-order path (negotiate
session + build/options for ad-hoc capabilities). **Build + test only — no
deploy, no push to prod, no GHCR/Railway/:prod changes were made.**

## Status: both bugs fixed and verified by scoped tests

- **BUG 1 (negotiate-session 500 for every case)** — already addressed in the
  committed code (`serializeChallenge` for the BigInt-anchored
  `WorkflowChallenge`, plus an up-front 4xx validation block and a
  try/catch around the handler body). Verified: `POST /api/negotiate/session`
  for `fdm` returns a `created`/`configuring` session that advances through
  `quote → review → commit`.
- **BUG 2 (ad-hoc capabilities unbuyable)** — handled via
  `services/ad-hoc-pricing.ts`: when no built-in template exists, a descriptor
  is derived from the capability row's own `pricing` (baseCost/currency) with a
  generic quantity+notes param flow. Missing-template and wrong-kernel return
  clean 4xx, never 500. Verified end-to-end: a buyer can
  `build/options → negotiate/session → quote → review → commit` an escrow+job
  against `wood-fired-pizza`.

`packages/gateway/src/__tests__/negotiate-ad-hoc.test.ts` — 14/14 green.

## What was actually wrong here (the real gap closed this session)

1. **The fix (#148) had never been executed.** Its tests could not even
   collect — vitest failed with *"Failed to resolve entry for package
   @pcc/store"* because no workspace package is built (`dist/` is absent in a
   fresh worktree; CI builds it). The order-path fix was shipped *unverified*.
   - Fix: `packages/gateway/vitest.config.ts` now aliases every `@pcc/*`
     specifier (and export subpaths, e.g. `@pcc/contracts/abi`) to its TS
     **source**, so the scoped suite runs with zero prior build. This is a
     test-time convenience only — CI/prod still build `dist/` normally; runtime
     resolution is unchanged.

2. **Commit silently stranded the buyer.** `createJobFromSession` called
   `getKernelService()` (only to compute the best-effort `isExternal`
   queued-vs-active hint). That throws if kernel-service is uninitialised, and
   **both callers wrap the function** (the negotiate commit handler swallows
   the throw as "best-effort"; the fast-track route turns it into a 500) — so
   the buyer got a `committed` session with **no job/escrow/scope** and no
   error. The old test passed anyway because it only asserted
   `status === "committed"`.
   - Fix: guarded the `getKernelService()` lookup; default to "local" when the
     service is unavailable (`packages/gateway/src/routes/paid-job-flow.ts`).
   - Test now asserts the commit response actually carries `jobId`/`escrowId`/
     `scopeId`/`escrowStatus: "funded"` for both the `fdm` and the ad-hoc
     pizza path, proving the escrow+job wiring ran.

## Verification performed (Spark was down → ran locally, sequential)

- `negotiate-ad-hoc.test.ts` → 14 passed.
- `createJobFromSession` regression set (`v2-settlement-wiring`,
  `eas-attestation-bridge`) → 28 passed / 2 skipped.
- Diverse sample (`template-session`, `capability-facade`, `setup`, `wizard`,
  `event-bus`) → 135 passed. Confirms the source-aliasing is robust across
  varied import graphs.

## Residual caveats (not gaps in the fix)

- The full 97-file gateway suite was **not** run end-to-end this session
  (local 16 GB box, DGX Spark unreachable → OOM risk on a full parallel run).
  CI should run it after building `dist/`. The exclude-list in
  `vitest.config.ts` (pre-existing facade-rewrite skips) is unchanged.
- `tsc`/typecheck for the gateway can't pass locally until the workspace
  `dist/*.d.ts` are built (unrelated to these changes); not run here.
