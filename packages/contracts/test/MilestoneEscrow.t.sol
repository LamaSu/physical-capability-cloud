// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";

contract MilestoneEscrowTest is Test {
    MilestoneEscrow escrow;
    MockUSDC usdc;

    address payer = address(0x1);
    address operator = address(0x2);
    address arbiter = address(0x3);
    address challenger = address(0x4);
    bytes32 cwmId = keccak256("cwm-001");
    bytes32 stepId1 = keccak256("step-001");
    bytes32 stepId2 = keccak256("step-002");

    address verifier = address(0x5);

    function setUp() public {
        usdc = new MockUSDC(1_000_000e6); // 1M USDC
        // address(0) for protocolRoot = standalone mode, no fee deducted
        escrow = new MilestoneEscrow(payer, arbiter, address(usdc), cwmId, address(0));

        // Distribute tokens
        usdc.mint(payer, 100_000e6);
        usdc.mint(operator, 10_000e6);
        usdc.mint(challenger, 10_000e6);

        // Authorize the verifier and the test contract itself for attestation
        vm.startPrank(arbiter);
        escrow.addVerifier(verifier);
        escrow.addVerifier(address(this));
        vm.stopPrank();
    }

    // ── Setup Tests ─────────────────────────────────────────────────

    function test_constructor() public view {
        assertEq(escrow.payer(), payer);
        assertEq(escrow.arbiter(), arbiter);
        assertEq(address(escrow.token()), address(usdc));
        assertEq(escrow.cwmId(), cwmId);
        assertEq(escrow.funded(), false);
    }

    function test_addMilestone() public {
        vm.prank(payer);
        escrow.addMilestone(stepId1, operator, 100e6, 10e6, 3600);

        assertEq(escrow.getMilestoneCount(), 1);
        MilestoneEscrow.Milestone memory m = escrow.getMilestone(0);
        assertEq(m.stepId, stepId1);
        assertEq(m.operator, operator);
        assertEq(m.amount, 100e6);
        assertEq(m.operatorBond, 10e6);
        assertEq(uint8(m.status), 0); // Unfunded
    }

    function test_addMilestone_onlyPayer() public {
        vm.prank(operator);
        vm.expectRevert("Only payer");
        escrow.addMilestone(stepId1, operator, 100e6, 10e6, 3600);
    }

    function test_addMilestone_afterFunding_reverts() public {
        vm.startPrank(payer);
        escrow.addMilestone(stepId1, operator, 100e6, 0, 3600);
        usdc.approve(address(escrow), 100e6);
        escrow.fund();
        vm.expectRevert("Already funded");
        escrow.addMilestone(stepId2, operator, 50e6, 0, 3600);
        vm.stopPrank();
    }

    // ── Funding Tests ───────────────────────────────────────────────

    function test_fund() public {
        vm.startPrank(payer);
        escrow.addMilestone(stepId1, operator, 100e6, 0, 3600);
        escrow.addMilestone(stepId2, operator, 50e6, 0, 3600);
        usdc.approve(address(escrow), 150e6);
        escrow.fund();
        vm.stopPrank();

        assertEq(escrow.funded(), true);
        assertEq(escrow.totalAmount(), 150e6);
        assertEq(usdc.balanceOf(address(escrow)), 150e6);

        // Both milestones should be Funded
        assertEq(uint8(escrow.getMilestone(0).status), 1);
        assertEq(uint8(escrow.getMilestone(1).status), 1);
    }

    function test_fund_noMilestones_reverts() public {
        vm.prank(payer);
        vm.expectRevert("No milestones");
        escrow.fund();
    }

    // ── Bond Deposit ────────────────────────────────────────────────

    function test_depositBond() public {
        _setupFundedEscrow(100e6, 10e6);

        vm.startPrank(operator);
        usdc.approve(address(escrow), 10e6);
        escrow.depositBond(0);
        vm.stopPrank();

        assertEq(uint8(escrow.getMilestone(0).status), 2); // Locked
        assertEq(usdc.balanceOf(address(escrow)), 110e6);
    }

    function test_depositBond_wrongOperator() public {
        _setupFundedEscrow(100e6, 10e6);

        vm.prank(payer);
        vm.expectRevert("Only operator");
        escrow.depositBond(0);
    }

    // ── Evidence Flow ───────────────────────────────────────────────

    function test_fullFlow_noBond() public {
        // Setup: funded, no bond required
        _setupFundedEscrow(100e6, 0);

        bytes32 evidenceHash = keccak256("evidence-bundle-001");
        bytes32 attestationHash = keccak256("attestation-001");

        // Operator submits evidence (Funded -> Evidenced since no bond)
        vm.prank(operator);
        escrow.submitEvidence(0, evidenceHash);
        assertEq(uint8(escrow.getMilestone(0).status), 3); // Evidenced

        // Verifier submits attestation (opens challenge window)
        escrow.submitAttestation(0, attestationHash);
        assertEq(uint8(escrow.getMilestone(0).status), 4); // Attested

        // Warp past challenge window
        vm.warp(block.timestamp + 3601);

        // Release
        escrow.release(0);
        assertEq(uint8(escrow.getMilestone(0).status), 5); // Released
        assertEq(usdc.balanceOf(operator), 10_100e6); // original 10k + 100
    }

    function test_fullFlow_withBond() public {
        _setupFundedEscrow(100e6, 10e6);

        // Operator deposits bond
        vm.startPrank(operator);
        usdc.approve(address(escrow), 10e6);
        escrow.depositBond(0);

        // Submit evidence
        bytes32 evidenceHash = keccak256("evidence-bundle-002");
        escrow.submitEvidence(0, evidenceHash);
        vm.stopPrank();

        // Attestation
        bytes32 attestationHash = keccak256("attestation-002");
        escrow.submitAttestation(0, attestationHash);

        // Warp + release
        vm.warp(block.timestamp + 3601);
        escrow.release(0);

        // Operator gets payment + bond back
        assertEq(usdc.balanceOf(operator), 10_100e6); // 10k - 10 (bond) + 100 (payment) + 10 (bond back) = 10100
    }

    function test_submitEvidence_wrongOperator() public {
        _setupFundedEscrow(100e6, 0);

        vm.prank(payer);
        vm.expectRevert("Only operator");
        escrow.submitEvidence(0, keccak256("fake"));
    }

    function test_release_beforeWindowEnds_reverts() public {
        _setupFundedEscrow(100e6, 0);

        vm.prank(operator);
        escrow.submitEvidence(0, keccak256("evidence"));
        escrow.submitAttestation(0, keccak256("attestation"));

        // Try to release immediately (window not expired)
        vm.expectRevert("Challenge window open");
        escrow.release(0);
    }

    // ── Dispute Tests ───────────────────────────────────────────────

    function test_dispute_challengerWins() public {
        _setupFundedEscrow(100e6, 10e6);

        // Operator bonds + submits evidence + gets attested
        vm.startPrank(operator);
        usdc.approve(address(escrow), 10e6);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("evidence"));
        vm.stopPrank();
        escrow.submitAttestation(0, keccak256("attestation"));

        // Challenger files dispute during window
        vm.startPrank(challenger);
        usdc.approve(address(escrow), 5e6);
        escrow.fileDispute(0, 5e6, keccak256("counter-evidence"), "Bad print quality");
        vm.stopPrank();

        assertEq(uint8(escrow.getMilestone(0).status), 6); // Disputed

        // Arbiter resolves: challenger wins
        vm.prank(arbiter);
        escrow.resolveDispute(0, true);

        assertEq(uint8(escrow.getMilestone(0).status), 8); // Slashed

        // Payer gets refund (100 USDC)
        // Challenger gets their bond back (5) + operator bond (10) = 15 total payout
        // Challenger: started 10000, deposited 5 bond, receives 15 → 10000 - 5 + 15 = 10010
        assertEq(usdc.balanceOf(payer), 100_000e6); // original 100k (refunded)
        assertEq(usdc.balanceOf(challenger), 10_010e6); // 10k - 5 (bond deposited) + 15 (bond back + operator slash)
    }

    function test_dispute_operatorWins() public {
        _setupFundedEscrow(100e6, 10e6);

        vm.startPrank(operator);
        usdc.approve(address(escrow), 10e6);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("evidence"));
        vm.stopPrank();
        escrow.submitAttestation(0, keccak256("attestation"));

        vm.startPrank(challenger);
        usdc.approve(address(escrow), 5e6);
        escrow.fileDispute(0, 5e6, keccak256("counter-evidence"), "Dispute reason");
        vm.stopPrank();

        // Arbiter resolves: operator wins
        vm.prank(arbiter);
        escrow.resolveDispute(0, false);

        assertEq(uint8(escrow.getMilestone(0).status), 5); // Released

        // Operator gets payment (100) + bond back (10) + challenger bond (5)
        assertEq(usdc.balanceOf(operator), 10_105e6); // 10k - 10 + 100 + 10 + 5
    }

    function test_dispute_afterWindow_reverts() public {
        _setupFundedEscrow(100e6, 0);

        vm.prank(operator);
        escrow.submitEvidence(0, keccak256("evidence"));
        escrow.submitAttestation(0, keccak256("attestation"));

        // Warp past challenge window
        vm.warp(block.timestamp + 3601);

        vm.startPrank(challenger);
        usdc.approve(address(escrow), 5e6);
        vm.expectRevert("Challenge window closed");
        escrow.fileDispute(0, 5e6, keccak256("counter"), "Too late");
        vm.stopPrank();
    }

    function test_resolveDispute_onlyArbiter() public {
        _setupFundedEscrow(100e6, 10e6);

        vm.startPrank(operator);
        usdc.approve(address(escrow), 10e6);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("evidence"));
        vm.stopPrank();
        escrow.submitAttestation(0, keccak256("attestation"));

        vm.startPrank(challenger);
        usdc.approve(address(escrow), 5e6);
        escrow.fileDispute(0, 5e6, keccak256("counter"), "Reason");
        vm.stopPrank();

        vm.prank(payer);
        vm.expectRevert("Only arbiter");
        escrow.resolveDispute(0, true);
    }

    // ── View Tests ──────────────────────────────────────────────────

    function test_getMilestoneCount() public {
        vm.startPrank(payer);
        escrow.addMilestone(stepId1, operator, 50e6, 0, 3600);
        escrow.addMilestone(stepId2, operator, 30e6, 0, 7200);
        vm.stopPrank();

        assertEq(escrow.getMilestoneCount(), 2);
    }

    function test_getDispute_empty() public view {
        MilestoneEscrow.Dispute memory d = escrow.getDispute(0);
        assertEq(d.challenger, address(0));
        assertEq(d.resolved, false);
    }

    // ── Helpers ─────────────────────────────────────────────────────

    function _setupFundedEscrow(uint256 amount, uint256 bond) internal {
        vm.startPrank(payer);
        escrow.addMilestone(stepId1, operator, amount, bond, 3600);
        usdc.approve(address(escrow), amount);
        escrow.fund();
        vm.stopPrank();
    }
}
