# Resume Point — Contributor Economics Build

**Updated**: 2026-04-24 (after gap-fill `/go` run).
**Worktree**: `C:/Users/globa/pcc-contributor-economics`
**Branch**: `feat/contributor-economics` (based on `master` @ `8550d5e`)
**Head commit**: `c5de9be docs(integration): bring AGENT_INTEGRATION.md forward from docs/split-operator-rules branch` (53 commits ahead of master).
**NOT pushed to `lamasu` remote yet.**

---

## Front door for new readers

If you are an agent or human dropping into this branch with no prior context,
**read `docs/CONTRIBUTOR_ECONOMICS.md` first**. It is the 5-minute quickstart
covering the 10-role taxonomy, the 3-layer architecture (off-chain types →
persistence → contracts), 5-command path to publish a schedule, and the cheat
sheet of where every artifact lives. This file (`99-resume-here.md`) is for
"what's done vs deferred"; the docs file is for "how do I use this."

---

## Status snapshot

| Layer | Status |
|---|---|
| Wave 1: scout research (4 reports) | DONE — all four landed in earlier session |
| Wave 2: ADRs (3 + reconciliation amendment) | DONE — ADR-10 / 11 / 12 all in tree, ADR-10 has the §0 reconciliation block |
| Wave 3a: TS types (`@pcc/spec`) | DONE — `RateSchedule`, `CompositionManifest`, `TrainingManifest`, `ContributorRole` enum |
| Wave 3b: persistence (`@pcc/store`) | DONE — Drizzle schema, `ContributorRepository` impl, migrations, 18+ tests |
| Wave 3c: on-chain (`@pcc/contracts`) | DONE — `RateScheduleRegistry`, `ContributorNFT`, `MilestoneEscrow.splitPayout`, `LicensingEngine` extension, 32 forge tests |
| Wave 3d: SDK + ABI | DONE — ABI exports for both new contracts, `payouts.ts` with `buildPayoutMap()` |
| Wave 4a: REST routes | DONE — `/api/contributors/*` (8 endpoints) on the gateway, 23 route tests |
| Wave 4b: MCP tools | DONE — 7 new tools (`pcc_contributor_*`), agent-package.json regenerated to v2.8.0 (218 tools) |
| Wave 4c: docs | DONE — `docs/CONTRIBUTOR_ECONOMICS.md`, README section, AGENT_INTEGRATION.md §14, DEPLOY_CONTRIBUTOR_ECONOMICS.md, claros-layer4-amendment.md |
| Wave 4d: dashboard UI | DONE for role taxonomy + presets (NegotiationPanel / BuilderPage / NegotiationPage / SplitEditor / IPDetailPage all extended) |
| Wave 5: tests | DONE — 32 forge + 700+ TS pass; integration test for full job-settles-through-splitPayout is the one gap (see deferred list) |

Everything in `00-plan.md` Wave 1-4 is shipped. Wave 5 is partially shipped
(unit + contract + route tests yes; an end-to-end "fund→evidence→attest→
release-with-payout-map→all balances correct" integration on a live testnet
is the largest gap).

---

## What just landed in the gap-fill `/go` run

These commits (in roughly the order they were made) closed the priority-1, 2,
and 3 lists from the previous version of this resume doc:

- `b094e02 feat(contracts): RateScheduleRegistry — content-addressed immutable schedule storage`
- `f2ec2c6 test(contracts): RateScheduleRegistry — 11 tests covering publish/get/exists invariants`
- `0942e62 feat(contracts): ContributorNFT — ERC-721 + ERC-2981, sealed metadata, scheduleHash + role + ipId per token`
- `1eb6e74 test(contracts): ContributorNFT — 15 tests covering mint, ERC-721, ERC-2981, sealed metadata`
- `0f50641 feat(db): IContributorRepository interface + record types`
- `b081812 feat(db): contributor-economics schema — profiles, rate_schedules, training_manifests, composition_manifests`
- `b4305d9 feat(db): ContributorRepository — Drizzle impl with canonical JSON serialization`
- `93b0c03 test(db): 18+ test cases for ContributorRepository`
- `749499b feat(db): migrations for contributor-economics tables + indexes`
- `40aa498 chore(contracts): ABI export for ContributorNFT + RateScheduleRegistry`
- `2785c9d chore(contracts): deploy script for RateScheduleRegistry + ContributorNFT` (`packages/contracts/script/DeployContributorEconomics.s.sol`)
- `7bb61c0 feat(gateway): /api/contributors/* — profiles, schedules, evaluate, training manifests`
- `802034f test(gateway): /api/contributors/* — 23 tests covering routes, validation, errors`
- `12b16d0 feat(mcp): 7 contributor-economics tools — register, list, schedules, manifests`
- `d69cc7c chore(agent-package): regenerate with 7 contributor tools — total 218`
- `c5de9be docs(integration): bring AGENT_INTEGRATION.md forward from docs/split-operator-rules branch`

