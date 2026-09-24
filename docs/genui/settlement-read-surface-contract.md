# Settlement read-surface contract: receipt, provenance, lifecycle (v1.5)

**Status:** design contract. The routes are implemented in
`packages/gateway/src/routes/settlement-read.ts`, which cites the rule numbers below (rules 1-26).
Until a concrete `SettlementUnitReader` is registered, the routes answer `INDEX_NOT_READY`.
The golden per-state test target is [`settlement-read-surface-conformance-matrix.md`](./settlement-read-surface-conformance-matrix.md).

## Implemented on master: what the routes return today (bind to THIS, not the design DTO below)

The DTOs further down are the v1.5 contract as agreed (coord #666 -> #712 -> #733). The routes on master were built
to it **through escrow's DTO mapping (#667)**, which changes the shape. This section was verified against
`routes/settlement-read.ts` and `settlement/unit-state-mapper.ts` at master `ac86a404` (2026-09-24). A consumer
that binds the design shape misreads real data; genui's own #313 did (see below).

| | `GET .../lifecycle` | `GET .../receipt` |
|---|---|---|
| status | 200 for states 1-9; **503 for state 0** (fails closed; both routes share one prelude); 404 `UNKNOWN_UNIT` for an unknown unit and, indistinguishably, for another tenant's | same |
| context | `chainId`, `escrow`, `unitId`, `asOfBlock` (a string), `asOfBlockHash`, `finality`, `logCompleteness` | same, plus `network: { chainId }` (an object, not a `"base-mainnet"` string) |
| state | `unitState` (a NUMBER, 1-9), `phase`, `finalState`, `isTerminal`, `isAllocated`, `windowEndsAt` | `finalState`, `phase`, `isAllocated` (no `unitState`, no `isTerminal`) |
| money | none | `economics` (`{amount, feeAmount, recipient, token, assuranceTier}` or null); `assetReality` (`{value, source: "registry", contractOrRegistryId, revision, attests: "identity-not-liveness"}` or null); `refundReason` and `finalizedBlock` (`"UNKNOWN"`, a source-marked value, or null) |

Field semantics (unit-state-mapper):
- `finalState` is `"SETTLED_RELEASED"` or `"SETTLED_REFUNDED"` for states 8/9 and **null for every other state**. It is never `RELEASE_ALLOCATED` / `REFUND_ALLOCATED` (the design DTO's non-terminal values).
- `isTerminal` is true for 8/9 only. `isAllocated` is true for **6/7 ONLY** ("outcome decided, money NOT fully moved"), so a settled body says `isAllocated: false`.
- `phase`: 1 `active`; 2-3 `contest`; 4-5 `escalation`; 6-7 `allocated`; 8-9 `settled`.
- The receipt route answers 200 for states 1-5 too (`finalState: null, isAllocated: false`), not the golden matrix's 404.
- Not emitted yet (design fields): `authorizationType`, `authorizationId`, `vcrReceiptPointer`, `evidenceBundleHash`, `verdictHash`, `oracleAuthEpoch`, `compositionRoot`, `allocatedBlock`, and a root-level `revision`.

**Consumer rule (Surface A).** Settled-green comes only from a consistent state 8. That means `/lifecycle` with
`unitState: 8`, `finalState: "SETTLED_RELEASED"`, `isTerminal: true`, `isAllocated: false` and `phase: "settled"`,
or `/receipt` with `finalState: "SETTLED_RELEASED"`, `isAllocated: false` and `phase: "settled"`. Any disagreement or
missing field is unknown. `@pcc/spec` `classifySettlementRecord` implements this (#313), pinned by a gateway suite that
classifies the routes' own bodies (`settlement-read-money-status.test.ts`, #313).

**Why this section exists.** #313's first cut assumed `isAllocated` was true for 6-9, since the implemented shape
was never written down. A genuinely settled unit therefore rendered "fields disagree" and never went green. Found by
checking the real routes; fixed in #313 @7061730a.

**Resolved by escrow's ruling #3163 (the money-semantics owner): the target is master's routes.**
- The golden matrix §A is updated to match them; the #667 rows it replaced are superseded.
- The one additive change: gateway adds the staticcall `unitState` to `/receipt`, so a receipt-only consumer can tell 6 (release decided) from 7 (refund decided).
- Consumers key that direction off `unitState`, never off `finalState`. #313's classifier already accepts it.

**Serves (read-only, one build, two consumers):** the gen-UI settlement render ("Surface A": value chain + settlement)
and composition's child-accepts-parent digest check.

**Ownership:** the routes and their content-addressed storage are a **neutral** gateway / provenance-registry
component, **not** a gen-UI endpoint (a UI lane must not own a backend endpoint that composition also consumes).
This document is gen-UI's **consumer contract**: the client DTOs it binds, and the render-versus-verify invariants
the neutral routes must satisfy. gen-UI owns the Surface A rendering and its client DTOs; composition owns the root
schema, validator and derivation; the gateway / provenance registry owns the routes and data-availability persistence.

Gateway conventions: camelCase DTOs, `Result<T>`, string enums, `(chainId, escrow, settlementUnitId)` refs.

---

## The one load-bearing rule
A read returns the **record plus the material to verify it**. It must **never itself assert that the record is sound**:
no `verified: true`, no `paid: true`, no `settled: boolean`, no inline signature. Surface A renders a neutral pointer;
a trusted verifier (or the execution runtime's signed receipt) asserts soundness out of band. The DTOs enforce this
by **omitting** every field a naive renderer would show as proof.

---

## Route 1: settlement receipt
`GET /api/settlement/units/:unitId/receipt` → `Result<SettlementReceiptDTO>`

```ts
type SettlementReceiptDTO = {
  unitId: string; chainId: number; escrow: string;        // domain context: a bare unitId is not portable or renderable
  network: "base-mainnet" | "base-sepolia";               // derived server-side from chainId, so Surface A shows a TEST badge without a UI-side chain table. A test-USDC settlement must NEVER render as a real payment.
  finalState: "SETTLED_RELEASED" | "SETTLED_REFUNDED" | "RELEASE_ALLOCATED" | "REFUND_ALLOCATED"; // STRING enum, NEVER a settled boolean (REFUNDED is a settlement where the operator was NOT paid).
  // A RECEIPT EXISTING DOES NOT MEAN SETTLED. The receipt is written at ALLOCATION and finalized when the last claim
  // discharges. Normally that is the same tx, but a payout leg that falls back to a collateralized claim (the
  // recipient transfer reverts, so a claim is recorded instead of discharged) leaves the unit in *_ALLOCATED with the
  // receipt PRESENT and finalState NON-TERMINAL.
  // RULE: Surface A keys settlement off finalState ∈ {SETTLED_RELEASED, SETTLED_REFUNDED} and renders every other
  // value as IN PROGRESS. Treating receipt presence as the settlement signal is the refund-as-paid error one layer deeper.
  authorizationType: "EVIDENCE" | "BUYER_APPROVAL" | "DISPUTE" | "RECLAIM";
  refundReason:                                           // the causes are NOT interchangeable to a user ("an appeal overturned your settlement" is not "nobody showed up").
                                                          // LOG-derived, not staticcall-derivable: unitState() returns 7/9 with no cause, and _allocateRefund emits
                                                          // RefundAllocated(unitId, remaining) with no discriminator; the cause lives only in the companion event of
                                                          // the calling path. It is index-derived (reorg-exposed): mark it per rule 21.
    | "NONE" | "EVIDENCE_FAIL" | "DISPUTE_PAYER_WIN"
    | "APPEAL_OVERTURN" | "EMERGENCY_OVERTURN" | "EMERGENCY_SILENCE"
    | "BACKUP_NO_RELEASE"                                  // one code for backup timeout and backup reject: the BACKUP_PENDING -> refund branch exits only on the
                                                          // assertion cutoff and emits Finalized(unitId, false, 2) for both, so "backup reject" is not a distinctly witnessable path.
    | "COHORT_REVOKED" | "DEADLINE_RECLAIM";               // DEADLINE_RECLAIM (reclaimAfterDeadline) emits a BARE RefundAllocated with no companion event, so it is
                                                          // identifiable only BY ELIMINATION, which any future bare-RefundAllocated path silently breaks.
                                                          // Open ask to escrow: emit an explicit discriminator so the cause is witnessed, not inferred.
  authorizationId: string;                                // EAS UID | dispute id | reclaim id | (buyer path:) the execution receipt id
  vcrReceiptPointer: string | null;                       // NON-null ONLY when authorizationType == "BUYER_APPROVAL": the execution receipt id to DEFER to. Never an inline signed receipt.
  evidenceBundleHash: string | null;                      // hex; null off the evidence path
  verdictHash: string | null;                             // hex; evidence path
  oracleAuthEpoch: number | null;                         // cohort id; evidence path
  compositionRoot: string | null;                         // hex; null = non-composed. The anchor a verifier proves preimages against (Route 2).
  // Allocation is split from finalization. A *_ALLOCATED receipt has NO settlement block yet: do NOT fabricate one.
  allocatedBlock: number;                                 // block the receipt was written (ALWAYS present)
  finalizedBlock: number | null;                          // block the last claim discharged: NULL until finalState ∈ {SETTLED_RELEASED, SETTLED_REFUNDED}.
                                                          // (finalizedBlock is not finality; a cross-chain consumer still needs a state proof.)
                                                          // Do NOT key this off the `Finalized` EVENT: Finalized fires at ALLOCATION (entering 6/7), so keying off it
                                                          // makes finalizedBlock non-null at state 6. The true settlement block is the block of the dischargeClaim that
                                                          // zeroed remainingClaimCount, which emits only ClaimDischarged. LOG-derived (reorg-exposed): mark per rule 21.
  // Asset reality and RELEASE-VERIFIED economics (rule 14). assetReality is a registry-derived classification, NOT inferred
  // from chainId alone (a fake mainnet token could pose as USDC).
  assetReality: "real" | "test" | "unknown";              // rule 15: registry-derived from the DEPLOYMENT TUPLE, never chainId; FAILS CLOSED to "unknown" for an unrecognized token
  amount: string;                                         // release-verified raw integer amount in base units, NOT the raw attestation field
  tokenContract: string;                                  // the settled asset's contract address
  tokenDecimals: number;                                  // to render `amount`
  asOfBlock: number; revision: number;                    // freshness / revision
};
```
- **No `verified` field.** Verification is out of band. A renderer that wants help gets a SEPARATE
  `GET .../receipt/verification` that a trusted verifier populates; it is never folded into this read.
- Tenant-scoped and authenticated: Surface A receives tenant-scoped authenticated data, not a public firehose.

## Route 2: provenance / lineage (the build-once)
`GET /api/settlement/units/:unitId/provenance?depth=<1..N>&limit=<1..MAX>&cursor=<opaque>` → `Result<ProvenanceDTO>`

```ts
type UnitRef = { chainId: number; escrow: string; settlementUnitId: string };

// Fields present in EVERY provenance response regardless of availability.
type ProvenanceBase = {
  unit: UnitRef;
  network: "base-mainnet" | "base-sepolia"; // this unit's network, server-derived from unit.chainId (same derivation as Routes 1/3). Each node carries its OWN chainId, so a mixed-network lineage is visibly flagged, never silently merged (rule 11).
  compositionSchemaVersion: number;
  // --- bounded DAG for the render (a DAG is unbounded, so this MUST page) ---
  nodes: Array<{ ref: UnitRef; receiptPath: string; finalStateHint: string | null }>; // links to Route 1; receiptPath is ROOT-RELATIVE
  edges: Array<{ from: UnitRef; to: UnitRef; kind: "provenance" | "value-flow" }>;
  // REAL pagination: `depth` is not a size bound (depth 1 can still return millions of children). `limit` caps the page;
  // results are STABLY ordered; `cursor` is opaque and BOUND to {compositionRoot, revision, asOfBlock} so pages cannot overlap or shift mid-traversal.
  depth: number; limit: number; hasMore: boolean; cursor: string | null;
  asOfBlock: number; revision: number;      // rule 8 requires freshness on ALL THREE routes; the cursor binds to these.
};

// A discriminated union on provenanceAvailability. Each state carries exactly the fields valid in that state, so an
// implementer CANNOT fabricate empty roots/proofs in AVAILABLE (rule 10) or populate them in UNANCHORED.
type ProvenanceDTO =
  | (ProvenanceBase & {
      provenanceAvailability: "AVAILABLE";
      compositionRoot: string;              // on-chain root (hex): the anchor a verifier proves preimages against
      outputContentDigest: string;          // hash-namespace-prefixed subject leaf
      // --- the preimage leaves the root commits to (what makes the 32-byte root usable) ---
      parents: Array<{ ref: UnitRef; expectedReceiptDigest: string; expectedEvidenceDigest: string }>; // child -> ancestor; the index-free child-accepts-parent check
      attribution: Array<{ party: string; weightBps: number; role: "contributor" | "fee" | "royalty"; capabilityId: string | null }>; // a DISTINCT dimension from PayoutLeg bps: do NOT force equality
      capabilityIds: { input: string[]; output: string[] };
      reservedChildEdges: Array<{ childEscrow: string; childUnitCommitment: string; amount: string; flowEdgeId: string }>; // ACTUAL reserved funding edges only; advisory "intended children" excluded
      // Proofs are a ROOT-RELATIVE same-origin PATH, NEVER an absolute URL: a naive consumer must never attach its credential to an attacker-supplied absolute href.
      merkleProofPath: string;              // per-leaf proofs; a verifier checks preimage ∈ compositionRoot. The read renders; it does NOT assert the split is correct.
    })
  | (ProvenanceBase & {
      provenanceAvailability: "WITHHELD";   // root committed on-chain, preimage NOT served: render "unverifiable", never "no lineage"
      compositionRoot: string;
      outputContentDigest: string;
      parents: []; attribution: []; reservedChildEdges: []; // preimage arrays EMPTY by construction
      capabilityIds: { input: []; output: [] };
      merkleProofPath: null;
    })
  | (ProvenanceBase & {
      provenanceAvailability: "UNANCHORED"; // non-composed, OR data availability never anchored
      compositionRoot: null;
      outputContentDigest: null;
      parents: []; attribution: []; reservedChildEdges: [];
      capabilityIds: { input: []; output: [] };
      merkleProofPath: null;
    });
```
- **child → ancestor is index-free; parent → descendant is NOT.** `parents[]` resolves without an index, but a
  forward "who consumed me" view needs a separate index; this route does not promise it.
- **Index-free child-accepts-parent requires** that the child authenticate the parent's **implementation/factory**
  (not any address exposing `receiptOf`: the counterfeit-clone guard), and it works **same-chain** only.

---

## Route 3: live lifecycle (states 2-5 are invisible to the receipt route)
`GET /api/settlement/units/:unitId/lifecycle` → `Result<LifecycleDTO>`

The settlement state machine has 10 states. The receipt (Route 1) is written only at ALLOCATION (states 6-9), so the
pre-outcome states, the ones a payer or operator most needs to see ("your settlement is in a 2-day challenge window",
"an appeal is running, decision by ..."), have no receipt and would otherwise render as "nothing happened yet". This
route serves them, **separately from the receipt**. Do NOT widen `finalState` to 10 values: that recollapses in-flight
and settled.

```ts
type LifecycleDTO = {
  unit: UnitRef;
  network: "base-mainnet" | "base-sepolia";     // same derivation as the receipt (chainId frozen per unit at funding)
  // The FULL 10-state machine (VNextSettlementLib enum) as a STRING. This route owns the in-flight half; the receipt route owns settlement.
  unitState:
    | "AWAITING_FUNDING" | "FUNDED_ACTIVE"      // 0-1. AWAITING_FUNDING(0) is UNREACHABLE via the route: a unit exists only once it is FUNDED_ACTIVE, and
                                                // unitState() reverts UnitNotFound for a non-existent unit. A pre-funding or non-existent unit is
                                                // UNKNOWN_UNIT -> 404 (error union), NOT an "AWAITING_FUNDING" DTO. Never render "awaiting funding" off a decode failure.
    | "PRIMARY_ASSERTED" | "CHALLENGED"         // 2-3: challenge / appeal window running
    | "BACKUP_PENDING" | "BACKUP_ASSERTED"      // 4-5: primary lane closed, operator escalated
    | "RELEASE_ALLOCATED" | "REFUND_ALLOCATED"  // 6-7: allocated; the RECEIPT now exists (Route 1); a claim may still be undischarged
    | "SETTLED_RELEASED" | "SETTLED_REFUNDED";  // 8-9: terminal
  phase: "funding" | "active" | "contest" | "escalation" | "allocated" | "settled"; // PCC-owned coarse grouping for the render, derived server-side from unitState, never manifest-supplied
  // Frozen deadline of the CURRENT window, so the render can show "decision by <date>". Null when no window is running.
  windowEndsAt: string | null;                  // ISO
  windowKind: "challenge" | "appeal" | "backup" | "reclaim" | null;
  asOfBlock: number; revision: number;
  // NO amounts or economics here: those live on the receipt (Route 1). This route is STATE + TIME only.
};
```
- **Render, don't assert:** show the state, window and deadline. The *outcome* (who was paid) comes from the receipt
  once allocated or terminal, never inferred from a lifecycle state.
- Same neutral-component ownership, tenant scoping and `Result<T>` error union (including `UNKNOWN_UNIT` /
  `TENANT_FORBIDDEN`) as Routes 1 and 2.

---

## Build-it-right checklist (each line names the failure it prevents)
1. `finalState` and `refundReason` are STRING enums, never a boolean → prevents a refund rendered as a payment.
2. The reads carry NO soundness assertion (`verified` / `paid` / `settled` / inline signature) → prevents the render surface becoming a second consent authority.
3. `vcrReceiptPointer` is a POINTER on the buyer path only; the settlement receipt is never signed "the execution-runtime way" → outcome ≠ consent stays true.
4. Every DTO carries `{chainId, escrow}` → renders and DAG refs resolve; a bare unitId does not.
5. Route 2 PAGES (`depth` + `limit` + `cursor`) → an unbounded DAG read is a DoS.
6. `attribution.weightBps` is separate from PayoutLeg bps → a fee leg is paid but is not a contributor; a contributor may be unpaid.
7. `reservedChildEdges` = actual reserved edges only (advisory children excluded) → no closed-world-DAG griefing.
8. Tenant-scoped, authenticated, and `revision` / `asOfBlock` on **all three routes** → freshness and authenticated data.
9. Merkle proofs are a fetchable **root-relative same-origin `merkleProofPath`** (never an absolute href: a naive consumer must not attach its credential to an attacker-supplied URL); verification is a separate act → the render defers to a sound anchor.
10. `provenanceAvailability` (AVAILABLE / WITHHELD / UNANCHORED) is a first-class field → a withheld-preimage-but-settled unit renders as "provenance unverifiable", never as clean or as "no lineage" (a root gives integrity, not availability).
11. `network` is server-derived from `chainId`; **`assetReality` is REGISTRY-derived, never chainId-derived** (a fake mainnet token could pose as USDC), on every DTO → a test-USDC settlement can never render as a real payment; mixed-network lineage is flagged, not silently merged.
12. Settlement is keyed off `finalState` ∈ {SETTLED_RELEASED, SETTLED_REFUNDED}, **never off receipt existence** (the receipt is written at allocation; a collateralized-claim fallback leaves it present but non-terminal) → an allocated-but-undischarged unit renders as IN PROGRESS.
13. `{chainId, escrow}` are MANDATORY on every DTO from every route, never a bare `unitId` (a consumer needs the address to query on-chain, even though `settlementUnitId` is globally unique by construction).
14. Economics fields (feeBps, feeRecipient, amounts, achievedTier) come from the RELEASE-VERIFIED frozen escrow record, NEVER from raw attestation fields → a raw attestation can record economics that disagree with what was actually paid; render only release-verified value.

## Design questions (answered with the escrow lane)
- **A.** TWO routes (not `?view=`): different cache and auth profiles.
- **B.** UNIT-KEYED paths (`/api/settlement/units/:unitId/*`); `{chainId, escrow}` mandatory on every DTO.
- **C.** The NEUTRAL provenance component (not escrow, not gen-UI) serves the proof path; composition owns the derivation and validator.
- **D.** There is **no `UnitSettled` event**; the only on-chain read is `unitState()`. Surface A polls the lifecycle route (Route 3) and reads the receipt (Route 1) once `unitState` reaches allocated (6-7) or terminal (8-9). Key settlement off `finalState`, never receipt presence.

## Failure semantics: the `Result<T>` error union
Every route returns `Result<T>`; the error side is a DEFINED union so consumers handle it deterministically:
- `UNKNOWN_UNIT` → 404 · `TENANT_FORBIDDEN` → 403. To a cross-tenant caller, 403 and "unknown" SHOULD be indistinguishable (do not leak existence). Not retryable.
- `INVALID_CURSOR` / `EXPIRED_CURSOR` (the revision moved under the cursor) → 409; restart pagination. Retryable.
- `REORG` / `REVISION_MISMATCH` (asOfBlock superseded) → 409; re-read. Retryable.
- `INDEX_NOT_READY` (provenance index still building, or no reader registered) → 503 + `Retry-After`. Retryable. Distinct from `WITHHELD`.
- **`DA_UNAVAILABLE` is NOT an error.** It is `provenanceAvailability: "WITHHELD"`, returned **200** so the surface renders it honestly (absence of a preimage is not absence of lineage).

---

## v1.3: cross-layer settlement-honesty refinements (2026-08-06)
A cross-layer review confirmed the design above and added rules 15-20. Each is something the neutral routes MUST satisfy.

15. **`assetReality` binds the DEPLOYMENT TUPLE and FAILS CLOSED.** `assetReality = "real"` ONLY when ALL of these match an approved immutable deployment record: `{chainId, factory, implementation codehash, escrow-clone provenance, escrow.USDC(), the canonical Circle USDC for that chain, deployment marked canonical and approved}`. Canonical Circle USDC: Base mainnet `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, Base Sepolia `0x036CbD53842c5426634e7929541eC2318f3dCF7e`. An unrecognized token on any chain is `"unknown"`, NEVER `"real"`: chainId alone is insufficient.
16. **Block consistency: one pinned block, hash-anchored.** Read EVERY value in a response at ONE block. All three DTOs carry **`asOfBlockHash: string`** alongside `asOfBlock`. NEVER join a live contract read to an unversioned indexer row: a claim discharged between two "latest" reads yields a torn record that never coexisted (for example a `RELEASE_ALLOCATED` state joined to a `remainingClaimCount == 0` counter). Reorg / revision mismatch → 409. The cursor binding includes `asOfBlockHash`.
17. **The exact 10-state → presentation table (the mapper spec).** A single `settled` / `paid` / `success` / receipt-exists boolean is PROHIBITED (an implementation and test rule, not a DTO field):

    | state | receipt route | presentation |
    |---|---|---|
    | 0-5 | no receipt | in flight: use the lifecycle route |
    | 6 RELEASE_ALLOCATED | present | release allocated; **payment incomplete** |
    | 7 REFUND_ALLOCATED | present | refund allocated; refund incomplete |
    | 8 SETTLED_RELEASED | terminal | operator distribution discharged |
    | 9 SETTLED_REFUNDED | terminal | **payer refunded; operator NOT paid** |

    `finalizedBlock` is NULL in states 6-7 and non-null only after 8/9. Lifecycle `phase` (server-derived): 0 = funding · 1 = active · 2-3 = contest · 4-5 = escalation · 6-7 = allocated · 8-9 = settled. Windows are computed from contract state plus frozen constants at the pinned block, never from wall-clock UI code.
18. **`SETTLED_RELEASED` ≠ "all funds paid".** `remainingClaimCount` counts only job-family claims (principal / fee / refund); bond, delay-compensation and burn claims are SEPARATE liability buckets that do not hold `SETTLED_*` open. Valid: "job payout distribution released." FALSE: "all funds for this dispute are paid." The DTO exposes auxiliary-liability status separately, OR makes no total-payment claim.
19. **The EAS mirror is provenance, NEVER current state or economics.** The mirror carries a mirror-TIME `unitState` snapshot (possibly pre-acceptance, stale, or a sentinel): read `unitState()` at the pinned block, never the mirror's state. An EAS UID proves only that the asynchronous mirror returned a UID, not a payment authorization. Verdict or economics reconstructed from events must hash back to the assertion id and match `{chain, attester, escrow, unit}`; unavailable material yields `null` / `UNAVAILABLE`, never a fabricated value; a mirror payload NEVER overrides frozen contract economics.
20. **Render cohort-disable HONESTLY.** "Disable ⇒ no payment" is NOT the state-machine rule; the kill switch is monotone toward refund and bounded. NEVER show a cohort-disabled unit as "cancelled" / "refund guaranteed" / "no payment". Disable blocks NEW assertions, adjudications and acceptances; already-accepted authorities resolve through the frozen state machine and CAN still release. Render the actual state.

**Tenant-scope addendum:** authorize BEFORE returning unit existence or metadata; forbidden and unknown must be indistinguishable to a cross-tenant caller.

---

## v1.4: escrow verification of the conformance matrix (2026-08-07)
The escrow lane (owner of the receipt and lifecycle money semantics) verified the conformance matrix line by line against `VNextSettlementEscrow.sol@7f2c6ff5`, and gen-UI re-verified every cited line. Six matrix rows were confirmed: the state enum 0-9; staticcall-servable windows for states 2/3/5; a pending principal *and* a pending fee both hold state 6; auxiliary claims do not hold state 8 (rule 18); a cohort-disabled but already-accepted unit still reaches 8. The four findings are folded into the DTO notes above (`refundReason`, `finalizedBlock`), plus this rule:

21. **Field-source provenance: the route is necessarily HYBRID.** Not every field is staticcall-authoritative. `finalState`, `unitState`, economics and windows are read by **staticcall at the pinned `asOfBlock` / `asOfBlockHash`**: reorg-safe and reproducible. But `refundReason` and `finalizedBlock` exist ONLY in event logs, so they are **reorg-exposed**. Every log-derived field MUST carry an explicit source marker (per field `{value, source: "staticcall" | "log"}`, or a `_fieldSource` map on the DTO), so a possibly-reorgable value is NEVER rendered identically to a staticcall-confirmed one. The money-critical claim stays safe by construction: rule 12 keys `finalState` off `unitState() ∈ {8, 9}` (staticcall-authoritative); only the CAUSE and the WHEN carry index exposure, and they are marked, not blended.

---

## v1.5: cross-family adversarial review (2026-08-18)
A cross-family adversarial review of the settlement layer sharpened rule 16: "one pinned block" is NECESSARY but NOT SUFFICIENT. Its money-path and custody findings belong to the escrow and operator lanes and are tracked there, not here.

22. **Pin to the FINALIZED block, by hash** (sharpens rule 16). "One pinned block" means Base's **`finalized`** L2 head, pinned by **block HASH**, never `latest` / `safe` / a bare number: Base distinguishes unsafe, safe and finalized heads, and a money display must not render an unsafe-head read as settled. `asOfBlockHash` is the finalized head's hash; a read taken at a non-finalized head is marked as such or refused, never rendered as confirmed.
23. **Absence is not evidence: indexer completeness or `UNKNOWN`** (sharpens rules 16/21). A log-derived field (rule 21) is trustworthy only if the indexer is **complete THROUGH the pinned block** with a matching canonical hash. If the indexer lags the pinned block, "no log found" MUST render `UNKNOWN`, NEVER a definitive absence-based inference; most dangerously `refundReason` by elimination (`DEADLINE_RECLAIM`) or "no refund cause ⇒ released".
24. **Cross-route snapshot consistency.** Each route being internally pinned is NOT enough: Surface A stitches receipt + lifecycle + provenance, and three independently-`latest` responses combine THREE blocks into one view that never existed. The routes MUST accept a **client-supplied snapshot token** (`?asOf=<finalizedBlockHash>`, bound identically across all three), OR expose one aggregate snapshot endpoint. Every DTO ECHOES `{asOfBlock, asOfBlockHash}` so Surface A can assert all three agree before rendering a combined view; a mismatch is `REVISION_MISMATCH` (409, re-read), never a silent stitch.
25. **Off-chain registries pin SEPARATELY; enrich the source envelope** (extends rules 15/21). A chain block cannot snapshot an OFF-CHAIN input (`assetReality` registry, tenant ownership, an independently revised provenance registry). Each carries its OWN effective-at / revision and identity. The rule-21 marker grows from `{value, source}` to **`{value, source, chain, contractOrRegistryId, blockNumber, blockHash, finality, completeness}`**, so a reader can tell a finalized on-chain read from a reorg-exposed log from a lagging off-chain registry row. A cursor binds to the COMPLETE snapshot (on-chain block plus every off-chain revision), not `asOfBlock` alone.
26. **`assetReality` attests IDENTITY, never LIVENESS.** `assetReality: "real"` says the settled token IS canonical Circle USDC at an approved deployment (rule 15); it does NOT say settlement is currently possible. Circle USDC is upgradeable, globally pausable and per-account blacklistable, so a correctly pinned real asset can be unable to move. The render MUST NEVER let `assetReality: "real"` imply "funds will settle" / "settlement guaranteed"; token liveness (pause / blacklist state) is a SEPARATE, non-authoritative signal if surfaced at all.

**Reader-port guidance for rules 22/24** (for the concrete `SettlementUnitReader`): capture ONE `{number, hash}` per response at the `finalized` head; issue every contract read with that block's HASH as the block tag (EIP-1898), so every value in a response comes from one block by construction; fail closed on any RPC error, missing block or decode failure ("unreadable" rejects, it never defaults); if redundant RPC providers are used, they must agree on the block hash and the reads or the response fails closed. The cross-route `?asOf=<finalizedBlockHash>` (rule 24) is the one piece above the single-reader layer.

---
Maintained by the gen-UI lane (consumer contract). v1.2 added Route 3 and the refund causes; v1.2.1 made `ProvenanceDTO` a real discriminated union and added `network` to it; v1.3-v1.5 added rules 15-26 as dated above.
