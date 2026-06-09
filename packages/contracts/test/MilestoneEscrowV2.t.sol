// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrowV2.sol";
import "../src/MockUSDC.sol";
import {Clones} from "../src/libraries/Clones.sol";
import "./mocks/MockEAS.sol";

/**
 * @title MilestoneEscrowV2Test
 * @notice Foundry tests for MilestoneEscrowV2's EAS-gated submitAttestation AND the
 *         EIP-1167 clone/initialize fault-isolation refactor.
 *
 * EAS-gating cases (ported from the pre-clone suite — behaviour UNCHANGED):
 *   1  test_happyPath_releasesOnValidAttestation        — full valid flow, status Released
 *   2  test_revert_wrongAttester                        — attester != oracle
 *   3  test_revert_wrongSchema                          — schema != PCC_EVIDENCE_SCHEMA_UID
 *   4  test_revert_revoked                              — revocationTime != 0
 *   5  test_revert_expired                              — expirationTime in the past
 *   6  test_revert_unknownUid                           — zero struct (uid never set)
 *   7  test_revert_oracleVerifiedFalse                  — data oracleVerified == false
 *   8  test_revert_tierTooLow                           — data assuranceTier < requiredTier
 *   9  test_revert_jobIdMismatch                        — data jobId != milestone jobId
 *  10  test_revert_evidenceMismatch                     — data evidenceBundleHash mismatch
 *  11  test_revert_uidReplay (C1)                       — same UID used twice → revert
 *  12  test_revert_wrongRecipient (C2a)                 — attestation.recipient != address(escrow)
 *  13  test_revert_stepIdMismatch (C2b)                 — data stepId != m.stepId
 *  14  test_revert_invalidTier (L4)                     — addMilestone with requiredTier > 3
 *      test_revert_zeroSchemaUidConstructor (H1)        — impl constructor with schemaUid == 0
 *      test_revert_evidenceNotSubmitted                 — submitAttestation before submitEvidence
 *
 * Clone / fault-isolation cases (NEW — the hard requirement):
 *      test_isolation_exploitOnAcannotTouchB            — drain/early-release attempt on A
 *                                                         leaves B's balance + state untouched
 *      test_revert_doubleInitialize                     — second initialize() on a clone reverts
 *      test_revert_initializeImplementationDirectly     — initialize() on the locked impl reverts
 *      test_clone_hasOwnAddress_recipientBindingHolds   — two clones have distinct addresses;
 *                                                         an attestation bound to cloneA is
 *                                                         rejected by cloneB ("Wrong recipient")
 *
 * Authored by: test-writer-echo; clone refactor by implementer-india.
 */
