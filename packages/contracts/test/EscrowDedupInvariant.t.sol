// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrowV2.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockEAS.sol";
import {Clones} from "../src/libraries/Clones.sol";

/**
 * @title EscrowDedupInvariantTest
 * @notice DELETION-BOUNDARY PROBE (Step 0 of ai/research/fable-settlement-architecture.md).
 *
 * Question this proves by EXECUTION (not by read): which escrow money-operations does
 * MilestoneEscrowV2 already dedup on-chain? Wherever it reverts/no-ops a duplicate, the
 * off-chain "exactly-once" gating for that op is redundant and DELETABLE. Wherever a
 * duplicate double-pays, the off-chain gating MUST STAY.
 *
 * POSITIVE cases (contract DEDUPS → off-chain gating deletable). Each must REVERT:
 *   P1 double fund()                         → "Already funded"           (:750)
 *   P2 double submitEvidence()               → "Invalid status"           (:814-818, write-once)
 *   P3 double submitAttestation(), same idx  → "Evidence not submitted"   (:862 status guard)
 *   P4 replay same UID to a 2nd milestone    → "Attestation already used" (:864 single-use UID)
 *   P5 release() before attestation          → "Not attested"            (:942)
 *   P6 release() before window closes        → "Challenge window open"   (:943)
 *   P7 double release() past window          → "Not attested"            (:942; Released set :946 CEI)
 *      ^ P7 is the load-bearing one: every retry/reclaim/keeper argument rests on it.
 *
 * NEGATIVE cases (contract does NOT dedup → off-chain gating MUST STAY). Must double-pay:
 *   N1 one escrow, two milestones w/ identical (stepId, jobId, evidenceHash) + two distinct
 *      oracle UIDs → BOTH release → operator paid 2x for one logical deliverable.
 *   N2 two separate escrows (what a duplicate createEscrowV2 mints) w/ identical logical
 *      identity + two UIDs (each recipient==its own escrow) → paid 2x across escrows.
 *
 * The contract dedups per-UID and per-milestone-status-transition, but has NO
 * (jobId, stepId, evidenceHash) logical-work registry — so a duplicated milestone plus an
 * oracle re-mint is the ONE composition where money-safety is not contract-enforced.
 *
 * Deploy/setup pattern mirrors MilestoneEscrowV2.t.sol (clone impl + initialize + MockEAS).
 *
 * AGENT_NAME: forkprobe-opus
 */
