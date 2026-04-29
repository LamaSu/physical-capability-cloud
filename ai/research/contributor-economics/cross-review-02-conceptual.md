# Cross-Branch Conceptual Alignment Review
**Reviewer**: review-conceptual-bravo
**Date**: 2026-04-29
**Branch under review**: `feat/contributor-economics`
**Compares against**: `digital-verifier/foundation`, `capture-verification-protocol`, `feat/multi-stablecoin-escrow`, `feat/workflow-runtime`, `wave7/verification-commitments`, `arch/open-core-split`, `erp-patterns/foundation` (merged to master @ dcc30f4)

This review is conceptual — about whether design primitives across branches agree, drift, or duplicate. File-conflict review is the sibling agent's job (review-merge-alpha).

The contributor-economics branch's load-bearing primitives, for cross-reference:
- 10-role `ContributorRole` enum (operator, verifier, insurer, integrator, protocol-author, model-author, dataset-contributor, curator, assembler, network-treasury). No OEM role — see ADR-12 §3.
- `RateSchedule` DSL (6 segment kinds) + `RateScheduleRegistry.sol` (sha256-keyed, immutable, permissionless).
- `ContributorNFT` (ERC-721 bridge over `StoryIPRegistration`, commits to a schedule hash at mint).
- `CompositionManifest` (off-chain entity, sha256-canonicalized, links capability ipId → contributor cohort with roles + rate schedule hashes).
- `TrainingManifest` (N:1 datasets-to-model with `weightBps`; recursive depth-5 cap).
- `MilestoneEscrow.setPayoutMap()` + `splitPayout` distribution path (ADR-11 chose Option A: on-chain payout map; pre-fund commitment).
- 7 MCP tools: `pcc_contributor_register`, `pcc_contributor_list`, `pcc_schedule_publish`, `pcc_schedule_get`, `pcc_schedule_evaluate`, `pcc_training_manifest_set`, `pcc_training_manifest_get`.

---

## Per-branch analysis

### digital-verifier/foundation

**Thesis quote** (from `ai/research/digital-verifier/05-workflow-challenge.md`):
> "Touchstones (report 01) catch the executor that *dodges* work; challenges catch the executor that *reuses* work. … the right answer is a two-track hybrid: for settled jobs that have on-chain escrow, the MilestoneEscrow creation block serves as a global, everyone-verifiable time anchor … for unsettled inter-agent sub-tasks that have no escrow, a lightweight `{UUID, recent block hash, scope}` challenge binds the child's work to a moment the parent can prove."

And from 04-assurance-score.md:
> "The rollup is multiplicative-with-gates rather than linear, because regulatory scoring fails catastrophically under linear aggregation: one missing signature cannot be offset by ten passing tier requirements."

**Overlap with contributor-economics:**

1. **Verifier role semantics — fully aligned.** Both branches treat `verifier` as a signed-attestation role with slashable stake. Digital-verifier introduces `assuranceScore: number ∈ [0,1]` as the rollup; contributor-economics' ADR-12 §4 specifies the verifier "evaluates evidence bundles, signs attestations, answers challenges" at "1-5% of job value, or flat fee for low-value jobs." No conflict — the digital-verifier is *what* the verifier produces, contributor-economics is *how the verifier gets paid*.

2. **ChallengeService scope is orthogonal to economics.** ChallengeService produces a `WorkflowChallenge` token and binds work to a block anchor. It does not produce or consume `RateSchedule`, `CompositionManifest`, or `Payout` data. The two systems would compose: a CompositionManifest's verifier entry receives bps; that verifier runs the touchstone+challenge pipeline to produce findings; findings feed `assuranceScore`; the score gates `release()`; release fires the splitPayout. Clean linear pipeline, no contention.

3. **Touchstone economics — minor drift to flag.** Touchstone fees ("per-touchstone $0.0X cost") in the digital-verifier docs aren't represented in the ContributorRole enum. They likely belong inside the verifier's per-job fee, but ADR-12 doesn't model that. **Not a blocker** — touchstone is operational cost, not a contributor role — but worth a sentence in §4 of ADR-12.

