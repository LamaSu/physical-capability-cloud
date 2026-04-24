# Resume Point — Contributor Economics Build

**Paused**: 2026-04-23 — ran into Claude Max rate limit (resets 9pm PT).
Agents `impl-roles-alpha`, `impl-splitpayout-bravo`, `scout-networks-delta`,
`scout-provenance-charlie`, `scout-schedules-bravo` all terminated with
"limit hit" mid-run. A lot still landed — this doc tells you exactly where to pick up.

**Worktree**: `C:/Users/globa/pcc-contributor-economics`
**Branch**: `feat/contributor-economics` (based on `master` @ `8550d5e`)
**Head commit when paused**: `a1083f6` (feat(a2a): extend IPRevenueSplitEntry)

## What's already landed (don't redo)

### Research (all 4 scouts delivered)
| File | Lines | Status |
|---|---|---|
| `ai/research/contributor-economics/01-royalty-nft-standards.md` | 2113 | DONE — 14 topics, 5-layer recommended stack, 3 next steps |
| `ai/research/contributor-economics/02-rate-schedule-dsl.md` | 938 | DONE — 10 sections through DSLs + upgradeability |
| `ai/research/contributor-economics/03-dataset-model-provenance.md` | 1413 | DONE — full v1 with Solidity pseudocode + separate `03-appendices.md` (800 lines) |
| `ai/research/contributor-economics/04-network-forkability.md` | 994 | DONE — 15 sections + PCC network architecture recommendation |

### Architecture (all 3 ADRs delivered)
| File | Lines | Status |
|---|---|---|
| `ai/research/contributor-economics/10-adr-licensing-engine-extension.md` | 776 | DONE — conflicts with 11 on split mechanism (see below) |
| `ai/research/contributor-economics/11-adr-splitpayout-contract.md` | 613 | DONE — Option A on-chain payout map (CHOSEN) |
| `ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md` | 366 | DONE — 10-role enum + OEM-free audit of full repo (14 hits, all LEAVE-ALONE) |
| `ai/architecture/target-state-splitpayout-escrow.md` | 124 | DONE — target-state doc from splitpayout-bravo |

### ADR conflicts that were resolved

**Split mechanism**: ADR-10 proposed Option B (off-chain compute + ECDSA verify
at release). ADR-11 proposed Option A (on-chain payout map set by payer pre-fund).
**Option A was chosen** — trust-less, matches existing PCC code patterns, user
directive of publicly-visible immutable schedules is still honored (schedule
evaluated at fund time → payer commits → contributors see the exact amounts
before fund lands). Option B needs a signing authority = centralization the
user explicitly rejected.

**Role taxonomy**: ADR-10 and ADR-12 disagreed on migration. **ADR-12 was chosen**
— preserves `assembler` and `curator` unchanged (ADR-10 collapsed them into
other roles, which would break existing data), and introduces `insurer` as a
distinct new role (ADR-10 wanted to repurpose `curator`, bad).

ADR-10 needs a reconciliation amendment block in Wave 4 docs pass.

### Code already committed

`f3c15d2 feat(spec): extend ContributorRole enum` — 10-role enum in
  `packages/spec/src/types/story.ts`. Old `designer`/`network` still decode
  for backward compat. Tests in `packages/spec/src/__tests__/story-types.test.ts`
  updated.

`d2407db feat(contracts): add contributor-economics split profile templates` —
  `packages/contracts/ts/story-defaults.ts` has new profiles:
  `contributor-economics-minimal` and `contributor-economics-with-ai`. Tests in
  `packages/contracts/ts/__tests__/story-defaults.test.ts` updated.

`a1083f6 feat(a2a): extend IPRevenueSplitEntry role enum` —
  `packages/a2a/src/types.ts` extended. Tests in
  `packages/a2a/src/__tests__/ip-intents.test.ts` added.

`dedd057 feat(contracts): add Payout struct + storage for splitPayout` —
  `packages/contracts/src/MilestoneEscrow.sol` has the new Payout struct +
  `_payoutMap` mapping + `payoutMapSet` mapping + MAX_PAYOUTS/MAX_SINGLE_BPS
  constants + `PayoutMapSet` and `SplitPayoutExecuted` events. No functions
  implemented yet.

Plus the orchestrator's plan doc + the scout/architect commits listed above.

## What still needs to be done (resume checklist)

### Priority 1 — finish what impl-*-alpha/bravo started

**impl-roles-alpha steps 4-7** (~30-45 min agent-time):

- [ ] Step 4: `packages/gateway/src/routes/ip.ts` line ~62 — extend Zod union for `role` in `POST /api/ip/splits`. Keep `designer` as a decoder alias.
- [ ] Step 5: `packages/mcp-server/src/index.ts` line ~1039 — extend `pcc_ip_set_splits` tool input schema to enumerate all 10 roles. Update `packages/mcp-server/src/cli.ts` line ~295 help text to use `protocol-author` + `integrator` in example.
- [ ] Step 6: Dashboard UI (5 files per ADR-12 §5):
  - `apps/dashboard/src/components/builder/NegotiationPanel.tsx` lines 23-38
  - `apps/dashboard/src/pages/BuilderPage.tsx` lines 15-33
  - `apps/dashboard/src/pages/NegotiationPage.tsx` lines 15-23
  - `apps/dashboard/src/components/SplitEditor.tsx` lines 28-37
  - `apps/dashboard/src/pages/IPDetailPage.tsx` lines 81-84
  - Add color assignments for 6 new roles; add `contributor-economics-with-ai` preset everywhere.
