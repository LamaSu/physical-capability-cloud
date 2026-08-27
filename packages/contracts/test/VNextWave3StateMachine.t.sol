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
import {VNextReadLens} from "./helpers/VNextReadLens.sol"; // WAVE 4c read adapter

using VNextReadLens for VNextSettlementEscrow;

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

        // The challenger's adjudicating authority is killed by the revoker — not by the challenger — and
        // it had NOT ruled. (H-02: no post-disable record is planted here any more, because none can
        // exist: `O5AttesterBase.adjudicate` refuses a disabled cohort, so a killed authority's effect on
        // an unruled challenge is exactly this — silence — and nothing else.)
        escalation.disableAtNow();
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
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
            address(e),
            uint64(e.challengedAtOf(id)), // ATT-01: the real appeal window, so the slot is the live one
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

    /// @dev An adjudication bound to another escrow cannot pay/refund this one. The record is planted in
    ///      THIS escrow's own slot (M-05 keys the slot on the escrow, so a foreign-escrow record could not
    ///      otherwise land here at all) precisely to show the escrow's OWN `WrongRecipient` defense still
    ///      stands unaided — a non-conforming attester cannot talk it into paying.
    function test_Appeal_RejectsAVerdictBoundToAnotherEscrow() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        (,, bytes32 accepted,,,,) = e.settlement(id);
        escalation.setAdjudication(
            id,
            O5_ADJ_ROLE_APPEAL,
            address(e),
            uint64(e.challengedAtOf(id)), // ATT-01: right slot, wrong bound escrow -- the point of the test
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

    /// @dev An appeal may only decide a CHALLENGED unit, and only over a verdict DECIDED inside its window.
    /// @dev H-01 (sol 4th-family): the second half used to warp past the deadline with a verdict decided
    ///      BEFORE it and expect a revert — i.e. it asserted that a timely verdict expires on RELAY time.
    ///      The deadline now bounds the DECISION time (`O5AdjudicationRecord.decidedAt`), so the case that
    ///      must revert is a verdict DECIDED at/after the deadline. The timely-record-late-relay case is
    ///      the opposite assertion and has its own test below.
    function test_Appeal_RequiresAChallengeAndAVerdictDecidedInTheWindow() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN); // signed, but nothing is challenged
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        _challenge(e, id);
        vm.warp(block.timestamp + VNextSettlementLib.APPEAL_WINDOW);
        // Decided AT the deadline (not before it): the release default owns the unit and this is refused.
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
    }

    /// @dev H-02 (sol 4th-family) — INVERTED. This test previously asserted that disabling the escalation
    ///      cohort neutralized an already-recorded verdict, and that behaviour was the finding: since
    ///      `O5AttesterBase.adjudicate` refuses a disabled cohort, EVERY stored record predates the
    ///      disable, so the escrow's runtime `disabledAt() != 0` re-check could never reject a
    ///      post-disable record — it could only let the revoker, having SEEN a verdict it disliked, delete
    ///      its effect and take the silence default instead. §8.3 C-5 freezes that a revoker may INITIATE
    ///      but never CHOOSE the financial result. So the recorded verdict now stands.
    function test_H02_DisableCannotVetoAnAlreadyRecordedAdjudication() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);
        uint256 payerBefore = usdc.balanceOf(payer);
        uint256 feeBefore = usdc.balanceOf(feeDest);

        // A valid UPHOLD is recorded while the cohort is live — the only way a record can ever exist.
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        // ...and only THEN does the revoker press the kill switch, having seen the verdict.
        escalation.disableAtNow();

        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "the verdict still decides");
        assertEq(usdc.balanceOf(feeDest), feeBefore + F, "the operator side was paid, as the quorum ruled");
        // The UPHOLD's own §2.4 disposition applies too — the revoker did not get to pick that either.
        uint256 comp = VNextSettlementLib.delayCompensation(G, bond);
        assertEq(usdc.balanceOf(payer), payerBefore, "no refund, and no bond back on an adjudicated loss");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), bond - comp, "the adjudicated burn, not silence");
        _assertBucketsCovered(e);
    }

    /// @dev The other direction of the same lever: the revoker cannot suppress an OVERTURN either. Before
    ///      the fix, disabling turned a recorded refund verdict into the appeal-silence RELEASE.
    function test_H02_DisableCannotVetoARecordedOverturnEither() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);
        uint256 payerBefore = usdc.balanceOf(payer);

        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN);
        escalation.disableAtNow();

        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED), "the OVERTURN still decides");
        assertEq(usdc.balanceOf(payer), payerBefore + G + bond, "refund plus the whole bond back");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), 0, "an adjudicated win burns nothing");
        _assertBucketsCovered(e);
    }

    // ══ WAVE 4b — THE GLOBAL APPEAL RULE (the 4th instance of the H-01 class) ══════════════════════
    //
    //     challengedAt <= appeal.decidedAt    <  min(appealDue, disabledAt)  => APPEAL is final
    //     disabledAt   <= emergency.decidedAt <  emergencyDue                => EMERGENCY owns
    //     at equality, EMERGENCY wins (timestamps cannot order two txs inside one block)
    //
    // The defect: `resolveEscalation(APPEAL)` reverted `EmergencyPaused` the instant ANY emergency was
    // open, BEFORE anything read the stored `decidedAt` — so a timely appeal already RECORDED on-chain was
    // discarded by a LATER disable. Relayer inactivity plus a disable improved the payer's outcome, which
    // is the invariant §0 exists to protect. Fixing only that branch would have left first-relayer-wins in
    // three other places, so the rule is applied globally: `finalize`, both `resolveEscalation` branches,
    // and both roles gained the missing LOWER bound.
    //
    // Each test below is annotated with what it does against PRE-FIX code. The four marked
    // [FAILS PRE-FIX] were each confirmed by reverting the fix, watching them fail, and restoring it.
    // The two marked [GUARD] pass both before and after BY DESIGN — they pin the anti-capture property
    // the fix must not trade away, and are stated as guards rather than dressed up as regressions.

    /// @dev Stamp an adjudication with an EXPLICIT decision time, so the boundary tests below can sit one
    ///      second either side of `disabledAt` instead of relying on same-block coincidence.
    function _adjudicateAt(VNextSettlementEscrow e, bytes32 id, uint8 role, uint8 outcome, uint256 decidedAt)
        internal
    {
        (,, bytes32 accepted,,,,) = e.settlement(id);
        escalation.setAdjudication(
            id,
            role,
            address(e),
            uint64(role == O5_ADJ_ROLE_APPEAL ? e.challengedAtOf(id) : e.emergencyAnchorOf(id)), // ATT-01
            O5AdjudicationRecord({
                adjudicationId: keccak256(abi.encode("adj-at", id, role, outcome, decidedAt)),
                reviewedAssertionId: accepted,
                escrow: address(e),
                decidedAt: uint64(decidedAt),
                role: role,
                outcome: outcome
            })
        );
    }

    /// @dev Accept + challenge, then disable the PRIMARY cohort `gap` seconds later, and report the two
    ///      instants the rule is written in terms of.
    function _challengedThenDisabled(uint256 gap)
        internal
        returns (VNextSettlementEscrow e, bytes32 id, uint256 challengedAt, uint256 disabledAt)
    {
        (e, id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        challengedAt = block.timestamp;
        vm.warp(challengedAt + gap);
        attester.disableAtNow();
        disabledAt = block.timestamp;
    }

    /// @dev [FAILS PRE-FIX] THE HEADLINE FIX. A timely APPEAL verdict RECORDED BEFORE the disable is
    ///      HONOURED, not discarded by the emergency that opened afterwards.
    ///      Pre-fix: `resolveEscalation(APPEAL)` reverts `EmergencyPaused` without ever reading
    ///      `decidedAt`, and the payer collects the emergency-silence refund at `emergencyDue` — i.e. the
    ///      operator loses an already-authenticated OVERTURN/UPHOLD to relayer inactivity plus a disable.
    function test_WAVE4B_TimelyAppealRecordedBeforeDisable_IsHonoured() public {
        (VNextSettlementEscrow e, bytes32 id, uint256 challengedAt, uint256 disabledAt) =
            _challengedThenDisabled(2 days);
        // The quorum ruled STRICTLY BEFORE the declaration, and it ruled UPHOLD (the operator is paid).
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD, disabledAt - 1);
        assertGe(disabledAt - 1, challengedAt, "the record is inside the appeal window's lower bound");
        uint256 feeBefore = usdc.balanceOf(feeDest);

        // Nobody relayed it for a while; the emergency review window elapses. The appeal still owns it.
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW + 1 days);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "the recorded appeal decides");
        assertEq(usdc.balanceOf(feeDest), feeBefore + F, "the operator side was paid, as the quorum ruled");
        _assertBucketsCovered(e);
    }

    /// @dev [FAILS PRE-FIX] The same rule seen from `finalize`: the emergency-silence REFUND must stand
    ///      aside for that earlier appeal. Patching only `resolveEscalation` would have moved the bug
    ///      rather than fixed it — whoever transacted first would still decide the outcome.
    function test_WAVE4B_Finalize_StandsAsideForAQualifyingEarlierAppeal() public {
        (VNextSettlementEscrow e, bytes32 id,, uint256 disabledAt) = _challengedThenDisabled(2 days);
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD, disabledAt - 1);
        uint256 payerBefore = usdc.balanceOf(payer);

        // Past the emergency deadline, `finalize` would ordinarily fire the silence refund. It must not.
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);
        assertEq(usdc.balanceOf(payer), payerBefore, "the payer collected no silence refund");

        // Not a brick: the appeal it deferred to is permissionless and still applicable, by anyone.
        vm.prank(address(0xD00D));
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    /// @dev [FAILS PRE-FIX] ...and the EMERGENCY role defers to it too, so the two roles can never both
    ///      decide one unit. Pre-fix there is no such deferral: whichever call lands first wins, and an
    ///      emergency OVERTURN could overwrite an earlier appeal UPHOLD.
    function test_WAVE4B_EmergencyDefersToAQualifyingEarlierAppeal() public {
        (VNextSettlementEscrow e, bytes32 id,, uint256 disabledAt) = _challengedThenDisabled(2 days);
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD, disabledAt - 1); // earlier: pay the operator
        _adjudicateAt(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_OVERTURN, disabledAt + 1); // later: refund

        vm.expectRevert(VNextSettlementEscrow.AppealIsFinal.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);

        uint256 feeBefore = usdc.balanceOf(feeDest);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "the EARLIER record decides");
        assertEq(usdc.balanceOf(feeDest), feeBefore + F);
    }

    /// @dev [GUARD] The anti-capture half, and the EQUALITY tie-break. An appeal decided AT or AFTER the
    ///      declaration is REJECTED — a merely pre-signed appeal cannot pounce on the systemic-compromise
    ///      review that was declared to override it. This is why honouring the earlier record is safe:
    ///      `decidedAt` is stamped by the ATTESTER at WRITE time (`O5AttesterBase.adjudicate`) and is not
    ///      a field of the signed struct (`_adjDigest` excludes it), so signers cannot backdate it.
    ///      MEASURED against pre-fix code: the REJECTION is unchanged (pre-fix the blanket
    ///      `EmergencyPaused` rejected everything here); only the error IDENTITY moves, to
    ///      `WindowStillOpen`. So this is a guard on behaviour, not a regression test — the fix's
    ///      DISCRIMINATING neighbour is the `disabledAt - 1` case one test above.
    /// @dev TWO ERRORS, deliberately distinct — verified, not assumed:
    ///        * `EmergencyPaused` when the declaration lands AT OR BEFORE `challengedAt`, so the appeal
    ///          has NO qualifying window at all (`due <= from`) and the emergency owns the unit outright.
    ///          That is the case `test_C5_ModelB_...` exercises (challenge and disable in one block).
    ///        * `WindowStillOpen` when a window DID exist and this verdict simply fell outside it — the
    ///          same error the late-verdict case raises, because it is the same fact.
    ///      Both are rejections; the difference is only which is true. Collapsing them to one error would
    ///      lose the distinction between "there was never an appeal to make" and "this appeal was late".
    function test_WAVE4B_AppealDecidedAtOrAfterTheDisable_IsRejected() public {
        (VNextSettlementEscrow e, bytes32 id, uint256 challengedAt, uint256 disabledAt) =
            _challengedThenDisabled(2 days);
        assertGt(disabledAt, challengedAt, "an appeal window DID open before the declaration");

        // EQUALITY: `decidedAt == disabledAt` -> EMERGENCY wins. Two txs in one block are unordered by
        // timestamp, so the tie is broken by a stated rule rather than by mining order.
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN, disabledAt);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // STRICTLY AFTER: rejected for the same reason, a fortiori.
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN, disabledAt + 1);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // And the emergency cohort — a different authority from the revoker — still decides it.
        _adjudicateAt(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_OVERTURN, disabledAt + 1);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
    }

    /// @dev [GUARD] The other error's own case: a declaration AT OR BEFORE `challengedAt` leaves the
    ///      appeal with no window at all, so `EmergencyPaused` is raised before any record is read.
    ///      This is the branch that keeps a payer from opening a challenge AFTER a compromise is declared
    ///      and then having an appeal quorum decide it.
    function test_WAVE4B_DeclarationAtOrBeforeTheChallenge_LeavesNoAppealWindow() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        attester.disableAtNow();
        uint256 disabledAt = block.timestamp;
        _challenge(e, id); // same block: challengedAt == disabledAt
        assertEq(block.timestamp, disabledAt, "challenge and declaration share an instant");

        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN, disabledAt);
        vm.expectRevert(VNextSettlementEscrow.EmergencyPaused.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
    }

    /// @dev [FAILS PRE-FIX] The EMERGENCY role's own missing LOWER bound — a separate bug in the same
    ///      family. `O5AttesterBase.adjudicate` requires only that the ESCALATION cohort is enabled; it
    ///      never consults the PRIMARY cohort's `disabledAt`. So an EMERGENCY record could be written
    ///      BEFORE any emergency existed and then activate once one was declared — a pre-signed verdict
    ///      reviewing a compromise that had not happened yet.
    ///      Pre-fix: `resolveEscalation(EMERGENCY)` APPLIES it (only `decidedAt < emergencyDue` was
    ///      checked), so the record's holder picks the outcome the moment the revoker acts.
    function test_WAVE4B_PreDeclarationEmergencyRecord_CannotActivateLater() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 preDeclaration = block.timestamp;
        // Recorded now, while no emergency is open at all.
        _adjudicateAt(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_OVERTURN, preDeclaration);

        vm.warp(preDeclaration + 1 days);
        attester.disableAtNow();
        uint256 disabledAt = block.timestamp;
        assertLt(preDeclaration, disabledAt, "the record really does predate the declaration");

        // It is inert: it answers a review that did not exist when it was decided.
        // ATT-01 makes that inertness STRUCTURAL rather than time-checked, so the error moved from
        // `WindowStillOpen` to `AttestationNotFound`. When this record was written no emergency existed,
        // so `emergencyAnchorOf` returned 0 (the four §8.3 C-5 exclusions decide that, not the attester)
        // and it was filed under anchor 0. The escrow looks up the real `disabledAt` anchor and finds
        // nothing. A pre-signed veto can no longer sit in the slot waiting for a window to open.
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);

        assertEq(
            escalation.adjudicationOf(id, O5_ADJ_ROLE_EMERGENCY, address(e), uint64(disabledAt)).adjudicationId,
            bytes32(0),
            "the pre-declaration record never entered the live emergency window's slot"
        );

        // [FAILS PRE-FIX] and it does not BRICK the unit either. Pre-fix, `finalize`'s one-sided
        // `_decidedInTime` also saw this stale record as "decided in time" and reverted forever, so the
        // unit could neither finalize nor resolve. It now takes its ordinary emergency-silence refund.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED), "the ordinary default fires");
        assertEq(usdc.balanceOf(payer), payerBefore + G, "the payer is refunded, not stranded");
        _assertBucketsCovered(e);
    }

    /// @dev [FAILS PRE-FIX] The APPEAL role's missing LOWER bound, with no emergency anywhere in sight.
    ///      An appeal record can be written any time after the assertion is ACCEPTED — potentially before
    ///      the challenge it purports to answer was ever filed. Pre-fix only `decidedAt < challengedAt +
    ///      APPEAL_WINDOW` was checked, so such a verdict decided the challenge in advance: the appeal
    ///      quorum ruling on a dispute that did not exist.
    /// @dev [RESTORED COVERAGE] The escrow's LOWER-BOUND time check, exercised with the record in the
    ///      CORRECT LIVE SLOT so the lookup actually FINDS it and the comparison at
    ///      `VNextSettlementEscrow.sol:1889` runs.
    ///
    ///      WHY THIS EXISTS. ATT-01 changed the two tests below from `WindowStillOpen` to
    ///      `AttestationNotFound`, because a record written before its window is now filed under anchor 0
    ///      and is structurally unfindable. That is a genuine strengthening of the IMPLEMENTATION -- but a
    ///      cross-family review (sol/GPT-5.6) pointed out those were the ONLY tests reaching the escrow's
    ///      `decidedAt < decisionFrom` branch, so the change silently REMOVED that coverage while the
    ///      suite stayed green. The author had claimed the change was "strictly stronger"; it was stronger
    ///      in the contract and weaker in the tests. This restores the missing half.
    ///
    ///      Here the appeal record carries the RIGHT anchor (so it is found) but a `decidedAt` that
    ///      PREDATES `challengedAt` -- a verdict decided before the challenge it purports to answer.
    ///      The escrow must reject it on TIME, not on absence.
    function test_WAVE4B_LowerBound_RecordInTheLiveSlotButDecidedTooEarly_IsRejectedOnTime() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 beforeChallenge = block.timestamp;

        vm.warp(beforeChallenge + 1 days);
        _challenge(e, id);
        uint256 challengedAt = block.timestamp;
        assertLt(beforeChallenge, challengedAt, "the decision really does predate the challenge");

        // The LIVE anchor -- so the escrow's lookup FINDS this record -- but decided BEFORE the window.
        (,, bytes32 accepted,,,,) = e.settlement(id);
        escalation.setAdjudication(
            id,
            O5_ADJ_ROLE_APPEAL,
            address(e),
            uint64(e.challengedAtOf(id)), // the CORRECT live slot
            O5AdjudicationRecord({
                adjudicationId: keccak256("decided-too-early"),
                reviewedAssertionId: accepted,
                escrow: address(e),
                decidedAt: uint64(beforeChallenge), // < decisionFrom
                role: O5_ADJ_ROLE_APPEAL,
                outcome: O5_ADJ_OVERTURN
            })
        );

        // Proves the record IS findable -- otherwise this test would be re-testing AttestationNotFound.
        assertEq(
            escalation.adjudicationOf(id, O5_ADJ_ROLE_APPEAL, address(e), uint64(challengedAt)).adjudicationId,
            keccak256("decided-too-early"),
            "precondition: the record occupies the LIVE window's slot"
        );

        // Found, then rejected on the LOWER TIME BOUND -- the branch ATT-01's key check would have hidden.
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // Not bricked: appeal silence still resolves to the RELEASE default.
        vm.warp(challengedAt + VNextSettlementLib.APPEAL_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "the silence default fires");
        _assertBucketsCovered(e);
    }

    function test_WAVE4B_AppealDecidedBeforeTheChallenge_IsRejected() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 preChallenge = block.timestamp;
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN, preChallenge);

        vm.warp(preChallenge + 1 days);
        _challenge(e, id);
        uint256 challengedAt = block.timestamp;
        assertLt(preChallenge, challengedAt, "the record really does predate the challenge");

        // ATT-01 STRENGTHENED THIS, and the error changed because the defense moved EARLIER.
        // Before: the escrow FOUND the pre-challenge record and rejected it on a time comparison
        //   (`WindowStillOpen`) -- correct, but it depended on the escrow reasoning about `decidedAt`.
        // Now: the slot key includes the window anchor. When this record was written the unit was not yet
        //   CHALLENGED, so `challengedAtOf` returned 0 and the record was filed under anchor 0. The escrow
        //   looks up the anchor it derives -- the real `challengedAt` -- and the record is simply NOT
        //   THERE. A verdict for a window that never opened can no longer occupy the live window's slot.
        // The assertion is therefore STRICTER, not looser: structural absence rather than a rejected find.
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);

        // Prove the structural property directly, not just via the revert: the live window's slot is EMPTY.
        assertEq(
            escalation.adjudicationOf(id, O5_ADJ_ROLE_APPEAL, address(e), uint64(challengedAt)).adjudicationId,
            bytes32(0),
            "the pre-challenge record never entered the live appeal window's slot"
        );

        // And the unit is not bricked: appeal silence resolves to the RELEASE default, as §8.3 C-1 says.
        vm.warp(challengedAt + VNextSettlementLib.APPEAL_WINDOW);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "the silence default fires");
        _assertBucketsCovered(e);
    }

    /// @dev [GUARD] The rule did not widen the appeal's UPPER bound: a verdict decided at/after
    ///      `appealDue` is still late, emergency or no emergency. Guards against the fix being read as
    ///      "any recorded appeal always wins".
    function test_WAVE4B_AppealDecidedAfterItsOwnDeadline_IsStillLate() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        uint256 appealDue = block.timestamp + VNextSettlementLib.APPEAL_WINDOW;
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN, appealDue);

        vm.warp(appealDue);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        e.finalize(id); // the release default owns it
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
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
    ///      the only one that can resolve the unit, and the appeal role is locked out so an appeal that
    ///      did not beat the declaration cannot pre-empt the systemic-compromise review.
    /// @dev WAVE 4b — WHAT THIS TEST ACTUALLY EXERCISES, restated because the old comment called the
    ///      record "pre-signed" when it is in fact RECORDED. `_adjudicate` stamps `decidedAt =
    ///      block.timestamp` and `disableAtNow()` runs in the SAME block, so this is the EQUALITY case:
    ///      `appeal.decidedAt == disabledAt`, where the frozen rule gives the unit to the EMERGENCY
    ///      (timestamps cannot order two transactions inside one block, so the tie needs a stated rule).
    ///      The outcome is unchanged, and it is now unchanged for a reason the comment names. The case
    ///      the rule DOES treat differently — a record strictly EARLIER than the declaration — is
    ///      `test_WAVE4B_TimelyAppealRecordedBeforeDisable_IsHonoured`.
    function test_C5_ModelB_RevokerCannotDecide_AndAppealCannotPreemptTheEmergency() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD); // decidedAt == the disable instant, below
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

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // (10) sol 4th-family audit — H-01 / M-02 / M-03. Every test here is the DEMONSTRATING form of a
    //      finding, i.e. it fails against the pre-fix contract. The shared invariant they defend:
    //      once a valid SETTLE is accepted, neither ordinary reclaim, challenger silence, appeal
    //      silence, RELAYER INACTIVITY, nor authority withholding may improve the payer's outcome.
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev H-01, emergency lane — THE audit scenario, verbatim. A quorum records a TIMELY emergency
    ///      UPHOLD at `emergencyDue - 1`; nobody relays `resolveEscalation`. Before the fix, the
    ///      resolution then reverted against the CURRENT block timestamp and the payer's `finalize`
    ///      collected the silence refund — an authenticated RELEASE converted to a REFUND by nothing but
    ///      relayer inactivity, with no challenge and no OVERTURN. `decidedAt` proves it was in time.
    function test_H01_TimelyEmergencyUphold_SurvivesAnArbitrarilyLateRelay() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();
        uint256 emergencyDue = disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.warp(emergencyDue - 1); // the last second of the review window
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);

        // ... and then NOBODY transacts for a fortnight.
        vm.warp(emergencyDue + 14 days);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id); // the silence default stands aside: this was not silence

        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY); // permissionless, and still live
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "the timely UPHOLD decides");
        assertEq(usdc.balanceOf(feeDest), F, "the operator side was paid");
        assertEq(usdc.balanceOf(payer), payerBefore, "relayer inactivity bought the payer nothing");
        _assertBucketsCovered(e);
    }

    /// @dev H-01, the symmetric appeal-lane form: a timely OVERTURN must not be discarded into the
    ///      appeal-silence RELEASE default just because it was relayed late.
    function test_H01_TimelyAppealOverturn_SurvivesALateRelay() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 bond = _challenge(e, id);
        uint256 appealDue = block.timestamp + VNextSettlementLib.APPEAL_WINDOW;
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.warp(appealDue - 1);
        _adjudicate(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN);

        vm.warp(appealDue + 3 days);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.finalize(id);

        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED), "the timely OVERTURN decides");
        assertEq(usdc.balanceOf(payer), payerBefore + G + bond, "refund plus the whole bond back");
        assertEq(usdc.balanceOf(feeDest), 0);
        _assertBucketsCovered(e);
    }

    /// @dev H-01's other edge, stated so the fix is not mistaken for "the deadline stopped mattering":
    ///      the deadline still bounds the DECISION. A verdict decided AT the deadline is refused, and the
    ///      silence default then proceeds normally.
    function test_H01_AnEmergencyDecidedAtTheDeadline_DoesNotApply_AndSilenceStillRefunds() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        uint256 emergencyDue = block.timestamp + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;
        attester.disableAtNow();
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.warp(emergencyDue); // decided exactly AT the deadline — one second too late
        _adjudicate(e, id, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);

        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED), "silence still refunds");
        assertEq(usdc.balanceOf(payer), payerBefore + G);
    }

    /// @dev M-02 — Tier-0 has NO emergency, therefore no early-refund authority. A Tier-0 unit can enter
    ///      neither assertion lane, so the primary cohort has no role in it at all; before the fix,
    ///      disabling that cohort still made `finalize` refund at `disabledAt + 5 days`, which a payer who
    ///      is also the allowed primary revoker could race MONTHS ahead of the bilaterally signed
    ///      `reclaimAt`. §8.3 C-6 freezes Tier-0 to "buyer approval or reclaim only".
    function test_M02_Tier0_HasNoEmergencyEarlyRefundAuthority() public {
        VNextSettlementEscrow e = _fundedEscrow(keccak256("t0-emg"), _oneUnitConfig(G, 0, 0, 0));
        bytes32 id = _unitId(e);
        uint256 reclaimAt = e.reclaimAtOf(id);
        attester.disableAtNow();
        uint256 payerBefore = usdc.balanceOf(payer);

        // Well past what WOULD have been the emergency deadline, and still long before `reclaimAt`.
        vm.warp(block.timestamp + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW + 1 days);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.finalize(id); // FUNDED_ACTIVE with no emergency: `reclaimAfterDeadline` is the only exit
        vm.expectRevert(VNextSettlementEscrow.TooEarlyToReclaim.selector);
        e.reclaimAfterDeadline(id);
        assertEq(usdc.balanceOf(payer), payerBefore, "no early refund exists for Tier-0");

        // The signed deadline still works, unchanged.
        vm.warp(reclaimAt);
        e.reclaimAfterDeadline(id);
        assertEq(usdc.balanceOf(payer), payerBefore + G, "the bilaterally signed deadline, and only it");
    }

    /// @dev M-03(a) — the emergency deadline may never outlive `reclaimAt`. Accept just before the
    ///      cutoff, challenge just before ITS deadline, then disable just before the appeal expires:
    ///      `disabledAt + EMERGENCY_REVIEW_WINDOW` lands ~5 days PAST the signed `reclaimAt`, with
    ///      ordinary reclaim permanently barred — the payer's capital locked beyond the date both parties
    ///      signed. No emergency opens when the review cannot fit (a TRUNCATED one would be worse: the
    ///      revoker would pick the moment and thereby the result), so the unit resolves under its ordinary
    ///      windows, before `reclaimAt`.
    function test_M03_EmergencyDeadlineNeverOutlivesReclaimAt() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(G, F, BPS, 1);
        c[0].reclaimAt = block.timestamp + VNextSettlementLib.MIN_RECLAIM_DELAY; // the tightest legal job
        VNextSettlementEscrow e = _fundedEscrow(keccak256("m03-cap"), c);
        bytes32 id = _unitId(e);
        uint256 reclaimAt = e.reclaimAtOf(id);

        _commit(e, id, PKG);
        _assert(e, id, 1, 1);
        vm.warp(reclaimAt - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW - 1);
        e.acceptAssertion(id);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW - 1);
        _challenge(e, id);
        uint256 appealDue = block.timestamp + VNextSettlementLib.APPEAL_WINDOW;

        vm.warp(appealDue - 1);
        uint256 disabledAt = block.timestamp;
        attester.disableAtNow();
        assertGt(
            disabledAt + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW,
            reclaimAt,
            "precondition: an unbounded emergency WOULD have run past the signed deadline"
        );

        // No emergency opened, so the emergency role has nothing to decide...
        vm.expectRevert(VNextSettlementEscrow.NoEmergency.selector);
        e.resolveEscalation(id, O5_ADJ_ROLE_EMERGENCY);

        // ...and the unit terminates under its ORDINARY window, to the last authenticated state, BEFORE
        // the payer's own deadline.
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.warp(appealDue);
        assertLt(block.timestamp, reclaimAt, "resolved strictly before the signed reclaim deadline");
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "the accepted SETTLE stands");
        assertEq(usdc.balanceOf(payer), payerBefore + (bondOf(G) - VNextSettlementLib.delayCompensation(G, bondOf(G))), "only the unused bond came back");
        _assertBucketsCovered(e);
    }

    /// @dev M-03(b) — `invokeBackup` must not erase an emergency refund that is ALREADY DUE. Escalating
    ///      sets `backupLane`, which closes the emergency; past the deadline that would reopen settlement
    ///      on a unit whose refund the C-5 clock had already awarded, leaving "full-G refund vs backup
    ///      settlement" decided by transaction ordering PAST a deadline the machine calls terminal.
    function test_M03_InvokeBackupCannotEraseADueEmergencyRefund() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _commit(e, id, PKG);
        // Both escrows are funded BEFORE the disable — `fund()` refuses a dead cohort, so a post-disable
        // fixture would not be a reachable state.
        VNextSettlementEscrow eControl = _fundedEscrow(keccak256("m03b-ctl"), _oneUnitConfig(G, F, BPS, 1));
        bytes32 idControl = _unitId(eControl);
        _commit(eControl, idControl, PKG);

        uint256 emergencyDue = block.timestamp + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;
        attester.disableAtNow();

        // Control: while the emergency is still OPEN, escalation is the operator's designed recourse.
        vm.warp(emergencyDue - 1);
        vm.prank(operator);
        eControl.invokeBackup(idControl);
        assertEq(uint256(eControl.unitState(idControl)), uint256(UnitState.BACKUP_PENDING), "still open: allowed");

        // One second later the refund is due, and escalation can no longer reach back over it.
        vm.warp(emergencyDue);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.invokeBackup(id);

        uint256 payerBefore = usdc.balanceOf(payer);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED), "the due refund is terminal");
        assertEq(usdc.balanceOf(payer), payerBefore + G);
    }

    function bondOf(uint256 g) internal pure returns (uint256) {
        return VNextSettlementLib.challengeBond(g);
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

    // ══ D-4 SIBLING — the last unclamped sentinel (sol re-review of 94ee6d5b) ══════════════════════

    /// @dev [FAILS PRE-FIX] `_emergencyDeadline` reads `assertedAt` as a SENTINEL (`if (a != 0)`) meaning
    ///      "an assertion has been accepted", and only on that branch applies §8.3 C-5 exclusion (2): no
    ///      emergency may open on a unit whose release was ALREADY DUE. A raw `assertedAt = 0` overloads
    ///      that sentinel -- at genesis "accepted at t=0" is indistinguishable from "nothing accepted" --
    ///      so the exclusion is SILENTLY SKIPPED.
    ///
    ///      Not introduced by ATT-01; a pre-existing sibling of the `disabledAt` and `challengedAt` clamps,
    ///      and the lone exception the `challengedAt` clamp comment warns about. Fixed while the
    ///      implementation address is ALREADY MOVING for this batch, because after first deploy the same
    ///      one-line change costs a migration.
    function test_D4Sibling_AssertedAtIsClampedNonZeroAtGenesis() public {
        vm.warp(0);
        assertEq(block.timestamp, 0, "we really are at genesis");

        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);

        (, uint64 assertedAt_,,,,,) = e.settlement(id);

        // THE SENTINEL PROPERTY: an accepted assertion must never read as "nothing accepted".
        assertTrue(assertedAt_ != 0, "assertedAt must never be the zero sentinel once an assertion exists");
        assertEq(uint256(assertedAt_), 1, "clamped to 1, exactly as disabledAt and challengedAt are");
    }

    // ══ O25 — rawChallengedAtOf, the TIMELESS anchor for the attester's storage gate ═══════════════

    /// @dev The property oracle's O25 predicate depends on, and it is a NEGATIVE one: this getter must
    ///      NOT revert when the PRIMARY attester is unreadable. `challengedAtOf` routes through
    ///      `_appealWindow` -> `_emergencyDeadline` -> a STATICCALL to the primary; this one is a plain
    ///      storage read and must be immune to that entirely.
    ///
    ///      Why a storage gate must never depend on a foreign call (the D-1 lesson as an API contract):
    ///      if `adjudicate()` refuses to STORE a record because some other contract is momentarily
    ///      unreadable, an attacker holds that contract unreadable across the window and a VALID OVERTURN
    ///      becomes permanently unrecordable — release where a refund was owed.
    function test_O25_RawChallengedAtOf_IsTimeless_AndSurvivesAnUnreadablePrimary() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();

        // No challenge yet: an unambiguous zero. `challengedAt` is clamped non-zero on write, so 0 can
        // only ever mean "no challenge", never a genesis timestamp.
        assertEq(e.rawChallengedAtOf(id), 0, "no challenge => 0, unambiguously");

        _acceptNow(e, id);
        _challenge(e, id);
        uint256 challengedAt = block.timestamp;
        assertEq(e.rawChallengedAtOf(id), challengedAt, "returns the raw stored anchor");

        // THE LOAD-BEARING CASE. Make the primary attester unreadable and confirm this getter is
        // UNAFFECTED — no revert, same value. A storage gate built on it therefore cannot be starved.
        vm.mockCallRevert(address(attester), abi.encodeWithSignature("disabledAt()"), bytes(""));
        assertEq(
            e.rawChallengedAtOf(id),
            challengedAt,
            "an unreadable primary must not affect a plain storage read"
        );
        vm.clearMockedCalls();

        // And it is genuinely TIMELESS: warping far past the appeal window does not change it. The
        // window is the CALLER's arithmetic (anchor + APPEAL_WINDOW), never baked into the anchor.
        vm.warp(challengedAt + VNextSettlementLib.APPEAL_WINDOW * 10);
        assertEq(e.rawChallengedAtOf(id), challengedAt, "timeless: the anchor does not decay");
    }

    // ══ D-1 FAIL-OPEN — sol re-review of 94ee6d5b ═══════════════════════════════════════════════════

    /// @dev [FAILS PRE-FIX] THE TEST FOR A BUG I INTRODUCED MYSELF. The first cut of D-1 had
    ///      `challengedAtOf` call `_emergencyDeadline`, which STATICCALLs the PRIMARY attester. I noticed
    ///      the getter could now revert and ACCEPTED it, reasoning that "an unreadable primary already
    ///      fails `finalize` and `resolveEscalation`, so a getter that fails with them is consistent".
    ///      THAT MISSED THE ASYMMETRY: those reverts are TEMPORARY; A MISSED APPEAL WINDOW IS PERMANENT.
    ///
    ///      The attack it opened: a quorum submits a VALID in-window OVERTURN; the primary is made
    ///      transiently unreadable (proxy swap, revert, malformed return); `O5AttesterBase.adjudicate`
    ///      reads this getter (:517), gets a revert, reports `EscrowBindingUnreadable` and STORES
    ///      NOTHING; the outage is held past `due` and the primary restored reading `disabledAt == 0`;
    ///      every later adjudication is stamped LATE and rejected, so `finalize` sees silence and
    ///      RELEASES — where a timely OVERTURN should have REFUNDED. Money to the wrong party.
    ///
    ///      Failing OPEN is correct HERE AND ONLY HERE: this getter decides only whether a record may be
    ///      WRITTEN, and the escrow still applies its own authoritative `[from, due)` check at
    ///      resolution via `_decidedIn` — so a record admitted under a stale-open window is still
    ///      rejected on time. The worst residual is the D-2 slot burn, which is financially inert.
    function test_D1_UnreadablePrimary_MustNotMakeATimelyAppealUnrecordable() public {
        (VNextSettlementEscrow e, bytes32 id) = _live();
        _acceptNow(e, id);
        _challenge(e, id);
        uint256 challengedAt = block.timestamp;

        // Baseline: with the primary readable, the getter reports the live appeal anchor.
        assertEq(e.challengedAtOf(id), challengedAt, "readable primary reports the live appeal anchor");

        // The primary becomes unreadable MID-WINDOW.
        vm.mockCallRevert(address(attester), abi.encodeWithSignature("disabledAt()"), bytes(""));

        // PRE-FIX THIS LINE REVERTS. The appeal window is a fact about THIS escrow's own storage; it
        // does not depend on the primary being readable, and must not become unreadable with it.
        assertEq(
            e.challengedAtOf(id), challengedAt, "an unreadable primary must not brick the appeal anchor"
        );

        // The consequence that actually matters: the verdict stays RECORDABLE during the outage.
        // `_adjudicateAt` reads the anchor at exactly the point production's `adjudicate` reads it.
        _adjudicateAt(e, id, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN, block.timestamp);

        // The attacker's second step: restore the primary, now reading as never-disabled.
        vm.clearMockedCalls();

        // The OVERTURN the quorum actually reached is honoured — the PAYER is refunded. Pre-fix the
        // record never existed, `finalize` would have seen silence, and the operator would have been paid.
        e.resolveEscalation(id, O5_ADJ_ROLE_APPEAL);
        assertEq(
            uint256(e.unitState(id)),
            uint256(UnitState.SETTLED_REFUNDED),
            "the timely OVERTURN decides, and it refunds"
        );
        _assertBucketsCovered(e);
    }
}
