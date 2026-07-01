// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrowV3.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockEAS.sol";
import {Clones} from "../src/libraries/Clones.sol";
import {IEAS, EASAttestation} from "../src/interfaces/IEAS.sol";

/**
 * @title MilestoneEscrowV3HardeningTest
 * @notice Hardening tests for MilestoneEscrowV3 — the two follow-ups #139 deferred and the
 *         escrow-V3 verify run flagged. Both lock in invariants the base suite
 *         (MilestoneEscrowV3.t.sol) leaves implicit:
 *
 *   (a) MODE-A × PAYOUT MAP. `approveAndRelease` (Mode A) is documented to IGNORE any payout
 *       map and pay the operator in full — but that bypass was untested. If a future edit
 *       accidentally routed Mode A through the split (or a split through Mode A), the buyer's
 *       direct-settlement threat model would silently break. These tests assert: even when a
 *       payout map IS set on the milestone, Mode A pays the WHOLE amount+bond to the operator,
 *       the split recipients receive NOTHING, and no SplitPayoutExecuted event fires.
 *
 *   (b) CROSS-MODE DOUBLE-RELEASE GUARD. A milestone settles through exactly one of Mode A
 *       (payer approval), Mode B (oracle attest → release), or Mode C (dispute). Once it
 *       reaches Released, NO other mode may pay again. These tests drive every cross-mode
 *       ordering and assert the second mode reverts and moves no funds:
 *         - Mode A then Mode B: after approveAndRelease, submitAttestation reverts.
 *         - Mode B then Mode A: after attest→release, approveAndRelease reverts.
 *         - Mode B attested, Mode A during window, then Mode B release: the late release()
 *           reverts "Not attested" and the operator is NOT paid twice. (This overlap — Mode A
 *           is permitted on an Attested milestone — is the sharpest double-pay risk.)
 *
 * Escrows are standalone clones (protocolRoot == address(0)); the factory path is covered by
 * PCCProtocolV3.t.sol. Style mirrors MilestoneEscrowV3.t.sol.
 *
 * Authored by: implementer (sgo/v3factory)
 */
