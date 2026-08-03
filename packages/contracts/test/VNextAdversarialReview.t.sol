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
    // A-01  BLOCKED (Wave 3c). The payer-controlled `evidenceCommitter` was a costless, one-transaction
    //       refund switch. Brief §2.8 required the authority to be REMOVED from the payer's side, and it
    //       now is: `UnitConfig` carries NO committer field at all and `submitEvidence` is bound to
    //       `operator`. THE CONSTRAINT THAT STOPS EACH ATTACK BELOW: `submitEvidence`'s
    //       `msg.sender != operator -> OnlyOperator` guard, over an authority no funding input can move.
    //       (The three tests below are the INVERTED forms of the demonstrating A-01a/b/c: same setups,
    //       same money assertions, opposite outcomes. Note that the payer-committer SETUP is no longer
    //       even expressible — `cfgs[0].evidenceCommitter = payer` does not compile — which is itself the
    //       first half of the proof, enforced by this file's own compilation.)
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev INVERTED A-01a. Funding can no longer express a payer committer: there is one committer for
    ///      the whole clone and it is the `operator` the OPERATOR itself signed as its money-plane identity.
    function test_A01a_ThePayerCanNeverBeTheEvidenceCommitter() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(AG, AF, ABPS, 1));
        bytes32 id = _unitId(e);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
        assertEq(e.operator(), operator, "the committer authority IS the operator");
        assertTrue(e.operator() != payer, "and the parties are distinct by construction (PartyCollision)");

        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        e.submitEvidence(id, PKG);
    }

    /// @dev INVERTED A-01b — THE TRACE, blocked. Same sequence: the operator performs and the cohort
    ///      signs a valid SETTLE over the real package. The payer's withholding move is now a revert, the
    ///      operator commits its own package, and the money assertions come out the other way round: the
    ///      payer does NOT recover the gross and the operator side IS paid.
    function test_A01b_PayerCannotWithhold_OperatorPerformsAndIsPaid() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(AG, AF, ABPS, 1));
        bytes32 id = _unitId(e);
        uint256 payerBefore = usdc.balanceOf(payer);

        // The payer's veto attempt: it has no commit authority to withhold OR to misuse.
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        e.submitEvidence(id, keccak256("junk"));

        // The operator commits the package it will be judged on, and the cohort settles it.
        _commit(e, id, PKG);
        _assert(e, id, 1, 1);
        e.acceptAssertion(id); // permissionless — the primary lane is NOT structurally dead any more
        assertEq(uint256(e.unitState(id)), uint256(UnitState.PRIMARY_ASSERTED));

        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(payer), payerBefore, "the payer recovered NOTHING");
        assertEq(usdc.balanceOf(recip1) + usdc.balanceOf(recip2), AG - AF, "operator side paid in full");
        assertEq(usdc.balanceOf(feeDest), AF);
    }

    /// @dev INVERTED A-01c. The one-transaction brick is gone with the authority: a junk one-shot
    ///      commitment from the payer reverts, so the one-shot commit can only ever be spent by the party
    ///      that loses if it is spent badly. The unit settles normally afterwards.
    function test_A01c_PayerCannotBrickReleaseWithAJunkCommit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(AG, AF, ABPS, 1));
        bytes32 id = _unitId(e);

        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        e.submitEvidence(id, keccak256("not-the-package-the-operator-produced"));
        assertFalse(e.evidenceCommittedOf(id), "the one-shot slot was not consumed by the payer");

        // The real package still goes in, and a verdict over it is payable.
        _commit(e, id, PKG);
        _assert(e, id, 1, 1);
        uint256 payerBefore = usdc.balanceOf(payer);
        _settleViaEvidence(e, id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(payer), payerBefore, "no refund lever remains");
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-02  BLOCKED (Wave 3c). Model B now holds on the backup lane too. THE CONSTRAINT: exclusion (1)
    //       in `_emergencyDeadline` — a backup-lane unit is NOT put under an emergency, because there the
    //       reviewer would be the body just killed. The lane resolves under its ORDINARY windows to the
    //       LAST AUTHENTICATED STATE, so the escalation revoker can no longer choose a refund.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_A02_BackupLane_DisableIsNotARefundSwitch_TheLastAuthenticatedStateStands() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _commit(e, id, PKG);

        vm.warp(_cutoff(e, id) - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);
        _backupAssert(e, id);
        uint256 acceptedAt = block.timestamp;
        e.acceptAssertion(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.BACKUP_ASSERTED), "a valid backup SETTLE");

        // Same setup as the demonstrating form: a genuine emergency UPHOLD written and waiting.
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);

        uint256 disabledAt = block.timestamp;
        escalation.disableAtNow(); // the escalation cohort's revoker acts

        // No emergency is OPEN for a backup-lane unit, so the emergency role has nothing to decide...
        vm.expectRevert(VNextSettlementEscrow.NoEmergency.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        // ...and the appeal role is inapplicable (nothing is challenged); a disabled cohort's verdict
        // still cannot move money either way.
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // The unit is NOT paused: it finalizes on its ordinary challenge deadline, to a RELEASE.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(acceptedAt + VNextSettlementLib.CHALLENGE_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(payer), payerBefore, "the revoker could NOT convert a valid SETTLE to a refund");
        assertEq(usdc.balanceOf(recip1) + usdc.balanceOf(recip2), AG - AF, "the operator side was paid");
        assertGt(disabledAt, 0);
    }

    /// @dev The other half of exclusion (1), stated so the fix is not mistaken for "the backup lane always
    ///      releases": a backup lane that never produced a SETTLE still REFUNDS at the assertion cutoff.
    ///      The §8.1 "backup silent ⇒ refund" default is untouched — what changed is only that a disable
    ///      cannot reach an accepted one.
    function test_A02b_BackupLane_WithNoSettle_StillRefundsAtTheCutoff_EvenWhenDisabled() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _commit(e, id, PKG);
        vm.warp(_cutoff(e, id) - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);
        escalation.disableAtNow();

        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(_cutoff(e, id));
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + AG, "no authenticated SETTLE means refund, as designed");
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

    /// @dev INVERTED A-03b — BLOCKED (Wave 3c). Same state, nobody calls `finalize`, and 14 days later
    ///      the primary cohort is disabled. THE CONSTRAINT: exclusion (2) in `_emergencyDeadline` — the
    ///      emergency does not open over a release that was ALREADY DUE at `disabledAt`, so relayer
    ///      inactivity no longer changes the payer's outcome (§8.1's expanded invariant names it
    ///      explicitly). The money assertions are the demonstrating test's, inverted.
    function test_A03b_NobodyFinalized_ALaterDisableCannotReachTheDueRelease() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        // (release is due here — see the control test — but no keeper transacts)

        vm.warp(block.timestamp + 14 days);
        attester.disableAtNow();

        // No pause: the release the control test proved was due is still due, to anyone who asks.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(address(0xD00D));
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(payer), payerBefore, "the payer gained nothing from nobody transacting");
        assertEq(usdc.balanceOf(recip1), (AG - AF) / 2);
        assertEq(usdc.balanceOf(feeDest), AF);
    }

    /// @dev The boundary of exclusion (2), so it cannot be mistaken for "a disable never pauses": a
    ///      disable landing ONE SECOND BEFORE the release is due still opens the emergency and still
    ///      refunds on review silence. Model B is intact for a settlement still inside its window.
    function test_A03c_ADisableOneSecondBeforeTheReleaseIsDue_StillPausesAndRefunds() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        (, uint64 assertedAt,,,,,) = e.settlement(id);
        uint256 due = uint256(assertedAt) + VNextSettlementLib.CHALLENGE_WINDOW;

        vm.warp(due - 1);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();

        vm.warp(due);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id); // PAUSED — the emergency owns this unit

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + AG);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-04  BLOCKED (Wave 3c). THE CONSTRAINT: `resolveEscalation` now refuses the EMERGENCY role once
    //       `block.timestamp >= emergencyDue`, symmetrically with the appeal deadline one branch up. The
    //       deadline is terminal instead of the start of a race between a late UPHOLD and `finalize`.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_A04_EmergencyDeadlineIsTerminal_APostDeadlineUpholdCannotPay() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();

        // Well past the deadline at which `finalize` refunds.
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW + 3 days);
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);

        // The deadline outcome is the only one left, and it is not a race.
        uint256 payerBefore = usdc.balanceOf(payer);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED), "silence refunds AT the deadline");
        assertEq(usdc.balanceOf(feeDest), 0, "the late UPHOLD paid nothing");
        assertEq(usdc.balanceOf(payer), payerBefore + AG);
    }

    /// @dev The boundary: one second before the deadline the emergency cohort can still decide, so the
    ///      terminality fix removed the race without shortening the review window it bounds.
    function test_A04b_TheLastSecondOfTheEmergencyWindowStillDecides() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();

        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW - 1);
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), AF);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // A-05  BLOCKED (Wave 3c). THE CONSTRAINT: the factory's write-once `fundedEscrowOf` marker — funding
    //       ANY generation of a (payer, operator, jobIdHash) retires every other one, which is what
    //       "one funded policy generation per job" always claimed.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_A05_FundingOneGeneration_RetiresTheNewerOneToo() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(AG, AF, ABPS, 1);

        // Generation 1.
        VNextSettlementEscrow e1 = VNextSettlementEscrow(factory.createEscrow(_identity(JOB, 1, cfgs)));
        _fund(e1, cfgs);

        // Generation 2 — a "revision" both parties also signed — can no longer ALSO be funded.
        VNextSettlementEscrow e2 = VNextSettlementEscrow(factory.createEscrow(_identity(JOB, 2, cfgs)));
        VNextSettlementEscrow.PolicyAcceptance memory acc2 = _acceptance(e2, cfgs);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrowFactory.JobAlreadyFunded.selector);
        e2.fund(cfgs, acc2);

        assertTrue(address(e1) != address(e2));
        assertEq(usdc.balanceOf(address(e1)), AG);
        assertEq(usdc.balanceOf(address(e2)), 0, "the operator is bound to ONE signed generation, not both");
        assertEq(factory.fundedEscrowOf(factory.policyKey(payer, operator, JOB)), address(e1));
        assertEq(factory.policyNonceFloor(factory.policyKey(payer, operator, JOB)), 2);
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
        PolicyIdentity memory p = _identity(JOB, 1, cfgs);
        assertEq(factory.predictEscrow(p), address(e));

        // A stranger cannot borrow the factory's verification.
        vm.expectRevert(VNextSettlementEscrowFactory.NotThePolicyEscrow.selector);
        factory.acceptPolicy(p, bytes32(0), payer, POLICY_EXPIRY, bytes(""), bytes(""));

        // Nor can the real clone, if the identity it hands back is not the one its address commits to.
        // WAVE 4b: the tampered field was `arbiter`; it is now `termsHash` — any salt component works, and
        // this one is still in the v2 preimage. (Tampering a REMOVED field would leave the salt unchanged
        // and the call would sail past `NotThePolicyEscrow`, so the substitution is load-bearing — hence
        // the explicit "did the salt actually move?" assertion below.)
        // NOTE: `PolicyIdentity memory` assignment is a REFERENCE copy, so the baseline salt must be read
        // BEFORE the mutation — `saltOf(p)` after it would return the tampered salt and the guard would
        // compare a value with itself.
        bytes32 canonicalSalt = factory.saltOf(p);
        PolicyIdentity memory tampered = p;
        tampered.termsHash = keccak256("not-the-committed-terms");
        assertTrue(factory.saltOf(tampered) != canonicalSalt, "the tamper must actually move the salt");
        vm.prank(address(e));
        vm.expectRevert(VNextSettlementEscrowFactory.NotThePolicyEscrow.selector);
        factory.acceptPolicy(tampered, bytes32(0), payer, POLICY_EXPIRY, bytes(""), bytes(""));
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

    /// @dev The §8.3 H-3 solvency invariant survives the full bond waterfall: appeal silence splits the
    ///      bond into delay-comp + returned remainder (§8.3 C-1) while the job's own G is paid out of the
    ///      JOB bucket only. The property under test is the NON-CROSSING — the job's G reaches the job's
    ///      recipients and the bond's every cent reaches a bond-family destination, with neither family
    ///      financing the other — and it holds under this disposition exactly as it did under the burn.
    function test_S06_BondBucketsNeverCrossTheJobBucket() public {
        (VNextSettlementEscrow e, bytes32 id) = _liveUnit();
        _acceptNow(e, id);
        usdc.mint(payer, 100e6);
        uint256 bond = _challenge(e, id);
        uint256 challengerBefore = usdc.balanceOf(payer); // `challenge` is payer-only
        assertEq(usdc.balanceOf(address(e)), AG + bond);
        assertEq(e.totalLiability(), AG);
        assertEq(e.bondLiability(), bond);

        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        e.finalize(id); // appeal silence -> release + compensate-then-RETURN (C-1)
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(e.totalLiability(), 0);
        assertEq(e.bondLiability(), 0);
        assertEq(e.compLiability(), 0);
        assertEq(e.burnLiability(), 0);
        assertEq(usdc.balanceOf(feeDest), AF);
        uint256 comp = VNextSettlementLib.delayCompensation(AG, bond);
        assertEq(usdc.balanceOf(operator), comp, "operator got the CAPPED delay comp, not the whole bond");
        assertEq(
            usdc.balanceOf(payer), challengerBefore + (bond - comp), "the unused remainder returned to the challenger"
        );
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), 0, "no adjudicated loss, so nothing burned");
        assertEq(usdc.balanceOf(address(e)), 0);
        // The non-crossing, stated as a sum: the bond financed exactly the bond family, and NOTHING else.
        assertEq(comp + (usdc.balanceOf(payer) - challengerBefore), bond, "every cent of the bond is accounted for");
    }
}