contract EscrowDedupInvariantTest is Test {
    // ── Actors ───────────────────────────────────────────────────────────────
    address internal payer    = address(0x1);
    address internal operator = address(0x2);
    address internal arbiter  = address(0x3);
    address internal oracle   = address(0x4); // authorizedOracle / EAS attester

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_UID = bytes32(uint256(0xDEAD));
    bytes32 internal constant CWM_ID     = keccak256("cwm-dedup-001");

    string  internal constant JOB_ID       = "job-dedup-001";
    bytes32 internal STEP_ID; // keccak256("step-dedup-001"), set in setUp
    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence-bundle-dedup-001");

    bytes32 internal constant VALID_UID = keccak256("eas-uid-001");

    uint256 internal constant AMOUNT           = 100e6;  // 100 USDC
    uint256 internal constant OPERATOR_BOND    = 10e6;   // 10 USDC
    uint256 internal constant CHALLENGE_WINDOW = 3600;   // 1 hour
    uint8   internal constant REQUIRED_TIER    = 1;

    // ── Contracts (shared single-milestone fixture, at Evidenced) ─────────────
    MilestoneEscrowV2 internal escrow;
    MockUSDC          internal usdc;
    MockEAS           internal mockEAS;

    // ── Setup: one milestone driven to Evidenced (mirrors V2 test) ────────────
    function setUp() public {
        vm.warp(1_000_000);
        STEP_ID = keccak256("step-dedup-001");

        usdc    = new MockUSDC(1_000_000e6);
        mockEAS = new MockEAS();

        escrow = _deployEscrow(payer, arbiter, address(usdc), CWM_ID, address(0), address(mockEAS), SCHEMA_UID, oracle);

        usdc.mint(payer,    500_000e6);
        usdc.mint(operator,  50_000e6);

        vm.prank(payer);
        escrow.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);

        vm.startPrank(payer);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(escrow), OPERATOR_BOND);
        escrow.depositBond(0);
        escrow.submitEvidence(0, EVIDENCE_HASH);
        vm.stopPrank();
    }

    // ── Deploy helper (clone impl + initialize) ───────────────────────────────
    function _deployEscrow(
        address _payer,
        address _arbiter,
        address _token,
        bytes32 _cwmId,
        address _protocolRoot,
        address _eas_,
        bytes32 _schemaUid,
        address _oracle
    ) internal returns (MilestoneEscrowV2 esc) {
        address impl = address(new MilestoneEscrowV2(_eas_, _schemaUid, _oracle));
        esc = MilestoneEscrowV2(Clones.clone(impl));
        esc.initialize(_payer, _arbiter, _token, _cwmId, _protocolRoot);
    }

    /// @dev Register a fully-valid attestation in `eas_` for `uid`, bound to `recip`, carrying
    ///      the SAME logical identity (JOB_ID, EVIDENCE_HASH, STEP_ID). Two distinct uids built
    ///      this way both validate — that is the create-leg gap N1/N2 exercise.
    function _registerAttestation(MockEAS eas_, bytes32 uid, address recip) internal {
        bytes memory data = eas_.encodeData(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "", REQUIRED_TIER, true, STEP_ID
        );
        eas_.setAttestation(uid, EASAttestation({
            uid:            uid,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      recip,
            attester:       oracle,
            revocable:      true,
            data:           data
        }));
    }

    /// @dev Build a fresh escrow with TWO milestones sharing identical (stepId, jobId, evidence),
    ///      driven to Evidenced on both. This is the "duplicate addMilestone" leg — the contract
    ///      permits it because _addMilestone (:610-655) has no logical-identity dedup.
    ///
    ///      operatorBond is 0 here on purpose: the bond is the operator's own money returned in
    ///      full at release, so a non-zero bond would wash through the balance delta and obscure
    ///      the finding. With bond 0, release pays exactly AMOUNT and the double-pay reads cleanly
    ///      as 2*AMOUNT of PAYER capital. (The bond PATH itself is covered by P7 on the setUp escrow.)
    function _twoIdenticalMilestoneEscrow() internal returns (MilestoneEscrowV2 esc, MockUSDC tok, MockEAS eas_) {
        tok  = new MockUSDC(1_000_000e6);
        eas_ = new MockEAS();
        esc  = _deployEscrow(payer, arbiter, address(tok), CWM_ID, address(0), address(eas_), SCHEMA_UID, oracle);

        tok.mint(payer,    500_000e6);
        tok.mint(operator,  50_000e6);

        vm.startPrank(payer);
        // Two milestones, byte-for-byte identical logical identity. No revert — no dedup.
        esc.addMilestone(STEP_ID, operator, AMOUNT, 0, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        esc.addMilestone(STEP_ID, operator, AMOUNT, 0, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        tok.approve(address(esc), AMOUNT * 2);
        esc.fund();
        vm.stopPrank();

        // bond 0 → depositBond is skipped; submitEvidence accepts the Funded+bond0 state directly.
        vm.startPrank(operator);
        esc.submitEvidence(0, EVIDENCE_HASH);
        esc.submitEvidence(1, EVIDENCE_HASH);
        vm.stopPrank();
    }

    /// @dev Build a fresh single-milestone escrow driven to Evidenced (for the two-escrow N2 case).
    ///      operatorBond 0 for the same balance-clarity reason as _twoIdenticalMilestoneEscrow.
    function _oneMilestoneEscrow() internal returns (MilestoneEscrowV2 esc, MockUSDC tok, MockEAS eas_) {
        tok  = new MockUSDC(1_000_000e6);
        eas_ = new MockEAS();
        esc  = _deployEscrow(payer, arbiter, address(tok), CWM_ID, address(0), address(eas_), SCHEMA_UID, oracle);

        tok.mint(payer,    500_000e6);
        tok.mint(operator,  50_000e6);

        vm.startPrank(payer);
        esc.addMilestone(STEP_ID, operator, AMOUNT, 0, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        tok.approve(address(esc), AMOUNT);
        esc.fund();
        vm.stopPrank();

        vm.prank(operator);
        esc.submitEvidence(0, EVIDENCE_HASH);
    }

    /// @dev Drive milestone `idx` on `esc` (mock `eas_`) from Evidenced → Released using `uid`.
    function _attestAndRelease(MilestoneEscrowV2 esc, MockEAS eas_, uint256 idx, bytes32 uid) internal {
        _registerAttestation(eas_, uid, address(esc));
        esc.submitAttestation(idx, uid);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        esc.release(idx);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // POSITIVE — contract DEDUPS (these off-chain guards are DELETABLE)
    // ══════════════════════════════════════════════════════════════════════════

    // P1: double fund() reverts — the escrow can be funded exactly once.
    function test_pos_P1_doubleFund_reverts() public {
        vm.prank(payer);
        vm.expectRevert("Already funded");
        escrow.fund();
    }

    // P2: double submitEvidence() reverts — evidence is write-once (status left Evidenced).
    function test_pos_P2_doubleSubmitEvidence_reverts() public {
        // setUp already submitted evidence on milestone 0 → status Evidenced.
        vm.prank(operator);
        vm.expectRevert("Invalid status");
        escrow.submitEvidence(0, EVIDENCE_HASH);
    }

    // P3: double submitAttestation() on the SAME milestone reverts on the status guard.
    // First submit moves status Evidenced→Attested; the second hits require(status==Evidenced).
    function test_pos_P3_doubleSubmitAttestation_sameMilestone_reverts() public {
        _registerAttestation(mockEAS, VALID_UID, address(escrow));
        escrow.submitAttestation(0, VALID_UID); // succeeds → Attested

        vm.expectRevert("Evidence not submitted");
        escrow.submitAttestation(0, VALID_UID); // status now Attested, not Evidenced
    }

    // P4: replaying the SAME UID to a DIFFERENT (still-Evidenced) milestone reverts on the
    // single-use UID guard (:864). This is the cross-milestone UID replay defense.
    function test_pos_P4_uidReplay_differentMilestone_reverts() public {
        (MilestoneEscrowV2 esc, , MockEAS eas_) = _twoIdenticalMilestoneEscrow();
        _registerAttestation(eas_, VALID_UID, address(esc));

        esc.submitAttestation(0, VALID_UID); // consumes UID on milestone 0
        assertTrue(esc.attestationUsed(VALID_UID), "UID must be marked used after first submit");

        vm.expectRevert("Attestation already used");
        esc.submitAttestation(1, VALID_UID); // same UID, milestone 1 → revert
    }

    // P5: release() before any attestation reverts — cannot pay an un-attested milestone.
    function test_pos_P5_releaseBeforeAttested_reverts() public {
        // setUp left milestone 0 at Evidenced (never attested).
        vm.expectRevert("Not attested");
        escrow.release(0);
    }

    // P6: release() before the challenge window closes reverts on the window guard (:943).
    function test_pos_P6_releaseBeforeWindow_reverts() public {
        _registerAttestation(mockEAS, VALID_UID, address(escrow));
        escrow.submitAttestation(0, VALID_UID); // Attested, window open (now + 3600)

        // Do NOT warp — window is still open.
        vm.expectRevert("Challenge window open");
        escrow.release(0);
    }

    // P7 (LOAD-BEARING): double release() past the window reverts. First release sets
    // status Released BEFORE any transfer (:946, CEI); the second hits require(status==Attested)
    // (:942) → "Not attested". THIS is the invariant every retry/reclaim/keeper argument rests on.
    function test_pos_P7_doubleRelease_reverts() public {
        _registerAttestation(mockEAS, VALID_UID, address(escrow));
        escrow.submitAttestation(0, VALID_UID);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        uint256 operatorBefore = usdc.balanceOf(operator);
        escrow.release(0); // pays once
        uint256 paid = usdc.balanceOf(operator) - operatorBefore;
        assertEq(paid, AMOUNT + OPERATOR_BOND, "first release pays amount + bond exactly once");

        // Second release must revert — no double-pay from a retried/duplicated crank.
        vm.expectRevert("Not attested");
        escrow.release(0);

        // Balance unchanged by the reverted second call.
        assertEq(usdc.balanceOf(operator) - operatorBefore, AMOUNT + OPERATOR_BOND, "no second payout");
    }

    // ══════════════════════════════════════════════════════════════════════════
    // NEGATIVE — contract does NOT dedup logical work (off-chain gating MUST STAY)
    // ══════════════════════════════════════════════════════════════════════════

    // N1: one escrow, TWO milestones with identical (stepId, jobId, evidenceHash), and TWO
    // distinct oracle UIDs → BOTH attest, BOTH release → operator paid 2x AMOUNT for one
    // logical deliverable. The contract has no logical-work registry, so this is NOT blocked.
    function test_neg_N1_duplicateMilestone_twoUids_doublePay() public {
        (MilestoneEscrowV2 esc, MockUSDC tok, MockEAS eas_) = _twoIdenticalMilestoneEscrow();

        // Prove the two milestones ARE the same logical work.
        MilestoneEscrowV2.Milestone memory m0 = esc.getMilestone(0);
        MilestoneEscrowV2.Milestone memory m1 = esc.getMilestone(1);
        assertEq(m0.jobIdHash, m1.jobIdHash, "same jobId");
        assertEq(m0.stepId,    m1.stepId,    "same stepId");

        bytes32 uidA = keccak256("oracle-mint-A");
        bytes32 uidB = keccak256("oracle-mint-B"); // oracle re-mint: different UID, same content

        uint256 operatorStart = tok.balanceOf(operator);

        _attestAndRelease(esc, eas_, 0, uidA);
        _attestAndRelease(esc, eas_, 1, uidB);

        // Both milestones Released.
        assertEq(uint8(esc.getMilestone(0).status), 5, "milestone 0 Released");
        assertEq(uint8(esc.getMilestone(1).status), 5, "milestone 1 Released");

        // Net operator gain = 2 * AMOUNT (the two bonds net to zero). One honest deliverable,
        // paid twice. THE DOUBLE-PAY the contract does not prevent.
        uint256 netGain = tok.balanceOf(operator) - operatorStart;
        assertEq(netGain, 2 * AMOUNT, "DOUBLE-PAY: operator paid 2x AMOUNT for one logical deliverable");
    }

    // N2: two SEPARATE escrows (what a duplicate createEscrowV2 mints — salt increments, no
    // revert, PCCProtocolV2.sol:258) each with the identical logical identity, and a per-escrow
    // oracle mint (recipient==its own escrow, so the recipient guard :872 does NOT help) → paid
    // 2x across escrows. This is the cross-escrow half of the create-leg gap.
    function test_neg_N2_duplicateEscrow_twoUids_doublePay() public {
        (MilestoneEscrowV2 escA, MockUSDC tokA, MockEAS easA) = _oneMilestoneEscrow();
        (MilestoneEscrowV2 escB, MockUSDC tokB, MockEAS easB) = _oneMilestoneEscrow();

        assertTrue(address(escA) != address(escB), "two distinct escrow clones");

        uint256 startA = tokA.balanceOf(operator);
        uint256 startB = tokB.balanceOf(operator);

        _attestAndRelease(escA, easA, 0, keccak256("mint-escrowA"));
        _attestAndRelease(escB, easB, 0, keccak256("mint-escrowB"));

        assertEq(uint8(escA.getMilestone(0).status), 5, "escrow A Released");
        assertEq(uint8(escB.getMilestone(0).status), 5, "escrow B Released");

        // Same (jobId, stepId, evidenceHash) paid once per escrow → 2x total.
        assertEq(tokA.balanceOf(operator) - startA, AMOUNT, "escrow A paid AMOUNT");
        assertEq(tokB.balanceOf(operator) - startB, AMOUNT, "escrow B paid AMOUNT");
        // Two escrows, one logical deliverable, 2x AMOUNT total settled.
    }
}
