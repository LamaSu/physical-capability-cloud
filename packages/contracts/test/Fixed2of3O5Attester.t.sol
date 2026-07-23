// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {O5AttesterBase} from "../src/attesters/O5AttesterBase.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {SingleSignerO5Attester} from "../src/attesters/SingleSignerO5Attester.sol";
import {O5Verdict, O5_DECISION_SETTLE} from "../src/O5Types.sol";
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
    bool public reverts;

    error UnitNotFound();
    error EvidenceNotCommitted();

    function setRoot(bytes32 unitId, bytes32 r) external {
        root[unitId] = r;
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
        // the escrow froze ROOT at funding and the committer committed BUNDLE; the quorum must echo both.
        escrowBinding.setRoot(_suid(), ROOT);
        escrowBinding.setEvidence(_suid(), BUNDLE);
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
            achievedTier: 2,
            requestedTier: 2,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("vh"),
            feeBps: 235,
            feeRecipient: address(0xFEE0),
            feeScheduleHash: keccak256("fh"),
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

    /// @dev L-03 separation of duties: a key that both signs and holds the kill-switch could disable the
    ///      cohort on its own (availability attack → every honest unit forced to refund).
    function test_Constructor_RejectsRevokerAsSigner() public {
        vm.expectRevert(O5AttesterBase.RevokerIsSigner.selector);
        new Fixed2of3O5Attester(
            vm.addr(pk1), vm.addr(pk2), vm.addr(pk3), address(mockEas), O5_SCHEMA, COHORT, vm.addr(pk2)
        );
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
        bytes32 uid = attester.attestO5(good, ESCROW, _twoSigsAscending(pk1, pk2, attester.digestOf(good)));
        assertEq(mockEas.recipientOf(uid), ESCROW, "corrected verdict mints for the same unit");
        assertTrue(attester.usedUnit(good.settlementUnitId));
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

    // ── L-02: independently-computed EIP-712 golden ─────────────────────────────────────────────────
    // Every expected value below was computed OUTSIDE this contract (`cast keccak` / `cast abi-encode` on
    // the spec strings) and is hardcoded as a literal. Nothing here calls `digestOf`, `_structHash`, or
    // `_domainSeparator` to build an expectation — so a hashing mistake shared by the on-chain code and an
    // off-chain mirror that copied it is caught here rather than at the money path.
    //
    // Canonical pinning: chainId 8453 (Base), cohortId/salt 7, verifyingContract = the attester deployed by
    // GOLDEN_DEPLOYER at nonce 0 (`cast compute-address 0x…00D0 --nonce 0`).
    address constant GOLDEN_DEPLOYER = address(0xD0);
    address constant GOLDEN_ATTESTER = 0xe61244BB1242d392fB53dF4979A62E955a9BC70d;
    uint256 constant GOLDEN_CHAINID = 8453;
    uint64 constant GOLDEN_COHORT = 7;
    bytes32 constant GOLDEN_DOMAIN_TYPEHASH = 0xd87cd6ef79d4e2b95e15ce8abf732db51ec771f1ca2edccf22a46c729ac56472;
    bytes32 constant GOLDEN_NAME_HASH = 0x8088a87b6ec5bea69f5197cba5c21ed8bd0517de908c2db45f3a57a009ab84cc;
    bytes32 constant GOLDEN_VERSION_HASH = 0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6;
    bytes32 constant GOLDEN_O5_TYPEHASH = 0xb1655a362b95f8aff16b8e0d088e7316643950f91bd955d8dd5b98092b140872;
    bytes32 constant GOLDEN_DOMAIN_SEPARATOR = 0xd1877915bc12dfdeacda5887c5eb3c6809ac3488e10dee437db1c7c5e5599827;
    bytes32 constant GOLDEN_STRUCT_HASH = 0x3a975d891d1770842ef8f7d8bddd98725d4043256efbf545539f780766f7074b;
    bytes32 constant GOLDEN_DIGEST = 0xc07d03725e6445f57b8685ee8c6d13adebd3e37e8a1e143c4f8c6878051d6c16;

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
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"),
            GOLDEN_DOMAIN_TYPEHASH,
            "EIP-712 domain type string"
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
        console2.log("cohortId (domain salt)", uint256(GOLDEN_COHORT));
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
}
