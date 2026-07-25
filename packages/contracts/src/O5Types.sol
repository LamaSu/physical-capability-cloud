// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title O5Types
 * @notice The canonical O5/v3 verdict shape shared byte-for-byte by the settlement escrow (which READS
 *         it out of an EAS attestation at release) and the cohort oracle attester (which WRITES it into
 *         EAS). Kept in a standalone file so both sides import the identical 14-field struct — the M2
 *         oracle↔escrow golden-parity is defined against THIS layout.
 * @dev    rev-3 (addendum §F/§C3) appends two trailing static words to the frozen v1.0 12-field seam:
 *         `oracleAuthEpoch` (the funded cohort id, §A.2) and `compositionRoot` (the funding-frozen root
 *         echoed by the oracle so the settlement authorization cryptographically covers it, §C3).
 *         All 14 members are static value types ⇒ `abi.encode(O5Verdict)` is exactly 14 * 32 = 448 bytes.
 *         Do NOT reorder, retype, or resize a field without a cross-lane re-pin of the schema UID + the
 *         golden vectors — the layout is load-bearing for the oracle's parity mirror.
 */
struct O5Verdict {
    bytes32 jobIdHash; // 1
    uint256 milestoneIndex; // 2
    bytes32 stepId; // 3
    // 4 — §B: the escrow's DOMAIN-SEPARATED evidence commitment (NOT the raw package digest):
    // `VNextSettlementLib.computeEvidenceCommitment`, readable from the escrow as
    // `evidenceBundleHashOf(settlementUnitId)`. Equality-checked against the unit's committed value.
    bytes32 evidenceBundleHash;
    uint8 achievedTier; // 5
    uint8 requestedTier; // 6
    uint8 decision; // 7  (SETTLE == O5_DECISION_SETTLE)
    bytes32 verdictHash; // 8
    uint16 feeBps; // 9
    address feeRecipient; // 10
    bytes32 feeScheduleHash; // 11
    bytes32 settlementUnitId; // 12
    uint64 oracleAuthEpoch; // 13 (rev-3, §A.2) — the funded cohort id
    bytes32 compositionRoot; // 14 (rev-3, §C3) — typed H(schema, merkleRoot); 0 = non-composed
}

// `abi.encode(O5Verdict)` length: 14 static ABI words * 32 bytes. Still the mirror's payload size and the
// EAS `data` length; no longer a money-path guard (nothing on the money path ABI-decodes a blob any more).
uint256 constant O5_VERDICT_BYTES = 448;

// O5 verdict decision encoding for "settle" (§0.3). Joint-pinned with the oracle (M1/M2).
uint8 constant O5_DECISION_SETTLE = 1;

/**
 * @notice P0-6: the DIRECT COHORT ASSERTION the escrow's money path reads instead of an EAS attestation.
 *         Written once per `settlementUnitId` by the cohort attester after the quorum verifies, read by
 *         {VNextSettlementEscrow.releaseFromEvidence}. Shared here (like {O5Verdict}) so the writer and
 *         the reader compile against one struct.
 * @dev    WHY this exists: synchronous EAS put a mandatory GLOBAL WRITE dependency on the money path —
 *         one shared failure domain across every bound Tier-1..3 cohort, and an immutable dependency for
 *         jobs that are already funded. An EAS stall pushed every active Tier>=1 job toward refund. The
 *         assertion has no external dependency at all: it is written to the attester's own storage.
 *
 *         `assertionId` is the EIP-712 digest over the FULL 14-field signed verdict (see
 *         {O5AttesterBase._digest}). That is deliberate: the escrow only re-checks a subset of the O5
 *         fields (13 of 14 are already re-verified from FROZEN escrow state), but the assertion must still
 *         bind the WHOLE signed verdict for provenance and for mirror replay. The digest binds every
 *         signed field AND the domain (chainId + the attester's own address), so it is simultaneously the
 *         strongest available provenance binding and a globally unique identifier for the assertion.
 *         A zero `assertionId` therefore means "no assertion" and is never a valid record (L-02's intent:
 *         a zero/absent identifier must fail closed rather than read as a default).
 *
 *         The full 448-byte verdict is NOT stored — it is emitted in `O5Asserted`. Storing 14 words on the
 *         money path would re-import the cost the direct assertion exists to remove (§13R.1); logs are
 *         on-chain, so the async EAS mirror stays replayable from on-chain data.
 *
 *         Layout is packed into 6 slots: 4 whole words, then {escrow,assertedAt,3 x uint8} = 31 B and
 *         {feeRecipient,oracleAuthEpoch,feeBps} = 30 B. Do not reorder without re-checking the packing.
 */
