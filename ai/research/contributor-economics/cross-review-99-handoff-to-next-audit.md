# Handoff: Context Pack for the Next Cross-Branch Audit

**Written**: 2026-04-29
**Author**: orchestrator (main session of the run that opened PR #7)
**Branch state at write time**: `feat/contributor-economics @ f5a3ca7` (84 commits ahead of local master `8550d5e`)
**PR state at write time**: PR #7 OPEN at https://github.com/LamaSu/physical-capability-cloud/pull/7 — still pointing at our pre-fix HEAD

---

## ⚠ CRITICAL: state will change — but NOT in the way originally framed

**Correction (added post-write)**: When the user said "another agent is fixing
some things," I assumed the parallel agent was on `feat/contributor-economics`
closing the CRITICAL items below. That assumption was **wrong**.

The parallel agent is on a **separate branch** — `feat/agent-onboarder-v2` —
doing SDK + chat console + template registry hardening (`repair-tier1` +
`repair-tier0-routes`). They wrote their own counter-handoff at:

`C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/cross-review-99-handoff-from-agent-onboarder-v2.md`

**Key cross-handoff conclusions** (read their doc for the full matrix):

- **Almost zero file overlap.** Their work is in `packages/orchestrator-sdk/`,
  `packages/template-physical-operator/`, `packages/template-data-product/`,
  `packages/agent-runtime/src/llm-agent.ts`, and `apps/dashboard/src/routes/{onboard,operator,orchestrator}/`.
  None of those overlap with my contracts / spec / CE docs.
- **The CRITICAL items in this doc are still OPEN** — `feat/agent-onboarder-v2`
  does NOT close the multi-stablecoin distribution bug, the agent-package.json
  collision, or the rebase. Those remain `feat/contributor-economics`'s job.
- **`agent-package.json` is the ONE shared file.** Coordination rule:
  *later mover bumps to N+1*. If we land first → 2.9.0/225 (211 base + 7 CVP +
  7 CE); if they land first → we bump to 2.10.0/~235 to absorb their +10 tools.
- **They reserve `MilestoneEscrow` funding-path** (gateway-EOA custody refactor,
  their Wave 4 finding F5). My distribution-path fix (`_distributeWithMap` +
  `_distributeLegacy`) is orthogonal and OK to ship.
- **Both branches can push to lamasu independently.** No fast-forward conflict
  since they're separate refs. Push when ready.

**The "audit again" trigger**: when `feat/agent-onboarder-v2` merges to master
(not just pushes), master's commit graph moves and our rebase target shifts.
That's when re-running cross-review-03 (master recency) is most valuable. Their
branch in-flight on lamasu doesn't directly affect us until merge.

After that agent's branch eventually merges to master:

- HEAD on lamasu/master will move past current
- `agent-package.json` on master may have +10 tools we need to absorb
- Some new TS routes will exist that our work doesn't depend on but should be
  aware of

**Before acting on anything here**, run:
```bash
git fetch lamasu master feat/contributor-economics feat/agent-onboarder-v2
git log --oneline 8550d5e..lamasu/master   # see what's on master since base
git log --oneline f5a3ca7..lamasu/feat/contributor-economics   # see what's on our branch since this doc
git log --oneline lamasu/feat/agent-onboarder-v2 -10  # state of parallel branch
```

Treat this doc as the *findings frame* + the orthogonality matrix from the
counter-handoff, not the current state.

---

## Why this doc exists

The user asked for a cross-branch architectural review before merging
PR #7. I (the prior orchestrator) ran one and wrote
`cross-review-00-synthesis.md`. The user's response: "another agent is fixing
some things, so we will have to do this same audit again after it fixes and
pushes." This doc hydrates the next audit run so it doesn't restart from zero.

---

## What was found (so the next audit knows what to re-verify)

### Critical items (the parallel agent is most likely fixing these)

1. **Multi-stablecoin compatibility bug in `MilestoneEscrow.sol`** —
   `_distributeWithMap` and `_distributeLegacy` hardcode `address(token)`
   (constructor default) and use raw `require(token.transfer(...))`. Master
   moved `release()` to `IERC20(tokenForMilestone(idx)).safeTransfer(...)`.
   Naive merge compiles + passes our tests, but mixed-token escrows
   misroute and USDT escrows revert. **~30 LOC fix + 1 mixed-token Forge
   test.**

2. **`agent-package.json` collision** — both master (CVP) and our branch
   bumped `2.7.0 → 2.8.0` and `211 → 218` for *different* tool sets.
   Correct merged values: `version: "2.9.0"`, `toolCount: 225`, with both
   tool blocks present.

### High items (likely also being addressed)

3. **Rebase PR #7 onto live `lamasu/master`** — master moved 66 commits
   since our base. 5 real conflicts via `git merge-tree`:
   - `MilestoneEscrow.sol` (semantic — item 1)
   - `agent-package.json` (semantic — item 2)
   - `packages/db/src/index.ts` (mechanical — additive both sides)
   - `packages/db/src/schema/index.ts` (mechanical — additive)
   - `packages/mcp-server/src/index.ts` (mechanical — additive)

4. **`MilestoneAdded` event** — master added this event per `addMilestone()`
   call. Our forge tests asserting log shape need updating.

### Medium items (likely *not* in the parallel agent's scope; may still be open)

5. **Wire `captureClass` from CVP into `LicensingEngine`** — master added
   `CaptureClassRegistry`. CaptureClass should affect royalty distribution
   (e.g., `capture-class-indexed` RateSchedule segment kind). ~80 LOC.
   *Likely deferred per user defaults.*

6. **Extract `CanonicalRegistry.sol` shared library** —
   `RateScheduleRegistry` (ours) and `CaptureClassRegistry` (master) both
   implement canonical-JSON → sha256 → bytes32 mapping. ~120 LOC library;
   each consumer becomes ~40 LOC.

7. **Move `ROLE_TAGS` to `@pcc/spec/payouts.ts` with codegen** — today the
   on-chain `bytes32` tag and off-chain TS `keccak256(roleString)` have no
   shared source of truth. Silent drift risk.

### Low items (all small; might be folded into the rebase commit by the parallel agent)

8. ADR-12 §4 paragraph: touchstone fees from digital-verifier fund out of
   the `verifier` bps share.
9. CONTRIBUTOR_ECONOMICS.md note on Pedersen (wave7) vs sha256 (us) future
   compat.
10. AGENT_INTEGRATION.md §12 example: `splitPayout` inside a workflow-runtime
    `ctx.step('release-milestone', ...)`.
11. `arch/open-core-split` ADR-0001 paragraph placing all CE primitives on
    Apache 2.0 side.
12. `erp-patterns/foundation` `endpoint_scopes` migration for our 7 new MCP
    routes (~20 LOC, only if erp-patterns has merged to master).

---

## The 3 questions still open with the user

The original synthesis ended with three questions. The user did **not**
answer them before kicking off the parallel agent, but the agent was
likely briefed with the user's defaults. Re-ask if state has shifted:

| # | Question | Default | Why this might still need an answer |
|---|----------|---------|-------------------------------------|
| 1 | Force-push to PR #7 after rebase? | YES | If PR has any review activity now, force-push is more disruptive. Check `gh pr view 7 --comments` first. |
| 2 | captureClass→LicensingEngine in this PR or follow-up? | DEFER (follow-up) | If the parallel agent already wired it, ignore. Otherwise still relevant. |
| 3 | Extract `CanonicalRegistry.sol` before/after merge? | DEFER (follow-up) | Same as #2. |

---

## What NOT to redo (sunk-cost preservation)

The next audit should NOT re-execute these — their reports are durable:

| Artifact | What it covers | Still valid? |
|----------|---------------|--------------|
| `verify-01-quickstart.md` | Fresh-agent test of `docs/CONTRIBUTOR_ECONOMICS.md` | Yes if doc text unchanged. Re-run if doc was edited by parallel agent. |
| `verify-02-api.md` | Fresh-agent test of `docs/AGENT_INTEGRATION.md` §12 | Yes unless §12 moved or endpoints changed. |
| `verify-03-deploy.md` | Fresh-agent test of `docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` | Yes unless deploy scripts or env vars changed. |
| `verify-04-resume.md` | Fresh-agent test of README + 99-resume-here.md | Worth a re-skim — counts may need updating after rebase. |
| `verify-05-e2e.md` | End-to-end fresh-agent journey | Worth re-running if `MilestoneEscrow.sol` was modified — SEAM-1 (canonical hash) is the kind of bug to recheck. |
| `cross-review-01-merge-conflicts.md` | File-level conflict matrix at write time | **STALE** if rebase happened. Re-run if branch graph moved. |
| `cross-review-02-conceptual.md` | Branch-pair concept alignment | Largely stable; re-skim only if a new branch landed since this. |
| `cross-review-03-master-recency.md` | Master delta vs our base | **STALE** post-rebase. **Re-run first** in any new audit since master moves daily. |

---

## Audit methodology that worked (use it again)

The 3-reviewer pattern was effective. Replicate:

1. **Wave 1 (parallel, 3 agents)**:
   - `review-merge-{X}`: file-level conflict matrix across all sibling
     branches that touch contributor-economics scope. Use
     `git diff --name-only master..<branch>` + `comm -12` for fast intersects.
     Rate severity by file type: `.sol` = CRITICAL, `.ts` same line range = HIGH,
     `.md` = MED, doc-only or different files = LOW.
   - `review-conceptual-{X}`: design-level alignment per relevant branch.
     Read the branch's primary ADR/README. Verdict: ALIGN / EXTEND /
     DUPLICATE / CONTRADICT.
   - `review-master-recency-{X}`: `git fetch lamasu master && git log
     8550d5e..lamasu/master` (or whatever the rebase target is). Categorize
     by area, identify silent-trap conflicts, recommend rebase or not.

2. **Wave 2 (sequential, 1 agent or main session)**:
   - Synthesizer: read all 3 reports + the verify-* reports, write a
     unified punch list with severity + effort estimates + owner.

3. **Output**: write `cross-review-NN-synthesis.md` (next number; current
   is 00) and present the punch list to the user as a numbered fix queue.

**Rate-limit warning**: spawning 4+ parallel agents with sonnet models
hits the Claude Max cap on a busy day (we lost 4 agents to "hit your
limit" mid-run earlier in this branch's life). Three parallel + one
sequential synthesizer is the safe ceiling.

---

## User preferences (confirmed across this branch's history)

These shouldn't change without an explicit user signal:

- **Push convention**: always to `lamasu` remote. Never `origin` (account suspended).
- **Build/test offloading**: Spark for everything heavy (TS builds, full test suite).
  `forge` is **local-only** — Spark does NOT have forge installed.
- **Atomic commits**: Conventional Commits (`feat:` / `fix:` / `docs:` / etc.).
  release-please classifies on master.
- **Scope discipline**: PRs should ship one focused thing. Defer
  extractions and refactors unless they're blocking.
- **Force-push**: OK on feature branches with no review activity; ask first
  if the PR has comments.
- **OEM royalty**: there is no OEM role. Do not reintroduce one.
- **Validator pattern**: run fresh-agent validators on docs to catch friction
  the original authors can't see.
- **Memory + handoff**: explicit handoff docs in `ai/research/...` are
  preferred over implicit context. This file is one of those.

---

## Tactical pointers

### Branch state verification

```bash
cd C:/Users/globa/pcc-contributor-economics
git fetch lamasu master feat/contributor-economics
git rev-parse HEAD  # local
git rev-parse lamasu/feat/contributor-economics  # remote
git log --oneline 8550d5e..HEAD | wc -l  # commit count

# What changed since this doc was written?
git log --oneline f5a3ca7..lamasu/feat/contributor-economics
```

### Test verification (after any rebase or fix)

```bash
# Local forge (Spark doesn't have it):
cd C:/Users/globa/pcc-contributor-economics/packages/contracts
forge build && forge test --match-path 'test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow}*' -vv

# Spark for TS:
spark-run "cd ~/projects/physical-capability-cloud && pnpm --filter @pcc/spec --filter @pcc/contracts --filter @pcc/store --filter @pcc/mcp-server --filter @pcc/gateway test"
```

Expected counts at write time (BEFORE parallel agent's fixes):
- forge: 58 (18 base MilestoneEscrow + 14 splitPayout + 11 RateScheduleRegistry + 15 ContributorNFT)
- @pcc/spec: 379
- @pcc/contracts: 226 (includes 26 buildPayoutMap tests)
- @pcc/store: 143
- @pcc/mcp-server: 34
- @pcc/gateway/contributors: 23

After parallel agent's multi-stablecoin fix, expect at minimum +1 forge
test (mixed-token splitPayout). Tests asserting log count may need
updating for the `MilestoneAdded` event.

### Cross-link integrity

```bash
cd C:/Users/globa/pcc-contributor-economics
# Should return 0 hits in user-facing docs:
grep -rn "49 MCP\|0xYourWallet\|0xMy\.\.\.Address\|@pcc/store" \
  --include="*.md" docs/ README.md 2>&1 | grep -v "ai/research/contributor-economics/verify-"
# (some hits in verify-* validator history are OK — those are immutable reports)
```

### PR state

```bash
gh pr view 7 --repo LamaSu/physical-capability-cloud --json state,mergeable,reviewDecision,comments
```

If `state` ≠ `OPEN` or `mergeable` ≠ `MERGEABLE`, the parallel agent's
work probably already landed.

---

## Files that are durable artifacts

These should remain useful regardless of what the parallel agent does:

| Path | What it is |
|------|-----------|
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/00-plan.md` | Original 5-wave plan. Done. |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/01-royalty-nft-standards.md` | Scout: ERC-721 + ERC-6551 + ERC-2981 + 0xSplits + Drips landscape. |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/02-rate-schedule-dsl.md` | Scout: segment DSL design (Sablier-inspired). |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/03-dataset-model-provenance.md` | Scout: dataset/model attribution research. |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/04-network-forkability.md` | Scout: cross-chain ContributorNFT options. |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/10-adr-licensing-engine-extension.md` | ADR-10 with §0 reconciliation amendment at top. |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/11-adr-splitpayout-contract.md` | ADR-11: Option A chosen for splitPayout. |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md` | ADR-12: 10-role enum + OEM-free thesis. |
| `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/99-resume-here.md` | Wave-by-wave status. May need a final post-merge update. |
| `C:/Users/globa/pcc-contributor-economics/docs/CONTRIBUTOR_ECONOMICS.md` | Front-door 5-min quickstart. |
| `C:/Users/globa/pcc-contributor-economics/docs/AGENT_INTEGRATION.md` | §12 has the API ref. |
| `C:/Users/globa/pcc-contributor-economics/docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` | Testnet deploy runbook. |
| `C:/Users/globa/pcc-contributor-economics/docs/claros-layer4-amendment.md` | Publishable no-OEM thesis. |

---

## Things to communicate to the next audit's subagents

When you spawn the next audit's reviewers, prepend this to their prompts:

> **You are running the second cross-branch audit on `feat/contributor-economics`.**
>
> A previous audit (orchestrator-led, April 29) found 2 critical issues
> (multi-stablecoin compatibility bug + agent-package.json collision) and a
> bunch of medium/low items. A parallel agent has been fixing those.
> Read `ai/research/contributor-economics/cross-review-99-handoff-to-next-audit.md`
> for the full briefing. Then verify what's actually in the current branch
> state — do not assume the previous findings still hold.
>
> Specifically:
> 1. Has `MilestoneEscrow.sol` been refactored to use `tokenForMilestone(idx)
>    + safeTransfer` in `_distributeWithMap` + `_distributeLegacy`?
> 2. Has `agent-package.json` been merged to v2.9.0 with toolCount 225?
> 3. Has the branch been rebased onto `lamasu/master`?
> 4. Are forge tests still 58/58 green (or higher with the new mixed-token test)?
> 5. Has master moved further since 2026-04-29? (re-fetch and check)
>
> Your audit should *complement*, not duplicate, the previous findings.
> Focus on what's NEW since `f5a3ca7`.

When you spawn the synthesizer, prepend:

> **You are the second-audit synthesizer for `feat/contributor-economics`.**
>
> Read these in order:
> 1. `ai/research/contributor-economics/cross-review-99-handoff-to-next-audit.md`
>    (this doc — the previous audit's findings + what to re-verify)
> 2. `ai/research/contributor-economics/cross-review-00-synthesis.md`
>    (the previous audit's punch list — match items off as resolved)
> 3. The 3 second-audit reviewer outputs
>    (cross-review-04, 05, 06 or whatever they're numbered)
>
> Produce a delta synthesis: what was fixed since the first audit, what
> remains, what's *new* (not in the previous synthesis). Recommend whether
> PR #7 is now safe to merge or if another iteration is needed.
> Write to `cross-review-00-synthesis.md` (overwrite the old one, but
> preserve the previous version's hash in your commit message for trace).

---

## Coordination with the parallel agent

- **Don't push** my (orchestrator's) commits to lamasu while the parallel
  agent is working. They'd hit a non-fast-forward error. This handoff
  doc is committed locally only at write time.
- **After they push**, this worktree may be behind lamasu. Run
  `git pull lamasu feat/contributor-economics --rebase` (or fresh checkout)
  before the next audit run. The handoff doc will travel with the rebase.
- **If the parallel agent edits files I also touched** in unrelated commits
  (e.g., the synthesis doc), prefer their version — they're the active
  worker, my context is frozen.

---

## Closing note for the future audit agent

The first audit was thorough but the punch list is now partially obsolete.
Don't waste budget redoing what's already shipped — your job is the *delta*.
If after running the 3 wave-1 reviewers you find that all CRITICAL + HIGH
items are closed and no new conflicts appeared, the synthesis can be a
1-page "PR #7 is now mergeable, here are 4 small follow-ups for the next
sprint" and you're done.

Good hunting.
