# Master Recency Review (since 8550d5e)

**Reviewer**: review-master-recency-charlie
**Date**: 2026-04-29
**Base**: `8550d5e` (`feat/contributor-economics` branched here)
**Master HEAD**: `771eb4a956b67bf8ca5810d757bc07547af7bd25` ("fix(gateway): requireAuth passes through when apiGate set userId (#6)")
**Our HEAD**: `1c323bf94143587531a44ec50db76dc8a5eda922` (84 commits ahead of base)
**Master delta**: 66 commits, 83 files, +19,609 / -87 lines

---

## New commits on master (since base)

Three large feature streams, plus housekeeping.

### A. Capture Verification Protocol (CVP) — 56 commits, the dominant feature

The vast majority of post-base master work is CVP, shipping in waves. Excerpts grouped by area:

**Spec / types** (4 commits)
- `5c7f29a` docs(capture): master design doc — CVP classes CC0-CC5, detection, verification, on-chain protocol
- `453f842` add CaptureClass + multipliers + CaptureManifest Zod schema
- `8dbebd8` extend SessionAction with `capture_submit`
- `8f6c861` add 7 `capture_*` EvidenceEventType values
- `37bde07` export capture types from spec barrel

**Verifier package** (10+ commits)
- `15fc217` add `issueCaptureNonce` + `verifyCaptureNonce`
- `3802c00` wire `captureClass` multiplier into `computeAssuranceScore` formula
- `68433c1` extend `challenge-service` + `assurance-score` tests for CVP
- `5858642` + `76e948e` add `CaptureDetector` 6-pass pipeline + tests
- `0bc510a` add `CaptureVerifier` orchestrator (G1-G6 gate structure)
- `ca639ad` 47-case test suite across G1-G6
- 4 real adapter wrappers: PlayIntegrity, AppAttest, WebAuthn, C2PA

**Gateway** (8 commits)
- `b45b246` add CVP capture routes + drizzle schema + zod dep
- `720556c` register `captureRoutes` in `server.ts`
- `4f3f770` extend `OperatorPolicy` with `minCaptureClass` + `requireAnchor`
- `cb12f48` add capture-policy gate to `job-submit`
- `c11fea8` capture route + 35-test policy suite
- `888d0a0` `computeAlcoaWithCapture` — cross-facade ALCOA+ wiring (alcoa-lima)
- `4118e79` add `captureVerification` to `ComplianceReportDTO`

**MCP server** (3 commits)
- `02b67eb` add 7 capture MCP tool definitions
- `0e1db25` add capture thin query routes for MCP backing
- `c85ddf4` add `capture-tools.test.ts` — 12 tests

**DB** (3 commits)
- `bec5429` `findCaptureVerdictsByJob` repo method
- `ddf2cb8` `capture_verdicts` + `capture_anchors` migrations
- inline migration in `migrate.ts`

**Contracts** (3 commits)
- `136abd8` `CaptureClassRegistry.sol` for CVP on-chain anchor
- `5172c78` 27-test Foundry suite
- `2f0915d` deploy `CaptureClassRegistry` to Base Sepolia → `0xAaB3F94f...A66`

**UI** (5 commits)
- `4633712` `SensorFusion` adapter for CVP trace collection
- `aee74e2` `VisualNonceRenderer` + qrcode dep
- `624be91` `CaptureFlow` + `FaceLandmarker` build fix
- `cb6e5b4` `capture/index.ts` barrel

**Docs** (3 commits)
- `74deba6` add `CAPTURE_CLASSES.md` reference
- `ca26fe2` add `CAPTURE_VERIFICATION.md` operator guide
- `02eb62b` link CVP docs from README

**Agent package** (1 commit)
- `83adf26` regenerate `agent-package.json` 211→218 tools (add 7 CVP tools, version 2.7.0→2.8.0)

### B. Multi-stablecoin escrow (PR #5, merged) — 6 commits

- `8a34622` `feat(contracts): add SafeERC20 library for non-compliant ERC-20 tokens`
- `7efd4e1` `feat(contracts): multi-stablecoin MilestoneEscrow with reserve attestations`
- `3514426` `test(contracts): multi-stablecoin escrow test suite + token mocks`
- `6946de0` `chore(scripts): allow/revoke stablecoin operator scripts`
- `2d63ae4` `test(contracts): declare events locally for vm.expectEmit matching`
- `807cd5c` `Merge pull request #5 from LamaSu/feat/multi-stablecoin-escrow`

### C. requireAuth fix (PR #6, latest) — 1 commit

