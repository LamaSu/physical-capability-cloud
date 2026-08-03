// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {O5Verdict, O5Assertion, O5Adjudication, O5AdjudicationRecord} from "../O5Types.sol";

/**
 * @title IOracleAttester
 * @notice The cohort-scoped O5 attester surface (addendum §A). The settlement escrow binds one attester
 *         address at deploy (`authorizedOracle`) and, at funding, pins the attester's `cohortId` and
 *         requires the cohort is still `enabled` — so a one-way `disable()` of the cohort neutralizes
 *         both new funding AND already-minted attestations (checked at release / payment time).
 * @dev    The escrow calls three view methods (`enabled` / `cohortId` / `assertionOf`); it never writes.
 *         The write path (`attestO5`) is exercised by the oracle operator with an M-of-N signature set.
 *
 *         P0-6: `attestO5` writes a DIRECT COHORT ASSERTION into this contract's own storage and does NOT
 *         touch EAS. The escrow's money authorization is `assertionOf(settlementUnitId)` — no synchronous
 *         global write dependency, no shared failure domain across cohorts, and no external dependency
 *         that a funded job cannot escape. EAS becomes an asynchronous, permissionlessly-replayable
 *         provenance mirror (`mirrorToEAS`), which is deliberately absent from this interface because
 *         nothing on the money path may call it.
 *
 *         `attestO5` carries an explicit `escrow` argument: it is recorded as the assertion's bound escrow
 *         (the escrow verifies `assertion.escrow == address(this)` at release). The escrow address cannot
 *         be recovered from the verdict's `settlementUnitId` hash, so it is passed and then re-bound to
 *         the verdict inside the implementation (recompute settlementUnitId and require equality) — the
 *         attester therefore only ever asserts for the escrow the quorum signed for.
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

    /// @notice The cohort's pinned O5 v1.1 EAS schema UID (M-02). Symmetric with `o5TypeHash`: the escrow's
    ///         `o5SchemaUid` immutable is a DEPLOYMENT pin, and when it is non-zero the escrow's constructor
    ///         requires it to equal this value. Without the pin a one-char schema divergence would make
    ///         every mint burn a unit's slot and every release revert `WrongSchema` — silently turning a
    ///         whole cohort refund-only. Zero stays the documented deferred state (unpinned, no check).
    function o5SchemaUid() external view returns (bytes32);

    /// @notice The immutable cohort assertion bound to `settlementUnitId`, or an all-zero record when none
    ///         exists. THE money-path read (P0-6): it replaces `IEAS.getAttestation` in the escrow's
    ///         `releaseFromEvidence`. Callers MUST treat `assertionId == 0` as "no assertion" and fail
    ///         closed — the zero record must never be readable as an authorization.
    /// @dev    Keyed BY `settlementUnitId`, so the returned record is bound to the requested unit by
    ///         construction (this is what the old `attestation.uid == requestedUid` check bought).
    function assertionOf(bytes32 settlementUnitId) external view returns (O5Assertion memory);

    /// @notice Write the direct cohort assertion for `escrow` from a valid cohort quorum over `v`. Reverts
    ///         unless the quorum, cohort, and one-verdict-per-unit invariants all hold. Touches no external
    ///         contract. Returns the assertion id (the EIP-712 digest over the full signed verdict).
    function attestO5(O5Verdict calldata v, address escrow, bytes[] calldata signatures)
        external
        returns (bytes32 assertionId);

    /// @notice One-way, permanent cohort disable (revoker only).
    function disable() external;

    // ── H-01 Wave 3 (post-verdict state machine) ────────────────────────────────────────────────────

    /// @notice The block timestamp `disable()` was called at; 0 while the cohort is enabled.
    /// @dev    §8.3 C-5 Model B. WRITE-ONCE (disable is one-way and refuses a second call), which is what
    ///         makes the escrow's emergency review deadline — `disabledAt + EMERGENCY_REVIEW_WINDOW` —
    ///         immutable: the revoker can INITIATE the emergency but can neither extend it, reset it, nor
    ///         choose the financial outcome. Never zero once disabled (clamped to 1 at genesis).
    function disabledAt() external view returns (uint64);

    /// @notice The cohort's kill-switch holder. Read at DEPLOY time only (the escrow's constructor
    ///         forbids one key holder from being the revoker of BOTH the primary and the escalation
    ///         cohort — see {VNextSettlementEscrow}'s constructor). No money path reads it.
    function revoker() external view returns (address);

    /// @notice The typed escalation adjudication for `(settlementUnitId, role, escrow)`, or an all-zero
    ///         record.
    /// @dev    THE second money-path read (Wave 3). `role` is `O5_ADJ_ROLE_APPEAL` or
    ///         `O5_ADJ_ROLE_EMERGENCY`; each has its OWN consume-once slot. Callers MUST treat
    ///         `adjudicationId == 0` as "no verdict" and fail closed. The record carries no amount and no
    ///         recipient by design — it selects a path, never a distribution.
    /// @dev    M-05: `escrow` is part of the slot key, so a record naming a different escrow cannot
    ///         consume this one's slot. The escrow passes `address(this)`.
    function adjudicationOf(bytes32 settlementUnitId, uint8 role, address escrow)
        external
        view
        returns (O5AdjudicationRecord memory);

    /// @notice H-01 (sol 4th-family) — the timestamp the quorum DECIDED an adjudication this escrow would
    ///         actually apply, or `type(uint64).max` ("never") when there is none.
    /// @dev    Returns `decidedAt` only if the record exists, is bound to `escrow`, and reviews exactly
    ///         `reviewedAssertionId`. It exists so the escrow's DEADLINE DEFAULTS can ask "was a verdict
    ///         already decided in time?" for ONE WORD instead of decoding the whole record: a timely
    ///         authenticated verdict must never be overtaken by a deadline default just because nobody
    ///         relayed it in time (relayer inactivity must not change either party's outcome).
    /// @dev    THE SENTINEL IS `max`, NOT 0, and that is load-bearing rather than a taste: the caller's
    ///         only question is `decidedAt < myDeadline`, so "nothing applicable" must answer a value that
    ///         is never inside any window. `max` makes the absent case FAIL TOWARD the ordinary deadline
    ///         default with no second comparison to get wrong; 0 would have answered "decided at the dawn
    ///         of time", i.e. inside every window, and stalled units instead.
    function adjudicationDecidedAt(
        bytes32 settlementUnitId,
        uint8 role,
        address escrow,
        bytes32 reviewedAssertionId
    ) external view returns (uint64 decidedAtOrNever);

    /// @notice Write the typed UPHOLD/OVERTURN from a valid escalation-cohort quorum over `a`.
    function adjudicate(O5Adjudication calldata a, bytes[] calldata signatures)
        external
        returns (bytes32 adjudicationId);
}
