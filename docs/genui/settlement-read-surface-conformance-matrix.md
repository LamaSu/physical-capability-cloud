# Settlement read-surface conformance matrix (v1.5)

**Purpose:** the implementable conformance target for the neutral settlement read routes (receipt / lifecycle /
provenance) AND the gen-UI client, derived from [`settlement-read-surface-contract.md`](./settlement-read-surface-contract.md)
(rule numbers below refer to it). It turns the prose rules into golden per-state expectations a test writer implements.
**Run it against the real candidate contract, the real mapper and the real kit render, not only parallel mocks:** the
honesty guarantee is end-to-end or it is nothing. Building the routes to pass it is the launch gate for any surface that
renders settlement.

Current implementation: `packages/gateway/src/routes/settlement-read.ts` and `packages/gateway/src/settlement/unit-state-mapper.ts`,
tested in `packages/gateway/src/__tests__/settlement-read-routes.test.ts` and `unit-state-mapper.test.ts`.

**Universal assertions (every row):** no `settled` / `paid` / `success` / `verified` boolean and no receipt-exists
boolean appears in ANY DTO; every DTO carries `{chainId, escrow, network, asOfBlock, asOfBlockHash, revision}`;
economics come from the frozen, release-verified record, never a raw attestation or EAS mirror; the kit renders each DTO
with **no semantic collapse** (an adversarial manifest cannot relabel a field: the trusted component owns outcome labels).

**Field source (the route is HYBRID, rule 21):** `finalState` / `unitState` / economics / windows are
**staticcall-authoritative** at the pinned `{asOfBlock, asOfBlockHash}` (reorg-safe). `refundReason` and `finalizedBlock`
are **LOG-derived** (reorg-exposed): they exist only in event logs. Every log-derived field MUST carry an explicit source
marker, so a possibly-reorgable value is NEVER rendered identically to a staticcall-confirmed one. The money-critical
claim is safe: rule 12 keys `finalState` off `unitState() ∈ {8, 9}`, which stays staticcall.

## §A: the 10-state golden (receipt + lifecycle)

