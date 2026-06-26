// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PCCProtocolV3.sol";
import "../src/MilestoneEscrowV3.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockEAS.sol";
import {IEAS, EASAttestation} from "../src/interfaces/IEAS.sol";

/**
 * @title PCCProtocolV3Test
 * @notice Tests for the PCCProtocolV3 factory and its EAS wiring.
 *
 * PCCProtocolV3 is the deploy-enablement companion for MilestoneEscrowV3 (#139 shipped the
 * escrow as a DRAFT with no factory). This suite mirrors PCCProtocolV2.t.sol and adds two
 * V3-specific checks that prove the EIP-1167 clone path actually works end-to-end:
 *
 *   1  test_createEscrowV3_deploysAndRegisters
 *         Factory clones a MilestoneEscrowV3, registers isProtocolEscrow[child], and the
 *         child exposes the correct eas / authorizedOracle / PCC_EVIDENCE_V2_SCHEMA_UID and
 *         per-escrow config (payer / token / cwmId / protocolRoot).
 *   2  test_revert_zeroSchemaUidConstructor (H1)
 *         PCCProtocolV3 with pccEvidenceSchemaUid == bytes32(0) reverts "Schema UID unset".
 *   3  test_createEscrowV3_appendedToAllEscrows
 *   4  test_createEscrowV3_emitsEscrowCreated
 *   5  test_feeDefaultsRetained
 *   6  test_createEscrowV3_revert_zeroPayer
 *   7  test_createEscrowV3_revert_zeroToken
 *   8  test_predictEscrowAddress_matchesDeployedClone (CREATE2 determinism)
 *   9  test_factoryClone_threadsImmutables_releasesAndAccountsFee
 *         A factory-cloned escrow runs the full Mode-B path: oracle attests a fee, release()
 *         pays the ATTESTED fee recipient and routes the collectFee accounting hook back to
 *         THIS factory (protocolRoot). Proves the threaded immutables + accounting wiring.
 *
 * Style mirrors PCCProtocolV2.t.sol.
 *
 * Authored by: implementer (sgo/v3factory)
 */
