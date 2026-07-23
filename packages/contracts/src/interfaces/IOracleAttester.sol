// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {O5Verdict} from "../O5Types.sol";

/**
 * @title IOracleAttester
 * @notice The cohort-scoped O5 attester surface (addendum §A). The settlement escrow binds one attester
 *         address at deploy (`authorizedOracle`) and, at funding, pins the attester's `cohortId` and
 *         requires the cohort is still `enabled` — so a one-way `disable()` of the cohort neutralizes
 *         both new funding AND already-minted attestations (checked at release / payment time).
 * @dev    The escrow only calls the two view methods (`enabled` / `cohortId`); it never mints. The write
 *         path (`attestO5`) is exercised by the oracle operator with an M-of-N signature set.
 *
 *         `attestO5` carries an explicit `escrow` argument: it becomes the EAS attestation recipient (the
 *         escrow verifies `attestation.recipient == address(this)` at release). The escrow address cannot
 *         be recovered from the verdict's `settlementUnitId` hash, so it is passed and then re-bound to
 *         the verdict inside the implementation (recompute settlementUnitId and require equality) — the
 *         attester therefore only ever mints an attestation whose recipient matches the signed verdict.
 */
interface IOracleAttester {
    /// @notice Cohort kill-switch. Starts true; a revoker may flip it false ONE-WAY (never re-enabled).
    function enabled() external view returns (bool);

    /// @notice This attester's immutable cohort label — pinned into the escrow's `oracleAuthEpoch` at fund.
    function cohortId() external view returns (uint64);

    /// @notice The cohort's LIVE O5 EIP-712 type hash (L-02). The escrow's `o5TypeHash` immutable is a
    ///         DEPLOYMENT pin, not a runtime security check; when it is non-zero the escrow's constructor
    ///         requires it to equal this value, so the published pin can never drift from the type hash the
    ///         cohort actually signs under.
    function o5TypeHash() external view returns (bytes32);

    /// @notice Mint the O5 EAS attestation for `escrow` from a valid cohort quorum over `v`. Reverts unless
    ///         the quorum, cohort, and one-verdict-per-unit invariants all hold. Returns the EAS uid.
    function attestO5(O5Verdict calldata v, address escrow, bytes[] calldata signatures)
        external
        returns (bytes32 uid);

    /// @notice One-way, permanent cohort disable (revoker only).
    function disable() external;
}
