# Contributor Economics

**Status**: Shipped on `feat/contributor-economics` (40 new forge tests across 3 contributor-economics test files; the broader contracts suite runs 58 tests when the MilestoneEscrow base suite is included; 700+ TS tests passing).
**Live target**: deploys to Base Sepolia via `script/DeployContributorEconomics.s.sol`.
**Branch state**: see `ai/research/contributor-economics/99-resume-here.md` for the current commit count and HEAD (this header was deliberately de-pinned to avoid bit-rot — run `git rev-parse HEAD` and `git rev-list --count master..HEAD` for the live numbers).

---

## In one paragraph

Anyone who contributes to a job — the adapter author, the capability protocol
author, the AI model trainer, the pilot who collected the training data — can
mint an immutable, publicly-committed rate schedule once and earn a fraction
of every job that uses their work, forever (or until they ship a v2). At
settlement, `MilestoneEscrow.splitPayout()` routes funds across all attached
contributors in a single transaction. There is no OEM royalty class — by
design. OEMs participate as Operators, Integrators, Protocol Authors, or
Model Authors on equal terms with everyone else (see
`docs/claros-layer4-amendment.md` for the full no-OEM thesis).

---

## Who earns what

PCC's `ContributorRole` enum has exactly **10 roles**. There is no `oem`,
`manufacturer`, `hardware-vendor`, or `device-maker` role. Any future
proposal to add such a role must clear the bar in
`ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md` §3.5.

| Role | What they do | Typical bps band | Example |
|------|--------------|------------------|---------|
| `operator` | Runs the physical machine | residual (80-95%) | A print shop running a Prusa MK4 |
| `verifier` | Evaluates evidence, signs attestations | 100-500 bps | Hybrid verifier market node |
| `insurer` | Underwrites job-failure coverage; opt-in per job | 0-300 bps premium | Risk-pool LP |
| `integrator` | Wrote the machine adapter (OctoPrint, Bambu, ROS) | 0-100 bps | Author of `kernel-octoprint` |
| `protocol-author` | Authored the Capability StructureDefinition + test vectors | 0-50 bps | Author of `csd:hplc/v1` |
| `model-author` | Trained the AI model used at execution time | 0-80 bps | Author of `model-defect-detect-v3` |
| `dataset-contributor` | Pilot who captured training data | fraction of `model-author` share via TrainingManifest | Pilot who recorded 200 demonstrations |
| `curator` | Organizes/audits a collection of contributions | 0-500 bps | A reviewer maintaining a verified-CSD index |
| `assembler` | Composed multiple capabilities into a workflow | 0-50 bps | Author of a multi-step PCB-fab DAG |
| `network-treasury` | Per-network treasury (0% allowed) | 0-300 bps | Network operator |

Operator residual = `10000 - sum(other_roles_bps)`. The market discovers
adoption: contributors who over-price aren't included in payout maps.

> **Why no OEM role?** See `docs/claros-layer4-amendment.md`. The short
> version: encoding a per-job lifetime royalty for hardware manufacturers
> would recreate Xometry-style platform rent in immutable form. PCC's
> forcing function is intentional — OEMs earn by maintaining the best open
> adapter, the best CSD, the best models. Absence of contribution earns zero.

---

## How it works (3 layers)

### 1. Off-chain types — `@pcc/spec`

A `RateSchedule` is a **sealed, content-addressed sequence of segments** that
encodes how a contributor's basis-points payout varies over time, job value,
and network adoption. It has 6 segment kinds:

- `constant` — flat bps from t0 to t1 (or forever)
- `step` — single bps starting at t0
- `linear-decay` — bps interpolates startBps → endBps over [t0, t1]
- `exponential-decay` — `bps(t) = max(endBps, startBps * exp(-k * elapsed))`
- `adoption-indexed` — `bps = clamp(scale / sqrt(jobsPerDay), floor, cap)`
- `piecewise-value` — `bps = jobValueCents < threshold ? bpsLow : bpsHigh`

The schedule's identity is `scheduleHash = sha256(canonicalJSON({version, segments}))`.
Two structurally-identical schedules always hash to the same `0x<64hex>`.
Evaluation is pure: `evaluateRateSchedule(schedule, ctx) → { bps, segmentIndex, kind }`.

Sources:
- `C:/Users/globa/pcc-contributor-economics/packages/spec/src/types/rate-schedule.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/spec/src/types/composition-manifest.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/spec/src/types/training-manifest.ts`

