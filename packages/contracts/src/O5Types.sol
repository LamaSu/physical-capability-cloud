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
    bytes32 evidenceBundleHash; // 4
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

// `abi.encode(O5Verdict)` length: 14 static ABI words * 32 bytes. The escrow's M-01 length guard.
uint256 constant O5_VERDICT_BYTES = 448;

// O5 verdict decision encoding for "settle" (§0.3). Joint-pinned with the oracle (M1/M2).
uint8 constant O5_DECISION_SETTLE = 1;