contract PCCProtocolV3Test is Test {
    // ── Events (mirror contract — required by vm.expectEmit) ────────────────
    event EscrowCreated(
        address indexed escrow,
        address indexed payer,
        address indexed arbiter,
        address token,
        bytes32 cwmId
    );
    event FeeCollected(address indexed escrow, address indexed token, uint256 fee);

    // ── Actors (use numeric hex literals only) ────────────────────────────────
    address internal feeRecipient   = address(0xFEE1); // factory fee recipient (immutable, parity-only)
    address internal governor       = address(0xF001);
    address internal oracleVerifier = address(0xF002);
    address internal easOracle      = address(0xF003); // EAS attester threaded to children
    address internal payer          = address(0x0001);
    address internal arbiter        = address(0x0002);
    address internal operator       = address(0x0007);
    address internal attestedFeeTo  = address(0xFEE2); // fee recipient encoded in the attestation

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_UID = bytes32(uint256(0xBEEF));
    bytes32 internal constant CWM_ID     = keccak256("cwm-factory-v3-001");

    string  internal constant JOB_ID = "job-factory-v3-001";
    bytes32 internal STEP_ID;
    bytes32 internal constant EVIDENCE_HASH = keccak256("evidence-factory-v3-001");

    uint256 internal constant AMOUNT           = 100e6;
    uint256 internal constant OPERATOR_BOND    = 10e6;
    uint256 internal constant CHALLENGE_WINDOW = 3600;
    uint8   internal constant REQUIRED_TIER    = 1;
    uint16  internal constant ATTESTED_FEE_BPS = 235; // 2.35% attested in Mode B

    // ── Contracts ────────────────────────────────────────────────────────────
    PCCProtocolV3 internal factory;
    MockUSDC      internal usdc;
    MockEAS       internal mockEAS;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        vm.warp(1_000_000);
        STEP_ID = keccak256("step-factory-v3-001");

        usdc    = new MockUSDC(1_000_000e6);
        mockEAS = new MockEAS();

        factory = new PCCProtocolV3(
            feeRecipient,
            235,               // 2.35% initial fee (parity — V3 fee is attested)
            governor,
            oracleVerifier,
            address(mockEAS),
            SCHEMA_UID,
            easOracle
        );

        usdc.mint(payer,    500_000e6);
        usdc.mint(operator,  50_000e6);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    /// @dev ABI-encode the 9-field pcc.evidence.v2 tuple (V1 7 fields + feeBps + feeRecipient).
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
            jobId, kernelId, evidenceBundleHash, ipfsCid, assuranceTier,
            oracleVerified, stepId, attestedFeeBps, attestedFeeRecipient
        );
    }

    /// @dev Register a fully-valid V3 attestation (recipient bound to `escAddr`) in mockEAS.
    function _attest(bytes32 uid, address escAddr, uint16 feeBps, address feeTo) internal {
        bytes memory data = _encodeV3Data(
            JOB_ID, keccak256("kernel-001"), EVIDENCE_HASH, "",
            REQUIRED_TIER, true, STEP_ID, feeBps, feeTo
        );
        mockEAS.setAttestation(uid, EASAttestation({
            uid:            uid,
            schema:         SCHEMA_UID,
            time:           uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID:         bytes32(0),
            recipient:      escAddr,
            attester:       easOracle,
            revocable:      true,
            data:           data
        }));
    }

    /// @dev Add one default-token milestone, fund, deposit bond, submit evidence.
    function _primeMilestone(MilestoneEscrowV3 esc) internal {
        vm.startPrank(payer);
        esc.addMilestone(STEP_ID, operator, AMOUNT, OPERATOR_BOND, CHALLENGE_WINDOW, REQUIRED_TIER, JOB_ID);
        usdc.approve(address(esc), AMOUNT);
        esc.fund();
        vm.stopPrank();

        vm.startPrank(operator);
        usdc.approve(address(esc), OPERATOR_BOND);
        esc.depositBond(0);
        esc.submitEvidence(0, EVIDENCE_HASH);
        vm.stopPrank();
    }

    // ── Test 1: createEscrowV3 deploys, registers, threads immutables ────────

    function test_createEscrowV3_deploysAndRegisters() public {
        address escrowAddr = factory.createEscrowV3(payer, arbiter, address(usdc), CWM_ID);

        // Factory registered the new escrow
        assertTrue(factory.isProtocolEscrow(escrowAddr), "isProtocolEscrow[child] must be true");

        // Cast and verify EAS wiring forwarded to child
        MilestoneEscrowV3 child = MilestoneEscrowV3(escrowAddr);
        assertEq(address(child.eas()),  address(mockEAS), "child.eas() must match factory.eas");
        assertEq(child.authorizedOracle(), easOracle,     "child.authorizedOracle() must match factory.easOracle");
        assertEq(child.PCC_EVIDENCE_V2_SCHEMA_UID(), SCHEMA_UID, "child schemaUid must match factory.pccEvidenceSchemaUid");

        // Child also records the correct payer / token / cwmId
        assertEq(child.payer(), payer,                   "child.payer()");
        assertEq(address(child.token()), address(usdc),  "child.token()");
        assertEq(child.cwmId(), CWM_ID,                  "child.cwmId()");

        // protocolRoot of the child must be the factory
        assertEq(child.protocolRoot(), address(factory), "child.protocolRoot()");
    }

    // ── Test 2: Zero schema uid → constructor reverts (H1) ──────────────────

    function test_revert_zeroSchemaUidConstructor() public {
        vm.expectRevert("Schema UID unset");
        new PCCProtocolV3(
            feeRecipient,
            235,
            governor,
            oracleVerifier,
            address(mockEAS),
            bytes32(0),  // zero pccEvidenceSchemaUid → must revert
            easOracle
        );
    }

    // ── Test 3: allEscrows grows per call ────────────────────────────────────

    function test_createEscrowV3_appendedToAllEscrows() public {
        assertEq(factory.getEscrowCount(), 0, "No escrows before first create");

        factory.createEscrowV3(payer, arbiter, address(usdc), CWM_ID);
        assertEq(factory.getEscrowCount(), 1, "One escrow after first create");

        factory.createEscrowV3(payer, arbiter, address(usdc), keccak256("cwm-v3-2"));
        assertEq(factory.getEscrowCount(), 2, "Two escrows after second create");

        // Verify both are registered and distinct
        address a0 = factory.allEscrows(0);
        address a1 = factory.allEscrows(1);
        assertTrue(factory.isProtocolEscrow(a0), "escrow 0 registered");
        assertTrue(factory.isProtocolEscrow(a1), "escrow 1 registered");
        assertTrue(a0 != a1, "Distinct addresses");
    }

    // ── Test 4: EscrowCreated event emitted ─────────────────────────────────

    function test_createEscrowV3_emitsEscrowCreated() public {
        // We do not know the exact escrow address before the call, so checkTopic1 = false.
        vm.expectEmit(false, true, true, true);
        emit EscrowCreated(address(0), payer, arbiter, address(usdc), CWM_ID);
        address escrowAddr = factory.createEscrowV3(payer, arbiter, address(usdc), CWM_ID);

        // After the call the returned address must be the registered escrow
        assertTrue(factory.isProtocolEscrow(escrowAddr));
    }

    // ── Test 5: fee defaults retained from factory constructor ───────────────

    function test_feeDefaultsRetained() public view {
        assertEq(factory.protocolFeeBps(), 235,          "Default fee 235 bps");
        assertEq(factory.feeRecipient(),   feeRecipient, "Fee recipient immutable");
        assertEq(factory.easOracle(),      easOracle,    "easOracle immutable");
        assertEq(factory.pccEvidenceSchemaUid(), SCHEMA_UID, "pccEvidenceSchemaUid immutable");
    }

    // ── Test 6: createEscrowV3 reverts on zero payer ─────────────────────────

    function test_createEscrowV3_revert_zeroPayer() public {
        vm.expectRevert("Zero payer");
        factory.createEscrowV3(address(0), arbiter, address(usdc), CWM_ID);
    }

    // ── Test 7: createEscrowV3 reverts on zero token ─────────────────────────

    function test_createEscrowV3_revert_zeroToken() public {
        vm.expectRevert("Zero token");
        factory.createEscrowV3(payer, arbiter, address(0), CWM_ID);
    }

    // ── Test 8: predictEscrowAddress matches the deployed clone (CREATE2) ────

    function test_predictEscrowAddress_matchesDeployedClone() public {
        // Predict the address for the FIRST escrow (index 0) before deploying.
        address predicted0 = factory.predictEscrowAddress(CWM_ID, 0);
        address actual0    = factory.createEscrowV3(payer, arbiter, address(usdc), CWM_ID);
        assertEq(actual0, predicted0, "predicted address must equal the deployed clone (index 0)");

        // And for the SECOND escrow (index 1) — same cwmId is fine: the salt mixes the index.
        address predicted1 = factory.predictEscrowAddress(CWM_ID, 1);
        address actual1    = factory.createEscrowV3(payer, arbiter, address(usdc), CWM_ID);
        assertEq(actual1, predicted1, "predicted address must equal the deployed clone (index 1)");
        assertTrue(actual0 != actual1, "same cwmId at different indexes yields distinct clones");
    }

    // ── Test 9: factory clone runs Mode B end-to-end + routes collectFee ────

    function test_factoryClone_threadsImmutables_releasesAndAccountsFee() public {
        MilestoneEscrowV3 esc =
            MilestoneEscrowV3(factory.createEscrowV3(payer, arbiter, address(usdc), CWM_ID));

        // protocolRoot must be the factory (so the collectFee accounting hook routes here).
        assertEq(esc.protocolRoot(), address(factory), "factory clone protocolRoot == factory");

        _primeMilestone(esc);

        // Oracle attests a 2.35% fee to attestedFeeTo (NOT the factory's own feeRecipient —
        // V3 fee + recipient come from the attestation payload).
        bytes32 uid = keccak256("uid-factory-v3-release");
        _attest(uid, address(esc), ATTESTED_FEE_BPS, attestedFeeTo);
        esc.submitAttestation(0, uid);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        uint256 feeToBefore    = usdc.balanceOf(attestedFeeTo);
        uint256 operatorBefore = usdc.balanceOf(operator);

        // collectFee accounting hook must fire on THIS factory with the attested fee.
        uint256 expectedFee = (AMOUNT * ATTESTED_FEE_BPS) / 10000;
        vm.expectEmit(true, true, false, true, address(factory));
        emit FeeCollected(address(esc), address(usdc), expectedFee);

        esc.release(0);

        // Attested fee recipient paid; operator gets net + bond.
        assertEq(usdc.balanceOf(attestedFeeTo) - feeToBefore, expectedFee, "attested fee recipient paid");
        assertEq(
            usdc.balanceOf(operator) - operatorBefore,
            AMOUNT - expectedFee + OPERATOR_BOND,
            "operator net payout on clone release"
        );
        assertEq(uint8(esc.getMilestone(0).status), 5, "factory clone Released");

        // Factory accounting reflects the routed fee.
        assertEq(factory.getTotalFeesForToken(address(usdc)), expectedFee, "factory total fees updated");
        assertEq(factory.feesFromEscrow(address(esc)), expectedFee, "factory per-escrow fee updated");
    }
}