### 2. Persistence — `@pcc/store` (directory: `packages/db/`)

Drizzle schema with 4 tables (one migration, `contributor` schema):

| Table | Purpose |
|-------|---------|
| `contributor_profiles` | `(address, role, label, ipId, createdAt)` — profile rows; one address may hold many roles |
| `rate_schedules` | `(scheduleHash, version, canonicalJSON, publisher, publishedAt)` — content-addressed schedule store; mirrors the on-chain `RateScheduleRegistry` |
| `training_manifests` | Model IP → ordered `[ {datasetIpId, weightBps} ]` for recursive `dataset-contributor` attribution |
| `composition_manifests` | Audit-trail commits of ordered `[{ipId, role, contributorAddress, rateScheduleHash}]` for one job |

Sources:
- `C:/Users/globa/pcc-contributor-economics/packages/db/src/schema/contributor.ts`
- `C:/Users/globa/pcc-contributor-economics/packages/db/src/repositories/contributor.ts`

### 3. On-chain — `@pcc/contracts`

Three Solidity contracts wire the off-chain types to settlement:

- **`RateScheduleRegistry`** — content-addressed immutable store. `publish(scheduleBytes, expectedHash)` recomputes `sha256(scheduleBytes)`, reverts if it doesn't match `expectedHash`, then stores forever. Permissionless. `exists(scheduleHash)` is O(1) and is what `ContributorNFT` calls at mint time.
- **`ContributorNFT`** — ERC-721 + ERC-2981. Each token seals 5 fields at mint (`role`, `scheduleHash`, `ipId`, `metadataUri`, `mintedAt`) and has **no setter**. Updating any field requires minting a new token. `scheduleHash` mints are gated by `RateScheduleRegistry.exists()`. ERC-2981 returns a 5% marketplace fallback — actual per-job payouts come from the off-chain RateSchedule via `MilestoneEscrow.setPayoutMap()`, not `royaltyInfo()`.
- **`MilestoneEscrow.splitPayout`** — extension that adds `setPayoutMap(milestoneIndex, Payout[])` and a new `release()` distribution branch. Up to 16 payouts per milestone, each ≤ 50% of milestone (no whales), no duplicate `(recipient, roleTag)` pairs, sum of bps ≤ 10000. Operator gets `(distributable - sumDistributed) + bond`. Legacy single-operator path preserved byte-for-byte for backward compat.

Sources:
- `C:/Users/globa/pcc-contributor-economics/packages/contracts/src/RateScheduleRegistry.sol`
- `C:/Users/globa/pcc-contributor-economics/packages/contracts/src/ContributorNFT.sol`
- `C:/Users/globa/pcc-contributor-economics/packages/contracts/src/MilestoneEscrow.sol` — see the `release()` and `splitPayout()` functions (the new distribution branch)
- ADR-11 selected Option A (on-chain payout map): see `ai/research/contributor-economics/11-adr-splitpayout-contract.md`

---

## How to use it (5 commands)

The 5-minute "I am a contributor and I want to earn from my work" path. All
endpoints are at `https://capability.network` and require `Authorization: Bearer $PCC_KEY`.

