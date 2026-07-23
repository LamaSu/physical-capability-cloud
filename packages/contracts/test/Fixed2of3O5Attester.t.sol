// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {O5AttesterBase} from "../src/attesters/O5AttesterBase.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {SingleSignerO5Attester} from "../src/attesters/SingleSignerO5Attester.sol";
import {O5Verdict, O5_DECISION_SETTLE} from "../src/O5Types.sol";
import {AttestationRequest} from "../src/interfaces/IEAS.sol";
import {VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";

/// @dev EAS write double: records each `attest` and returns a deterministic uid so the test can assert
///      the schema / recipient / payload the attester minted. Mirrors the fields the real escrow reads.
contract MockAttestEAS {
    uint256 public n;

    mapping(bytes32 => bytes32) public schemaOf;
    mapping(bytes32 => address) public recipientOf;
    mapping(bytes32 => bytes) public dataOf;
    mapping(bytes32 => bool) public revocableOf;

    function attest(AttestationRequest calldata r) external payable returns (bytes32 uid) {
        uid = keccak256(abi.encode(r.schema, r.data.recipient, r.data.data, n));
        n += 1;
        schemaOf[uid] = r.schema;
        recipientOf[uid] = r.data.recipient;
        dataOf[uid] = r.data.data;
        revocableOf[uid] = r.data.revocable;
    }
}

contract Fixed2of3O5AttesterTest is Test {
    MockAttestEAS mockEas;
    Fixed2of3O5Attester attester;
    SingleSignerO5Attester single;

    uint256 constant pk1 = 0xA11CE;
    uint256 constant pk2 = 0xB0B;
    uint256 constant pk3 = 0xC0FFEE;
    uint256 constant pkS = 0xD00D; // testnet single signer
    uint256 constant pkX = 0xDEAD; // NOT in any signer set

    address constant REVOKER = address(0xDEC0DE);
    uint64 constant COHORT = 42;
    bytes32 constant O5_SCHEMA = keccak256("o5.schema.v1.1");
    address constant ESCROW = address(0xE5C0F);
    bytes32 constant JOB = keccak256("attester-job");
    uint256 constant MI = 3;
    bytes32 constant STEP = keccak256("attester-step");

    // secp256k1 group order (for the high-s malleability construction).
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        mockEas = new MockAttestEAS();
        attester = new Fixed2of3O5Attester(
            vm.addr(pk1), vm.addr(pk2), vm.addr(pk3), address(mockEas), O5_SCHEMA, COHORT, REVOKER
        );
        single = new SingleSignerO5Attester(vm.addr(pkS), address(mockEas), O5_SCHEMA, COHORT, REVOKER);
    }

    // ── helpers ────────────────────────────────────────────────────────────────────────────────────
    function _verdict() internal view returns (O5Verdict memory v) {
        bytes32 suid = VNextSettlementLib.computeSettlementUnitId(block.chainid, ESCROW, JOB, MI, STEP);
        v = O5Verdict({
            jobIdHash: JOB,
            milestoneIndex: MI,
            stepId: STEP,
            evidenceBundleHash: keccak256("eb"),
            achievedTier: 2,
            requestedTier: 2,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("vh"),
            feeBps: 235,
            feeRecipient: address(0xFEE0),
            feeScheduleHash: keccak256("fh"),
            settlementUnitId: suid,
            oracleAuthEpoch: COHORT,
            compositionRoot: keccak256("cr")
        });
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Two signatures ordered so the RECOVERED signers ascend (what the 2-of-3 rule requires).
    function _twoSigsAscending(uint256 pkA, uint256 pkB, bytes32 digest) internal pure returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        if (vm.addr(pkA) < vm.addr(pkB)) {
            sigs[0] = _sig(pkA, digest);
            sigs[1] = _sig(pkB, digest);
        } else {
            sigs[0] = _sig(pkB, digest);
            sigs[1] = _sig(pkA, digest);
        }
    }

    // ── Fixed 2-of-3 (mainnet) ───────────────────────────────────────────────────────────────────────
    function test_TwoOfThree_Mints() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, digest);

        bytes32 uid = attester.attestO5(v, ESCROW, sigs);

        assertEq(mockEas.schemaOf(uid), O5_SCHEMA, "minted with the pinned O5 schema");
        assertEq(mockEas.recipientOf(uid), ESCROW, "recipient == the settling escrow");
        assertEq(keccak256(mockEas.dataOf(uid)), keccak256(abi.encode(v)), "payload == abi.encode(O5Verdict)");
        assertEq(mockEas.dataOf(uid).length, 448, "payload is the 448-byte O5 layout");
        assertFalse(mockEas.revocableOf(uid), "O5 mints are non-revocable");
        assertTrue(attester.usedUnit(v.settlementUnitId), "unit consumed");
    }

    function test_AnyValidPair_Mints() public {
        // the 1+3 and 2+3 pairs are equally valid quorums, not just 1+2.
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        attester.attestO5(v, ESCROW, _twoSigsAscending(pk2, pk3, digest));
        assertTrue(attester.usedUnit(v.settlementUnitId));
    }

    function test_OneSig_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(pk1, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.WrongSignatureCount.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    function test_ThreeSigs_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        bytes[] memory sigs = new bytes[](3);
        sigs[0] = _sig(pk1, digest);
        sigs[1] = _sig(pk2, digest);
        sigs[2] = _sig(pk3, digest);
        vm.expectRevert(O5AttesterBase.WrongSignatureCount.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    function test_DuplicateSigner_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(pk1, digest);
        sigs[1] = _sig(pk1, digest); // same signer twice — not strictly ascending
        vm.expectRevert(O5AttesterBase.SignersNotSortedOrUnique.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    function test_Unsorted_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        bytes[] memory asc = _twoSigsAscending(pk1, pk2, digest);
        bytes[] memory desc = new bytes[](2);
        desc[0] = asc[1]; // descending order
        desc[1] = asc[0];
        vm.expectRevert(O5AttesterBase.SignersNotSortedOrUnique.selector);
        attester.attestO5(v, ESCROW, desc);
    }

    function test_NonSigner_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        // one valid signer + one outsider, ascending
        bytes[] memory sigs = _twoSigsAscending(pk1, pkX, digest);
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    function test_HighS_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk1, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s)); // flip to the malleable high-s form
        uint8 flipV = vv == 27 ? 28 : 27;
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = abi.encodePacked(r, highS, flipV);
        sigs[1] = _sig(pk2, digest);
        vm.expectRevert(O5AttesterBase.MalleableSignature.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    function test_Disabled_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.prank(REVOKER);
        attester.disable();
        assertFalse(attester.enabled());
        vm.expectRevert(O5AttesterBase.CohortIsDisabled.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    function test_DisableOnlyRevoker_Reverts() public {
        vm.expectRevert(O5AttesterBase.OnlyRevoker.selector);
        attester.disable(); // msg.sender is the test contract, not the revoker
    }

    function test_SecondAttestSameUnit_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        attester.attestO5(v, ESCROW, _twoSigsAscending(pk1, pk2, digest));
        // second, fully-valid attestation for the same settlementUnitId is rejected (consume-once).
        vm.expectRevert(O5AttesterBase.UnitAlreadyAttested.selector);
        attester.attestO5(v, ESCROW, _twoSigsAscending(pk1, pk2, digest));
    }

    function test_CohortMismatch_Reverts() public {
        O5Verdict memory v = _verdict();
        v.oracleAuthEpoch = COHORT + 1; // verdict claims a different cohort
        bytes32 digest = attester.digestOf(v);
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, digest);
        vm.expectRevert(O5AttesterBase.CohortMismatch.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    function test_EscrowMismatch_Reverts() public {
        O5Verdict memory v = _verdict(); // settlementUnitId computed for ESCROW
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.EscrowVerdictMismatch.selector);
        attester.attestO5(v, address(0xBAD), sigs); // a different recipient than the verdict was signed for
    }

    // ── Single signer (testnet) ──────────────────────────────────────────────────────────────────────
    function test_Single_Mints() public {
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(pkS, single.digestOf(v));
        bytes32 uid = single.attestO5(v, ESCROW, sigs);
        assertEq(mockEas.recipientOf(uid), ESCROW);
        assertTrue(single.usedUnit(v.settlementUnitId));
    }

    function test_Single_WrongSigner_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(pk1, single.digestOf(v)); // pk1 is not the single signer
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        single.attestO5(v, ESCROW, sigs);
    }

    function test_Single_TwoSigs_Reverts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = single.digestOf(v);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sig(pkS, digest);
        sigs[1] = _sig(pkS, digest);
        vm.expectRevert(O5AttesterBase.WrongSignatureCount.selector);
        single.attestO5(v, ESCROW, sigs);
    }

    // ── constructor guards ───────────────────────────────────────────────────────────────────────────
    function test_Constructor_RejectsDuplicateSigner() public {
        vm.expectRevert(O5AttesterBase.DuplicateSigner.selector);
        new Fixed2of3O5Attester(vm.addr(pk1), vm.addr(pk1), vm.addr(pk3), address(mockEas), O5_SCHEMA, COHORT, REVOKER);
    }

    function test_Constructor_RejectsZeroSigner() public {
        vm.expectRevert(O5AttesterBase.ZeroSigner.selector);
        new Fixed2of3O5Attester(vm.addr(pk1), address(0), vm.addr(pk3), address(mockEas), O5_SCHEMA, COHORT, REVOKER);
    }
}
