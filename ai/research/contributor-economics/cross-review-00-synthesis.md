# Cross-Branch Review Synthesis — Things to Adapt Before/After Merge

**Date**: 2026-04-29
**Synthesizer**: orchestrator (main session)
**Inputs**: cross-review-01-merge-conflicts.md (review-merge-alpha), cross-review-02-conceptual.md (review-conceptual-bravo), cross-review-03-master-recency.md (review-master-recency-charlie)
**Branch state**: feat/contributor-economics @ 7a92346, 84 commits ahead of LOCAL master (8550d5e), but ~150 commits ahead of LIVE lamasu/master
**PR state**: #7 OPEN — see Section 1.

---

## TL;DR

The PR opens cleanly against local master because local master is stale. Live `lamasu/master` has moved 66 commits since our base — including the entire **Capture Verification Protocol** (56 commits, +218 agent-package bump) and the **multi-stablecoin MilestoneEscrow** (PR #5 already merged on lamasu).

There are **2 critical issues**, **3 high-priority adaptations**, **2 extraction opportunities**, and **5 minor doc/migration follow-ups**. The most important one is invisible to the test suite: a naive merge compiles green but silently misroutes funds for non-default-token escrows.

**Recommendation**: don't merge PR #7 until the rebase + 2 critical fixes ship.

---

## 1. CRITICAL — must fix before merge

### 1.1 Refactor `_distributeWithMap` + `_distributeLegacy` to multi-stablecoin

**The bug**: master's `MilestoneEscrow.release()` now uses
`IERC20(tokenForMilestone(idx)).safeTransfer(...)`. Our split-payout helpers
hardcode `address(token)` (the constructor-time default) and use raw
`require(token.transfer(...))` (returns bool, USDT does not).

**Effect after naive 3-way merge**:
- ✅ Compiles green
- ✅ Passes our existing 32 forge tests (they all use the default token)
- ❌ Mixed-token escrows route every recipient to the construction-time default
- ❌ USDT-funded milestones revert outright on `release()` (no bool return)

**Fix scope**: ~30 LOC in `MilestoneEscrow.sol` + 1 new Forge test mixing USDC/USDT in a single milestone with a payout map.

**Owner**: post-rebase implementer.

### 1.2 `agent-package.json` version + tool-count collision

Both branches bump `version: "2.7.0" → "2.8.0"` and `toolCount: 211 → 218` for **completely different tool sets**:
- Master/CVP: added 7 capture-verification tools
- CE: added 7 contributor-economics tools

**Correct merged values**: `version: "2.9.0"`, `toolCount: 225` (211 base + 7 CVP + 7 CE), with both tool blocks in `tools[]`.

A naive auto-merge will pick one set and silently drop the other. The dashboard agent-package endpoint becomes wrong + fresh agents see 7 of 14 new tools.

**Fix scope**: 1 file, ~14 lines, hand-merged.

---

## 2. HIGH — rebase + integration

### 2.1 Rebase PR #7 onto live `lamasu/master`

Master moved 66 commits / 83 files / +19,609 lines since our base. `git merge-tree` reports 5 real conflicts:

| File | Conflict shape | Resolution |
|------|---------------|------------|
| `MilestoneEscrow.sol` | semantic (1.1 above) | Hand-merge + new test |
| `agent-package.json` | semantic (1.2 above) | Hand-merge versions + tools |
| `packages/db/src/index.ts` | mechanical | Add both new exports |
| `packages/db/src/schema/index.ts` | mechanical | Add both new schemas |
| `packages/mcp-server/src/index.ts` | mechanical | Add both tool registration blocks |

**Pre-rebase checklist**:
1. `git branch backup/contributor-economics-pre-rebase feat/contributor-economics`
2. `git fetch lamasu master`
3. `git rebase lamasu/master` (interactive; resolve the 5 conflicts above)
4. Run forge + TS test suites; expect adjustments to event-count assertions (master added `MilestoneAdded` event per `addMilestone`)
5. Force-push to lamasu under PR #7

### 2.2 Wire CVP `captureClass` into `LicensingEngine` (post-merge follow-up)

Master's CVP work added `CaptureClassRegistry.sol` and a `captureClass` field on settlement evidence. Conceptually, the capture class should affect royalty distribution (e.g., higher-fidelity capture classes might warrant higher verifier shares). Today our `LicensingEngine` is unaware.

**Scope**: ~80 LOC in `licensing-engine.ts` to read captureClass off the evidence bundle and feed it into `evaluateRateSchedule(context)` as a new context dimension. Plus a spec extension to RateSchedule to accept `capture-class-indexed` segments.

**Defer to**: separate PR after merge — not blocking.

### 2.3 Adjust event-count assertions in our forge tests

Master added a `MilestoneAdded` event emitted per `addMilestone()`. Our tests that assert log shape may break. ~5-10 test lines to update.

---

## 3. EXTRACTION OPPORTUNITIES — value-positive refactors

These don't block merge but are worth doing in a follow-up PR:

### 3.1 Shared `canonical-registry` utility

`RateScheduleRegistry.sol` and master's `CaptureClassRegistry.sol` both implement the same pattern: canonical-JSON → sha256 → bytes32 → on-chain mapping with `publish(bytes, expectedHash)` + `get(bytes32)` + `exists(bytes32)`. Extract a shared `CanonicalRegistry.sol` library or abstract base contract.

**Scope**: ~120 LOC library, both registries become ~40 LOC each.

### 3.2 Shared `@pcc/spec/payouts` with `bytes32` role-tag constants

Today `ROLE_TAGS` lives only in `packages/contracts/ts/payouts.ts` (TS-side keccak256). The on-chain `MilestoneEscrow.Payout.roleTag` is a `bytes32` that must match. There's no shared source of truth — silent drift risk.

**Fix**: move `ROLE_TAGS` into `@pcc/spec/payouts.ts`, generate matching `.sol` constants via codegen. Both sides stay in sync by construction.

**Scope**: small file move + codegen step.

---

## 4. CONCEPTUAL ALIGNMENT — minor doc/migration follow-ups

### 4.1 `digital-verifier/foundation` (touchstone fees)

Add a paragraph to ADR-12 §4 noting that touchstone fees from digital-verifier fund out of the `verifier` bps share (not a separate role). No code change; clarifies an open question someone WILL ask.

### 4.2 `wave7/verification-commitments`

Add a doc note: schedule hash currently uses sha256 (matching off-chain canonical-JSON). wave7's commitments use Pedersen. They don't conflict (different layers), but flag the future-compat consideration in the schedule-hash section of CONTRIBUTOR_ECONOMICS.md.

### 4.3 `feat/workflow-runtime`

Add an example to AGENT_INTEGRATION.md §12 showing `splitPayout` triggered inside a memoized `ctx.step('release-milestone', ...)` workflow step. Doc-only; no code change.

### 4.4 `arch/open-core-split` ADR-0001 clarification

One paragraph placing all contributor-economics primitives (RateScheduleRegistry, ContributorNFT, MilestoneEscrow.splitPayout, LicensingEngine extension, the 10-role taxonomy) on the Apache 2.0 / open-core side. No proprietary oracle dependency was introduced.

### 4.5 `erp-patterns/foundation` endpoint_scopes migration

If erp-patterns has already merged to master (verify), add ~20 LOC of `endpoint_scopes` rows for our 7 new MCP routes. Probably belongs in our DB migration file, not erp-patterns'.

---

## 5. CONCEPTUAL REVISIONS — bigger picture

### 5.1 Should `splitPayout` be a workflow-runtime step?

**Question**: Currently splitPayout is a direct contract call from the gateway. workflow-runtime offers durable, idempotent step execution with on-chain semantic keys. Should the gateway call splitPayout *through* a workflow run instead?

**Verdict**: ALIGN — keep direct call as v1 (simpler, deterministic, contract-enforced atomicity). Document the workflow-step integration as a v2 option for use cases that need durability beyond on-chain finality (e.g., off-chain payout maps that need to survive multi-day signature collection).

### 5.2 Should ContributorNFT be cross-chain (LayerZero ONFT) or per-network?

**Verdict**: Already deferred in `99-resume-here.md`. Per-network for v1. ONFT wrapper is ~50 LOC when we're ready.

### 5.3 Should the verifier role have a "touchstone fee" mechanism?

**Verdict**: NO for v1. Verifier earns a flat or bps share via standard RateSchedule. Touchstone-fee semantics would couple us to digital-verifier's primitives prematurely. Revisit if/when digital-verifier merges.

### 5.4 Should `CaptureClassRegistry` and `RateScheduleRegistry` use a shared base?

**Verdict**: YES — see 3.1. Post-merge refactor PR.

### 5.5 Are our 7 new MCP tools the right surface?

**Question**: Does the merged 14-tool delta (CVP 7 + CE 7) duplicate anything in the 211 base? Specifically: does CVP have a "register a contributor"-shaped tool we missed, or vice versa?

**Action**: post-merge audit — likely no overlap (CVP is about evidence capture, CE is about who gets paid), but worth a 30-minute pass once both are in master.

---

## 6. Recommended merge order (per review-merge-alpha)

1. **CE rebase** (this PR) — once 1.1 + 1.2 + 2.1 + 2.3 are addressed
2. workflow-runtime (clean)
3. activity-caller-sweep (clean)
4. CVP — wait, already merged on lamasu, skip
5. multi-stablecoin — already merged, skip
6. fix/require-auth — already merged, skip
7. arch/open-core-split (post-CE; needs §4.4 paragraph)
8. wave7/verification-commitments
9. feat/agent-onboarder-v2
10. feat/centralized-substrate
11. mobile/week-1-scaffold
12. digital-verifier/foundation (last, deliberate ABI break)
13. docs/split-operator-rules

Pin a CI `forge build` on every merge candidate to catch silent broken merges. Only CE + digital-verifier regenerate the `MilestoneEscrow.ts` ABI; the other 5 contract-modifying branches ship the stale master ABI and will silently skip the ABI re-export.

---

## 7. Punch list (ordered, with effort estimates)

| # | Item | Severity | Effort | Owner |
|---|------|----------|--------|-------|
| 1 | Refactor `_distributeWithMap` + `_distributeLegacy` to use `tokenForMilestone(idx) + safeTransfer` | CRITICAL | 1 hr (~30 LOC + test) | One impl-fix agent |
| 2 | Hand-merge `agent-package.json` to v2.9.0 / 225 tools / both tool sets | CRITICAL | 15 min | Manual or agent |
| 3 | Rebase CE branch onto `lamasu/master`, resolve 5 conflicts | HIGH | 30 min | Manual (must own merge decisions) |
| 4 | Adjust forge tests for new `MilestoneAdded` event | HIGH | 15 min | Same agent as #1 |
| 5 | Force-push rebased branch to PR #7 | HIGH | 5 min | Manual |
| 6 | Wire CVP `captureClass` into LicensingEngine | MED | ~3 hr | Separate PR after merge |
| 7 | Extract `CanonicalRegistry.sol` library (CE + CVP share) | MED | ~2 hr | Separate PR after merge |
| 8 | Move `ROLE_TAGS` to `@pcc/spec/payouts.ts` + codegen | MED | ~1 hr | Separate PR after merge |
| 9 | ADR-12 §4 touchstone-fees paragraph | LOW | 10 min | Same rebase commit |
| 10 | wave7 Pedersen-vs-sha256 doc note | LOW | 5 min | Same rebase commit |
| 11 | workflow-runtime example in AGENT_INTEGRATION §12 | LOW | 15 min | Same rebase commit |
| 12 | open-core-split ADR-0001 paragraph | LOW | 10 min | Same rebase commit |
| 13 | erp-patterns endpoint_scopes migration (if applicable) | LOW | 30 min | Same rebase commit |

**Critical path before merge**: items 1 + 2 + 3 + 4 + 5. Estimated 2 hours of focused work.

---

## 8. Open questions for the user

Before kicking off the rebase + fix wave, three questions:

1. **Are you OK with a force-push to PR #7's branch after rebase?** The PR is fresh (just opened), no review comments yet, so this is low-risk — but it does invalidate any link/reference to the current PR diff.
2. **Should the captureClass → LicensingEngine integration (item 6) ship in this PR or a follow-up?** Including it makes the PR 80 LOC bigger but ships a cleaner story; deferring keeps the PR scope tight.
3. **Should we extract `CanonicalRegistry.sol` (item 7) before or after the merge?** Before = clean code from day 1, but blocks merge another ~2 hr. After = ship now, refactor next sprint.

My defaults if you don't specify:
- Q1: yes, force-push (it's our branch and the PR is hours old)
- Q2: defer captureClass to a follow-up PR (keeps scope tight; also lets the captureClass primitive bake on master a bit more before we couple to it)
- Q3: defer extraction to a follow-up PR