```bash
# 0. (Once) Get a key.
export PCC_KEY=$(curl -s -X POST https://capability.network/api/auth/provision \
  -H "Content-Type: application/json" \
  -d '{"email":"me@example.com","name":"My Adapter Shop"}' | jq -r .api_key)

# 1. Publish a sealed RateSchedule (content-addressed; same JSON → same hash).
#    The wire body is {publishedBy, schedule}; the server canonicalizes the
#    inner schedule JSON, computes sha256, and returns the resulting hash.
SCHEDULE_HASH=$(curl -s -X POST https://capability.network/api/contributors/schedules \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "publishedBy": "0x000000000000000000000000000000000000dEaD",
        "schedule": {
          "version": 1,
          "segments": [
            {"kind":"constant","startTime":0,"endTime":null,"bps":40}
          ],
          "notes": "Flat 40bps integrator share, forever."
        }
      }' | jq -r .scheduleHash)

# 2. Register a contributor profile bound to the schedule.
#    NOTE: RegisterProfileBodySchema accepts {address, role, scheduleHash,
#    ipId?, metadataUri?, contributorNftTokenId?} — there is no `label` field
#    today. Annotate role/wallet using metadataUri or ipId.
curl -s -X POST https://capability.network/api/contributors \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d "{
        \"address\": \"0x000000000000000000000000000000000000dEaD\",
        \"role\": \"integrator\",
        \"scheduleHash\": \"$SCHEDULE_HASH\"
      }"

# 3. (Anyone, any time) Evaluate the schedule at a moment.
curl -s -X POST "https://capability.network/api/contributors/schedules/$SCHEDULE_HASH/evaluate" \
  -H "Authorization: Bearer $PCC_KEY" \
  -H "Content-Type: application/json" \
  -d '{"now": 1714000000, "jobValueCents": 50000, "jobsPerDay": 12}'
# → {"bps":40,"segmentIndex":0,"kind":"constant"}

# 4. (Payer, off-chain → on-chain) Compose the payout map and call setPayoutMap()
#    on the milestone escrow before fund(). Use
#    `packages/contracts/ts/payouts.ts:buildPayoutMap()` to compose the on-chain
#    `Payout[]` array from a `CompositionManifest` + RateSchedule lookup. See
#    ADR-11 for the Payout struct shape and the `MilestoneEscrow.setPayoutMap`
#    signature. The dashboard "Composition Builder" / "SplitEditor" surfaces
#    are still post-MVP for this flow — script-driven composition works today.

# 5. (Operator) Run the job; settlement automatically calls splitPayout via release().
#    Every recipient gets paid in one tx; you (the integrator) receive
#    (distributable * 40 / 10000) credited to your wallet.
```

For the full REST + MCP surface (8 endpoints, 7 MCP tools added in v2.8.0),
see `docs/AGENT_INTEGRATION.md` §12.

---

## How to think about RateSchedule

A `RateSchedule` is the contributor's public commitment to a payout curve.
You publish it once; it lives forever; anyone who evaluates it gets the same
answer. A few realistic shapes:

### "I'm a hobbyist — credit me, but don't take a cut"

```json
{
  "version": 1,
  "segments": [
    { "kind": "constant", "startTime": 0, "endTime": null, "bps": 0 }
  ]
}
```

Zero bps forever. The ContributorNFT still mints; jobs still attach the
profile to their CompositionManifest; you appear in the on-chain
`SplitPayoutExecuted` event log with a zero share. That's the credit.

### "I'm bootstrapping — high early, decay over 18 months, then floor"

```json
{
  "version": 1,
  "segments": [
    { "kind": "constant",     "startTime": 1713916800, "endTime": 1729641600, "bps": 80 },
    { "kind": "linear-decay", "startTime": 1729641600, "endTime": 1761177600, "startBps": 80, "endBps": 10 },
    { "kind": "constant",     "startTime": 1761177600, "endTime": null,        "bps": 10 }
  ]
}
```

80bps the first 6 months (Apr-Oct 2026), linearly decays 80→10bps over the
next year, then 10bps forever. The "I want to recoup my upfront work, then
become essentially-free infrastructure" curve.

### "I want adoption-decayed — bps shrinks as the network gets busier"

```json
{
  "version": 1,
  "segments": [
    {
      "kind": "adoption-indexed",
      "startTime": 1713916800, "endTime": null,
      "scale": 200, "floorBps": 5, "capBps": 100
    }
  ]
}
```

`bps = clamp(200 / sqrt(jobsPerDay), 5, 100)`. At 4 jobs/day → 100bps cap.
At 100 jobs/day → 20bps. At 1600 jobs/day → 5bps floor. This is the curve
for "I believe in the network; if it succeeds my cut shrinks but volume grows."

The full segment grammar (5 of 6 kinds shown above; `step`, `exponential-decay`,
`piecewise-value` round it out) lives at
`C:/Users/globa/pcc-contributor-economics/packages/spec/src/types/rate-schedule.ts`.

---

## Where each thing lives (cheat sheet)

