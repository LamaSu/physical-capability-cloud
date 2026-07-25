// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VNextSettlementEscrowTest, MockToken} from "./VNextSettlementEscrow.t.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {
    O5Assertion,
    O5AdjudicationRecord,
    O5_ADJ_ROLE_APPEAL,
    O5_ADJ_ROLE_EMERGENCY,
    O5_ADJ_UPHOLD,
    O5_ADJ_OVERTURN
} from "../src/O5Types.sol";
import {UnitState, ClaimClass, VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/**
 * @title VNextWave3StateMachineTest
 * @notice H-01 §8.1 post-verdict state machine — one test per frozen mechanism.
 * @dev    Inherits the Wave-1/2 harness (fixtures, bilateral acceptance, the mock cohorts) so these
 *         tests exercise the SAME escrow the migrated suite does, rather than a parallel fixture that
 *         could drift from it.
 */
contract VNextWave3StateMachineTest is VNextSettlementEscrowTest {
    uint256 constant G = 1000e6;
    uint256 constant F = 23_500000;
    uint16 constant BPS = 235;

    function _live() internal returns (VNextSettlementEscrow e, bytes32 id) {
        e = _fundedEscrow(JOB, _oneUnitConfig(G, F, BPS, 1));
        id = _unitId(e);
    }

    /// @dev The §8.3 H-3 solvency invariant, asserted directly against the token balance.
    function _assertBucketsCovered(VNextSettlementEscrow e) internal view {
        uint256 sum = e.totalLiability() + e.bondLiability() + e.compLiability() + e.burnLiability();
        assertGe(IERC20(address(usdc)).balanceOf(address(e)), sum, "balance >= sum(buckets)");
    }

    // ══ (1) assertion acceptance: assertedAt is the ESCROW's clock, not the mint time ═══════════════

    /// @dev §8.2 C-3. The attester's record says the verdict was minted 20 days ago; the escrow stamps
    ///      its OWN acceptance time, so the challenge window is FULL from acceptance. If the escrow had
    ///      trusted `O5Assertion.assertedAt`, this stale verdict's window would already have expired and
    ///      the payer would have had zero opportunity to contest it — the exact attack C-3 names.
    function test_C3_AssertedAtIsTheAcceptanceClock_NotTheMintTime() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);

        vm.warp(block.timestamp + 20 days);
        O5Assertion memory a = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e));
        a.assertedAt = uint64(block.timestamp - 20 days); // minted long ago
        attester.setAssertion(id, a);

        uint256 acceptedAt = block.timestamp;
        e.acceptAssertion(id);
        (, uint64 stamped,,,,,) = e.settlement(id);
        assertEq(uint256(stamped), acceptedAt, "the escrow stamps its own clock");

        // One second before the window closes, finalization is still refused and a challenge is still open.
        vm.warp(acceptedAt + VNextSettlementLib.CHALLENGE_WINDOW - 1);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);
        _challenge(e, id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.CHALLENGED), "a stale verdict cannot eat the window");
    }

    /// @dev §8.2 C-3: a verdict that arrives too late for its own challenge + appeal windows to fit
    ///      before `reclaimAt` is REFUSED, so acceptance can never extend the payer's capital lock.
    function test_C3_AssertionCutoff_RefusesALateVerdict() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);
        _assert(e, id, 1, 1);
        uint256 cutoff =
            e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;

        vm.warp(cutoff);
        vm.expectRevert(VNextSettlementEscrow.AssertionCutoffPassed.selector);
        e.acceptAssertion(id);

        vm.warp(cutoff - 1); // one second earlier is fine
        e.acceptAssertion(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.PRIMARY_ASSERTED));
    }

    // ══ (2) challenge window -> default RELEASE, permissionlessly finalizable by ANYONE ═════════════

    function test_ChallengeWindow_UnchallengedDefaultsToReleaseAndIsPermissionless() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);

        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);

        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        vm.prank(address(0xD00D)); // a total stranger — no keeper privilege exists
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), F);
        _assertBucketsCovered(e);
    }

    /// @dev The window is a HARD edge on both sides: once it closes, the payer can no longer challenge.
    function test_ChallengeWindow_ClosesForTheChallengerToo() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ChallengeWindowClosed.selector);
        e.challenge(id);
    }

    // ══ (3) challenger-only bond: bounds, separate buckets, never consumed by job settlement ════════

    /// @dev §8.2 H-2: `minimumBond <= bond <= maxChallengeFraction x G`, with the CEILING binding. The
    ///      point of the ceiling is that a payer must not have to risk ~the disputed amount to contest.
    function test_H2_BondIsWithinTheFrozenBand_AndTheCeilingBinds() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        uint256 bond = e.requiredBondOf(id);
        uint256 cap = (G * uint256(VNextSettlementLib.MAX_CHALLENGE_BOND_BPS)) / VNextSettlementLib.FEE_DENOMINATOR;
        assertEq(bond, 50e6, "5% of a 1,000 USDC job");
        assertGe(bond, VNextSettlementLib.MIN_CHALLENGE_BOND, "at or above the anti-spam floor");
        assertLe(bond, cap, "at or below the H-2 ceiling");
        assertLt(bond, G / 4, "contesting never costs ~the disputed amount");

        // A very small job: the anti-spam floor (1 USDC) would EXCEED the 20%-of-G ceiling (0.4 USDC),
        // and the CEILING wins — the payer's exposure is capped even when the floor cannot be met.
        assertEq(VNextSettlementLib.challengeBond(2e6), 400_000, "the ceiling binds, not the floor");
        assertGt(VNextSettlementLib.challengeBond(2e6), 0, "and it is never a free challenge");
        assertLt(VNextSettlementLib.challengeBond(2e6), VNextSettlementLib.MIN_CHALLENGE_BOND, "below the floor");
    }

    /// @dev §8.3 H-3. The bond is NEW USDC in its own bucket; the job's release pays exactly G out of the
    ///      JOB bucket and the bond is still fully accounted for afterwards. This is the "a job release
    ///      must NEVER consume bond collateral" property, asserted on balances and buckets together.
    function test_H3_JobSettlementNeverConsumesBondCollateral() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 escrowBefore = usdc.balanceOf(address(e));
        assertEq(escrowBefore, G, "only the job collateral is held so far");

        uint256 bond = _challenge(e, id);
        assertEq(usdc.balanceOf(address(e)), G + bond, "the bond is NEW money, not part of G");
        assertEq(e.totalLiability(), G);
        assertEq(e.bondLiability(), bond);
        _assertBucketsCovered(e);

        // Appeal OVERTURN: the job refunds G and the bond returns in full — neither touched the other.
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN);
        uint256 payerBefore = usdc.balanceOf(payer);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(usdc.balanceOf(payer), payerBefore + G + bond);
        assertEq(e.totalLiability(), 0);
        assertEq(e.bondLiability(), 0);
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    /// @dev The solvency gate now covers EVERY bucket, so a job release cannot proceed while the escrow
    ///      could not still cover the bond. Draining the escrow to exactly the job's G (i.e. one wei
    ///      short of covering the bond too) makes the release revert `Insolvent` rather than quietly
    ///      paying the operator out of the challenger's stake.
    function test_H3_SolvencyGateCoversTheBondBuckets() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);

        // Simulate the escrow being short by 1 wei of the bond bucket.
        vm.prank(address(e));
        IERC20(address(usdc)).transfer(address(0xDEAD1), 1);
        assertEq(usdc.balanceOf(address(e)), G + bond - 1);

        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        vm.expectRevert(VNextSettlementEscrow.Insolvent.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
    }

    // ══ (4) appeal: typed, assertion-specific, no distribution authority, SILENCE -> RELEASE ════════

    /// @dev THE safety default of the whole redesign (§2 table + §8.1) AND the §8.3 C-1 bond rule, which
    ///      are two separate halves of the same terminal state:
    ///        * the RELEASE half — silence must not refund, or the payer regains the veto H-01 removed
    ///          simply by challenging and then letting the appeal cohort go quiet;
    ///        * the BOND half — the operator takes its full capped delay compensation, and the UNUSED
    ///          remainder goes back to the CHALLENGER. Nothing is burned, because burning is a penalty and
    ///          no quorum ruled. C-1, verbatim: "SETTLE releases + fixed delay-comp to the operator +
    ///          unused challenger bond returned".
    ///      Wave 3d changed the bond half (it burned the remainder before, treating "no overturn" as a
    ///      finding of fault). The release half — the part that actually closes H-01 — is untouched.
    function test_C1_AppealSilence_ReleasesAndReturnsTheUnusedBond() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);
        uint256 opBefore = usdc.balanceOf(operator);
        uint256 challengerBefore = usdc.balanceOf(payer); // `challenge` is payer-only, so payer == challenger

        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW - 1);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);

        vm.warp(block.timestamp + 1);
        e.finalize(id); // permissionless
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "SILENCE MUST NOT REFUND");
        assertEq(usdc.balanceOf(feeDest), F, "the operator side is paid in full");

        uint256 comp = VNextSettlementLib.delayCompensation(G, bond);
        assertGt(comp, 0, "the operator's delay is still compensated, in full and on schedule");
        assertLt(comp, bond, "and still capped: the delay-comp never swallows the bond");
        assertEq(usdc.balanceOf(operator), opBefore + comp, "capped delay compensation only");
        assertEq(usdc.balanceOf(payer), challengerBefore + (bond - comp), "the UNUSED bond RETURNS (C-1)");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), 0, "nothing burned: no quorum ever ruled");
        assertEq(e.bondLiability(), 0, "no bond collateral left stranded");
        assertEq(e.compLiability(), 0);
        assertEq(e.burnLiability(), 0);
        assertEq(usdc.balanceOf(address(e)), 0, "every bucket emptied to a real destination");
        _assertBucketsCovered(e);
    }

    /// @dev WHY C-1 is not a softening of §2.4, asserted as an economic identity rather than argued: run
    ///      the same job to appeal SILENCE and to an explicit UPHOLD, and the OPERATOR'S TAKE IS IDENTICAL.
    ///      Forfeiting on silence never paid the operator one wei more — it only chose a different home for
    ///      the challenger's remainder (the burn sink instead of the challenger). So the old rule bought no
    ///      operator protection and no extra delay coverage; it was pure destruction of the challenger's
    ///      capital, triggered by an event the challenger neither caused nor could prevent. The half that
    ///      DOES deter a frivolous challenge — the operator's scheduled delay cost — is charged in both.
    function test_C1_SilenceAndUphold_PayTheOperatorIdentically_AndDifferOnlyInTheRemainder() public {
        // (a) appeal SILENCE — the unadjudicated end.
        (VNextSettlementEscrow eS, bytes32 idS) = _live();
        _acceptNow(eS, idS);
        uint256 bond = _challenge(eS, idS);
        uint256 opBefore = usdc.balanceOf(operator);
        uint256 challengerBefore = usdc.balanceOf(payer);
        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        eS.finalize(idS);
        uint256 opFromSilence = usdc.balanceOf(operator) - opBefore;
        uint256 returnedToChallenger = usdc.balanceOf(payer) - challengerBefore;

        // (b) an explicit UPHOLD on an identical job — the adjudicated loss.
        VNextSettlementEscrow eU = _fundedEscrow(keccak256("job-uphold"), _oneUnitConfig(G, F, BPS, 1));
        bytes32 idU = VNextSettlementLib.computeSettlementUnitId(
            block.chainid, address(eU), eU.jobIdHash(), 0, keccak256("step-0")
        );
        _acceptNow(eU, idU);
        assertEq(_challenge(eU, idU), bond, "same job, same bond schedule");
        opBefore = usdc.balanceOf(operator);
        challengerBefore = usdc.balanceOf(payer);
        _adjudicate(eU, idU, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        eU.resolveEscalation(idU, O5_ADJ_ROLE_APPEAL);
        uint256 opFromUphold = usdc.balanceOf(operator) - opBefore;

        // The identity. Both released the job; both charged the challenger the same delay cost.
        assertEq(uint256(eS.unitState(idS)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(uint256(eU.unitState(idU)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(opFromSilence, opFromUphold, "forfeiture never paid the operator more than silence does");
        assertEq(opFromSilence, VNextSettlementLib.delayCompensation(G, bond), "the pre-agreed schedule");

        // The ONLY difference: where the unused remainder went.
        assertEq(returnedToChallenger, bond - opFromSilence, "silence -> back to the challenger");
        assertEq(usdc.balanceOf(payer), challengerBefore, "an ADJUDICATED loss returns nothing");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), bond - opFromUphold, "uphold -> the sink");
        _assertBucketsCovered(eS);
        _assertBucketsCovered(eU);
    }

    /// @dev §8.3 C-5 boundary, on the bond. Killing the ESCALATION cohort makes the appeal quorum unable to
    ///      rule at all (`resolveEscalation` refuses a disabled cohort), so every open challenge falls to
    ///      the appeal-silence default. C-5 freezes that "the revoker may INITIATE but NEVER chooses the
    ///      financial result" — so pressing that kill switch must not also decide that challengers lose
    ///      their bonds. Under the pre-Wave-3d rule it did exactly that: governance action = confiscation.
    function test_C1_DisabledEscalationCohort_DoesNotPenaliseTheChallenger() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);
        uint256 opBefore = usdc.balanceOf(operator);
        uint256 challengerBefore = usdc.balanceOf(payer);

        // The challenger's adjudicating authority is killed by the revoker — not by the challenger.
        escalation.disableAtNow();
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN); // even a signed OVERTURN is now unusable
        vm.expectRevert(VNextSettlementEscrow.OracleCohortDisabled.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // No emergency opens on this unit: `_emergencyDeadline` reads the PRIMARY cohort, which is healthy.
        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        e.finalize(id);

        uint256 comp = VNextSettlementLib.delayCompensation(G, bond);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "release still holds");
        assertEq(usdc.balanceOf(operator), opBefore + comp, "the operator's scheduled delay cost, as always");
        assertEq(usdc.balanceOf(payer), challengerBefore + (bond - comp), "not penalised for a killed authority");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), 0, "a kill switch is not a verdict");
        _assertBucketsCovered(e);
    }

    /// @dev The same hazard on the lane the Wave-3c M-1 fix made reachable. After `invokeBackup` the unit's
    ///      settlement authority IS the escalation cohort, so `_emergencyDeadline` deliberately excludes the
    ///      backup lane (the killed body cannot review itself) and the unit resolves under its ORDINARY
    ///      windows. A challenger who challenged a valid backup SETTLE and then had the adjudicating body
    ///      disabled therefore lands on appeal silence — the concrete case where the old rule stripped a
    ///      bond for a governance action the challenger had no part in.
    function test_C1_BackupLane_DisabledCohort_DoesNotPenaliseTheChallenger() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);
        uint256 cutoff = e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
        vm.warp(cutoff - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);
        _assertOnEscalation(e, id);
        e.acceptAssertion(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.BACKUP_ASSERTED));

        uint256 bond = _challenge(e, id);
        uint256 opBefore = usdc.balanceOf(operator);
        uint256 challengerBefore = usdc.balanceOf(payer);
        escalation.disableAtNow(); // the body that asserted AND would rule on the appeal is now dead

        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        e.finalize(id);

        uint256 comp = VNextSettlementLib.delayCompensation(G, bond);
        (,,, bool backupLane,,,) = e.settlement(id);
        assertTrue(backupLane, "this is the backup lane the M-1 exclusion covers");
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "last authenticated state");
        assertEq(usdc.balanceOf(operator), opBefore + comp);
        assertEq(usdc.balanceOf(payer), challengerBefore + (bond - comp), "the unused bond still returns");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), 0);
        _assertBucketsCovered(e);
    }

    /// @dev §8.3 H-3 on the NEW arithmetic. `COMP_RETURN` is the one disposition where value both leaves
    ///      the bond bucket (the compensation) and STAYS in it (the returned remainder), so the CLAIM
    ///      branch — where no push succeeds and every leg becomes a collateralized claim — is where a
    ///      bucket error would hide. Every bucket is asserted exactly, the solvency invariant holds while
    ///      the claims are outstanding, and the job buckets are untouched by any of it.
    function test_C1_AppealSilence_BucketsAreExactWhenTheReturnBecomesAClaim() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);
        uint256 comp = VNextSettlementLib.delayCompensation(G, bond);

        usdc.setTransferMode(MockToken.Mode.REVERT); // solvent, but every push safe-fails -> CLAIM
        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        e.finalize(id);

        assertEq(e.totalLiability(), G, "a CLAIM never discharges liability; the job still owes G");
        assertEq(e.compLiability(), comp, "the compensation moved bond -> comp bucket and stayed owed");
        assertEq(e.bondLiability(), bond - comp, "the RETURNED remainder is still challenger money");
        assertEq(e.burnLiability(), 0, "nothing was routed to the sink");
        assertEq(usdc.balanceOf(address(e)), G + bond, "and the escrow still physically holds all of it");
        _assertBucketsCovered(e);

        // Discharging the two bond-family claims empties exactly their own buckets and never the job's.
        usdc.setTransferMode(MockToken.Mode.NORMAL);
        uint256 challengerBefore = usdc.balanceOf(payer);
        e.dischargeClaim(
            VNextSettlementLib.computeClaimId(
                block.chainid, address(e), id, VNextSettlementLib.BOND_LEG_INDEX, ClaimClass.BOND
            )
        );
        e.dischargeClaim(
            VNextSettlementLib.computeClaimId(
                block.chainid, address(e), id, VNextSettlementLib.DELAY_COMP_LEG_INDEX, ClaimClass.DELAY_COMP
            )
        );
        assertEq(usdc.balanceOf(payer), challengerBefore + (bond - comp), "the challenger is paid its remainder");
        assertEq(e.bondLiability(), 0);
        assertEq(e.compLiability(), 0);
        assertEq(e.totalLiability(), G, "the JOB legs are still owed: a bond claim settled no job leg");
        _assertBucketsCovered(e);
    }

    /// @dev §2.4 compensate-then-burn on an ADJUDICATED loss — the branch §8.3 C-1 does NOT touch. A quorum
    ///      ruled on the exact accepted assertion and the challenge lost, so there IS a finding, and the
    ///      remainder burns. Stated as an economic property: the winner does not profit. The operator
    ///      receives a CAPPED schedule amount, strictly less than the bond; no part of the remainder
    ///      reaches the counterparty or a treasury; and — the half that separates this from the silence
    ///      rule — the challenger gets nothing back.
    function test_CompensateThenBurn_WinningIsNeverAProfit() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);
        uint256 opBefore = usdc.balanceOf(operator);
        uint256 feeBefore = usdc.balanceOf(feeDest);
        uint256 challengerBefore = usdc.balanceOf(payer);

        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        uint256 comp = usdc.balanceOf(operator) - opBefore;
        assertEq(comp, VNextSettlementLib.delayCompensation(G, bond), "the pre-agreed schedule, nothing else");
        assertLt(comp, bond, "the operator does not capture the bond");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), bond - comp, "remainder to the sink");
        assertEq(usdc.balanceOf(payer), challengerBefore, "an adjudicated loss returns NOTHING to the challenger");
        // The fee recipient (the protocol) received only the ordinary job fee — no share of the bond.
        assertEq(usdc.balanceOf(feeDest) - feeBefore, F, "the protocol earns nothing from the dispute");
        assertEq(usdc.balanceOf(address(e)), 0);
        assertEq(e.bondLiability(), 0);
        assertEq(e.compLiability(), 0);
        assertEq(e.burnLiability(), 0);
    }

    /// @dev §2.5 assertion-specificity: an adjudication naming a DIFFERENT assertion cannot be applied.
    function test_Appeal_IsBoundToTheExactAcceptedAssertion() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        escalation.setAdjudication(
            id,
            O5_ADJ_ROLE_APPEAL,
            O5AdjudicationRecord({
                adjudicationId: keccak256("adj-other"),
                reviewedAssertionId: keccak256("some-other-assertion"),
                escrow: address(e),
                decidedAt: uint64(block.timestamp),
                role: O5_ADJ_ROLE_APPEAL,
                outcome: O5_ADJ_OVERTURN
            })
        );
        vm.expectRevert(VNextSettlementEscrow.IdentityMismatch.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
    }

    /// @dev An adjudication bound to another escrow cannot pay/refund this one.
    function test_Appeal_RejectsAVerdictBoundToAnotherEscrow() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        (,, bytes32 accepted,,,,) = e.settlement(id);
        escalation.setAdjudication(
            id,
            O5_ADJ_ROLE_APPEAL,
            O5AdjudicationRecord({
                adjudicationId: keccak256("adj-elsewhere"),
                reviewedAssertionId: accepted,
                escrow: address(0xE5C0F),
                decidedAt: uint64(block.timestamp),
                role: O5_ADJ_ROLE_APPEAL,
                outcome: O5_ADJ_OVERTURN
            })
        );
        vm.expectRevert(VNextSettlementEscrow.WrongRecipient.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
    }

    /// @dev An appeal may only decide a CHALLENGED unit, and only inside its window.
    function test_Appeal_RequiresAChallengeAndALiveWindow() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN); // signed, but nothing is challenged
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        _challenge(e, id);
        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL); // too late: the release default now owns it
    }

    /// @dev A killed escalation cohort's pre-written verdict must not move money — the symmetric form of
    ///      the rev-3 property that a killed primary cohort's pre-written assertion must not.
    function test_Appeal_ADisabledEscalationCohortCannotPay() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        escalation.disableAtNow();
        vm.expectRevert(VNextSettlementEscrow.OracleCohortDisabled.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
    }

    /// @dev A unit carries at most ONE live challenge, and only the payer may open it.
    function test_Challenge_IsPayerOnlyAndSingleShot() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.OnlyPayer.selector);
        e.challenge(id);
        _challenge(e, id);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.challenge(id);
    }

    // ══ (5) one-way primary -> backup lane (C-4): no verifier shopping ══════════════════════════════

    /// @dev §2.6/§8.2 C-4, the operator's recourse against a WITHHELD primary verdict, end to end: the
    ///      primary never asserts, the operator escalates after `primaryVerdictDue`, the backup cohort
    ///      settles, and the backup SETTLE enters the ORDINARY challenge window.
    function test_C4_BackupLane_WithheldPrimary_BackupSettles_ThenChallengeable() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);

        // Too early: the primary's verdict is not yet overdue.
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.PrimaryVerdictNotDue.selector);
        e.invokeBackup(id);

        uint256 cutoff =
            e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
        vm.warp(cutoff - VNextSettlementLib.BACKUP_WINDOW);

        // The PAYER must not control this lane (§2.6) — that would be the withholding attack with a step.
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        e.invokeBackup(id);

        vm.prank(operator);
        e.invokeBackup(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.BACKUP_PENDING));

        // The backup cohort asserts, under ITS OWN pinned epoch.
        _assertOnEscalation(e, id);
        e.acceptAssertion(id);
        (,,, bool backupLane,,,) = e.settlement(id);
        assertTrue(backupLane, "the unit is on the backup lane");
        assertEq(uint256(e.unitState(id)), uint256(UnitState.BACKUP_ASSERTED));

        // A backup SETTLE is challengeable exactly like a primary one, and defaults to release.
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        _assertBucketsCovered(e);
    }

    /// @dev C-4 no verifier shopping: once escalated, a PRIMARY assertion — even a perfectly valid one
    ///      that arrives later — can never be accepted, and there is exactly one backup outcome.
    function test_C4_AfterEscalation_ThePrimaryLaneIsClosedForGood() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);
        uint256 cutoff =
            e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
        vm.warp(cutoff - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);

        // The primary now produces a perfectly valid SETTLE. It is unreachable: `acceptAssertion` in
        // BACKUP_PENDING reads the ESCALATION cohort, and nothing returns the unit to FUNDED_ACTIVE.
        _assert(e, id, 1, 1);
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        e.acceptAssertion(id); // the escalation cohort has asserted nothing yet

        _assertOnEscalation(e, id);
        e.acceptAssertion(id);
        // ... and a second backup acceptance is impossible too: the state has moved on.
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.acceptAssertion(id);

        // Escalating again is likewise impossible.
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.invokeBackup(id);
    }

    /// @dev §8.1: backup timeout -> REFUND. The operator opened the lane and the backup produced nothing,
    ///      so the last authenticated state is "no settlement" and the payer gets its money back.
    function test_C4_BackupTimeout_Refunds() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);
        uint256 cutoff =
            e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
        vm.warp(cutoff - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);

        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(cutoff);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + G);
    }

    /// @dev The escalation cohort's OWN epoch is pinned at funding and re-checked on the backup lane: a
    ///      backup record echoing the primary's epoch is not the cohort this job was funded against.
    function test_C4_BackupLane_PinsTheEscalationCohortEpoch() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        assertEq(e.escalationAuthEpoch(), ESC_COHORT);
        _commit(e, id, PKG);
        uint256 cutoff =
            e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
        vm.warp(cutoff - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);

        O5Assertion memory a = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e));
        a.oracleAuthEpoch = COHORT; // the PRIMARY cohort's epoch, on the escalation attester
        escalation.setAssertion(id, a);
        vm.expectRevert(VNextSettlementEscrow.OracleCohortMismatch.selector);
        e.acceptAssertion(id);
    }

    // ══ (6) emergency, Model B (C-5): the revoker INITIATES, the cohort decides, silence -> REFUND ══

    /// @dev §8.3 C-5, accepted-but-unfinalized branch. Disabling the primary cohort PAUSES ordinary
    ///      finalization; the emergency cohort then reviews the exact assertion. UPHOLD releases.
    function test_C5_Emergency_PausesFinalization_ThenUpholdReleases() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        attester.disableAtNow();

        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id); // PAUSED: the emergency review window owns this unit now

        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), F);
    }

    /// @dev §8.3 C-5: OVERTURN refunds.
    function test_C5_Emergency_OverturnRefunds() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        attester.disableAtNow();
        uint256 payerBefore = usdc.balanceOf(payer);
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_OVERTURN);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + G);
    }

    /// @dev §8.3 C-5: emergency SILENCE -> REFUND at the immutable deadline. This is the ONE deliberate
    ///      exception to "timeout preserves the last authenticated state", and it is monotone: the
    ///      revoker can grief a settlement into a refund, but can never redirect a cent.
    function test_C5_EmergencySilence_RefundsAtTheImmutableDeadline() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW - 1);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);

        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW);
        e.finalize(id); // permissionless
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + G);
        assertEq(usdc.balanceOf(operator), 0, "the revoker never redirected anything to anyone");
    }

    /// @dev §8.3 C-5, pre-assertion branch: disable -> the primary lane is provably closed, so the
    ///      operator may invoke the backup IMMEDIATELY (not only after `primaryVerdictDue`), and if no
    ///      authenticated SETTLE arrives by the emergency deadline the unit refunds.
    function test_C5_Emergency_BeforeAnyAssertion_OperatorMayEscalateImmediately() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();

        vm.prank(operator);
        e.invokeBackup(id); // allowed at once — waiting out the clock would only burn the operator's window
        assertEq(uint256(e.unitState(id)), uint256(UnitState.BACKUP_PENDING));

        // The backup cohort settles: the operator is paid despite the primary's systemic compromise.
        _assertOnEscalation(e, id);
        e.acceptAssertion(id);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertGt(disabledAt, 0);
    }

    /// @dev The pre-assertion emergency with NO backup at all: refund at the immutable deadline.
    function test_C5_Emergency_BeforeAnyAssertion_NoSettleMeansRefund() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW);
        e.finalize(id);
        assertEq(usdc.balanceOf(payer), payerBefore + G);
    }

    /// @dev The revoker may INITIATE but NEVER decide: with the cohort disabled, the emergency ROLE is
    ///      the only one that can resolve the unit, and the appeal role is locked out so a pre-signed
    ///      appeal cannot pre-empt the systemic-compromise review.
    function test_C5_ModelB_RevokerCannotDecide_AndAppealCannotPreemptTheEmergency() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD); // pre-signed appeal, sitting ready
        attester.disableAtNow();

        vm.expectRevert(VNextSettlementEscrow.EmergencyPaused.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // The emergency cohort — a DIFFERENT authority from the revoker — is the only decider left.
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_OVERTURN);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
    }

    /// @dev With no emergency open, the emergency role has nothing to decide (it is not a second appeal).
    function test_C5_EmergencyRole_RejectedWithoutADeclaredEmergency() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_OVERTURN);
        vm.expectRevert(VNextSettlementEscrow.NoEmergency.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
    }

    function test_ResolveEscalation_RejectsAnUnknownRole() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        vm.expectRevert(VNextSettlementEscrow.BadEscalationRole.selector);
        e.resolveEscalation(id, 7);
    }

    // ══ (9) C-2: an accepted SETTLE PERMANENTLY disables ordinary deadline reclaim ══════════════════

    /// @dev §8.2 C-2, the critical one. A missing keeper does NOT restore reclaim: finalization is
    ///      permissionless and can happen at ANY later time, so the payer waiting past `reclaimAt` gains
    ///      nothing. Asserted well beyond `reclaimAt`, then the release still completes.
    function test_C2_ReclaimIsPermanentlyBarredAfterAcceptance() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);

        vm.warp(e.reclaimAtOf(id));
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.reclaimAfterDeadline(id);

        vm.warp(e.reclaimAtOf(id) + 365 days); // a keeper that never showed up for a YEAR
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.reclaimAfterDeadline(id);

        e.finalize(id); // still finalizable, still a RELEASE
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), F);
    }

    /// @dev C-2 second half: a validly-opened challenge likewise bars reclaim from bypassing the appeal.
    function test_C2_AValidChallengeAlsoBarsReclaim() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        vm.warp(e.reclaimAtOf(id) + 1);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.reclaimAfterDeadline(id);
    }

    /// @dev And the BACKUP lane bars it too — its own timeout (the assertion cutoff) is the refund path.
    function test_C2_BackupPendingBarsReclaim() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        uint256 cutoff =
            e.reclaimAtOf(id) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
        vm.warp(cutoff - VNextSettlementLib.BACKUP_WINDOW);
        vm.prank(operator);
        e.invokeBackup(id);
        vm.warp(e.reclaimAtOf(id) + 1);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.reclaimAfterDeadline(id);
    }

    // ══ (8) finality at window-close: the receipt/fee key off FINALIZED, never the raw attestation ══

    /// @dev §2.7. Between acceptance and finalization NOTHING has been realized: the fee has not moved,
    ///      no payout has moved, the liability is untouched, and no claim exists. That is what lets a
    ///      composition child safely key off the finalized state instead of the raw attestation.
    function test_FinalityAtWindowClose_NothingIsRealizedBeforeFinalize() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        assertEq(usdc.balanceOf(feeDest), 0, "no fee realized on the raw attestation");
        assertEq(usdc.balanceOf(recip1), 0);
        assertEq(e.liabilityOf(id), G, "full liability still committed");
        assertEq(e.remainingClaimCountOf(id), 0);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.PRIMARY_ASSERTED), "not an allocation state");

        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        e.finalize(id);
        assertEq(usdc.balanceOf(feeDest), F, "realized exactly at window-close");
        assertEq(e.liabilityOf(id), 0);
    }

    /// @dev The §2 authorization key is consumed by the ALLOCATION, so a finalized unit cannot be
    ///      finalized twice even though `finalize` is permissionless.
    function test_Finalize_IsIdempotentlyGuarded() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        e.finalize(id);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.finalize(id);
    }

    /// @dev `finalize` is not a refund lever: a FUNDED_ACTIVE unit with no emergency has no finalize path.
    function test_Finalize_RejectsAFundedActiveUnitWithNoEmergency() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        vm.warp(block.timestamp + 31 days);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.finalize(id);
    }

    // ══ (11) C-6: Tier-0 is UNCHANGED — explicit buyer approval or deadline refund ══════════════════

    /// @dev §8.3 C-6. No optimistic Tier-0 ships: a Tier-0 unit cannot enter the evidence machine at all,
    ///      and operator silence/assertion is never a payment authorization for it.
    function test_C6_Tier0_HasNoOptimisticPath() public {
        VNextSettlementEscrow e = _fundedEscrow(keccak256("t0"), _oneUnitConfig(G, 0, 0, 0));
        bytes32 id = _unitId(e);
        vm.prank(operator);
        e.submitEvidence(id, PKG);
        _assert(e, id, 1, 3); // a maximal, perfectly-formed SETTLE for a Tier-0 unit
        vm.expectRevert(VNextSettlementEscrow.Tier0NotEvidence.selector);
        e.acceptAssertion(id);

        // The only two Tier-0 exits remain: explicit buyer approval, or the deadline refund.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(block.timestamp + 31 days);
        e.reclaimAfterDeadline(id);
        assertEq(usdc.balanceOf(payer), payerBefore + G);
    }

    // ══ helpers ════════════════════════════════════════════════════════════════════════════════════

    /// @dev A backup SETTLE: the SAME `O5Assertion` shape, written by the ESCALATION cohort under its own
    ///      pinned epoch. That a backup verdict needs no new escrow machinery is the point — the escrow
    ///      reads one record type from one of two precommitted attesters.
    function _assertOnEscalation(VNextSettlementEscrow e, bytes32 id) internal {
        O5Assertion memory a = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e));
        a.assertionId = keccak256("backup-assertion-1");
        a.oracleAuthEpoch = ESC_COHORT;
        escalation.setAssertion(id, a);
    }
}
