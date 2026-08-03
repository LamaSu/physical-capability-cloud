// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {O5AttesterBase} from "../src/attesters/O5AttesterBase.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {SingleSignerO5Attester} from "../src/attesters/SingleSignerO5Attester.sol";
import {
    O5Verdict,
    O5Assertion,
    O5Adjudication,
    O5AdjudicationRecord,
    O5_DECISION_SETTLE,
    O5_ADJ_ROLE_APPEAL,
    O5_ADJ_ROLE_EMERGENCY,
    O5_ADJ_UPHOLD,
    O5_ADJ_OVERTURN
} from "../src/O5Types.sol";
import {AttestationRequest} from "../src/interfaces/IEAS.sol";
import {VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";

/// @dev Settlement-escrow READ double for the M-01 anti-brick pre-check: mirrors the two binding getters
///      {VNextSettlementEscrow} exposes — a settable per-unit composition root, and a committed evidence
///      commitment that REVERTS while uncommitted (exactly as the real escrow's `evidenceBundleHashOf`
///      does) — plus a switch to model a unit that was never funded.
contract MockEscrowBinding {
    mapping(bytes32 => bytes32) public root;
    mapping(bytes32 => bytes32) internal _bundle;
    mapping(bytes32 => bool) public committed;
    mapping(bytes32 => bytes32) public feeHash;
    mapping(bytes32 => uint16) public feeBpsVal; // M-01: the raw frozen feeBps mirror
    mapping(bytes32 => address) public feeRecipVal; // M-01: the raw frozen feeRecipient mirror
    mapping(bytes32 => uint8) public tier;
    bool public reverts;

    error UnitNotFound();
    error EvidenceNotCommitted();

    function setRoot(bytes32 unitId, bytes32 r) external {
        root[unitId] = r;
    }

    function setFeeScheduleHash(bytes32 unitId, bytes32 h) external {
        feeHash[unitId] = h;
    }

    function setFeeBps(bytes32 unitId, uint16 b) external {
        feeBpsVal[unitId] = b;
    }

    function setFeeRecipient(bytes32 unitId, address a) external {
        feeRecipVal[unitId] = a;
    }

    function setRequiredTier(bytes32 unitId, uint8 t) external {
        tier[unitId] = t;
    }

    function feeScheduleHashOf(bytes32 unitId) external view returns (bytes32) {
        if (reverts) revert UnitNotFound();
        return feeHash[unitId];
    }

    function feeBpsOf(bytes32 unitId) external view returns (uint16) {
        if (reverts) revert UnitNotFound();
        return feeBpsVal[unitId];
    }

    function feeRecipientOf(bytes32 unitId) external view returns (address) {
        if (reverts) revert UnitNotFound();
        return feeRecipVal[unitId];
    }

    function requiredTierOf(bytes32 unitId) external view returns (uint8) {
        if (reverts) revert UnitNotFound();
        return tier[unitId];
    }

    function setEvidence(bytes32 unitId, bytes32 commitment) external {
        _bundle[unitId] = commitment;
        committed[unitId] = true;
    }

    function clearEvidence(bytes32 unitId) external {
        delete _bundle[unitId];
        committed[unitId] = false;
    }

    function setReverts(bool r) external {
        reverts = r;
    }

    function compositionRootOf(bytes32 unitId) external view returns (bytes32) {
        if (reverts) revert UnitNotFound();
        return root[unitId];
    }

    function evidenceBundleHashOf(bytes32 unitId) external view returns (bytes32) {
        if (reverts) revert UnitNotFound();
        if (!committed[unitId]) revert EvidenceNotCommitted();
        return _bundle[unitId];
    }

    /// @dev H-01 Wave 3: the assertion the escrow ACCEPTED for this unit. Zero while nothing is accepted,
    ///      which is what makes an adjudication over an unaccepted unit fail closed at the attester.
    mapping(bytes32 => bytes32) public acceptedAssertionIdOf;

    function setAcceptedAssertionId(bytes32 unitId, bytes32 a) external {
        acceptedAssertionIdOf[unitId] = a;
    }
}

/// @dev An escrow whose getter returns a NON-32-byte payload — the fail-closed length guard's target.
contract MockEscrowBadReturn {
    fallback() external {
        assembly {
            mstore(0, 1)
            return(0, 64) // two words where exactly one is required
        }
    }
}

/// @dev EAS write double: records each `attest` and returns a deterministic uid so the test can assert
///      the schema / recipient / payload the attester minted. Mirrors the fields the real escrow reads.
contract MockAttestEAS {
    uint256 public n;
    bool public returnZeroUid; // L-02: model an EAS that returns a zero uid (misbehaving/misconfigured)

    mapping(bytes32 => bytes32) public schemaOf;
    mapping(bytes32 => address) public recipientOf;
    mapping(bytes32 => bytes) public dataOf;
    mapping(bytes32 => bool) public revocableOf;

    function setReturnZeroUid(bool z) external {
        returnZeroUid = z;
    }

    function attest(AttestationRequest calldata r) external payable returns (bytes32 uid) {
        if (returnZeroUid) return bytes32(0);
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
    MockEscrowBinding escrowBinding;
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
    /// @dev the settling escrow — a real contract, because attestO5 now STATICCALLs its composition root.
    address ESCROW;
    bytes32 constant JOB = keccak256("attester-job");
    uint256 constant MI = 3;
    bytes32 constant STEP = keccak256("attester-step");
    bytes32 constant ROOT = keccak256("cr"); // the escrow's funding-frozen composition root
    bytes32 constant BUNDLE = keccak256("committed-evidence-commitment"); // the escrow's committed §B value
    bytes32 constant FEE_HASH = keccak256("fh"); // the escrow's frozen 13-field feeScheduleHash
    uint16 constant FEE_BPS = 235; // the escrow's frozen raw feeBps mirror (M-01)
    address constant FEE_RECIP = address(0xFEE0); // the escrow's frozen raw feeRecipient mirror (M-01)
    uint8 constant REQUIRED_TIER = 2; // == requestedTier, frozen at funding (§E)

    // secp256k1 group order (for the high-s malleability construction).
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function setUp() public {
        mockEas = new MockAttestEAS();
        escrowBinding = new MockEscrowBinding();
        ESCROW = address(escrowBinding);
        attester = new Fixed2of3O5Attester(
            vm.addr(pk1), vm.addr(pk2), vm.addr(pk3), address(mockEas), O5_SCHEMA, COHORT, REVOKER
        );
        single = new SingleSignerO5Attester(vm.addr(pkS), address(mockEas), O5_SCHEMA, COHORT, REVOKER);
        // the escrow's funding-frozen state + the committed package; the quorum must echo all of it.
        escrowBinding.setRoot(_suid(), ROOT);
        escrowBinding.setEvidence(_suid(), BUNDLE);
        escrowBinding.setFeeScheduleHash(_suid(), FEE_HASH);
        escrowBinding.setFeeBps(_suid(), FEE_BPS);
        escrowBinding.setFeeRecipient(_suid(), FEE_RECIP);
        escrowBinding.setRequiredTier(_suid(), REQUIRED_TIER);
    }

    // ── helpers ────────────────────────────────────────────────────────────────────────────────────
    function _suid() internal view returns (bytes32) {
        return VNextSettlementLib.computeSettlementUnitId(block.chainid, ESCROW, JOB, MI, STEP);
    }

    function _verdict() internal view returns (O5Verdict memory v) {
        bytes32 suid = _suid();
        v = O5Verdict({
            jobIdHash: JOB,
            milestoneIndex: MI,
            stepId: STEP,
            evidenceBundleHash: BUNDLE,
            achievedTier: REQUIRED_TIER,
            requestedTier: REQUIRED_TIER,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("vh"),
            feeBps: FEE_BPS,
            feeRecipient: FEE_RECIP,
            feeScheduleHash: FEE_HASH,
            settlementUnitId: suid,
            oracleAuthEpoch: COHORT,
            compositionRoot: ROOT
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

    /// @dev P0-6 OBSERVATION POINT. These tests used to prove "a write happened" by reading the EAS mock's
    ///      recorded attestation. `attestO5` no longer touches EAS, so the same property is now read off
    ///      the ASSERTION RECORD -- the thing the escrow's money path actually consumes. Every field the
    ///      escrow re-checks at release is asserted here, so a record that dropped or mis-copied one would
    ///      fail loudly instead of silently authorizing the wrong economics.
    function _assertRecordBound(O5AttesterBase a, O5Verdict memory v, bytes32 returnedId) internal view {
        O5Assertion memory rec = a.assertionOf(v.settlementUnitId);
        assertEq(rec.assertionId, returnedId, "record carries the id attestO5 returned");
        assertEq(rec.assertionId, a.digestOf(v), "the id IS the EIP-712 digest over the FULL signed verdict");
        assertTrue(rec.assertionId != bytes32(0), "a live record is never the zero record");
        assertEq(rec.escrow, ESCROW, "bound to the settling escrow (was: EAS attestation recipient)");
        assertEq(uint256(rec.assertedAt), block.timestamp, "assertion time (was: EAS attestation time)");
        assertEq(uint256(rec.decision), uint256(O5_DECISION_SETTLE), "SETTLE-only");
        assertEq(uint256(rec.achievedTier), uint256(v.achievedTier), "achievedTier");
        assertEq(uint256(rec.requestedTier), uint256(v.requestedTier), "requestedTier");
        assertEq(rec.feeScheduleHash, v.feeScheduleHash, "feeScheduleHash");
        assertEq(uint256(rec.feeBps), uint256(v.feeBps), "raw feeBps (M-01)");
        assertEq(rec.feeRecipient, v.feeRecipient, "raw feeRecipient (M-01)");
        assertEq(uint256(rec.oracleAuthEpoch), uint256(v.oracleAuthEpoch), "cohort epoch");
        assertEq(rec.compositionRoot, v.compositionRoot, "compositionRoot");
        assertEq(rec.evidenceBundleHash, v.evidenceBundleHash, "evidenceBundleHash");
        assertTrue(a.usedUnit(v.settlementUnitId), "the unit one-verdict slot is consumed");
        assertEq(a.mirroredUid(v.settlementUnitId), bytes32(0), "asserting did NOT touch EAS");
    }

    // ── Fixed 2-of-3 (mainnet) ───────────────────────────────────────────────────────────────────────
    /// @dev MIGRATED from `test_TwoOfThree_Mints`. A valid quorum now writes the direct cohort assertion
    ///      instead of minting into EAS, so the assertions move to the record. The EAS-shaped properties
    ///      this test used to own (pinned schema, escrow recipient, byte-exact 448-B payload,
    ///      non-revocable) are NOT dropped -- they move to `test_Mirror_MintsPinnedSchemaAndExactPayload`,
    ///      which asserts them where the mint now happens.
    function test_TwoOfThree_Asserts() public {
        O5Verdict memory v = _verdict();
        bytes32 digest = attester.digestOf(v);
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, digest);

        bytes32 assertionId = attester.attestO5(v, ESCROW, sigs);

        assertEq(assertionId, digest, "the quorum-signed digest is the assertion id");
        _assertRecordBound(attester, v, assertionId);
    }

    /// @dev The EAS-mint properties migrated out of `test_TwoOfThree_Mints`, asserted on the ASYNC mirror.
    ///      Same guarantees, now off the money path: pinned schema, the settling escrow as recipient, the
    ///      byte-exact 448-byte O5 payload, and non-revocable.
    function test_Mirror_MintsPinnedSchemaAndExactPayload() public {
        O5Verdict memory v = _verdict();
        attester.attestO5(v, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(v)));

        bytes32 uid = attester.mirrorToEAS(v);

        assertEq(mockEas.schemaOf(uid), O5_SCHEMA, "mirrored with the pinned O5 schema");
        assertEq(mockEas.recipientOf(uid), ESCROW, "recipient == the settling escrow");
        assertEq(keccak256(mockEas.dataOf(uid)), keccak256(abi.encode(v)), "payload == abi.encode(O5Verdict)");
        assertEq(mockEas.dataOf(uid).length, 448, "payload is the 448-byte O5 layout");
        assertFalse(mockEas.revocableOf(uid), "O5 mirrors are non-revocable");
        assertEq(attester.mirroredUid(v.settlementUnitId), uid, "drained from the mirror queue");
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

    /// @dev P0-6 CONSUME-ONCE + IMMUTABILITY. On the EAS rail the consume-once marker was a bool that no
    ///      code path could alter. It is now a whole RECORD that the escrow's money path reads field by
    ///      field, so "written exactly once and never mutated" has to be asserted, not assumed: a second
    ///      quorum — signing a DIFFERENT but individually-valid verdict for the same unit — must not
    ///      overwrite a single field of the first. Every field is compared before and after.
    function test_AssertionIsConsumeOnce_AndImmutable() public {
        O5Verdict memory first = _verdict();
        bytes32 firstId = attester.attestO5(first, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(first)));
        O5Assertion memory before = attester.assertionOf(first.settlementUnitId);

        // A second verdict for the SAME unit, differing in fields the escrow reads, with a genuine quorum
        // from a different valid signer pair, submitted later in time.
        O5Verdict memory second = _verdict();
        second.achievedTier = 3; // still >= requiredTier, so it would pass the pre-checks on its own
        second.verdictHash = keccak256("a-second-verdict-document");
        // Sign BEFORE `expectRevert`: `digestOf` is an external call, and an argument expression is
        // evaluated first, so an inline `attester.digestOf(...)` would consume the expectRevert itself.
        bytes[] memory secondSigs = _twoSigsAscending(pk2, pk3, attester.digestOf(second));
        vm.warp(block.timestamp + 7 days);
        vm.expectRevert(O5AttesterBase.UnitAlreadyAttested.selector);
        attester.attestO5(second, ESCROW, secondSigs);

        O5Assertion memory afterAttempt = attester.assertionOf(first.settlementUnitId);
        assertEq(afterAttempt.assertionId, firstId, "assertionId immutable");
        assertEq(afterAttempt.assertionId, before.assertionId, "assertionId unchanged");
        assertEq(uint256(afterAttempt.achievedTier), uint256(before.achievedTier), "achievedTier immutable");
        assertEq(uint256(afterAttempt.requestedTier), uint256(before.requestedTier), "requestedTier immutable");
        assertEq(uint256(afterAttempt.decision), uint256(before.decision), "decision immutable");
        assertEq(afterAttempt.feeScheduleHash, before.feeScheduleHash, "feeScheduleHash immutable");
        assertEq(uint256(afterAttempt.feeBps), uint256(before.feeBps), "feeBps immutable");
        assertEq(afterAttempt.feeRecipient, before.feeRecipient, "feeRecipient immutable");
        assertEq(afterAttempt.compositionRoot, before.compositionRoot, "compositionRoot immutable");
        assertEq(afterAttempt.evidenceBundleHash, before.evidenceBundleHash, "evidenceBundleHash immutable");
        assertEq(uint256(afterAttempt.oracleAuthEpoch), uint256(before.oracleAuthEpoch), "epoch immutable");
        assertEq(afterAttempt.escrow, before.escrow, "bound escrow immutable");
        assertEq(uint256(afterAttempt.assertedAt), uint256(before.assertedAt), "assertedAt not re-stamped");
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
    function test_Single_Asserts() public {
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = new bytes[](1);
        sigs[0] = _sig(pkS, single.digestOf(v));
        bytes32 assertionId = single.attestO5(v, ESCROW, sigs);
        _assertRecordBound(single, v, assertionId);
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

    /// @dev L-03 separation of duties: a key that both signs and holds the kill-switch could disable the
    ///      cohort on its own (availability attack → every honest unit forced to refund).
    function test_Constructor_RejectsRevokerAsSigner() public {
        vm.expectRevert(O5AttesterBase.RevokerIsSigner.selector);
        new Fixed2of3O5Attester(
            vm.addr(pk1), vm.addr(pk2), vm.addr(pk3), address(mockEas), O5_SCHEMA, COHORT, vm.addr(pk2)
        );
    }

    /// @dev L-03 parity: the single-signer testnet cohort must reject a revoker == its signer too.
    function test_Single_Constructor_RejectsRevokerAsSigner() public {
        vm.expectRevert(O5AttesterBase.RevokerIsSigner.selector);
        new SingleSignerO5Attester(vm.addr(pkS), address(mockEas), O5_SCHEMA, COHORT, vm.addr(pkS));
    }

    // ── M-01: escrow composition-root pre-check (anti-brick) ─────────────────────────────────────────
    /// @dev THE M-01 regression: a verdict echoing a stale root must NOT consume the unit's one-verdict
    ///      slot, and the corrected verdict must still mint afterwards.
    function test_WrongCompositionRoot_Reverts_AndLeavesUnitMintable() public {
        O5Verdict memory stale = _verdict();
        stale.compositionRoot = keccak256("stale-root-from-a-bad-source");
        bytes[] memory staleSigs = _twoSigsAscending(pk1, pk2, attester.digestOf(stale));

        vm.expectRevert(O5AttesterBase.CompositionRootMismatch.selector);
        attester.attestO5(stale, ESCROW, staleSigs);

        // the slot is untouched — the corrected verdict (echoing the escrow's frozen root) still mints.
        assertFalse(attester.usedUnit(stale.settlementUnitId), "wrong-root verdict must not consume the unit");
        O5Verdict memory good = _verdict();
        bytes32 id = attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        _assertRecordBound(attester, good, id); // corrected verdict asserts for the same unit
    }

    /// @dev SETTLE-only guard: a non-SETTLE verdict — even with a VALID quorum — must revert WITHOUT
    ///      consuming the unit's one-verdict slot, so a later real SETTLE verdict still mints for the same
    ///      unit. Without the guard, a buggy/compromised signer set could brick the unit to refund-only.
    function test_NonSettleVerdict_Reverts_AndLeavesUnitMintable() public {
        O5Verdict memory bad = _verdict();
        bad.decision = 2; // anything != O5_DECISION_SETTLE (hold/reject carry no on-chain attestation)
        bytes[] memory badSigs = _twoSigsAscending(pk1, pk2, attester.digestOf(bad)); // a genuine quorum

        vm.expectRevert(O5AttesterBase.NotSettleVerdict.selector);
        attester.attestO5(bad, ESCROW, badSigs);
        assertFalse(attester.usedUnit(bad.settlementUnitId), "a non-SETTLE verdict must not consume the unit");

        // the slot survived -- the real SETTLE verdict still asserts for the same unit.
        O5Verdict memory good = _verdict();
        bytes32 id = attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        _assertRecordBound(attester, good, id);
    }

    /// @dev §B twin of the above: a verdict over a package the escrow did NOT commit to must not consume
    ///      the slot either — the escrow would reject it with EvidenceBundleMismatch at release.
    function test_WrongEvidenceBundle_Reverts_AndLeavesUnitMintable() public {
        O5Verdict memory wrong = _verdict();
        wrong.evidenceBundleHash = keccak256("a-package-the-escrow-never-committed");
        bytes[] memory wrongSigs = _twoSigsAscending(pk1, pk2, attester.digestOf(wrong));
        vm.expectRevert(O5AttesterBase.EvidenceBundleMismatch.selector);
        attester.attestO5(wrong, ESCROW, wrongSigs);
        assertFalse(attester.usedUnit(wrong.settlementUnitId), "wrong-bundle verdict must not consume the unit");

        O5Verdict memory good = _verdict();
        attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        assertTrue(attester.usedUnit(good.settlementUnitId));
    }

    /// @dev The highest-likelihood M-01 variant: `feeScheduleHash` is a computed 13-field digest, so a
    ///      stale fee mirror is the mismatch most likely to reach a signing quorum. Burning the slot on it
    ///      would make the unit unsettleable forever (release reverts FeeHashMismatch) — so it must revert
    ///      here instead, and the corrected verdict must still mint.
    function test_WrongFeeScheduleHash_Reverts_AndLeavesUnitMintable() public {
        O5Verdict memory stale = _verdict();
        stale.feeScheduleHash = keccak256("a-stale-fee-schedule-mirror");
        bytes[] memory staleSigs = _twoSigsAscending(pk1, pk2, attester.digestOf(stale));
        vm.expectRevert(O5AttesterBase.FeeHashMismatch.selector);
        attester.attestO5(stale, ESCROW, staleSigs);
        assertFalse(attester.usedUnit(stale.settlementUnitId), "wrong-fee-hash verdict must not consume the unit");

        O5Verdict memory good = _verdict();
        bytes32 id = attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        _assertRecordBound(attester, good, id); // corrected verdict asserts for the same unit
    }

    /// @dev M-01: a verdict echoing a false `feeBps` — even beside the CORRECT `feeScheduleHash` — must not
    ///      consume the slot. The permanent attestation would otherwise record false economics that
    ///      downstream indexers/receipts read raw, and the escrow re-checks the field at release, so burning
    ///      the slot here would strand the unit. The corrected verdict must still mint.
    function test_WrongFeeBps_Reverts_AndLeavesUnitMintable() public {
        O5Verdict memory bad = _verdict();
        bad.feeBps = FEE_BPS + 1; // != the escrow's frozen 235, though feeScheduleHash stays correct
        bytes[] memory badSigs = _twoSigsAscending(pk1, pk2, attester.digestOf(bad));
        vm.expectRevert(O5AttesterBase.FeeBpsMismatch.selector);
        attester.attestO5(bad, ESCROW, badSigs);
        assertFalse(attester.usedUnit(bad.settlementUnitId), "wrong-feeBps verdict must not consume the unit");

        O5Verdict memory good = _verdict();
        bytes32 id = attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        _assertRecordBound(attester, good, id); // corrected verdict asserts for the same unit
    }

    /// @dev M-01 twin: a false `feeRecipient` (correct hash) must not consume the slot either.
    function test_WrongFeeRecipient_Reverts_AndLeavesUnitMintable() public {
        O5Verdict memory bad = _verdict();
        bad.feeRecipient = address(0xBADD); // != the escrow's frozen 0xFEE0
        bytes[] memory badSigs = _twoSigsAscending(pk1, pk2, attester.digestOf(bad));
        vm.expectRevert(O5AttesterBase.FeeRecipientMismatch.selector);
        attester.attestO5(bad, ESCROW, badSigs);
        assertFalse(attester.usedUnit(bad.settlementUnitId), "wrong-feeRecipient verdict must not consume the unit");

        O5Verdict memory good = _verdict();
        attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        assertTrue(attester.usedUnit(good.settlementUnitId));
    }

    /// @dev M-01: an `achievedTier` above the supported max (3) is only lower-bounded (`>= requiredTier`), so
    ///      without the ceiling it would mint and be permanently attested. It must revert WITHOUT consuming
    ///      the slot — it is the oracle's own field, checked directly (like `decision`), not read back.
    function test_AchievedTierOutOfRange_Reverts_NothingConsumed() public {
        O5Verdict memory bad = _verdict();
        bad.achievedTier = 4; // outside 0..3, though still >= the unit's frozen requiredTier(2)
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(bad));
        vm.expectRevert(O5AttesterBase.TierOutOfRange.selector);
        attester.attestO5(bad, ESCROW, sigs);
        assertFalse(attester.usedUnit(bad.settlementUnitId), "out-of-range achievedTier must not consume the unit");
    }

    /// @dev The frozen tier fields, same anti-brick class: each would be rejected at release.
    function test_WrongTierFields_Revert_AndLeaveUnitMintable() public {
        // requestedTier != the unit's frozen requiredTier
        O5Verdict memory wrongReq = _verdict();
        wrongReq.requestedTier = REQUIRED_TIER + 1;
        bytes[] memory s1 = _twoSigsAscending(pk1, pk2, attester.digestOf(wrongReq));
        vm.expectRevert(O5AttesterBase.RequestedTierMismatch.selector);
        attester.attestO5(wrongReq, ESCROW, s1);

        // achievedTier below the unit's frozen requiredTier
        O5Verdict memory under = _verdict();
        under.achievedTier = REQUIRED_TIER - 1;
        bytes[] memory s2 = _twoSigsAscending(pk1, pk2, attester.digestOf(under));
        vm.expectRevert(O5AttesterBase.TierNotMet.selector);
        attester.attestO5(under, ESCROW, s2);

        assertFalse(attester.usedUnit(_suid()), "no tier mismatch may consume the unit");
        O5Verdict memory good = _verdict();
        attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        assertTrue(attester.usedUnit(good.settlementUnitId));
    }

    /// @dev A tier-0 unit can never settle on evidence, so minting for it could only ever burn the slot.
    function test_Tier0Unit_Reverts_NothingConsumed() public {
        escrowBinding.setRequiredTier(_suid(), 0);
        O5Verdict memory v = _verdict();
        v.requestedTier = 0;
        v.achievedTier = 0;
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.Tier0NotEvidence.selector);
        attester.attestO5(v, ESCROW, sigs);
        assertFalse(attester.usedUnit(v.settlementUnitId));
    }

    /// @dev A non-canonical tier word from a hostile escrow is rejected rather than truncated.
    function test_OutOfRangeTier_Reverts() public {
        escrowBinding.setRequiredTier(_suid(), 4); // outside the 0..3 range frozen at funding
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.TierOutOfRange.selector);
        attester.attestO5(v, ESCROW, sigs);
        assertFalse(attester.usedUnit(v.settlementUnitId));
    }

    /// @dev MUTABLE escrow state is deliberately NOT pre-checked: those rejections are terminal-to-refund,
    ///      so the slot costs nothing, and any read here would be stale by release time. This pins that
    ///      decision — a disputed / past-deadline unit still mints, exactly as designed.
    function test_MutableEscrowStateIsNotPreChecked() public {
        O5Verdict memory v = _verdict();
        bytes32 id = attester.attestO5(v, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(v)));
        // the assertion does not depend on dispute/deadline/enabled state
        _assertRecordBound(attester, v, id);
    }

    /// @dev §B commit-before-verdict: nothing committed on the escrow ⇒ no mint, nothing consumed.
    function test_UncommittedEvidence_Reverts_NothingConsumed() public {
        escrowBinding.clearEvidence(_suid());
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.EscrowBindingUnreadable.selector);
        attester.attestO5(v, ESCROW, sigs);
        assertFalse(attester.usedUnit(v.settlementUnitId));

        // once the committer commits, the same quorum mints
        escrowBinding.setEvidence(_suid(), BUNDLE);
        attester.attestO5(v, ESCROW, sigs);
        assertTrue(attester.usedUnit(v.settlementUnitId));
    }

    /// @dev Fail-closed when the escrow's unit does not exist (getter reverts) — nothing is consumed.
    function test_EscrowUnitNotFunded_Reverts_NothingConsumed() public {
        escrowBinding.setReverts(true);
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.EscrowBindingUnreadable.selector);
        attester.attestO5(v, ESCROW, sigs);
        assertFalse(attester.usedUnit(v.settlementUnitId));
    }

    /// @dev Fail-closed when `escrow` has no code at all (a plain address cannot be a settling escrow).
    function test_EscrowWithNoCode_Reverts() public {
        address bare = address(0xE5C0F);
        bytes32 suid = VNextSettlementLib.computeSettlementUnitId(block.chainid, bare, JOB, MI, STEP);
        O5Verdict memory v = _verdict();
        v.settlementUnitId = suid; // so the escrow↔verdict binding passes and the READ is what fails
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.EscrowBindingUnreadable.selector);
        attester.attestO5(v, bare, sigs);
    }

    /// @dev Fail-closed on a non-32-byte return (bounded buffer + strict length guard).
    function test_EscrowBadReturnLength_Reverts() public {
        address bad = address(new MockEscrowBadReturn());
        bytes32 suid = VNextSettlementLib.computeSettlementUnitId(block.chainid, bad, JOB, MI, STEP);
        O5Verdict memory v = _verdict();
        v.settlementUnitId = suid;
        bytes[] memory sigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        vm.expectRevert(O5AttesterBase.EscrowBindingUnreadable.selector);
        attester.attestO5(v, bad, sigs);
    }

    /// @dev The pre-check runs AFTER the quorum check: an unauthenticated caller cannot use attestO5 to
    ///      probe an escrow, and a bad-quorum call still fails with the signature error.
    function test_QuorumCheckedBeforeEscrowRead() public {
        escrowBinding.setReverts(true);
        O5Verdict memory v = _verdict();
        bytes[] memory sigs = _twoSigsAscending(pk1, pkX, attester.digestOf(v)); // pkX is not a cohort signer
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        attester.attestO5(v, ESCROW, sigs);
    }

    // ── L-02: reject a zero/invalid identifier ───────────────────────────────────────────────────────
    // The original `test_ZeroEasUid_Reverts_AndLeavesUnitMintable` protected ONE property: a misbehaving
    // or misconfigured dependency that returns a zero identifier must not burn a unit's one-verdict slot
    // on a write that recorded nothing. P0-6 splits that property in two, and both halves are asserted.
    //
    // FINDING, stated rather than assumed: the MONEY-PATH form of this hazard is now structurally
    // impossible, not merely guarded. `attestO5` makes NO external call, so no dependency can return
    // anything to it — there is nothing left that could burn the slot. That is a strengthening of L-02,
    // and it is why the original test cannot be reproduced verbatim on the money path.

    /// @dev HALF 1 (the direct migration): the zero-uid hazard moved WITH EAS onto the async mirror. A
    ///      zero uid there must revert and leave `mirroredUid` unset, so the assertion stays on the
    ///      drainable queue instead of being falsely recorded as mirrored — and a later call succeeds.
    ///      Note what is NO LONGER at stake: the unit's verdict slot was consumed by `attestO5` long
    ///      before, and settlement does not wait on any of this. A broken EAS now costs provenance
    ///      latency, never a burnt slot.
    function test_L02_ZeroEasUid_OnTheMirror_LeavesAssertionQueued() public {
        O5Verdict memory v = _verdict();
        bytes32 assertionId = attester.attestO5(v, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(v)));
        assertTrue(attester.usedUnit(v.settlementUnitId), "the slot is consumed by the ASSERTION, not by EAS");

        mockEas.setReturnZeroUid(true);
        vm.expectRevert(O5AttesterBase.InvalidAttestationUid.selector);
        attester.mirrorToEAS(v);
        assertEq(attester.mirroredUid(v.settlementUnitId), bytes32(0), "a zero-uid mint marks nothing mirrored");
        // The assertion is untouched by the failed mirror — it is still exactly what the escrow will read.
        assertEq(attester.assertionOf(v.settlementUnitId).assertionId, assertionId, "assertion intact");

        mockEas.setReturnZeroUid(false);
        bytes32 uid = attester.mirrorToEAS(v);
        assertTrue(uid != bytes32(0), "the same record mirrors once EAS is healthy");
        assertEq(attester.mirroredUid(v.settlementUnitId), uid, "queue drained");
        assertEq(mockEas.recipientOf(uid), ESCROW);
    }

    /// @dev HALF 2 (the money-path form): the identifier the ESCROW authorizes against can never be zero,
    ///      and the all-zero record must never read as an assertion. `assertionId` is a keccak digest, so
    ///      the `ZeroAssertionId` guard in `attestO5` is defense-in-depth that is unreachable by
    ///      construction — deliberately kept, and deliberately NOT faked into a passing test. What IS
    ///      testable, and is what the escrow actually relies on, is asserted here.
    function test_L02_AssertionIdIsNonZero_AndTheZeroRecordIsNotAnAssertion() public {
        O5Verdict memory v = _verdict();
        assertEq(attester.assertionOf(v.settlementUnitId).assertionId, bytes32(0), "unasserted reads all-zero");
        assertFalse(attester.usedUnit(v.settlementUnitId), "and all-zero is NOT a consumed slot");

        bytes32 assertionId = attester.attestO5(v, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(v)));
        assertTrue(assertionId != bytes32(0), "a real assertion id is never zero");
        assertEq(assertionId, attester.digestOf(v), "it is the full signed-verdict digest");
        // An unrelated unit still reads the zero record: the guard is per-unit, not global.
        bytes32 otherUnit = VNextSettlementLib.computeSettlementUnitId(block.chainid, ESCROW, JOB, MI + 1, STEP);
        assertEq(attester.assertionOf(otherUnit).assertionId, bytes32(0), "no bleed to a neighbouring unit");
    }

    // ── L-02: independently-computed EIP-712 golden ─────────────────────────────────────────────────
    // Every expected value below was computed OUTSIDE this contract (`cast keccak` / `cast abi-encode` on
    // the spec strings) and is hardcoded as a literal. Nothing here calls `digestOf`, `_structHash`, or
    // `_domainSeparator` to build an expectation — so a hashing mistake shared by the on-chain code and an
    // off-chain mirror that copied it is caught here rather than at the money path.
    //
    // Canonical pinning: chainId 8453 (Base), cohortId 7 (bound INSIDE the struct as oracleAuthEpoch — no
    // longer a domain salt), verifyingContract = the attester deployed by GOLDEN_DEPLOYER at nonce 0
    // (`cast compute-address 0x…00D0 --nonce 0`).
    address constant GOLDEN_DEPLOYER = address(0xD0);
    address constant GOLDEN_ATTESTER = 0xe61244BB1242d392fB53dF4979A62E955a9BC70d;
    uint256 constant GOLDEN_CHAINID = 8453;
    uint64 constant GOLDEN_COHORT = 7;
    bytes32 constant GOLDEN_DOMAIN_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;
    bytes32 constant GOLDEN_NAME_HASH = 0x8088a87b6ec5bea69f5197cba5c21ed8bd0517de908c2db45f3a57a009ab84cc;
    bytes32 constant GOLDEN_VERSION_HASH = 0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6;
    bytes32 constant GOLDEN_O5_TYPEHASH = 0xb1655a362b95f8aff16b8e0d088e7316643950f91bd955d8dd5b98092b140872;
    bytes32 constant GOLDEN_DOMAIN_SEPARATOR = 0x089f1b2121bfc0d8b7cc543917e0a6e76f5a3e06d18e8a52ed523be03c385a2a;
    bytes32 constant GOLDEN_STRUCT_HASH = 0x3a975d891d1770842ef8f7d8bddd98725d4043256efbf545539f780766f7074b;
    bytes32 constant GOLDEN_DIGEST = 0xc15b529ac9df1b28646b3ba79e3a9764ada83b7c02b7ed74e409f8569a144b67;

    function _goldenVerdict() internal pure returns (O5Verdict memory v) {
        v = O5Verdict({
            jobIdHash: keccak256("golden-job"),
            milestoneIndex: 3,
            stepId: keccak256("golden-step"),
            evidenceBundleHash: keccak256("golden-bundle"),
            achievedTier: 2,
            requestedTier: 2,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("golden-verdict"),
            feeBps: 235,
            feeRecipient: address(0xFEE0),
            feeScheduleHash: keccak256("golden-fee-schedule"),
            settlementUnitId: keccak256("golden-unit"),
            oracleAuthEpoch: GOLDEN_COHORT,
            compositionRoot: keccak256("golden-composition-root")
        });
    }

    function test_EIP712_Golden_IndependentlyComputed() public {
        vm.chainId(GOLDEN_CHAINID);
        vm.prank(GOLDEN_DEPLOYER);
        Fixed2of3O5Attester g = new Fixed2of3O5Attester(
            vm.addr(pk1), vm.addr(pk2), vm.addr(pk3), address(mockEas), O5_SCHEMA, GOLDEN_COHORT, REVOKER
        );
        assertEq(address(g), GOLDEN_ATTESTER, "golden verifyingContract pin");

        // the string preimages, asserted against externally-computed literals (catches a typo'd type string)
        assertEq(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            GOLDEN_DOMAIN_TYPEHASH,
            "EIP-712 domain type string (no salt)"
        );
        assertEq(keccak256(bytes("PCC:O5Attester")), GOLDEN_NAME_HASH, "domain name");
        assertEq(keccak256(bytes("1")), GOLDEN_VERSION_HASH, "domain version");
        assertEq(g.o5TypeHash(), GOLDEN_O5_TYPEHASH, "live O5 type hash == the spec's type string hash");

        // the digest the cohort signs, vs the literal computed off-chain from the spec
        assertEq(g.digestOf(_goldenVerdict()), GOLDEN_DIGEST, "O5 EIP-712 digest golden");

        // the same digest, recomposed from the two literal halves — pins WHICH half a future break is in
        assertEq(
            keccak256(abi.encodePacked("\x19\x01", GOLDEN_DOMAIN_SEPARATOR, GOLDEN_STRUCT_HASH)),
            GOLDEN_DIGEST,
            "digest == 0x1901 || domainSeparator || structHash"
        );

        console2.log("== O5 EIP-712 golden (mirror these off-chain) ==");
        console2.log("chainId", GOLDEN_CHAINID);
        console2.log("cohortId (struct oracleAuthEpoch, not a domain salt)", uint256(GOLDEN_COHORT));
        console2.log("verifyingContract", GOLDEN_ATTESTER);
        console2.logBytes32(GOLDEN_DOMAIN_TYPEHASH);
        console2.logBytes32(GOLDEN_NAME_HASH);
        console2.logBytes32(GOLDEN_VERSION_HASH);
        console2.logBytes32(GOLDEN_O5_TYPEHASH);
        console2.logBytes32(GOLDEN_DOMAIN_SEPARATOR);
        console2.logBytes32(GOLDEN_STRUCT_HASH);
        console2.logBytes32(GOLDEN_DIGEST);
    }

    /// @dev Field coverage: mutating ANY of the 14 O5 fields must move the digest the quorum signs. A field
    ///      dropped from `_structHash` would let a signer's approval carry over to a different verdict.
    function test_EIP712_EveryFieldMovesTheDigest() public view {
        bytes32 d0 = attester.digestOf(_goldenVerdict());
        O5Verdict memory v;
        v = _goldenVerdict();
        v.jobIdHash = keccak256("x");
        assertTrue(attester.digestOf(v) != d0, "1 jobIdHash");
        v = _goldenVerdict();
        v.milestoneIndex = 4;
        assertTrue(attester.digestOf(v) != d0, "2 milestoneIndex");
        v = _goldenVerdict();
        v.stepId = keccak256("x");
        assertTrue(attester.digestOf(v) != d0, "3 stepId");
        v = _goldenVerdict();
        v.evidenceBundleHash = keccak256("x");
        assertTrue(attester.digestOf(v) != d0, "4 evidenceBundleHash");
        v = _goldenVerdict();
        v.achievedTier = 3;
        assertTrue(attester.digestOf(v) != d0, "5 achievedTier");
        v = _goldenVerdict();
        v.requestedTier = 3;
        assertTrue(attester.digestOf(v) != d0, "6 requestedTier");
        v = _goldenVerdict();
        v.decision = 2;
        assertTrue(attester.digestOf(v) != d0, "7 decision");
        v = _goldenVerdict();
        v.verdictHash = keccak256("x");
        assertTrue(attester.digestOf(v) != d0, "8 verdictHash");
        v = _goldenVerdict();
        v.feeBps = 236;
        assertTrue(attester.digestOf(v) != d0, "9 feeBps");
        v = _goldenVerdict();
        v.feeRecipient = address(0xFEE1);
        assertTrue(attester.digestOf(v) != d0, "10 feeRecipient");
        v = _goldenVerdict();
        v.feeScheduleHash = keccak256("x");
        assertTrue(attester.digestOf(v) != d0, "11 feeScheduleHash");
        v = _goldenVerdict();
        v.settlementUnitId = keccak256("x");
        assertTrue(attester.digestOf(v) != d0, "12 settlementUnitId");
        v = _goldenVerdict();
        v.oracleAuthEpoch = GOLDEN_COHORT + 1;
        assertTrue(attester.digestOf(v) != d0, "13 oracleAuthEpoch");
        v = _goldenVerdict();
        v.compositionRoot = keccak256("x");
        assertTrue(attester.digestOf(v) != d0, "14 compositionRoot");
    }

    // == H-01 Wave 3: the typed escalation adjudication (appeal + Model-B emergency) =================
    // The escrow hosts NO signature verification. Every Wave-3 authority is an m-of-n quorum verified
    // HERE and read back by the escrow as an immutable record, so these tests are where that quorum's
    // safety properties live.

    bytes32 constant ACCEPTED = keccak256("the-accepted-assertion");

    function _adj(uint8 role, uint8 outcome) internal view returns (O5Adjudication memory a) {
        a = O5Adjudication({
            settlementUnitId: _suid(),
            escrow: ESCROW,
            reviewedAssertionId: ACCEPTED,
            role: role,
            outcome: outcome,
            oracleAuthEpoch: COHORT
        });
    }

    function _adjSigs(O5Adjudication memory a) internal view returns (bytes[] memory) {
        return _twoSigsAscending(pk1, pk2, attester.adjudicationDigestOf(a));
    }

    function _armAccepted() internal {
        escrowBinding.setAcceptedAssertionId(_suid(), ACCEPTED);
    }

    /// @dev The happy path: a 2-of-3 quorum writes an immutable, escrow-bound, assertion-specific UPHOLD.
    function test_Adjudicate_QuorumWritesAnImmutableRecord() public {
        _armAccepted();
        O5Adjudication memory a = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bytes32 expected = attester.adjudicationDigestOf(a);
        bytes32 got = attester.adjudicate(a, _adjSigs(a));
        assertEq(got, expected, "the adjudication id IS the EIP-712 digest over the full signed struct");

        O5AdjudicationRecord memory r = attester.adjudicationOf(_suid(), O5_ADJ_ROLE_APPEAL, ESCROW);
        assertEq(r.adjudicationId, expected);
        assertEq(r.reviewedAssertionId, ACCEPTED);
        assertEq(r.escrow, ESCROW);
        assertEq(uint256(r.role), uint256(O5_ADJ_ROLE_APPEAL));
        assertEq(uint256(r.outcome), uint256(O5_ADJ_UPHOLD));
        assertEq(uint256(r.decidedAt), block.timestamp);
    }

    /// @dev Consume-once PER ROLE. The appeal slot and the Model-B emergency slot are independent, so an
    ///      appeal verdict can never consume (or masquerade as) the emergency review of the same unit.
    function test_Adjudicate_ConsumeOncePerRole_ButRolesAreIndependent() public {
        _armAccepted();
        O5Adjudication memory ap = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        attester.adjudicate(ap, _adjSigs(ap));
        bytes[] memory sigs_ap_0 = _adjSigs(ap);
        vm.expectRevert(O5AttesterBase.UnitAlreadyAdjudicated.selector);
        attester.adjudicate(ap, sigs_ap_0);

        // A different OUTCOME under the same role is also refused: the SLOT is consumed, not the value.
        O5Adjudication memory ap2 = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_OVERTURN);
        bytes[] memory sigs_ap2_1 = _adjSigs(ap2);
        vm.expectRevert(O5AttesterBase.UnitAlreadyAdjudicated.selector);
        attester.adjudicate(ap2, sigs_ap2_1);

        // The EMERGENCY slot is untouched and still writable.
        O5Adjudication memory em = _adj(O5_ADJ_ROLE_EMERGENCY, O5_ADJ_OVERTURN);
        attester.adjudicate(em, _adjSigs(em));
        assertEq(
            uint256(attester.adjudicationOf(_suid(), O5_ADJ_ROLE_EMERGENCY, ESCROW).outcome), uint256(O5_ADJ_OVERTURN)
        );
        assertEq(uint256(attester.adjudicationOf(_suid(), O5_ADJ_ROLE_APPEAL, ESCROW).outcome), uint256(O5_ADJ_UPHOLD));
    }

    /// @dev A signature over an APPEAL cannot be replayed as an EMERGENCY (and vice versa): `role` is
    ///      inside the signed struct, so changing it changes the digest and the quorum no longer holds.
    function test_Adjudicate_RoleIsInsideTheSignedStruct_NoCrossRoleReplay() public {
        _armAccepted();
        O5Adjudication memory ap = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bytes[] memory sigs = _adjSigs(ap);
        O5Adjudication memory em = _adj(O5_ADJ_ROLE_EMERGENCY, O5_ADJ_UPHOLD);
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        attester.adjudicate(em, sigs); // the appeal signatures recover to strangers under the new digest
    }

    /// @dev An O5 SETTLE signature cannot be replayed as an UPHOLD: separate typehashes, same domain.
    function test_Adjudicate_AnO5SettleSignatureIsNotAnUphold() public {
        _armAccepted();
        O5Verdict memory v = _verdict();
        bytes[] memory settleSigs = _twoSigsAscending(pk1, pk2, attester.digestOf(v));
        O5Adjudication memory a = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        attester.adjudicate(a, settleSigs);
    }

    /// @dev ANTI-BRICK (the same discipline as the M-01 pre-check on `attestO5`): the slot is consume-once,
    ///      so a verdict naming an assertion the escrow did not accept must consume NOTHING and stay
    ///      re-signable. A unit with nothing accepted reads zero and fails closed for the same reason.
    function test_Adjudicate_AntiBrick_WrongOrAbsentAssertionConsumesNothing() public {
        O5Adjudication memory a = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bytes[] memory sigs_a_2 = _adjSigs(a);
        vm.expectRevert(O5AttesterBase.ReviewedAssertionMismatch.selector);
        attester.adjudicate(a, sigs_a_2); // nothing accepted yet -> zero -> mismatch

        escrowBinding.setAcceptedAssertionId(_suid(), keccak256("a-different-assertion"));
        bytes[] memory sigs_a_3 = _adjSigs(a);
        vm.expectRevert(O5AttesterBase.ReviewedAssertionMismatch.selector);
        attester.adjudicate(a, sigs_a_3);

        // Nothing was burned: once the escrow's accepted assertion matches, the SAME verdict writes.
        _armAccepted();
        attester.adjudicate(a, _adjSigs(a));
        assertEq(attester.adjudicationOf(_suid(), O5_ADJ_ROLE_APPEAL, ESCROW).reviewedAssertionId, ACCEPTED);
    }

    function test_Adjudicate_RejectsBadRoleOutcomeCohortAndZeroFields() public {
        _armAccepted();
        O5Adjudication memory bad = _adj(9, O5_ADJ_UPHOLD);
        bytes[] memory sigs_bad_4 = _adjSigs(bad);
        vm.expectRevert(O5AttesterBase.BadAdjudicationRole.selector);
        attester.adjudicate(bad, sigs_bad_4);

        bad = _adj(O5_ADJ_ROLE_APPEAL, 9);
        bytes[] memory sigs_bad_5 = _adjSigs(bad);
        vm.expectRevert(O5AttesterBase.BadAdjudicationOutcome.selector);
        attester.adjudicate(bad, sigs_bad_5);

        bad = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bad.oracleAuthEpoch = COHORT + 1;
        bytes[] memory sigs_bad_6 = _adjSigs(bad);
        vm.expectRevert(O5AttesterBase.CohortMismatch.selector);
        attester.adjudicate(bad, sigs_bad_6);

        bad = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bad.escrow = address(0);
        bytes[] memory sigs_bad_7 = _adjSigs(bad);
        vm.expectRevert(O5AttesterBase.ZeroAddress.selector);
        attester.adjudicate(bad, sigs_bad_7);

        bad = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bad.reviewedAssertionId = bytes32(0);
        bytes[] memory sigs_bad_8 = _adjSigs(bad);
        vm.expectRevert(O5AttesterBase.ZeroReviewedAssertion.selector);
        attester.adjudicate(bad, sigs_bad_8);
    }

    /// @dev The adjudication quorum is the SAME m-of-n rule as the settle quorum: one signature is not a
    ///      quorum, a duplicate is not two signers, and a non-signer is never authorized.
    function test_Adjudicate_EnforcesTheSameQuorumRule() public {
        _armAccepted();
        O5Adjudication memory a = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bytes32 d = attester.adjudicationDigestOf(a);

        bytes[] memory one = new bytes[](1);
        one[0] = _sig(pk1, d);
        vm.expectRevert(O5AttesterBase.WrongSignatureCount.selector);
        attester.adjudicate(a, one);

        bytes[] memory dup = new bytes[](2);
        dup[0] = _sig(pk1, d);
        dup[1] = _sig(pk1, d);
        vm.expectRevert(O5AttesterBase.SignersNotSortedOrUnique.selector);
        attester.adjudicate(a, dup);

        vm.expectRevert(O5AttesterBase.NotAuthorizedSigner.selector);
        attester.adjudicate(a, _twoSigsAscending(pk1, pkX, d));
    }

    function test_Adjudicate_RejectedOnceTheCohortIsDisabled() public {
        _armAccepted();
        vm.prank(REVOKER);
        attester.disable();
        O5Adjudication memory a = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        bytes[] memory sigs_a_9 = _adjSigs(a);
        vm.expectRevert(O5AttesterBase.CohortIsDisabled.selector);
        attester.adjudicate(a, sigs_a_9);
    }

    /// @dev Section 8.3 C-5: `disabledAt` is WRITE-ONCE inside a one-way switch. That is the property
    ///      that makes the escrow's emergency deadline immutable: the revoker cannot reset or extend it
    ///      by calling `disable()` again later, so it may INITIATE an emergency but never move its clock.
    function test_C5_DisabledAtIsWriteOnceAndOneWay() public {
        assertEq(uint256(attester.disabledAt()), 0, "zero while enabled");
        vm.warp(1_000_000);
        vm.prank(REVOKER);
        attester.disable();
        assertEq(uint256(attester.disabledAt()), 1_000_000);
        assertFalse(attester.enabled());

        vm.warp(2_000_000);
        vm.prank(REVOKER);
        vm.expectRevert(O5AttesterBase.CohortIsDisabled.selector);
        attester.disable(); // a second disable cannot move the deadline
        assertEq(uint256(attester.disabledAt()), 1_000_000, "the emergency deadline is immutable");
    }

    function test_C5_DisabledAtIsNeverZeroAtGenesis() public {
        vm.warp(0);
        vm.prank(REVOKER);
        attester.disable();
        assertEq(uint256(attester.disabledAt()), 1, "clamped, so a dead cohort never reads as a live one");
    }

    /// @dev The record carries NO amount and NO recipient: the "no distribution authority" property is
    ///      enforced by the TYPE, so this quorum can only ever select a path.
    function test_Adjudication_HasNoDistributionAuthority() public {
        _armAccepted();
        O5Adjudication memory a = _adj(O5_ADJ_ROLE_APPEAL, O5_ADJ_UPHOLD);
        attester.adjudicate(a, _adjSigs(a));
        O5AdjudicationRecord memory r = attester.adjudicationOf(_suid(), O5_ADJ_ROLE_APPEAL, ESCROW);
        // abi.encode of the whole record is exactly 6 words: id, reviewed, escrow, decidedAt, role, outcome.
        assertEq(abi.encode(r).length, 6 * 32, "no amount and no recipient field exists to abuse");
    }
}