- `771eb4a` `fix(gateway): requireAuth passes through when apiGate set userId (#6)`

### D. Housekeeping (3 commits)

- `8061c67` `ci: drop pnpm/action-setup version arg (pm-from-package-json)`
- `c7cfca2` / `6b26031` / `4e8c3c1` supervisor pipeline-state markers
- `946cbef` add CVP end-to-end smoke test script

---

## File-level conflict potential

11 files touched by both branches. `git merge-tree --write-tree --merge-base=8550d5e lamasu/master feat/contributor-economics` reports **5 real conflicts** + 6 clean auto-merges.

| File | Severity | Note |
|------|----------|------|
| **`apps/dashboard/public/agent-package.json`** | **CRITICAL** | Both bump version `2.7.0→2.8.0` and toolCount `211→218`, both edit `system_prompt`, both insert tool entries at line 5513. Numbers ALSO disagree semantically — true correct merged count is `211 + 7 (CVP) + 7 (contributor) = 225`, version should be `2.9.0`. Cannot auto-resolve. |
| **`packages/contracts/src/MilestoneEscrow.sol`** | **CRITICAL** | Both massively rewrite the same lines: master adds `SafeERC20`+`tokenOf[]`+per-token `fund()`+`tokenForMilestone()` and inlines safeTransfer in `release()`; ours adds `Payout[]`+`_payoutMap`+splits `release()` into `_distributeLegacy`/`_distributeWithMap`. Hunks overlap at struct list, state vars, events, modifiers, `addMilestone`, `fund`, `release`, `fileDispute`. Even if 3-way merge succeeds, our `_distributeWithMap` uses `token.transfer()` directly — would silently break multi-stablecoin for split-payout milestones. **Requires manual rewrite.** |
| **`packages/db/src/index.ts`** | MEDIUM | Both add to the same `export type {…}` block (master adds `CaptureVerdictRow`, we add 5 contributor types) and both bump the `drizzle-orm` re-export. Adjacent lines — git auto-merge usually wins this but conflict was reported. Easy manual resolution. |
| **`packages/db/src/schema/index.ts`** | LOW | Both append a new `export * from "./<name>.js"` line. Reported as conflict only because both touch the final line. Trivial manual fix. |
| **`packages/mcp-server/src/index.ts`** | MEDIUM | Master inserts `registerCaptureTools(server)` at line 1227 (~8 lines); we insert ~234 lines of new tools at the same spot. Also we modified `pcc_ip_set_splits` (line 1009-1078) to widen its role enum — unique to us. Adjacent insertions are usually mergeable but git flagged it. |
| `.gitignore` | trivial | Different lines, auto-merge OK |
| `README.md` | trivial | Different paragraphs added, auto-merge OK |
| `packages/db/src/interfaces/index.ts` | trivial | Different line ranges, auto-merge OK |
| `packages/db/src/migrate.ts` | trivial | Master inserts inside an existing `sqlite.exec(...)` at L1306; we add a new `sqlite.exec` after it at L1308. Adjacent — auto-merge OK. |
| `packages/gateway/src/server.ts` | trivial | Different import lines (22 vs 52) and registration lines (319 vs 351), auto-merge OK |
| `packages/spec/src/types/index.ts` | trivial | We add at line 36-39, master adds at line 6 — different regions, auto-merge OK |

Master also added 72 brand-new files we don't touch (CVP packages, capture mocks, deploy artifacts, multi-stablecoin tests). No conflict — they just appear post-merge.

---

## Conceptual additions we should account for

These aren't file conflicts, they're things master added that our branch arguably **should** know about.

### 1. `SafeERC20` library exists now and our payout transfers should use it

Master added `packages/contracts/src/libraries/SafeERC20.sol` and uses `tok.safeTransfer(...)` everywhere it previously used `require(token.transfer(...))`. Our `_distributeLegacy` and `_distributeWithMap` use the old `require(token.transfer(...))` pattern. After merge:
- Compatible with the master code, but inconsistent
- USDT and similar non-compliant tokens would silently fail in our split paths
- **Action**: rewrite both `_distribute*` helpers to use `using SafeERC20 for IERC20` + `tok.safeTransfer(...)`

### 2. Per-milestone token override changes the assumption "one escrow = one token"

Master added `mapping(uint256 => address) tokenOf` and `tokenForMilestone(idx)`. Our splitPayout currently hardcodes `address tokenAddr = address(token)` in `_distributeWithMap`. After merge, a payer could create one escrow with USDC milestones AND USDT milestones with split-payout maps — and each split would silently route in the WRONG token. **Action**: replace `address(token)` with `tokenForMilestone(milestoneIndex)` in `_distributeWithMap` and emit the actual settlement token in `SplitPayoutExecuted`.