4. **No primitive collision.** Digital-verifier types (`Touchstone`, `WorkflowChallenge`, `EvidenceCommitment`, `AssuranceScore`) live in `packages/verifier/` and `packages/spec/src/identity/ephemeral.ts`. Contributor-economics types (`RateSchedule`, `CompositionManifest`, `TrainingManifest`, `ContributorRole`) live in `packages/spec/src/types/`. Disjoint namespaces.

**Verdict: ALIGN**

**Recommendation:** No code rework. Add one paragraph to ADR-12 §4 clarifying that touchstone/challenge operational fees are accounted for inside the `verifier` role's bps allocation, not as a separate role. The `assuranceScore` floor that gates `release()` should be referenced from ADR-11 §3 once digital-verifier merges.

---

### capture-verification-protocol

**Thesis quote** (from `ai/research/capture-verification-protocol.md`):
> "The Capture Verification Protocol (CVP) defines six tiers of capture authenticity (CC0–CC5), orthogonal to the existing assurance tiers 0–3. Each tier has a unique trust model, verification procedure, and set of anti-spoof affordances. Operators declare their class per capture. The system auto-detects whether the declared class is actually supported by the submitted evidence and downgrades silently on mismatch. All capture claims plus a small set of verification attestations land on-chain via `CaptureClassRegistry.sol`."

**Overlap with contributor-economics:**

1. **Pattern parallel: CaptureClassRegistry vs RateScheduleRegistry — strong, but NOT redundant.** Both are content-addressed, sha256-keyed, immutable on-chain registries. Both treat governance as "anyone publishes; the bytes-key prevents collision." Both use `mapping(bytes32 => bytes)` accessor patterns and `SchedulePublished` / `CaptureAnchored` events.
   - **Reuse opportunity.** CVP's registry uses the gateway oracle as a single privileged writer (`anchor` is `onlyGatewayOracle`); contributor-economics' registry is fully permissionless. Different threat models — captures need an oracle to assert `verifiedClass <= declaredClass`, schedules just need bytes to match their hash. Not duplicate; different invariants.
   - But they share the off-chain "canonical JSON → sha256 → bytes32 key" hashing convention, so the same `canonicalize` + `sha256` library serves both. No drift.

2. **Verifier role: same identity, different output.** CVP's "verifier attestations" (Merkle root in `CaptureClassRegistry.attestationsRoot` for N-of-M) map to the same on-chain `verifier` actor that contributor-economics pays via `splitPayout`. CVP says the verifier "ran the 32-step verifier on captureHash X and got passed=true, class=CC2"; contributor-economics says that verifier gets 1-5% bps. No conflict — CVP is the verification work, contributor-economics is the verifier compensation.

3. **MCP tool surface — strict no-overlap.** CVP adds 7 tools: `pcc_capture_challenge`, `pcc_capture_upload`, `pcc_capture_anchor`, `pcc_capture_status`, `pcc_capture_class_registry`, plus 2 more. Contributor-economics adds 7 tools: `pcc_contributor_register`, `pcc_contributor_list`, `pcc_schedule_publish`, `pcc_schedule_get`, `pcc_schedule_evaluate`, `pcc_training_manifest_set`, `pcc_training_manifest_get`. Zero name collision. `agent-package.json` should grow from 211 (post-CVP) → 218 → 225 (when both merge).

4. **No new role required for capture.** CVP introduces a `submittedBy` (operator) on the on-chain anchor, not a separate "capture-verifier" role. The `verifier` role already covers it. ALIGN.

**Verdict: ALIGN** (with minor reuse opportunity)

**Recommendation:** Extract a shared utility `packages/spec/src/util/canonical-registry.ts` exporting `hashCanonicalJson(obj): bytes32` + a Solidity helper macro for the `require(sha256(x) == claimed, ...)` pattern used in BOTH `RateScheduleRegistry.publish` and `CaptureClassRegistry.anchor`. Tiny refactor, prevents future drift.

---

### feat/multi-stablecoin-escrow

