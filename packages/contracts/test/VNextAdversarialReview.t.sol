// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VNextSettlementEscrowTest} from "./VNextSettlementEscrow.t.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {
    O5Assertion,
    O5AdjudicationRecord,
    O5_ADJ_ROLE_APPEAL,
    O5_ADJ_ROLE_EMERGENCY,
    O5_ADJ_UPHOLD,
    O5_ADJ_OVERTURN
} from "../src/O5Types.sol";
import {PolicyIdentity, UnitState, VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";

/**
 * @title VNextAdversarialReviewTest
 * @notice reviewer-adversarial-alpha: demonstrating tests for the Waves 1-3b adversarial review.
 *         These are NOT regression tests for intended behaviour — every `A-0x` test below documents an
 *         outcome the review flags. They pass against the CURRENT `src/`, which is the point: each one
 *         is the concrete trace behind a finding. `S-0x` tests are the converse — properties the review
 *         PROVED hold, recorded so a later change that breaks them fails here.
 */
contract VNextAdversarialReviewTest is VNextSettlementEscrowTest {
    uint256 constant AG = 1000e6;
    uint256 constant AF = 23_500000;
    uint16 constant ABPS = 235;

    function _liveUnit() internal returns (VNextSettlementEscrow e, bytes32 id) {
        e = _fundedEscrow(JOB, _oneUnitConfig(AG, AF, ABPS, 1));
        id = _unitId(e);
    }

    function _cutoff(VNextSettlementEscrow e, bytes32 id) internal view returns (uint256) {
        return e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
    }

    /// @dev A backup SETTLE written by the ESCALATION cohort under its own pinned epoch.
    function _backupAssert(VNextSettlementEscrow e, bytes32 id) internal {
        O5Assertion memory a = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e));
        a.assertionId = keccak256("adv-backup-assertion");
        a.oracleAuthEpoch = ESC_COHORT;
        escalation.setAssertion(id, a);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-01  The payer-controlled `evidenceCommitter` is a costless, one-transaction refund switch.
    //       Design brief §2.8 required this authority to be REMOVED from the payer's side. It was not.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The funding path accepts `evidenceCommitter == payer`: the ONLY guard is
    ///      `_requireAllowedRecipient` ({0, escrow, USDC, factory}) at VNextSettlementEscrow.sol:705.
    function test_A01a_FundingAcceptsThePayerAsEvidenceCommitter() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(AG, AF, ABPS, 1);
        cfgs[0].evidenceCommitter = payer;
        VNextSettlementEscrow e = _fundedEscrow(JOB, cfgs);
        bytes32 id = _unitId(e);
        assertEq(e.evidenceCommitterOf(id), payer, "the payer is a legal evidence committer");
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev THE TRACE. Payer funds with itself as committer, the operator signs, the operator performs,
    ///      the cohort has a valid SETTLE ready — and the payer simply never commits. Both settlement
    ///      lanes are structurally dead and the whole G returns to the payer at `reclaimAt`.
    ///      This is the H-01 OUTCOME (operator performs, payer refunds unilaterally) reached through the
    ///      §B commit gate instead of the retired `openDispute`.
    function test_A01b_PayerCommitterWithholds_OperatorPerformsAndIsNeverPaid() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(AG, AF, ABPS, 1);
        cfgs[0].evidenceCommitter = payer;
        VNextSettlementEscrow e = _fundedEscrow(JOB, cfgs);
        bytes32 id = _unitId(e);
        uint256 payerBefore = usdc.balanceOf(payer);

        // The operator did the work and the cohort signed a valid SETTLE over the real package.
        _assert(e, id, 1, 1);

        // Primary lane: refused, because nothing was committed.
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.acceptAssertion(id);

        // The operator cannot supply the commitment itself — the committer is frozen to the payer.
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.OnlyEvidenceCommitter.selector);
        e.submitEvidence(id, PKG);

        // Backup lane: the operator's own recourse, and it is dead for the same reason.
        vm.warp(_cutoff(e, id) - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);
        _backupAssert(e, id);
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.acceptAssertion(id);

        // And escalating has now also locked the commit gate shut for good (`submitEvidence` needs
        // FUNDED_ACTIVE), so even a repentant payer could not rescue the operator from here.
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.submitEvidence(id, PKG);

        // Backup timeout -> refund. Payer whole, operator and its payout recipients paid nothing.
        vm.warp(_cutoff(e, id));
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + AG, "payer recovered the full gross");
        assertEq(usdc.balanceOf(recip1), 0, "operator side paid nothing");
        assertEq(usdc.balanceOf(recip2), 0);
        assertEq(usdc.balanceOf(feeDest), 0);
    }

    /// @dev The faster form: the payer does not even have to wait. ONE cheap transaction — a one-shot
    ///      commitment over a digest that is not the package the oracle evaluated — permanently strands
    ///      the release path, because `submitEvidence` is single-use.
    function test_A01c_PayerCommitterCanBrickReleaseInOneTransaction() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(AG, AF, ABPS, 1);
        cfgs[0].evidenceCommitter = payer;
        VNextSettlementEscrow e = _fundedEscrow(JOB, cfgs);
        bytes32 id = _unitId(e);

        vm.prank(payer);
        e.submitEvidence(id, keccak256("not-the-package-the-operator-produced"));

        // The real package can never be committed now.
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.EvidenceAlreadyCommitted.selector);
        e.submitEvidence(id, PKG);

        // A cohort verdict over the REAL package no longer matches the frozen commitment.
        _assert(e, id, 1, 1);
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.acceptAssertion(id);

        // Terminal state: refund at the deadline.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(e.reclaimAtOf(id));
        e.reclaimAfterDeadline(id);
        assertEq(usdc.balanceOf(payer), payerBefore + AG);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-02  Model B does NOT hold on the backup lane: there the escalation revoker's `disable()` is a
    //       deterministic refund switch, because the emergency REVIEWER is the attester it just killed.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_A02_BackupLane_DisableIsADeterministicRefund_NoUpholdReachable() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _commit(e, id, PKG);

        vm.warp(_cutoff(e, id) - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);
        _backupAssert(e, id);
        e.acceptAssertion(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.BACKUP_ASSERTED), "a valid backup SETTLE");

        // A genuine emergency UPHOLD is already written and waiting.
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);

        uint256 disabledAt = block.timestamp;
        escalation.disableAtNow(); // the escalation cohort's revoker acts

        // Neither escalation role can decide: EMERGENCY is barred by the cohort-disabled check
        // (VNextSettlementEscrow.sol:1536) and APPEAL by the emergency pause (:1516).
        vm.expectRevert(VNextSettlementEscrow.OracleCohortDisabled.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        vm.expectRevert(VNextSettlementEscrow.EmergencyPaused.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // So the ONLY reachable outcome is the emergency-silence refund. The revoker chose it alone.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + AG, "a valid accepted SETTLE became a refund");
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-03  The emergency reaches BACK over an assertion whose challenge window already closed, i.e.
    //       over a release that was already due and needed only a keystroke. Relayer inactivity plus a
    //       later disable therefore does change the payer's outcome.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Control: once the challenge window closes the release is due to anyone who asks.
    function test_A03a_Control_ReleaseIsDueTheInstantTheWindowCloses() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        vm.prank(address(0xD00D));
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    /// @dev Same state, nobody calls `finalize`, and 14 days later the primary cohort is disabled. The
    ///      already-due release is re-opened and defaults to REFUND on emergency silence.
    function test_A03b_NobodyFinalized_ALaterDisableConvertsTheDueReleaseIntoARefund() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        // (release is due here — see the control test — but no keeper transacts)

        vm.warp(block.timestamp + 14 days);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();

        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + AG);
        assertEq(usdc.balanceOf(recip1), 0);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-04  The "immutable emergency deadline" is not terminal: `resolveEscalation` carries no deadline
    //       check, so a post-deadline UPHOLD that front-runs `finalize` still releases.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_A04_EmergencyDeadlineIsNotTerminal_APostDeadlineUpholdStillReleases() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();

        // Well past the deadline at which `finalize` would have refunded.
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW + 3 days);
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "late UPHOLD still pays");
        assertEq(usdc.balanceOf(feeDest), AF);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-05  Funding generation N does NOT retire generation N+1: both can be funded, in that order.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_A05_OlderGenerationFundedFirst_DoesNotRetireTheNewerOne() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(AG, AF, ABPS, 1);

        // Generation 1.
        VNextSettlementEscrow e1 = VNextSettlementEscrow(factory.createEscrow(_identity(JOB, arbiter, 1, cfgs)));
        _fund(e1, cfgs);

        // Generation 2 — a "revision" both parties also signed — is still fundable afterwards.
        VNextSettlementEscrow e2 = VNextSettlementEscrow(factory.createEscrow(_identity(JOB, arbiter, 2, cfgs)));
        _fund(e2, cfgs);

        assertTrue(address(e1) != address(e2));
        assertEq(usdc.balanceOf(address(e1)), AG);
        assertEq(usdc.balanceOf(address(e2)), AG, "the payer funded BOTH generations of one job");
        assertEq(factory.policyNonceFloor(factory.policyKey(payer, operator, JOB)), 3);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // S-0x  PROVED SAFE — the converse tests. A change that breaks one of these breaks a property this
    //       review checked and relied on.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev The Wave-3b factory offload: `acceptPolicy` is unreachable except from the exact CREATE2
    ///      clone of that policy identity. A stranger, and a clone passing a MUTATED identity, both fail.
    function test_S01_FactoryAcceptPolicy_OnlyTheCanonicalCloneMayCallIt() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(AG, AF, ABPS, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, cfgs);
        PolicyIdentity memory p = _identity(JOB, arbiter, 1, cfgs);
        assertEq(factory.predictEscrow(p), address(e));

        // A stranger cannot borrow the factory's verification.
        vm.expectRevert(VNextSettlementEscrowFactory.NotThePolicyEscrow.selector);
        factory.acceptPolicy(p, bytes32(0), payer, POLICY_EXPIRY, false, bytes(""), bytes(""));

        // Nor can the real clone, if the identity it hands back is not the one its address commits to.
        PolicyIdentity memory tampered = p;
        tampered.arbiter = address(0xDEAD01);
        vm.prank(address(e));
        vm.expectRevert(VNextSettlementEscrowFactory.NotThePolicyEscrow.selector);
        factory.acceptPolicy(tampered, bytes32(0), payer, POLICY_EXPIRY, false, bytes(""), bytes(""));
    }

    /// @dev The Wave-3b residual verifier is a pure predicate bound to `msg.sender`'s EIP-712 domain: a
    ///      signature made for clone E validates ONLY when E is the caller. Nobody can launder a
    ///      signature through the factory into another contract's domain.
    function test_S02_VerifyCloneSignature_IsDomainBoundToTheCaller() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(AG, AF, ABPS, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, cfgs);
        bytes32 structHash = keccak256("any-struct-hash");
        bytes memory sig = _sign(operatorPk, keccak256(abi.encodePacked("\x19\x01", _domainSep(address(e)), structHash)));

        vm.prank(address(e));
        assertTrue(factory.verifyCloneSignature(operator, structHash, sig), "valid in the clone's domain");
        assertFalse(
            factory.verifyCloneSignature(operator, structHash, sig), "not valid in any other caller's domain"
        );
    }

    /// @dev The assertion rail is escrow-bound: a record naming a different escrow cannot authorize here.
    function test_S03_AssertionIsBoundToTheReadingEscrow() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _commit(e, id, PKG);
        O5Assertion memory a = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(0xE5C0));
        attester.setAssertion(id, a);
        vm.expectRevert(VNextSettlementEscrow.WrongRecipient.selector);
        e.acceptAssertion(id);
    }

    /// @dev Reclaim exclusion after acceptance is permanent — a missing keeper never restores it.
    function test_S04a_ReclaimIsBarredForeverAfterAcceptance() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        vm.warp(e.reclaimAtOf(id) + 365 days);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.reclaimAfterDeadline(id);
    }

    /// @dev A validly-opened challenge equally cannot be bypassed back into a deadline refund.
    function test_S04b_ReclaimCannotBypassALiveChallenge() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        usdc.mint(payer, 100e6);
        _challenge(e, id);
        vm.warp(e.reclaimAtOf(id) + 365 days);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.reclaimAfterDeadline(id);
    }

    /// @dev Boundary timestamps: challenge and finalize partition the instant `assertedAt + WINDOW`
    ///      exactly — no second in which both are open, and none in which neither is.
    function test_S05_ChallengeAndFinalizeBoundariesPartitionExactly() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        (, uint64 assertedAt,,,,,) = e.settlement(id);
        uint256 edge = uint256(assertedAt) + VNextSettlementLib.CHALLENGE_WINDOW;

        vm.warp(edge - 1);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id); // finalize closed, challenge open

        vm.warp(edge);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ChallengeWindowClosed.selector);
        e.challenge(id); // challenge closed, finalize open
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    /// @dev The §8.3 H-3 solvency invariant survives the full forfeit waterfall: appeal silence forfeits
    ///      the bond into delay-comp + burn while the job's own G is paid out of the JOB bucket only.
    function test_S06_BondBucketsNeverCrossTheJobBucket() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        usdc.mint(payer, 100e6);
        uint256 bond = _challenge(e, id);
        assertEq(usdc.balanceOf(address(e)), AG + bond);
        assertEq(e.totalLiability(), AG);
        assertEq(e.bondLiability(), bond);

        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        e.finalize(id); // appeal silence -> release + compensate-then-burn
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(e.totalLiability(), 0);
        assertEq(e.bondLiability(), 0);
        assertEq(e.compLiability(), 0);
        assertEq(e.burnLiability(), 0);
        assertEq(usdc.balanceOf(feeDest), AF);
        uint256 comp = VNextSettlementLib.delayCompensation(AG, bond);
        assertEq(usdc.balanceOf(operator), comp, "operator got the CAPPED delay comp, not the whole bond");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), bond - comp, "remainder burned, not paid out");
        assertEq(usdc.balanceOf(address(e)), 0);
    }
}
