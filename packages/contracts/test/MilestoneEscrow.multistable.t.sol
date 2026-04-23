// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockUSDT.sol";
import "./mocks/MockDAI.sol";
import "./mocks/MockFeeOnTransfer.sol";
import "./mocks/MockReturnFalseERC20.sol";

/**
 * @title MilestoneEscrowMultiStableTest
 * @notice Exercises the multi-stablecoin extension of MilestoneEscrow:
 *           - owner-only stablecoin allowlist management
 *           - milestones in non-default tokens
 *           - SafeERC20 compatibility (USDT-style no-return-bool tokens)
 *           - fee-on-transfer rejection
 *           - revocation does not retroactively invalidate milestones
 *           - release pays out in the milestone's currency
 */
contract MilestoneEscrowMultiStableTest is Test {
    MilestoneEscrow escrow;
    MockUSDC usdc; // default token
    MockUSDT usdt;
    MockDAI dai;
    MockFeeOnTransfer fot;
    MockReturnFalseERC20 rfalse;

    address payer = address(0x1);
    address operator = address(0x2);
    address arbiter = address(0x3);
    address challenger = address(0x4);
    address verifier = address(0x5);
    address attestor = address(0xA);

    bytes32 cwmId = keccak256("cwm-ms-001");
    bytes32 stepId1 = keccak256("step-ms-001");
    bytes32 stepId2 = keccak256("step-ms-002");
    bytes32 stepId3 = keccak256("step-ms-003");

    function setUp() public {
        usdc = new MockUSDC(1_000_000e6);
        usdt = new MockUSDT(1_000_000e6);
        dai = new MockDAI(1_000_000e18);
        fot = new MockFeeOnTransfer(1_000_000e18);
        rfalse = new MockReturnFalseERC20(1_000_000e18);

        escrow = new MilestoneEscrow(payer, arbiter, address(usdc), cwmId, address(0));

        // Distribute tokens to all test actors
        usdc.mint(payer, 100_000e6);
        usdc.mint(operator, 10_000e6);
        usdc.mint(challenger, 10_000e6);

        usdt.mint(payer, 100_000e6);
        usdt.mint(operator, 10_000e6);
        usdt.mint(challenger, 10_000e6);

        dai.mint(payer, 100_000e18);
        dai.mint(operator, 10_000e18);
        dai.mint(challenger, 10_000e18);

        fot.mint(payer, 100_000e18);

        rfalse.mint(payer, 100_000e18);

        vm.startPrank(arbiter);
        escrow.addVerifier(verifier);
        escrow.addVerifier(address(this));
        vm.stopPrank();
    }

    // ── Allowlist Management ────────────────────────────────────────

    function test_allowStablecoin_onlyPayer() public {
        vm.prank(operator);
        vm.expectRevert("Only payer");
        escrow.allowStablecoin(address(usdt), attestor, "ipfs://usdt-report", 50);
    }

    function test_allowStablecoin_storesAttestation() public {
        vm.prank(payer);
        escrow.allowStablecoin(address(usdt), attestor, "ipfs://usdt-report", 50);

        (
            address storedAttestor,
            uint64 storedAttestedAt,
            string memory storedUri,
            uint16 storedMaxDev,
            bool storedActive
        ) = escrow.reserves(address(usdt));

        assertEq(storedAttestor, attestor);
        assertEq(storedAttestedAt, uint64(block.timestamp));
        assertEq(storedUri, "ipfs://usdt-report");
        assertEq(storedMaxDev, 50);
        assertTrue(storedActive);
    }

    function test_allowStablecoin_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit IStablecoinEvents.StablecoinAllowed(address(dai), attestor, "ar://dai-report", 25);
        vm.prank(payer);
        escrow.allowStablecoin(address(dai), attestor, "ar://dai-report", 25);
    }

    function test_allowStablecoin_rejectsZeroAddress() public {
        vm.prank(payer);
        vm.expectRevert("Zero token");
        escrow.allowStablecoin(address(0), attestor, "", 0);
    }

    function test_allowStablecoin_rejectsEOA() public {
        address eoa = address(0xBEEF);
        vm.prank(payer);
        vm.expectRevert("Token not a contract");
        escrow.allowStablecoin(eoa, attestor, "", 0);
    }

    function test_allowStablecoin_reactivatesRevoked() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(usdt), attestor, "v1", 50);
        escrow.revokeStablecoin(address(usdt));
        escrow.allowStablecoin(address(usdt), attestor, "v2", 75);
        vm.stopPrank();

        (, , string memory uri, uint16 maxDev, bool active) = escrow.reserves(address(usdt));
        assertEq(uri, "v2");
        assertEq(maxDev, 75);
        assertTrue(active);
    }

    function test_revokeStablecoin_onlyPayer() public {
        vm.prank(payer);
        escrow.allowStablecoin(address(usdt), attestor, "", 0);

        vm.prank(operator);
        vm.expectRevert("Only payer");
        escrow.revokeStablecoin(address(usdt));
    }

    function test_revokeStablecoin_rejectsNonAllowlisted() public {
        vm.prank(payer);
        vm.expectRevert("Not allowlisted");
        escrow.revokeStablecoin(address(usdt));
    }

    function test_revokeStablecoin_emitsEvent() public {
        vm.prank(payer);
        escrow.allowStablecoin(address(dai), attestor, "", 0);

        vm.expectEmit(true, false, false, false);
        emit IStablecoinEvents.StablecoinRevoked(address(dai));
        vm.prank(payer);
        escrow.revokeStablecoin(address(dai));
    }

    function test_isStablecoinAllowed_defaultToken_alwaysTrue() public view {
        // Default token implicitly allowed for backward compat
        assertTrue(escrow.isStablecoinAllowed(address(usdc)));
    }

    function test_isStablecoinAllowed_nonAllowlistedFalse() public view {
        assertFalse(escrow.isStablecoinAllowed(address(usdt)));
    }

    function test_isStablecoinAllowed_revokedFalse() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(usdt), attestor, "", 0);
        escrow.revokeStablecoin(address(usdt));
        vm.stopPrank();
        assertFalse(escrow.isStablecoinAllowed(address(usdt)));
    }

    function test_getReserveTokens_enumeratesAll() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(usdt), attestor, "", 0);
        escrow.allowStablecoin(address(dai), attestor, "", 0);
        escrow.revokeStablecoin(address(usdt));
        vm.stopPrank();

        address[] memory tokens = escrow.getReserveTokens();
        assertEq(tokens.length, 2);
        assertEq(tokens[0], address(usdt));
        assertEq(tokens[1], address(dai));
    }

    // ── Milestone Creation with Token ───────────────────────────────

    function test_addMilestoneWithToken_defaultOmitted() public {
        vm.prank(payer);
        escrow.addMilestone(stepId1, operator, 100e6, 0, 3600);

        assertEq(escrow.getMilestoneCount(), 1);
        assertEq(escrow.tokenForMilestone(0), address(usdc));
        // No override stored — gas-clean for legacy deployments
        assertEq(escrow.tokenOf(0), address(0));
        assertEq(escrow.totalByToken(address(usdc)), 100e6);
    }

    function test_addMilestoneWithToken_allowlistedDAI() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(dai), attestor, "", 0);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(dai));
        vm.stopPrank();

        assertEq(escrow.tokenForMilestone(0), address(dai));
        assertEq(escrow.tokenOf(0), address(dai));
        assertEq(escrow.totalByToken(address(dai)), 100e18);
        // totalAmount is aggregated (even though decimals differ — by design)
        assertEq(escrow.totalAmount(), 100e18);
    }

    function test_addMilestoneWithToken_rejectsNotAllowed() public {
        vm.prank(payer);
        vm.expectRevert("Token not allowed");
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(dai));
    }

    function test_addMilestoneWithToken_rejectsAfterRevoke() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(dai), attestor, "", 0);
        escrow.revokeStablecoin(address(dai));
        vm.expectRevert("Token not allowed");
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(dai));
        vm.stopPrank();
    }

    function test_addMilestoneWithToken_onlyPayer() public {
        vm.prank(payer);
        escrow.allowStablecoin(address(dai), attestor, "", 0);

        vm.prank(operator);
        vm.expectRevert("Only payer");
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(dai));
    }

    // ── Multi-Token Funding ─────────────────────────────────────────

    function test_fund_mixedTokens() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(dai), attestor, "", 0);
        escrow.allowStablecoin(address(usdt), attestor, "", 0);

        escrow.addMilestone(stepId1, operator, 100e6, 0, 3600); // USDC
        escrow.addMilestoneWithToken(stepId2, operator, 50e18, 0, 3600, address(dai));
        escrow.addMilestoneWithToken(stepId3, operator, 200e6, 0, 3600, address(usdt));

        usdc.approve(address(escrow), 100e6);
        dai.approve(address(escrow), 50e18);
        usdt.approve(address(escrow), 200e6);
        escrow.fund();
        vm.stopPrank();

        assertTrue(escrow.funded());
        assertEq(usdc.balanceOf(address(escrow)), 100e6);
        assertEq(dai.balanceOf(address(escrow)), 50e18);
        assertEq(usdt.balanceOf(address(escrow)), 200e6);
    }

    function test_fund_rejectsFeeOnTransfer() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(fot), attestor, "", 0);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(fot));

        fot.approve(address(escrow), 100e18);
        vm.expectRevert("Fee-on-transfer token");
        escrow.fund();
        vm.stopPrank();
    }

    function test_fund_rejectsReturnFalseToken() public {
        // Register the return-false token (it IS a contract so it passes the allowlist check)
        vm.startPrank(payer);
        escrow.allowStablecoin(address(rfalse), attestor, "", 0);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(rfalse));
        rfalse.approve(address(escrow), 100e18);
        // SafeERC20 MUST revert on returndata == false
        vm.expectRevert();
        escrow.fund();
        vm.stopPrank();
    }

    // ── Full Flow in Non-Default Token (DAI) ────────────────────────

    function test_fullFlow_DAI_noBond() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(dai), attestor, "ar://dai", 25);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(dai));
        dai.approve(address(escrow), 100e18);
        escrow.fund();
        vm.stopPrank();

        vm.prank(operator);
        escrow.submitEvidence(0, keccak256("dai-evidence"));

        escrow.submitAttestation(0, keccak256("dai-attest"));

        vm.warp(block.timestamp + 3601);
        escrow.release(0);

        assertEq(uint8(escrow.getMilestone(0).status), 5); // Released
        // Operator started with 10_000 DAI, receives 100 → 10_100 DAI
        assertEq(dai.balanceOf(operator), 10_100e18);
        assertEq(usdc.balanceOf(operator), 10_000e6); // USDC untouched
    }

    function test_fullFlow_DAI_withBond() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(dai), attestor, "ar://dai", 25);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 10e18, 3600, address(dai));
        dai.approve(address(escrow), 100e18);
        escrow.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        dai.approve(address(escrow), 10e18);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("dai-evidence"));
        vm.stopPrank();

        escrow.submitAttestation(0, keccak256("dai-attest"));
        vm.warp(block.timestamp + 3601);
        escrow.release(0);

        // Operator paid 10 bond, received 100 + 10 back → 10_100
        assertEq(dai.balanceOf(operator), 10_100e18);
    }

    // ── Full Flow with USDT (no-return-bool semantics) ──────────────

    function test_fullFlow_USDT_noReturnBool() public {
        // This flow would REVERT in the legacy escrow because transfer/transferFrom
        // return no data and a `require(token.transfer(...))` expects a bool.
        vm.startPrank(payer);
        escrow.allowStablecoin(address(usdt), attestor, "https://tether.to/reports", 100);
        escrow.addMilestoneWithToken(stepId1, operator, 250e6, 25e6, 3600, address(usdt));
        usdt.approve(address(escrow), 250e6);
        escrow.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdt.approve(address(escrow), 25e6);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("usdt-evidence"));
        vm.stopPrank();

        escrow.submitAttestation(0, keccak256("usdt-attest"));
        vm.warp(block.timestamp + 3601);
        escrow.release(0);

        // Operator started 10_000, deposited 25 bond, got 250 + 25 back → 10_250
        assertEq(usdt.balanceOf(operator), 10_250e6);
    }

    // ── Revocation Does Not Affect Existing Milestones ─────────────

    function test_revokeDoesNotInvalidateExistingMilestones() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(dai), attestor, "", 0);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(dai));
        // Now revoke BEFORE funding
        escrow.revokeStablecoin(address(dai));
        // Cannot add NEW milestones in this token
        vm.expectRevert("Token not allowed");
        escrow.addMilestoneWithToken(stepId2, operator, 50e18, 0, 3600, address(dai));

        // ... but the existing milestone still funds + settles
        dai.approve(address(escrow), 100e18);
        escrow.fund();
        vm.stopPrank();

        vm.prank(operator);
        escrow.submitEvidence(0, keccak256("ev"));
        escrow.submitAttestation(0, keccak256("at"));
        vm.warp(block.timestamp + 3601);
        escrow.release(0);

        assertEq(dai.balanceOf(operator), 10_100e18);
    }

    // ── Dispute in Non-Default Token ───────────────────────────────

    function test_dispute_challengerWins_inDAI() public {
        vm.startPrank(payer);
        escrow.allowStablecoin(address(dai), attestor, "", 0);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 10e18, 3600, address(dai));
        dai.approve(address(escrow), 100e18);
        escrow.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        dai.approve(address(escrow), 10e18);
        escrow.depositBond(0);
        escrow.submitEvidence(0, keccak256("ev"));
        vm.stopPrank();
        escrow.submitAttestation(0, keccak256("at"));

        vm.startPrank(challenger);
        dai.approve(address(escrow), 5e18);
        escrow.fileDispute(0, 5e18, keccak256("counter"), "Bad output");
        vm.stopPrank();

        vm.prank(arbiter);
        escrow.resolveDispute(0, true);

        // Payer refunded 100 DAI (had 100_000 - 100 deposit = 99_900, + 100 refund = 100_000)
        assertEq(dai.balanceOf(payer), 100_000e18);
        // Challenger: started 10_000, staked 5, got back 5 + 10 operator bond = 10_010
        assertEq(dai.balanceOf(challenger), 10_010e18);
        // Operator: staked 10 bond, slashed → 10_000 - 10 = 9_990
        assertEq(dai.balanceOf(operator), 9_990e18);
    }

    // ── Protocol Fee Integration (spotcheck) ───────────────────────

    function test_release_feeTakenInMilestoneToken() public {
        // Use a fake protocol root that charges 2% (200 bps)
        FakeProtocol fakeProtocol = new FakeProtocol(200, address(0xFEE));

        MilestoneEscrow feeEscrow = new MilestoneEscrow(
            payer, arbiter, address(usdc), keccak256("with-fee"), address(fakeProtocol)
        );
        fakeProtocol.markProtocolEscrow(address(feeEscrow));

        vm.startPrank(arbiter);
        feeEscrow.addVerifier(address(this));
        vm.stopPrank();

        vm.startPrank(payer);
        feeEscrow.allowStablecoin(address(dai), attestor, "", 0);
        feeEscrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(dai));
        dai.approve(address(feeEscrow), 100e18);
        feeEscrow.fund();
        vm.stopPrank();

        vm.prank(operator);
        feeEscrow.submitEvidence(0, keccak256("ev"));
        feeEscrow.submitAttestation(0, keccak256("at"));
        vm.warp(block.timestamp + 3601);
        feeEscrow.release(0);

        // 2% of 100 = 2 DAI to fee recipient; operator gets 98
        assertEq(dai.balanceOf(address(0xFEE)), 2e18);
        assertEq(dai.balanceOf(operator), 10_098e18);
        // Fee accounting tracks the milestone's token (DAI), not the default (USDC)
        assertEq(fakeProtocol.feesCollectedByToken(address(dai)), 2e18);
        assertEq(fakeProtocol.feesCollectedByToken(address(usdc)), 0);
    }

    // ── Reentrancy Guard ────────────────────────────────────────────

    function test_release_reentrancyGuarded() public {
        ReentrantToken rtoken = new ReentrantToken();
        rtoken.mint(payer, 200e18);

        vm.startPrank(payer);
        escrow.allowStablecoin(address(rtoken), attestor, "", 0);
        escrow.addMilestoneWithToken(stepId1, operator, 100e18, 0, 3600, address(rtoken));
        rtoken.approve(address(escrow), 100e18);
        escrow.fund();
        vm.stopPrank();

        vm.prank(operator);
        escrow.submitEvidence(0, keccak256("ev"));
        escrow.submitAttestation(0, keccak256("at"));
        vm.warp(block.timestamp + 3601);

        // Point the reentrant token at the escrow so it tries to re-enter on `transfer`
        rtoken.setTarget(address(escrow), 0);

        // Release should still succeed (payout goes through), but the reentrancy attempt
        // inside the callback must revert. The outer call still completes because the
        // callback is wrapped in a try/catch inside the malicious token.
        escrow.release(0);

        // Milestone is Released exactly once
        assertEq(uint8(escrow.getMilestone(0).status), 5);
        assertTrue(rtoken.reentrancyAttempted());
        assertTrue(rtoken.reentrancyReverted());
    }
}