**Thesis quote** (from `packages/contracts/src/MilestoneEscrow.sol`):
> "The escrow has a DEFAULT token (set at construction) for backward compatibility. It also maintains an owner-curated allowlist of approved stablecoins, each with an on-chain `ReserveAttestation` pointer to a vetted reserve report (maintained off-chain). Milestones added via `addMilestoneWithToken(..., token)` may use any allowlisted stablecoin instead of the default. … SafeERC20 is used for all transfers so the escrow is compatible with tokens such as USDT that do NOT return a boolean from transfer/transferFrom."

**Overlap with contributor-economics — THIS IS THE LOAD-BEARING CONFLICT:**

1. **`splitPayout` uses `address(token)` (default), not `tokenForMilestone(milestoneIndex)`.** Confirmed by reading `feat/contributor-economics:packages/contracts/src/MilestoneEscrow.sol`:
   - Line 530 in contributor-economics: `address tokenAddr = address(token);`
   - Lines 536, 552, 570 use `token.transfer(...)` directly.
   - Line 491 (legacy path) also uses `token.transfer(...)`.

   Contrast `feat/multi-stablecoin-escrow` lines 528, 604, 647, 691: all use `IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));` then `tok.safeTransfer(...)`.

   **If both branches merge as-is**, an escrow that uses USDT for one milestone and USDC for another will route `splitPayout` distributions through the wrong token (the construction-time default), causing every test that mixes per-milestone tokens to fail and silently routing real funds incorrectly in production.

2. **`require(token.transfer(...))` in contributor-economics will revert on USDT** — USDT does not return a bool. Multi-stablecoin solved this with `SafeERC20`. Contributor-economics' splitPayout path will silently brick USDT-denominated milestones the moment the two merge.

3. **Fee-on-transfer rejection: contributor-economics inherits implicit guards via the prior single-token path (the balance-delta math reverts), but multi-stablecoin enforces it explicitly via `require(tok.balanceOf(this) - before == amount, "Fee-on-transfer token")` after every inbound transfer. After merge, the contributor-economics `splitPayout` outbound transfers don't have a corresponding outbound check — necessary if a recipient is itself a fee-on-transfer wrapper. Edge case, but worth noting.**

**Verdict: CONTRADICT — must be fixed before both merge.**

**Recommendation:** In `_distributeWithMap` and `_distributeLegacy`:
- Replace every `token.transfer(...)` and `require(token.transfer(...))` with `IERC20(tokenForMilestone(milestoneIndex)).safeTransfer(...)`.
- Replace `address(token)` (line 530) with `tokenForMilestone(milestoneIndex)` and pass the result down.
- Pull `using SafeERC20 for IERC20;` directive into the file.
- Add a Forge test: `splitPayout` with milestone[0]=USDC + milestone[1]=USDT, assert each recipient receives the milestone-specific token.

This is a 30-line surgical change. The integration test `MilestoneEscrow.t.sol` (which already exists per the recent commit `1c323bf test(contracts): TypeScript integration — buildPayoutMap end-to-end matches forge expectations`) should be extended with a multi-token case before either branch lands.

---

### feat/workflow-runtime

**Thesis quote** (from `packages/workflow/README.md`):
> "`@pcc/workflow` is a library-only, SQLite-backed durable-execution package. It borrows the Inngest step-memoization model, layers on a Temporal-style `Activity` ABI, and adds the bits PCC actually needs (semantic on-chain idempotency keys, hash-chained ALCOA+ audit log, federated `DataPort` handoff, CWL export). It ships ~1,400 LOC of source, runs in-process …"

And:
> "every `ctx.step()` looks up `(runId, stepId)` in `step_results`; on hit it returns the cached value without invoking the lambda; on miss it runs and memoizes."

**Overlap with contributor-economics:**

