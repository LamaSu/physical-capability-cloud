// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PCCProtocol.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";
import {IPCCOracle} from "../src/interfaces/IPCCOracle.sol";
import {MockPCCOracle} from "./mocks/MockPCCOracle.sol";

contract PCCProtocolTest is Test {
    PCCProtocol protocol;
    MockUSDC usdc;
    MockPCCOracle mockOracle;

    address constant FEE_RECIPIENT = 0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B;
    address governor = address(0x10);
    address payer = address(0x1);
    address operator = address(0x2);
    address arbiter = address(0x3);
    address challenger = address(0x4);
    address oracleSigner = address(0xABCD);

    bytes32 cwmId = keccak256("cwm-001");
    bytes32 stepId = keccak256("step-001");

    uint256 constant INITIAL_FEE_BPS = 150; // 1.5%

    function setUp() public {
        usdc = new MockUSDC(1_000_000e6);
        // MockPCCOracle starts accepting attestations; tests toggle it off
        // to exercise the fail-closed path.
        mockOracle = new MockPCCOracle(oracleSigner, true);
        protocol = new PCCProtocol(FEE_RECIPIENT, INITIAL_FEE_BPS, governor, address(mockOracle));

        usdc.mint(payer, 100_000e6);
        usdc.mint(operator, 10_000e6);
        usdc.mint(challenger, 10_000e6);
    }

    /** Authorize the test contract as a verifier on a newly created escrow */
    function _authorizeTestAsVerifier(MilestoneEscrow escrow_) internal {
        vm.prank(arbiter);
        escrow_.addVerifier(address(this));
    }

    /** Build a valid attestation for a given escrow. MockPCCOracle accepts
     *  anything with verified=true + non-zero escrowAddress when its toggle
     *  is set. */
    function _makeAttestation(address escrowAddr, bytes32 evidenceHash, uint8 tier)
        internal
        view
        returns (IPCCOracle.Attestation memory)
    {
        return IPCCOracle.Attestation({
            version: 1,
            escrowAddress: escrowAddr,
            jobId: "job-test",
            evidenceHash: evidenceHash,
            tier: tier,
            verified: true,
            timestamp: block.timestamp,
            nonce: keccak256(abi.encode(escrowAddr, evidenceHash, block.timestamp)),
            extraData: hex"",
            signature: hex""
        });
    }

    // ── Constructor / Immutability ───────────────────────────────────

    function test_constructor_setsFeeRecipientImmutable() public view {
        assertEq(protocol.feeRecipient(), FEE_RECIPIENT);
    }

    function test_constructor_setsFeeBps() public view {
        assertEq(protocol.protocolFeeBps(), INITIAL_FEE_BPS);
    }

    function test_constructor_setsGovernor() public view {
        assertEq(protocol.governor(), governor);
    }

    function test_noSetterForFeeRecipient() public {
        // There must be no function to change feeRecipient — we verify via expected-revert
        // on an attempted low-level call to a non-existent function
        (bool success,) = address(protocol).call(
            abi.encodeWithSignature("setFeeRecipient(address)", address(0x99))
        );
        assertFalse(success, "setFeeRecipient should not exist");
    }

    function test_feeRecipient_isHardcoded() public {
        // Even governor cannot change fee recipient
        vm.prank(governor);
        // Attempting to call setFeeRecipient (which doesn't exist) should fail
        (bool success,) = address(protocol).call(
            abi.encodeWithSignature("setFeeRecipient(address)", address(0x99))
        );
        assertFalse(success, "Governor cannot change fee recipient");
        // Fee recipient unchanged
        assertEq(protocol.feeRecipient(), FEE_RECIPIENT);
    }

    // ── Fee Bounds ───────────────────────────────────────────────────

    function test_setProtocolFeeBps_withinBounds() public {
        vm.prank(governor);
        protocol.setProtocolFeeBps(200);
        assertEq(protocol.protocolFeeBps(), 200);
    }

    function test_setProtocolFeeBps_atMinimum() public {
        vm.prank(governor);
        protocol.setProtocolFeeBps(10); // 0.1%
        assertEq(protocol.protocolFeeBps(), 10);
    }

    function test_setProtocolFeeBps_atMaximum() public {
        vm.prank(governor);
        protocol.setProtocolFeeBps(500); // 5%
        assertEq(protocol.protocolFeeBps(), 500);
    }

    function test_setProtocolFeeBps_belowMin_reverts() public {
        vm.prank(governor);
        vm.expectRevert("Fee below minimum (10 bps)");
        protocol.setProtocolFeeBps(9);
    }

    function test_setProtocolFeeBps_zero_reverts() public {
        vm.prank(governor);
        vm.expectRevert("Fee below minimum (10 bps)");
        protocol.setProtocolFeeBps(0);
    }

    function test_setProtocolFeeBps_aboveMax_reverts() public {
        vm.prank(governor);
        vm.expectRevert("Fee above maximum (500 bps)");
        protocol.setProtocolFeeBps(501);
    }

    function test_setProtocolFeeBps_onlyGovernor() public {
        vm.prank(payer);
        vm.expectRevert("Only governor");
        protocol.setProtocolFeeBps(200);
    }

    // ── Governor Transfer ─────────────────────────────────────────────

    function test_transferGovernor() public {
        address newGov = address(0x20);
        vm.prank(governor);
        protocol.transferGovernor(newGov);
        assertEq(protocol.governor(), newGov);
    }

    function test_transferGovernor_onlyGovernor() public {
        vm.prank(payer);
        vm.expectRevert("Only governor");
        protocol.transferGovernor(address(0x20));
    }

    function test_transferGovernor_zeroAddress_reverts() public {
        vm.prank(governor);
        vm.expectRevert("Zero governor");
        protocol.transferGovernor(address(0));
    }

    // ── Factory ───────────────────────────────────────────────────────

    function test_createEscrow_registersEscrow() public {
        address escrow = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        assertTrue(protocol.isProtocolEscrow(escrow));
        assertEq(protocol.getEscrowCount(), 1);
        assertEq(protocol.allEscrows(0), escrow);
    }

    function test_createEscrow_setsProtocolRoot() public {
        address escrow = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        MilestoneEscrow me = MilestoneEscrow(escrow);
        assertEq(me.protocolRoot(), address(protocol));
    }

    function test_createEscrow_multipleTimes() public {
        protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        bytes32 cwmId2 = keccak256("cwm-002");
        protocol.createEscrow(payer, arbiter, address(usdc), cwmId2);
        assertEq(protocol.getEscrowCount(), 2);
    }

    // ── collectFeeWithAttestation access control ──────────────────────

    function test_collectFeeWithAttestation_onlyProtocolEscrow() public {
        // A non-escrow address cannot call the oracle-gated fee collector
        IPCCOracle.Attestation memory att = _makeAttestation(address(0xDEAD), keccak256("e"), 1);
        vm.prank(address(0x99));
        vm.expectRevert("Only protocol escrow");
        protocol.collectFeeWithAttestation(address(usdc), 100e6, att);
    }

    function test_collectFeeWithAttestation_byNonFactoryEscrow_reverts() public {
        // A manually deployed escrow (not via factory) cannot call the fee collector
        MilestoneEscrow rogue = new MilestoneEscrow(payer, arbiter, address(usdc), cwmId, address(protocol));
        IPCCOracle.Attestation memory att = _makeAttestation(address(rogue), keccak256("e"), 1);
        vm.prank(address(rogue));
        vm.expectRevert("Only protocol escrow");
        protocol.collectFeeWithAttestation(address(usdc), 100e6, att);
    }

    function test_collectFeeWithAttestation_invalidOracle_reverts() public {
        // Even a factory escrow fails if the oracle rejects the attestation
        address escrowAddr = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        mockOracle.setValid(false); // flip oracle to reject everything

        IPCCOracle.Attestation memory att = _makeAttestation(escrowAddr, keccak256("e"), 1);
        vm.prank(escrowAddr);
        vm.expectRevert("PCC: invalid oracle attestation");
        protocol.collectFeeWithAttestation(address(usdc), 100e6, att);
    }

    // ── Fee Calculation ───────────────────────────────────────────────

    function test_calculateFee() public view {
        // 150 bps = 1.5% of 1000 = 15
        assertEq(protocol.calculateFee(1000e6), 15e6);
    }

    function test_calculateFee_largeAmount() public view {
        // 1.5% of 100_000 USDC = 1500 USDC
        assertEq(protocol.calculateFee(100_000e6), 1500e6);
    }

    // ── Full Release Flow with Fee ─────────────────────────────────────

    function test_fullFlow_feeDeductedOnRelease() public {
        // Create escrow via factory
        address escrowAddr = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        MilestoneEscrow escrow = MilestoneEscrow(escrowAddr);
        _authorizeTestAsVerifier(escrow);

        uint256 milestoneAmount = 1000e6; // 1000 USDC
        uint256 expectedFee = (milestoneAmount * INITIAL_FEE_BPS) / 10000; // 15 USDC

        // Setup: add milestone and fund
        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, milestoneAmount, 0, 3600);
        usdc.approve(escrowAddr, milestoneAmount);
        escrow.fund();
        vm.stopPrank();

        // Evidence and attestation
        bytes32 evidenceHash = keccak256("evidence");
        vm.prank(operator);
        escrow.submitEvidence(0, evidenceHash);
        IPCCOracle.Attestation memory att = _makeAttestation(escrowAddr, evidenceHash, 1);
        escrow.submitAttestation(0, att);

        // Warp past challenge window
        vm.warp(block.timestamp + 3601);

        uint256 feeRecipientBefore = usdc.balanceOf(FEE_RECIPIENT);
        uint256 operatorBefore = usdc.balanceOf(operator);

        // Release (must pass the same attestation)
        escrow.release(0, att);

        // Fee recipient received exactly 1.5%
        assertEq(
            usdc.balanceOf(FEE_RECIPIENT) - feeRecipientBefore,
            expectedFee,
            "Fee recipient should receive 1.5%"
        );

        // Operator received net amount (no bond in this test)
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            milestoneAmount - expectedFee,
            "Operator should receive payment minus fee"
        );

        // Protocol accounting updated
        assertEq(protocol.feesFromEscrow(escrowAddr), expectedFee);
        assertEq(protocol.getTotalFeesForToken(address(usdc)), expectedFee);
    }

    function test_fullFlow_withBond_feeOnPaymentOnly() public {
        // Fee should only be deducted from the payment, NOT the bond
        address escrowAddr = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        MilestoneEscrow escrow = MilestoneEscrow(escrowAddr);
        _authorizeTestAsVerifier(escrow);

        uint256 milestoneAmount = 1000e6;
        uint256 bondAmount = 100e6;
        uint256 expectedFee = (milestoneAmount * INITIAL_FEE_BPS) / 10000; // 15 USDC

        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, milestoneAmount, bondAmount, 3600);
        usdc.approve(escrowAddr, milestoneAmount);
        escrow.fund();
        vm.stopPrank();

        // Operator deposits bond
        bytes32 evidenceHash = keccak256("evidence");
        vm.startPrank(operator);
        usdc.approve(escrowAddr, bondAmount);
        escrow.depositBond(0);
        escrow.submitEvidence(0, evidenceHash);
        vm.stopPrank();

        IPCCOracle.Attestation memory att = _makeAttestation(escrowAddr, evidenceHash, 1);
        escrow.submitAttestation(0, att);
        vm.warp(block.timestamp + 3601);

        uint256 operatorBefore = usdc.balanceOf(operator);
        escrow.release(0, att);

        // Operator gets: milestoneAmount - fee + bondAmount (bond returned in full)
        uint256 expectedOperatorPayout = milestoneAmount - expectedFee + bondAmount;
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            expectedOperatorPayout,
            "Operator gets net payment + bond"
        );
    }

    function test_fullFlow_feeAtDifferentRate() public {
        // Change fee to 300 bps (3%)
        vm.prank(governor);
        protocol.setProtocolFeeBps(300);

        address escrowAddr = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        MilestoneEscrow escrow = MilestoneEscrow(escrowAddr);
        _authorizeTestAsVerifier(escrow);

        uint256 milestoneAmount = 1000e6;
        uint256 expectedFee = (milestoneAmount * 300) / 10000; // 30 USDC

        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, milestoneAmount, 0, 3600);
        usdc.approve(escrowAddr, milestoneAmount);
        escrow.fund();
        vm.stopPrank();

        bytes32 evidenceHash = keccak256("evidence");
        vm.prank(operator);
        escrow.submitEvidence(0, evidenceHash);
        IPCCOracle.Attestation memory att = _makeAttestation(escrowAddr, evidenceHash, 1);
        escrow.submitAttestation(0, att);
        vm.warp(block.timestamp + 3601);

        uint256 feeRecipientBefore = usdc.balanceOf(FEE_RECIPIENT);
        escrow.release(0, att);

        assertEq(usdc.balanceOf(FEE_RECIPIENT) - feeRecipientBefore, expectedFee);
    }

    function test_multipleEscrows_feesAccumulate() public {
        address escrowAddr1 = protocol.createEscrow(payer, arbiter, address(usdc), keccak256("cwm-1"));
        address escrowAddr2 = protocol.createEscrow(payer, arbiter, address(usdc), keccak256("cwm-2"));
        _authorizeTestAsVerifier(MilestoneEscrow(escrowAddr1));
        _authorizeTestAsVerifier(MilestoneEscrow(escrowAddr2));

        uint256 amount = 1000e6;
        uint256 fee = (amount * INITIAL_FEE_BPS) / 10000;

        // Release on escrow 1
        _runFullFlow(MilestoneEscrow(escrowAddr1), amount);
        // Release on escrow 2
        _runFullFlow(MilestoneEscrow(escrowAddr2), amount);

        // Total fees = 2 * fee
        assertEq(protocol.getTotalFeesForToken(address(usdc)), fee * 2);
        assertEq(protocol.feesFromEscrow(escrowAddr1), fee);
        assertEq(protocol.feesFromEscrow(escrowAddr2), fee);
    }

    function test_release_failsWhenOracleRejects() public {
        // If the oracle later flips to reject, release() fails at the
        // PCCProtocol.collectFeeWithAttestation boundary, NOT silently.
        // Setup: open the challenge window while oracle still accepts.
        address escrowAddr = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        MilestoneEscrow escrow = MilestoneEscrow(escrowAddr);
        _authorizeTestAsVerifier(escrow);

        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, 1000e6, 0, 3600);
        usdc.approve(escrowAddr, 1000e6);
        escrow.fund();
        vm.stopPrank();

        bytes32 evidenceHash = keccak256("evidence");
        vm.prank(operator);
        escrow.submitEvidence(0, evidenceHash);

        IPCCOracle.Attestation memory att = _makeAttestation(escrowAddr, evidenceHash, 1);
        escrow.submitAttestation(0, att);

        // Flip oracle to reject AFTER attestation was accepted
        mockOracle.setValid(false);
        vm.warp(block.timestamp + 3601);

        vm.expectRevert("PCC: invalid oracle attestation");
        escrow.release(0, att);
    }

    function test_submitAttestation_failsWhenOracleRejects() public {
        // Oracle rejection at submission time blocks the challenge window
        // from ever opening — fail closed.
        mockOracle.setValid(false);
        address escrowAddr = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        MilestoneEscrow escrow = MilestoneEscrow(escrowAddr);
        _authorizeTestAsVerifier(escrow);

        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, 1000e6, 0, 3600);
        usdc.approve(escrowAddr, 1000e6);
        escrow.fund();
        vm.stopPrank();

        bytes32 evidenceHash = keccak256("evidence");
        vm.prank(operator);
        escrow.submitEvidence(0, evidenceHash);

        IPCCOracle.Attestation memory att = _makeAttestation(escrowAddr, evidenceHash, 1);
        vm.expectRevert("Invalid oracle attestation");
        escrow.submitAttestation(0, att);
    }

    // ── Helpers ──────────────────────────────────────────────────────

    function _runFullFlow(MilestoneEscrow escrow, uint256 amount) internal {
        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, amount, 0, 3600);
        usdc.approve(address(escrow), amount);
        escrow.fund();
        vm.stopPrank();

        bytes32 evidenceHash = keccak256("evidence");
        vm.prank(operator);
        escrow.submitEvidence(0, evidenceHash);
        IPCCOracle.Attestation memory att = _makeAttestation(address(escrow), evidenceHash, 1);
        escrow.submitAttestation(0, att);
        vm.warp(block.timestamp + 3601);
        escrow.release(0, att);
    }
}