// ── Interface shim for vm.expectEmit matching ──────────────────────

interface IStablecoinEvents {
    event StablecoinAllowed(
        address indexed token,
        address indexed attestor,
        string reportUri,
        uint16 maxDeviationBps
    );
    event StablecoinRevoked(address indexed token);
}

// ── Minimal fake PCCProtocol-compatible root for fee tests ────────

contract FakeProtocol {
    uint256 public protocolFeeBps;
    address public feeRecipient;

    mapping(address => uint256) public feesCollectedByToken;
    mapping(address => bool) public isProtocolEscrow;

    constructor(uint256 _feeBps, address _recipient) {
        protocolFeeBps = _feeBps;
        feeRecipient = _recipient;
    }

    function markProtocolEscrow(address escrow_) external {
        isProtocolEscrow[escrow_] = true;
    }

    function collectFee(address token, uint256 fee) external {
        require(isProtocolEscrow[msg.sender], "Not a protocol escrow");
        feesCollectedByToken[token] += fee;
    }
}

// ── Malicious token that attempts reentrancy on transfer ──────────

contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    address public target;
    uint256 public targetMilestone;
    bool public reentrancyAttempted;
    bool public reentrancyReverted;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;

        // Attempt reentrancy ONCE
        if (target != address(0) && !reentrancyAttempted) {
            reentrancyAttempted = true;
            (bool success, ) = target.call(
                abi.encodeWithSignature("release(uint256)", targetMilestone)
            );
            reentrancyReverted = !success;
        }

        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient");
        require(allowance[from][msg.sender] >= amount, "Allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function setTarget(address _target, uint256 _milestone) external {
        target = _target;
        targetMilestone = _milestone;
    }
}