| You want to... | Look at |
|---|---|
| Understand the no-OEM thesis | `C:/Users/globa/pcc-contributor-economics/docs/claros-layer4-amendment.md` |
| See the role taxonomy | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/12-adr-role-taxonomy-and-no-oem.md` (§2 + §4) |
| See why splitPayout chose Option A (on-chain map vs off-chain ECDSA) | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/11-adr-splitpayout-contract.md` |
| See the LicensingEngine extension plan | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/10-adr-licensing-engine-extension.md` (with §0 reconciliation amendment) |
| Original design directive | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/00-plan.md` |
| Royalty NFT standards landscape | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/01-royalty-nft-standards.md` |
| Rate-schedule DSL landscape (Sablier prior art) | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/02-rate-schedule-dsl.md` |
| Dataset / Model provenance research | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/03-dataset-model-provenance.md` |
| Network-forkability research | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/04-network-forkability.md` |
| API reference (REST + MCP) | `C:/Users/globa/pcc-contributor-economics/docs/AGENT_INTEGRATION.md` §12 (Contributor Economics) |
| Deploy the new contracts | `C:/Users/globa/pcc-contributor-economics/docs/DEPLOY_CONTRIBUTOR_ECONOMICS.md` |
| The Solidity contracts | `C:/Users/globa/pcc-contributor-economics/packages/contracts/src/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow}.sol` |
| Deploy script | `C:/Users/globa/pcc-contributor-economics/packages/contracts/script/DeployContributorEconomics.s.sol` |
| The TS types | `C:/Users/globa/pcc-contributor-economics/packages/spec/src/types/{rate-schedule,composition-manifest,training-manifest}.ts` |
| The DB schema | `C:/Users/globa/pcc-contributor-economics/packages/db/src/schema/contributor.ts` |
| The DB repo | `C:/Users/globa/pcc-contributor-economics/packages/db/src/repositories/contributor.ts` |
| Gateway routes | `C:/Users/globa/pcc-contributor-economics/packages/gateway/src/routes/contributors.ts` |
| MCP tools | `C:/Users/globa/pcc-contributor-economics/packages/mcp-server/src/index.ts` (search for `contributor_`) |
| Forge tests | `C:/Users/globa/pcc-contributor-economics/packages/contracts/test/{ContributorNFT,RateScheduleRegistry,MilestoneEscrow.splitPayout}.t.sol` |
| TS tests | `C:/Users/globa/pcc-contributor-economics/packages/spec/src/__tests__/`, `packages/db/src/__tests__/contributor-db.test.ts`, `packages/gateway/src/__tests__/contributors.test.ts` |
| Resume point if work is paused | `C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/99-resume-here.md` |

---

## What this is NOT

- **Not a token launch.** No new ERC-20. `ContributorNFT` is identity, not currency. Settlement uses USDC (or whatever ERC-20 the milestone escrow was constructed with).
- **Not a new chain.** Same Base Sepolia + Flow EVM testnet deploys as the rest of PCC. `RateScheduleRegistry` and `ContributorNFT` are simple contracts with no chain-specific assumptions.
- **Not a marketplace UI** (yet). The dashboard's `Composition Builder` and `SplitEditor` tabs were extended to render the new roles and presets, but a polished "publish your schedule" UI is still post-MVP.
- **Not zkML-attested.** v1 is hash-commit + reputational slashing for `model-author` and `dataset-contributor`. zkML training attestation is in `03-dataset-model-provenance.md` as v2 work.
- **Not "OEMs forbidden."** OEMs are first-class participants — as Operators / Integrators / Protocol Authors / Model Authors. The protocol just has no special royalty class for hardware manufacturing as a historical fact (see `docs/claros-layer4-amendment.md`).
- **Not audited.** 40 contributor-economics forge tests pass (11 RateScheduleRegistry + 15 ContributorNFT + 14 splitPayout); the broader contracts suite runs 58 tests when the MilestoneEscrow base suite is included; 700+ TS tests pass. External audit (OpenZeppelin / Trail of Bits) is a v2 task. Do not deploy to a chain handling real money without one.

---

## Status of deferrals

These items are **intentionally** out of scope for the gap-fill `/go` run.
Each has prior-art research already on the branch; pick up from there.

| Deferred | Where to start |
|---|---|
| Cross-chain `ContributorNFT` portability (LayerZero ONFT / CCIP) | `04-network-forkability.md` §10-12; landed scout work covers the design space |
| zkML training attestation for `model-author` / `dataset-contributor` | `03-dataset-model-provenance.md` + `03-appendices.md` |
| External audit | post-MVP gate; do not promote `:prod` Railway image to mainnet contracts without one |
| Mainnet deployment | `DeployContributorEconomics.s.sol` is testnet-targeted today; mainnet env vars are stubbed |
| Reconciliation of pre-existing `designer` role split data | data migration, not a type change; old strings still decode (ADR-12 §2.2) |
| Dashboard polish: contributor "publish my schedule" UI | builder/NegotiationPanel + SplitEditor were extended for new roles; full publish-flow UX TBD |

### Hash-algorithm note (Pedersen vs sha256)