### 3. CaptureClass now feeds AssuranceScore — settlement-time hook for us

`computeAssuranceScore` (in `@pcc/verifier`) now accepts `captureClass?: CaptureClass`, multiplying the final score by `CAPTURE_CLASS_MULTIPLIERS[class]` (CC0=0.70 → CC5=1.05). Our LicensingEngine + RateSchedule evaluation is the natural consumer — a CC0 capture should arguably reduce the protocol-author/integrator share OR refuse settlement under `OperatorPolicy.requireAnchor`. **Action (post-merge, follow-up PR)**: thread `captureClass` from settlement evidence into `LicensingEngine.split(...)` so contributors paid via `splitPayout()` see a class-weighted distribution. Not blocking for this PR.

### 4. New `EvidenceEventType` values

Master added 7 `capture_*` events to the `EvidenceEventType` enum in `packages/spec/src/types/evidence.ts`. Our gateway routes (`POST /api/contributors/schedules`, etc.) emit no evidence events, so this is a no-op for us. Worth knowing for our `pcc_schedule_publish` MCP tool — we may eventually want a `schedule_published` or `composition_committed` event for ALCOA+ compliance, mirroring how master added a per-stage event vocabulary.

### 5. ContributorRole vs canonical role enum — minor harmonization

We widened `StoryRoyaltySplit.role` from 5 values to 11 (the new `ContributorRole` union). Master did NOT touch story.ts. **No conflict**, but if anyone on master adds a new role independently we could clash. Worth a one-liner in our `12-adr-role-taxonomy-and-no-oem.md` saying "this role union owns role names; CVP `EvidenceEventType` is orthogonal."

### 6. PR #6 (requireAuth API-key passthrough) is RELEVANT to us

Our `contributorRoutes` in `packages/gateway/src/routes/contributors.ts` are currently unauthenticated (no `preHandler: requireAuth`). If we ever do add `requireAuth`, the post-PR-6 behavior is correct: agents calling with `Authorization: Bearer pcc_live_*` won't be 401'd just because they lack a SIWE cookie. **No conflict** but this fix supports a future hardening pass on our endpoints.

### 7. `OperatorPolicy.minCaptureClass` + `requireAnchor`

Master added two fields to `OperatorPolicy`. Our work doesn't read OperatorPolicy. No conflict, but it changes the kernel-side policy surface — when we add per-contributor policy gates someday, we should consider whether the policy is keyed by capture class too.

---

## Backward-compat surprises

Things master changed where our branch's assumptions might be off the old shape:

1. **`MilestoneEscrow.fund()` now reverts on fee-on-transfer tokens.** Our splitPayout test suite (`MilestoneEscrow.splitPayout.t.sol`) uses `MockUSDC` which is compliant — fine. But `setPayoutMap()` should arguably refuse a `Payout` recipient that is itself a fee-on-transfer contract, since the receiver could short the operator residual. Not currently checked. Minor note for follow-up.

2. **`MilestoneAdded` event is now emitted by `addMilestone`.** Master added an event we never had. Our test suites that snapshot `vm.recordLogs()` and assert specific event counts will see ONE EXTRA event per milestone. Need to bump expected log counts in our tests, or use `vm.expectEmit` for our specific events.

3. **`token.transfer` calls were converted to `safeTransfer` everywhere on master.** If we 3-way merge naively, our `_distributeWithMap` is the only place left in the file that still uses raw `require(token.transfer(...))`. Slither/audit tools would flag this as inconsistent. Fix is mechanical.