1. **DAG primitives — different shapes, different concerns.** Workflow-runtime's `WorkflowDef` is a runtime DAG (memoized step results, `ctx.activity` retries, CWL export for interop). CompositionManifest is a static economic anchor (which contributors get paid for which capability). They are NOT the same primitive:
   - WorkflowDef.steps describe *control flow*: step "fund-escrow" calls activity X, then step "submit-evidence" calls activity Y.
   - CompositionManifest.entries describe *contributor identity*: this capability is composed of operator A, verifier B, integrator C, model-author D — each with their own rateScheduleHash.
   - A single workflow run consumes ONE CompositionManifest (the manifest doesn't change mid-run); the workflow steps are how that capability gets executed; the manifest is who gets paid when it's done.

2. **Composition model alignment.** The CompositionManifest schema has no notion of "step graph" — that's correct. If a job is multi-step (3D print + post-process + inspect), each step has its own `MilestoneEscrow` milestone with its own `setPayoutMap`. The workflow-runtime executes the steps; contributor-economics handles the payout map per milestone. Compose by treating "milestone N completes" as a workflow activity that triggers `release(N)` which fires the splitPayout distribution.

3. **No conflict on hash-chained audit.** Workflow-runtime's hash-chained event log is for ALCOA+ Enduring/Available evidence, not for payouts. Contributor-economics doesn't write to that log; the gateway emits one `MilestoneReleased` event per milestone, plus N `SplitPayoutExecuted` events. These can be activities-via-the-runtime if/when contributor-economics wires into it.

4. **CWL export — neutral on contributor model.** The CWL serializer doesn't include economic data. Adopting workflow-runtime won't force changes to CompositionManifest.

5. **Should CompositionManifest be a workflow run?** No. The manifest is the contract; the workflow run is one execution against the contract. A capability can have hundreds of executions, each one funded as separate milestones, each one emitting its own splitPayout. The manifest is shared across them. Conflating the two would give every job a unique manifest, eliminating the "publish once, settle many" story.

**Verdict: ALIGN — they compose cleanly without overlap.**

**Recommendation:** No rework. When workflow-runtime lands as a hard dep, write a short doc in `packages/workflow/examples/` showing a sample `JobLifecycleWorkflow` whose final step calls `escrow.release(milestoneIdx)` — which then emits `SplitPayoutExecuted` events that workflow-runtime memoizes via `ctx.step('release-milestone', ...)`. This is the migration pattern, not a redesign.

---

### wave7/verification-commitments

**Thesis quote** (commit messages + `VerificationSchemeRegistry.sol`):
> "Governor-gated registry mapping schemeId → IVerificationScheme impl. Registration has a 24h timelock to prevent governor-key compromise from swapping schemes mid-flight; deregistration is immediate for safety. … A registered scheme's impl address is IMMUTABLE once committed — to change the impl for an existing schemeId, deregister first, then register a new one. This prevents silent impl-swap attacks on locked milestones."

And from `commitment-service.ts`:
> "Pedersen hash (BN254) for all tree-internal operations, matching Noir's `std::hash::pedersen_hash` in the circuits. bundleHash fields remain SHA-256 (content addressing). commitmentHash, merkleRoot, and tree leaves use Pedersen."

**Overlap with contributor-economics:**

1. **Two registries with different threat models.** wave7's `VerificationSchemeRegistry` is governor-gated with a 24h timelock; `RateScheduleRegistry` is fully permissionless. They serve different purposes:
   - VerificationSchemeRegistry stores VERIFICATION LOGIC (a smart contract address that implements `IVerificationScheme`). Trust required: governance must vet impls.
   - RateScheduleRegistry stores ECONOMIC INTENT (canonical JSON of a rate curve). Trust required: zero — the bytes are the schedule.
   - Different primitives serving different roles. Both content-addressed but for different content. NOT duplicate.

2. **Pedersen vs SHA256 — drift to watch.** wave7 uses Pedersen (BN254) for Merkle tree commitments to match Noir circuits. Contributor-economics uses SHA256 for canonical hashing. Both are correct in their domain; the question is whether a `CompositionManifest` ever needs a ZK proof. Currently it does not — manifests are public, payouts are public, no privacy. **If a future feature wants ZK-private payouts, the manifest hashing layer will need a Pedersen-compatible variant alongside SHA256.** Not a current blocker.

3. **CommitmentService scope.** wave7's `CommitmentService` operates on `EvidenceCommitment` objects (bundle hash → Pedersen commitment → Merkle tree → on-chain root). Contributor-economics' `RateScheduleRegistry` operates on `RateSchedule` objects (canonical JSON → SHA256 → on-chain bytes). No method or storage slot overlap.

4. **Verifier-economics overlap is minimal.** wave7's `IVerificationScheme.commit(...)` and `verify(commitment)` produce a verdict that the gateway feeds into `assuranceScore`; that score gates `release()`; release fires splitPayout. Same pipeline as digital-verifier — clean composition.

5. **CaptureChallengeV1Scheme adapter** — this is wave7's adapter from CVP's challenge primitives into the new `IVerificationScheme` interface. It's purely additive on top of CVP, with zero economic surface. ALIGN.

**Verdict: ALIGN**

**Recommendation:** No rework needed. Document in ADR-12 §4 that the verifier role's bps share funds the operational cost of running registered `IVerificationScheme` impls, including potential Pedersen-tree commitment work. One sentence.

---

### arch/open-core-split

**Thesis quote** (from `docs/adr/0001-open-core-split.md`):
> "Adopt an open-core split with a strict copyleft-contagion boundary at the HTTP edge … Monorepo (gateway, verifier, detector, UI, pcc-node, contracts, MCP server, workflow runtime) | LamaSu/physical-capability-cloud (public) | Apache 2.0 | The protocol. … PCC Oracle (settlement attestation service) | LamaSu/pcc-oracle (private) | Proprietary | The rent layer. Issues signed `MilestoneEscrow.release()` attestations."

**Overlap with contributor-economics:**

1. **Every contributor-economics primitive is OPEN-CORE.** The branch's load-bearing artifacts:
   - `RateScheduleRegistry.sol`, `MilestoneEscrow.sol` extensions → live in `packages/contracts/src/` → Apache 2.0 (per ADR-0001 boundary).
   - `RateSchedule`, `CompositionManifest`, `TrainingManifest`, `ContributorRole` Zod schemas → live in `packages/spec/src/types/` → Apache 2.0.
   - `splitPayout` distribution logic → all on-chain in `MilestoneEscrow.sol` → Apache 2.0.
   - 7 MCP tools → live in `packages/mcp-server/` → Apache 2.0.

   **None of contributor-economics' primitives belong in the proprietary oracle.** They are protocol-level; the rent layer is unchanged (still the 2.35% fee in the contract + the oracle's signed attestation).

