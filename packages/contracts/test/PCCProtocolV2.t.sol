// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PCCProtocolV2.sol";
import "../src/MilestoneEscrowV2.sol";
import "../src/MockUSDC.sol";
import "./mocks/MockEAS.sol";

/**
 * @title PCCProtocolV2Test
 * @notice Tests for the PCCProtocolV2 factory and its EAS wiring.
 *
 * Cases:
 *   1  test_createEscrowV2_deploysAndRegisters
 *         Factory deploys a MilestoneEscrowV2, registers isProtocolEscrow[child],
 *         and the child exposes the correct eas / authorizedOracle / PCC_EVIDENCE_SCHEMA_UID.
 *
 *   2  test_revert_zeroSchemaUidConstructor (H1)
 *         Deploying PCCProtocolV2 with pccEvidenceSchemaUid == bytes32(0) reverts "Schema UID unset".
 *
 *   3  test_createEscrowV2_appendedToAllEscrows
 *         allEscrows grows by one per createEscrowV2 call.
 *
 *   4  test_createEscrowV2_emitsEscrowCreated
 *         EscrowCreated event emitted with correct payer/arbiter/token/cwmId.
 *
 *   5  test_feeIsTransferredToChildOnRelease
 *         Factory exposes correct default fee bps and feeRecipient.
 *
 * Style mirrors MilestoneEscrow.multistable.t.sol:
 *   - forge-std/Test.sol, named actors, setUp(), vm.expectRevert/expectEmit.
 *
 * Authored by: test-writer-echo
 */
contract PCCProtocolV2Test is Test {
    // ── Events (mirror contract — required by vm.expectEmit) ────────────────
    event EscrowCreated(
        address indexed escrow,
        address indexed payer,
        address indexed arbiter,
        address token,
        bytes32 cwmId
    );

    // ── Actors (use numeric hex literals only) ────────────────────────────────
    address internal feeRecipient   = address(0xFEE1);
    address internal governor       = address(0xF001);
    address internal oracleVerifier = address(0xF002);
    address internal easOracle      = address(0xF003);
    address internal payer          = address(0x0001);
    address internal arbiter        = address(0x0002);

    // ── Constants ────────────────────────────────────────────────────────────
    bytes32 internal constant SCHEMA_UID = bytes32(uint256(0xBEEF));
    bytes32 internal constant CWM_ID     = keccak256("cwm-factory-001");

    // ── Contracts ────────────────────────────────────────────────────────────
    PCCProtocolV2 internal factory;
    MockUSDC      internal usdc;
    MockEAS       internal mockEAS;

    // ── Setup ────────────────────────────────────────────────────────────────

    function setUp() public {
        usdc    = new MockUSDC(1_000_000e6);
        mockEAS = new MockEAS();

        factory = new PCCProtocolV2(
            feeRecipient,
            235,               // 2.35% initial fee
            governor,
            oracleVerifier,
            address(mockEAS),
            SCHEMA_UID,
            easOracle
        );
    }

    // ── Test 1: createEscrowV2 deploys, registers, threads immutables ────────

    function test_createEscrowV2_deploysAndRegisters() public {
        address escrowAddr = factory.createEscrowV2(payer, arbiter, address(usdc), CWM_ID);

        // Factory registered the new escrow
        assertTrue(factory.isProtocolEscrow(escrowAddr), "isProtocolEscrow[child] must be true");

        // Cast and verify EAS wiring forwarded to child
        MilestoneEscrowV2 child = MilestoneEscrowV2(escrowAddr);
        assertEq(address(child.eas()),  address(mockEAS), "child.eas() must match factory.eas");
        assertEq(child.authorizedOracle(), easOracle,     "child.authorizedOracle() must match factory.easOracle");
        assertEq(child.PCC_EVIDENCE_SCHEMA_UID(), SCHEMA_UID, "child schemaUid must match factory.pccEvidenceSchemaUid");

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
        new PCCProtocolV2(
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

    function test_createEscrowV2_appendedToAllEscrows() public {
        assertEq(factory.getEscrowCount(), 0, "No escrows before first create");

        factory.createEscrowV2(payer, arbiter, address(usdc), CWM_ID);
        assertEq(factory.getEscrowCount(), 1, "One escrow after first create");

        factory.createEscrowV2(payer, arbiter, address(usdc), keccak256("cwm-2"));
        assertEq(factory.getEscrowCount(), 2, "Two escrows after second create");

        // Verify both are registered and distinct
        address a0 = factory.allEscrows(0);
        address a1 = factory.allEscrows(1);
        assertTrue(factory.isProtocolEscrow(a0), "escrow 0 registered");
        assertTrue(factory.isProtocolEscrow(a1), "escrow 1 registered");
        assertTrue(a0 != a1, "Distinct addresses");
    }

    // ── Test 4: EscrowCreated event emitted ─────────────────────────────────

    function test_createEscrowV2_emitsEscrowCreated() public {
        // We do not know the exact escrow address before the call.
        // Use vm.expectEmit with checkTopic1 = false so the first indexed
        // (escrow address) is not required to match.
        //   checkTopic1 (escrow addr) = false
        //   checkTopic2 (payer)       = true
        //   checkTopic3 (arbiter)     = true
        //   checkData   (token, cwmId) = true
        vm.expectEmit(false, true, true, true);
        emit EscrowCreated(address(0), payer, arbiter, address(usdc), CWM_ID);
        address escrowAddr = factory.createEscrowV2(payer, arbiter, address(usdc), CWM_ID);

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

    // ── Test 6: createEscrowV2 reverts on zero payer ─────────────────────────

    function test_createEscrowV2_revert_zeroPayer() public {
        vm.expectRevert("Zero payer");
        factory.createEscrowV2(address(0), arbiter, address(usdc), CWM_ID);
    }

    // ── Test 7: createEscrowV2 reverts on zero token ─────────────────────────

    function test_createEscrowV2_revert_zeroToken() public {
        vm.expectRevert("Zero token");
        factory.createEscrowV2(payer, arbiter, address(0), CWM_ID);
    }
}