4. **`@pcc/verifier` `computeAssuranceScore` signature changed.** Added optional `captureClass`. Existing callers that pass a positional object are fine (it's optional). Our LicensingEngine doesn't call this today, but `licensing-engine.ts` is one obvious place to wire it post-merge.

5. **`pnpm-lock.yaml` exploded by ~750 lines on master.** Our branch has zero lockfile change despite adding new package internals. Post-merge, after `pnpm install` we'll see hash drift on the lockfile — needs a clean `pnpm install` after merge to re-lock dependencies. Not a real conflict but a CI gotcha.

6. **`@pcc/spec` exports `CaptureClass` + `CAPTURE_CLASS_MULTIPLIERS`.** Our `payouts.ts` and `licensing-engine.ts` are the natural consumers but don't import them yet. Post-merge follow-up.

7. **`CaptureClassRegistry` is deployed at `0xAaB3F94f...A66` on Base Sepolia.** Our deployment script `DeployContributorEconomics.s.sol` does NOT depend on this — the contracts are fully independent. Good.

---

## Recommended action

- [ ] Merge as-is (master moved minimally)
- [x] **Rebase before merging (master moved meaningfully)**
- [ ] Hold the PR pending other branch merges first

### Why rebase, not merge-as-is

Three of the five conflicts are non-trivial to manually resolve, and at least two have **silent semantic correctness issues** that 3-way merge will not catch:

1. **`MilestoneEscrow.sol`** — Our `_distributeWithMap` uses `token` (default) and raw `require(token.transfer(...))`. Both wrong post-merge. Compiles fine, tests for split-payout still pass (they use the default token), but ANY split-payout milestone in a non-default token silently routes the wrong currency. This is a **subtle settlement bug** that would survive review and break in production. Has to be hand-rewritten during rebase.
2. **`agent-package.json`** — Numbers and version cannot both win. The correct post-merge state is `version: "2.9.0"`, `toolCount: 225` (CVP 7 + contributor 7 + base 211), with both prompt sections concatenated and tool arrays merged. Auto-merge will produce duplicate version-key chaos.
3. **`mcp-server/src/index.ts`** — Two adjacent insertions at the same line. Mergeable, but easier to rebase and re-add deliberately.

The other 8 files (`db/index.ts`, `db/schema/index.ts`, `db/interfaces/index.ts`, `db/migrate.ts`, `gateway/server.ts`, `spec/types/index.ts`, `.gitignore`, `README.md`) all auto-merge cleanly OR are trivial to resolve.

### Concrete rebase plan

1. Branch a recovery point: `git branch backup/contributor-economics-pre-rebase feat/contributor-economics`
2. `git rebase lamasu/master`
3. Hand-resolve the 3 critical files:
   - **MilestoneEscrow.sol**: keep the splitPayout dispatch; rewrite `_distributeLegacy` and `_distributeWithMap` to (a) use `IERC20 tok = IERC20(tokenForMilestone(milestoneIndex))` and (b) call `tok.safeTransfer(...)`. Update `setPayoutMap` to validate `payoutMapSet` against the milestone's actual token if needed.
   - **agent-package.json**: bump to `version: "2.9.0"`, `toolCount: 225`, splice both system-prompt sections (CVP and Contributor Economics under their own ### headers), splice both tool blocks at the same insertion point.
   - **mcp-server/src/index.ts**: keep our `pcc_ip_set_splits` widening + 234 lines of contributor tools; ALSO add master's `import { registerCaptureTools }` and the `registerCaptureTools(server)` call.
4. Run targeted suites:
   - `forge test --match-path packages/contracts/test/MilestoneEscrow.splitPayout.t.sol`
   - `forge test --match-path packages/contracts/test/MilestoneEscrow.multistable.t.sol` (will need updates if MilestoneAdded event changes count)
   - `pnpm -F @pcc/spec test`
   - `pnpm -F @pcc/store test` (db migrations test both contributor + capture tables init)
   - `pnpm -F @pcc/gateway test -- contributors.test capture.test`
   - `pnpm -F @pcc/mcp-server test`
5. After contracts pass, run `pnpm install` to re-lock, then verify the `apps/dashboard/public/agent-package.json` against the live MCP `tools/list`.
6. Force-push the rebased branch (it's a feature branch, force-push is acceptable).
7. **Add a follow-up TODO**: thread `captureClass` from settlement evidence into `LicensingEngine` (per "Conceptual additions" §3) — separate PR, post-merge.

### Why not "hold pending other branches"

There is no other in-flight branch we know of that would change the conflict surface. The two recent merges (PR #5 multi-stablecoin and PR #6 requireAuth) are already on master. Holding gains nothing.

---

## Bottom line

Master moved meaningfully — 66 commits across 83 files, including a major contracts refactor (multi-stablecoin + SafeERC20) that overlaps directly with our `MilestoneEscrow.splitPayout` rewrite, plus a 218-tool agent-package version bump that collides with ours. Five files have real merge conflicts and two of them (MilestoneEscrow.sol, agent-package.json) require careful hand-resolution because naive 3-way merge produces silently incorrect output: split-payout milestones could settle in the wrong currency, and the agent-package version/toolCount fields cannot both win. Rebase before merging the PR. Plan above; budget ~2-3 hours to rebase, hand-resolve, and re-run targeted test suites. After rebase, file a follow-up to consume `captureClass` in `LicensingEngine` so the two systems compose at settlement time.