2. **The PCC Oracle's role does NOT change.** The oracle signs that "this evidence meets the tier requirements; please release the milestone." The contributor-economics path is: oracle attests → `release()` reads the payout map → distributes to N recipients. Open-core split's HTTP-edge boundary is preserved: the oracle's `verify()` response is still a single signed yes/no with confidence; the split distribution happens entirely on-chain afterward, no oracle round-trip per recipient.

3. **SWF — `network-treasury` role compatibility.** Contributor-economics adds `network-treasury` as a role (0% allowed; per-network address). The SWF section of ADR-0001 keeps SWF in the public repo and clarifies it cannot reach into the oracle. The `network-treasury` recipient in a CompositionManifest is just an EVM address — the SWF can BE that address for one network, or a multisig for another. The role doesn't depend on the SWF specifically; the SWF can subscribe by registering its address. Clean.

4. **License-scan CI — no impact.** ADR-0001 will add a CI license-scan job rejecting GPL/AGPL/SSPL transitive deps in the public repo. Contributor-economics introduces zero new third-party deps (only `zod`, `node:crypto`, existing `viem`). Passes the scan trivially.

5. **No privileged code path in contributor-economics that would need to move to oracle.** All splitPayout logic is on-chain; the LicensingEngine traversal that builds the payout map is open-source library code (not a signing or attestation step). No leak across the boundary.

**Verdict: ALIGN — open-core split would NOT need to be redone.**

**Recommendation:** Add a paragraph to ADR-0001 explicitly stating "the contributor-economics primitives (RateScheduleRegistry, ContributorNFT, CompositionManifest, splitPayout) are Apache 2.0 — they describe public economic intent, not the rent layer." Two sentences, one PR. Keeps future contributors from re-asking the question.

---

### erp-patterns/foundation

