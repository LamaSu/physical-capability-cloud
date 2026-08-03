// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VNextSettlementEscrow} from "../../src/VNextSettlementEscrow.sol";
import {FeeSchedule} from "../../src/libraries/VNextSettlementLib.sol";

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
    // ── FeeSchedule projections (successor: `feeScheduleOf`) ─────────────────────────────────────────

    function feeDomainVersion(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint8) {
        return e.feeScheduleOf(unitId).domainVersion;
    }

    function feeChainId(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256) {
        return e.feeScheduleOf(unitId).chainId;
    }

    function escrowOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (address) {
        return e.feeScheduleOf(unitId).escrow;
    }

    function settlementUnitIdOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (bytes32) {
        return e.feeScheduleOf(unitId).settlementUnitId;
    }

    function feeBasisOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint8) {
        return e.feeScheduleOf(unitId).feeBasis;
    }

    function gross(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256) {
        return e.feeScheduleOf(unitId).g;
    }

    function fee(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256) {
        return e.feeScheduleOf(unitId).f;
    }

    function net(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256) {
        return e.feeScheduleOf(unitId).n;
    }

    function denominatorOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint256) {
        return e.feeScheduleOf(unitId).denominator;
    }

    function roundingRuleOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (uint8) {
        return e.feeScheduleOf(unitId).roundingRule;
    }

    function feeSplitConfigHashOf(VNextSettlementEscrow e, bytes32 unitId) internal view returns (bytes32) {
        return e.feeScheduleOf(unitId).feeSplitConfigHash;
    }

    /// @notice The whole schedule, for a consumer that wants more than one field (the case the collapse
    ///         was built for — one call instead of N).
    function feeScheduleStruct(VNextSettlementEscrow e, bytes32 unitId) internal view returns (FeeSchedule memory) {
        return e.feeScheduleOf(unitId);
    }

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
}