contract MilestoneEscrowV3HardeningTest is Test {
    // ── Events (mirror contract — required by vm.expectEmit) ────────────────
    event PayerApprovedRelease(uint256 indexed milestoneIndex, address indexed approvedBy, uint256 amount);
    event MilestoneReleased(uint256 indexed milestoneIndex, address operator, uint256 amount);
    event SplitPayoutExecuted(
        uint256 indexed milestoneIndex,
        address indexed recipient,
        bytes32 indexed roleTag,
        bytes32 ipId,
        address token,
        uint256 amount
    );

    // ── Actors ───────────────────────────────────────────────────────────────
    address internal payer        = address(0x1);
    address internal operator     = address(0x2);
    address internal arbiter      = address(0x3);
    address internal oracle       = address(0x4);
    address internal feeRecipient = address(0xFEE); // attested fee recipient (Mode B)
    address internal splitA       = address(0x5A);  // payout-map recipient A
    address internal splitB       = address(0x5B);  // payout-map recipient B

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_V2_UID = bytes32(uint256(0xBEEF));
    bytes32 internal constant CWM_ID        = keccak256("cwm-v3-harden-001");

    string  internal constant JOB_ID = "job-v3-harden-001";
    bytes32 internal STEP_ID;
    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence-bundle-v3-harden-001");

    bytes32 internal constant VALID_UID = keccak256("eas-uid-v3-harden-001");

    uint256 internal constant AMOUNT           = 100e6;
    uint256 internal constant OPERATOR_BOND    = 10e6;
    uint256 internal constant CHALLENGE_WINDOW = 3600;
    uint8   internal constant REQUIRED_TIER    = 1;
    uint16  internal constant ATTESTED_FEE_BPS = 500; // 5%

    // payout-map split: 30% + 20% = 50% of the milestone (each <= MAX_SINGLE_BPS).
    uint256 internal constant SPLIT_A_BPS = 3000;
    uint256 internal constant SPLIT_B_BPS = 2000;

    // ── Contracts ────────────────────────────────────────────────────────────
    MilestoneEscrowV3 internal escrow;
    MockUSDC          internal usdc;
    MockEAS           internal mockEAS;

    // ── Setup: deploy + add ONE milestone, but do NOT fund yet ──────────────
    // (Funding is deferred so the Mode-A×payout-map test can call setPayoutMap, which
    //  requires the milestone to still be Unfunded.)

    function setUp() public {
        vm.warp(1_000_000);
        STEP_ID = keccak256("step-v3-harden-001");

        usdc    = new MockUSDC(1_000_000e6);
        mockEAS = new MockEAS();

        escrow = _deployEscrow(payer, arbiter, address(usdc), CWM_ID, address(0), address(mockEAS), SCHEMA_V2_UID, oracle);

        usdc.mint(payer,    500_000e6);
        usdc.mint(operator,  50_000e6);

        vm.prank(payer);
        escrow.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    function _deployEscrow(
        address _payer,
        address _arbiter,
        address _token,
        bytes32 _cwmId,
        address _protocolRoot,
        address _eas_,
        bytes32 _schemaUid,
        address _oracle
    ) internal returns (MilestoneEscrowV3 esc) {
        address impl = address(new MilestoneEscrowV3(_eas_, _schemaUid, _oracle));
        esc = MilestoneEscrowV3(Clones.clone(impl));
        esc.initialize(_payer, _arbiter, _token, _cwmId, _protocolRoot);
    }

    /// @dev Fund the escrow, deposit the operator bond, and submit evidence → Evidenced.
    function _fundBondEvidence() internal {
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

    /// @dev Register a fully-valid V3 attestation for milestone 0 (recipient = escrow).
    function _buildValidAttestation(bytes32 uid, uint16 feeBps, address feeTo) internal {
        bytes memory data = abi.encode(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "",
            REQUIRED_TIER, true, STEP_ID, feeBps, feeTo
        );
        mockEAS.setAttestation(uid, EASAttestation({
            uid:            uid,
            schema:         SCHEMA_V2_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow),
            attester:       oracle,
            revocable:      true,
            data:           data
        }));
    }

    /// @dev Set a 30%/20% two-recipient payout map on milestone 0 (must be Unfunded).
    function _setSplitPayoutMap() internal {
        MilestoneEscrowV3.Payout[] memory payouts = new MilestoneEscrowV3.Payout[](2);
        payouts[0] = MilestoneEscrowV3.Payout({
            recipient: splitA, bps: SPLIT_A_BPS, roleTag: bytes32("designer"), ipId: bytes32(0)
        });
        payouts[1] = MilestoneEscrowV3.Payout({
            recipient: splitB, bps: SPLIT_B_BPS, roleTag: bytes32("printer"), ipId: bytes32(0)
        });
        vm.prank(payer);
        escrow.setPayoutMap(0, payouts);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // (a) Mode A × payout map — Mode A must bypass the split entirely
    // ─────────────────────────────────────────────────────────────────────────

    function test_modeA_withPayoutMapSet_bypassesSplit_paysOperatorInFull() public {
        // A payout map IS set on the milestone...
        _setSplitPayoutMap();
        assertTrue(escrow.payoutMapSet(0), "payout map must be set for this test");

        _fundBondEvidence();

        uint256 operatorBefore = usdc.balanceOf(operator);
        uint256 splitABefore   = usdc.balanceOf(splitA);
        uint256 splitBBefore   = usdc.balanceOf(splitB);

        // Mode A: payer signs off. Must NOT fire any SplitPayoutExecuted (split is bypassed).
        // expectEmit the PayerApprovedRelease so we also assert the Mode-A event path is taken.
        vm.expectEmit(true, true, false, true, address(escrow));
        emit PayerApprovedRelease(0, payer, AMOUNT);

        vm.prank(payer);
        escrow.approveAndRelease(0);

        // Operator received the WHOLE amount + bond — the split map was ignored.
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            AMOUNT + OPERATOR_BOND,
            "Mode A must pay operator the full amount + bond, ignoring the payout map"
        );
        // Split recipients received NOTHING.
        assertEq(usdc.balanceOf(splitA) - splitABefore, 0, "split recipient A must receive nothing in Mode A");
        assertEq(usdc.balanceOf(splitB) - splitBBefore, 0, "split recipient B must receive nothing in Mode A");

        // Milestone Released; the map remains set (Mode A does not clear it) but was not used.
        assertEq(uint8(escrow.getMilestone(0).status), 5, "milestone Released");
        assertTrue(escrow.payoutMapSet(0), "payout map flag remains set (unused)");

        // Escrow fully drained — nothing stranded by the bypass.
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow fully drained after Mode A");
    }

    function test_modeA_withPayoutMapSet_emitsNoSplitPayoutEvent() public {
        // Tighter guard: record logs and assert ZERO SplitPayoutExecuted events fire in Mode A,
        // even with a populated payout map.
        _setSplitPayoutMap();
        _fundBondEvidence();

        vm.recordLogs();
        vm.prank(payer);
        escrow.approveAndRelease(0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 splitSig = keccak256("SplitPayoutExecuted(uint256,address,bytes32,bytes32,address,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics[0] != splitSig, "Mode A must not emit SplitPayoutExecuted");
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // (b) Cross-mode double-release guard
    // ─────────────────────────────────────────────────────────────────────────

    // Mode A first → Mode B (submitAttestation) must revert and pay nothing more.
    function test_crossMode_modeAThenModeB_noDoublePay() public {
        _fundBondEvidence();

        // Mode A settles the milestone.
        vm.prank(payer);
        escrow.approveAndRelease(0);
        assertEq(uint8(escrow.getMilestone(0).status), 5, "Released via Mode A");

        uint256 operatorAfterA = usdc.balanceOf(operator);
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained by Mode A");

        // Mode B cannot even start: status is Released, not Evidenced.
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        vm.expectRevert("Evidence not submitted");
        escrow.submitAttestation(0, VALID_UID);

        // No second payout, escrow still empty.
        assertEq(usdc.balanceOf(operator), operatorAfterA, "operator not paid twice");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow remains drained");
    }

    // Mode B first (attest → release) → Mode A (approveAndRelease) must revert.
    function test_crossMode_modeBThenModeA_noDoublePay() public {
        _fundBondEvidence();

        // Mode B: attest, warp past challenge window, release.
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        escrow.submitAttestation(0, VALID_UID);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        escrow.release(0);
        assertEq(uint8(escrow.getMilestone(0).status), 5, "Released via Mode B");

        uint256 operatorAfterB = usdc.balanceOf(operator);
        uint256 feeAfterB      = usdc.balanceOf(feeRecipient);
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained by Mode B");

        // Mode A now reverts: status is Released, not Evidenced/Attested.
        vm.expectRevert("Not approvable");
        vm.prank(payer);
        escrow.approveAndRelease(0);

        // No second payout to operator or fee recipient.
        assertEq(usdc.balanceOf(operator), operatorAfterB, "operator not paid twice");
        assertEq(usdc.balanceOf(feeRecipient), feeAfterB, "fee recipient not paid twice");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow remains drained");
    }

    // The sharp overlap: Attested milestone, Mode A releases during the window, then the
    // late Mode B release() must revert and NOT double-pay the operator.
    function test_crossMode_attestedThenModeA_lateReleaseReverts_noDoublePay() public {
        _fundBondEvidence();

        // Mode B up to Attested (fee attested), still inside the challenge window.
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        escrow.submitAttestation(0, VALID_UID);
        assertEq(uint8(escrow.getMilestone(0).status), 4, "Attested");

        // Mode A is permitted on an Attested milestone — payer short-circuits during the window.
        // Mode A takes NO fee even though one was attested.
        uint256 operatorBefore = usdc.balanceOf(operator);
        vm.prank(payer);
        escrow.approveAndRelease(0);
        assertEq(uint8(escrow.getMilestone(0).status), 5, "Released via Mode A during window");

        uint256 operatorAfterA = usdc.balanceOf(operator);
        assertEq(operatorAfterA - operatorBefore, AMOUNT + OPERATOR_BOND, "operator paid full amount+bond in Mode A (no fee)");
        assertEq(usdc.balanceOf(feeRecipient), 0, "no fee taken in Mode A");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow drained by Mode A");

        // The Mode-B release() is now stale: warp past the window and attempt it.
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        vm.expectRevert("Not attested");
        escrow.release(0);

        // Operator and fee recipient unchanged — no double pay.
        assertEq(usdc.balanceOf(operator), operatorAfterA, "operator not paid twice by stale release()");
        assertEq(usdc.balanceOf(feeRecipient), 0, "fee recipient still unpaid");
        assertEq(usdc.balanceOf(address(escrow)), 0, "escrow remains drained");
    }
}