**Thesis quote** (from commit `dcc30f4` body):
> "ERP patterns foundation — 6 enterprise systems for global physical ERP: 1. Parameterized query templates (ISA-88 inspired composition) 2. API gateway governance (rate limiting, DLP redaction, RBAC scopes) 3. Natural language query interface 4. Unified analytics layer (hash-chained event bus + materialized views) 5. Structured agentic tool-chain (intent → template → repo → cited response) 6. Configurable compliance framework (per-industry/regulation templates)"

**Overlap with contributor-economics:**

This branch's "foundation" landed on master as commits `dcc30f4` + `7d395ef` + `c7c40f2`, so the contributor-economics branch has it as ancestor.

1. **No primitive collision.** The 6 ERP patterns are infrastructure (rate limiting, DLP redaction, hash-chained analytics, intent classifier). They do not introduce a `ContributorRole`, `RateSchedule`, or NFT mint. Templates exist (`parameterized query templates` in `packages/db/src/repositories/template-store.ts`) — NOT capability templates. Different namespace ("query template" = SQL skeleton with bind params; "capability template" = CSD).

2. **Compliance templates vs ALCOA+.** ERP brings `compliance_templates` table (per-industry rules); contributor-economics doesn't touch compliance. They share the gateway facade pattern (the compliance facade in `packages/gateway/src/facades/compliance.facade.ts` already exists). Pure additive; no contention.

3. **Governance role overlap?** ERP introduces `endpoint_scopes` (RBAC scopes per route) and the contributor-economics MCP tools (`pcc_contributor_register`, `pcc_schedule_publish`) will need scopes registered. This is configuration, not design conflict — contributor-economics merely adds new entries to the existing `endpoint_scopes` table.

4. **Natural-language query interface vs contributor profiles.** The NL interface is intent → template execution. It does not currently know about RateSchedule/CompositionManifest, but the contract is "register your tool, the NL agent can call it." After contributor-economics merges, the agent will discover the 7 new MCP tools automatically. Compose, don't compete.

5. **Hash-chained analytics vs ALCOA+ events vs splitPayout events.** ERP's `analytics_events` table has hash-chained events for compliance audit. Contributor-economics emits `SplitPayoutExecuted` and `ScheduleEvaluated` (off-chain) events. After merge, those events should be ingested into the analytics_events table. Trivial wiring, ~15 LOC of subscriber.

**Verdict: ALIGN**

**Recommendation:** When contributor-economics merges, add `endpoint_scopes` rows for the 7 new MCP routes (read scope for `_get`/`_list`/`_evaluate`, write scope for `_register`/`_publish`/`_set`). One migration file. Optional: subscribe the new events into `analytics_events`.

---

## Cross-cutting impact analysis

**If `feat/contributor-economics` merges first, what happens to each branch?**

The single hard collision is `feat/multi-stablecoin-escrow`. The two branches both edit `MilestoneEscrow.sol`'s `release()` function from incompatible angles:
- Multi-stablecoin extends `release()` to use `IERC20(tokenForMilestone(idx)).safeTransfer(...)` for the legacy single-recipient path.
- Contributor-economics extends `release()` to dispatch into `_distributeWithMap` (multi-recipient via `setPayoutMap`), but the new helper hardcodes `address(token)` — losing per-milestone token selection.

If contributor-economics merges first, multi-stablecoin must rebase and re-apply the SafeERC20 + `tokenForMilestone()` pattern to BOTH `_distributeLegacy` and `_distributeWithMap`. That's a clean fix (~30 lines), but it must happen before multi-stablecoin's PR can land — otherwise USDT-denominated splitPayouts revert and USDC/USDT-mixed milestones route to the wrong token.

The other branches do not invalidate any contributor-economics design:
- digital-verifier compose cleanly (their score gates release; release fires the split).
- capture-verification-protocol compose cleanly (CVP captures feed verifier attestations; verifiers earn bps via splitPayout).
- feat/workflow-runtime composes cleanly (workflow run executes a job whose final step is `release()` — splitPayout fires inside).
- wave7/verification-commitments composes cleanly (IVerificationScheme outputs feed assuranceScore; same pipeline).
- arch/open-core-split: contributor-economics is entirely Apache 2.0 by construction; the boundary survives unchanged.
- erp-patterns/foundation: only need to add scope entries.

