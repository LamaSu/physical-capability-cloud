// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VNextSettlementEscrowTest, MockToken} from "./VNextSettlementEscrow.t.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {O5AttesterBase} from "../src/attesters/O5AttesterBase.sol";
import {
    O5Verdict,
    O5Assertion,
    O5AdjudicationRecord,
    O5_DECISION_SETTLE,
    O5_ADJ_ROLE_APPEAL,
    O5_ADJ_ROLE_EMERGENCY,
    O5_ADJ_UPHOLD,
    O5_ADJ_OVERTURN
} from "../src/O5Types.sol";
import {
    PayoutEntry,
    UnitState,
    ClaimClass,
    AuthorizationType,
    VNextSettlementLib
} from "../src/libraries/VNextSettlementLib.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {VNextReadLens} from "./helpers/VNextReadLens.sol";

using VNextReadLens for VNextSettlementEscrow;

/**
 * @title VNextParentReleaseRoutesTest
 * @notice CHARACTERIZATION tests for "every route by which a PARENT settlement unit P becomes releasable or
 *         paid", a question from a nested-settlement review. Each test asserts what the escrow DOES today (written against
 *         lamasu/master 75fd440b, whose V-next contract sources are unchanged since 8b72eab8); a bypass is a
 *         passing test that documents the bypass. If a contract change makes one of these fail, the route
 *         audit has to be redone, which is the point.
 *
 * @dev    The nested deal is modelled as three units of ONE escrow: a parent P and two children C1, C2
 *         (same payer, same operator, same job, independent unit ids, independent `reclaimAt`s). The escrow
 *         has no notion of "child of": that is exactly what is being characterized.
 *
 *         ROUTES TO RELEASE ALLOCATION (`_allocateRelease`, VNextSettlementEscrow.sol:1451) and what each needs:
 *           R1 finalize, PRIMARY_ASSERTED, after challenge window ... accepted PRIMARY-cohort SETTLE for P
 *           R2 finalize, BACKUP_ASSERTED,  after challenge window ... accepted ESCALATION-cohort SETTLE for P
 *                (reached only after the operator's one-way `invokeBackup`; the primary oracle asserts nothing)
 *           R3 finalize, CHALLENGED, after appeal window (silence) .. accepted SETTLE for P (either lane)
 *           R4 resolveEscalation(APPEAL) upheld ..................... accepted SETTLE for P + escalation record
 *           R5 resolveEscalation(EMERGENCY) upheld .................. accepted SETTLE for P + escalation record
 *           R6 approveByBuyer ....................................... NO oracle assertion; Tier-0 units only,
 *                payer authority (direct call, or the payer's EIP-712 / ERC-1271 signature relayed by anyone)
 *         Nothing on any of these paths reads another unit. The only cross-unit read is the aggregate
 *         solvency gate `_requireSolvent` (:1368), which compares the escrow balance with the SUM of all
 *         units' liabilities.
 *
 *         ROUTES TO REFUND ALLOCATION (`_allocateRefund`, :1480), which matter because a SIBLING can take them
 *         between P's acceptance and finalize(P) (the N22 timing fact): reclaimAfterDeadline (FUNDED_ACTIVE at
 *         `reclaimAt`), finalize from BACKUP_PENDING at the assertion cutoff, finalize under an open emergency
 *         (silence), resolveEscalation OVERTURN (appeal or emergency). A unit whose release was allocated can take none.
 *
 *         Everything is exercised against `MockOracleAttester` (the escrow's money path only STATICCALLs the
 *         attester, so the mock is faithful to what the escrow reads) except the signature-binding tests,
 *         which use the REAL `Fixed2of3O5Attester`.
 */
