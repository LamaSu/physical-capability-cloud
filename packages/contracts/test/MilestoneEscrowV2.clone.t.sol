// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/MilestoneEscrowV2.sol";
import "../src/PCCProtocolV2.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockEAS.sol";
import {Clones} from "../src/libraries/Clones.sol";
import {IEAS, EASAttestation} from "../src/interfaces/IEAS.sol";

/**
 * @title MilestoneEscrowV2CloneTest
 * @notice Clone-safety tests for the EIP-1167 minimal-proxy refactor of
 *         MilestoneEscrowV2 (deferred bulletin #024 B-2, "V2-direct").
 *
 * These tests assert the properties the clone refactor exists to provide, none
 * of which the pre-clone (one-full-deploy-per-escrow) design could even express:
 *
 *   A. Re-init guard — calling initialize() twice on a clone reverts AlreadyInitialized.
 *   B. Implementation lock — initialize() on the implementation itself reverts
 *      AlreadyInitialized (its constructor pre-set _initialized = true). A clone of a
 *      LOCKED implementation is still initializable exactly once (zeroed clone storage).
 *   C. Fault isolation — two clones have fully ISOLATED storage and token balances:
 *      funding + releasing milestone(s) on clone A leaves clone B's milestones, funded
 *      flag, totals, and USDC balance untouched, and vice-versa. This is the EVM-enforced
 *      per-escrow blast-radius containment the refactor buys.
 *   D. Guards survive cloning — C1 (UID single-use), C2a (recipient binding),
 *      C2b (stepId binding), H1 (zero-schema reject) all still hold on a clone created by
 *      the factory's createEscrowV2 path (not just on a hand-built clone).
 *   E. Deterministic address — PCCProtocolV2.predictEscrowAddress(cwmId, index) equals the
 *      address createEscrowV2 actually deploys to (CREATE2 salt = keccak256(cwmId, index)).
 *
 * Authored by: implementer-mike (clone refactor)
 */