contract MilestoneEscrowV2Test is Test {
    // ── Events (mirror contract — required by vm.expectEmit) ────────────────
    event AttestationSubmitted(uint256 indexed milestoneIndex, bytes32 attestationUid, uint256 challengeWindowEnd);
    event MilestoneReleased(uint256 indexed milestoneIndex, address operator, uint256 amount);

    // ── Actors ───────────────────────────────────────────────────────────────
    address internal payer    = address(0x1);
    address internal operator = address(0x2);
    address internal arbiter  = address(0x3);
    address internal oracle   = address(0x4); // authorizedOracle / EAS attester

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_UID = bytes32(uint256(0xDEAD));
    bytes32 internal constant CWM_ID     = keccak256("cwm-v2-001");

    // The milestone's job id and its keccak256 hash (bound at addMilestone)
    string  internal constant JOB_ID     = "job-v2-001";
    bytes32 internal JOB_ID_HASH;   // set in setUp

    // The milestone's step id bytes32 (bound at addMilestone as _stepId param)
    bytes32 internal STEP_ID;        // keccak256("step-v2-001"), set in setUp

    // Evidence bound by submitEvidence
    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence-bundle-001");

    // An arbitrary non-zero EAS uid used in most tests
    bytes32 internal constant VALID_UID  = keccak256("eas-uid-001");
    bytes32 internal constant SECOND_UID = keccak256("eas-uid-002");

    // Milestone params
    uint256 internal constant AMOUNT           = 100e6;  // 100 USDC
    uint256 internal constant OPERATOR_BOND    = 10e6;   // 10 USDC
    uint256 internal constant CHALLENGE_WINDOW = 3600;   // 1 hour
    uint8   internal constant REQUIRED_TIER    = 1;

    // ── Contracts ────────────────────────────────────────────────────────────
    MilestoneEscrowV2 internal escrowImpl; // shared, locked implementation
    MilestoneEscrowV2 internal escrow;     // an initialized clone
    MockUSDC          internal usdc;
    MockEAS           internal mockEAS;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        // Warp to a realistic timestamp so expiration tests can use a non-zero past value.
        // (Foundry starts at block.timestamp = 1; expiration = 0 means "never expires".)
        vm.warp(1_000_000);

        JOB_ID_HASH = keccak256(bytes(JOB_ID));
        STEP_ID     = keccak256("step-v2-001");

        usdc    = new MockUSDC(1_000_000e6);
        mockEAS = new MockEAS();

        // Deploy the shared implementation (carries EAS wiring as immutables, locked),
        // then clone + initialize a standalone escrow (protocolRoot = 0).
        escrowImpl = _deployImpl(address(mockEAS), SCHEMA_UID, oracle);
        escrow     = _cloneAndInit(escrowImpl, payer, arbiter, address(usdc), CWM_ID, address(0));

        // Distribute tokens
        usdc.mint(payer,     500_000e6);
        usdc.mint(operator,   50_000e6);

        // Add milestone with V2 signature (requiredTier, jobId)
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

        // Fund the escrow
        vm.startPrank(payer);
        usdc.approve(address(escrow), AMOUNT);
        escrow.fund();
        vm.stopPrank();

        // Operator deposits bond, submits evidence
        vm.startPrank(operator);
        usdc.approve(address(escrow), OPERATOR_BOND);
        escrow.depositBond(0);
        escrow.submitEvidence(0, EVIDENCE_HASH);
        vm.stopPrank();
    }

    // ── Deployment helpers (clone/initialize) ─────────────────────────────────

    /// @dev Deploy a locked MilestoneEscrowV2 implementation carrying the EAS wiring.
    function _deployImpl(address eas_, bytes32 schema_, address oracle_)
        internal
        returns (MilestoneEscrowV2 impl)
    {
        impl = new MilestoneEscrowV2(eas_, schema_, oracle_);
    }

    /// @dev Clone `impl` and initialize the clone with per-escrow config. Mirrors the
    ///      old constructor's per-escrow params so ported test bodies barely change.
    function _cloneAndInit(
        MilestoneEscrowV2 impl,
        address payer_,
        address arbiter_,
        address token_,
        bytes32 cwmId_,
        address protocolRoot_
    ) internal returns (MilestoneEscrowV2 clone_) {
        clone_ = MilestoneEscrowV2(Clones.clone(address(impl)));
        clone_.initialize(payer_, arbiter_, token_, cwmId_, protocolRoot_);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /**
     * @dev Build and register a fully-valid EAS attestation in MockEAS.
     *      The caller can override individual fields afterwards to exercise error paths.
     */
    function _buildValidAttestation(bytes32 uid) internal returns (EASAttestation memory att) {
        bytes memory data = mockEAS.encodeData(
            JOB_ID,
            keccak256("kernel-001"),
            EVIDENCE_HASH,
            "",            // ipfsCid — empty, not gated on-chain
            REQUIRED_TIER, // assuranceTier meets required
            true,          // oracleVerified
            STEP_ID        // stepId matches m.stepId
        );

        att = EASAttestation({
            uid:            uid,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,              // never expires
            revocationTime: 0,              // not revoked
            refUID:         bytes32(0),
            recipient:      address(escrow), // C2a: recipient == this escrow
            attester:       oracle,          // authorizedOracle
            revocable:      true,
            data:           data
        });

        mockEAS.setAttestation(uid, att);
    }

    // ── Test 1: Happy path ───────────────────────────────────────────────────

    function test_happyPath_releasesOnValidAttestation() public {
        _buildValidAttestation(VALID_UID);

        // Check attestation is not yet used
        assertFalse(escrow.attestationUsed(VALID_UID));

        // submitAttestation should succeed and transition to Attested
        escrow.submitAttestation(0, VALID_UID);

        MilestoneEscrowV2.Milestone memory m = escrow.getMilestone(0);
        assertEq(uint8(m.status), 4, "Status should be Attested (4)");
        assertEq(m.verifierAttestationUid, VALID_UID, "UID stored");
        assertEq(m.verifierAttestationHash, EVIDENCE_HASH, "Back-compat hash set");
        assertTrue(escrow.attestationUsed(VALID_UID), "UID marked used");

        // Warp past challenge window and release
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        uint256 operatorBefore = usdc.balanceOf(operator);
        escrow.release(0);

        MilestoneEscrowV2.Milestone memory m2 = escrow.getMilestone(0);
        assertEq(uint8(m2.status), 5, "Status should be Released (5)");

        // Operator receives AMOUNT + OPERATOR_BOND (no protocol root fee)
        uint256 operatorAfter = usdc.balanceOf(operator);
        assertEq(operatorAfter - operatorBefore, AMOUNT + OPERATOR_BOND, "Operator payout");
    }

    // ── Test 2: Wrong attester ───────────────────────────────────────────────

    function test_revert_wrongAttester() public {
        _buildValidAttestation(VALID_UID);
        // Override attester to a random address
        mockEAS.setAttester(VALID_UID, address(0xBAD));

        vm.expectRevert("Wrong attester");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 3: Wrong schema ─────────────────────────────────────────────────

    function test_revert_wrongSchema() public {
        _buildValidAttestation(VALID_UID);
        // Override schema to a wrong uid
        mockEAS.setSchema(VALID_UID, bytes32(uint256(1)));

        vm.expectRevert("Wrong schema");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 4: Revoked attestation ──────────────────────────────────────────

    function test_revert_revoked() public {
        _buildValidAttestation(VALID_UID);
        // Set revocationTime to a non-zero value → revoked (any non-zero value triggers the check)
        mockEAS.setRevocationTime(VALID_UID, 1);

        vm.expectRevert("Revoked");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 5: Expired attestation ──────────────────────────────────────────
    //
    // Contract check: require(a.expirationTime == 0 || block.timestamp <= a.expirationTime, "Expired")
    // To trigger: expirationTime must be non-zero AND block.timestamp > expirationTime.
    // setUp() warps to 1_000_000; setting expirationTime = 999_999 (< current) triggers "Expired".

    function test_revert_expired() public {
        _buildValidAttestation(VALID_UID);
        // expirationTime in the past: 1 second before current block.timestamp (= 1_000_000)
        uint64 pastExpiry = uint64(block.timestamp - 1); // = 999_999, non-zero and < now
        mockEAS.setExpirationTime(VALID_UID, pastExpiry);

        vm.expectRevert("Expired");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 6: Unknown uid (zero struct) ────────────────────────────────────

    function test_revert_unknownUid() public {
        // uid never stored in MockEAS → getAttestation returns zero struct (uid == bytes32(0))
        bytes32 neverSet = keccak256("uid-never-set");

        vm.expectRevert("Attestation not found");
        escrow.submitAttestation(0, neverSet);
    }

    // ── Test 7: oracleVerified == false ──────────────────────────────────────

    function test_revert_oracleVerifiedFalse() public {
        bytes memory data = mockEAS.encodeData(
            JOB_ID,
            keccak256("kernel-001"),
            EVIDENCE_HASH,
            "",
            REQUIRED_TIER,
            false, // oracleVerified = false
            STEP_ID
        );
        mockEAS.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow),
            attester:       oracle,
            revocable:      true,
            data:           data
        }));

        vm.expectRevert("Oracle did not verify");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 8: Tier too low ─────────────────────────────────────────────────

    function test_revert_tierTooLow() public {
        // Attestation reports tier 0, but milestone requires tier 1
        bytes memory data = mockEAS.encodeData(
            JOB_ID,
            keccak256("kernel-001"),
            EVIDENCE_HASH,
            "",
            0,    // assuranceTier = 0 < REQUIRED_TIER (1)
            true,
            STEP_ID
        );
        mockEAS.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow),
            attester:       oracle,
            revocable:      true,
            data:           data
        }));

        vm.expectRevert("Tier too low");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 9: jobId mismatch ───────────────────────────────────────────────

    function test_revert_jobIdMismatch() public {
        bytes memory data = mockEAS.encodeData(
            "other-job-999",  // wrong jobId
            keccak256("kernel-001"),
            EVIDENCE_HASH,
            "",
            REQUIRED_TIER,
            true,
            STEP_ID
        );
        mockEAS.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow),
            attester:       oracle,
            revocable:      true,
            data:           data
        }));

        vm.expectRevert("jobId mismatch");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 10: Evidence mismatch ───────────────────────────────────────────

    function test_revert_evidenceMismatch() public {
        bytes32 wrongEvidence = keccak256("wrong-evidence-hash");
        bytes memory data = mockEAS.encodeData(
            JOB_ID,
            keccak256("kernel-001"),
            wrongEvidence, // does not match EVIDENCE_HASH on-chain
            "",
            REQUIRED_TIER,
            true,
            STEP_ID
        );
        mockEAS.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow),
            attester:       oracle,
            revocable:      true,
            data:           data
        }));

        vm.expectRevert("Evidence mismatch");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 11: UID replay guard (security review C1) ───────────────────────
    //
    // A valid UID releases milestone 0. Submitting the SAME uid to milestone 1
    // (within the same escrow) must revert "Attestation already used".
    // Also verifies attestationUsed() returns true after first use.

    function test_revert_uidReplay() public {
        bytes32 replayUid = keccak256("replay-uid-001");
        bytes32 stepId2   = keccak256("step-v2-002");

        // Build a fresh two-milestone escrow (setUp escrow is already funded/bonded/evidenced)
        MockUSDC usdc2    = new MockUSDC(1_000_000e6);
        MockEAS  mockEAS2 = new MockEAS();
        MilestoneEscrowV2 impl2    = _deployImpl(address(mockEAS2), SCHEMA_UID, oracle);
        MilestoneEscrowV2 escrow2  = _cloneAndInit(impl2, payer, arbiter, address(usdc2), CWM_ID, address(0));

        usdc2.mint(payer,    500_000e6);
        usdc2.mint(operator,  50_000e6);

        vm.startPrank(payer);
        escrow2.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        escrow2.addMilestone(stepId2, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, "job-v2-002");
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

        // Build a valid attestation for milestone 0 (recipient = escrow2)
        bytes memory data0 = mockEAS2.encodeData(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "", REQUIRED_TIER, true, STEP_ID
        );
        mockEAS2.setAttestation(replayUid, EASAttestation({
            uid:            replayUid,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow2),
            attester:       oracle,
            revocable:      true,
            data:           data0
        }));

        // First submit on milestone 0: succeeds
        escrow2.submitAttestation(0, replayUid);
        assertTrue(escrow2.attestationUsed(replayUid), "UID must be marked used after first submit");

        // Second submit of same uid to milestone 1: "Attestation already used" (C1)
        vm.expectRevert("Attestation already used");
        escrow2.submitAttestation(1, replayUid);
    }

    // ── Test 12: Wrong recipient (security review C2a) ───────────────────────

    function test_revert_wrongRecipient() public {
        _buildValidAttestation(VALID_UID);
        // Override recipient to a random address (not address(escrow))
        mockEAS.setRecipient(VALID_UID, address(0xDEAD));

        vm.expectRevert("Wrong recipient");
        escrow.submitAttestation(0, VALID_UID);
    }

    // ── Test 13: stepId mismatch (security review C2b) ──────────────────────

    function test_revert_stepIdMismatch() public {
        bytes32 wrongStepId = keccak256("step-wrong-999");
        bytes memory data = mockEAS.encodeData(
            JOB_ID,
            keccak256("kernel-001"),
            EVIDENCE_HASH,
            "",
            REQUIRED_TIER,
            true,
            wrongStepId  // wrong stepId — does not match m.stepId
        );
        mockEAS.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
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

    // ── Test 14a: Invalid tier at addMilestone (security review L4) ──────────

    function test_revert_invalidTier() public {
        // requiredTier = 4 exceeds MAX_ASSURANCE_TIER (3) → "Invalid tier"
        MockUSDC usdc3    = new MockUSDC(1_000_000e6);
        MockEAS  mockEAS3 = new MockEAS();
        MilestoneEscrowV2 impl3   = _deployImpl(address(mockEAS3), SCHEMA_UID, oracle);
        MilestoneEscrowV2 escrow3 = _cloneAndInit(impl3, payer, arbiter, address(usdc3), CWM_ID, address(0));

        vm.prank(payer);
        vm.expectRevert("Invalid tier");
        escrow3.addMilestone(STEP_ID, operator, AMOUNT, 0, CHALLENGE_WINDOW, 4, JOB_ID);
    }

    // ── Test 14b: Zero schema UID constructor (security review H1) ───────────
    //
    // The H1 require now lives in the IMPLEMENTATION constructor. Deploying an impl
    // with schemaUid == 0 must revert before any clone could be made.

    function test_revert_zeroSchemaUidConstructor() public {
        MockEAS mockEAS4 = new MockEAS();

        vm.expectRevert("Schema UID unset");
        new MilestoneEscrowV2(
            address(mockEAS4),
            bytes32(0), // zero schemaUid — must revert (H1)
            oracle
        );
    }

    // ── Bonus: evidence must be submitted before attestation ─────────────────

    function test_revert_evidenceNotSubmitted() public {
        // Fresh escrow where submitEvidence was NOT called
        MockUSDC usdc5    = new MockUSDC(1_000_000e6);
        MockEAS  mockEAS5 = new MockEAS();
        MilestoneEscrowV2 impl5   = _deployImpl(address(mockEAS5), SCHEMA_UID, oracle);
        MilestoneEscrowV2 escrow5 = _cloneAndInit(impl5, payer, arbiter, address(usdc5), CWM_ID, address(0));
        usdc5.mint(payer, 500_000e6);

        vm.prank(payer);
        escrow5.addMilestone(STEP_ID, operator, AMOUNT, 0, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        vm.startPrank(payer);
        usdc5.approve(address(escrow5), AMOUNT);
        escrow5.fund();
        vm.stopPrank();

        // Register a valid attestation in the mock
        bytes memory data5 = mockEAS5.encodeData(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "", REQUIRED_TIER, true, STEP_ID
        );
        mockEAS5.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrow5),
            attester:       oracle,
            revocable:      true,
            data:           data5
        }));

        // submitAttestation before submitEvidence → "Evidence not submitted"
        vm.expectRevert("Evidence not submitted");
        escrow5.submitAttestation(0, VALID_UID);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  CLONE / FAULT-ISOLATION TESTS (the hard requirement)
    // ══════════════════════════════════════════════════════════════════════════

    // ── Isolation: an exploit on clone A cannot touch clone B ─────────────────
    //
    // Build two fully-independent clones A and B from ONE implementation, each funded
    // with its own USDC. Then attack A: (1) an early release() before the challenge
    // window, and (2) a release() by a non-payer / before attestation — anything that
    // would, in a shared-contract design, risk cross-escrow state. Assert that B's
    // token balance and milestone state are byte-for-byte untouched throughout, and
    // that A's funds never leave A toward B.

    function test_isolation_exploitOnAcannotTouchB() public {
        // Two clones of the SAME implementation, separate USDC pots.
        MockUSDC usdcA = new MockUSDC(1_000_000e6);
        MockUSDC usdcB = new MockUSDC(1_000_000e6);

        MilestoneEscrowV2 escrowA = _cloneAndInit(escrowImpl, payer, arbiter, address(usdcA), keccak256("cwm-A"), address(0));
        MilestoneEscrowV2 escrowB = _cloneAndInit(escrowImpl, payer, arbiter, address(usdcB), keccak256("cwm-B"), address(0));

        // Distinct addresses → distinct storage → distinct balances.
        assertTrue(address(escrowA) != address(escrowB), "clones must have distinct addresses");

        usdcA.mint(payer, 500_000e6);
        usdcB.mint(payer, 500_000e6);
        usdcA.mint(operator, 50_000e6);
        usdcB.mint(operator, 50_000e6);

        // Fund BOTH escrows with one milestone each.
        vm.startPrank(payer);
        escrowA.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        usdcA.approve(address(escrowA), AMOUNT);
        escrowA.fund();
        escrowB.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        usdcB.approve(address(escrowB), AMOUNT);
        escrowB.fund();
        vm.stopPrank();

        // Operators bond + evidence on BOTH.
        vm.startPrank(operator);
        usdcA.approve(address(escrowA), OPERATOR_BOND);
        escrowA.depositBond(0);
        escrowA.submitEvidence(0, EVIDENCE_HASH);
        usdcB.approve(address(escrowB), OPERATOR_BOND);
        escrowB.depositBond(0);
        escrowB.submitEvidence(0, EVIDENCE_HASH);
        vm.stopPrank();

        // Snapshot B's full state BEFORE attacking A.
        uint256 bTokenBefore   = usdcB.balanceOf(address(escrowB));
        uint8   bStatusBefore  = uint8(escrowB.getMilestone(0).status);
        uint256 aTokenBefore   = usdcA.balanceOf(address(escrowA));
        assertEq(bTokenBefore, AMOUNT + OPERATOR_BOND, "B holds its own funds");
        assertEq(aTokenBefore, AMOUNT + OPERATOR_BOND, "A holds its own funds");

        // ── ATTACK A #1: release before the challenge window even opens (not attested). ──
        vm.expectRevert("Not attested");
        escrowA.release(0);

        // ── ATTACK A #2: attest A, then try to release A BEFORE the window closes. ──
        bytes memory dataA = mockEAS.encodeData(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "", REQUIRED_TIER, true, STEP_ID
        );
        mockEAS.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(escrowA),
            attester:       oracle,
            revocable:      true,
            data:           dataA
        }));
        escrowA.submitAttestation(0, VALID_UID);
        vm.expectRevert("Challenge window open");
        escrowA.release(0);

        // ── ATTACK A #3: try to reuse A's UID against B (cross-escrow replay). ──
        // The UID names escrowA as recipient, so B rejects it: "Wrong recipient".
        vm.expectRevert("Wrong recipient");
        escrowB.submitAttestation(0, VALID_UID);

        // ── After all attacks on A, B is byte-for-byte unchanged. ──
        assertEq(usdcB.balanceOf(address(escrowB)), bTokenBefore, "B balance untouched by attacks on A");
        assertEq(uint8(escrowB.getMilestone(0).status), bStatusBefore, "B milestone status untouched");

        // ── Sanity: a LEGITIMATE release of A pays out of A's pot only; B is still untouched. ──
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        uint256 opBefore = usdcA.balanceOf(operator);
        escrowA.release(0);
        assertEq(usdcA.balanceOf(operator) - opBefore, AMOUNT + OPERATOR_BOND, "A pays its operator from A's pot");
        assertEq(usdcA.balanceOf(address(escrowA)), 0, "A's pot fully drained by its own release");

        // B's funds and state STILL untouched after A fully settled.
        assertEq(usdcB.balanceOf(address(escrowB)), bTokenBefore, "B balance untouched after A settles");
        assertEq(uint8(escrowB.getMilestone(0).status), bStatusBefore, "B status untouched after A settles");
    }

    // ── Re-init guard: a clone can be initialized exactly once ────────────────

    function test_revert_doubleInitialize() public {
        // `escrow` (from setUp) is already initialized. A second initialize must revert.
        vm.expectRevert("Already initialized");
        escrow.initialize(payer, arbiter, address(usdc), CWM_ID, address(0));
    }

    // ── Impl lock: the implementation itself can never be initialized ─────────

    function test_revert_initializeImplementationDirectly() public {
        // escrowImpl's constructor set _initialized = true, so initialize() reverts.
        vm.expectRevert("Already initialized");
        escrowImpl.initialize(payer, arbiter, address(usdc), CWM_ID, address(0));
    }

    // ── Recipient binding survives the clone refactor across two clones ───────
    //
    // Two clones have distinct addresses. An attestation minted with recipient = cloneA
    // is rejected by cloneB with "Wrong recipient" — the per-escrow binding (C2a) holds
    // precisely BECAUSE each clone has its own address.

    function test_clone_hasOwnAddress_recipientBindingHolds() public {
        MockUSDC usdcA = new MockUSDC(1_000_000e6);
        MockUSDC usdcB = new MockUSDC(1_000_000e6);
        MockEAS  meas  = new MockEAS();

        // Both clones share ONE implementation that points at `meas`.
        MilestoneEscrowV2 impl = _deployImpl(address(meas), SCHEMA_UID, oracle);
        MilestoneEscrowV2 cloneA = _cloneAndInit(impl, payer, arbiter, address(usdcA), keccak256("cwm-clone-A"), address(0));
        MilestoneEscrowV2 cloneB = _cloneAndInit(impl, payer, arbiter, address(usdcB), keccak256("cwm-clone-B"), address(0));

        assertTrue(address(cloneA) != address(cloneB), "distinct clone addresses");
        // Both read the SAME shared immutables from the implementation code.
        assertEq(address(cloneA.eas()), address(meas), "cloneA reads shared eas immutable");
        assertEq(address(cloneB.eas()), address(meas), "cloneB reads shared eas immutable");
        assertEq(cloneA.PCC_EVIDENCE_SCHEMA_UID(), SCHEMA_UID, "cloneA shared schema");
        assertEq(cloneB.PCC_EVIDENCE_SCHEMA_UID(), SCHEMA_UID, "cloneB shared schema");
        assertEq(cloneA.authorizedOracle(), oracle, "cloneA shared oracle");
        assertEq(cloneB.authorizedOracle(), oracle, "cloneB shared oracle");

        // Fund + evidence cloneB's milestone 0 so it reaches the recipient check.
        usdcB.mint(payer, 500_000e6);
        usdcB.mint(operator, 50_000e6);
        vm.startPrank(payer);
        cloneB.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        usdcB.approve(address(cloneB), AMOUNT);
        cloneB.fund();
        vm.stopPrank();
        vm.startPrank(operator);
        usdcB.approve(address(cloneB), OPERATOR_BOND);
        cloneB.depositBond(0);
        cloneB.submitEvidence(0, EVIDENCE_HASH);
        vm.stopPrank();

        // Mint an attestation whose recipient is cloneA (NOT cloneB).
        bytes memory data = meas.encodeData(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "", REQUIRED_TIER, true, STEP_ID
        );
        meas.setAttestation(VALID_UID, EASAttestation({
            uid:            VALID_UID,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      address(cloneA), // bound to A
            attester:       oracle,
            revocable:      true,
            data:           data
        }));

        // cloneB rejects an attestation bound to cloneA.
        vm.expectRevert("Wrong recipient");
        cloneB.submitAttestation(0, VALID_UID);
    }
}
