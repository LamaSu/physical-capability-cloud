# Cross-Branch Merge Conflict Analysis

**Reviewer**: review-merge-alpha
**Date**: 2026-04-29
**Base branch**: `feat/contributor-economics` @ `1c323bf9` (master @ `8550d5ec`)

## Executive Summary

`feat/contributor-economics` (CE) is mergeable into `master` cleanly today — master is the merge-base and CE has no upstream conflicts. The complications arrive AFTER CE merges, when the other ten branches need to land. **Eight of those ten branches are descendants of a shared "substrate" cluster** rooted at `0443a33` (`fix/require-auth-api-key-passthrough`), which is itself a descendant of `feat/multi-stablecoin-escrow` and `capture-verification-protocol`. They all carry the SAME copy of CVP + multi-stablecoin work, so once you resolve those once, the resolution applies to most of the rest.

**The CRITICAL finding**: when CE merges with `feat/multi-stablecoin-escrow` (or any of its descendants — `agent-onboarder-v2`, `centralized-substrate`, `mobile/week-1-scaffold`, `fix/require-auth-api-key-passthrough`), `git merge-tree` produces a **silently-broken auto-merge**. The merged `MilestoneEscrow.sol` declares a local `IERC20 tok` in `release()`, then calls `_distributeLegacy` / `_distributeWithMap` (CE's helpers) which reference `tok` even though it isn't passed as an argument or visible in their scope. **The contract will not compile.** This needs an explicit hand-merge; do NOT trust the auto-merge.

---

## 1. Conflict Matrix

Severity rubric: **CRITICAL** = silently-broken auto-merge OR breaking ABI signature change; **HIGH** = real conflict markers in code files; **MED** = real conflict markers only in JSON/docs; **LOW** = no conflicts via `git merge-tree`.

| Branch | Commits | Files in tree intersection | Real conflict markers | Severity | Notes |
|--------|---------|---------------------------|----------------------|----------|-------|
| `feat/agent-onboarder-v2` | 75 | 11 | **5** (MilestoneEscrow.sol, db/index.ts, db/schema/index.ts, mcp-server/src/index.ts, agent-package.json) | **CRITICAL** | Inherits multi-stablecoin → silent broken `release()` |
| `feat/centralized-substrate` | 71 | 11 | **5** (same 5) | **CRITICAL** | Inherits multi-stablecoin + adds settleCentralized; same broken release() |
| `arch/open-core-split` | 67 | 10 | **4** (db/index.ts, db/schema/index.ts, mcp-server/src/index.ts, agent-package.json) | **HIGH** | No MilestoneEscrow.sol diff; pure CVP + open-core split |
| `wave7/verification-commitments` | 64 | 10 | **4** (same 4 as arch/open-core) | **HIGH** | CVP descendant + verification scheme contracts |
| `feat/multi-stablecoin-escrow` | 64 | 11 | **5** (same 5 as agent-onboarder) | **CRITICAL** | The substrate root for the broken-release-merge problem |
| `capture-verification-protocol` | 59 | 10 | **4** (same 4 as arch/open-core) | **HIGH** | NOT yet in master (59 commits ahead). Substrate ancestor of 7 other branches |
| `digital-verifier/foundation` | 23 | 4 | **1** (MilestoneEscrow.sol) | **CRITICAL** | Breaks `release()` and `submitAttestation()` ABI — adds `IPCCOracle.Attestation` parameter |
| `feat/workflow-runtime` | 22 | 1 | **0** | **LOW** | CLAUDE.md addition at line 94, CE edits lines 828+. Non-overlapping. Clean merge. |
| `fix/activity-caller-sweep` | 23 | 1 | **0** | **LOW** | Strict descendant of feat/workflow-runtime; same CLAUDE.md, plus more. Clean merge. |
| `docs/split-operator-rules` | 27 | 6 | **4** (CLAUDE.md, docs/AGENT_INTEGRATION.md add/add, docs/DEPLOY.md add/add, MilestoneEscrow.sol) | **HIGH** | Branched from `791d5bd5`, NOT the standard substrate. AGENT_INTEGRATION.md is duplicate-named with our copy (we already pulled it in). |
| `mobile/week-1-scaffold` | 75 | 11 | **5** (same 5 as agent-onboarder) | **CRITICAL** | Inherits multi-stablecoin → silent broken release(); plus large `apps/mobile/` additions |
| `fix/require-auth-api-key-passthrough` | 66 | 11 | **5** (same 5 as agent-onboarder) | **CRITICAL** | Substrate root (multi-stablecoin + CVP merged) + auth bug fix |

**Total**: 5 CRITICAL, 4 HIGH, 1 MED (none — all docs cases are bundled with other conflicts), 2 LOW.

### Repeat-pattern observation

The 11-file intersection seen in 6 branches is identical because **these 6 branches all share a common ancestor at `0443a33` (fix/require-auth-api-key-passthrough)** which itself contains `feat/multi-stablecoin-escrow` + `capture-verification-protocol`. Since CE was branched from master BEFORE that merge, every CE↔descendant comparison surfaces the same 11-file delta:

```
Substrate root (0443a33) = master + multi-stablecoin + CVP + auth fix
├── feat/agent-onboarder-v2  (75c on top)
├── feat/centralized-substrate  (71c on top)
├── arch/open-core-split  (67c on top)
├── wave7/verification-commitments  (64c on top)
├── mobile/week-1-scaffold  (75c on top)
└── fix/require-auth-api-key-passthrough  ≡ root (66c)
```

The 4-file vs 5-file split: the 5-file branches are descendants of `feat/multi-stablecoin-escrow` (which touches MilestoneEscrow.sol), the 4-file branches descend from `capture-verification-protocol` only (which does NOT touch MilestoneEscrow.sol).

---

## 2. MilestoneEscrow.sol Deep-Dive

### CE's additions (master → CE)

CE adds **226 lines** (master 445 → CE 662). Net additions:

- `struct Payout { address recipient; bytes32 roleTag; bytes32 ipId; uint16 bps; }` (new struct)
- `mapping(uint256 => Payout[]) private _payoutMap`, `mapping(uint256 => bool) public payoutMapSet`
- Constants `MAX_PAYOUTS = 16`, `MAX_SINGLE_BPS = 5000`
- Events `PayoutMapSet`, `SplitPayoutExecuted`
- Functions `setPayoutMap()`, `getPayoutMap()`, internal `_distributeLegacy()`, internal `_distributeWithMap()`
- `release()` body refactored: branches on `payoutMapSet[idx]` and dispatches to one of the two helpers

**Touch sites in `release()`**: lines 306-323 in master (the entire `release()` body). CE replaces the inline transfer logic with an `if/else` dispatcher.

### Three distinct other-branch versions of MilestoneEscrow.sol

Among the 7 branches that touch MilestoneEscrow.sol, only **3 distinct versions** exist (verified by content hash):

| Hash | Branches | Content |
|------|----------|---------|
| `582c4f04...` | `feat/multi-stablecoin-escrow`, `feat/agent-onboarder-v2`, `mobile/week-1-scaffold`, `fix/require-auth-api-key-passthrough` | "multi-stablecoin variant" |
| `5d79acc4...` | `feat/centralized-substrate` | "multi-stablecoin + settleCentralized variant" (superset) |
| `be2808cd...` | `digital-verifier/foundation`, `docs/split-operator-rules` | "oracle-attestation variant" (signature-breaking) |

#### Version 1 — multi-stablecoin variant (4 branches)

`master..feat/multi-stablecoin-escrow` adds **295 lines** (445 → 740). Net additions:

- `struct ReserveAttestation { ... }` for stablecoin allowlist metadata
- `mapping(address => ReserveAttestation) public reserves`
- `address[] private _reserveTokens`, `mapping(uint256 => address) public tokenOf`, `mapping(address => uint256) public totalByToken`
- Events `StablecoinAllowed`, `StablecoinRevoked`, `MilestoneAdded`
- Functions `allowStablecoin()`, `revokeStablecoin()`, `isStablecoinAllowed()`, `getReserveTokens()`, `tokenForMilestone()`, `addMilestoneWithToken()`, internal `_addMilestone()`, internal `_pullToken()`
- `release()` MODIFIED in place: declares `IERC20 tok = IERC20(tokenForMilestone(milestoneIndex))` and replaces every `token.transfer/transferFrom` with `tok.safeTransfer/safeTransferFrom`
- `depositBond()` MODIFIED: same `tok` substitution
- `fileDispute()`, `resolveDispute()`: same `tok` substitution

**The conflict with CE in `release()`**:

```solidity
// MASTER (line ~327)
emit MilestoneReleased(milestoneIndex, operator, amount);
if (protocolRoot != address(0)) {
    ...
    require(token.transfer(recipient, fee), "Fee transfer failed");
    ...
}

// CE
emit MilestoneReleased(milestoneIndex, operator, amount);
if (payoutMapSet[milestoneIndex]) {
    _distributeWithMap(milestoneIndex, amount, operator, operatorBond);
} else {
    _distributeLegacy(amount, operator, operatorBond);
}

// MULTI-STABLECOIN
IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));
emit MilestoneReleased(milestoneIndex, operator, amount);
if (protocolRoot != address(0)) {
    ...
    tok.safeTransfer(recipient, fee);
    ...
}
```

**Auto-merge result (verified via `git merge-tree`)**: Git takes the substrate's `IERC20 tok = ...` declaration AND CE's dispatcher. The result:

```solidity
function release(uint256 milestoneIndex) external nonReentrant ... {
    ...
    address operator = m.operator;
    uint256 amount = m.amount;
    uint256 operatorBond = m.operatorBond;
    IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));   // FROM SUBSTRATE
    emit MilestoneReleased(...);
    if (payoutMapSet[milestoneIndex]) {                        // FROM CE
        _distributeWithMap(milestoneIndex, amount, operator, operatorBond);
    } else {
        _distributeLegacy(amount, operator, operatorBond);
    }
}

function _distributeLegacy(uint256 amount, address operator, uint256 operatorBond) internal {
    if (protocolRoot != address(0)) {
        ...
        tok.safeTransfer(recipient, fee);    // ← `tok` IS UNDEFINED HERE
        ...
    }
}
```

**`_distributeLegacy` references `tok`, which is not in scope.** Helper code came from CE (no `tok` because CE used global `token`), but the body got "auto-fixed" by the substrate's `s/token.transfer/tok.safeTransfer/g` replacements. The contract will not compile.

**Resolution required**: rewrite both helpers to either (a) accept `IERC20 tok` as a parameter, or (b) re-derive it locally via `IERC20(tokenForMilestone(milestoneIndex))`. Cleaner is (a):

```solidity
function _distributeLegacy(IERC20 tok, uint256 amount, address operator, uint256 operatorBond) internal {
    ...
    tok.safeTransfer(recipient, fee);
    ...
    root.collectFee(address(tok), fee);
    ...
}
```

This is **invasive**, not additive.

#### Version 2 — centralized-substrate variant (1 branch)

Strict superset of multi-stablecoin variant + adds:

- `enum SettlementMode { OnChain, Centralized }`
- `mapping(uint256 => bool) public centrallySettled`
- `event MilestoneSettled(uint256 idx, SettlementMode mode, address payer, address operator, uint256 amount, bytes32 receiptHash)`
- `function settleCentralized(uint256 milestoneIndex, address operator, uint256 amount, bytes32 receiptHash) external onlyPayer`

**Conflicts with CE**: same broken-merge in `release()` as multi-stablecoin (carries the substrate problem forward), PLUS:

- `release()` and `settleCentralized()` are mutually-exclusive paths. CE's splitPayout assumes on-chain release. There's no logic conflict — CE and centralized-substrate compose cleanly *conceptually* (split payouts only fire on the on-chain release path; centralized is a one-shot payer-attested settlement). But the file-level merge carries the same `tok` scope bug.

#### Version 3 — oracle-attestation variant (digital-verifier + docs/split-operator-rules)

**This is the ABI-breaking branch.** Diff vs master:

```solidity
// BEFORE (master)
function submitAttestation(uint256 milestoneIndex, bytes32 _attestationHash) external ...
function release(uint256 milestoneIndex) external nonReentrant ...

// AFTER (digital-verifier)
function submitAttestation(uint256 milestoneIndex, IPCCOracle.Attestation calldata attestation) external ...
function release(uint256 milestoneIndex, IPCCOracle.Attestation calldata attestation) external nonReentrant ...
```

These are **breaking signature changes**. Every caller — gateway routes, agent-package tools, MCP server, dashboard SplitEditor, integration tests — must change. This branch already updates them in its tree.

**Conflict with CE**: `git merge-tree` produces ONE conflict marker (the `release()` doc-comment block, lines 464-506 in merged result). Git AUTO-MERGES the function signature itself (silently choosing digital-verifier's), so CE's existing `release(uint256 milestoneIndex)` callers will break at compile time. Tests that call `escrow.release(0)` will need to be updated to `escrow.release(0, attestation)`.

**Resolution required**: choose ABI direction. If digital-verifier wins, ALL of CE's tests, docs, ABI consumers, and the agent-package need updating. If CE wins, digital-verifier's oracle-gating goes away. Most likely you want digital-verifier's ABI on top of CE's split-payout logic — meaning the FINAL `release()` is:

```solidity
function release(uint256 milestoneIndex, IPCCOracle.Attestation calldata attestation) external nonReentrant ... {
    require(keccak256(abi.encode(attestation)) == m.verifierAttestationHash, "Attestation mismatch");
    // ... CEI ...
    emit MilestoneReleased(...);
    if (payoutMapSet[milestoneIndex]) {
        _distributeWithMap(milestoneIndex, amount, operator, operatorBond, attestation);  // pass through to collectFeeWithAttestation
    } else {
        _distributeLegacy(amount, operator, operatorBond, attestation);
    }
}
```

Both `_distributeLegacy` and `_distributeWithMap` need the `attestation` parameter to call `root.collectFeeWithAttestation(token, fee, attestation)`. This is a hand-merge.

#### Version 4 — branches with no MilestoneEscrow change

`capture-verification-protocol`, `arch/open-core-split`, `wave7/verification-commitments`, `feat/workflow-runtime`, `fix/activity-caller-sweep` — all touch zero lines of MilestoneEscrow.sol. CVP only adds new `packages/verifier/` files; arch/open-core-split inherits CVP and adds an open-core split + license-scan; wave7 adds new contracts (`VerificationSchemeRegistry.sol`, `IVerificationScheme.sol`) but doesn't modify the escrow.

---

## 3. ABI / Type Drift

Comparing `packages/contracts/ts/abi/MilestoneEscrow.ts` across all branches:

| Branch | ABI lines | ABI sha (first 16) | Regenerated? |
|--------|----------|--------------------|--------------|
| master | 339 | `74326174e110b658` | (baseline) |
| `feat/contributor-economics` | 428 | `06930de472942130` | **YES** — adds setPayoutMap, getPayoutMap, Payout struct, PayoutMapSet/SplitPayoutExecuted events |
| `feat/agent-onboarder-v2` | 339 | `74326174e110b658` | **NO** — IDENTICAL to master |
| `feat/centralized-substrate` | 339 | `74326174e110b658` | **NO** |
| `feat/multi-stablecoin-escrow` | 339 | `74326174e110b658` | **NO** |
| `mobile/week-1-scaffold` | 339 | `74326174e110b658` | **NO** |
| `fix/require-auth-api-key-passthrough` | 339 | `74326174e110b658` | **NO** |
| `digital-verifier/foundation` | 368 | `bc3bda1f5ee36916` | **YES** — but partial (signature update) |
| `docs/split-operator-rules` | 368 | `bc3bda1f5ee36916` | **YES** — same as digital-verifier |
| (capture-verification, workflow-runtime, etc. don't touch ABI) | | | |

**Critical implication**: 5 branches modify `MilestoneEscrow.sol` but ship the master ABI without regeneration. Their ABI is **stale by their own definition**. Whoever merges last must `forge build && pnpm tsx scripts/generate-abi.ts` (or equivalent) to refresh the ABI before publishing — otherwise frontend / agent-package / MCP server will not see the new functions (`allowStablecoin`, `addMilestoneWithToken`, `tokenForMilestone`, `setPayoutMap`, etc.).

**ABI merge order matters**: Whoever merges last to `master` triggers the canonical ABI regeneration. The safe rule is to regenerate at every merge; the safer rule is to make ABI regeneration a single post-merge cleanup commit per release-please cycle so it's never half-stale.

---

## 4. Recommended Merge Order

Heuristic: **orthogonal additions first**, then **shared-base cluster**, then **invasive contract changes**, then **documentation**.

### Tier 1 — Land first (alongside or just after CE, no conflicts)

1. **`feat/contributor-economics`** — Land first. Adds new contracts (ContributorNFT, RateScheduleRegistry), new packages (db/repositories/contributor, gateway/routes/contributors, gateway/routes/ip), refactors `MilestoneEscrow.release()` to dispatch via helpers. No upstream conflicts. Clean merge into master @ `8550d5ec`.

2. **`feat/workflow-runtime`** — Strictly orthogonal to CE. CLAUDE.md addition at line 94 (lines 828+ are CE territory), `packages/workflow/` is a new package, no shared file edits. **Zero conflict markers** in `git merge-tree`. Land second.

3. **`fix/activity-caller-sweep`** — Strict descendant of `feat/workflow-runtime` (workflow-runtime IS its ancestor). Once `feat/workflow-runtime` merges, this is essentially the same content + minor activity-caller tweaks. **Zero conflict markers** with CE. Can land third.

### Tier 2 — Substrate cluster (must land as a unit, OR start with the root)

The 6 branches descended from `0443a33` (`fix/require-auth-api-key-passthrough`) all carry the identical CVP + multi-stablecoin work. Resolve the CRITICAL `release()` bug ONCE on the substrate root, then everything downstream rebases cleanly.

4. **`capture-verification-protocol`** — CVP is the lowest-conflict substrate (only 4 conflicts; doesn't touch MilestoneEscrow.sol). Resolves agent-package.json + 3 db/mcp imports. **Land before multi-stablecoin** so the CVP storage-tables migrations land in master before any branch that depends on them.

5. **`feat/multi-stablecoin-escrow`** — CRITICAL conflict resolution required. After this lands, the substrate root contains the canonical multi-stablecoin + CVP combination. Hand-merge needed: refactor `_distributeLegacy` / `_distributeWithMap` to accept `IERC20 tok` (or rederive locally). See §5.A.

6. **`fix/require-auth-api-key-passthrough`** — Once 4+5 are in master, this branch's substrate is in master and only the auth fix delta remains. Should be a near-trivial rebase — likely 0 conflicts, but verify.

### Tier 3 — Substrate descendants (all should rebase cleanly once Tier 2 lands)

After Tier 2 merges to master, each of these branches should be rebased onto the new master. The conflicts will collapse to just their UNIQUE diffs (since the substrate is now upstream).

7. **`arch/open-core-split`** — adds `packages/verifier/consensus-oracle/` rename, license-scan job, gateway openapi spec. Orthogonal to CE. Rebase clean.

8. **`wave7/verification-commitments`** — adds `IVerificationScheme.sol`, `VerificationSchemeRegistry.sol`, `CaptureChallengeV1Scheme.sol` (new files; no MilestoneEscrow modification). Rebase clean.

9. **`feat/agent-onboarder-v2`** — adds `packages/template-data-product/`, agent onboarder routes. Orthogonal to CE. Rebase clean.

10. **`feat/centralized-substrate`** — adds `settleCentralized()` to MilestoneEscrow + `centrallySettled` storage. AFTER Tier 2 lands, the only remaining conflict with CE is in the `release()` doc comments — resolvable. The `settleCentralized()` codepath does NOT call `_distributeLegacy/WithMap`, so it composes cleanly with CE's dispatcher. Land 10th.

11. **`mobile/week-1-scaffold`** — adds `apps/mobile/` (75 commits, mostly mobile PWA scaffold). After Tier 2 lands the only conflict is `apps/dashboard/public/agent-package.json` (timestamp + ordering — trivial). Rebase clean.

### Tier 4 — Invasive ABI breaks (handle with eyes wide open)

12. **`digital-verifier/foundation`** — Breaking ABI change to `release()` and `submitAttestation()`. Land LAST so callers can be migrated in one PR. Requires hand-merge with CE: `release()` must take BOTH `attestation` (digital-verifier) AND dispatch to `_distributeWithMap` (CE). All tests, agent-package, MCP server, and gateway escrow routes need to pass `attestation` through. See §5.E.

13. **`docs/split-operator-rules`** — Strict descendant of digital-verifier (digital-verifier IS its ancestor). Once digital-verifier lands, this is essentially documentation + the same MilestoneEscrow changes. The AGENT_INTEGRATION.md "add/add" conflict resolves as: keep CE's version (it's strictly newer; we already pulled it from this branch). Land 13th.

---

## 5. Pairwise Resolution Patches

### A. CE × multi-stablecoin variant (4 branches: multi-stablecoin, agent-onboarder-v2, mobile/week-1-scaffold, fix/require-auth-api-key-passthrough)

**Files**: MilestoneEscrow.sol, db/index.ts, db/schema/index.ts, mcp-server/src/index.ts, agent-package.json.

**Resolution direction**: pre-merge multi-stablecoin into a CE-merge branch, then hand-fix MilestoneEscrow.sol.

**Patch (MilestoneEscrow.sol)**:
1. KEEP both state blocks (splitPayout state from CE + reserve state from substrate). Both are textually adjacent additions; no logic conflict.
2. KEEP both event blocks (PayoutMapSet/SplitPayoutExecuted from CE + StablecoinAllowed/StablecoinRevoked/MilestoneAdded from substrate).
3. Modify `release()` to derive `IERC20 tok` once and pass it through:

   ```solidity
   function release(uint256 milestoneIndex) external nonReentrant milestoneExists(milestoneIndex) {
       Milestone storage m = milestones[milestoneIndex];
       require(m.status == MilestoneStatus.Attested, "Not attested");
       require(block.timestamp >= m.challengeWindowEnd, "Challenge window open");
       m.status = MilestoneStatus.Released;
       address operator = m.operator;
       uint256 amount = m.amount;
       uint256 operatorBond = m.operatorBond;
       IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));
       emit MilestoneReleased(milestoneIndex, operator, amount);
       if (payoutMapSet[milestoneIndex]) {
           _distributeWithMap(tok, milestoneIndex, amount, operator, operatorBond);
       } else {
           _distributeLegacy(tok, amount, operator, operatorBond);
       }
   }

   function _distributeLegacy(IERC20 tok, uint256 amount, address operator, uint256 operatorBond) internal {
       if (protocolRoot != address(0)) {
           IPCCProtocol root = IPCCProtocol(protocolRoot);
           uint256 feeBps = root.protocolFeeBps();
           uint256 fee = (amount * feeBps) / 10000;
           tok.safeTransfer(root.feeRecipient(), fee);
           tok.safeTransfer(operator, amount - fee + operatorBond);
           root.collectFee(address(tok), fee);
       } else {
           tok.safeTransfer(operator, amount + operatorBond);
       }
   }

   function _distributeWithMap(
       IERC20 tok,
       uint256 milestoneIndex,
       uint256 amount,
       address operator,
       uint256 operatorBond
   ) internal {
       uint256 protocolFee = 0;
       if (protocolRoot != address(0)) {
           IPCCProtocol root = IPCCProtocol(protocolRoot);
           uint256 feeBps = root.protocolFeeBps();
           protocolFee = (amount * feeBps) / 10000;
           if (protocolFee > 0) tok.safeTransfer(root.feeRecipient(), protocolFee);
           root.collectFee(address(tok), protocolFee);
       }
       uint256 distributable = amount - protocolFee;
       Payout[] storage payouts = _payoutMap[milestoneIndex];
       uint256 distributed = 0;
       for (uint256 i = 0; i < payouts.length; i++) {
           Payout memory p = payouts[i];
           uint256 share = (distributable * p.bps) / 10000;
           if (share > 0) {
               tok.safeTransfer(p.recipient, share);
               distributed += share;
           }
           emit SplitPayoutExecuted(milestoneIndex, p.recipient, p.roleTag, p.ipId, address(tok), share);
       }
       uint256 operatorAmount = (distributable - distributed) + operatorBond;
       if (operatorAmount > 0) tok.safeTransfer(operator, operatorAmount);
   }
   ```

   This is **invasive**: two helper signatures change (one more parameter), and `token.transfer` becomes `tok.safeTransfer`. Approximately 10-15 lines of diff in MilestoneEscrow.sol on top of git's auto-merge. The new tests `MilestoneEscrow.splitPayout.t.sol` and `MilestoneEscrow.contributorEconomics.integration.t.sol` should still pass because the chosen token is consistent in single-token escrows (default token).

**Patch (other 4 files)**:
- `db/index.ts`: keep both export blocks (CE adds 5 contributor types at line 74-79, substrate adds `desc, asc` at line 53 + `CaptureVerdictRow` at line 75). Trivial 2-block keep-both.
- `db/schema/index.ts`: similar — orthogonal exports.
- `mcp-server/src/index.ts`: orthogonal tool registrations (CE adds contributor MCP tools, substrate adds capture MCP tools).
- `agent-package.json`: regenerate after merge via `pnpm tsx packages/agent-pkg/scripts/regenerate.ts` (or whichever generator). Don't hand-merge JSON — just regenerate.

### B. CE × CVP

**Files**: db/index.ts, db/schema/index.ts, mcp-server/src/index.ts, agent-package.json.

**No MilestoneEscrow.sol conflict** (CVP doesn't touch it). All 4 conflicts are pure additive imports/exports. Trivial keep-both. Regenerate agent-package.json. **No hand-merge of business logic needed.**

### C. CE × arch/open-core-split

Same as CE × CVP (arch/open-core-split is descended from CVP and inherits the same 4 conflict files). Resolution identical.

### D. CE × wave7/verification-commitments

Same as CE × CVP (wave7 is also CVP-descended). The wave7 contracts (`VerificationSchemeRegistry.sol`, `IVerificationScheme.sol`, `CaptureChallengeV1Scheme.sol`) are NEW files; no overlap with CE.

### E. CE × digital-verifier/foundation

**The hardest patch.** ABI signature changes propagate everywhere.

**Pre-merge**: digital-verifier into CE, OR vice versa. Choosing CE-as-base (since it's the active feature):

1. **MilestoneEscrow.sol**:
   - Take digital-verifier's signatures: `submitAttestation(uint256, IPCCOracle.Attestation calldata)`, `release(uint256, IPCCOracle.Attestation calldata)`.
   - Take CE's `release()` body refactor (dispatch on `payoutMapSet`).
   - Pass `attestation` through `_distributeLegacy` / `_distributeWithMap` so they can call `root.collectFeeWithAttestation(token, fee, attestation)` instead of `root.collectFee(token, fee)`.

2. **All callers**:
   - Gateway routes that call `escrow.release(milestoneIndex)` need to pass the stored attestation.
   - MCP server tools.
   - The agent-package.json — regenerate after the ABI changes.
   - All Solidity tests in `packages/contracts/test/MilestoneEscrow*.t.sol` (CE adds two of these).
   - Frontend dashboard pages that call `release` via viem.

3. **ABI regeneration**: run `forge build` then the generator. The new ABI must include `IPCCOracle.Attestation` tuple in the function signatures.

**Rough effort**: 300-500 LOC across ~15-20 files. NOT a 30-minute task; budget half a day.

### F. CE × docs/split-operator-rules

After digital-verifier lands, this branch's MilestoneEscrow change is already in master. Remaining conflicts:
- `CLAUDE.md` — both branches add lines around the deploy section. Keep both.
- `docs/AGENT_INTEGRATION.md` (add/add) — CE has the **forward** version. Take CE's. (We already incorporated the docs/split-operator-rules content during CE's development; the diff is minor section-header tweaks.)
- `docs/DEPLOY.md` (add/add) — verify which version is canonical; CE's deploy doc is the active one.
- `packages/contracts/src/MilestoneEscrow.sol` — same digital-verifier signature change, already resolved in §5.E.

### G. CE × workflow-runtime / activity-caller-sweep

**No conflict markers**. Direct merge.

### H. CE × centralized-substrate

After multi-stablecoin lands (§5.A), the centralized-substrate branch is its strict superset + `settleCentralized` codepath. Remaining delta vs CE:
- `settleCentralized()` is a separate code path that does NOT touch `release()`. Composes cleanly with CE's split-payout dispatcher.
- The `centrallySettled[milestoneIndex]` storage gates BOTH paths — once set, neither `release()` nor `settleCentralized()` can run again.
- Hand-merge is mostly mechanical at this point — git auto-merges, just verify the `centrallySettled` check fires correctly in the path through `_distributeWithMap`.

---

## 6. Bottom Line

**Yes — `feat/contributor-economics` is safe to merge first.** It has zero conflicts with master (master is its merge-base) and only orthogonal-or-trivially-resolvable conflicts with the other branches. Merging CE first does NOT make any other branch harder than it already is.

**The real risk lies downstream**, not in CE itself: the substrate cluster (`feat/multi-stablecoin-escrow` and its 5 descendants) carries a CRITICAL silent-merge bug where git auto-merges `MilestoneEscrow.release()` into uncompilable code. **Whoever merges multi-stablecoin AFTER CE must hand-fix `_distributeLegacy` / `_distributeWithMap` to accept `IERC20 tok`**, or the build will silently break. Add a CI gate that runs `forge build` on every merge candidate to catch this kind of issue at the door.

**Recommended order**: CE → workflow-runtime → activity-caller-sweep (all clean) → CVP (4 trivial conflicts) → multi-stablecoin (CRITICAL hand-merge needed) → fix/require-auth (trivial after substrate is upstream) → arch/open-core-split → wave7 → agent-onboarder → centralized-substrate → mobile/week-1-scaffold → digital-verifier (BIG hand-merge, ABI break) → docs/split-operator-rules.

**ABI regeneration**: only CE and digital-verifier regenerate the MilestoneEscrow ABI today. The 5 multi-stablecoin-descendant branches all ship a stale master ABI despite modifying the contract. Make ABI regeneration a mandatory post-merge cleanup step (or a pre-merge CI check).