contract MilestoneEscrowV2CloneTest is Test {
    // ── Actors ───────────────────────────────────────────────────────────────
    address internal payer    = address(0x1);
    address internal operator = address(0x2);
    address internal arbiter  = address(0x3);
    address internal oracle   = address(0x4); // authorizedOracle / EAS attester

    // Factory actors
    address internal feeRecipient   = address(0xFEE1);
    address internal governor       = address(0xF001);
    address internal oracleVerifier = address(0xF002);

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_UID = bytes32(uint256(0xDEAD));
    bytes32 internal constant CWM_A      = keccak256("cwm-clone-A");
    bytes32 internal constant CWM_B      = keccak256("cwm-clone-B");

    string  internal constant JOB_ID        = "job-clone-001";
    bytes32 internal STEP_ID;                 // keccak256("step-clone-001")
    bytes32 internal constant EVIDENCE_HASH  = keccak256("evidence-clone-001");

    uint256 internal constant AMOUNT           = 100e6; // 100 USDC
    uint256 internal constant OPERATOR_BOND    = 10e6;  // 10 USDC
    uint256 internal constant CHALLENGE_WINDOW = 3600;  // 1 hour
    uint8   internal constant REQUIRED_TIER    = 1;

    // ── Contracts ────────────────────────────────────────────────────────────
    MilestoneEscrowV2 internal implementation; // locked shared logic
    MockUSDC          internal usdc;
    MockEAS           internal mockEAS;

    function setUp() public {
        vm.warp(1_000_000);
        STEP_ID = keccak256("step-clone-001");

        usdc    = new MockUSDC(10_000_000e6);
        mockEAS = new MockEAS();

        // Deploy ONE locked implementation (the same constructor PCCProtocolV2 uses).
        implementation = new MilestoneEscrowV2(address(mockEAS), SCHEMA_UID, oracle);

        usdc.mint(payer,    5_000_000e6);
        usdc.mint(operator, 1_000_000e6);
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /// @dev Clone the shared implementation and initialize it (standalone, no factory root).
    function _clone(bytes32 cwmId) internal returns (MilestoneEscrowV2 esc) {
        esc = MilestoneEscrowV2(Clones.clone(address(implementation)));
        esc.initialize(payer, arbiter, address(usdc), cwmId, address(0));
    }

    /// @dev Add one default-token milestone, fund, deposit bond, submit evidence.
    function _primeMilestone(MilestoneEscrowV2 esc, bytes32 stepId, string memory jobId) internal {
        vm.startPrank(payer);
        esc.addMilestone(stepId, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, jobId);
        usdc.approve(address(esc), AMOUNT);
        esc.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(esc), OPERATOR_BOND);
        esc.depositBond(0);
        esc.submitEvidence(0, EVIDENCE_HASH);
        vm.stopPrank();
    }

    /// @dev Register a valid attestation (recipient bound to `esc`) in `mock`.
    function _attest(MockEAS mock, bytes32 uid, address escAddr, bytes32 stepId, string memory jobId) internal {
        bytes memory data = mock.encodeData(
            jobId, keccak256("kernel"), EVIDENCE_HASH, "", REQUIRED_TIER, true, stepId
        );
        mock.setAttestation(uid, EASAttestation({
            uid:            uid,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      escAddr,
            attester:       oracle,
            revocable:      true,
            data:           data
        }));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // A. Re-initialization guard
    // ─────────────────────────────────────────────────────────────────────────

    function test_clone_reinit_reverts() public {
        MilestoneEscrowV2 esc = _clone(CWM_A);

        // Second initialize on the SAME clone must revert with the custom error.
        vm.expectRevert(MilestoneEscrowV2.AlreadyInitialized.selector);
        esc.initialize(payer, arbiter, address(usdc), CWM_A, address(0));
    }

    function test_clone_reinit_cannotHijackConfig() public {
        MilestoneEscrowV2 esc = _clone(CWM_A);

        // An attacker trying to re-initialize with themselves as payer must fail,
        // and the original config must be intact afterward.
        address attacker = address(0xBAD);
        vm.prank(attacker);
        vm.expectRevert(MilestoneEscrowV2.AlreadyInitialized.selector);
        esc.initialize(attacker, attacker, address(usdc), CWM_A, address(0));

        assertEq(esc.payer(), payer, "payer must remain the original after failed re-init");
        assertEq(esc.arbiter(), arbiter, "arbiter must remain the original after failed re-init");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // B. Implementation lock
    // ─────────────────────────────────────────────────────────────────────────

    function test_implementation_isLocked() public {
        // The implementation's constructor pre-set _initialized = true, so initialize()
        // on the implementation itself must revert — it can never be configured/used directly.
        vm.expectRevert(MilestoneEscrowV2.AlreadyInitialized.selector);
        implementation.initialize(payer, arbiter, address(usdc), CWM_A, address(0));
    }

    function test_implementation_locked_butCloneInitializable() public {
        // Even though the implementation is locked, a fresh clone of it (zeroed storage)
        // is initializable exactly once.
        MilestoneEscrowV2 esc = MilestoneEscrowV2(Clones.clone(address(implementation)));
        esc.initialize(payer, arbiter, address(usdc), CWM_A, address(0));
        assertEq(esc.payer(), payer, "fresh clone of a locked impl must initialize once");

        // ...and only once.
        vm.expectRevert(MilestoneEscrowV2.AlreadyInitialized.selector);
        esc.initialize(payer, arbiter, address(usdc), CWM_A, address(0));
    }

    function test_implementation_immutablesSharedByClone() public {
        // Immutables live in the implementation's CODE and are read identically by clones.
        MilestoneEscrowV2 esc = _clone(CWM_A);
        assertEq(address(esc.eas()), address(mockEAS), "clone reads impl eas immutable");
        assertEq(esc.PCC_EVIDENCE_SCHEMA_UID(), SCHEMA_UID, "clone reads impl schema immutable");
        assertEq(esc.authorizedOracle(), oracle, "clone reads impl oracle immutable");
        // And the implementation exposes the same immutables.
        assertEq(address(implementation.eas()), address(mockEAS), "impl eas immutable");
        assertEq(implementation.PCC_EVIDENCE_SCHEMA_UID(), SCHEMA_UID, "impl schema immutable");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // C. Fault isolation — two clones, isolated storage + balances
    // ─────────────────────────────────────────────────────────────────────────

    function test_twoClones_haveDistinctAddressesAndZeroCrosstalk() public {
        MilestoneEscrowV2 a = _clone(CWM_A);
        MilestoneEscrowV2 b = _clone(CWM_B);

        assertTrue(address(a) != address(b), "clones must have distinct addresses");
        assertTrue(address(a) != address(implementation), "clone A != implementation");
        assertTrue(address(b) != address(implementation), "clone B != implementation");

        // Distinct cwmId in each clone's OWN storage.
        assertEq(a.cwmId(), CWM_A, "clone A cwmId");
        assertEq(b.cwmId(), CWM_B, "clone B cwmId");
    }

    function test_faultIsolation_fundingOneDoesNotAffectOther() public {
        MilestoneEscrowV2 a = _clone(CWM_A);
        MilestoneEscrowV2 b = _clone(CWM_B);

        // Add a milestone to BOTH, but fund only A.
        vm.startPrank(payer);
        a.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        b.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        usdc.approve(address(a), AMOUNT);
        a.fund();
        vm.stopPrank();

        // A is funded; B is NOT — isolated `funded` flags and balances.
        assertTrue(a.funded(),  "clone A funded");
        assertFalse(b.funded(), "clone B must remain unfunded");
        assertEq(usdc.balanceOf(address(a)), AMOUNT, "clone A holds the funds");
        assertEq(usdc.balanceOf(address(b)), 0,      "clone B holds nothing");

        // A's milestone is Funded(1); B's is still Unfunded(0).
        assertEq(uint8(a.getMilestone(0).status), 1, "clone A milestone Funded");
        assertEq(uint8(b.getMilestone(0).status), 0, "clone B milestone Unfunded");
    }

    function test_faultIsolation_releasingOneDoesNotTouchOther() public {
        // Two clones, each with their OWN MockEAS so attestations cannot bleed across.
        MockEAS easA = new MockEAS();
        MockEAS easB = new MockEAS();
        MilestoneEscrowV2 implA = new MilestoneEscrowV2(address(easA), SCHEMA_UID, oracle);
        MilestoneEscrowV2 implB = new MilestoneEscrowV2(address(easB), SCHEMA_UID, oracle);

        MilestoneEscrowV2 a = MilestoneEscrowV2(Clones.clone(address(implA)));
        a.initialize(payer, arbiter, address(usdc), CWM_A, address(0));
        MilestoneEscrowV2 b = MilestoneEscrowV2(Clones.clone(address(implB)));
        b.initialize(payer, arbiter, address(usdc), CWM_B, address(0));

        // Prime both clones identically (milestone + fund + bond + evidence).
        _primeMilestone(a, STEP_ID, JOB_ID);
        _primeMilestone(b, STEP_ID, JOB_ID);

        // Snapshot B's pre-state and balances.
        uint256 bBalBefore = usdc.balanceOf(address(b));
        uint8   bStatusBefore = uint8(b.getMilestone(0).status);
        uint256 operatorBefore = usdc.balanceOf(operator);

        // Fully release A's milestone.
        bytes32 uidA = keccak256("uid-clone-A");
        _attest(easA, uidA, address(a), STEP_ID, JOB_ID);
        a.submitAttestation(0, uidA);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        a.release(0);

        // A advanced to Released(5) and paid out; its balance dropped to 0.
        assertEq(uint8(a.getMilestone(0).status), 5, "clone A Released");
        assertEq(usdc.balanceOf(address(a)), 0, "clone A drained on release");

        // B is COMPLETELY untouched: same status, same balance, attestation UID not consumed.
        assertEq(uint8(b.getMilestone(0).status), bStatusBefore, "clone B status unchanged by A's release");
        assertEq(usdc.balanceOf(address(b)), bBalBefore, "clone B balance unchanged by A's release");
        assertFalse(b.attestationUsed(uidA), "A's UID must not be marked used in B");

        // Operator received A's payout (AMOUNT + BOND) and B's funds are still locked in B.
        assertEq(usdc.balanceOf(operator) - operatorBefore, AMOUNT + OPERATOR_BOND, "operator paid from A only");
        assertEq(usdc.balanceOf(address(b)), AMOUNT + OPERATOR_BOND, "B still holds its own amount + bond");
    }

    function test_faultIsolation_uidUsedInOneIsFreshInOther() public {
        // The same UID value, minted separately for each clone (recipient bound to each),
        // is consumed independently — using it in A does NOT mark it used in B (C1 is per-escrow).
        MockEAS easA = new MockEAS();
        MockEAS easB = new MockEAS();
        MilestoneEscrowV2 implA = new MilestoneEscrowV2(address(easA), SCHEMA_UID, oracle);
        MilestoneEscrowV2 implB = new MilestoneEscrowV2(address(easB), SCHEMA_UID, oracle);
        MilestoneEscrowV2 a = MilestoneEscrowV2(Clones.clone(address(implA)));
        a.initialize(payer, arbiter, address(usdc), CWM_A, address(0));
        MilestoneEscrowV2 b = MilestoneEscrowV2(Clones.clone(address(implB)));
        b.initialize(payer, arbiter, address(usdc), CWM_B, address(0));

        _primeMilestone(a, STEP_ID, JOB_ID);
        _primeMilestone(b, STEP_ID, JOB_ID);

        bytes32 sharedUid = keccak256("shared-uid");
        _attest(easA, sharedUid, address(a), STEP_ID, JOB_ID); // recipient = A
        _attest(easB, sharedUid, address(b), STEP_ID, JOB_ID); // recipient = B

        a.submitAttestation(0, sharedUid);
        assertTrue(a.attestationUsed(sharedUid), "UID used in A");
        assertFalse(b.attestationUsed(sharedUid), "same UID still fresh in B (isolated _attestationUsed)");

        // B can still consume its own attestation for the same UID value.
        b.submitAttestation(0, sharedUid);
        assertTrue(b.attestationUsed(sharedUid), "UID now used in B too");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // D. Guards survive cloning via the FACTORY path
    // ─────────────────────────────────────────────────────────────────────────

    function _factory() internal returns (PCCProtocolV2 f) {
        f = new PCCProtocolV2(feeRecipient, 235, governor, oracleVerifier, address(mockEAS), SCHEMA_UID, oracle);
    }

    function test_factoryClone_happyPath_releases() public {
        PCCProtocolV2 f = _factory();
        MilestoneEscrowV2 esc = MilestoneEscrowV2(f.createEscrowV2(payer, arbiter, address(usdc), CWM_A));

        // protocolRoot must be the factory (so release routes the fee there).
        assertEq(esc.protocolRoot(), address(f), "factory clone protocolRoot == factory");

        _primeMilestone(esc, STEP_ID, JOB_ID);

        bytes32 uid = keccak256("uid-factory-happy");
        _attest(mockEAS, uid, address(esc), STEP_ID, JOB_ID);
        esc.submitAttestation(0, uid);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        // Release: factory fee (235 bps) goes to feeRecipient, remainder + bond to operator.
        uint256 feeRecipBefore = usdc.balanceOf(feeRecipient);
        uint256 operatorBefore = usdc.balanceOf(operator);
        esc.release(0);

        uint256 expectedFee = (AMOUNT * 235) / 10000;
        assertEq(usdc.balanceOf(feeRecipient) - feeRecipBefore, expectedFee, "factory fee paid on clone release");
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            AMOUNT - expectedFee + OPERATOR_BOND,
            "operator net payout on clone release"
        );
        assertEq(uint8(esc.getMilestone(0).status), 5, "factory clone Released");
    }

    function test_factoryClone_C2a_wrongRecipientReverts() public {
        // C2a: an attestation whose recipient != the clone address must be rejected.
        PCCProtocolV2 f = _factory();
        MilestoneEscrowV2 esc = MilestoneEscrowV2(f.createEscrowV2(payer, arbiter, address(usdc), CWM_A));
        _primeMilestone(esc, STEP_ID, JOB_ID);

        bytes32 uid = keccak256("uid-wrong-recipient");
        _attest(mockEAS, uid, address(0xDEAD), STEP_ID, JOB_ID); // recipient bound to a DIFFERENT address

        vm.expectRevert("Wrong recipient");
        esc.submitAttestation(0, uid);
    }

    function test_factoryClone_C2b_wrongStepIdReverts() public {
        // C2b: decoded stepId must equal the milestone's stepId.
        PCCProtocolV2 f = _factory();
        MilestoneEscrowV2 esc = MilestoneEscrowV2(f.createEscrowV2(payer, arbiter, address(usdc), CWM_A));
        _primeMilestone(esc, STEP_ID, JOB_ID);

        bytes32 uid = keccak256("uid-wrong-step");
        _attest(mockEAS, uid, address(esc), keccak256("step-WRONG"), JOB_ID); // wrong stepId in payload

        vm.expectRevert("stepId mismatch");
        esc.submitAttestation(0, uid);
    }

    function test_factoryClone_C1_uidReplayReverts() public {
        // C1: a UID consumed once on a factory clone cannot release a second milestone.
        PCCProtocolV2 f = _factory();
        MilestoneEscrowV2 esc = MilestoneEscrowV2(f.createEscrowV2(payer, arbiter, address(usdc), CWM_A));

        bytes32 stepId2 = keccak256("step-clone-002");
        vm.startPrank(payer);
        esc.addMilestone(STEP_ID,  operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        esc.addMilestone(stepId2,  operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, "job-clone-002");
        usdc.approve(address(esc), AMOUNT * 2);
        esc.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(esc), OPERATOR_BOND * 2);
        esc.depositBond(0);
        esc.submitEvidence(0, EVIDENCE_HASH);
        esc.depositBond(1);
        esc.submitEvidence(1, EVIDENCE_HASH);
        vm.stopPrank();

        bytes32 uid = keccak256("uid-replay-factory");
        _attest(mockEAS, uid, address(esc), STEP_ID, JOB_ID);
        esc.submitAttestation(0, uid);
        assertTrue(esc.attestationUsed(uid), "UID used after first submit");

        // Reusing the same UID on milestone 1 must revert (C1).
        vm.expectRevert("Attestation already used");
        esc.submitAttestation(1, uid);
    }

    function test_factory_H1_zeroSchemaReverts() public {
        // H1 via the factory path: a zero schema UID must be rejected at factory construction
        // (the factory's own guard fires before it deploys the implementation).
        vm.expectRevert("Schema UID unset");
        new PCCProtocolV2(feeRecipient, 235, governor, oracleVerifier, address(mockEAS), bytes32(0), oracle);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // E. Deterministic clone address
    // ─────────────────────────────────────────────────────────────────────────

    function test_predictEscrowAddress_matchesDeployedClone() public {
        PCCProtocolV2 f = _factory();

        // Predict the address for the FIRST escrow (index 0) before deploying.
        address predicted0 = f.predictEscrowAddress(CWM_A, 0);
        address actual0    = f.createEscrowV2(payer, arbiter, address(usdc), CWM_A);
        assertEq(actual0, predicted0, "predicted address must equal the deployed clone (index 0)");

        // And for the SECOND escrow (index 1) — same cwmId is fine because the salt mixes the index.
        address predicted1 = f.predictEscrowAddress(CWM_A, 1);
        address actual1    = f.createEscrowV2(payer, arbiter, address(usdc), CWM_A);
        assertEq(actual1, predicted1, "predicted address must equal the deployed clone (index 1)");
        assertTrue(actual0 != actual1, "same cwmId at different indexes yields distinct clones");
    }
}