struct O5Assertion {
    bytes32 assertionId; // EIP-712 digest over the full signed verdict; 0 == no assertion
    bytes32 feeScheduleHash; // frozen 13-field fee commitment the escrow re-checks
    bytes32 compositionRoot; // rev-3 §C3 echo the escrow re-checks against its frozen root
    bytes32 evidenceBundleHash; // §B domain-separated evidence commitment the escrow re-checks
    address escrow; // the bound escrow (the EASAttestation.recipient analog)
    // @dev H-01 §8.2 C-3: this is the MINT time, and it is deliberately NOT the escrow's clock. The escrow
    //      stamps its OWN `assertedAt = block.timestamp` inside `acceptAssertion()`, so a stale assertion
    //      submitted late can never have already eaten the challenge window. This field is provenance only.
    uint64 assertedAt;
    uint8 achievedTier;
    uint8 requestedTier;
    uint8 decision; // always O5_DECISION_SETTLE: the attester mints no other decision
    address feeRecipient; // M-01 raw fee word the escrow re-checks
    uint64 oracleAuthEpoch; // the cohort id the escrow pinned at funding
    uint16 feeBps; // M-01 raw fee word the escrow re-checks
}

// ── H-01 §2.5 / §8.3 C-5: the TYPED ESCALATION ADJUDICATION ───────────────────────────────────────────
// The appeal quorum and the emergency cohort issue the SAME shape: an m-of-n signed, typed
// UPHOLD/OVERTURN over ONE EXACT already-accepted assertion, with **no distribution authority** — it
// selects a path, and the escrow alone owns every number. It is hosted in the ATTESTER (which already
// owns EIP-712 + m-of-n + consume-once) and merely READ by the escrow, exactly like `O5Assertion`.

uint8 constant O5_ADJ_ROLE_APPEAL = 1; // §2.5 independent appeal-verifier quorum
uint8 constant O5_ADJ_ROLE_EMERGENCY = 2; // §8.3 C-5 Model-B emergency cohort
uint8 constant O5_ADJ_UPHOLD = 1; // the reviewed SETTLE stands  -> RELEASE
uint8 constant O5_ADJ_OVERTURN = 2; // the reviewed SETTLE falls -> REFUND

/// @notice The signed adjudication payload (the appeal/emergency analog of {O5Verdict}).
/// @dev    `reviewedAssertionId` is what makes this ASSERTION-SPECIFIC: a verdict signed over one
///         assertion can never be applied to a different one, and the escrow re-checks it against its own
///         `acceptedAssertionId`. There is no amount, no recipient and no fee field anywhere in this
///         struct — that absence IS the "no distribution authority" property, enforced by the type.
struct O5Adjudication {
    bytes32 settlementUnitId;
    address escrow;
    bytes32 reviewedAssertionId;
    uint8 role; // O5_ADJ_ROLE_*
    uint8 outcome; // O5_ADJ_UPHOLD | O5_ADJ_OVERTURN
    uint64 oracleAuthEpoch; // the escalation cohort's own id
}

/// @notice The immutable record written by the escalation cohort's quorum, read by the escrow.
/// @dev    Keyed by `keccak256(abi.encode(settlementUnitId, role))` so APPEAL and EMERGENCY each get
///         their own consume-once slot: an appeal verdict can never pre-empt (or be replayed as) the
///         Model-B emergency review of the same unit.
struct O5AdjudicationRecord {
    bytes32 adjudicationId; // EIP-712 digest over the full signed adjudication; 0 == none
    bytes32 reviewedAssertionId;
    address escrow;
    uint64 decidedAt;
    uint8 role;
    uint8 outcome;
}