- [x] Step 7: `docs/claros-layer4-amendment.md` — **DONE by orchestrator before pause**

**impl-splitpayout-bravo steps 2-6** (~45-60 min agent-time):

- [ ] Step 2: `setPayoutMap(milestoneIndex, Payout[])` with validation rules from ADR-11 §4 (sum ≤10000, no duplicate recipient+roleTag pairs, max 16 payouts, callable only on Unfunded milestone). Don't forget `getPayoutMap()` view.
- [ ] Step 3: Modify `release()` per ADR-11 §3 — CEI preserved, operator gets residual, protocol fee first on gross, fallback to legacy path when `!payoutMapSet[idx]`. Emits `SplitPayoutExecuted` per recipient.
- [ ] Step 4: `packages/contracts/test/MilestoneEscrow.splitPayout.t.sol` — 14 test cases from ADR-11 §7.
- [ ] Step 5: Run `forge test` (local first, fall back to `spark-run` if OOM). Ralph loop fixes.
- [ ] Step 6: `packages/contracts/ts/payouts.ts` — Payout type + ROLE_TAGS keccak256 constants + `buildPayoutMap()` stub. Use viem or @noble/hashes for keccak256 (check existing imports). ABI regen if needed: `packages/contracts/ts/abi/MilestoneEscrow.ts`.

### Priority 2 — LicensingEngine extension (Wave 3c)

Was blocked waiting on scout-schedules-bravo. That scout landed 938 lines.
Ready to proceed now. Spawn a new implementer:

- [ ] `packages/spec/src/types/rate-schedule.ts` — new type (`RateSchedule`, `Segment[]` pattern from scout research § on Sablier LockupDynamic). Use ERC-3569 content-addressed pattern: `scheduleHash` commits the schedule.
- [ ] `packages/spec/src/types/composition-manifest.ts` — `CompositionManifest` (ordered list of `{ipId, role, contributorAddress, rateScheduleHash}`).
- [ ] `packages/spec/src/types/training-manifest.ts` — `TrainingManifest` for ModelNFT linking to DatasetNFTs with weights.
- [ ] `packages/contracts/ts/licensing-engine.ts` — add `setRateSchedule()`, `evaluateRateSchedule(ipId, context)`, `linkModel(modelIpId, manifest)`, `getRoyaltyDistributionRich()` that traverses both derivative tree AND training manifest.
- [ ] `packages/contracts/ts/payouts.ts` — fill in `buildPayoutMap()` (from Priority 1 step 6 stub) using the rich royalty distribution from LicensingEngine.

### Priority 3 — Wave 4: docs + integration

- [ ] Update `docs/AGENT_INTEGRATION.md` § to document new `pcc_ip_*` tools
  that handle RateSchedule + ContributorNFT + DatasetNFT/ModelNFT. Bump tool
  count from 219 → ~230.
- [ ] Regenerate `/agent-package.json` at the gateway.
- [ ] Update `docs/whitepaper.md` — ensure no OEM-royalty framing anywhere;
  add section describing contributor economics (cite ADR-10/11/12).
- [ ] Reconciliation amendment to ADR-10 noting ADR-11's Option A was chosen
  and which role-taxonomy choices from ADR-12 supersede ADR-10's proposal.

### Priority 4 — Wave 5: tests

- [ ] Integration test: full job submits → fund with payout map → evidence →
  attestation → release → verify N transfers emitted + balances correct.
- [ ] Integration test: job with training-manifest-attributed model →
  payout traverses up the DAG to dataset contributors.
- [ ] Smoke test on Base Sepolia (requires DEPLOYER_PRIVATE_KEY).

### Out of scope for this build (stretch goals)

- Cross-chain ContributorNFT portability (LayerZero ONFT / CCIP) — scout-networks-delta
  covered it; defer to a separate branch.
- zkML training attestation — scout-provenance-charlie covered it; defer to v2.
- Production audit (OpenZeppelin or Trail of Bits) — obviously not in a /go run.

## Known conflicts flagged during the build

See "ADR conflicts that were resolved" above. Both conflicts were resolved in
favor of the more thorough ADR (11 over 10, 12 over 10) without stopping the
impl agents. The Wave 4 docs pass should land the explicit reconciliation
amendment to ADR-10.

## How to resume in the next session

1. Re-read this file first.
2. Check `git log --oneline` for any commits that landed after `a1083f6`.
3. Start with Priority 1 — they're the most concrete and scope-isolated.
4. Fire impl-roles-alpha-resume and impl-splitpayout-bravo-resume in parallel
   (independent files).
5. Then fire Priority 2 (LicensingEngine extension, Wave 3c).
6. Then Wave 4 docs + reconciliation.
7. Then Wave 5 tests.
8. Push to `lamasu` remote when green. Open PR.

Estimated remaining agent work: ~3-5 hours of implementer + 1-2 hours of docs.
That's one more /go run plus one shorter follow-up.