Plus the Wave 4 docs trio (this commit and the two preceding it):

- `docs: CONTRIBUTOR_ECONOMICS.md — 5-minute quickstart for the new primitives`
- `docs(readme): add Contributor Economics section + cross-links`
- `docs(resume): update 99-resume-here.md to reflect gap-fill complete state`

(The earlier-session commits — `f3c15d2`, `d2407db`, `a1083f6`, `dedd057`,
`85f0a58`, `06c18f9`, `9bab2ef`, `4ffaf09` — are still in tree as the lower
layers that this run built on. See `git log --oneline master..HEAD` for the
full 53-commit list.)

---

## What is genuinely still deferred (post-gap-fill)

Each of these has prior-art research already on the branch — none is "we
forgot about it"; all four are deliberate scope cuts from the original plan.

### Cross-chain `ContributorNFT` portability
- LayerZero ONFT or CCIP wrapping for `ContributorNFT`. Today the NFT lives
  on whichever chain you deploy `ContributorNFT.sol` to (Base Sepolia for
  the testnet target).
- Research: `04-network-forkability.md` §10-12 covers the design space.
- Should ship before mainnet, since contributor identity is supposed to be
  per-network-sovereign with cross-network earnings.

### zkML training attestation
- For `model-author` and `dataset-contributor` roles, v1 relies on hash-commit
  + reputational slashing. zkML proofs that "this model was actually trained
  on these datasets in these proportions" is a v2 task.
- Research: `03-dataset-model-provenance.md` + `03-appendices.md`.

### Production audit
- 32 forge tests + 700+ TS tests pass. **No external audit.**
- Do not deploy to a chain handling real value (mainnet, prod) without one.
- Candidates noted in research: OpenZeppelin, Trail of Bits, Spearbit.

### Mainnet deploy
- `script/DeployContributorEconomics.s.sol` targets testnet (Base Sepolia +
  Flow EVM testnet today).
- Mainnet deploy is gated on (a) audit completion, (b) cross-chain ONFT
  resolution, (c) Railway prod promotion gate (see `docs/DEPLOY.md` —
  build-once-deploy-many invariants apply).

### Integration test (end-to-end)
- All unit / contract / route tests pass. A live test "fund a milestone with
  a 4-recipient payout map → submit evidence → attest → wait challenge window
  → release → verify N transfers emitted + balances correct → re-test with a
  TrainingManifest-attributed model" is the missing seam.
- Requires either testnet env (slow, but real) or a forge-level integration
  harness that mocks the chain; either is one focused implementer-day of
  work.

### Dashboard UX polish
- Role taxonomy + presets are wired through 5 dashboard files (NegotiationPanel
  / BuilderPage / NegotiationPage / SplitEditor / IPDetailPage), but a
  dedicated "publish my RateSchedule" wizard, a "browse other contributors'
  schedules" gallery, and an "evaluate this schedule at a moment" sandbox
  are still post-MVP.

---

## ADR conflict resolution status

Both ADR conflicts called out in the previous version of this doc were
resolved during the build. The reconciliation amendment to `10-adr-licensing-engine-extension.md`
is in tree at commit `4ffaf09`. ADR-12's role taxonomy and ADR-11's on-chain
payout map are the canonical choices.

---

## How to resume from here

If you are picking this up:

1. **Read `docs/CONTRIBUTOR_ECONOMICS.md` first.** It's the front door.
2. Run `git log --oneline master..HEAD` to confirm the 53-commit count.
3. Run the test suite once locally (or via `spark-run` if your local box is
   16GB) to confirm green:
   ```bash
   spark-run "cd ~/projects/physical-capability-cloud && pnpm --workspace-concurrency=1 -r test"
   spark-run "cd ~/projects/physical-capability-cloud/packages/contracts && forge test"
   ```
4. **Push to `lamasu` remote** when you're ready: `git push lamasu feat/contributor-economics`. Open PR.
5. Pick the highest-leverage deferred item from the list above. Most likely
   "integration test" (smallest scope, biggest confidence delta) or
   "production audit" (longest lead time, blocks mainnet).

Estimated remaining agent work to ship to mainnet: 1-2 implementer days for
the integration test, 4-8 weeks of calendar time for the audit, then the
mainnet promotion via the build-once / retag pipeline (`docs/DEPLOY.md`).