`RateSchedule.scheduleHash` and `CompositionManifest.manifestHash` use **sha256**
over canonical-JSON bytes — matching `RateScheduleRegistry.publish()` which
recomputes sha256 on-chain. The parallel `wave7/verification-commitments`
branch introduces Pedersen commitments for verifier-side commitments. These
are different layers (per-schedule content addressing vs verifier-attestation
binding) and do not conflict. If a future audit unifies the two, it will live
in the canonical-registry extraction (cross-review-00 item #6).

### Composing with workflow-runtime

For deployments that need durable, idempotent settlement orchestration, wrap
`MilestoneEscrow.release()` (which internally calls `splitPayout` when a map
is set) inside a workflow-runtime step:

```ts
// Pseudo-code; concrete API lives in @pcc/workflow on feat/workflow-runtime
await ctx.step("release-milestone", async () => {
  return milestoneEscrow.release(milestoneIndex);
});
```

The contract path is the source of truth (atomic on-chain tx, all-or-none).
The workflow step adds: durable retry on RPC blips, idempotency key derived
from `(escrowAddress, milestoneIndex)`, and a queryable run history. Use it
for off-chain payout-map collection scenarios that need to survive multi-day
signature-collection windows. For single-call settlement, the contract is
enough on its own.

A more granular checkpoint of "what just landed vs what's still pending" is
`C:/Users/globa/pcc-contributor-economics/ai/research/contributor-economics/99-resume-here.md`.

---

## In one more paragraph (the why)

The legacy OEM business model extracts rent from deployed capital — proprietary
firmware, spare-part monopolies, calibration fees. Encoding a per-job lifetime
royalty on-chain would recreate that rent structure in an immutable form
(every Bambu print flowing a cut to Bambu Labs forever, regardless of whether
Bambu's engineers contributed to that job). PCC's contributor economics
explicitly refuses that pattern. Earnings track ongoing contribution: the best
adapter wins; the best CSD wins; the best model wins; absence of contribution
earns zero. This aligns OEM incentives with open interfaces and modularity
rather than closure. That is the load-bearing thesis of `feat/contributor-economics`.

---

## Rounding behavior — where the dust goes

Basis-points splits use integer division. A 153-bps allocation against a
$100 USDC milestone (100_000_000 wei at 6 decimals) is `100_000_000 * 153 /
10000 = 1_530_000` wei exactly — no dust. But a 153-bps allocation against
a $0.07 milestone (70_000 wei) is `70_000 * 153 / 10000 = 1071` wei, which
rounds DOWN; the lossless math would have been `1071.0` exactly so no loss
here. The dust shows up when the bps × amount product isn't divisible by
10_000.

**On-chain (Solidity)**: `(distributable * bps) / 10000` truncates toward
zero (standard EVM integer division). Per-recipient rounding loss is at
most 0.999... wei.

**Off-chain (TypeScript)**: `buildPayoutMap()` and `LicensingEngine`'s
`groupBps` weighting use `Math.round()`. This rounds half-up, which
introduces a 1-bps directional bias relative to on-chain truncation under
adversarial inputs. The integration tests in
`C:\Users\globa\pcc-contributor-economics\packages\contracts\ts\__tests__\integration.test.ts`
verify the off-chain `Payout[]` produces exact balance matches with the
on-chain settlement under realistic inputs (4-recipient + 6-recipient
training-manifest expansion); under all tested scenarios the two
calculation paths agree on the final wire value.

**Where dust lands**: the operator residual. `release()` computes
`distributed = sum(payouts[i].bps applied to distributable)` and pays the
operator `(distributable - distributed) + operatorBond`. Any rounding loss
across all per-recipient transfers is silently absorbed into the operator's
residual share. At a single-milestone scale this is sub-1-wei of dust; at
$1M/day GMV it's a few cents/day. Document this for operators: "your share
is whatever's left after explicit recipients are paid; this includes
sub-bps rounding dust."

**No dust below 1 wei** — the contract uses raw token wei throughout. There
is no fractional-wei accounting.

---

## Relationship to Story Protocol — honest scoping

The original design ambition was that PCC's contributor economics would
*extend* the existing Story Protocol IP graph integration (`pcc_ip_*` MCP
tools, `/api/ip/*` routes, `StoryIPRegistration` types, `LicensingEngine`'s
derivative tree). Reality landed differently:

- **`ContributorNFT`** (`C:\Users\globa\pcc-contributor-economics\packages\contracts\src\ContributorNFT.sol`)
  is a fresh ERC-721 + ERC-2981 contract. It does NOT mint itself as a
  Story Protocol `IPAsset`. The `ipId` field on a ContributorNFT is a
  reference to a Story IP Asset *if one exists*; it is not used to drive
  any on-chain Story Protocol operation in v1.
- **`TrainingManifest`** is a separate concept stored in `@pcc/db`'s
  `training_manifests` table; it does NOT register dataset→model edges
  with Story Protocol's derivative graph.
- **`/api/contributors/*`** routes are parallel to (not extensions of)
  `/api/ip/*`. The two surfaces share the same database (Drizzle) but have
  separate Zod schemas, separate route handlers, separate MCP tools.
- **`pcc_contributor_*` and `pcc_schedule_*` MCP tools** are parallel to
  `pcc_ip_*` (the existing Story Protocol-backed tools), not replacements.

**Why the parallel path**: the contributor-economics primitives (immutable
`RateSchedule`, `CompositionManifest` with role-tagged entries,
`TrainingManifest` for recursive model→dataset attribution) are different
enough in semantics from Story Protocol's derivative-tree-with-decay model
that a clean separation was lower-risk than retrofitting.

**v2 unification path**: a future branch should converge the two graphs.
Specifically:
1. Mint each `ContributorNFT` as a Story Protocol `IPAsset` at registration
   time, capturing the same `ipId` in both registries.
2. Map `CompositionManifest` entries to Story Protocol derivative
   registrations so a single graph traversal covers both contributor splits
   and IP licensing decay.
3. Deprecate `pcc_contributor_*` in favor of extended `pcc_ip_*` tools
   (e.g., `pcc_ip_set_rate_schedule`, `pcc_ip_link_training_data`).

Until that work lands, treat `ContributorNFT` and `StoryIPRegistration` as
**two coordinated registries that point to the same logical IP** rather
than as a unified graph.

**Audit + migration plan**: a row-by-row audit of all 8
`/api/contributors/*` routes and all 7 contributor MCP tools (50-56)
against `/api/ip/*` and `pcc_ip_*` is in
[`ai/research/contributor-economics/20-api-unification-audit.md`](../ai/research/contributor-economics/20-api-unification-audit.md).
The migration plan, the per-surface pay-model split, and the deprecation
schedule for the v2 cutover are documented in `docs/AGENT_INTEGRATION.md`
§12.7 ("Contributor Economics ↔ Story Protocol IP routes — relationship +
migration path"). Headline result: zero v1 deprecations because there are
zero v1 operation-level duplicates; every contributor route targets a
distinct on-chain pay rail (`MilestoneEscrow.splitPayout`) from the
Story-Royalty-Vault rail used by `/api/ip/*`.

---

## Open scope cuts (deliberate, documented in `99-resume-here.md`)

These are **not** "we forgot" — they are explicit deferrals with
prior-art research already in tree. Listed here so external readers don't
mistake the v1 scope for the eventual v2 scope:

- **Cross-chain `ContributorNFT` portability** (LayerZero ONFT or CCIP).
  Today the NFT lives on whichever chain `ContributorNFT.sol` is deployed
  to. Sovereign-network identity with cross-network earnings requires
  this; v1 ships single-chain.
- **zkML training attestation** for `model-author` and
  `dataset-contributor`. v1 relies on `methodologyHash` commit +
  reputational slashing; v2 will add cryptographic proof that a specific
  training mix was actually used.
- **Production audit**. 109 forge tests + 230 TS tests pass. No external
  audit. Required gate before mainnet.
- **Live-flow validation**. The deploy scripts
  (`C:\Users\globa\pcc-contributor-economics\packages\contracts\script\DeployContributorEconomics.s.sol`,
  `C:\Users\globa\pcc-contributor-economics\packages\contracts\script\PublishSchedule.s.sol`,
  `C:\Users\globa\pcc-contributor-economics\packages\contracts\script\MintContributor.s.sol`)
  exist and forge-compile but have **never** been broadcast to Base
  Sepolia. No human has performed an end-to-end flow against the live
  gateway yet.
- **Dashboard publish/browse UI**. The 5 dashboard files updated by Wave 4d
  added role-aware colors and split presets but did NOT add a
  "publish my RateSchedule" wizard, a "browse other contributors'
  schedules" gallery, or an evaluation sandbox. v2 work.