**Are there primitives in contributor-economics that should be EXTRACTED to a shared layer?**

Yes, two:
1. **`canonical-registry` utility.** Both `RateScheduleRegistry` and `CaptureClassRegistry` (from CVP) implement the same pattern: canonical JSON → SHA256 → bytes32 → immutable on-chain mapping with publisher attribution. Extract `packages/spec/src/util/canonical-registry.ts` (off-chain) + a small Solidity macro/internal-function library (on-chain) so future registries (forthcoming model registry, dataset registry, etc.) inherit the same hash convention without copy-paste drift.

2. **`payout-map` interface boundary.** The on-chain `Payout[]` struct in `MilestoneEscrow.sol` and the off-chain `CompositionEntry` schema in `composition-manifest.ts` have to stay in lock-step — adding a field one place needs to be reflected in the other. Currently they live in different repos in spirit (Solidity vs TypeScript), tied only by the `roleTag = keccak256(roleName)` convention. Recommend a shared `packages/spec/src/types/payout-map.ts` exporting the canonical role-tag list as `bytes32` constants computed via `keccak256("operator")` etc., consumed by both the off-chain manifest builder AND a Solidity test fixture that asserts the constants match. Prevents silent drift between the off-chain manifest's role names and the on-chain roleTag bytes.

---

## Things to adapt or extract

In rough priority order (what the synthesizer should consider):

1. **[BLOCKER if merged with multi-stablecoin]** Patch `MilestoneEscrow._distributeWithMap` and `_distributeLegacy` to use `IERC20(tokenForMilestone(milestoneIndex)).safeTransfer(...)` and adopt SafeERC20. Add a Forge test mixing USDC + USDT in one escrow's setPayoutMap.
2. **[Clean before merge]** Add a paragraph to ADR-0001 (open-core-split) explicitly placing contributor-economics primitives on the Apache 2.0 side.
3. **[After contributor-economics merges]** When erp-patterns/foundation patterns are next touched, add `endpoint_scopes` rows for the 7 new MCP routes.
4. **[Worth a tiny refactor]** Extract `packages/spec/src/util/canonical-registry.ts` exporting `hashCanonicalJson` shared between contributor-economics and CVP. Backport CVP after extract.
5. **[Worth a tiny refactor]** Extract `packages/spec/src/types/payout-map.ts` with the canonical `bytes32` role-tag constants and a unit test asserting they match `keccak256(roleName)`. Tie the off-chain CompositionEntry to the on-chain Payout struct via shared constants.
6. **[Documentation only]** Add a sentence to ADR-12 §4 noting touchstone/challenge operational fees are funded out of the verifier role's bps allocation, not as a separate role.
7. **[Documentation only]** Add a sentence to ADR-11 §3 referencing digital-verifier's `assuranceScore` floor as the gate condition for `release()` once both branches merge.
8. **[Future-proofing only]** Note in CompositionManifest docs that if ZK-private payouts are ever needed, a Pedersen-compatible variant must be added alongside SHA256 to align with wave7's commitment scheme.

---

## Branches ranked by reconciliation work needed

1. **`feat/multi-stablecoin-escrow`** — CONTRADICT. Hard fix in `MilestoneEscrow.sol` required. ~30 LOC + 1 Forge test. **Blocker.**
2. **`erp-patterns/foundation`** (already on master) — ALIGN; small wiring task (endpoint scope rows). ~20 LOC migration.
3. **`capture-verification-protocol`** — ALIGN; suggested utility extract (canonical-registry). ~50 LOC refactor, low priority.
4. **`wave7/verification-commitments`** — ALIGN; doc note on Pedersen vs SHA256 future compatibility. Doc-only.
5. **`digital-verifier/foundation`** — ALIGN; one-paragraph ADR clarification on touchstone fees. Doc-only.
6. **`feat/workflow-runtime`** — ALIGN; example workflow showing splitPayout integration. Doc/example only.
7. **`arch/open-core-split`** — ALIGN; one-paragraph ADR clarification placing contributor-economics on Apache 2.0 side. Doc-only.