**Updated 2026-09-24 per escrow's ruling #3163: the target is master's routes.** The earlier rows (a 404 or "no receipt"
for states 1-5; `finalState: RELEASE_ALLOCATED` / `REFUND_ALLOCATED` for 6/7, from #667) are SUPERSEDED, for two reasons:
- 404 must stay the unambiguous "this unit does not exist";
- `finalState` means TERMINAL (rule 12). A receipt exists from allocation onward while money can still be outstanding.

| unitState | /receipt | finalState | isAllocated | finalizedBlock | phase | presentation (kit, #313) |
|---|---|---|---|---|---|---|
| 0 AWAITING_FUNDING | **503** (fails closed; never a real unit) | n/a | n/a | n/a | n/a | **never returned** (see the state-0 note) |
| 1 FUNDED_ACTIVE | 200 | null | false | null | `active` | "active - funds committed, no outcome yet" |
| 2 PRIMARY_ASSERTED | 200 | null | false | null | `contest` | "primary assertion accepted - not final" |
| 3 CHALLENGED | 200 | null | false | null | `contest` | "challenged - not final" |
| 4 BACKUP_PENDING | 200 | null | false | null | `escalation` | "escalated to backup - not final" |
| 5 BACKUP_ASSERTED | 200 | null | false | null | `escalation` | "backup assertion accepted - not final" |
| 6 RELEASE_ALLOCATED | 200 | null | **true** | null | `allocated` | "release decided - payout outstanding" |
| 7 REFUND_ALLOCATED | 200 | null | **true** | null | `allocated` | "refund decided - payer not yet refunded" |
| 8 SETTLED_RELEASED | 200 | `SETTLED_RELEASED` | false | non-null | `settled` | "released - payout distribution discharged" (the ONLY green) |
| 9 SETTLED_REFUNDED | 200 | `SETTLED_REFUNDED` | false | non-null | `settled` | "**refunded - payer refunded, payees NOT paid**" |

- **404 `UNKNOWN_UNIT`** is answered only for an unknown unit, and indistinguishably for another tenant's (rule 7).
- **The 6-vs-7 direction comes from `unitState`, never from `finalState`.**
  - `/lifecycle` already carries `unitState`. Gateway is adding the staticcall `unitState` to `/receipt` (additive, #3163).
  - Until then, a `/receipt`-only read of 6/7 shows "outcome decided - not yet paid out", with no direction.
- **Pinned by** `packages/gateway/src/__tests__/settlement-read-money-status.test.ts` (#313). It classifies the routes' own bodies for states 1-9, and a receipt with `unitState`, with the spec and the shipped kit.

Assert per row: `isTerminal == finalState ∈ {SETTLED_RELEASED, SETTLED_REFUNDED}`; `operatorPaid == (finalState == SETTLED_RELEASED)`
(as a test rule, NOT a DTO boolean); `finalizedBlock` null iff not terminal; the exact `phase`; `windowEndsAt` / `windowKind`
present for states 2-5 and computed from contract state plus frozen constants at `asOfBlock`, never wall clock.

**`finalizedBlock` derivation (anti-trap):** null in 6/7 and non-null in 8/9 as tabled, BUT derive the value from the
block of the `dischargeClaim` that zeroed `remainingClaimCount`, NOT from the `Finalized` event. `Finalized` fires at
ALLOCATION (entering 6/7), so keying `finalizedBlock` off it makes it non-null at state 6 and breaks rows 6/7. The real
6→8 / 7→9 flip emits no `Finalized` (only `ClaimDischarged`). It is an intermittent trap: when every leg pays inline, the
allocation block equals the settlement block and the naive derivation is accidentally right. LOG-derived and source-marked.
**Reader-port obligation:** the mapper's `deriveFinalizedBlock` TRUSTS its input block; it cannot itself prove the caller
passed the zeroing-`dischargeClaim` block rather than an allocation-time `Finalized` block. So this anti-trap is a contract
on the concrete `SettlementUnitReader` (`readZeroingDischargeBlock`), not on the pure function. When a live reader is wired,
check this hardest.

**State 0 (AWAITING_FUNDING) is unreachable:** a unit is registered as existing only after its state is set to
FUNDED_ACTIVE, so an existing unit is always ≥ state 1, and `unitState()` is `onlyExisting`, reverting `UnitNotFound` for
a non-existent unit. There is no block where `unitState()` returns 0. **The route must map the `UnitNotFound` revert to
404 / `UNKNOWN_UNIT`, NOT to a state-0 branch.** A mapper that decodes a revert or decode failure as "state 0" would
render "awaiting funding" for a unit that does not exist (fail open). Only states **1-5 and 8-9 are guaranteed
observable**; 6/7 are skippable (see the fixture note in §B); 0 is unreachable.

**States 2 vs 5:** both use the SAME window (`assertedAt + CHALLENGE_WINDOW`). They are distinguished by `backupLane_`
(from `settlement()`), NOT by window arithmetic. Key off `unitState` + `backupLane_`.

## §B: money-outcome fixtures → expected DTO
1. Release, every leg discharged → state 8, `refundReason: NONE`.
2. Release, one **principal** claim pending → state 6, `finalizedBlock: null`, presentation "payment incomplete".
3. Release, one **fee** claim pending → state 6 (same); auxiliary status exposed separately (rule 18).
4. Refund, refund claim pending → state 7.
5. Terminal release after the final job-claim discharge → state 8; but if an **auxiliary** bond / delay-compensation / burn claim remains, the DTO must NOT assert "all funds paid" (rule 18): expose `auxiliaryClaimsOpen: n` or omit any total-payment statement.
6. Terminal refund → state 9, `refundReason` = the exact cause, **LOG-derived and source-marked** (not staticcall-derivable: the refund allocation emits `RefundAllocated(unitId, remaining)` with no cause). **Five witnessed causes:** appeal overturn (`EscalationResolved` role = APPEAL, upheld = false), emergency overturn (`EscalationResolved` role = EMERGENCY), emergency silence (`Finalized false, 3`), backup no-release (`Finalized false, 2`: one code for backup timeout and backup reject, since the BACKUP_PENDING → refund branch exits only on the assertion cutoff), and deadline reclaim (`reclaimAfterDeadline` → a bare `RefundAllocated`, identifiable by elimination only until escrow adds an explicit discriminator). Never collapse the five that ARE distinct.
7. Tier-0 payer approval → `authorizationType: BUYER_APPROVAL`, `vcrReceiptPointer` set; NOT an evidence path.
8. Tier 1-3 unchallenged release → `authorizationType: EVIDENCE`.

**Fixture construction:** states 6/7 are SKIPPABLE. If every leg discharges inline, a unit goes 1 → 6 → 8 in one tx
and is never observable at 6. To produce an observable state-6 fixture, one leg must be one that the exact-transfer path
cannot discharge (a collateralized-claim fallback). Not a contract defect: a test-authoring requirement so the row-6
assertions actually exercise state 6.

## §C: domain / asset-reality fixtures (rule 15, fail closed)
- Base mainnet + canonical Circle USDC (`0x8335…`) + approved deployment tuple → `assetReality: "real"`.
- Base Sepolia + canonical test USDC (`0x036C…`) → `assetReality: "test"`.
- Base mainnet + a token with symbol `USDC` that is NOT `0x8335…` → **`assetReality: "unknown"`** (fail closed; NEVER "real").
- Wrong factory / implementation codehash / non-canonical `escrow.USDC()` → `"unknown"` (tuple mismatch).
- Mixed-network provenance DAG → each node carries its own `network`; visibly mixed, never merged as one reality.

## §D: provenance fixtures (rule 19, discriminated union)
- Root anchored + preimage available → `provenanceAvailability: AVAILABLE`.
- Root anchored + preimage withheld → `WITHHELD` (a **200**, honest; NOT a 404, NOT an empty AVAILABLE).
- No anchor → `UNANCHORED`.
- Stale EAS mirror before terminal settlement → the route reads `unitState()` at `asOfBlock`, NOT the mirror snapshot; the mirror never upgrades `WITHHELD` → `AVAILABLE`.
- EAS unavailable / composition-root mismatch → the material yields `null` / `UNAVAILABLE`, never a fabricated value.

## §E: block-consistency fixtures (rules 16, 22-26)
- A claim discharge mined between two reads → all values come from ONE pinned `asOfBlock` + `asOfBlockHash`; the mapper must NOT combine a `RELEASE_ALLOCATED` state with a `remainingClaimCount == 0` that never coexisted (torn read → reject).
- A reorg replacing the allocation or finalization block → `409 REORG / REVISION_MISMATCH`, re-read.
- Indexer ahead of or behind RPC → never join a live contract read to an unversioned indexer row.
- A read taken at Base's `latest` / `safe` (non-finalized) head → marked non-final or refused; only the `finalized` head hash renders as confirmed (rule 22).
- A log-derived field while the indexer lags the pinned block → `UNKNOWN`, NEVER an absence-based inference (no "no cause ⇒ released"; no by-elimination `DEADLINE_RECLAIM`) (rule 23).
- **Cross-route tear:** receipt@blockA + lifecycle@blockB + provenance@blockC, each internally consistent but stitched by Surface A → REJECT. Require a shared `?asOf=<finalizedBlockHash>` across all three (or an aggregate endpoint); the DTOs' `{asOfBlock, asOfBlockHash}` must match across routes or `409 REVISION_MISMATCH` (rule 24).
- An off-chain registry (assetReality / tenant / provenance) revised between the on-chain pin and the registry read → each carries its OWN effective-at / revision in the enriched source envelope `{value, source, chain, contractOrRegistryId, blockNumber, blockHash, finality, completeness}`; the cursor binds the COMPLETE snapshot (rule 25).
- `assetReality: "real"` on a paused or blacklisted canonical USDC → still `"real"` (identity holds), but the render MUST NOT imply settlement is possible; token liveness is a separate, non-authoritative signal (rule 26).

## §F: cohort-disable honesty (rule 20)
- Cohort disabled, and the unit had an **already-accepted** assertion → the unit can still reach state 8; the render shows the ACTUAL state, NEVER "cancelled" / "refund guaranteed" / "no payment".

## Cross-tenant
- A cross-tenant caller → authorize BEFORE returning existence or metadata; forbidden and unknown are indistinguishable; cursors are bound to `{tenant, root, revision, asOfBlock, asOfBlockHash}`.

---
Ownership: the ROUTES that must pass this are the neutral gateway / provenance-registry component; gen-UI owns the client
DTOs and the kit render assertions here. This matrix is the shared conformance target for both. Rows in §A-§B were
verified line by line against `VNextSettlementEscrow.sol@7f2c6ff5` by the escrow lane (2026-08-07) and re-verified by gen-UI.
