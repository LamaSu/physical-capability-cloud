// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VNextSettlementEscrow} from "../../src/VNextSettlementEscrow.sol";

/// @title  VNextReadLens — the WAVE 4c read adapter for the collapsed escrow read plane.
/// @notice WAVE 4c collapsed eighteen one-field getters on {VNextSettlementEscrow} into two fixed-width
///         snapshot reads (`feeScheduleOf` and `unitTerms`) to reclaim contract size under EIP-170. This
///         library restores every retired accessor as an OFF-CONTRACT lens: same name, same signature,
///         same value, zero bytes on the escrow. It is the migration reference for any consumer — the
///         retired selector's successor is exactly the destructuring shown here.
///
///         Nothing in here computes: every function is a pure projection of one snapshot call, so a test
///         reading through the lens observes byte-identical on-chain state to one that called the retired
///         selector directly. That is deliberate — a lens that derived anything would be a place for the
///         test suite and the contract to disagree.
///
/// @dev    RETIRED SELECTOR -> SUCCESSOR
///         feeDomainVersion, feeChainId, escrowOf, settlementUnitIdOf, feeBasisOf, gross, fee, net,
///         denominatorOf, roundingRuleOf, feeSplitConfigHashOf   ->  feeScheduleOf(unitId).<field>
///         milestoneIndexOf, stepIdOf, requestedTierOf, reclaimAtOf, payoutConfigHashOf,
///         compositionSchemaVersionOf, evidenceCommittedOf                 ->  unitTerms(unitId).<slot>
///
///         STILL ON THE CONTRACT, DELIBERATELY NOT COLLAPSED: `feeScheduleHashOf`, `feeBpsOf`,
///         `feeRecipientOf`, `requiredTierOf`, `compositionRootOf`, `evidenceBundleHashOf`. The O5
///         attester STATICCALLs those selectors and requires `returndatasize() == 32` exactly, so
///         reshaping any of them would make every `attestO5` revert `EscrowBindingUnreadable`.
library VNextReadLens {
    // ── Fee-amount projections (successor: `feeAmountsOf`) ───────────────────────────────────────────
    // WAVE 4c Move 4 replaced the 13-field `feeScheduleOf` struct getter with the 3-word `feeAmountsOf`,
    // because g/f/n are the ONLY fee-schedule fields with no other on-chain reader. These three keep a
    // faithful storage-backed projection.

    function gross(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (v,,) = e.feeAmountsOf(unitId);
    }

    function fee(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (, v,) = e.feeAmountsOf(unitId);
    }

    function net(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (,, v) = e.feeAmountsOf(unitId);
    }

    // DELIBERATELY NOT PROJECTED, and this is the honest part: `feeDomainVersion`, `feeChainId`,
    // `escrowOf`, `settlementUnitIdOf`, `feeBasisOf`, `denominatorOf`, `roundingRuleOf`,
    // `feeSplitConfigHashOf`. Each of those eight is a compile-time constant, `address(this)`, the map
    // key the caller already holds, or `block.chainid` (VNextSettlementEscrow.sol:727-741), so nothing
    // in storage backs them any more. A lens that returned `VNextSettlementLib.FEE_DENOMINATOR` here
    // would ASSERT THE CONSTANT AGAINST ITSELF and pass even if the contract stored something else —
    // a test that cannot fail. They are dropped rather than faked. No test referenced any of them.

    // ── Unit-terms projections (successor: `unitTerms`) ──────────────────────────────────────────────

    function milestoneIndexOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (v,,,,,,) = e.unitTerms(unitId);
    }

    function stepIdOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (bytes32 v) {
        (, v,,,,,) = e.unitTerms(unitId);
    }

    function requestedTierOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint8 v) {
        (,, v,,,,) = e.unitTerms(unitId);
    }

    function reclaimAtOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (,,, v,,,) = e.unitTerms(unitId);
    }

    function payoutConfigHashOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (bytes32 v) {
        (,,,, v,,) = e.unitTerms(unitId);
    }

    function compositionSchemaVersionOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint16 v) {
        (,,,,, v,) = e.unitTerms(unitId);
    }

    function evidenceCommittedOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (bool v) {
        (,,,,,, v) = e.unitTerms(unitId);
    }

    // ── Live-counter projections (successor: `unitCounters`) ─────────────────────────────────────────
    // These three MUTATE, so the collapse also removes a torn-read hazard: three separate calls could
    // straddle a state change, one call cannot.

    function liabilityOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (v,,) = e.unitCounters(unitId);
    }

    function payoutCount(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (, v,) = e.unitCounters(unitId);
    }

    function remainingClaimCountOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256 v) {
        (,, v) = e.unitCounters(unitId);
    }
}
