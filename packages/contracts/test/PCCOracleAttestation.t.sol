// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PCCProtocol.sol";
import "../src/PCCVerificationOracle.sol";
import "../src/MilestoneEscrow.sol";
import "../src/MockUSDC.sol";
import {IPCCOracle} from "../src/interfaces/IPCCOracle.sol";

/// @notice Tests for the v10 Attestation schema (version + extraData added).
///         Covers:
///          - Default v1 attestation round-trips through the oracle
///          - version != 1 is rejected by PCCProtocol's defense-in-depth guard
///          - version != 1 is also rejected by the oracle itself
///          - extraData is included in the signing hash (tamper detection)
///          - non-empty extraData on a v1 attestation works (carried, not
///            interpreted) as long as the signature was produced over it
contract PCCOracleAttestationTest is Test {
    PCCProtocol protocol;
    PCCVerificationOracle oracle;
    MockUSDC usdc;
    MilestoneEscrow escrow;

    address constant FEE_RECIPIENT = 0xdDF476D86afD5e2075b8c95CBFfd3d76aEfa4b6B;
    address governor = address(0x10);
    address payer = address(0x1);
    address operator = address(0x2);
    address arbiter = address(0x3);

    // Use a known private key so we can sign off-chain without anvil.
    uint256 oracleSignerKey = 0xA11CE;
    address oracleSigner;

    bytes32 cwmId = keccak256("cwm-oracle-001");
    bytes32 stepId = keccak256("step-oracle-001");

    uint256 constant FEE_BPS = 235; // 2.35%

    function setUp() public {
        oracleSigner = vm.addr(oracleSignerKey);
        oracle = new PCCVerificationOracle(oracleSigner);
        protocol = new PCCProtocol(FEE_RECIPIENT, FEE_BPS, governor, address(oracle));

        usdc = new MockUSDC(1_000_000e6);
        usdc.mint(payer, 100_000e6);

        address escrowAddr = protocol.createEscrow(payer, arbiter, address(usdc), cwmId);
        escrow = MilestoneEscrow(escrowAddr);
    }

    // ── Helpers ────────────────────────────────────────────────────────

    /// @dev Build a canonical v1 attestation (defaults for all fields).
    function _defaultV1(
        address escrowAddr,
        bytes32 evidenceHash,
        uint8 tier
    ) internal view returns (IPCCOracle.Attestation memory a) {
        a.version = 1;
        a.escrowAddress = escrowAddr;
        a.jobId = "job-oracle-001";
        a.evidenceHash = evidenceHash;
        a.tier = tier;
        a.verified = true;
        a.timestamp = block.timestamp;
        a.nonce = keccak256("nonce-1");
        a.extraData = ""; // v1 default
        // signature filled in by _sign
    }

    /// @dev Sign an attestation with the oracle signer key.
    ///      Mirrors PCCVerificationOracle: keccak256(abi.encode(all fields
    ///      except signature)), wrapped in the Ethereum signed-message
    ///      prefix.
    function _sign(
        IPCCOracle.Attestation memory a
    ) internal view returns (bytes memory sig) {
        bytes32 msgHash = keccak256(
            abi.encode(
                a.version,
                a.escrowAddress,
                a.jobId,
                a.evidenceHash,
                a.tier,
                a.verified,
                a.timestamp,
                a.nonce,
                a.extraData
            )
        );
        bytes32 ethHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oracleSignerKey, ethHash);
        sig = abi.encodePacked(r, s, v);
    }

    function _signedV1() internal view returns (IPCCOracle.Attestation memory) {
        IPCCOracle.Attestation memory a = _defaultV1(
            address(escrow),
            keccak256("evidence-bytes"),
            1
        );
        a.signature = _sign(a);
        return a;
    }

    // ── Happy path ────────────────────────────────────────────────────

    function test_verifyOracleAttestation_v1_ok() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        assertTrue(protocol.verifyOracleAttestation(a), "v1 attestation should verify");
        assertTrue(oracle.verifyAttestation(a), "oracle should verify v1");
    }

    function test_signingHashHelper_matchesExpected() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        bytes32 expected = keccak256(
            abi.encode(
                a.version,
                a.escrowAddress,
                a.jobId,
                a.evidenceHash,
                a.tier,
                a.verified,
                a.timestamp,
                a.nonce,
                a.extraData
            )
        );
        assertEq(oracle.signingHash(a), expected);
    }

    // ── Version guard ─────────────────────────────────────────────────

    function test_verifyOracleAttestation_rejectsUnsupportedVersion() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        a.version = 2; // bump → invalidates signature AND hits version guard
        assertFalse(
            protocol.verifyOracleAttestation(a),
            "v2 attestation should be rejected"
        );
    }

    function test_oracle_rejectsUnsupportedVersion_directly() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        a.version = 2;
        assertFalse(
            oracle.verifyAttestation(a),
            "oracle itself should reject v2"
        );
    }

    function test_oracle_rejectsVersionZero() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        a.version = 0;
        assertFalse(oracle.verifyAttestation(a), "v0 should be rejected");
    }

    function test_collectFeeWithAttestation_rejectsUnsupportedVersion() public {
        // Setup: fund escrow, reach the release step, then attempt
        // collectFeeWithAttestation directly with a v2 attestation.
        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, 1000e6, 0, 3600);
        usdc.approve(address(escrow), 1000e6);
        escrow.fund();
        vm.stopPrank();

        IPCCOracle.Attestation memory a = _signedV1();
        a.version = 7; // unsupported
        a.signature = _sign(a); // re-sign so oracle sig check isn't the failure mode

        // Only a factory escrow can call collectFeeWithAttestation, so
        // impersonate the escrow's address.
        vm.prank(address(escrow));
        vm.expectRevert("PCC: unsupported attestation version");
        protocol.collectFeeWithAttestation(address(usdc), 10e6, a);
    }

    function test_collectFeeWithAttestation_v1_ok() public {
        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, 1000e6, 0, 3600);
        usdc.approve(address(escrow), 1000e6);
        escrow.fund();
        vm.stopPrank();

        IPCCOracle.Attestation memory a = _signedV1();

        // Simulate the escrow calling into the protocol post-release.
        vm.prank(address(escrow));
        protocol.collectFeeWithAttestation(address(usdc), 10e6, a);

        assertEq(protocol.feesFromEscrow(address(escrow)), 10e6);
    }

    // ── extraData: signing-hash tamper detection ──────────────────────

    function test_extraData_tamperedAfterSigning_rejected() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        // Attacker swaps in new extraData after the oracle signed.
        a.extraData = abi.encode(uint256(42));
        assertFalse(
            oracle.verifyAttestation(a),
            "tampering extraData must invalidate signature"
        );
    }

    function test_extraData_nonEmpty_v1_verifiesWhenSignedOver() public view {
        // A v1 attestation is allowed to carry non-empty extraData; v1 does
        // not interpret it, but the signing hash must cover it. Signing
        // OVER the non-empty extraData must verify.
        IPCCOracle.Attestation memory a = _defaultV1(
            address(escrow),
            keccak256("evidence-with-extra"),
            2
        );
        a.extraData = abi.encode(bytes32("forward-compat-ping"));
        a.signature = _sign(a);
        assertTrue(
            oracle.verifyAttestation(a),
            "v1 with non-empty extraData signed over it must verify"
        );
    }

    function test_signatureHash_differs_forDifferentExtraData() public view {
        IPCCOracle.Attestation memory a = _defaultV1(
            address(escrow),
            keccak256("evidence-distinct"),
            1
        );
        // Solidity memory structs pass by reference, not value — we need
        // to build `b` independently so mutating extraData on one doesn't
        // touch the other.
        IPCCOracle.Attestation memory b = _defaultV1(
            address(escrow),
            keccak256("evidence-distinct"),
            1
        );
        // Normalize the unsigned-per-call fields so extraData is the only
        // difference (nonce is hardcoded in _defaultV1).
        b.timestamp = a.timestamp;

        a.extraData = abi.encode(uint256(1));
        b.extraData = abi.encode(uint256(2));

        // Same everything except extraData → signing hashes must differ.
        assertTrue(
            oracle.signingHash(a) != oracle.signingHash(b),
            "extraData must change signing hash"
        );
    }

    // ── version tamper detection ──────────────────────────────────────

    function test_version_tamperedAfterSigning_rejected() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        a.version = 1; // still v1 but re-check guard
        assertTrue(oracle.verifyAttestation(a), "untouched v1 verifies");

        a.version = 2;
        assertFalse(
            oracle.verifyAttestation(a),
            "bumping version without re-signing must not verify"
        );
    }

    // ── signature sanity ──────────────────────────────────────────────

    function test_otherField_tamper_rejected() public view {
        IPCCOracle.Attestation memory a = _signedV1();
        a.tier = 3; // was 1 when signed
        assertFalse(
            oracle.verifyAttestation(a),
            "tampering tier must invalidate signature"
        );
    }

    function test_wrongSigner_rejected() public view {
        IPCCOracle.Attestation memory a = _defaultV1(
            address(escrow),
            keccak256("evidence-wrong-signer"),
            1
        );
        // Sign with a DIFFERENT private key.
        uint256 attackerKey = 0xBAD;
        bytes32 msgHash = keccak256(
            abi.encode(
                a.version,
                a.escrowAddress,
                a.jobId,
                a.evidenceHash,
                a.tier,
                a.verified,
                a.timestamp,
                a.nonce,
                a.extraData
            )
        );
        bytes32 ethHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", msgHash)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attackerKey, ethHash);
        a.signature = abi.encodePacked(r, s, v);

        assertFalse(
            oracle.verifyAttestation(a),
            "signature by non-oracle signer must be rejected"
        );
    }

    // ── release flow: extraData carried through, not interpreted ──────

    function test_release_withExtraDataPayload_carriesThrough() public {
        // The MilestoneEscrow.release() path does NOT go through
        // collectFeeWithAttestation (it uses collectFee). But we want
        // to document that a v1 extraData payload is a no-op for
        // settlement: non-empty extraData on a valid v1 attestation
        // still lets collectFeeWithAttestation succeed.
        vm.startPrank(payer);
        escrow.addMilestone(stepId, operator, 500e6, 0, 3600);
        usdc.approve(address(escrow), 500e6);
        escrow.fund();
        vm.stopPrank();

        IPCCOracle.Attestation memory a = _defaultV1(
            address(escrow),
            keccak256("evidence-payload"),
            1
        );
        a.extraData = abi.encode("forward-compat-scratchpad");
        a.signature = _sign(a);

        vm.prank(address(escrow));
        protocol.collectFeeWithAttestation(address(usdc), 5e6, a);

        assertEq(protocol.feesFromEscrow(address(escrow)), 5e6);
    }

    // ── SUPPORTED_ATTESTATION_VERSION constant ────────────────────────

    function test_protocol_exposesSupportedAttestationVersion() public view {
        assertEq(protocol.SUPPORTED_ATTESTATION_VERSION(), 1);
    }

    function test_oracle_exposesSupportedVersion() public view {
        assertEq(oracle.SUPPORTED_VERSION(), 1);
    }
}