contract VNextParentReleaseRoutesTest is VNextSettlementEscrowTest {
    // ── the nested deal ──────────────────────────────────────────────────────────────────────────────
    bytes32 constant DEAL_JOB = keccak256("nested-deal-job");
    bytes32 constant STEP_P = keccak256("step-parent");
    bytes32 constant STEP_C1 = keccak256("step-child-1");
    bytes32 constant STEP_C2 = keccak256("step-child-2");
    /// @dev P's funding-frozen `compositionRoot`: stands for the digest of the accepted deal graph.
    bytes32 constant DEAL_ROOT = keccak256("accepted-deal-graph-root");
    address constant CHILD1_RECIP = address(0xC1C1);
    address constant CHILD2_RECIP = address(0xC2C2);
    address constant STRANGER = address(0xD00D);
    /// @dev A realistic funding time. Foundry starts at timestamp 1, which is the genesis edge the escrow
    ///      clamps for; none of these tests is about that edge.
    uint256 constant T0 = 1_800_000_000;

    uint256 constant GP = 1000e6; // P gross
    uint256 constant FP = 23_500000; // P fee (235 bps)
    uint16 constant BPSP = 235;
    uint256 constant GC1 = 300e6; // C1 gross, no fee
    uint256 constant GC2 = 200e6; // C2 gross, no fee

    uint256 constant CW = VNextSettlementLib.CHALLENGE_WINDOW;
    uint256 constant AW = VNextSettlementLib.APPEAL_WINDOW;
    uint256 constant BW = VNextSettlementLib.BACKUP_WINDOW;
    uint256 constant EW = VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;

    struct DealShape {
        uint8 tierP;
        uint8 tierC1;
        uint256 pDelay; // reclaimAt - T0
        uint256 c1Delay;
        uint256 c2Delay;
    }

    struct Deal {
        VNextSettlementEscrow e;
        bytes32 job;
        bytes32 p;
        bytes32 c1;
        bytes32 c2;
    }

    function _shape() internal pure returns (DealShape memory s) {
        s = DealShape({tierP: 1, tierC1: 1, pDelay: 60 days, c1Delay: 45 days, c2Delay: 30 days});
    }

    function _childCfg(uint256 milestone, bytes32 step, uint8 tier, uint256 g, address recipient, uint256 delay)
        internal
        pure
        returns (VNextSettlementEscrow.UnitConfig memory c)
    {
        PayoutEntry[] memory po = new PayoutEntry[](1);
        po[0] = PayoutEntry({recipient: recipient, amount: g});
        c = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: milestone,
            stepId: step,
            requiredTier: tier,
            requestedTier: tier,
            g: g,
            f: 0,
            n: g,
            feeBps: 0,
            feeRecipient: address(0),
            reclaimAt: T0 + delay,
            compositionSchemaVersion: 0,
            compositionRoot: bytes32(0),
            payouts: po
        });
    }

    function _dealCfgs(DealShape memory s) internal view returns (VNextSettlementEscrow.UnitConfig[] memory cfgs) {
        cfgs = new VNextSettlementEscrow.UnitConfig[](3);
        uint256 nP = GP - FP;
        PayoutEntry[] memory pp = new PayoutEntry[](2);
        pp[0] = PayoutEntry({recipient: recip1, amount: nP / 2});
        pp[1] = PayoutEntry({recipient: recip2, amount: nP - nP / 2});
        cfgs[0] = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: 0,
            stepId: STEP_P,
            requiredTier: s.tierP,
            requestedTier: s.tierP,
            g: GP,
            f: FP,
            n: nP,
            feeBps: BPSP,
            feeRecipient: feeDest,
            reclaimAt: T0 + s.pDelay,
            compositionSchemaVersion: 1,
            compositionRoot: DEAL_ROOT,
            payouts: pp
        });
        cfgs[1] = _childCfg(1, STEP_C1, s.tierC1, GC1, CHILD1_RECIP, s.c1Delay);
        cfgs[2] = _childCfg(2, STEP_C2, 1, GC2, CHILD2_RECIP, s.c2Delay);
    }

    function _uid(VNextSettlementEscrow e, bytes32 job, uint256 milestone, bytes32 step)
        internal
        view
        returns (bytes32)
    {
        return VNextSettlementLib.computeSettlementUnitId(block.chainid, address(e), job, milestone, step);
    }

    function _deal(DealShape memory s) internal returns (Deal memory d) {
        d = _dealFor(DEAL_JOB, s);
    }

    function _dealFor(bytes32 job, DealShape memory s) internal returns (Deal memory d) {
        vm.warp(T0);
        d.e = _fundedEscrow(job, _dealCfgs(s));
        d.job = job;
        d.p = _uid(d.e, job, 0, STEP_P);
        d.c1 = _uid(d.e, job, 1, STEP_C1);
        d.c2 = _uid(d.e, job, 2, STEP_C2);
    }

    // ── assertion helpers (mock cohorts) ─────────────────────────────────────────────────────────────

    /// @dev A SETTLE record shaped exactly as the escrow's `acceptAssertion` demands, read off the escrow's own
    ///      getters (the way the off-chain oracle does). Reverts `EvidenceNotCommitted` until the operator commits.
    function _record(VNextSettlementEscrow e, bytes32 id, uint64 cohort, bytes32 assertionId)
        internal
        view
        returns (O5Assertion memory a)
    {
        a = O5Assertion({
            assertionId: assertionId,
            feeScheduleHash: e.feeScheduleHashOf(id),
            compositionRoot: e.compositionRootOf(id),
            evidenceBundleHash: e.evidenceBundleHashOf(id),
            escrow: address(e),
            assertedAt: uint64(block.timestamp),
            achievedTier: e.requiredTierOf(id),
            requestedTier: e.requiredTierOf(id),
            decision: O5_DECISION_SETTLE,
            feeRecipient: e.feeRecipientOf(id),
            oracleAuthEpoch: cohort,
            feeBps: e.feeBpsOf(id)
        });
    }

    /// @dev The PRIMARY oracle asserts SETTLE for exactly `id` (after the operator committed its evidence).
    function _mintPrimary(Deal memory d, bytes32 id) internal {
        _commit(d.e, id, PKG);
        attester.setAssertion(id, _record(d.e, id, COHORT, keccak256(abi.encode("primary-assertion", id))));
    }

    /// @dev Mint + ACCEPT (permissionless) a primary SETTLE for `id`. Returns the escrow's acceptance time.
    function _mintAndAccept(Deal memory d, bytes32 id) internal returns (uint256 acceptedAt) {
        _mintPrimary(d, id);
        vm.prank(STRANGER);
        d.e.acceptAssertion(id);
        acceptedAt = block.timestamp;
    }

    function _assertState(VNextSettlementEscrow e, bytes32 id, UnitState want) internal view {
        assertEq(uint256(e.unitState(id)), uint256(want));
    }

    function _paidToP() internal view returns (uint256) {
        return usdc.balanceOf(recip1) + usdc.balanceOf(recip2) + usdc.balanceOf(feeDest);
    }

    function _assertPReleasedInFull(Deal memory d) internal view {
        _assertState(d.e, d.p, UnitState.SETTLED_RELEASED);
        assertEq(usdc.balanceOf(recip1) + usdc.balanceOf(recip2), GP - FP, "P's principal legs paid");
        assertEq(usdc.balanceOf(feeDest), FP, "P's fee leg paid");
    }

    // ══ (a) a third party calls finalize(P) when NO SETTLE assertion has been accepted for P ═════════

    /// @dev Route table: finalize from FUNDED_ACTIVE has no release branch (VNextSettlementEscrow.sol:1914-1916).
    function test_finalize_byStranger_withoutAnyAssertion_revertsNotActive_andPStaysFundedActive() public {
        Deal memory d = _deal(_shape());
        _assertState(d.e, d.p, UnitState.FUNDED_ACTIVE);

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.finalize(d.p);

        _assertState(d.e, d.p, UnitState.FUNDED_ACTIVE);
        assertEq(_paidToP(), 0, "nothing was paid");
        assertEq(d.e.totalLiability(), GP + GC1 + GC2, "all three units are still fully collateralized");
    }

    /// @dev The oracle's record is not an authorization by itself: the escrow must ACCEPT it first. Acceptance is
    ///      permissionless, but it only consumes a record that exists at the oracle for exactly this unit.
    function test_finalize_byStranger_whenOracleHoldsSettleForP_butNobodyAcceptedIt_revertsNotActive() public {
        Deal memory d = _deal(_shape());
        _mintPrimary(d, d.p);
        assertTrue(attester.assertionOf(d.p).assertionId != bytes32(0), "the oracle's SETTLE for P exists");

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.FUNDED_ACTIVE);

        // acceptance is the permissionless step ...
        vm.prank(STRANGER);
        d.e.acceptAssertion(d.p);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);
        // ... and it does not pay: the challenge window has just opened
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.p);
        assertEq(_paidToP(), 0);
    }

    /// @dev Accepting P reads the oracle's record KEYED BY P. Accepted assertions and releases of siblings give P nothing.
    function test_siblingAssertionsAndReleases_giveNothingToP_acceptRevertsAttestationNotFound_finalizeRevertsNotActive()
        public
    {
        Deal memory d = _deal(_shape());
        _commit(d.e, d.p, PKG); // P's evidence is committed, as it must be, but the oracle has said nothing about P
        _mintAndAccept(d, d.c1);
        _mintAndAccept(d, d.c2);

        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        d.e.acceptAssertion(d.p);

        vm.warp(block.timestamp + CW);
        d.e.finalize(d.c1); // the sibling is released with ITS OWN accepted assertion
        _assertState(d.e, d.c1, UnitState.SETTLED_RELEASED);

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.FUNDED_ACTIVE);
        assertEq(_paidToP(), 0);
    }

    /// @dev Past P's own `reclaimAt` with nothing accepted: finalize still reverts; the only move is the REFUND route.
    function test_finalize_byStranger_afterPsReclaimAt_withNoAcceptedAssertion_revertsNotActive_onlyReclaimMovesPToRefund()
        public
    {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 60 days); // P.reclaimAt

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.finalize(d.p);

        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(STRANGER);
        d.e.reclaimAfterDeadline(d.p);
        _assertState(d.e, d.p, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GP, "the payer, not the recipients, is paid");
        assertEq(_paidToP(), 0);
    }

    /// @dev finalize from BACKUP_PENDING (operator escalated, nobody asserted) can only REFUND, at the assertion cutoff.
    function test_finalize_byStranger_inBackupPending_neverReleasesP_refundsThePayerAtTheAssertionCutoff() public {
        Deal memory d = _deal(_shape());
        uint256 cutoff = T0 + 60 days - CW - AW;
        vm.warp(cutoff - BW);
        vm.prank(operator);
        d.e.invokeBackup(d.p);
        _assertState(d.e, d.p, UnitState.BACKUP_PENDING);

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.p);

        vm.warp(cutoff);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GP);
        assertEq(_paidToP(), 0);
    }

    /// @dev finalize with the primary cohort disabled and nothing accepted: after the emergency deadline it REFUNDS.
    function test_finalize_byStranger_duringEmergency_withNoAcceptedAssertion_refundsP_neverReleasesIt() public {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 1 days);
        attester.disableAtNow();
        uint256 emergencyDue = block.timestamp + EW;

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.p);

        vm.warp(emergencyDue);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.expectEmit(true, false, false, true, address(d.e));
        emit VNextSettlementEscrow.Finalized(d.p, false, 3); // 3 == emergency-silence refund
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GP);
        assertEq(_paidToP(), 0);
    }

    // ══ (b) finalize(P) after P's SETTLE was accepted and its window passed, sibling still OPEN ═══════

    /// @dev ROUTE R1. The release needs P's accepted primary assertion and nothing else. C1 and C2 stay FUNDED_ACTIVE,
    ///      the oracle never asserted anything for them, and the stranger who finalizes P needs no privilege.
    function test_finalize_byStranger_afterChallengeWindow_releasesP_whileSiblingsC1AndC2StayFundedActive() public {
        Deal memory d = _deal(_shape());
        uint256 acceptedAt = _mintAndAccept(d, d.p);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);
        assertEq(attester.assertionOf(d.c1).assertionId, bytes32(0), "no oracle record for C1");
        assertEq(attester.assertionOf(d.c2).assertionId, bytes32(0), "no oracle record for C2");
        assertFalse(d.e.evidenceCommittedOf(d.c1));
        assertFalse(d.e.evidenceCommittedOf(d.c2));

        vm.warp(acceptedAt + CW - 1);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.p);

        vm.warp(acceptedAt + CW);
        vm.expectEmit(true, false, false, true, address(d.e));
        emit VNextSettlementEscrow.Finalized(d.p, true, 0); // 0 == uncontested release
        vm.prank(STRANGER);
        d.e.finalize(d.p);

        _assertPReleasedInFull(d);
        _assertState(d.e, d.c1, UnitState.FUNDED_ACTIVE);
        _assertState(d.e, d.c2, UnitState.FUNDED_ACTIVE);
        assertEq(usdc.balanceOf(CHILD1_RECIP) + usdc.balanceOf(CHILD2_RECIP), 0, "siblings unpaid");
        assertEq(d.e.totalLiability(), GC1 + GC2, "only the siblings' collateral remains");
        assertEq(usdc.balanceOf(address(d.e)), GC1 + GC2);
    }

    /// @dev Across CHAINS at the escrow: an assertion accepted on the funding chain cannot be released under another
    ///      chain id (fork or mis-relay), because the allocator re-checks the frozen chain id (VNextSettlementEscrow.sol:1375-1379).
    ///      (Pre-existing corroboration: VNextCrossChain.t.sol test_02.)
    function test_finalize_byStranger_underAnotherChainId_revertsRuntimeDomainMismatch_andSucceedsOnTheFundingChain()
        public
    {
        Deal memory d = _deal(_shape());
        uint256 acceptedAt = _mintAndAccept(d, d.p);
        uint256 chainA = block.chainid;

        vm.warp(acceptedAt + CW);
        vm.chainId(chainA + 1);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.RuntimeDomainMismatch.selector);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);
        assertEq(_paidToP(), 0);

        vm.chainId(chainA);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
    }

    /// @dev Same fact with the REAL attester: it does not read sibling units either; only the quorum signatures and
    ///      P-keyed escrow getters decide whether P's assertion is written.
    function test_endToEnd_realAttester_assertsAndReleasesP_whileSiblingsAreOpen_andTheSameVerdictCannotBeWrittenTwice()
        public
    {
        (Fixed2of3O5Attester real, VNextSettlementEscrowFactory f) = _realStack();
        RealDeal memory r = _realEscrow(real, f, DEAL_JOB);
        _commit(r.e, r.p, PKG);
        O5Verdict memory v = _realVerdict(r, r.p, 0, STEP_P);
        bytes[] memory sigs = _ascendingSigs(real.digestOf(v));

        real.attestO5(v, address(r.e), sigs);
        // the write-once record is the replacement for a nonce: the same signed verdict cannot be written again
        vm.expectRevert(O5AttesterBase.UnitAlreadyAttested.selector);
        real.attestO5(v, address(r.e), sigs);

        vm.prank(STRANGER);
        r.e.acceptAssertion(r.p);
        vm.warp(block.timestamp + CW);
        vm.prank(STRANGER);
        r.e.finalize(r.p);

        _assertState(r.e, r.p, UnitState.SETTLED_RELEASED);
        _assertState(r.e, r.c1, UnitState.FUNDED_ACTIVE);
        _assertState(r.e, r.c2, UnitState.FUNDED_ACTIVE);
        assertFalse(real.usedUnit(r.c1), "the real attester was never asked about C1");
        assertFalse(real.usedUnit(r.c2), "the real attester was never asked about C2");
        assertEq(usdc.balanceOf(feeDest), FP);
    }

    // ══ (c) ... after sibling C2 was refunded or reclaimed (the N22 timing fact) ═════════════════════

    /// @dev C2 reaches its own `reclaimAt` and is refunded long after P's window closed; P is still unfinalized
    ///      (nobody has to call finalize, and it has no upper time bound). finalize(P) still releases P.
    function test_finalize_byStranger_releasesP_afterSiblingC2WasReclaimedAndRefundedToThePayer() public {
        Deal memory d = _deal(_shape()); // C2.reclaimAt == T0 + 30 days
        vm.warp(T0 + 1 days);
        _mintAndAccept(d, d.p);

        vm.warp(T0 + 30 days);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(STRANGER);
        d.e.reclaimAfterDeadline(d.c2);
        _assertState(d.e, d.c2, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GC2, "C2 refunded in full");
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED); // P has been waiting for a finalize call

        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
        _assertState(d.e, d.c2, UnitState.SETTLED_REFUNDED);
        _assertState(d.e, d.c1, UnitState.FUNDED_ACTIVE);
    }

    /// @dev N22 proper. C2's `reclaimAt` falls INSIDE P's open challenge window: P accepted at day 9.5, C2 reclaimable at
    ///      day 10 (the minimum delay), P finalizable at day 11.5. The sibling refunds after P's SETTLE was accepted and
    ///      before finalize(P), and finalize(P) still releases. Nothing about P is touched by the sibling's refund.
    function test_n22_siblingC2RefundsByReclaim_afterPsAssertionWasAccepted_andBeforeFinalizeP_andFinalizePStillReleases()
        public
    {
        DealShape memory s = _shape();
        s.c2Delay = 10 days; // MIN_RECLAIM_DELAY: the earliest a sibling can become reclaimable
        Deal memory d = _deal(s);

        vm.warp(T0 + 9 days + 12 hours);
        uint256 acceptedAt = _mintAndAccept(d, d.p);
        bytes32 rootBefore = d.e.compositionRootOf(d.p);

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.TooEarlyToReclaim.selector);
        d.e.reclaimAfterDeadline(d.c2);

        vm.warp(T0 + 10 days); // C2.reclaimAt, strictly inside P's window
        assertLt(block.timestamp, acceptedAt + CW, "still inside P's challenge window");
        vm.prank(STRANGER);
        d.e.reclaimAfterDeadline(d.c2);
        _assertState(d.e, d.c2, UnitState.SETTLED_REFUNDED);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);
        assertEq(d.e.compositionRootOf(d.p), rootBefore, "P's frozen commitment is untouched by the sibling's refund");

        vm.warp(acceptedAt + CW);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
        _assertState(d.e, d.c2, UnitState.SETTLED_REFUNDED);
    }

    /// @dev A sibling can also refund BEFORE its own `reclaimAt`: the operator escalates it (primary verdict overdue),
    ///      the backup cohort is silent, and anyone refunds it at its assertion cutoff (reclaimAt - 7 days).
    function test_n22_siblingC2RefundsByBackupTimeout_beforeItsReclaimAt_betweenPsAcceptanceAndFinalizeP() public {
        DealShape memory s = _shape();
        s.c2Delay = 10 days; // C2 cutoff = day 3; escalation allowed from day 1
        Deal memory d = _deal(s);

        vm.warp(T0 + 1 days);
        vm.prank(operator);
        d.e.invokeBackup(d.c2);
        _assertState(d.e, d.c2, UnitState.BACKUP_PENDING);

        vm.warp(T0 + 2 days);
        uint256 acceptedAt = _mintAndAccept(d, d.p); // P's window runs to day 4

        vm.warp(T0 + 3 days); // C2's assertion cutoff
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(STRANGER);
        d.e.finalize(d.c2);
        _assertState(d.e, d.c2, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GC2);
        assertLt(block.timestamp, d.e.reclaimAtOf(d.c2), "refunded days before C2's own reclaimAt");
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);

        vm.warp(acceptedAt + CW);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
    }

    /// @dev A fourth sibling-refund route, and an ASYMMETRIC one: if the primary cohort is disabled after P's release was
    ///      already due, P is excluded from the emergency (VNextSettlementEscrow.sol:1642) and still releases, while the
    ///      unaccepted sibling C2 is refunded by the emergency-silence default. Parent released, child refunded.
    function test_n22_siblingC2RefundsByEmergencySilence_andPStillReleases_whenThePrimaryIsDisabledAfterPsReleaseWasDue()
        public
    {
        Deal memory d = _deal(_shape()); // C2.reclaimAt = day 30
        vm.warp(T0 + 1 days);
        uint256 acceptedAt = _mintAndAccept(d, d.p);

        vm.warp(acceptedAt + CW + 1); // P's release is now due (and nobody has finalized it)
        attester.disableAtNow();
        uint256 emergencyDue = block.timestamp + EW;

        vm.warp(emergencyDue - 1);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.c2); // C2 is under the emergency: paused until the deadline

        vm.warp(emergencyDue);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(STRANGER);
        d.e.finalize(d.c2);
        _assertState(d.e, d.c2, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GC2);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED); // not touched by the emergency

        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);

        // the other unaccepted child is under the same emergency and refunds the same way: parent released, both children refunded
        vm.prank(STRANGER);
        d.e.finalize(d.c1);
        _assertState(d.e, d.c1, UnitState.SETTLED_REFUNDED);
    }

    /// @dev N22's FOURTH sibling-refund route (astra MEDIUM on #479): an appeal OVERTURN refunds sibling C1
    ///      between P's acceptance and finalize(P) — the C1 appeal-overturn trace above
    ///      (test_n37_acceptedButUnfinalizedChild_canStillBecomeARefund_viaChallengeAndAppealOverturn),
    ///      extended with P accepted FIRST and finalized AFTER. Sibling independence holds on the
    ///      appeal-overturn route too, not just reclaim / backup-timeout / emergency-silence (the three
    ///      traces above): an OVERTURN is a quorum FINDING on C1 alone and touches none of P's own state.
    function test_n22_siblingC1RefundsByAppealOverturn_afterPsAssertionWasAccepted_andBeforeFinalizeP_andFinalizePStillReleases()
        public
    {
        Deal memory d = _deal(_shape());
        uint256 acceptedAt = _mintAndAccept(d, d.p); // P accepted FIRST

        _mintAndAccept(d, d.c1);
        uint256 bond = _challenge(d.e, d.c1);
        _adjudicate(d.e, d.c1, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(STRANGER);
        d.e.resolveEscalation(d.c1, O5_ADJ_ROLE_APPEAL);
        _assertState(d.e, d.c1, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GC1 + bond, "C1 refunded in full, and the challenger's bond returned");
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED); // P untouched by the sibling's overturn-refund

        vm.warp(acceptedAt + CW);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
        _assertState(d.e, d.c1, UnitState.SETTLED_REFUNDED);
    }

    /// @dev The sibling being mid-dispute (a bonded challenge, appeal pending) does not hold P either.
    function test_finalize_byStranger_releasesP_whileSiblingC2IsChallengedAndItsAppealIsPending() public {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 1 days);
        _mintAndAccept(d, d.c2);
        uint256 bond = _challenge(d.e, d.c2);
        _assertState(d.e, d.c2, UnitState.CHALLENGED);

        uint256 acceptedAt = _mintAndAccept(d, d.p);
        vm.warp(acceptedAt + CW);
        vm.prank(STRANGER);
        d.e.finalize(d.p);

        _assertPReleasedInFull(d);
        _assertState(d.e, d.c2, UnitState.CHALLENGED);
        assertEq(d.e.bondLiability(), bond, "C2's bond is untouched by P's release");
    }

    /// @dev N22 flip side: once P is ACCEPTED, no payer reclaim can take it back to a refund, even past P.reclaimAt, and
    ///      finalize has no upper time bound.
    function test_reclaimAfterDeadline_afterPIsAccepted_revertsNotActive_evenPastPsReclaimAt_andFinalizePStillReleasesLater()
        public
    {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 1 days);
        _mintAndAccept(d, d.p);

        vm.warp(T0 + 61 days); // a day past P.reclaimAt
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.reclaimAfterDeadline(d.p);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.reclaimAfterDeadline(d.p);

        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
    }

    // ══ N37: which sibling states are irreversible ═══════════════════════════════════════════════════

    /// @dev A child whose release was allocated can never become a refund, whatever the clock or the cohorts do.
    function test_n37_releasedChild_cannotBecomeARefund_reclaimFinalizeAndAppealAllRevertNotActive() public {
        Deal memory d = _deal(_shape());
        uint256 acceptedAt = _mintAndAccept(d, d.c1);
        vm.warp(acceptedAt + CW);
        d.e.finalize(d.c1);
        _assertState(d.e, d.c1, UnitState.SETTLED_RELEASED);

        vm.warp(T0 + 45 days); // C1.reclaimAt
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.reclaimAfterDeadline(d.c1);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.finalize(d.c1);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.resolveEscalation(d.c1, O5_ADJ_ROLE_APPEAL);

        attester.disableAtNow(); // a later kill-switch does not reach back over an allocated release
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.finalize(d.c1);
        _assertState(d.e, d.c1, UnitState.SETTLED_RELEASED);
    }

    /// @dev RELEASE_ALLOCATED (some leg is an outstanding claim) is just as irreversible as SETTLED_RELEASED.
    function test_n37_childInReleaseAllocated_withOutstandingClaims_cannotBecomeARefund() public {
        Deal memory d = _deal(_shape());
        usdc.setTransferMode(MockToken.Mode.REVERT); // every payout push becomes a claim
        uint256 acceptedAt = _mintAndAccept(d, d.c1);
        vm.warp(acceptedAt + CW);
        d.e.finalize(d.c1);
        _assertState(d.e, d.c1, UnitState.RELEASE_ALLOCATED);

        vm.warp(T0 + 45 days);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.reclaimAfterDeadline(d.c1);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.finalize(d.c1);
        _assertState(d.e, d.c1, UnitState.RELEASE_ALLOCATED);
    }

    /// @dev The counter-case that matters for any "child is done" rule: an ACCEPTED-but-unfinalized child is NOT
    ///      terminal. A bonded challenge plus an appeal OVERTURN still turns it into a refund.
    function test_n37_acceptedButUnfinalizedChild_canStillBecomeARefund_viaChallengeAndAppealOverturn() public {
        Deal memory d = _deal(_shape());
        _mintAndAccept(d, d.c1);
        uint256 bond = _challenge(d.e, d.c1);
        _adjudicate(d.e, d.c1, O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(STRANGER);
        d.e.resolveEscalation(d.c1, O5_ADJ_ROLE_APPEAL);
        _assertState(d.e, d.c1, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GC1 + bond, "C1 refunded in full, and the challenger's bond returned");
    }

    // ══ the other release routes: R2 (backup lane), R3 (appeal silence), R4 (appeal upheld), R5 (emergency) ══

    /// @dev ROUTE R2. P is released with NO assertion from the primary oracle at all. The operator (not the oracle)
    ///      escalates once the primary verdict is overdue; the ESCALATION cohort's SETTLE for P is then what the escrow
    ///      accepts, and the same permissionless finalize releases P. Whether the escalation cohort applies any
    ///      dependency check is outside the escrow.
    function test_backupLane_operatorEscalates_escalationCohortSettleForP_releasesP_whilePrimaryOracleNeverAssertedAnything()
        public
    {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 1 days);
        _commit(d.e, d.p, PKG); // must be committed while FUNDED_ACTIVE, i.e. before escalating
        uint256 cutoff = T0 + 60 days - CW - AW;
        assertEq(attester.assertionOf(d.p).assertionId, bytes32(0), "the primary oracle withholds");

        vm.warp(cutoff - BW - 1);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.PrimaryVerdictNotDue.selector);
        d.e.invokeBackup(d.p);

        vm.warp(cutoff - BW);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        d.e.invokeBackup(d.p);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        d.e.invokeBackup(d.p);
        vm.prank(operator);
        d.e.invokeBackup(d.p);
        _assertState(d.e, d.p, UnitState.BACKUP_PENDING);

        escalation.setAssertion(d.p, _record(d.e, d.p, ESC_COHORT, keccak256("backup-assertion-for-P")));
        vm.prank(STRANGER);
        d.e.acceptAssertion(d.p);
        _assertState(d.e, d.p, UnitState.BACKUP_ASSERTED);
        (,,, bool backupLane,,,) = d.e.settlement(d.p);
        assertTrue(backupLane, "accepted on the backup lane");

        vm.warp(block.timestamp + CW);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
        _assertState(d.e, d.c1, UnitState.FUNDED_ACTIVE);
        _assertState(d.e, d.c2, UnitState.FUNDED_ACTIVE);
        assertEq(attester.assertionOf(d.p).assertionId, bytes32(0), "the primary oracle never asserted anything for P");
    }

    /// @dev The lane is chosen by the unit's state, not by the caller: after escalation a perfect PRIMARY record for P
    ///      is unreachable, and the escalation cohort (not the primary oracle) is the only source.
    function test_backupLane_primaryRecordForP_isUnreachableAfterInvokeBackup_acceptReadsOnlyTheEscalationCohort()
        public
    {
        Deal memory d = _deal(_shape());
        _mintPrimary(d, d.p); // a perfectly valid primary SETTLE for P exists
        uint256 cutoff = T0 + 60 days - CW - AW;
        vm.warp(cutoff - BW);
        vm.prank(operator);
        d.e.invokeBackup(d.p);

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        d.e.acceptAssertion(d.p);
        _assertState(d.e, d.p, UnitState.BACKUP_PENDING);
    }

    function _escAscendingSigs(bytes32 digest) internal pure returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        (uint256 lo, uint256 hi) = vm.addr(esk1) < vm.addr(esk2) ? (esk1, esk2) : (esk2, esk1);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(lo, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(hi, digest);
        sigs[0] = abi.encodePacked(r0, s0, v0);
        sigs[1] = abi.encodePacked(r1, s1, v1);
    }

    /// @dev ROUTE R2 with BOTH cohorts REAL (disjoint signer sets): P is released on the signatures of the ESCALATION
    ///      quorum alone. No signature of the primary oracle's quorum is involved, and its attester holds no record for P.
    function test_endToEnd_realEscalationAttester_quorumSettleForP_releasesP_withoutAnyPrimaryOracleSignature()
        public
    {
        Fixed2of3O5Attester primary = new Fixed2of3O5Attester(
            vm.addr(sk1), vm.addr(sk2), vm.addr(sk3), DEAD_EAS, O5_SCHEMA, REAL_COHORT, address(0xDEC0DE)
        );
        Fixed2of3O5Attester esc = new Fixed2of3O5Attester(
            vm.addr(esk1), vm.addr(esk2), vm.addr(esk3), DEAD_EAS, O5_SCHEMA, ESC_REAL_COHORT, address(0xDEC0DF)
        );
        VNextSettlementEscrowFactory f = new VNextSettlementEscrowFactory(
            address(usdc), address(primary), address(esc), O5_SCHEMA, primary.o5TypeHash()
        );
        RealDeal memory r = _realEscrow(primary, f, DEAL_JOB);
        _commit(r.e, r.p, PKG);

        vm.warp(T0 + 60 days - CW - AW - BW); // the primary verdict is overdue
        vm.prank(operator);
        r.e.invokeBackup(r.p);

        O5Verdict memory v = _realVerdict(r, r.p, 0, STEP_P);
        v.oracleAuthEpoch = ESC_REAL_COHORT; // the escalation cohort's own pinned epoch
        esc.attestO5(v, address(r.e), _escAscendingSigs(esc.digestOf(v)));
        assertTrue(esc.usedUnit(r.p));
        assertFalse(primary.usedUnit(r.p), "the primary oracle's quorum signed nothing for P");

        vm.prank(STRANGER);
        r.e.acceptAssertion(r.p);
        vm.warp(block.timestamp + CW);
        vm.prank(STRANGER);
        r.e.finalize(r.p);
        _assertState(r.e, r.p, UnitState.SETTLED_RELEASED);
        assertEq(usdc.balanceOf(feeDest), FP);
        assertFalse(primary.usedUnit(r.p), "and still nothing from the primary oracle");
        _assertState(r.e, r.c1, UnitState.FUNDED_ACTIVE);
        _assertState(r.e, r.c2, UnitState.FUNDED_ACTIVE);
    }

    /// @dev The second trigger for the same operator-only edge: a disabled primary cohort opens the backup lane at once.
    function test_invokeBackup_byOperator_succeedsAtOnce_whenThePrimaryCohortIsDisabled() public {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 1 days);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.PrimaryVerdictNotDue.selector);
        d.e.invokeBackup(d.p);

        attester.disableAtNow();
        vm.prank(operator);
        d.e.invokeBackup(d.p);
        _assertState(d.e, d.p, UnitState.BACKUP_PENDING);
    }

    /// @dev ROUTE R3. A payer challenge does not turn P into a refund by silence: appeal silence RELEASES.
    ///      astra MEDIUM on #479: the bond's two legs must land on the right addresses, not merely empty
    ///      their buckets. For P, bond = 50 USDC (5% of GP's 1000 USDC) and compensation = 10 USDC (1% of
    ///      GP, capped by the bond): silence (§8.3 C-1, unadjudicated) pays the operator its capped
    ///      compensation and returns the REST — 40 USDC — to the challenger, who IS the payer here
    ///      (`challenge` is payer-only, so `u.challenger == payer`).
    function test_finalize_byStranger_afterAppealWindow_releasesP_onAppealSilence_afterThePayersChallenge() public {
        Deal memory d = _deal(_shape());
        _mintAndAccept(d, d.p);
        uint256 bond = _challenge(d.e, d.p);
        assertEq(bond, 50e6, "5% of GP's 1000 USDC");
        _assertState(d.e, d.p, UnitState.CHALLENGED);
        uint256 challengedAt = block.timestamp;

        vm.warp(challengedAt + AW - 1);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.p);

        uint256 operatorBefore = usdc.balanceOf(operator);
        uint256 payerBefore = usdc.balanceOf(payer); // the challenger: it posted the bond via `challenge`
        vm.warp(challengedAt + AW);
        vm.expectEmit(true, false, false, true, address(d.e));
        emit VNextSettlementEscrow.Finalized(d.p, true, 1); // 1 == appeal-silence release
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
        assertEq(d.e.bondLiability() + d.e.compLiability() + d.e.burnLiability(), 0, "every bond bucket paid out");
        assertEq(usdc.balanceOf(operator), operatorBefore + 10e6, "operator's capped delay compensation (1% of GP)");
        assertEq(usdc.balanceOf(payer), payerBefore + 40e6, "the REST of the bond returned to the challenger (payer), never to the sink");
        _assertState(d.e, d.c1, UnitState.FUNDED_ACTIVE);
    }

    /// @dev ROUTE R4. An appeal UPHOLD releases P, but only over the EXACT accepted assertion, and only for a unit that
    ///      has an accepted assertion at all (it is a CHALLENGED-state action).
    ///      astra MEDIUM on #479: an adjudicated LOSS (§2.4) is the one branch that BURNS the bond's rest,
    ///      never returning it to any counterparty. Operator compensation is the SAME capped 10 USDC either
    ///      way (R3's silence and this UPHOLD); only the destination of the remaining 40 USDC differs — the
    ///      sink here, the challenger on silence.
    function test_resolveEscalation_appealUphold_byStranger_releasesP_onlyForTheExactAcceptedAssertion() public {
        Deal memory d = _deal(_shape());
        _mintAndAccept(d, d.p);
        uint256 bond = _challenge(d.e, d.p);
        assertEq(bond, 50e6, "5% of GP's 1000 USDC");

        // a record that reviews some OTHER assertion cannot release P
        escalation.setAdjudication(
            d.p,
            O5_ADJ_ROLE_APPEAL,
            address(d.e),
            uint64(d.e.challengedAtOf(d.p)),
            O5AdjudicationRecord({
                adjudicationId: keccak256("adj-for-another-assertion"),
                reviewedAssertionId: keccak256("some-other-assertion"),
                escrow: address(d.e),
                decidedAt: uint64(block.timestamp),
                role: O5_ADJ_ROLE_APPEAL,
                outcome: O5_ADJ_UPHOLD
            })
        );
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.IdentityMismatch.selector);
        d.e.resolveEscalation(d.p, O5_ADJ_ROLE_APPEAL);
        _assertState(d.e, d.p, UnitState.CHALLENGED);

        // an appeal verdict cannot release a sibling that has no accepted assertion either
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.resolveEscalation(d.c1, O5_ADJ_ROLE_APPEAL);

        // the record over the exact accepted assertion releases
        _adjudicate(d.e, d.p, O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        uint256 operatorBefore = usdc.balanceOf(operator);
        uint256 sinkBefore = usdc.balanceOf(VNextSettlementLib.BURN_SINK);
        vm.prank(STRANGER);
        d.e.resolveEscalation(d.p, O5_ADJ_ROLE_APPEAL);
        _assertPReleasedInFull(d);
        _assertState(d.e, d.c1, UnitState.FUNDED_ACTIVE);
        assertEq(usdc.balanceOf(operator), operatorBefore + 10e6, "operator's capped delay compensation (1% of GP)");
        assertEq(usdc.balanceOf(VNextSettlementLib.BURN_SINK), sinkBefore + 40e6, "the REST of the bond burned to the sink, never to a counterparty");
    }

    /// @dev ROUTE R5. The emergency cohort's UPHOLD releases an ACCEPTED P, and is useless for a unit with no accepted
    ///      assertion (state check before the record is even read).
    function test_resolveEscalation_emergencyUphold_releasesAcceptedP_butCannotReleaseAnUnacceptedUnit() public {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 1 days);
        _mintAndAccept(d, d.p);
        vm.warp(T0 + 2 days); // inside P's challenge window
        attester.disableAtNow();

        _adjudicate(d.e, d.c1, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD); // a perfectly shaped record for a FUNDED_ACTIVE unit
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        d.e.resolveEscalation(d.c1, O5_ADJ_ROLE_EMERGENCY);
        _assertState(d.e, d.c1, UnitState.FUNDED_ACTIVE);

        _adjudicate(d.e, d.p, O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);
        vm.prank(STRANGER);
        d.e.resolveEscalation(d.p, O5_ADJ_ROLE_EMERGENCY);
        _assertPReleasedInFull(d);
    }

    // ══ ROUTE R6: approveByBuyer, the one release route with no oracle assertion ═══════════════════════

    function _approvalFor(VNextSettlementEscrow e, bytes32 id, uint256 nonce, uint256 expiry)
        internal
        view
        returns (VNextSettlementEscrow.BuyerApproval memory a)
    {
        (uint256 g, uint256 f, uint256 n) = e.feeAmountsOf(id);
        a = VNextSettlementEscrow.BuyerApproval({
            chainId: block.chainid,
            escrow: address(e),
            contractVersion: e.CONTRACT_VERSION(),
            settlementUnitId: id,
            payer: payer,
            jobIdHash: e.jobIdHash(),
            termsHash: TERMS,
            g: g,
            f: f,
            n: n,
            feeScheduleHash: e.feeScheduleHashOf(id),
            payoutConfigHash: e.payoutConfigHashOf(id),
            decision: uint8(AuthorizationType.BUYER_APPROVAL),
            approvalNonce: nonce,
            expiry: expiry
        });
    }

    function _approvalSig(VNextSettlementEscrow e, VNextSettlementEscrow.BuyerApproval memory a, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        return _sign(pk, keccak256(abi.encodePacked("\x19\x01", _domainSep(address(e)), _buyerStructHash(a))));
    }

    function _tier0P() internal pure returns (DealShape memory s) {
        s = _shape();
        s.tierP = 0;
    }

    /// @dev R6, the payer calls directly. Neither cohort holds any record for P, siblings are untouched.
    function test_approveByBuyer_allocatesRelease_withoutOracleAssertion_whenThePayerCallsForATier0P() public {
        Deal memory d = _deal(_tier0P());
        assertEq(attester.assertionOf(d.p).assertionId, bytes32(0));
        assertEq(escalation.assertionOf(d.p).assertionId, bytes32(0));
        VNextSettlementEscrow.BuyerApproval memory a = _approvalFor(d.e, d.p, 0, block.timestamp + 1 hours);

        vm.expectEmit(true, false, false, true, address(d.e));
        emit VNextSettlementEscrow.BuyerApproved(d.p, 0);
        vm.prank(payer);
        d.e.approveByBuyer(d.p, a, "");

        _assertPReleasedInFull(d);
        _assertState(d.e, d.c1, UnitState.FUNDED_ACTIVE);
        _assertState(d.e, d.c2, UnitState.FUNDED_ACTIVE);
        assertEq(attester.assertionOf(d.p).assertionId, bytes32(0), "no oracle record was ever involved");
    }

    /// @dev R6, anyone may relay the payer's signature; the relayer gains no authority.
    function test_approveByBuyer_relayedByStranger_withThePayersSignature_allocatesRelease_withoutOracleAssertion()
        public
    {
        Deal memory d = _deal(_tier0P());
        VNextSettlementEscrow.BuyerApproval memory a = _approvalFor(d.e, d.p, 0, block.timestamp + 1 hours);
        bytes memory sig = _approvalSig(d.e, a, payerPk);

        vm.prank(STRANGER);
        d.e.approveByBuyer(d.p, a, sig);
        _assertPReleasedInFull(d);
    }

    /// @dev The route needs the PAYER: no signature, or anyone else's, is `BadSignature` and consumes nothing.
    function test_approveByBuyer_byStrangerWithoutThePayersSignature_revertsBadSignature_andPStaysFundedActive()
        public
    {
        Deal memory d = _deal(_tier0P());
        VNextSettlementEscrow.BuyerApproval memory a = _approvalFor(d.e, d.p, 0, block.timestamp + 1 hours);

        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.BadSignature.selector);
        d.e.approveByBuyer(d.p, a, "");

        bytes memory operatorSig = _approvalSig(d.e, a, operatorPk); // the operator's key is not the payer's
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.BadSignature.selector);
        d.e.approveByBuyer(d.p, a, operatorSig);

        // the operator calling directly is not the payer either
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.BadSignature.selector);
        d.e.approveByBuyer(d.p, a, "");
        _assertState(d.e, d.p, UnitState.FUNDED_ACTIVE);
        assertEq(_paidToP(), 0);
    }

    /// @dev The route does not exist for evidence-tier units, and a Tier-0 unit has no oracle route either.
    function test_approveByBuyer_onTier1P_revertsNotTier0_andTier0PCannotBeAcceptedFromAnyOracleRecord() public {
        Deal memory d1 = _deal(_shape()); // P is Tier-1
        VNextSettlementEscrow.BuyerApproval memory a1 = _approvalFor(d1.e, d1.p, 0, block.timestamp + 1 hours);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.NotTier0.selector);
        d1.e.approveByBuyer(d1.p, a1, "");

        Deal memory d0 = _dealFor(keccak256("tier0-parent-job"), _tier0P());
        _commit(d0.e, d0.p, PKG);
        attester.setAssertion(d0.p, _record(d0.e, d0.p, COHORT, keccak256("hostile-record-for-a-tier0-unit")));
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.Tier0NotEvidence.selector);
        d0.e.acceptAssertion(d0.p);
    }

    /// @dev The payer's signature is bound to its unit: a signature for a Tier-0 sibling cannot release P.
    function test_approveByBuyer_payersSignatureForSiblingC1_cannotReleaseP() public {
        DealShape memory s = _tier0P();
        s.tierC1 = 0; // C1 is Tier-0 as well
        Deal memory d = _deal(s);
        VNextSettlementEscrow.BuyerApproval memory aC1 = _approvalFor(d.e, d.c1, 0, block.timestamp + 1 hours);
        bytes memory sigC1 = _approvalSig(d.e, aC1, payerPk);

        // (1) C1's approval struct aimed at P: the binding checks refuse it (unit id, amounts and both hashes differ)
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.ApprovalBindingMismatch.selector);
        d.e.approveByBuyer(d.p, aC1, sigC1);

        // (2) the struct rewritten for P, C1's signature kept: the signature no longer matches the digest
        VNextSettlementEscrow.BuyerApproval memory aP = _approvalFor(d.e, d.p, 0, block.timestamp + 1 hours);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.BadSignature.selector);
        d.e.approveByBuyer(d.p, aP, sigC1);
        _assertState(d.e, d.p, UnitState.FUNDED_ACTIVE);

        // control: the payer's own signature over P's approval does release P
        vm.prank(STRANGER);
        d.e.approveByBuyer(d.p, aP, _approvalSig(d.e, aP, payerPk));
        _assertPReleasedInFull(d);
    }

    /// @dev The payer's approval cannot cross escrows or chains.
    function test_approveByBuyer_payersSignatureCannotBeReplayedAtAnotherEscrowOrOnAnotherChain() public {
        Deal memory d1 = _deal(_tier0P());
        Deal memory d2 = _dealFor(keccak256("a-second-nested-deal"), _tier0P());
        VNextSettlementEscrow.BuyerApproval memory a1 = _approvalFor(d1.e, d1.p, 0, block.timestamp + 1 hours);
        bytes memory sig1 = _approvalSig(d1.e, a1, payerPk);

        // E1's approval at E2, E1's unit id: that unit does not exist at E2
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.UnitNotFound.selector);
        d2.e.approveByBuyer(d1.p, a1, sig1);
        // E1's approval at E2, E2's unit id: the struct names E1
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.ApprovalBindingMismatch.selector);
        d2.e.approveByBuyer(d2.p, a1, sig1);
        // the struct rewritten for E2, E1's signature kept: the EIP-712 domain names E1
        VNextSettlementEscrow.BuyerApproval memory a2 = _approvalFor(d2.e, d2.p, 0, block.timestamp + 1 hours);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.BadSignature.selector);
        d2.e.approveByBuyer(d2.p, a2, sig1);

        // on another chain the struct's chainId no longer matches
        uint256 chainA = block.chainid;
        vm.chainId(chainA + 1);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.ApprovalBindingMismatch.selector);
        d1.e.approveByBuyer(d1.p, a1, sig1);
        vm.chainId(chainA);

        _assertState(d1.e, d1.p, UnitState.FUNDED_ACTIVE);
        _assertState(d2.e, d2.p, UnitState.FUNDED_ACTIVE);
    }

    /// @dev R6 is time-boxed by P's own `reclaimAt`.
    function test_approveByBuyer_atOrAfterPsReclaimAt_revertsTooLateForEvidence() public {
        Deal memory d = _deal(_tier0P());
        VNextSettlementEscrow.BuyerApproval memory a = _approvalFor(d.e, d.p, 0, T0 + 61 days);
        vm.warp(T0 + 60 days);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.TooLateForEvidence.selector);
        d.e.approveByBuyer(d.p, a, "");
    }

    // ══ assertion binding and replay: the REAL attester's signature scheme ═══════════════════════════

    struct RealDeal {
        Fixed2of3O5Attester real;
        VNextSettlementEscrowFactory f;
        VNextSettlementEscrow e;
        bytes32 job;
        bytes32 p;
        bytes32 c1;
        bytes32 c2;
    }

    function _realStack() internal returns (Fixed2of3O5Attester real, VNextSettlementEscrowFactory f) {
        real = new Fixed2of3O5Attester(
            vm.addr(sk1), vm.addr(sk2), vm.addr(sk3), DEAD_EAS, O5_SCHEMA, REAL_COHORT, address(0xDEC0DE)
        );
        f = new VNextSettlementEscrowFactory(
            address(usdc), address(real), address(escalation), O5_SCHEMA, real.o5TypeHash()
        );
    }

    function _realEscrow(Fixed2of3O5Attester real, VNextSettlementEscrowFactory f, bytes32 job)
        internal
        returns (RealDeal memory r)
    {
        vm.warp(T0);
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _dealCfgs(_shape());
        r.real = real;
        r.f = f;
        r.job = job;
        r.e = VNextSettlementEscrow(f.createEscrow(_identity(job, 1, cfgs)));
        _fund(r.e, cfgs);
        r.p = _uid(r.e, job, 0, STEP_P);
        r.c1 = _uid(r.e, job, 1, STEP_C1);
        r.c2 = _uid(r.e, job, 2, STEP_C2);
    }

    function _realVerdict(RealDeal memory r, bytes32 id, uint256 milestone, bytes32 step)
        internal
        view
        returns (O5Verdict memory v)
    {
        v = O5Verdict({
            jobIdHash: r.job,
            milestoneIndex: milestone,
            stepId: step,
            evidenceBundleHash: r.e.evidenceBundleHashOf(id),
            achievedTier: r.e.requiredTierOf(id),
            requestedTier: r.e.requiredTierOf(id),
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256(abi.encode("verdict", id)),
            feeBps: r.e.feeBpsOf(id),
            feeRecipient: r.e.feeRecipientOf(id),
            feeScheduleHash: r.e.feeScheduleHashOf(id),
            settlementUnitId: id,
            oracleAuthEpoch: REAL_COHORT,
            compositionRoot: r.e.compositionRootOf(id)
        });
    }

    /// @dev Across UNITS. The unit id is inside the signed digest, so a quorum signature over sibling C1's verdict
    ///      cannot write P's assertion, whichever way the attacker re-points it. Nothing is then readable for P.
    function test_attestO5_quorumSignedVerdictForSiblingC1_cannotBeReusedToAssertP() public {
        (Fixed2of3O5Attester real, VNextSettlementEscrowFactory f) = _realStack();
        RealDeal memory r = _realEscrow(real, f, DEAL_JOB);
        _commit(r.e, r.p, PKG);
        _commit(r.e, r.c1, PKG);
        O5Verdict memory vC1 = _realVerdict(r, r.c1, 1, STEP_C1);
        bytes[] memory sigsC1 = _ascendingSigs(real.digestOf(vC1));

        // (1) only the unit id flipped to P: the attester recomputes the id from the other fields and refuses
        O5Verdict memory flipped = _copyVerdict(vC1);
        flipped.settlementUnitId = r.p;
        vm.expectRevert(O5AttesterBase.EscrowVerdictMismatch.selector);
        real.attestO5(flipped, address(r.e), sigsC1);

        // (2) every identity field re-pointed to P, C1's signatures attached: a verdict the quorum never signed
        O5Verdict memory repointed = _realVerdict(r, r.p, 0, STEP_P);
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        real.attestO5(repointed, address(r.e), sigsC1);
        assertTrue(real.digestOf(repointed) != real.digestOf(vC1), "the unit id is inside the signed digest");

        assertFalse(real.usedUnit(r.p), "nothing was written for P");
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        r.e.acceptAssertion(r.p);

        // control: the same signatures are valid, for C1
        real.attestO5(vC1, address(r.e), sigsC1);
        assertTrue(real.usedUnit(r.c1));
        assertFalse(real.usedUnit(r.p));
    }

    /// @dev Across ESCROWS. The escrow address is inside the unit id, so E1's verdict cannot be asserted for E2.
    function test_attestO5_quorumSignedVerdictForEscrowE1_cannotAssertTheSameUnitShapeAtEscrowE2() public {
        (Fixed2of3O5Attester real, VNextSettlementEscrowFactory f) = _realStack();
        RealDeal memory r1 = _realEscrow(real, f, DEAL_JOB);
        RealDeal memory r2 = _realEscrow(real, f, keccak256("another-nested-deal"));
        assertTrue(address(r1.e) != address(r2.e));
        assertTrue(r1.p != r2.p, "same milestone and step, different escrow: different unit id");
        _commit(r1.e, r1.p, PKG);
        _commit(r2.e, r2.p, PKG);
        O5Verdict memory v1 = _realVerdict(r1, r1.p, 0, STEP_P);
        bytes[] memory sigs1 = _ascendingSigs(real.digestOf(v1));

        // (1) E1's verdict, E2 named as the escrow: the unit id recomputed for E2 is not the signed one
        vm.expectRevert(O5AttesterBase.EscrowVerdictMismatch.selector);
        real.attestO5(v1, address(r2.e), sigs1);
        // (2) the verdict re-pointed to E2's unit, E1's signatures attached
        O5Verdict memory v2 = _realVerdict(r2, r2.p, 0, STEP_P);
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        real.attestO5(v2, address(r2.e), sigs1);
        assertFalse(real.usedUnit(r2.p));

        // control
        real.attestO5(v1, address(r1.e), sigs1);
        assertTrue(real.usedUnit(r1.p));
        assertFalse(real.usedUnit(r2.p));
    }

    /// @dev Across CHAINS. The chain id is inside the unit id AND inside the EIP-712 domain, so the check fires at both
    ///      layers. (Pre-existing corroboration: VNextCrossChain.t.sol test_03, and test_02/test_04 for the escrow.)
    function test_attestO5_quorumSignedVerdictForChainA_cannotBeAssertedOnChainB() public {
        (Fixed2of3O5Attester real, VNextSettlementEscrowFactory f) = _realStack();
        RealDeal memory r = _realEscrow(real, f, DEAL_JOB);
        _commit(r.e, r.p, PKG);
        O5Verdict memory v = _realVerdict(r, r.p, 0, STEP_P);
        bytes32 digestA = real.digestOf(v);
        bytes[] memory sigsA = _ascendingSigs(digestA);
        uint256 chainA = block.chainid;

        vm.chainId(chainA + 1);
        // (1) the same verdict: the unit id the attester recomputes on chain B is different
        vm.expectRevert(O5AttesterBase.EscrowVerdictMismatch.selector);
        real.attestO5(v, address(r.e), sigsA);
        // (2) the digest the quorum signed is chain-bound
        assertTrue(real.digestOf(v) != digestA, "chainId is inside the EIP-712 domain");
        // (3) an attacker who re-derives the chain-B unit id still holds only chain-A signatures
        O5Verdict memory vB = _copyVerdict(v);
        vB.settlementUnitId = VNextSettlementLib.computeSettlementUnitId(block.chainid, address(r.e), r.job, 0, STEP_P);
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        real.attestO5(vB, address(r.e), sigsA);
        assertFalse(real.usedUnit(r.p));
        assertFalse(real.usedUnit(vB.settlementUnitId));

        vm.chainId(chainA);
        real.attestO5(v, address(r.e), sigsA); // control: on the funding chain it asserts
        assertTrue(real.usedUnit(r.p));
    }

    /// @dev Across ATTESTER deployments with the same signers: the attester's own address is inside the domain.
    function test_attestO5_quorumSignedVerdictForOneAttester_cannotBeReplayedOnATwinAttesterWithTheSameSigners()
        public
    {
        (Fixed2of3O5Attester real, VNextSettlementEscrowFactory f) = _realStack();
        RealDeal memory r = _realEscrow(real, f, DEAL_JOB);
        _commit(r.e, r.p, PKG);
        O5Verdict memory v = _realVerdict(r, r.p, 0, STEP_P);
        bytes[] memory sigs = _ascendingSigs(real.digestOf(v));

        Fixed2of3O5Attester twin = new Fixed2of3O5Attester(
            vm.addr(sk1), vm.addr(sk2), vm.addr(sk3), DEAD_EAS, O5_SCHEMA, REAL_COHORT, address(0xDEC0DF)
        );
        assertTrue(twin.digestOf(v) != real.digestOf(v), "verifyingContract is inside the domain");
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        twin.attestO5(v, address(r.e), sigs);
        assertFalse(twin.usedUnit(r.p));
    }

    /// @dev What the escrow compares P's accepted assertion against, and what it does NOT: the only P-specific
    ///      funding-time commitment an assertion must echo is `compositionRoot` (plus the evidence commitment and
    ///      fee fields). There is no nonce, no expiry, and no field that names other units.
    function test_acceptAssertion_forP_requiresTheVerdictToEchoPsFrozenCompositionRoot_anyOtherRootReverts() public {
        Deal memory d = _deal(_shape());
        _commit(d.e, d.p, PKG);
        O5Assertion memory a = _record(d.e, d.p, COHORT, keccak256("assertion-for-P"));

        a.compositionRoot = keccak256("some-other-deal-graph");
        attester.setAssertion(d.p, a);
        vm.expectRevert(VNextSettlementEscrow.CompositionRootMismatch.selector);
        d.e.acceptAssertion(d.p);

        a.compositionRoot = bytes32(0); // the children's root, not P's
        attester.setAssertion(d.p, a);
        vm.expectRevert(VNextSettlementEscrow.CompositionRootMismatch.selector);
        d.e.acceptAssertion(d.p);

        a.compositionRoot = DEAL_ROOT;
        attester.setAssertion(d.p, a);
        d.e.acceptAssertion(d.p);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);
        assertEq(d.e.compositionRootOf(d.p), DEAL_ROOT);
    }

    /// @dev No expiry: a record minted long ago (here 40 days before acceptance, i.e. before a sibling refunded) is
    ///      accepted on the escrow's clock, as long as acceptance happens before P's assertion cutoff.
    function test_acceptAssertion_forP_ignoresTheRecordsMintTime_aStaleSettleStillReleasesP_afterASiblingRefunded()
        public
    {
        Deal memory d = _deal(_shape()); // C2.reclaimAt = day 30; P cutoff = day 53
        vm.warp(T0 + 1 days);
        _mintPrimary(d, d.p);
        uint64 mintedAt = attester.assertionOf(d.p).assertedAt;

        vm.warp(T0 + 30 days);
        vm.prank(STRANGER);
        d.e.reclaimAfterDeadline(d.c2); // the sibling refunds while the oracle's SETTLE sits unaccepted
        _assertState(d.e, d.c2, UnitState.SETTLED_REFUNDED);

        vm.warp(T0 + 41 days); // 40 days after the record was minted
        vm.prank(STRANGER);
        d.e.acceptAssertion(d.p);
        (, uint64 stamped,,,,,) = d.e.settlement(d.p);
        assertEq(uint256(stamped), T0 + 41 days, "the escrow stamps its OWN clock");
        assertEq(uint256(stamped) - uint256(mintedAt), 40 days, "the record was minted 40 days before acceptance");

        vm.warp(T0 + 41 days + CW);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
    }

    // ══ authority per edge (who cannot touch P) ═══════════════════════════════════════════════════════

    /// @dev astra LOW on #479: renamed. The old name ("...soOnlyThePayerCanDelayPsRelease") overstated this
    ///      test's own finding — it shows only that `challenge` itself is payer-only. The primary cohort's
    ///      revoker can ALSO pause an eligible release, through an emergency, without ever posting a bond
    ///      (see the trace immediately below).
    function test_challenge_byStrangerOrOperator_revertsOnlyPayer_soOnlyThePayerCanInitiateABondedChallenge() public {
        Deal memory d = _deal(_shape());
        _mintAndAccept(d, d.p);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.OnlyPayer.selector);
        d.e.challenge(d.p);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.OnlyPayer.selector);
        d.e.challenge(d.p);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);
    }

    /// @dev astra LOW on #479 (optional, "cheap"): the revoker-pause trace. The payer's bonded challenge is
    ///      not the only way an eligible release can be paused — the primary cohort's revoker can do it too,
    ///      through an emergency, posting no bond at all. P is accepted; the primary is disabled while P's
    ///      ordinary challenge window is still open; at the ordinary deadline `finalize` is STILL paused
    ///      (`VNextSettlementEscrow.sol:1631` admits the emergency since the disable predates that deadline;
    ///      `:1835` is the gate `finalize` gives it priority over). It resolves only at the emergency deadline.
    function test_emergency_duringPsChallengeWindow_pausesFinalizeAtTheOrdinaryDeadline_untilTheEmergencyDeadline()
        public
    {
        Deal memory d = _deal(_shape());
        uint256 acceptedAt = _mintAndAccept(d, d.p);
        vm.warp(acceptedAt + 1); // still well inside P's challenge window
        attester.disableAtNow();
        uint256 emergencyDue = block.timestamp + EW;

        vm.warp(acceptedAt + CW); // P's ORDINARY challenge deadline
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.p); // paused: the emergency governs now, not the ordinary deadline

        vm.warp(emergencyDue - 1);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.WindowStillOpen.selector);
        d.e.finalize(d.p);

        vm.warp(emergencyDue);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.SETTLED_REFUNDED);
        assertEq(usdc.balanceOf(payer), payerBefore + GP, "the payer, not the recipients, is paid");
        assertEq(_paidToP(), 0);
    }

    function test_invokeBackup_byStrangerOrPayer_revertsOnlyOperator() public {
        Deal memory d = _deal(_shape());
        vm.warp(T0 + 60 days - CW - AW - BW);
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        d.e.invokeBackup(d.p);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        d.e.invokeBackup(d.p);
        _assertState(d.e, d.p, UnitState.FUNDED_ACTIVE);
    }

    function test_submitEvidence_byStrangerOrPayer_revertsOnlyOperator_soTheEvidenceCommitIsNotAThirdPartyLever()
        public
    {
        Deal memory d = _deal(_shape());
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        d.e.submitEvidence(d.p, PKG);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.OnlyOperator.selector);
        d.e.submitEvidence(d.p, PKG);
        assertFalse(d.e.evidenceCommittedOf(d.p));
    }

    // ══ payout of an allocated release: dischargeClaim and rotateClaimDestination ════════════════════

    /// @dev After P's release is allocated with outstanding claims, anyone can discharge them, and the money goes only
    ///      to the claim's destination. Redirecting a claim needs the claim OWNER's signature.
    function test_dischargeClaim_byStranger_paysOnlyTheClaimDestination_andRotationNeedsTheOwnersSignature() public {
        Deal memory d = _deal(_shape());
        usdc.setTransferMode(MockToken.Mode.REVERT); // every payout push becomes a claim
        uint256 acceptedAt = _mintAndAccept(d, d.p);
        vm.warp(acceptedAt + CW);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.RELEASE_ALLOCATED);
        assertEq(_paidToP(), 0, "nothing could be pushed");

        bytes32 claim0 = VNextSettlementLib.computeClaimId(block.chainid, address(d.e), d.p, 0, ClaimClass.PRINCIPAL);
        bytes32 claim1 = VNextSettlementLib.computeClaimId(block.chainid, address(d.e), d.p, 1, ClaimClass.PRINCIPAL);
        bytes32 feeClaim = VNextSettlementLib.computeClaimId(
            block.chainid, address(d.e), d.p, VNextSettlementLib.FEE_LEG_INDEX, ClaimClass.FEE
        );

        // a stranger cannot redirect claim 0: a signature by anyone but the owner reverts and changes nothing
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.BadSignature.selector);
        d.e.rotateClaimDestination(claim0, STRANGER, block.timestamp + 1 hours, _sign(0xBAD, keccak256("not-the-owner")));
        assertEq(d.e.claimOf(claim0).claimDestination, recip1, "destination unchanged");

        usdc.setTransferMode(MockToken.Mode.NORMAL);
        uint256 strangerBefore = usdc.balanceOf(STRANGER);
        vm.prank(STRANGER);
        d.e.dischargeClaim(claim0);
        assertEq(usdc.balanceOf(recip1), (GP - FP) / 2, "paid to the claim's destination");
        assertEq(usdc.balanceOf(STRANGER), strangerBefore, "the caller is paid nothing");

        d.e.dischargeClaim(claim1);
        _assertState(d.e, d.p, UnitState.RELEASE_ALLOCATED); // the fee claim is still outstanding
        d.e.dischargeClaim(feeClaim);
        _assertPReleasedInFull(d);
    }

    // ══ cross-unit coupling: the only read is the aggregate solvency gate ═══════════════════════════════

    /// @dev `_requireSolvent` compares the escrow's balance with the SUM of all units' (and the bond buckets') liabilities.
    ///      A shortfall of one wei against the siblings' collateral blocks P's release; restoring it unblocks it. A
    ///      conforming sibling refund lowers balance and liability together, so it can never trip this gate
    ///      (see the n22 tests, where P releases after C2 refunded).
    function test_finalize_P_revertsInsolvent_whenTheEscrowBalanceIsBelowTheSumOfAllUnitsLiabilities() public {
        Deal memory d = _deal(_shape());
        uint256 acceptedAt = _mintAndAccept(d, d.p);
        vm.warp(acceptedAt + CW);

        vm.prank(address(d.e));
        IERC20(address(usdc)).transfer(address(0xDEAD1), 1); // one wei short of GP + GC1 + GC2
        vm.prank(STRANGER);
        vm.expectRevert(VNextSettlementEscrow.Insolvent.selector);
        d.e.finalize(d.p);
        _assertState(d.e, d.p, UnitState.PRIMARY_ASSERTED);

        usdc.mint(address(d.e), 1);
        vm.prank(STRANGER);
        d.e.finalize(d.p);
        _assertPReleasedInFull(d);
    }
}
