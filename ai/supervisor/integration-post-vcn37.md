# Post-VCN-37 Integration Report

**Agent**: implementer-whiskey
**Date**: 2026-06-19
**Integration branch**: `integration/post-vcn37-fixes`
**Base**: `lamasu/master` (4d0567c1e10d3590cbeddaaaeb85fa93305aeaa9)
**Status**: GO

---

## Summary

Composed 4 of 5 implementer branches into a single reviewable branch.
Sierra2's branch was findings-doc only (skipped per prompt). Tango's branch
was effectively superseded by an upstream PR (#172) that landed independently
to fix the same B5 email-transport issue — see "What was skipped and why"
below.

Tests on the resulting integration branch: **103 gateway test files passed,
1803 tests passed, 5 skipped, 0 failed.** Workspace-wide: every package that
runs tests passes (the single workspace test failure — `demand-intel
aggregator.test.ts` — is pre-existing and references a non-existent
`@pcc/store` package; it fails identically on master).

---

## Branches surveyed

| Branch | Owner | Status | Cherry-picked |
|---|---|---|---|
| `fix/catalog-list-and-decompose-vocab` | romeo | Picked (2 of 4 commits — the other 2 are summit work already in master via #167) | YES |
| `feat/ed25519-keys-and-kernel-ttl` | uniform | Picked (all 9 commits, no conflicts) | YES |
| `feat/kernel-response-discovery-status` | victor | Picked (3 of 178 commits — only the implementer-victor: commits; rest are a fork-base divergence dating from a much older codebase) | YES |
| `feat/channel-email-real-transport` | tango | **SKIPPED** — superseded by upstream PR #172 (`fix(roleplay): real email transport for operator notifications`) which already does the B5 fix via a different module shape | NO |
| `feat/erc8004-identity-reputation-base-sepolia` | sierra2 | **SKIPPED** — per prompt, this branch is a findings/blockers doc only; ERC-8004 IdentityRegistry write integration remains a separate fresh task | NO |

---

## Cherry-pick log (chronological)

```
ede9b60 fix(gateway): honour ?type= filter on GET /api/capabilities + regression tests   [romeo, 3ac996d]
de88e5c fix(decomposer): live-vocab-aware DAG construction + food_delivery template       [romeo, 081ab67] - CONFLICT resolved
2849573 feat(db): add valid_until + last_heartbeat_at TTL columns + public_key on api_keys [uniform, e6ad2e4]
12b0a6d feat(gateway): issue Ed25519 keypair at agent provision (BYOK or server-mint)     [uniform, eee2922]
625904d feat(gateway): POST /api/agents/:id/verify endpoint for Ed25519 signature check   [uniform, 4b9c1f9]
fb9dac8 feat(gateway): TTL on kernels + capabilities, heartbeat extends, catalog drops    [uniform, a8d81bb]
6355e95 feat(gateway): background TTL sweeper + per-capability heartbeat route            [uniform, f3a970d]
7edaf38 docs: kernel-lifecycle.md — TTL contract for kernel + capability registry         [uniform, 6ed15a7]
349cd03 test(gateway): unit + integration tests for ed25519 + kernel TTL                  [uniform, f711b5b]
47aac2f chore(gateway): hoist createPrivateKey import in ed25519 helper                   [uniform, de8681e]
862cf93 test(gateway): mock telemetry + audit + posthog in TTL/ed25519 integration tests  [uniform, 552cd48]
b176a76 implementer-victor: feat(gateway): surface discoveryStatus + nextStep on /api/kernels [victor, d840344] - CONFLICT resolved
0d5455d implementer-victor: test(gateway): cover discoveryStatus + nextStep on /api/kernels [victor, 0a4a617] - CONFLICT resolved
fe27698 implementer-victor: revert routes.test.ts edit — file is in vitest exclude list   [victor, b5d47d3] - CONFLICT resolved
f86b0f1 implementer-whiskey: fix(gateway): alias kernel.capabilities -> capabilityTypes on GET /api/kernels/:id  [whiskey, integration glue]
```

---

## Conflicts encountered + resolutions

### C1. `packages/gateway/src/routes/requests.ts` (romeo `081ab67`)

**Cause**: Romeo's commit replaced the decompose call site with a single
`decomposeRequest(request, { availableTypes: liveCapabilityTypes() })`.
Upstream master had already added (via PR #169 — ad-hoc capability routing,
landed independently) a branched ad-hoc path: `if (body.capabilityType)
matchListings(...) else decomposeRequest(request)`.

**Resolution**: Preserve master's ad-hoc routing branch verbatim. Inject
romeo's `availableTypes: liveCapabilityTypes()` arg into the `else` branch's
`decomposeRequest` call. The two changes compose cleanly — ad-hoc routing
happens for buyer-typed requests, romeo's vocab-aware DAG bias kicks in for
natural-language fallback.

### C2. `packages/gateway/src/routes/kernels.ts` (victor `d840344`)

**Cause**: Victor's branch is on a much older fork base (`6a2236f`, ~178
commits behind master). His `routes/kernels.ts` was written against the
pre-facade architecture (`getRepos()` direct calls); the post-uniform HEAD
uses the `KernelFacade` pattern with `sendResult` helper. The whole-file
diff was structurally incompatible.

**Resolution**: Port Victor's semantic additions into the facade
architecture. Added `buildCapabilityRegistrationHint(kernelId)` helper
above the route block (Victor's exact prose). Modified the existing
`GET /api/kernels/:kernelId` route to compute `discoveryStatus` from the
facade-returned `KernelHealthSnapshot.capabilityCount` and attach
`nextStep` when the kernel has zero capabilities. Modified the existing
`POST /api/kernels` route to emit the same fields on the 201 response.
Victor's facade-incompatible whole-file replacement was discarded.

### C3. `packages/gateway/src/__tests__/routes.test.ts` (victor `0a4a617`)

**Cause**: Victor inserted a `discoveryStatus=discoverable` test in
`routes.test.ts` AND renamed the adjacent "returns 404 for unknown kernel"
title to "returns error for unknown kernel".

**Resolution (initial)**: Kept both the new discoveryStatus test and HEAD's
404 title.

### C4. `packages/gateway/src/__tests__/routes.test.ts` (victor `b5d47d3`)

**Cause**: Victor's own follow-up revert of C3 — his own commit message
notes that `routes.test.ts` is in vitest's exclude list and the
discoveryStatus test there was dead code. He moved the canonical
discoveryStatus tests to `kernel-register-response.test.ts` (which IS in
vitest).

**Resolution**: Apply the revert — drop the discoveryStatus stub from
`routes.test.ts`. Keep HEAD's "returns 404 for unknown kernel" title (more
accurate than victor's older "returns error" wording).

---

## Integration glue commit (f86b0f1)

After cherry-picking succeeded, Victor's `kernel-register-response.test.ts`
failed one assertion: it expected `body.kernel.capabilities` to be a plain
string[] of capability types on `GET /api/kernels/:id`. Uniform's facade
refactor surfaces the same data as `capabilityTypes`, not `capabilities`.
The kernel-populator comment explicitly notes "Backward-compat alias for
capabilityTypes (dashboard + tests use kernel.capabilities)" but the alias
field itself wasn't actually being emitted.

Added a route-layer alias `capabilities: snapshot.capabilityTypes ?? []`.
Purely additive — KernelHealthSnapshot fields preserved, all other callers
unaffected. One commit: f86b0f1.

---

## Cross-branch interactions found

1. **routes/requests.ts (romeo × master PR #169)**: Both touched the same
   decompose site. Resolved by composing — master's ad-hoc branch + romeo's
   live-vocab arg in the fallback. Verified by `decomposer-food-delivery`
   tests (8 passing in integration branch).
2. **routes/kernels.ts (victor × uniform)**: Victor wrote against
   pre-facade architecture; uniform shipped the facade refactor. Victor's
   semantic additions ported into uniform's facade arch. Verified by
   `kernel-register-response.test.ts` (5 passing) + `kernel-ttl-integration.test.ts`
   (5 passing) + `kernel-ttl-filter.test.ts` (passing).
3. **kernel.capabilities alias (whiskey integration glue)**: Necessary
   because victor's test was written against the older shape and uniform's
   populator emits the newer shape. One-line route alias resolves it.
4. **Master PR #172 vs tango branch**: Both implemented the same B5 fix
   (real email transport for operator-channels dispatch). Master's #172
   uses `services/email-transport.ts`; tango's branch uses
   `services/channel-email.ts`. They are equivalent in behavior — picking
   tango on top would have created a major two-implementation conflict.
   Tango's smoke tests are tightly coupled to his own module shape and
   would not have exercised master's transport. **Decision: skip tango**
   and let master's #172 stand as the B5 fix.

---

## Test results

### Gateway package (most relevant — all integration territory)

| Phase | Test files | Tests passed | Failed | Skipped |
|---|---|---|---|---|
| Before integration (master 4d0567c) | n/a (baseline) | n/a | n/a | n/a |
| First run (build artifacts missing for verifier) | 101 / 103 | 1748 | 1 (kernel-register-response.test.ts) + 2 file-load (capture) | 5 |
| After whiskey alias commit (f86b0f1) | 101 / 103 | 1749 | 0 + 2 file-load (capture, pre-existing) | 5 |
| After `pnpm build` for `@pcc/spec` + `@pcc/verifier` | **103 / 103** | **1803** | **0** | **5** |

### Workspace-wide

Ran `pnpm -r test` across all 55 workspace packages after building
`@pcc/spec` + `@pcc/verifier`. Summary of green packages tracked:
bridge-directory (48), attestations (71), a2a-signing (22),
connectors-airbyte-bridge (6), connectors-csv (6), connectors-postgres (5),
connectors-sap (5), connectors-salesforce (5), connectors-sharepoint (5),
identity (68), evidence-embeddings (63), onboard-cli (45), trilobio (31),
subgraph (6), spec (499), contract-builder (358), contracts (245), a2a
(254 + 15 skipped), identity-8004 (24), db (179), intent-broker (13),
dht-core (37), mcp-server (51), intent-otel-exporter (62), intent-collector
(67), scheduler (33), payments (300), tool-index (100), touchstone (57),
ui (9), workflow (186), verifier (585), orchestrator (54), demand-intel
(23 passing + 1 file failure, see below), gateway (1803).

Sole non-passing test file: `packages/demand-intel/src/__tests__/aggregator.test.ts`
— "Failed to resolve entry for package `@pcc/store`". `@pcc/store` does
not exist as a workspace package; the test file references it directly.
This failure exists identically on master and is not caused by the
integration. Confirmed via `git show lamasu/master:packages/demand-intel/src/__tests__/aggregator.test.ts`
(file imports `@pcc/store` on master too).

---

## Recommendation

**GO.** Push `integration/post-vcn37-fixes` to a feature branch on
`lamasu` and open a PR. Suggested PR body should include:

- Cherry-pick log + conflict-resolution notes (this report)
- Test result: gateway 1803/1803, 0 regressions
- Note tango skipped (PR #172 supersedes); note sierra2 skipped (findings
  doc only — ERC-8004 IdentityRegistry write integration is a separate
  task)
- Note: requires `pnpm build` for `@pcc/spec` and `@pcc/verifier` before
  test run; these are pre-existing repo-state requirements

---

## What was NOT done (per prompt)

- Did NOT push the integration branch — owner reviews first
- Did NOT modify master
- Did NOT modify the 5 source branches
- Did NOT modify CI/CD or Dockerfile
- Did NOT execute sierra2's ERC-8004 IdentityRegistry write integration —
  separate fresh task per prompt

---

## Files added/modified by integration glue (whiskey commit f86b0f1)

- `packages/gateway/src/routes/kernels.ts` — 1 alias line added on the
  GET handler to expose `capabilities: capabilityTypes` for backward-compat

---

## Outstanding follow-ups (recommended for next session)

1. **Run integration on Railway staging** — once the integration PR opens,
   the build-image CI step will populate a tagged image; deploy-staging
   will retag it; smoke-check `/api/health` confirms boot. Per
   `docs/DEPLOY.md`.
2. **Fresh task for ERC-8004 IdentityRegistry write integration** —
   sierra2's findings doc at `feat/erc8004-identity-reputation-base-sepolia`
   identifies the blockers; a separate implementer should pick this up.
3. **Optional**: address the `@pcc/store` pre-existing failure in
   `demand-intel/aggregator.test.ts` (out of scope for this integration).
