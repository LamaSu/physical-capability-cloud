// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrowV3.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockEAS.sol";
import {Clones} from "../src/libraries/Clones.sol";

/**
 * @title MilestoneEscrowV3Test
 * @notice Foundry tests for MilestoneEscrowV3 — DRAFT (no deploy).
 *
 * V3 deltas covered:
 *   - fee-from-attestation: oracle attests feeBps=500 + feeRecipient=X;
 *     release() distributes 5% to X, rest to operator.
 *   - fee cap: feeBps > MAX_FEE_BPS (1000) at submitAttestation reverts.
 *   - fee recipient guard: attestedFeeBps > 0 with zero recipient reverts.
 *   - payer-approval Mode A: payer calls approveAndRelease, no oracle, releases.
 *   - non-payer cannot call approveAndRelease.
 *   - approveAndRelease before evidence reverts (must be at least Evidenced).
 *   - approveAndRelease after Released reverts (idempotent).
 *   - C1: same UID twice reverts.
 *   - C2a: recipient != escrow reverts.
 *   - C2b: stepId mismatch reverts.
 *   - zero-fee path: attested feeBps=0, no fee transferred.
 *
 * Style mirrors MilestoneEscrowV2.t.sol.
 *
 * Authored by: implementer-oscar
 */
contract MilestoneEscrowV3Test is Test {
    // ── Events (mirror contract — required by vm.expectEmit) ────────────────
    event AttestationSubmitted(
        uint256 indexed milestoneIndex,
        bytes32 attestationUid,
        uint256 challengeWindowEnd,
        uint16 attestedFeeBps,
        address attestedFeeRecipient
    );
    event MilestoneReleased(uint256 indexed milestoneIndex, address operator, uint256 amount);
    event PayerApprovedRelease(uint256 indexed milestoneIndex, address indexed approvedBy, uint256 amount);

    // ── Actors ───────────────────────────────────────────────────────────────
    address internal payer        = address(0x1);
    address internal operator     = address(0x2);
    address internal arbiter      = address(0x3);
    address internal oracle       = address(0x4);
    address internal feeRecipient = address(0xFEE); // V3 fee recipient (attested)

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_V2_UID = bytes32(uint256(0xBEEF));
    bytes32 internal constant CWM_ID        = keccak256("cwm-v3-001");

    string  internal constant JOB_ID = "job-v3-001";
    bytes32 internal JOB_ID_HASH;
    bytes32 internal STEP_ID;

    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence-bundle-v3-001");

    bytes32 internal constant VALID_UID  = keccak256("eas-uid-v3-001");
    bytes32 internal constant SECOND_UID = keccak256("eas-uid-v3-002");

    uint256 internal constant AMOUNT           = 100e6;
    uint256 internal constant OPERATOR_BOND    = 10e6;
    uint256 internal constant CHALLENGE_WINDOW = 3600;
    uint8   internal constant REQUIRED_TIER    = 1;

    uint16  internal constant ATTESTED_FEE_BPS = 500; // 5%

    // ── Contracts ────────────────────────────────────────────────────────────
    MilestoneEscrowV3 internal escrow;
    MockUSDC          internal usdc;
    MockEAS           internal mockEAS;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.warp(1_000_000);

        JOB_ID_HASH = keccak256(bytes(JOB_ID));
        STEP_ID     = keccak256("step-v3-001");

        usdc    = new MockUSDC(1_000_000e6);
        mockEAS = new MockEAS();

        escrow = _deployEscrow(
            payer,
            arbiter,
            address(usdc),
            CWM_ID,
            address(0),
            address(mockEAS),
            SCHEMA_V2_UID,
            oracle
        );

        usdc.mint(payer,    500_000e6);
        usdc.mint(operator,  50_000e6);

        vm.prank(payer);
        escrow.addMilestone(
            STEP_ID,
            operator,
            AMOUNT,
            OPERATOR_BOND,
            CHALLENGE_WINDOW,
            REQUIRED_TIER,
            JOB_ID
        );

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

    // ── Internal helpers ─────────────────────────────────────────────────────

    /**
     * @dev Build a V3 attestation data blob (9-field pcc.evidence.v2 tuple).
     */
    function _encodeV3Data(
        string memory jobId,
        bytes32 kernelId,
        bytes32 evidenceBundleHash,
        string memory ipfsCid,
        uint8 assuranceTier,
        bool oracleVerified,
        bytes32 stepId,
        uint16 attestedFeeBps,
        address attestedFeeRecipient
    ) internal pure returns (bytes memory) {
        return abi.encode(
            jobId,
            kernelId,
            evidenceBundleHash,
            ipfsCid,
            assuranceTier,
            oracleVerified,
            stepId,
            attestedFeeBps,
            attestedFeeRecipient
        );
    }

    /**
     * @dev Build a fully-valid V3 attestation, register it in MockEAS, return it.
     */
    function _buildValidAttestation(bytes32 uid, uint16 _feeBps, address _feeRecipient)
        internal
        returns (EASAttestation memory att)
    {
        bytes memory data = _encodeV3Data(
            JOB_ID,
            keccak256("kernel-001"),
            EVIDENCE_HASH,
            "",
            REQUIRED_TIER,
            true,
            STEP_ID,
            _feeBps,
            _feeRecipient
        );

        att = EASAttestation({
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
        });

        mockEAS.setAttestation(uid, att);
    }

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

    // ── Test 1: Fee-from-attestation happy path ─────────────────────────────

    function test_feeFromAttestation_releasesWithAttestedFee() public {
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);

        // submitAttestation succeeds; expect event with the attested fee fields.
        vm.expectEmit(true, false, false, true, address(escrow));
        emit AttestationSubmitted(0, VALID_UID, block.timestamp + CHALLENGE_WINDOW, ATTESTED_FEE_BPS, feeRecipient);
        escrow.submitAttestation(0, VALID_UID);

        MilestoneEscrowV3.Milestone memory m = escrow.getMilestone(0);
        assertEq(uint8(m.status), 4, "Status should be Attested");
        assertEq(m.attestedFeeBps, ATTESTED_FEE_BPS, "Fee bps stored");
        assertEq(m.attestedFeeRecipient, feeRecipient, "Fee recipient stored");

        // Warp past challenge window and release.
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        uint256 operatorBefore = usdc.balanceOf(operator);
        uint256 feeBefore      = usdc.balanceOf(feeRecipient);

        escrow.release(0);

        MilestoneEscrowV3.Milestone memory m2 = escrow.getMilestone(0);
        assertEq(uint8(m2.status), 5, "Status should be Released");

        // 5% of AMOUNT goes to feeRecipient; operator gets net + bond.
        uint256 expectedFee = (AMOUNT * ATTESTED_FEE_BPS) / 10000;
        assertEq(usdc.balanceOf(feeRecipient) - feeBefore, expectedFee, "Fee recipient paid");
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            AMOUNT - expectedFee + OPERATOR_BOND,
            "Operator paid net + bond"
        );
    }

    // ── Test 2: Fee cap — feeBps > MAX_FEE_BPS at submit reverts ────────────

    function test_revert_feeBpsExceedsCap() public {
        // MAX_FEE_BPS = 1000. Attest with 2000 (20%) — must revert at submit.
        _buildValidAttestation(VALID_UID, 2000, feeRecipient);

        vm.expectRevert("Fee exceeds MAX_FEE_BPS");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 3: Zero feeRecipient with non-zero feeBps reverts ──────────────

    function test_revert_nonZeroFeeBpsWithZeroRecipient() public {
        // feeBps > 0 must come with a non-zero recipient.
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, address(0));

        vm.expectRevert("Zero fee recipient");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 4: Zero fee path — feeBps = 0, no fee transferred ──────────────

    function test_zeroFee_operatorGetsFullAmount() public {
        // Zero fee — attestation with feeBps=0 and any recipient (allowed).
        _buildValidAttestation(VALID_UID, 0, address(0));

        escrow.submitAttestation(0, VALID_UID);

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        uint256 operatorBefore = usdc.balanceOf(operator);

        escrow.release(0);

        // No fee. Operator gets AMOUNT + OPERATOR_BOND.
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            AMOUNT + OPERATOR_BOND,
            "Operator gets full amount with no fee"
        );
    }

    // ── Test 5: Mode A — payer approveAndRelease, no oracle ─────────────────

    function test_payerApprovalRelease_byBuyer() public {
        // Milestone is Evidenced after setUp.
        uint256 operatorBefore = usdc.balanceOf(operator);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit PayerApprovedRelease(0, payer, AMOUNT);

        vm.prank(payer);
        escrow.approveAndRelease(0);

        MilestoneEscrowV3.Milestone memory m = escrow.getMilestone(0);
        assertEq(uint8(m.status), 5, "Status should be Released");

        // No fee in Mode A. Operator gets AMOUNT + OPERATOR_BOND.
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            AMOUNT + OPERATOR_BOND,
            "Operator paid full amount (no fee in Mode A)"
        );
    }

    // ── Test 6: Mode A — non-payer cannot call approveAndRelease ────────────

    function test_revert_payerApprovalByNonBuyer() public {
        vm.expectRevert("Only payer");
        vm.prank(operator);
        escrow.approveAndRelease(0);

        vm.expectRevert("Only payer");
        vm.prank(arbiter);
        escrow.approveAndRelease(0);

        vm.expectRevert("Only payer");
        vm.prank(address(0xDEAD));
        escrow.approveAndRelease(0);
    }

    // ── Test 7: Mode A — payer cannot approve before Evidenced ──────────────

    function test_revert_payerApprovalBeforeEvidence() public {
        // Fresh escrow, milestone funded + locked but NOT evidenced.
        MockUSDC usdc2    = new MockUSDC(1_000_000e6);
        MockEAS  mockEAS2 = new MockEAS();
        MilestoneEscrowV3 escrow2 = _deployEscrow(
            payer, arbiter, address(usdc2), CWM_ID, address(0),
            address(mockEAS2), SCHEMA_V2_UID, oracle
        );
        usdc2.mint(payer,    500_000e6);
        usdc2.mint(operator,  50_000e6);

        vm.prank(payer);
        escrow2.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);

        vm.startPrank(payer);
        usdc2.approve(address(escrow2), AMOUNT);
        escrow2.fund();
        vm.stopPrank();

        // Bond deposited, status = Locked. NO submitEvidence yet.
        vm.startPrank(operator);
        usdc2.approve(address(escrow2), OPERATOR_BOND);
        escrow2.depositBond(0);
        vm.stopPrank();

        vm.expectRevert("Not approvable");
        vm.prank(payer);
        escrow2.approveAndRelease(0);
    }

    // ── Test 8: Mode A — idempotent (cannot approve twice) ──────────────────

    function test_revert_payerApprovalTwice() public {
        vm.prank(payer);
        escrow.approveAndRelease(0);

        vm.expectRevert("Not approvable");
        vm.prank(payer);
        escrow.approveAndRelease(0);
    }

    // ── Test 9: Mode A — payer can short-circuit during challenge window ────

    function test_payerApprovalDuringChallengeWindow() public {
        // Run Mode B up to Attested, then payer signs off during the window.
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        escrow.submitAttestation(0, VALID_UID);

        MilestoneEscrowV3.Milestone memory mAttested = escrow.getMilestone(0);
        assertEq(uint8(mAttested.status), 4, "Status should be Attested");

        // Buyer can early-release during challenge window.
        // Mode A has no fee — even though attestation set one, Mode A path skips it.
        uint256 operatorBefore = usdc.balanceOf(operator);
        uint256 feeBefore      = usdc.balanceOf(feeRecipient);

        vm.prank(payer);
        escrow.approveAndRelease(0);

        // Operator gets full amount + bond. No fee taken (Mode A).
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            AMOUNT + OPERATOR_BOND,
            "Operator paid full (Mode A skips fee even when attested)"
        );
        assertEq(
            usdc.balanceOf(feeRecipient) - feeBefore,
            0,
            "Fee recipient receives nothing in Mode A"
        );
    }

    // ── Test 10: C1 replay guard — same UID twice reverts ───────────────────

    function test_revert_uidReplay_C1() public {
        bytes32 stepId2 = keccak256("step-v3-002");

        MockUSDC usdc2    = new MockUSDC(1_000_000e6);
        MockEAS  mockEAS2 = new MockEAS();
        MilestoneEscrowV3 escrow2 = _deployEscrow(
            payer, arbiter, address(usdc2), CWM_ID, address(0),
            address(mockEAS2), SCHEMA_V2_UID, oracle
        );

        usdc2.mint(payer,    500_000e6);
        usdc2.mint(operator,  50_000e6);

        vm.startPrank(payer);
        escrow2.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        escrow2.addMilestone(stepId2, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, "job-v3-002");
        usdc2.approve(address(escrow2), AMOUNT * 2);
        escrow2.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdc2.approve(address(escrow2), OPERATOR_BOND * 2);
        escrow2.depositBond(0);
        escrow2.submitEvidence(0, EVIDENCE_HASH);
        escrow2.depositBond(1);
        escrow2.submitEvidence(1, EVIDENCE_HASH);
        vm.stopPrank();

        // Build a valid attestation for milestone 0 (recipient = escrow2).
        bytes memory data0 = _encodeV3Data(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "",
            REQUIRED_TIER, true, STEP_ID, ATTESTED_FEE_BPS, feeRecipient
        );
        mockEAS2.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_V2_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow2),
            attester:       oracle,
            revocable:      true,
            data:           data0
        }));

        // First submit succeeds.
        escrow2.submitAttestation(0, VALID_UID);
        assertTrue(escrow2.attestationUsed(VALID_UID), "UID marked used");

        // Second submit of same UID to milestone 1 reverts (C1).
        vm.expectRevert("Attestation already used");
        escrow2.submitAttestation(1, VALID_UID);
    }

    // ── Test 11: C2a recipient guard — recipient != escrow reverts ──────────

    function test_revert_wrongRecipient_C2a() public {
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        // Override recipient to a random address.
        mockEAS.setRecipient(VALID_UID, address(0xDEAD));

        vm.expectRevert("Wrong recipient");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 12: C2b stepId guard — stepId mismatch reverts ────────────────

    function test_revert_stepIdMismatch_C2b() public {
        bytes32 wrongStepId = keccak256("step-wrong-999");
        bytes memory data = _encodeV3Data(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "",
            REQUIRED_TIER, true, wrongStepId, ATTESTED_FEE_BPS, feeRecipient
        );
        mockEAS.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
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

        vm.expectRevert("stepId mismatch");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 13: Wrong schema UID reverts (V1 schema not accepted) ──────────

    function test_revert_wrongSchema() public {
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        // Use V1 schema UID instead — V3 only accepts V2.
        mockEAS.setSchema(VALID_UID, bytes32(uint256(0xDEAD)));

        vm.expectRevert("Wrong schema");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 14: Boundary — feeBps == MAX_FEE_BPS (1000) accepted ───────────

    function test_feeBpsAtCap_isAccepted() public {
        // Exactly at cap (1000 bps = 10%) — must NOT revert.
        _buildValidAttestation(VALID_UID, 1000, feeRecipient);

        escrow.submitAttestation(0, VALID_UID);

        MilestoneEscrowV3.Milestone memory m = escrow.getMilestone(0);
        assertEq(m.attestedFeeBps, 1000, "Fee at cap accepted");
    }

    // ── Test 15: H1 — zero schema UID at construction reverts ───────────────

    function test_revert_zeroSchemaUidConstructor() public {
        MockEAS mEAS = new MockEAS();
        vm.expectRevert("Schema UID unset");
        new MilestoneEscrowV3(address(mEAS), bytes32(0), oracle);
    }

    // ── Test 16: Mode C — dispute mechanism still works ─────────────────────

    function test_dispute_modeC() public {
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        escrow.submitAttestation(0, VALID_UID);

        // Operator gets challenger bond from somewhere — mint a small balance.
        address challenger = address(0xC1);
        usdc.mint(challenger, 50e6);

        uint256 challengerBond = 5e6;
        vm.startPrank(challenger);
        usdc.approve(address(escrow), challengerBond);
        escrow.fileDispute(0, challengerBond, keccak256("challenger-evidence"), "bad output");
        vm.stopPrank();

        MilestoneEscrowV3.Milestone memory m = escrow.getMilestone(0);
        assertEq(uint8(m.status), 6, "Status should be Disputed");

        // Arbiter resolves in operator's favor.
        vm.prank(arbiter);
        escrow.resolveDispute(0, false);

        MilestoneEscrowV3.Milestone memory m2 = escrow.getMilestone(0);
        assertEq(uint8(m2.status), 5, "Status should be Released after dispute");

        // Operator receives milestoneAmount + operatorBond + challengerBond.
        // (We don't check exact balance here — the V2-inherited dispute path is
        // covered by V2 tests; we only assert the path WORKS and ends Released.)
    }

    // ═══ Mode D — reclaimAfterDeadline (locked-funds-gap fix) ════════════════

    event MilestoneRefunded(uint256 indexed milestoneIndex, uint256 amount);

    /// @dev Deploy + fund a fresh single-milestone escrow, stopping at a chosen
    ///      pre-settlement stage. bond>0 + depositBond_=false => Funded; +deposit => Locked;
    ///      +submitEvidence_ => Evidenced.
    function _freshFundedEscrow(uint256 bond, bool depositBond_, bool submitEvidence_)
        internal
        returns (MilestoneEscrowV3 esc, MockUSDC tok)
    {
        tok = new MockUSDC(1_000_000e6);
        MockEAS eas2 = new MockEAS();
        esc = _deployEscrow(payer, arbiter, address(tok), CWM_ID, address(0), address(eas2), SCHEMA_V2_UID, oracle);
        tok.mint(payer, 500_000e6);
        tok.mint(operator, 50_000e6);

        vm.prank(payer);
        esc.addMilestone(STEP_ID, operator, AMOUNT, bond, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);

        vm.startPrank(payer);
        tok.approve(address(esc), AMOUNT);
        esc.fund();
        vm.stopPrank();

        if (depositBond_ && bond > 0) {
            vm.startPrank(operator);
            tok.approve(address(esc), bond);
            esc.depositBond(0);
            vm.stopPrank();
        }
        if (submitEvidence_) {
            vm.prank(operator);
            esc.submitEvidence(0, EVIDENCE_HASH);
        }
    }

    function _warpPastDeadline(MilestoneEscrowV3 esc) internal {
        vm.warp(esc.fundedAt() + esc.DEFAULT_RECLAIM_DEADLINE() + 1);
    }

    // D1: reclaim at Evidenced (bond posted in setUp) → payer gets amount, operator gets bond.
    function test_reclaim_atEvidenced_refundsPayerAndBond() public {
        uint256 payerBefore    = usdc.balanceOf(payer);
        uint256 operatorBefore = usdc.balanceOf(operator);

        _warpPastDeadline(escrow);

        vm.expectEmit(true, false, false, true, address(escrow));
        emit MilestoneRefunded(0, AMOUNT);
        vm.prank(payer);
        escrow.reclaimAfterDeadline(0);

        assertEq(uint8(escrow.getMilestone(0).status), 7, "Status should be Refunded");
        assertEq(usdc.balanceOf(payer) - payerBefore, AMOUNT, "Payer refunded amount");
        assertEq(usdc.balanceOf(operator) - operatorBefore, OPERATOR_BOND, "Operator bond returned");
    }

    // D2: reclaim at Funded (no bond deposited) → payer gets amount, operator gets nothing.
    function test_reclaim_atFunded_refundsPayerOnly() public {
        (MilestoneEscrowV3 esc, MockUSDC tok) = _freshFundedEscrow(OPERATOR_BOND, false, false);
        uint256 payerBefore    = tok.balanceOf(payer);
        uint256 operatorBefore = tok.balanceOf(operator);

        _warpPastDeadline(esc);
        vm.prank(payer);
        esc.reclaimAfterDeadline(0);

        assertEq(uint8(esc.getMilestone(0).status), 7, "Refunded");
        assertEq(tok.balanceOf(payer) - payerBefore, AMOUNT, "Payer refunded amount");
        assertEq(tok.balanceOf(operator) - operatorBefore, 0, "Operator gets nothing (no bond posted)");
    }

    // D3: reclaim at Locked (bond deposited, no evidence) → payer amount, operator bond.
    function test_reclaim_atLocked_refundsPayerAndBond() public {
        (MilestoneEscrowV3 esc, MockUSDC tok) = _freshFundedEscrow(OPERATOR_BOND, true, false);
        uint256 payerBefore    = tok.balanceOf(payer);
        uint256 operatorBefore = tok.balanceOf(operator);

        _warpPastDeadline(esc);
        vm.prank(payer);
        esc.reclaimAfterDeadline(0);

        assertEq(uint8(esc.getMilestone(0).status), 7, "Refunded");
        assertEq(tok.balanceOf(payer) - payerBefore, AMOUNT, "Payer refunded amount");
        assertEq(tok.balanceOf(operator) - operatorBefore, OPERATOR_BOND, "Operator bond returned");
    }

    // D4: reclaim before the deadline reverts.
    function test_revert_reclaimBeforeDeadline() public {
        vm.prank(payer);
        vm.expectRevert("Deadline not reached");
        escrow.reclaimAfterDeadline(0);
    }

    // D5: an Attested milestone can NEVER be clawed back (operator earned it).
    function test_revert_reclaimAttested() public {
        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        escrow.submitAttestation(0, VALID_UID); // → Attested

        _warpPastDeadline(escrow);
        vm.prank(payer);
        vm.expectRevert("Not reclaimable");
        escrow.reclaimAfterDeadline(0);
    }

    // D6: a Released milestone is not reclaimable.
    function test_revert_reclaimReleased() public {
        vm.prank(payer);
        escrow.approveAndRelease(0); // Mode A → Released

        _warpPastDeadline(escrow);
        vm.prank(payer);
        vm.expectRevert("Not reclaimable");
        escrow.reclaimAfterDeadline(0);
    }

    // D7: only the payer may reclaim.
    function test_revert_reclaimByNonPayer() public {
        _warpPastDeadline(escrow);

        vm.prank(operator);
        vm.expectRevert("Only payer");
        escrow.reclaimAfterDeadline(0);

        vm.prank(arbiter);
        vm.expectRevert("Only payer");
        escrow.reclaimAfterDeadline(0);

        vm.prank(address(0xDEAD));
        vm.expectRevert("Only payer");
        escrow.reclaimAfterDeadline(0);
    }

    // D8: idempotent — a second reclaim reverts (Refunded is terminal).
    function test_revert_reclaimTwice() public {
        _warpPastDeadline(escrow);
        vm.prank(payer);
        escrow.reclaimAfterDeadline(0);

        vm.prank(payer);
        vm.expectRevert("Not reclaimable");
        escrow.reclaimAfterDeadline(0);
    }

    // D9: payer-set custom (shorter) deadline takes effect.
    function test_reclaim_customDeadline() public {
        MockUSDC tok = new MockUSDC(1_000_000e6);
        MockEAS eas2 = new MockEAS();
        MilestoneEscrowV3 esc = _deployEscrow(payer, arbiter, address(tok), CWM_ID, address(0), address(eas2), SCHEMA_V2_UID, oracle);
        tok.mint(payer, 500_000e6);

        vm.startPrank(payer);
        esc.addMilestone(STEP_ID, operator, AMOUNT, 0, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        esc.setReclaimDeadline(1 hours);
        tok.approve(address(esc), AMOUNT);
        esc.fund();
        vm.stopPrank();

        // Before the custom 1h window → revert.
        vm.warp(esc.fundedAt() + 1 hours - 1);
        vm.prank(payer);
        vm.expectRevert("Deadline not reached");
        esc.reclaimAfterDeadline(0);

        // After it → succeeds (well before the 30-day default).
        vm.warp(esc.fundedAt() + 1 hours + 1);
        uint256 payerBefore = tok.balanceOf(payer);
        vm.prank(payer);
        esc.reclaimAfterDeadline(0);
        assertEq(tok.balanceOf(payer) - payerBefore, AMOUNT, "Payer refunded after custom deadline");
    }

    // D10: reclaim-first blocks a later oracle attestation (race safety).
    function test_reclaimThenAttestationReverts() public {
        _warpPastDeadline(escrow);
        vm.prank(payer);
        escrow.reclaimAfterDeadline(0); // → Refunded

        _buildValidAttestation(VALID_UID, ATTESTED_FEE_BPS, feeRecipient);
        vm.expectRevert("Evidence not submitted");
        escrow.submitAttestation(0, VALID_UID);
    }

    // D11: setReclaimDeadline after funding reverts.
    function test_revert_setReclaimDeadlineAfterFunded() public {
        vm.prank(payer);
        vm.expectRevert("Already funded");
        escrow.setReclaimDeadline(1 hours);
    }
}
