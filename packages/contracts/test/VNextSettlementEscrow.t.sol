// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {O5Verdict, O5Assertion, O5_VERDICT_BYTES, O5_DECISION_SETTLE} from "../src/O5Types.sol";
import {IOracleAttester} from "../src/interfaces/IOracleAttester.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {PayoutEntry, FeeSchedule, PolicyIdentity, UnitState, ClaimClass, AuthorizationType, ValueOverflow, VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";
import {EASAttestation, AttestationRequest} from "../src/interfaces/IEAS.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {O5AttesterBase} from "../src/attesters/O5AttesterBase.sol";

/// @dev Configurable adversarial USDC mock. `transfer` (money-out) and `transferFrom` (funding) modes
///      are set per test to drive the tryTransferExact classifier + the funding delta check.
contract MockToken {
    enum Mode {
        NORMAL,
        RETURN_FALSE_NO_MOVE,
        REVERT,
        DEBIT_NO_CREDIT,
        RETURN_FALSE_WITH_MOVE,
        WRONG_DELTA,
        FEE_ON_TRANSFER
    }

    mapping(address => uint256) public balanceOf;
    Mode public transferMode = Mode.NORMAL;
    Mode public transferFromMode = Mode.NORMAL;

    function setTransferMode(Mode m) external {
        transferMode = m;
    }

    function setTransferFromMode(Mode m) external {
        transferFromMode = m;
    }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        Mode m = transferMode;
        if (m == Mode.REVERT) revert("transfer reverts");
        if (m == Mode.RETURN_FALSE_NO_MOVE) return false;
        if (m == Mode.DEBIT_NO_CREDIT) {
            balanceOf[msg.sender] -= amt;
            return true;
        }
        if (m == Mode.RETURN_FALSE_WITH_MOVE) {
            balanceOf[msg.sender] -= amt;
            balanceOf[to] += amt;
            return false;
        }
        if (m == Mode.WRONG_DELTA) {
            balanceOf[msg.sender] -= amt;
            balanceOf[to] += amt - 1;
            return true;
        }
        if (m == Mode.FEE_ON_TRANSFER) {
            balanceOf[msg.sender] -= amt;
            balanceOf[to] += (amt * 99) / 100;
            return true;
        }
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        if (transferFromMode == Mode.FEE_ON_TRANSFER) {
            balanceOf[from] -= amt;
            balanceOf[to] += (amt * 99) / 100;
            return true;
        }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @dev A read+write EAS double: records what the attester's ASYNC MIRROR writes and serves it back by
///      uid. P0-6: the escrow never touches this — it exists only to observe the provenance mirror.
contract MockReadWriteEAS {
    mapping(bytes32 => EASAttestation) internal _atts;
    uint256 public n;

    function attest(AttestationRequest calldata r) external payable returns (bytes32 uid) {
        uid = keccak256(abi.encode(r.schema, r.data.recipient, r.data.data, n));
        n += 1;
        _atts[uid] = EASAttestation({
            uid: uid,
            schema: r.schema,
            time: uint64(block.timestamp),
            expirationTime: r.data.expirationTime,
            revocationTime: 0,
            refUID: r.data.refUID,
            recipient: r.data.recipient,
            attester: msg.sender,
            revocable: r.data.revocable,
            data: r.data.data
        });
    }

    function getAttestation(bytes32 uid) external view returns (EASAttestation memory) {
        return _atts[uid];
    }
}

/// @dev Minimal IOracleAttester the escrow reads at fund()/release(): a settable one-way kill-switch, a
///      fixed cohort id, and a settable per-unit ASSERTION RECORD (P0-6 — this is what the escrow's money
///      path reads instead of an EAS attestation). The escrow never calls attestO5, so attestO5 is a no-op
///      here — the real quorum crypto and the real record write are exercised in Fixed2of3O5Attester.t.sol
///      and in the end-to-end tests at the bottom of this file.
contract MockOracleAttester is IOracleAttester {
    bool public enabled = true;
    uint64 public cohortId;
    mapping(bytes32 => O5Assertion) internal _assertions;

    function setAssertion(bytes32 unitId, O5Assertion memory a) external {
        _assertions[unitId] = a;
    }

    function assertionOf(bytes32 unitId) external view returns (O5Assertion memory) {
        return _assertions[unitId];
    }
    /// @dev the cohort's live O5 EIP-712 type hash — the escrow's constructor pins its metadata to this.
    bytes32 public o5TypeHash = keccak256("mock.o5.typehash");
    /// @dev the cohort's pinned O5 schema UID (M-02) — MUST equal the test's `O5_SCHEMA` so the escrow's
    ///      symmetric schema pin passes at construction (the setUp factory pins O5_SCHEMA, non-zero).
    bytes32 public o5SchemaUid = keccak256("test.o5.schema");

    constructor(uint64 cohortId_) {
        cohortId = cohortId_;
    }

    function setO5TypeHash(bytes32 h) external {
        o5TypeHash = h;
    }

    function setO5SchemaUid(bytes32 s) external {
        o5SchemaUid = s;
    }

    function setEnabled(bool e) external {
        enabled = e;
    }

    function disable() external {
        enabled = false;
    }

    function attestO5(O5Verdict calldata, address, bytes[] calldata) external pure returns (bytes32) {
        return bytes32(0);
    }
}

/// @dev A minimal ERC-1271 smart-account OPERATOR. H-01 requires the operator's money-plane identity to
///      work when the operator is a contract, not just an EOA — most real operators will be smart
///      accounts. It validates an ECDSA signature from its owner key and can be told to decline, so both
///      the accept and reject branches of the escrow's ERC-1271 path are exercised.
contract MockSmartAccountOperator {
    address public immutable owner;
    bool public accepts = true;

    constructor(address owner_) {
        owner = owner_;
    }

    function setAccepts(bool a) external {
        accepts = a;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (!accepts || signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

/// @dev Exposes the H-2 checked downcasts at an EXTERNAL call boundary. `vm.expectRevert` cannot observe
///      a revert raised at its own call depth, so an internal library call has to be wrapped to be tested.
contract DowncastHarness {
    function toUint64(uint256 v) external pure returns (uint64) {
        return VNextSettlementLib.toUint64(v);
    }

    function toUint128(uint256 v) external pure returns (uint128) {
        return VNextSettlementLib.toUint128(v);
    }
}

contract VNextSettlementEscrowTest is Test {
    MockToken usdc;
    MockOracleAttester attester;
    VNextSettlementEscrowFactory factory;

    uint64 constant COHORT = 1; // the mock attester's cohort id, pinned into the escrow at fund()
    uint256 payerPk = 0xA11CE;
    address payer;
    address arbiter = address(0xAB12);
    address recip1 = address(0xBEEF01);
    address recip2 = address(0xBEEF02);
    address feeDest = address(0xFEE1);
    /// @dev H-01: the operator is now a MONEY-PLANE SIGNING IDENTITY, not just an address in a config.
    ///      It is also the funder-designated evidence committer (§B) in these fixtures.
    uint256 operatorPk = 0x0FE7A;
    address operator;
    bytes32 constant PKG = keccak256("evidence-package-v1");
    bytes32 constant ASSERTION_1 = keccak256("assertion-1"); // stands in for the attester's EIP-712 digest
    bytes32 constant O5_SCHEMA = keccak256("test.o5.schema");
    bytes32 constant JOB = keccak256("job-1");
    bytes32 constant TERMS = keccak256("terms-1");

    function setUp() public {
        payer = vm.addr(payerPk);
        operator = vm.addr(operatorPk);
        usdc = new MockToken();
        attester = new MockOracleAttester(COHORT);
        factory = new VNextSettlementEscrowFactory(address(usdc), address(attester), O5_SCHEMA, bytes32(0));
        usdc.mint(payer, 1_000_000e6);
    }

    // ── H-01 bilateral-acceptance helpers ────────────────────────────────────────────────────────
    // Everything below RE-DERIVES the policy hash from the frozen spec (the EIP-712 type string, the
    // domain, the salt preimage, the unit-id derivation) rather than asking the contract for it, so a
    // change to the contract's encoding fails these tests instead of silently agreeing with itself.

    bytes32 constant JOB_POLICY_TYPEHASH_T = keccak256(
        "JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,address arbiter,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,bool allowSelfAdjudication,uint256 expiry)"
    );
    uint256 constant POLICY_EXPIRY = 1e12; // far future for the happy paths; overridden where it matters

    /// @dev The address-independent commitment to the exact funded terms (goes into the CREATE2 salt).
    function _preRoot(VNextSettlementEscrow.UnitConfig[] memory cfgs) internal pure returns (bytes32) {
        return keccak256(abi.encode(cfgs));
    }

    function _identity(bytes32 job, address arb, uint256 nonce, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        view
        returns (PolicyIdentity memory)
    {
        return PolicyIdentity({
            payer: payer,
            operator: operator,
            arbiter: arb,
            jobIdHash: job,
            termsHash: TERMS,
            policyNonce: nonce,
            prePolicyRoot: _preRoot(cfgs)
        });
    }

    /// @dev The rolling commitment over the settlementUnitIds derived from the PREDICTED escrow address —
    ///      step 4 of the §8.2 H-1 sequence, computed here exactly as an operator would before signing.
    function _unitsRootFor(address escrowAddr, bytes32 job, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        view
        returns (bytes32 r)
    {
        for (uint256 i; i < cfgs.length; ++i) {
            bytes32 uid = VNextSettlementLib.computeSettlementUnitId(
                block.chainid, escrowAddr, job, cfgs[i].milestoneIndex, cfgs[i].stepId
            );
            r = keccak256(abi.encode(r, uid));
        }
    }

    struct PolicyArgs {
        address escrowAddr;
        address factoryAddr;
        address impl;
        bytes32 job;
        address arb;
        uint256 nonce;
        bytes32 preRoot;
        bytes32 unitsRoot;
        bool allowSelf;
        uint256 expiry;
    }

    function _policyStructHash(PolicyArgs memory a) internal view returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    JOB_POLICY_TYPEHASH_T,
                    block.chainid,
                    a.factoryAddr,
                    a.impl,
                    a.escrowAddr,
                    uint256(1), // POLICY_VERSION
                    payer,
                    operator
                ),
                abi.encode(a.arb, a.job, TERMS, a.nonce, a.preRoot, a.unitsRoot, a.allowSelf, a.expiry)
            )
        );
    }

    function _policyDigest(PolicyArgs memory a) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSep(a.escrowAddr), _policyStructHash(a)));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The exact digest `e` will recompute for these configs — derived here from the spec, so a
    ///      drift in the contract's encoding surfaces as a signature failure rather than silent agreement.
    function _digestOf(
        VNextSettlementEscrow e,
        VNextSettlementEscrow.UnitConfig[] memory cfgs,
        bool allowSelf,
        uint256 expiry
    ) internal view returns (bytes32) {
        (,, uint256 nonce, bytes32 preRoot,,) = e.policy();
        bytes32 job = e.jobIdHash();
        address f = e.factory();
        return _policyDigest(
            PolicyArgs({
                escrowAddr: address(e),
                factoryAddr: f,
                impl: VNextSettlementEscrowFactory(f).implementation(),
                job: job,
                arb: e.arbiter(),
                nonce: nonce,
                preRoot: preRoot,
                unitsRoot: _unitsRootFor(address(e), job, cfgs),
                allowSelf: allowSelf,
                expiry: expiry
            })
        );
    }

    /// @dev The canonical acceptance for `e`'s own frozen identity + the configs being funded.
    function _acceptance(
        VNextSettlementEscrow e,
        VNextSettlementEscrow.UnitConfig[] memory cfgs,
        bool allowSelf,
        uint256 expiry,
        bool includePayerSig
    ) internal view returns (VNextSettlementEscrow.PolicyAcceptance memory acc) {
        (,, uint256 nonce, bytes32 preRoot,,) = e.policy();
        bytes32 job = e.jobIdHash();
        address f = e.factory(); // the escrow's OWN deploying factory, not the fixture's
        bytes32 digest = _policyDigest(
            PolicyArgs({
                escrowAddr: address(e),
                factoryAddr: f,
                impl: VNextSettlementEscrowFactory(f).implementation(),
                job: job,
                arb: e.arbiter(),
                nonce: nonce,
                preRoot: preRoot,
                unitsRoot: _unitsRootFor(address(e), job, cfgs),
                allowSelf: allowSelf,
                expiry: expiry
            })
        );
        acc = VNextSettlementEscrow.PolicyAcceptance({
            expiry: expiry,
            allowSelfAdjudication: allowSelf,
            payerSignature: includePayerSig ? _sign(payerPk, digest) : bytes(""),
            operatorSignature: _sign(operatorPk, digest)
        });
    }

    function _acceptance(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        view
        returns (VNextSettlementEscrow.PolicyAcceptance memory)
    {
        return _acceptance(e, cfgs, false, POLICY_EXPIRY, false);
    }

    // ── escrow lifecycle helpers ─────────────────────────────────────────────────────────────────
    /// @dev Create (not fund) the clone whose address commits to EXACTLY these configs.
    function _escrowFor(bytes32 job, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        returns (VNextSettlementEscrow e)
    {
        e = VNextSettlementEscrow(factory.createEscrow(_identity(job, arbiter, 1, cfgs)));
    }

    /// @dev Create + fund in the canonical §8.2 H-1 order.
    function _fundedEscrow(bytes32 job, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        returns (VNextSettlementEscrow e)
    {
        e = _escrowFor(job, cfgs);
        _fund(e, cfgs);
    }

    /// @dev One unit: G, fee F, two payouts summing to N. requiredTier/requestedTier configurable.
    function _oneUnitConfig(uint256 g, uint256 f, uint16 feeBps, uint8 tier)
        internal
        view
        returns (VNextSettlementEscrow.UnitConfig[] memory cfgs)
    {
        uint256 n = g - f;
        PayoutEntry[] memory po = new PayoutEntry[](2);
        po[0] = PayoutEntry({recipient: recip1, amount: n / 2});
        po[1] = PayoutEntry({recipient: recip2, amount: n - n / 2});
        cfgs = new VNextSettlementEscrow.UnitConfig[](1);
        cfgs[0] = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            requiredTier: tier,
            requestedTier: tier,
            g: g,
            f: f,
            n: n,
            feeBps: feeBps,
            feeRecipient: f > 0 ? feeDest : address(0),
            disputeWindow: 1 days,
            reclaimAt: block.timestamp + 30 days,
            compositionSchemaVersion: 0,
            compositionRoot: bytes32(0),
            evidenceCommitter: operator,
            payouts: po
        });
    }

    function _unitId(VNextSettlementEscrow e) internal view returns (bytes32) {
        return VNextSettlementLib.computeSettlementUnitId(block.chainid, address(e), e.jobIdHash(), 0, keccak256("step-0"));
    }

    function _fund(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig[] memory cfgs) internal {
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, cfgs);
        vm.prank(payer);
        e.fund(cfgs, acc);
    }

    // ── §B evidence-commit helpers ────────────────────────────────────────────────────────────────
    /// @dev The canonical commitment the escrow stores, recomputed here from the unit's own frozen fields.
    function _commitment(VNextSettlementEscrow e, bytes32 id, bytes32 packageDigest) internal view returns (bytes32) {
        return VNextSettlementLib.computeEvidenceCommitment(
            block.chainid,
            address(e),
            id,
            e.compositionSchemaVersionOf(id),
            VNextSettlementLib.EVIDENCE_PACKAGE_FORMAT_V1,
            packageDigest
        );
    }

    function _commit(VNextSettlementEscrow e, bytes32 id, bytes32 packageDigest) internal {
        vm.prank(operator);
        e.submitEvidence(id, packageDigest);
    }

    // ── funding ───────────────────────────────────────────────────────────────────────────────────
    function test_FundFreezesAndReservesExactG() public {
        // f = floor(1000e6 * 235 / 10000) = 23_500000
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
        assertEq(e.gross(id), 1000e6);
        assertEq(e.fee(id), 23_500000);
        assertEq(e.net(id), 1000e6 - 23_500000);
        assertEq(e.liabilityOf(id), 1000e6);
        assertEq(e.totalLiability(), 1000e6);
        assertEq(usdc.balanceOf(address(e)), 1000e6);
    }

    function test_FundRejectsUnderReceipt() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        usdc.setTransferFromMode(MockToken.Mode.FEE_ON_TRANSFER);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.FundingDeltaMismatch.selector);
        e.fund(c, acc);
    }

    function test_FundRejectsBadInvariant() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].n = 999e6; // N + F != G
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(); // V1: N+F!=G (or payout sum mismatch)
        e.fund(c, acc);
    }

    function test_FundRejectsForbiddenRecipient() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].payouts[0].recipient = address(usdc); // USDC is excluded
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        e.fund(c, acc);
    }

    /// @dev The payer leg of the bilateral acceptance. A non-payer caller carrying NO payer signature is
    ///      rejected as `OnlyPayer` — the payer's acceptance is implicit only for a direct payer-sent tx.
    function test_FundOnlyPayerAndSealed() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.expectRevert(VNextSettlementEscrow.OnlyPayer.selector);
        e.fund(c, acc); // not the payer, and no payer signature supplied
        _fund(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.AlreadySealed.selector);
        e.fund(c, acc);
    }

    // ── release via dispute-win + distribution ────────────────────────────────────────────────────
    function test_DisputeOperatorWin_ReleasesExactlyG() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, true);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(recip1), (1000e6 - 23_500000) / 2);
        assertEq(usdc.balanceOf(recip2), (1000e6 - 23_500000) - (1000e6 - 23_500000) / 2);
        assertEq(usdc.balanceOf(feeDest), 23_500000);
        assertEq(e.totalLiability(), 0);
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    function test_DisputePayerWin_RefundsExactlyG() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, false);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + 1000e6);
        assertEq(e.totalLiability(), 0);
    }

    function test_ReclaimAfterDeadline_Refunds() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.expectRevert(VNextSettlementEscrow.TooEarlyToReclaim.selector);
        e.reclaimAfterDeadline(id);
        vm.warp(block.timestamp + 31 days);
        uint256 payerBefore = usdc.balanceOf(payer);
        e.reclaimAfterDeadline(id); // permissionless
        assertEq(usdc.balanceOf(payer), payerBefore + 1000e6);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
    }

    // ── transfer-classifier matrix ────────────────────────────────────────────────────────────────
    function test_Classifier_SafeRevert_CreatesClaim_ThenDischarge() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.REVERT); // solvent, but every payout push reverts -> CLAIM
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, true);
        // no payouts moved; 2 claims outstanding; liability intact
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED));
        assertEq(e.liabilityOf(id), 1000e6);
        assertEq(usdc.balanceOf(recip1), 0);
        // now discharge one claim
        usdc.setTransferMode(MockToken.Mode.NORMAL);
        bytes32 claim0 =
            VNextSettlementLib.computeClaimId(block.chainid, address(e), id, 0, ClaimClass.PRINCIPAL);
        e.dischargeClaim(claim0);
        assertEq(usdc.balanceOf(recip1), 500e6);
        assertEq(e.liabilityOf(id), 500e6);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED));
    }

    function test_Classifier_DebitNoCredit_RevertsAll() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.DEBIT_NO_CREDIT);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        vm.expectRevert(VNextSettlementEscrow.WrongTransferDelta.selector);
        e.resolveDispute(id, true);
    }

    function test_Classifier_FalseWithMove_RevertsAll() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.RETURN_FALSE_WITH_MOVE);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        vm.expectRevert(VNextSettlementEscrow.NonCanonicalTransferReturn.selector);
        e.resolveDispute(id, true);
    }

    // ── buyer approval (Tier-0) ───────────────────────────────────────────────────────────────────
    function _buyerApproval(VNextSettlementEscrow e, bytes32 id)
        internal
        view
        returns (VNextSettlementEscrow.BuyerApproval memory a)
    {
        a = VNextSettlementEscrow.BuyerApproval({
            chainId: block.chainid,
            escrow: address(e),
            contractVersion: e.CONTRACT_VERSION(),
            settlementUnitId: id,
            payer: payer,
            jobIdHash: JOB,
            termsHash: TERMS,
            g: e.gross(id),
            f: e.fee(id),
            n: e.net(id),
            feeScheduleHash: e.feeScheduleHashOf(id),
            payoutConfigHash: e.payoutConfigHashOf(id),
            decision: uint8(AuthorizationType.BUYER_APPROVAL),
            approvalNonce: 0,
            expiry: block.timestamp + 1 hours
        });
    }

    function _domainSep(address e) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("VNextSettlementEscrow")),
                keccak256(bytes("1")),
                block.chainid,
                e
            )
        );
    }

    function _buyerStructHash(VNextSettlementEscrow.BuyerApproval memory a) internal pure returns (bytes32) {
        bytes32 th = keccak256(
            "BuyerApproval(uint256 chainId,address escrow,uint256 contractVersion,bytes32 settlementUnitId,address payer,bytes32 jobIdHash,bytes32 termsHash,uint256 g,uint256 f,uint256 n,bytes32 feeScheduleHash,bytes32 payoutConfigHash,uint8 decision,uint256 approvalNonce,uint256 expiry)"
        );
        return keccak256(
            bytes.concat(
                abi.encode(th, a.chainId, a.escrow, a.contractVersion, a.settlementUnitId, a.payer, a.jobIdHash, a.termsHash),
                abi.encode(a.g, a.f, a.n, a.feeScheduleHash, a.payoutConfigHash, a.decision, a.approvalNonce, a.expiry)
            )
        );
    }

    function test_BuyerApproval_SignedRelease() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 0)); // Tier-0, no fee
        bytes32 id = _unitId(e);
        VNextSettlementEscrow.BuyerApproval memory a = _buyerApproval(e, id);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSep(address(e)), _buyerStructHash(a)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        e.approveByBuyer(id, a, abi.encodePacked(r, s, v)); // relayed by anyone
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(recip1), 500e6);
    }

    function test_BuyerApproval_DirectCall() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 0));
        bytes32 id = _unitId(e);
        VNextSettlementEscrow.BuyerApproval memory a = _buyerApproval(e, id);
        vm.prank(payer);
        e.approveByBuyer(id, a, ""); // direct payer call, no signature
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    function test_BuyerApproval_RejectsWrongTier() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1)); // Tier-1
        bytes32 id = _unitId(e);
        VNextSettlementEscrow.BuyerApproval memory a = _buyerApproval(e, id);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.NotTier0.selector);
        e.approveByBuyer(id, a, "");
    }

    // ── evidence release (P0-6 direct cohort assertion; no EAS anywhere on this path) ──────────────
    function _o5FullVerdict(VNextSettlementEscrow e, bytes32 id, uint8 decision, uint8 achieved)
        internal
        view
        returns (O5Verdict memory v)
    {
        v = O5Verdict({
            jobIdHash: JOB,
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            // §B: the O5 field carries the escrow's domain-separated commitment over the committed package
            evidenceBundleHash: _commitment(e, id, PKG),
            achievedTier: achieved,
            requestedTier: 1,
            decision: decision,
            verdictHash: keccak256("verdict"),
            feeBps: e.feeBpsOf(id),
            feeRecipient: e.feeRecipientOf(id),
            feeScheduleHash: e.feeScheduleHashOf(id),
            settlementUnitId: id,
            oracleAuthEpoch: COHORT,
            compositionRoot: bytes32(0)
        });
    }

    /// @dev The direct cohort assertion the escrow's money path reads (P0-6), derived from the same
    ///      verdict the oracle would have signed. `assertionId` stands in for the EIP-712 digest the real
    ///      attester records — the escrow only requires it to be non-zero and uses it as the §2
    ///      authorization key seed; the digest binding itself is proven end-to-end against the REAL
    ///      attester further down this file and in Fixed2of3O5Attester.t.sol.
    function _assertionFor(O5Verdict memory v, address escrow) internal view returns (O5Assertion memory a) {
        a = O5Assertion({
            assertionId: ASSERTION_1,
            feeScheduleHash: v.feeScheduleHash,
            compositionRoot: v.compositionRoot,
            evidenceBundleHash: v.evidenceBundleHash,
            escrow: escrow,
            assertedAt: uint64(block.timestamp),
            achievedTier: v.achievedTier,
            requestedTier: v.requestedTier,
            decision: v.decision,
            feeRecipient: v.feeRecipient,
            oracleAuthEpoch: v.oracleAuthEpoch,
            feeBps: v.feeBps
        });
    }

    /// @dev Bind an assertion for (e, id) built from the canonical verdict for that unit.
    function _assert(VNextSettlementEscrow e, bytes32 id, uint8 decision, uint8 achieved) internal {
        attester.setAssertion(id, _assertionFor(_o5FullVerdict(e, id, decision, achieved), address(e)));
    }

    function test_EvidenceRelease_Settle() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG); // §B: commit the package BEFORE the verdict exists
        _assert(e, id, 1, 1); // decision=SETTLE(1), achieved>=required
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
    }

    /// @dev MIGRATED from `test_EvidenceRelease_RejectsWrongAttester`. On the EAS rail the escrow compared
    ///      `attestation.attester == authorizedOracle`, because ANY address could mint into the shared
    ///      registry. On the assertion rail the escrow CALLS its immutable `authorizedOracle` directly, so
    ///      a foreign attester's record is unreachable rather than rejected — the check is structurally
    ///      subsumed and cannot be written as a test any more. What survives as a real hazard is the OTHER
    ///      half of that binding: a genuine cohort assertion made for a DIFFERENT escrow must not pay this
    ///      one. That is the `WrongRecipient` successor, asserted here.
    function test_EvidenceRelease_RejectsAssertionBoundToAnotherEscrow() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Assertion memory a = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(0xE5C0F)); // another escrow
        attester.setAssertion(id, a);
        vm.expectRevert(VNextSettlementEscrow.WrongRecipient.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev Twin of the above: an escrow bound to a DIFFERENT attester sees no assertion at all. This is
    ///      what "wrong attester" degrades to once the trust root is the callee rather than a field.
    function test_EvidenceRelease_ForeignAttesterAssertionIsUnreachable() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        // A different, non-authorized attester holds a perfectly-formed assertion for this exact unit.
        MockOracleAttester rogue = new MockOracleAttester(COHORT);
        rogue.setAssertion(id, _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e)));
        assertTrue(rogue.assertionOf(id).assertionId != bytes32(0), "the rogue record exists");
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        e.releaseFromEvidence(id); // the escrow only ever reads its own immutable authorizedOracle
    }

    function test_EvidenceRelease_RejectsUnderTier() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 2); // requiredTier 2
        VNextSettlementEscrow e = _fundedEscrow(JOB, c);
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        // achieved 2 but requested 1 != the frozen requiredTier 2
        attester.setAssertion(id, _assertionFor(_o5verdict(id, 1, 2, 1), address(e)));
        vm.expectRevert(VNextSettlementEscrow.RequestedTierMismatch.selector);
        e.releaseFromEvidence(id);
    }

    /// @dev The lower tier bound in its own right: achieved < the frozen requiredTier cannot settle.
    function test_EvidenceRelease_RejectsAchievedBelowRequired() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 2)); // requiredTier 2
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        attester.setAssertion(id, _assertionFor(_o5verdict(id, 1, 1, 2), address(e))); // achieved 1 < 2
        vm.expectRevert(VNextSettlementEscrow.TierNotMet.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev M-01: the release path binds the RAW `feeBps`, not just its 13-field hash. A verdict with the
    ///      correct feeScheduleHash but a false feeBps (the false economics permanently recorded in the
    ///      assertion) must not settle; the unit stays FUNDED_ACTIVE.
    function test_EvidenceRelease_RejectsMismatchedFeeBps() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.feeBps = 900; // != the frozen 235, though feeScheduleHash stays correct
        attester.setAssertion(id, _assertionFor(v, address(e)));
        vm.expectRevert(VNextSettlementEscrow.FeeBpsMismatch.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev M-01 twin: a false `feeRecipient` (correct hash) must not settle either.
    function test_EvidenceRelease_RejectsMismatchedFeeRecipient() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.feeRecipient = address(0xBADD); // != the frozen feeDest
        attester.setAssertion(id, _assertionFor(v, address(e)));
        vm.expectRevert(VNextSettlementEscrow.FeeRecipientMismatch.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev The frozen 13-field fee commitment in its own right.
    function test_EvidenceRelease_RejectsMismatchedFeeScheduleHash() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.feeScheduleHash = keccak256("stale-fee-schedule");
        attester.setAssertion(id, _assertionFor(v, address(e)));
        vm.expectRevert(VNextSettlementEscrow.FeeHashMismatch.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev A non-SETTLE decision never releases. (The real attester also refuses to assert one at all —
    ///      `NotSettleVerdict` — so this is the escrow-side half of a doubly-guarded property.)
    function test_EvidenceRelease_RejectsNonSettleDecision() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        _assert(e, id, 2, 1); // decision 2 != O5_DECISION_SETTLE
        vm.expectRevert(VNextSettlementEscrow.NotSettle.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev M-01: the release path bounds the ORACLE-asserted `achievedTier` to the supported max (3). An
    ///      out-of-range tier is only lower-bounded (`>= requiredTier`) elsewhere, so it must be rejected here.
    function test_EvidenceRelease_RejectsAchievedTierAboveMax() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1)); // requiredTier 1
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        _assert(e, id, 1, 4); // SETTLE, achievedTier 4 (> MAX_TIER)
        vm.expectRevert(VNextSettlementEscrow.TierOutOfRange.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    function _o5verdict(bytes32 id, uint8 decision, uint8 achieved, uint8 requested)
        internal
        pure
        returns (O5Verdict memory v)
    {
        v = O5Verdict({
            jobIdHash: JOB,
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            evidenceBundleHash: keccak256("bundle"),
            achievedTier: achieved,
            requestedTier: requested,
            decision: decision,
            verdictHash: keccak256("verdict"),
            feeBps: 0,
            feeRecipient: address(0),
            feeScheduleHash: bytes32(0),
            settlementUnitId: id,
            oracleAuthEpoch: COHORT,
            compositionRoot: bytes32(0)
        });
    }

    // ── gate-2: production-shaped max-aggregate funding gas + calldata-bound fit ───────────────────
    function test_gas_maxAggregateFunding_fits() public {
        uint256 UNITS = VNextSettlementLib.MAX_SETTLEMENT_UNITS; // 16
        uint256 LEGS = VNextSettlementLib.MAX_PAYOUT_LEGS_PER_UNIT; // 16
        uint256 legAmt = 1e6;
        uint256 n = legAmt * LEGS;
        VNextSettlementEscrow.UnitConfig[] memory cfgs = new VNextSettlementEscrow.UnitConfig[](UNITS);
        for (uint256 u; u < UNITS; ++u) {
            PayoutEntry[] memory po = new PayoutEntry[](LEGS);
            for (uint256 j; j < LEGS; ++j) {
                po[j] = PayoutEntry({recipient: address(uint160(0x100000 + u * LEGS + j + 1)), amount: legAmt});
            }
            cfgs[u] = VNextSettlementEscrow.UnitConfig({
                milestoneIndex: u,
                stepId: keccak256(abi.encode("step", u)),
                requiredTier: 1,
                requestedTier: 1,
                g: n,
                f: 0,
                n: n,
                feeBps: 0,
                feeRecipient: address(0),
                disputeWindow: 1 days,
                reclaimAt: block.timestamp + 30 days,
                compositionSchemaVersion: 0,
                compositionRoot: bytes32(0),
                evidenceCommitter: operator,
                payouts: po
            });
        }
        VNextSettlementEscrow e = _escrowFor(keccak256("job-max"), cfgs);
        // L-01 calldata bound. This config is 16 units x 16 legs == MAX_TOTAL_LEGS_PER_JOB, i.e. the largest
        // config the contract SEMANTICALLY ACCEPTS, carried alongside the largest acceptance the contract
        // semantically accepts (two MAX_SIGNATURE_BYTES signatures — an ERC-1271 smart account may need
        // them), so it must fit — a bound below it is a funding DoS on a legal input. Asserted as an EXACT
        // equality too, so adding a UnitConfig/PolicyAcceptance field without re-pinning MAX_CONFIG_BYTES
        // (either direction) fails here rather than in production.
        VNextSettlementEscrow.PolicyAcceptance memory maxAcc = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: false,
            payerSignature: new bytes(VNextSettlementLib.MAX_SIGNATURE_BYTES),
            operatorSignature: new bytes(VNextSettlementLib.MAX_SIGNATURE_BYTES)
        });
        bytes memory cd = abi.encodeCall(VNextSettlementEscrow.fund, (cfgs, maxAcc));
        emit log_named_uint("max-config fund() calldata bytes", cd.length);
        assertLe(cd.length, VNextSettlementLib.MAX_CONFIG_BYTES, "max config must fit MAX_CONFIG_BYTES");
        assertEq(cd.length, VNextSettlementLib.MAX_CONFIG_BYTES, "MAX_CONFIG_BYTES is the exact 16x16 envelope");
        // The max envelope is ACCEPTED by the size gate: it fails on signature validity, never ConfigTooLarge.
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadOperatorSignature.selector);
        e.fund(cfgs, maxAcc);
        // gas of the full 256-entry funding tx with real acceptance signatures.
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, cfgs);
        vm.prank(payer);
        uint256 g0 = gasleft();
        e.fund(cfgs, acc);
        emit log_named_uint("max aggregate funding gas (256 entries)", g0 - gasleft());
        assertEq(e.unitCount(), UNITS);
    }

    // ── gate-2: all-16-legs-DISCHARGE release (realistic, but NOT the worst case — 0 claims created) ──
    /// @dev This drives Mode.NORMAL, so every leg discharges and no claim is created. It is the realistic
    ///      release, kept as a baseline; the TRUE worst case (all legs safe-fail -> claims) is below.
    function test_gas_worstCaseRelease_allDischarge() public {
        uint256 LEGS = VNextSettlementLib.MAX_PAYOUT_LEGS_PER_UNIT;
        uint256 legAmt = 1e6;
        uint256 n = legAmt * LEGS;
        PayoutEntry[] memory po = new PayoutEntry[](LEGS);
        for (uint256 j; j < LEGS; ++j) po[j] = PayoutEntry({recipient: address(uint160(0x200000 + j + 1)), amount: legAmt});
        VNextSettlementEscrow.UnitConfig[] memory cfgs = new VNextSettlementEscrow.UnitConfig[](1);
        cfgs[0] = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            requiredTier: 1,
            requestedTier: 1,
            g: n,
            f: 0,
            n: n,
            feeBps: 0,
            feeRecipient: address(0),
            disputeWindow: 1 days,
            reclaimAt: block.timestamp + 30 days,
            compositionSchemaVersion: 0,
            compositionRoot: bytes32(0),
            evidenceCommitter: operator,
            payouts: po
        });
        VNextSettlementEscrow e = _fundedEscrow(keccak256("job-wc"), cfgs);
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.NORMAL); // all 16 legs discharge -> 0 claims (not the worst case)
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        uint256 g0 = gasleft();
        e.resolveDispute(id, true);
        emit log_named_uint("all-discharge 16-leg release gas (0 claims)", g0 - gasleft());
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    // ── gate-2: TRUE worst-case single-unit release (16 payout + 1 fee leg, all safe-fail -> 17 claims) ─
    /// @dev The claim-heavy release IS the gas ceiling: every one of the 16 payout legs AND the fee leg
    ///      safe-fails (the CLAIM branch of _tryTransferExact), so 17 claims are created, the unit stays
    ///      RELEASE_ALLOCATED with liability == G, and remainingClaimCount == 17. The prior
    ///      test_gas_worstCaseRelease used Mode.NORMAL (all discharge, 0 claims) and so understated the cost.
    function test_gas_worstCaseRelease() public {
        uint256 LEGS = VNextSettlementLib.MAX_PAYOUT_LEGS_PER_UNIT; // 16
        // G = 16_000_000, feeBps = 250 -> F = floor(16e6 * 250 / 10000) = 400_000, N = 15_600_000 = 16 * 975_000.
        uint256 g = 16_000_000;
        uint16 feeBps = 250;
        uint256 f = 400_000;
        uint256 legAmt = 975_000; // 16 * 975_000 == 15_600_000 == N
        PayoutEntry[] memory po = new PayoutEntry[](LEGS);
        for (uint256 j; j < LEGS; ++j) {
            po[j] = PayoutEntry({recipient: address(uint160(0x210000 + j + 1)), amount: legAmt});
        }
        VNextSettlementEscrow.UnitConfig[] memory cfgs = new VNextSettlementEscrow.UnitConfig[](1);
        cfgs[0] = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            requiredTier: 1,
            requestedTier: 1,
            g: g,
            f: f,
            n: g - f,
            feeBps: feeBps,
            feeRecipient: feeDest,
            disputeWindow: 1 days,
            reclaimAt: block.timestamp + 30 days,
            compositionSchemaVersion: 0,
            compositionRoot: bytes32(0),
            evidenceCommitter: operator,
            payouts: po
        });
        VNextSettlementEscrow e = _fundedEscrow(keccak256("job-wc17"), cfgs);
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.REVERT); // every push (16 payouts + fee) safe-fails -> CLAIM
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        uint256 g0 = gasleft();
        e.resolveDispute(id, true);
        emit log_named_uint("TRUE worst-case release gas (17 claims created)", g0 - gasleft());
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED), "claims outstanding -> not settled");
        assertEq(e.liabilityOf(id), g, "a CLAIM never discharges liability; still owes the full G");
        assertEq(e.remainingClaimCountOf(id), 17, "16 payout legs + 1 fee leg = 17 claims");
    }

    // ── gate-2: audit edge cases (dispute-window-0 / payer-arbiter / final-claim-discharge) ────────
    /// @dev MIGRATED (H-01). This test previously PINNED the attack as accepted behaviour: with
    ///      `disputeWindow == 0` the dispute expired in the block it opened, the arbiter was already too
    ///      late, and the permissionless `refundOnDisputeExpiry` refunded the payer in that same block —
    ///      a costless veto over a job the operator had already performed. That configuration is now
    ///      rejected at FUNDING by `MIN_DISPUTE_WINDOW`, so the sequence it enabled is unreachable.
    function test_DisputeWindowZero_RejectedAtFunding() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].disputeWindow = 0;
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadDisputeWindow.selector);
        e.fund(c, acc);
        assertEq(usdc.balanceOf(address(e)), 0, "a rejected policy never takes custody");
    }

    /// @dev MIGRATED (H-01). arbiter == payer is no longer merely "a deployment-config choice the payer
    ///      makes": it is a self-adjudication policy that the OPERATOR must also sign. Once both parties
    ///      have signed it, the end-to-end behaviour is unchanged — the point of the fix is authenticated
    ///      consent, not banning the configuration.
    function test_PayerAsArbiter_RequiresBilateralSelfAdjudication() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        VNextSettlementEscrow e =
            VNextSettlementEscrow(factory.createEscrow(_identity(JOB, payer, 1, c)));
        assertEq(e.arbiter(), payer, "arbiter == payer is still expressible");

        // Without the bilaterally-signed flag the funding is refused outright.
        VNextSettlementEscrow.PolicyAcceptance memory plain = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.SelfAdjudicationNotAccepted.selector);
        e.fund(c, plain);

        // With it — signed by BOTH parties over the same JobPolicyHash — the original behaviour holds.
        VNextSettlementEscrow.PolicyAcceptance memory accepted = _acceptance(e, c, true, POLICY_EXPIRY, false);
        vm.prank(payer);
        e.fund(c, accepted);
        (,,,,, bool selfAdj) = e.policy();
        assertTrue(selfAdj, "self-adjudication recorded on-chain as bilaterally accepted");

        bytes32 id = _unitId(e);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(payer); // the same address is also the arbiter
        e.resolveDispute(id, true); // operator-win -> release
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
    }

    /// @dev Discharging the LAST outstanding claim (remainingClaimCount -> 0) transitions the unit to
    ///      SETTLED_RELEASED. Two payout legs both safe-fail -> 2 claims; the second discharge settles it.
    function test_FinalClaimDischarge_TransitionsToSettled() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1)); // 2 payout legs, no fee
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.REVERT); // both pushes -> CLAIM
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, true);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED));
        assertEq(e.remainingClaimCountOf(id), 2);

        usdc.setTransferMode(MockToken.Mode.NORMAL); // now the claims can discharge
        bytes32 claim0 = VNextSettlementLib.computeClaimId(block.chainid, address(e), id, 0, ClaimClass.PRINCIPAL);
        bytes32 claim1 = VNextSettlementLib.computeClaimId(block.chainid, address(e), id, 1, ClaimClass.PRINCIPAL);
        e.dischargeClaim(claim0);
        assertEq(e.remainingClaimCountOf(id), 1, "one claim left");
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED), "not settled until the last claim");

        e.dischargeClaim(claim1); // the FINAL claim
        assertEq(e.remainingClaimCountOf(id), 0);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "final discharge settles the unit");
        assertEq(e.liabilityOf(id), 0);
        assertEq(usdc.balanceOf(recip1), 500e6);
        assertEq(usdc.balanceOf(recip2), 500e6);
    }

    // ── gate-1: byte-exact golden vectors for the oracle/evidence ethers/viem mirror (M2) ─────────
    // Canonical fixed inputs: chainId=8453 (Base), escrow=0x…E5C0F, jobIdHash=keccak("golden-job"),
    // milestoneIndex=3, stepId=keccak("golden-step"), G/F/N=1000000/23500/976500, feeBps=235.
    function test_emit_goldenVectors() public {
        uint256 cid = 8453;
        address ESC = address(0xE5C0F);
        bytes32 jobIdHash = keccak256("golden-job");
        uint256 mi = 3;
        bytes32 stepId = keccak256("golden-step");

        bytes32 unitId = VNextSettlementLib.computeSettlementUnitId(cid, ESC, jobIdHash, mi, stepId);
        emit log_named_bytes32("settlementUnitId", unitId);

        FeeSchedule memory fs = FeeSchedule({
            domainVersion: 1,
            chainId: cid,
            escrow: ESC,
            settlementUnitId: unitId,
            feeBasis: 0,
            g: 1_000_000,
            f: 23_500,
            n: 976_500,
            feeBps: 235,
            denominator: 10_000,
            roundingRule: 0,
            feeRecipient: address(0xFEE0),
            feeSplitConfigHash: bytes32(0)
        });
        emit log_named_bytes32("feeScheduleHash", VNextSettlementLib.computeFeeScheduleHash(fs));

        PayoutEntry[] memory po = new PayoutEntry[](2);
        po[0] = PayoutEntry({recipient: address(0xAAA1), amount: 500_000});
        po[1] = PayoutEntry({recipient: address(0xBBB2), amount: 476_500});
        emit log_named_bytes32("payoutConfigHash", VNextSettlementLib.computePayoutConfigHash(unitId, po));

        emit log_named_bytes32(
            "claimId_PRINCIPAL_leg0", VNextSettlementLib.computeClaimId(cid, ESC, unitId, 0, ClaimClass.PRINCIPAL)
        );
        emit log_named_bytes32(
            "claimId_FEE", VNextSettlementLib.computeClaimId(cid, ESC, unitId, type(uint256).max, ClaimClass.FEE)
        );

        O5Verdict memory v = O5Verdict({
            jobIdHash: jobIdHash,
            milestoneIndex: mi,
            stepId: stepId,
            evidenceBundleHash: keccak256("golden-bundle"),
            achievedTier: 2,
            requestedTier: 2,
            decision: 1,
            verdictHash: keccak256("golden-verdict"),
            feeBps: 235,
            feeRecipient: address(0xFEE0),
            feeScheduleHash: VNextSettlementLib.computeFeeScheduleHash(fs),
            settlementUnitId: unitId,
            oracleAuthEpoch: 7,
            compositionRoot: keccak256("golden-composition-root")
        });
        bytes memory o5 = abi.encode(v);
        emit log_named_uint("o5Verdict_encoded_bytes", o5.length); // rev-3: MUST be 448
        emit log_named_bytes32("o5Verdict_keccak", keccak256(o5)); // the 448 golden the oracle re-runs parity on
        assertEq(o5.length, 448, "rev-3 O5Verdict golden must be 448 bytes");
        assertEq(o5.length, O5_VERDICT_BYTES, "golden length mirrors the imported constant");
    }

    // ── rev-3: O5 layout (448) + cohort/composition bindings ───────────────────────────────────────
    function test_O5Verdict_encoding_is_448_and_roundtrips() public pure {
        O5Verdict memory v = O5Verdict({
            jobIdHash: keccak256("j"),
            milestoneIndex: 5,
            stepId: keccak256("s"),
            evidenceBundleHash: keccak256("b"),
            achievedTier: 2,
            requestedTier: 2,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("vh"),
            feeBps: 235,
            feeRecipient: address(0xFEE0),
            feeScheduleHash: keccak256("fh"),
            settlementUnitId: keccak256("u"),
            oracleAuthEpoch: 7,
            compositionRoot: keccak256("cr")
        });
        bytes memory enc = abi.encode(v);
        assertEq(enc.length, 448, "14 static ABI words == 448 bytes");
        assertEq(enc.length, O5_VERDICT_BYTES, "constant mirrors layout");
        assertEq(uint256(O5_DECISION_SETTLE), 1, "SETTLE == 1");

        O5Verdict memory d = abi.decode(enc, (O5Verdict));
        assertEq(d.jobIdHash, v.jobIdHash);
        assertEq(d.milestoneIndex, v.milestoneIndex);
        assertEq(d.stepId, v.stepId);
        assertEq(d.evidenceBundleHash, v.evidenceBundleHash);
        assertEq(d.achievedTier, v.achievedTier);
        assertEq(d.requestedTier, v.requestedTier);
        assertEq(d.decision, v.decision);
        assertEq(d.verdictHash, v.verdictHash);
        assertEq(d.feeBps, v.feeBps);
        assertEq(d.feeRecipient, v.feeRecipient);
        assertEq(d.feeScheduleHash, v.feeScheduleHash);
        assertEq(d.settlementUnitId, v.settlementUnitId);
        assertEq(d.oracleAuthEpoch, v.oracleAuthEpoch);
        assertEq(d.compositionRoot, v.compositionRoot);
    }

    function test_Fund_PinsCohort_And_RejectsWhenDisabled() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        assertEq(e.oracleAuthEpoch(), COHORT, "fund pins the attester cohort id");

        // a fresh escrow funded while the cohort is disabled must revert (fail-closed).
        VNextSettlementEscrow.UnitConfig[] memory c2 = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e2 = _escrowFor(keccak256("job-2"), c2);
        VNextSettlementEscrow.PolicyAcceptance memory acc2 = _acceptance(e2, c2);
        attester.setEnabled(false);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.InvalidOrDisabledCohort.selector);
        e2.fund(c2, acc2);
    }

    function test_Fund_RevertsWhenRequiredTierNeRequestedTier() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].requestedTier = 2; // != requiredTier (1)
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.TierRequestMismatch.selector);
        e.fund(c, acc);
    }

    function test_EvidenceRelease_RevertsWhenCohortDisabled() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        _assert(e, id, 1, 1); // an otherwise-valid assertion already exists
        attester.setEnabled(false); // cohort disabled AFTER the assertion — must neutralize it at payment time
        vm.expectRevert(VNextSettlementEscrow.OracleCohortDisabled.selector);
        e.releaseFromEvidence(id);
    }

    function test_EvidenceRelease_RevertsOnCohortEpochMismatch() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.oracleAuthEpoch = COHORT + 1; // wrong epoch
        attester.setAssertion(id, _assertionFor(v, address(e)));
        vm.expectRevert(VNextSettlementEscrow.OracleCohortMismatch.selector);
        e.releaseFromEvidence(id);
    }

    function test_EvidenceRelease_RevertsOnCompositionRootMismatch() public {
        // unit.compositionRoot == 0
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.compositionRoot = keccak256("some-other-root"); // != frozen 0
        attester.setAssertion(id, _assertionFor(v, address(e)));
        vm.expectRevert(VNextSettlementEscrow.CompositionRootMismatch.selector);
        e.releaseFromEvidence(id);
    }

    function test_EvidenceRelease_CompositionHappyPath() public {
        bytes32 root = keccak256("composed-root");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        c[0].compositionSchemaVersion = 1;
        c[0].compositionRoot = root;
        VNextSettlementEscrow e = _fundedEscrow(JOB, c);
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.compositionRoot = root; // matches the frozen unit root
        attester.setAssertion(id, _assertionFor(v, address(e)));
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
    }

    // ── L-01: claim / dispute / one-shot read surfaces ────────────────────────────────────────────
    /// @dev claimOf + remainingClaimCountOf expose the collateralized-claim state created when a payout
    ///      push safe-fails during allocation; claimOf is existence-checked.
    function test_L01_claimOf_and_remainingClaimCount() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1)); // 2 payout legs, no fee
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.REVERT); // every push -> CLAIM
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, true);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED));
        assertEq(e.remainingClaimCountOf(id), 2, "two outstanding claims");

        bytes32 claim0 = VNextSettlementLib.computeClaimId(block.chainid, address(e), id, 0, ClaimClass.PRINCIPAL);
        VNextSettlementEscrow.ClaimRecord memory c = e.claimOf(claim0);
        assertTrue(c.exists);
        assertEq(c.settlementUnitId, id);
        assertEq(c.claimOwner, recip1);
        assertEq(c.claimDestination, recip1);
        assertEq(c.amount, 500e6);
        assertEq(uint256(c.class), uint256(ClaimClass.PRINCIPAL));
        assertEq(c.destinationNonce, 0);

        vm.expectRevert(VNextSettlementEscrow.ClaimNotFound.selector);
        e.claimOf(keccak256("no-such-claim"));
    }

    /// @dev disputeOf surfaces the dispute record set by openDispute; existence-checked.
    function test_L01_disputeOf() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        VNextSettlementEscrow.Dispute memory pre = e.disputeOf(id);
        assertFalse(pre.opened, "no dispute before openDispute");
        assertEq(pre.nonce, 0);

        vm.prank(payer);
        e.openDispute(id);
        VNextSettlementEscrow.Dispute memory d = e.disputeOf(id);
        assertTrue(d.opened);
        assertFalse(d.resolved);
        assertEq(d.nonce, 1);
        assertEq(d.openedAt, block.timestamp);
        assertEq(d.adjudicationDeadline, block.timestamp + 1 days);
        assertEq(d.effectiveDisputeExpiry, block.timestamp + 1 days, "min(deadline, reclaimAt) = deadline");

        vm.expectRevert(VNextSettlementEscrow.UnitNotFound.selector);
        e.disputeOf(keccak256("no-such-unit"));
    }

    /// @dev MIGRATED from `test_L01_easUidUsed_and_authorizationUsed`. P0-6 removed `easUidUsed` with the
    ///      EAS read; the replay guard it provided now lives in `authorizationUsed`, whose key is derived
    ///      from the ASSERTION ID. This asserts the same property on the new rail: the §2 evidence
    ///      authorization key reads false before the release and true after, and an unissued key reads
    ///      false. The key is recomputed here exactly as the escrow derives it, so a change to the
    ///      authorization-key envelope breaks this test rather than passing silently.
    function test_L01_evidenceAuthorizationKey_and_authorizationUsed() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        bytes32 authKey = keccak256(
            abi.encode(
                uint8(AuthorizationType.EVIDENCE),
                keccak256("PCC:vnext:auth:evidence:v1"),
                address(attester),
                ASSERTION_1, // rawAuthorizationId == the assertion id (was: the EAS uid)
                block.chainid,
                address(e),
                id
            )
        );
        assertFalse(e.authorizationUsed(authKey), "evidence auth key unused before release");
        assertFalse(e.authorizationUsed(keccak256("never-issued")), "an unissued auth key reads false");

        _assert(e, id, 1, 1);
        e.releaseFromEvidence(id);
        assertTrue(e.authorizationUsed(authKey), "evidence auth key consumed after release");
    }

    // ── L-01/L-02: config-envelope pin + type-hash deployment pin ─────────────────────────────────
    /// @dev L-01: MAX_CONFIG_BYTES is the EXACT canonical envelope, not a round number above it. The
    ///      max-config fit is asserted in test_gas_maxAggregateFunding_fits; this pins the constant itself
    ///      so a future UnitConfig field cannot silently leave slack (or, worse, make the max unfundable).
    function test_MaxConfigBytes_IsTheExactCanonicalEnvelope() public pure {
        // 24,644 B at rev-3, + 512 B for §B's per-unit `evidenceCommitter` (16 units x 32 B) = 25,156 B,
        // + 2,272 B for the H-01 `PolicyAcceptance` argument (64 B of extra arg head + 128 B struct head
        // + 2 x (32 + MAX_SIGNATURE_BYTES) of signature tail) = 27,428 B.
        assertEq(VNextSettlementLib.MAX_CONFIG_BYTES, 27_428, "16 units x 16 legs + max acceptance");
    }

    /// @dev L-02: a non-zero `o5TypeHash` deployment pin must equal the bound cohort's live type hash.
    function test_Constructor_RejectsTypeHashDrift() public {
        vm.expectRevert(VNextSettlementEscrow.TypeHashMismatch.selector);
        new VNextSettlementEscrowFactory(
            address(usdc), address(attester), O5_SCHEMA, keccak256("some-other-typehash")
        );
    }

    /// @dev M-02: a non-zero `o5SchemaUid` deployment pin must equal the bound cohort's live schema UID —
    ///      symmetric with the type-hash pin, so a schema divergence can never ship (it would otherwise
    ///      burn every unit's slot on mint and revert `WrongSchema` at release, turning the cohort
    ///      refund-only). Here the pinned schema differs from the attester's while the type hash is zero,
    ///      so ONLY the schema check fires.
    function test_Constructor_RejectsSchemaUidDrift() public {
        vm.expectRevert(VNextSettlementEscrow.SchemaUidMismatch.selector);
        new VNextSettlementEscrowFactory(
            address(usdc), address(attester), keccak256("some-other-schema"), bytes32(0)
        );
    }

    /// @dev The setUp factory already pins O5_SCHEMA == attester.o5SchemaUid(); state the accept-path intent.
    function test_Constructor_AcceptsMatchingSchemaUid() public view {
        assertEq(VNextSettlementEscrow(factory.implementation()).o5SchemaUid(), attester.o5SchemaUid());
    }

    function test_Constructor_AcceptsMatchingTypeHash() public {
        VNextSettlementEscrowFactory f = new VNextSettlementEscrowFactory(
            address(usdc), address(attester), O5_SCHEMA, attester.o5TypeHash()
        );
        assertEq(VNextSettlementEscrow(f.implementation()).o5TypeHash(), attester.o5TypeHash());
    }

    /// @dev Zero stays the documented deferred state: unpinned, no check, no security claim (the setUp
    ///      factory already exercises it — this states the intent explicitly).
    function test_Constructor_ZeroTypeHashSkipsThePin() public view {
        assertEq(VNextSettlementEscrow(factory.implementation()).o5TypeHash(), bytes32(0));
    }

    // ══ H-01: CREATE2 salt rebound to the BILATERAL POLICY IDENTITY ════════════════════════════════
    // The rev-3 salt was `keccak256(abi.encode(payer, arbiter, jobIdHash, termsHash))`. It is retired and
    // superseded: the salt now binds payer, operator, arbiter, jobIdHash, termsHash, policyNonce AND
    // prePolicyRoot. The property it provided must be PRESERVED, not merely renamed — these tests hold it.

    /// @dev predictEscrow must equal the address createEscrow actually deploys for matching args — both
    ///      parties compute one address, derive the unit ids from it, sign it, and fund exactly that clone.
    function test_Factory_PredictMatchesCreate() public {
        bytes32 job = keccak256("h01-predict-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        PolicyIdentity memory id = _identity(job, arbiter, 1, c);
        address predicted = factory.predictEscrow(id);
        address created = factory.createEscrow(id);
        assertEq(created, predicted, "predictEscrow == the deployed clone for matching args");
    }

    /// @dev PRESERVED from rev-3: changing ONLY the arbiter changes the address, so a front-run with a
    ///      HOSTILE arbiter cannot occupy the address the parties computed and funded.
    function test_Factory_ArbiterIsBoundIntoTheAddress() public {
        bytes32 job = keccak256("h01-arbiter-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        address hostileArbiter = address(0xB0B0);
        address intended = factory.predictEscrow(_identity(job, arbiter, 1, c));
        address hostileAddr = factory.predictEscrow(_identity(job, hostileArbiter, 1, c));
        assertTrue(intended != hostileAddr, "a different arbiter must yield a different escrow address");

        // Attacker front-runs with the hostile arbiter: their clone occupies its OWN address, not the payer's.
        address deployedHostile = factory.createEscrow(_identity(job, hostileArbiter, 1, c));
        assertEq(deployedHostile, hostileAddr, "hostile-arbiter clone lands at its own committed address");
        assertTrue(deployedHostile != intended, "front-run cannot occupy the payer's computed address");

        // The intended address is still available, and its clone binds the intended arbiter.
        VNextSettlementEscrow e = VNextSettlementEscrow(factory.createEscrow(_identity(job, arbiter, 1, c)));
        assertEq(address(e), intended, "intended address remains available after the front-run");
        assertEq(e.arbiter(), arbiter, "the funded clone carries the arbiter the parties committed to");
    }

    /// @dev NEW under the rebound salt: every component of the policy identity moves the address. Each
    ///      assertion is one substitution an attacker (or a careless integrator) might attempt.
    function test_Factory_EveryPolicyFieldMovesTheAddress() public view {
        bytes32 job = keccak256("h01-salt-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        address base = factory.predictEscrow(_identity(job, arbiter, 1, c));

        // operator substituted
        PolicyIdentity memory alt = _identity(job, arbiter, 1, c);
        alt.operator = address(0xDEAD01);
        assertTrue(factory.predictEscrow(alt) != base, "a different OPERATOR must move the address");

        // payer substituted
        alt = _identity(job, arbiter, 1, c);
        alt.payer = address(0xDEAD02);
        assertTrue(factory.predictEscrow(alt) != base, "a different PAYER must move the address");

        // policy generation substituted
        assertTrue(factory.predictEscrow(_identity(job, arbiter, 2, c)) != base, "a newer NONCE moves it");

        // termsHash substituted
        alt = _identity(job, arbiter, 1, c);
        alt.termsHash = keccak256("other-terms");
        assertTrue(factory.predictEscrow(alt) != base, "a different TERMS HASH must move the address");

        // jobIdHash substituted
        assertTrue(factory.predictEscrow(_identity(keccak256("other-job"), arbiter, 1, c)) != base, "job moves it");

        // ANY funded term substituted (the pre-policy root) — here a single payout amount.
        VNextSettlementEscrow.UnitConfig[] memory c2 = _oneUnitConfig(1000e6, 0, 0, 1);
        c2[0].payouts[0].amount += 1;
        c2[0].payouts[1].amount -= 1;
        assertTrue(factory.predictEscrow(_identity(job, arbiter, 1, c2)) != base, "altered TERMS move the address");
    }

    /// @dev A permissionless pre-deploy of the EXACT canonical tuple is harmless: it lands at the address
    ///      the parties already committed to, carries exactly their authorities, holds nothing, and the
    ///      subsequent funding is unchanged. Deployment is not authorization — `fund()` is.
    function test_Factory_CanonicalPredeployByAStrangerChangesNothing() public {
        bytes32 job = keccak256("h01-predeploy-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        PolicyIdentity memory id = _identity(job, arbiter, 1, c);
        address predicted = factory.predictEscrow(id);

        vm.prank(address(0xBADBAD)); // a total stranger front-runs the canonical creation
        address created = factory.createEscrow(id);
        assertEq(created, predicted, "the stranger's clone lands at the canonical address");

        VNextSettlementEscrow e = VNextSettlementEscrow(created);
        assertEq(e.payer(), payer);
        assertEq(e.operator(), operator);
        assertEq(e.arbiter(), arbiter);
        assertEq(usdc.balanceOf(created), 0, "a created clone holds nothing until it is funded");

        // Semantics unchanged: the payer still funds it, with the same bilateral acceptance.
        _fund(e, c);
        assertEq(uint256(e.unitState(_unitId(e))), uint256(UnitState.FUNDED_ACTIVE));
        assertEq(usdc.balanceOf(created), 1000e6);
    }

    /// @dev A duplicate canonical creation reverts (CREATE2 collision) — one escrow per policy identity.
    function test_Factory_DuplicateIdentityReverts() public {
        bytes32 job = keccak256("h01-dup-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        factory.createEscrow(_identity(job, arbiter, 1, c));
        vm.expectRevert();
        factory.createEscrow(_identity(job, arbiter, 1, c));
    }

    // ══ H-01: THE ATTACK ═══════════════════════════════════════════════════════════════════════════

    /// @dev THE H-01 REGRESSION. The original attack, verbatim: the payer funds with `arbiter == payer`
    ///      and `disputeWindow == 0`; the operator performs the physical work; the payer then calls
    ///      `openDispute` and `refundOnDisputeExpiry` in the SAME BLOCK and walks away with a full refund
    ///      while the operator is unpaid. The root cause was that no authenticated operator acceptance of
    ///      the funded terms ever existed. Each stage below shows the constraint that now stops it.
    function test_H01_PayerVetoAttack_IsBlockedAtFunding() public {
        // ── Stage 1: the attack configuration as written. `disputeWindow == 0` is rejected in the funding
        //    freeze loop by MIN_DISPUTE_WINDOW — even with the operator's signature, even with the
        //    self-adjudication flag set. The costless-veto TIMING is gone before anything else is checked.
        VNextSettlementEscrow.UnitConfig[] memory hostile = _oneUnitConfig(1000e6, 0, 0, 1);
        hostile[0].disputeWindow = 0;
        VNextSettlementEscrow e0 =
            VNextSettlementEscrow(factory.createEscrow(_identity(JOB, payer, 1, hostile)));
        VNextSettlementEscrow.PolicyAcceptance memory a0 = _acceptance(e0, hostile, true, POLICY_EXPIRY, false);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadDisputeWindow.selector);
        e0.fund(hostile, a0);
        assertEq(usdc.balanceOf(address(e0)), 0, "no custody was ever taken");

        // ── Stage 2: repair the window, keep the self-selected arbiter, and present a HONEST acceptance
        //    (the operator did sign — but signed a policy WITHOUT self-adjudication). Rejected: the payer
        //    cannot appoint itself judge on terms the operator did not accept.
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        bytes32 jobA = keccak256("h01-attack-a");
        VNextSettlementEscrow e1 = VNextSettlementEscrow(factory.createEscrow(_identity(jobA, payer, 1, c)));
        VNextSettlementEscrow.PolicyAcceptance memory a1 = _acceptance(e1, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.SelfAdjudicationNotAccepted.selector);
        e1.fund(c, a1);

        // ── Stage 3: the payer FORGES the consent — flips the self-adjudication flag and signs the
        //    operator leg with its own key. Rejected: the operator's identity is an authenticated
        //    signing identity, not an address the payer writes into a config.
        bytes32 forgedDigest = _digestOf(e1, c, true, POLICY_EXPIRY);
        VNextSettlementEscrow.PolicyAcceptance memory forged = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: true,
            payerSignature: bytes(""),
            operatorSignature: _sign(payerPk, forgedDigest) // the PAYER signing as the operator
        });
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadOperatorSignature.selector);
        e1.fund(c, forged);

        // ── Stage 4: the operator GENUINELY consents to self-adjudication and a legal window. Funding
        //    succeeds — the fix is authenticated consent, not banning configurations. The same-block
        //    sequence is nevertheless unreachable, because `effectiveDisputeExpiry` is strictly after the
        //    block the dispute opened in.
        VNextSettlementEscrow.PolicyAcceptance memory real = _acceptance(e1, c, true, POLICY_EXPIRY, false);
        vm.prank(payer);
        e1.fund(c, real);
        bytes32 id = _unitId(e1);
        uint256 payerBefore = usdc.balanceOf(payer);

        vm.prank(payer);
        e1.openDispute(id);
        vm.expectRevert(VNextSettlementEscrow.DisputeWindowOpen.selector);
        e1.refundOnDisputeExpiry(id); // SAME BLOCK — this is the attack's final move
        assertEq(uint256(e1.unitState(id)), uint256(UnitState.FUNDED_ACTIVE), "funds stay in escrow");
        assertEq(usdc.balanceOf(payer), payerBefore, "the payer took nothing");
    }

    /// @dev The root closure stated on its own: with NO operator signature there is no fundable state at
    ///      all. Everything else above is defence in depth on top of this.
    function test_H01_NoOperatorAcceptance_MeansNoFundedState() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory empty = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: false,
            payerSignature: bytes(""),
            operatorSignature: bytes("")
        });
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadOperatorSignature.selector);
        e.fund(c, empty);
        assertFalse(e.configurationSealed(), "a refused policy leaves the escrow unsealed and unfunded");
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    /// @dev With the SMALLEST LEGAL window the same-block sequence is still unreachable — the property
    ///      does not depend on choosing a large window, it holds at the boundary.
    function test_H01_SameBlockDisputeThenRefund_UnreachableAtTheMinimumWindow() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].disputeWindow = VNextSettlementLib.MIN_DISPUTE_WINDOW;
        VNextSettlementEscrow e = _fundedEscrow(JOB, c);
        bytes32 id = _unitId(e);
        vm.prank(payer);
        e.openDispute(id);
        vm.expectRevert(VNextSettlementEscrow.DisputeWindowOpen.selector);
        e.refundOnDisputeExpiry(id);
        // The arbiter is NOT already expired either — it has the full window to act.
        vm.prank(arbiter);
        e.resolveDispute(id, true);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    // ══ H-01 §8.2 H-1: the predict -> derive -> sign -> deploy -> fund sequence ════════════════════

    /// @dev The canonical sequence, executed in order and asserted at every step. This is the test that
    ///      shows the circular escrow-address dependency is actually broken: the unit ids, and therefore
    ///      the hash both parties sign, are derived from an address that does not exist yet.
    function test_BilateralAcceptance_PredictDeriveSignDeployFund() public {
        bytes32 job = keccak256("h01-sequence-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);

        // 1-2. factory + implementation are fixed; the pre-policy root is address-INDEPENDENT.
        PolicyIdentity memory id = _identity(job, arbiter, 1, c);
        assertEq(id.prePolicyRoot, keccak256(abi.encode(c)), "prePolicyRoot == keccak(abi.encode(configs))");

        // 3. predict the address from the salt that binds that root.
        address predicted = factory.predictEscrow(id);
        assertEq(predicted.code.length, 0, "nothing is deployed yet");

        // 4. derive the settlementUnitIds from the PREDICTED address.
        bytes32 predictedUnitId = VNextSettlementLib.computeSettlementUnitId(
            block.chainid, predicted, job, c[0].milestoneIndex, c[0].stepId
        );
        bytes32 unitsRoot = keccak256(abi.encode(bytes32(0), predictedUnitId));
        assertEq(unitsRoot, _unitsRootFor(predicted, job, c), "units root derived from the predicted address");

        // 5. build the JobPolicyHash and 6. both parties sign it — still before deployment.
        VNextSettlementEscrow.PolicyAcceptance memory acc = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: false,
            payerSignature: bytes(""), // implicit: the payer sends the tx
            operatorSignature: _sign(
                operatorPk,
                _policyDigest(
                    PolicyArgs({
                        escrowAddr: predicted,
                        factoryAddr: address(factory),
                        impl: factory.implementation(),
                        job: job,
                        arb: arbiter,
                        nonce: 1,
                        preRoot: id.prePolicyRoot,
                        unitsRoot: unitsRoot,
                        allowSelf: false,
                        expiry: POLICY_EXPIRY
                    })
                )
            )
        });

        // 7. deploy at the predicted address.
        VNextSettlementEscrow e = VNextSettlementEscrow(factory.createEscrow(id));
        assertEq(address(e), predicted, "the clone lands exactly where both parties signed");
        assertEq(e.operator(), operator, "the escrow now STORES an authenticated operator identity");

        // 8. fund: both signatures verified + the policy nonce consumed, atomically.
        vm.prank(payer);
        e.fund(c, acc);

        assertEq(_unitId(e), predictedUnitId, "the funded unit id is the one that was signed");
        assertEq(usdc.balanceOf(address(e)), 1000e6);
        _assertAcceptedPolicy(e, job, id.prePolicyRoot);
    }

    /// @dev Split out of the sequence test to keep its stack shallow.
    function _assertAcceptedPolicy(VNextSettlementEscrow e, bytes32 job, bytes32 expectedPreRoot) internal view {
        (,, uint256 nonce_, bytes32 preRoot_, bytes32 policyHash_, bool selfAdj_) = e.policy();
        assertEq(nonce_, 1);
        assertEq(preRoot_, expectedPreRoot);
        assertFalse(selfAdj_);
        assertTrue(policyHash_ != bytes32(0), "the authenticated policy hash is recorded on-chain");
        assertEq(factory.policyNonceFloor(factory.policyKey(payer, operator, job)), 2, "nonce consumed");
    }

    // ══ H-01 §2.1: bilateral acceptance — the failure modes ════════════════════════════════════════

    function test_BilateralAcceptance_RejectsWrongOperatorSigner() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        bytes32 digest = _digestOf(e, c, false, POLICY_EXPIRY);
        VNextSettlementEscrow.PolicyAcceptance memory acc = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: false,
            payerSignature: bytes(""),
            operatorSignature: _sign(0xB0B, digest) // a valid signature — by the wrong identity
        });
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadOperatorSignature.selector);
        e.fund(c, acc);
    }

    /// @dev A signature over a DIFFERENT policy (here: the self-adjudication flag flipped) does not
    ///      validate against the policy actually being funded.
    function test_BilateralAcceptance_RejectsSignatureOverADifferentPolicy() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        bytes32 otherDigest = _digestOf(e, c, true, POLICY_EXPIRY); // signed WITH self-adjudication
        VNextSettlementEscrow.PolicyAcceptance memory acc = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: false, // ...but funded WITHOUT it
            payerSignature: bytes(""),
            operatorSignature: _sign(operatorPk, otherDigest)
        });
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadOperatorSignature.selector);
        e.fund(c, acc);
    }

    function test_BilateralAcceptance_RejectsExpiredPolicy() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        uint256 expiry = block.timestamp + 1 hours;
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c, false, expiry, false);
        vm.warp(expiry + 1);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.PolicyExpired.selector);
        e.fund(c, acc);
    }

    /// @dev The escrow's ADDRESS commits to the terms: funding it with different configs is refused before
    ///      any signature is even consulted.
    function test_BilateralAcceptance_RejectsConfigsThatAreNotTheCommittedTerms() public {
        VNextSettlementEscrow.UnitConfig[] memory committed = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, committed);
        VNextSettlementEscrow.UnitConfig[] memory swapped = _oneUnitConfig(1000e6, 0, 0, 1);
        swapped[0].payouts[0].recipient = address(0xC0FFEE); // pay someone else the same amount
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, swapped, false, POLICY_EXPIRY, false);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.PolicyRootMismatch.selector);
        e.fund(swapped, acc);
    }

    /// @dev Delegated/agent funding: a non-payer caller CAN fund, but only with an explicit payer
    ///      signature over the same policy. The payer's acceptance is never assumed.
    function test_BilateralAcceptance_DelegatedFundingRequiresAnExplicitPayerSignature() public {
        address relayer = address(0xAE1A);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        bytes32 digest = _digestOf(e, c, false, POLICY_EXPIRY);

        // A wrong-key payer signature is rejected.
        VNextSettlementEscrow.PolicyAcceptance memory bad = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: false,
            payerSignature: _sign(0xB0B, digest),
            operatorSignature: _sign(operatorPk, digest)
        });
        vm.prank(relayer);
        vm.expectRevert(VNextSettlementEscrow.BadSignature.selector);
        e.fund(c, bad);

        // The genuine payer signature lets the relayer fund; the funds still come from the payer.
        VNextSettlementEscrow.PolicyAcceptance memory good = _acceptance(e, c, false, POLICY_EXPIRY, true);
        uint256 payerBefore = usdc.balanceOf(payer);
        vm.prank(relayer);
        e.fund(c, good);
        assertEq(usdc.balanceOf(address(e)), 1000e6);
        assertEq(usdc.balanceOf(payer), payerBefore - 1000e6, "the payer's funds, not the relayer's");
    }

    /// @dev The operator may be a SMART ACCOUNT: the money-plane identity is ERC-1271-capable.
    function test_BilateralAcceptance_ERC1271SmartAccountOperator() public {
        MockSmartAccountOperator sa = new MockSmartAccountOperator(vm.addr(operatorPk));
        operator = address(sa); // the fixture's operator identity is now a contract
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        assertEq(e.operator(), address(sa));

        // Declining account -> no funded state.
        sa.setAccepts(false);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadOperatorSignature.selector);
        e.fund(c, acc);

        // Accepting account -> funded.
        sa.setAccepts(true);
        vm.prank(payer);
        e.fund(c, acc);
        assertEq(uint256(e.unitState(_unitId(e))), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev No cross-factory reuse: an acceptance signed for one factory/implementation cannot fund the
    ///      identical policy deployed by another factory, because both are inside the signed hash.
    function test_BilateralAcceptance_NoCrossFactoryReuse() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow eA = _escrowFor(JOB, c);
        bytes32 digestA = _digestOf(eA, c, false, POLICY_EXPIRY);

        VNextSettlementEscrowFactory fB =
            new VNextSettlementEscrowFactory(address(usdc), address(attester), O5_SCHEMA, bytes32(0));
        VNextSettlementEscrow eB = VNextSettlementEscrow(fB.createEscrow(_identity(JOB, arbiter, 1, c)));
        assertTrue(address(eA) != address(eB), "different factories -> different clone addresses");

        VNextSettlementEscrow.PolicyAcceptance memory replay = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            allowSelfAdjudication: false,
            payerSignature: bytes(""),
            operatorSignature: _sign(operatorPk, digestA)
        });
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadOperatorSignature.selector);
        eB.fund(c, replay);
    }

    // ══ H-01 §8.2 H-1: cancellation + policy-nonce semantics ══════════════════════════════════════

    /// @dev Funding a generation retires it AND every older one for that (payer, operator, job).
    function test_PolicyNonce_FundingANewerGenerationInvalidatesOlderOnes() public {
        bytes32 job = keccak256("h01-nonce-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow old = VNextSettlementEscrow(factory.createEscrow(_identity(job, arbiter, 1, c)));
        VNextSettlementEscrow fresh = VNextSettlementEscrow(factory.createEscrow(_identity(job, arbiter, 7, c)));
        VNextSettlementEscrow.PolicyAcceptance memory accOld = _acceptance(old, c);

        _fund(fresh, c); // fund generation 7
        assertEq(factory.policyNonceFloor(factory.policyKey(payer, operator, job)), 8);

        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrowFactory.PolicyNoLongerValid.selector);
        old.fund(c, accOld); // generation 1 is dead even though its clone exists and its signatures are valid
    }

    function test_PolicyNonce_RevokeBeforeFunding_ByEitherParty() public {
        bytes32 job = keccak256("h01-revoke-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = VNextSettlementEscrow(factory.createEscrow(_identity(job, arbiter, 3, c)));
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);

        // The OPERATOR walks away from a policy it signed but which was never funded.
        vm.prank(operator);
        factory.revokePolicy(payer, operator, job, 3);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrowFactory.PolicyNoLongerValid.selector);
        e.fund(c, acc);

        // Symmetrically, the PAYER can revoke a later generation.
        VNextSettlementEscrow e2 = VNextSettlementEscrow(factory.createEscrow(_identity(job, arbiter, 4, c)));
        VNextSettlementEscrow.PolicyAcceptance memory acc2 = _acceptance(e2, c);
        vm.prank(payer);
        factory.revokePolicy(payer, operator, job, 4);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrowFactory.PolicyNoLongerValid.selector);
        e2.fund(c, acc2);
    }

    function test_PolicyNonce_RevokeIsMonotoneAndPartyGated() public {
        bytes32 job = keccak256("h01-revoke-guard-job");
        vm.prank(payer);
        factory.revokePolicy(payer, operator, job, 5);
        assertEq(factory.policyNonceFloor(factory.policyKey(payer, operator, job)), 6);

        // A revocation can never be walked back or restated.
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrowFactory.FloorNotIncreasing.selector);
        factory.revokePolicy(payer, operator, job, 4);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrowFactory.FloorNotIncreasing.selector);
        factory.revokePolicy(payer, operator, job, 5);

        // And only a party to the policy may cancel it.
        vm.prank(address(0xBADBAD));
        vm.expectRevert(VNextSettlementEscrowFactory.NotAParty.selector);
        factory.revokePolicy(payer, operator, job, 9);
    }

    /// @dev The nonce registry cannot be used to grief: only the clone CREATE2 places at that policy's
    ///      predicted address may consume it, so no stranger can raise another job's floor.
    function test_PolicyNonce_OnlyThePolicyEscrowMayConsume() public {
        bytes32 job = keccak256("h01-consume-guard-job");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        PolicyIdentity memory id = _identity(job, arbiter, 1, c);
        vm.prank(address(0xBADBAD));
        vm.expectRevert(VNextSettlementEscrowFactory.NotThePolicyEscrow.selector);
        factory.consumePolicyNonce(id);
        assertEq(factory.policyNonceFloor(factory.policyKey(payer, operator, job)), 0, "floor untouched");
    }

    // ══ H-01 §13.1/H-2: reclaim + dispute-window bounds, and the checked downcasts ═════════════════

    function test_ReclaimBounds_BoundaryValuesAreAccepted() public {
        VNextSettlementEscrow.UnitConfig[] memory lo = _oneUnitConfig(1000e6, 0, 0, 1);
        lo[0].reclaimAt = block.timestamp + VNextSettlementLib.MIN_RECLAIM_DELAY; // exactly the floor
        VNextSettlementEscrow eLo = _fundedEscrow(keccak256("bound-lo"), lo);
        assertEq(eLo.reclaimAtOf(_unitIdOf(eLo, lo[0])), lo[0].reclaimAt);

        VNextSettlementEscrow.UnitConfig[] memory hi = _oneUnitConfig(1000e6, 0, 0, 1);
        hi[0].reclaimAt = block.timestamp + VNextSettlementLib.MAX_RECLAIM_DELAY; // exactly the ceiling
        VNextSettlementEscrow eHi = _fundedEscrow(keccak256("bound-hi"), hi);
        assertEq(eHi.reclaimAtOf(_unitIdOf(eHi, hi[0])), hi[0].reclaimAt);
    }

    function test_ReclaimBounds_RejectsJustBelowTheFloor() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].reclaimAt = block.timestamp + VNextSettlementLib.MIN_RECLAIM_DELAY - 1;
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadReclaim.selector);
        e.fund(c, acc);
    }

    /// @dev The gap the pre-H-01 code left open: only the LOWER edge was enforced, so an unbounded
    ///      far-future deadline was legal and could pin the operator's settlement horizon indefinitely.
    function test_ReclaimBounds_RejectsJustAboveTheCeiling() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].reclaimAt = block.timestamp + VNextSettlementLib.MAX_RECLAIM_DELAY + 1;
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadReclaim.selector);
        e.fund(c, acc);

        // ...including the value that used to be the only rejected case's opposite extreme.
        VNextSettlementEscrow.UnitConfig[] memory far = _oneUnitConfig(1000e6, 0, 0, 1);
        far[0].reclaimAt = type(uint256).max;
        VNextSettlementEscrow eFar = _escrowFor(keccak256("bound-far"), far);
        VNextSettlementEscrow.PolicyAcceptance memory accFar = _acceptance(eFar, far);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadReclaim.selector);
        eFar.fund(far, accFar);
    }

    function test_DisputeWindowBounds_MinimumIsAcceptedAndBelowItIsNot() public {
        VNextSettlementEscrow.UnitConfig[] memory ok = _oneUnitConfig(1000e6, 0, 0, 1);
        ok[0].disputeWindow = VNextSettlementLib.MIN_DISPUTE_WINDOW;
        VNextSettlementEscrow eOk = _fundedEscrow(keccak256("win-ok"), ok);
        assertEq(eOk.disputeWindowOf(_unitIdOf(eOk, ok[0])), VNextSettlementLib.MIN_DISPUTE_WINDOW);

        VNextSettlementEscrow.UnitConfig[] memory bad = _oneUnitConfig(1000e6, 0, 0, 1);
        bad[0].disputeWindow = VNextSettlementLib.MIN_DISPUTE_WINDOW - 1;
        VNextSettlementEscrow eBad = _escrowFor(keccak256("win-bad"), bad);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(eBad, bad);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadDisputeWindow.selector);
        eBad.fund(bad, acc);
    }

    /// @dev H-2 checked downcasts, exercised DIRECTLY: `toUint64`/`toUint128` revert rather than
    ///      truncating. `uint64(x)`/`uint128(x)` would silently produce a wrong value here.
    function test_CheckedDowncasts_RevertInsteadOfTruncating() public {
        DowncastHarness h = new DowncastHarness();
        assertEq(h.toUint64(type(uint64).max), type(uint64).max);
        vm.expectRevert(ValueOverflow.selector);
        h.toUint64(uint256(type(uint64).max) + 1); // `uint64(x)` would silently return 0 here

        assertEq(h.toUint128(type(uint128).max), type(uint128).max);
        vm.expectRevert(ValueOverflow.selector);
        h.toUint128(uint256(type(uint128).max) + 1);
    }

    /// @dev ...and reachable through the funding path: a gross above uint128 is refused at the boundary
    ///      rather than silently narrowed once the Wave-3 liability buckets are packed.
    function test_Fund_RejectsGrossAboveUint128() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].g = uint256(type(uint128).max) + 1;
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(ValueOverflow.selector);
        e.fund(c, acc);
    }

    // ══ H-01: the operator identity must exist and be independent ═════════════════════════════════

    function test_Initialize_RejectsAZeroOperator() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        PolicyIdentity memory id = _identity(JOB, arbiter, 1, c);
        id.operator = address(0); // "nobody has to accept" — the H-01 hole, now unrepresentable
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        factory.createEscrow(id);
    }

    function test_Initialize_RejectsOperatorEqualToPayer() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        PolicyIdentity memory id = _identity(JOB, arbiter, 1, c);
        id.operator = payer; // bilateral acceptance by one party is not bilateral
        vm.expectRevert(VNextSettlementEscrow.PartyCollision.selector);
        factory.createEscrow(id);
    }

    function test_Initialize_RejectsAZeroArbiter() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        PolicyIdentity memory id = _identity(JOB, address(0), 1, c);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        factory.createEscrow(id);
    }

    /// @dev Symmetric with the payer case: an operator-appointed-as-arbiter is also self-adjudication.
    function test_Fund_RejectsOperatorAsArbiterWithoutConsent() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        VNextSettlementEscrow e = VNextSettlementEscrow(factory.createEscrow(_identity(JOB, operator, 1, c)));
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.SelfAdjudicationNotAccepted.selector);
        e.fund(c, acc);
    }

    function _unitIdOf(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig memory c)
        internal
        view
        returns (bytes32)
    {
        return VNextSettlementLib.computeSettlementUnitId(
            block.chainid, address(e), e.jobIdHash(), c.milestoneIndex, c.stepId
        );
    }

    /// @dev MIGRATED from `test_EvidenceRelease_RevertsWhenUidMismatch`. On the EAS rail the CALLER chose
    ///      which uid to present, so the escrow had to bind the returned attestation back to the requested
    ///      uid. On the assertion rail the record is KEYED by `settlementUnitId` — the caller chooses
    ///      nothing — so a "mismatched identifier" is unreachable. What the check was really protecting is
    ///      preserved and asserted here: an un-asserted unit reads the ALL-ZERO record, and a zero
    ///      `assertionId` must fail closed rather than be treated as an authorization (L-02's intent).
    function test_EvidenceRelease_RevertsWhenNoAssertionExists() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        assertEq(attester.assertionOf(id).assertionId, bytes32(0), "no assertion bound to this unit");
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev The zero-record guard is a check on the ID, not merely on emptiness: a record whose payload
    ///      fields are all correct but whose `assertionId` is zero must still be rejected.
    function test_EvidenceRelease_RejectsZeroAssertionId() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Assertion memory a = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e));
        a.assertionId = bytes32(0);
        attester.setAssertion(id, a);
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        e.releaseFromEvidence(id);
    }

    // ══ §B — on-chain evidence binding ═════════════════════════════════════════════════════════════

    // ── funding-time binding of the committer ─────────────────────────────────────────────────────
    function test_Fund_FreezesEvidenceCommitter_AndStartsUncommitted() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        assertEq(e.evidenceCommitterOf(id), operator, "committer frozen at funding");
        assertFalse(e.evidenceCommittedOf(id), "nothing committed yet");
        vm.expectRevert(VNextSettlementEscrow.EvidenceNotCommitted.selector);
        e.evidenceBundleHashOf(id); // the default value is never readable as a commitment
    }

    function test_Fund_RejectsZeroEvidenceCommitter() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].evidenceCommitter = address(0);
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        e.fund(c, acc);
    }

    function test_Fund_RejectsExcludedEvidenceCommitter() public {
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].evidenceCommitter = address(usdc); // the token can never be a caller
        VNextSettlementEscrow e = _escrowFor(JOB, c);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        e.fund(c, acc);
    }

    // ── submitEvidence: authority, window, one-shot ───────────────────────────────────────────────
    function test_SubmitEvidence_StoresDomainSeparatedCommitment() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        bytes32 expected = _commitment(e, id, PKG);
        vm.expectEmit(true, false, false, true, address(e));
        emit VNextSettlementEscrow.EvidenceCommitted(id, PKG, expected);
        _commit(e, id, PKG);
        assertTrue(e.evidenceCommittedOf(id));
        assertEq(e.evidenceBundleHashOf(id), expected, "stored value is the domain-separated commitment");
        assertTrue(expected != PKG, "the raw package digest is never what is stored");
    }

    function test_SubmitEvidence_OnlyCommitter() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.expectRevert(VNextSettlementEscrow.OnlyEvidenceCommitter.selector);
        e.submitEvidence(id, PKG); // the test contract is not the committer
        vm.prank(payer); // not even the payer, unless it designated itself
        vm.expectRevert(VNextSettlementEscrow.OnlyEvidenceCommitter.selector);
        e.submitEvidence(id, PKG);
    }

    function test_SubmitEvidence_RejectsSecondCommit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.EvidenceAlreadyCommitted.selector);
        e.submitEvidence(id, keccak256("a-second-package")); // no re-pointing to shop for a payable verdict
        assertEq(e.evidenceBundleHashOf(id), _commitment(e, id, PKG), "first commit stands");
    }

    function test_SubmitEvidence_RejectsZeroDigest() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.ZeroEvidenceDigest.selector);
        e.submitEvidence(id, bytes32(0));
    }

    function test_SubmitEvidence_RejectsAfterReclaimAt() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.warp(block.timestamp + 30 days); // == reclaimAt
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.TooLateForEvidence.selector);
        e.submitEvidence(id, PKG);
    }

    function test_SubmitEvidence_RejectsDuringLiveDispute() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.LiveDispute.selector);
        e.submitEvidence(id, PKG);
    }

    function test_SubmitEvidence_RejectsWhenNotActive() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        _assert(e, id, 1, 1);
        e.releaseFromEvidence(id); // unit is now SETTLED_RELEASED
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.submitEvidence(id, keccak256("late-package"));
    }

    function test_SubmitEvidence_RejectsUnknownUnit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.UnitNotFound.selector);
        e.submitEvidence(keccak256("not-a-unit"), PKG);
    }

    // ── release binding ───────────────────────────────────────────────────────────────────────────
    function test_EvidenceRelease_RevertsWithNoCommit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _assert(e, id, 1, 1); // an otherwise-perfect verdict, but nothing was committed
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev The zero/default hash must never satisfy release — this is why `evidenceCommitted` is separate.
    function test_EvidenceRelease_ZeroBundleHashCannotSatisfyAnUncommittedUnit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.evidenceBundleHash = bytes32(0); // matches the unit's untouched storage slot
        attester.setAssertion(id, _assertionFor(v, address(e)));
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id);
    }

    function test_EvidenceRelease_RevertsOnDigestMismatch() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.evidenceBundleHash = _commitment(e, id, keccak256("a-different-package")); // verdict over another package
        attester.setAssertion(id, _assertionFor(v, address(e)));
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev Domain separation: the SAME package digest committed on a different unit yields a different
    ///      commitment, so a verdict minted for unit A can never satisfy unit B.
    function test_EvidenceCommitment_DoesNotReplayAcrossUnits() public {
        VNextSettlementEscrow e1 = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        VNextSettlementEscrow e2 = _fundedEscrow(keccak256("job-other"), _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id1 = _unitId(e1);
        bytes32 id2 = _unitId(e2);
        _commit(e1, id1, PKG);
        _commit(e2, id2, PKG); // identical package digest
        assertTrue(e1.evidenceBundleHashOf(id1) != e2.evidenceBundleHashOf(id2), "escrow/unit domain-separated");

        // and a different composition schema version also moves the commitment
        assertTrue(
            VNextSettlementLib.computeEvidenceCommitment(block.chainid, address(e1), id1, 0, 1, PKG)
                != VNextSettlementLib.computeEvidenceCommitment(block.chainid, address(e1), id1, 1, 1, PKG),
            "schema version is bound"
        );
        assertTrue(
            VNextSettlementLib.computeEvidenceCommitment(block.chainid, address(e1), id1, 0, 1, PKG)
                != VNextSettlementLib.computeEvidenceCommitment(block.chainid, address(e1), id1, 0, 2, PKG),
            "package format is bound"
        );
        assertTrue(
            VNextSettlementLib.computeEvidenceCommitment(block.chainid, address(e1), id1, 0, 1, PKG)
                != VNextSettlementLib.computeEvidenceCommitment(block.chainid + 1, address(e1), id1, 0, 1, PKG),
            "chainId is bound"
        );
    }

    /// @dev ONE VERDICT PER UNIT: after a settle, a second otherwise-valid assertion (fresh assertion id,
    ///      same committed package, same tier) cannot settle the unit again. The mock lets a second record
    ///      be written precisely so this asserts the ESCROW-side guard; the real attester refuses the
    ///      second write outright (`UnitAlreadyAttested`, asserted in Fixed2of3O5Attester.t.sol).
    function test_OneVerdictPerUnit_SecondValidVerdictCannotSettle() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        _assert(e, id, 1, 1);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));

        O5Assertion memory a2 = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e));
        a2.assertionId = keccak256("assertion-2"); // a brand-new, fully valid record over the same package
        attester.setAssertion(id, a2);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.releaseFromEvidence(id);
        assertEq(usdc.balanceOf(feeDest), 23_500000, "paid exactly once");
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    /// @dev The consume-once is the UNIT's state transition, and it holds even in the partially-settled
    ///      RELEASE_ALLOCATED case (payouts stuck as claims): neither a replay of the same assertion nor a
    ///      fresh one can allocate a second release. (The §2 authorization key sits behind this state guard
    ///      as defense-in-depth — an assertion is bound to exactly one unit, so the state guard is what
    ///      actually fires. That layering is unchanged by P0-6; only the key's seed moved from the EAS uid
    ///      to the assertion id.)
    function test_OneVerdictPerUnit_ReleaseAllocatedCannotBeReReleased() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        usdc.setTransferMode(MockToken.Mode.REVERT); // stay in RELEASE_ALLOCATED (claims outstanding)
        _assert(e, id, 1, 1);
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED));
        assertEq(e.liabilityOf(id), 1000e6, "still owed once, not twice");

        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.releaseFromEvidence(id); // same assertion

        O5Assertion memory a2 = _assertionFor(_o5FullVerdict(e, id, 1, 1), address(e));
        a2.assertionId = keccak256("assertion-2");
        attester.setAssertion(id, a2);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.releaseFromEvidence(id); // fresh assertion, same committed package
        assertEq(e.liabilityOf(id), 1000e6, "no second allocation");
    }

    // ── refund/reclaim independence (fail-closed) ─────────────────────────────────────────────────
    /// @dev The refund path must never depend on the committer OR the attester: no commit at all still
    ///      refunds the payer in full at `reclaimAt`.
    function test_Reclaim_WorksWithNoCommit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        assertFalse(e.evidenceCommittedOf(id));
        attester.setEnabled(false); // and the whole cohort is dead
        vm.warp(block.timestamp + 31 days);
        uint256 before = usdc.balanceOf(payer);
        e.reclaimAfterDeadline(id); // permissionless
        assertEq(usdc.balanceOf(payer), before + 1000e6, "full G back to the payer");
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
    }

    /// @dev A WRONG commit (a package no verdict will ever match) also fails closed to a full refund.
    function test_Reclaim_WorksWithWrongCommit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, keccak256("wrong-package"));
        _assert(e, id, 1, 1); // verdict over the RIGHT package -> unpayable against this commit
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id);
        vm.warp(block.timestamp + 31 days);
        uint256 before = usdc.balanceOf(payer);
        e.reclaimAfterDeadline(id);
        assertEq(usdc.balanceOf(payer), before + 1000e6);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
    }

    /// @dev Dispute-driven refund is likewise independent of any commit.
    function test_DisputeRefund_WorksWithNoCommit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        uint256 before = usdc.balanceOf(payer);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, false);
        assertEq(usdc.balanceOf(payer), before + 1000e6);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
    }

    /// @dev A committed package does not weaken the payer's dispute/refund rights either.
    function test_DisputeRefund_WorksAfterACommit() public {
        VNextSettlementEscrow e = _fundedEscrow(JOB, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        uint256 before = usdc.balanceOf(payer);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, false);
        assertEq(usdc.balanceOf(payer), before + 1000e6);
    }

    // ── end-to-end across the REAL attester + the REAL escrow ─────────────────────────────────────
    // The attester-side unit tests drive a mock escrow, which by construction cannot catch drift between
    // `IEscrowSettlementBinding` and this escrow's actual getters. This exercises the whole money path
    // through both real contracts: fund -> commit -> 2-of-3 quorum assertion -> release. P0-6: no EAS is
    // deployed for these at all — the money path cannot reach one.
    uint256 constant sk1 = 0x51;
    uint256 constant sk2 = 0x52;
    uint256 constant sk3 = 0x53;
    uint64 constant REAL_COHORT = 9;
    /// @dev An address with NO CODE, handed to the attester as its EAS registry. Any `attest` call against
    ///      it reverts (Solidity's extcodesize guard). Used to prove settlement never reaches EAS.
    address constant DEAD_EAS = address(0xEA5DEAD);

    function _ascendingSigs(bytes32 digest) internal pure returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        (uint256 lo, uint256 hi) = vm.addr(sk1) < vm.addr(sk2) ? (sk1, sk2) : (sk2, sk1);
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(lo, digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(hi, digest);
        sigs[0] = abi.encodePacked(r0, s0, v0);
        sigs[1] = abi.encodePacked(r1, s1, v1);
    }

    function test_EndToEnd_RealAttesterAssertion_ThenRealEscrowRelease() public {
        // The EAS address is DEAD (no code) for the whole test: settlement must not care.
        Fixed2of3O5Attester real = new Fixed2of3O5Attester(
            vm.addr(sk1), vm.addr(sk2), vm.addr(sk3), DEAD_EAS, O5_SCHEMA, REAL_COHORT, address(0xDEC0DE)
        );
        VNextSettlementEscrowFactory f =
            new VNextSettlementEscrowFactory(address(usdc), address(real), O5_SCHEMA, real.o5TypeHash());
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        bytes32 root = keccak256("e2e-composition-root");
        c[0].compositionSchemaVersion = 1;
        c[0].compositionRoot = root;
        VNextSettlementEscrow e = VNextSettlementEscrow(f.createEscrow(_identity(JOB, arbiter, 1, c)));
        _fund(e, c);
        bytes32 id = _unitId(e);
        assertEq(e.oracleAuthEpoch(), REAL_COHORT, "escrow pinned the real cohort at funding");
        _commit(e, id, PKG);

        // Every verdict field the attester pre-checks is read straight off the escrow — exactly what the
        // off-chain oracle does. If a getter's name, argument, or return width drifted, this would fail.
        O5Verdict memory v = O5Verdict({
            jobIdHash: JOB,
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            evidenceBundleHash: e.evidenceBundleHashOf(id),
            achievedTier: e.requiredTierOf(id),
            requestedTier: e.requiredTierOf(id),
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("e2e-verdict"),
            feeBps: e.feeBpsOf(id),
            feeRecipient: e.feeRecipientOf(id),
            feeScheduleHash: e.feeScheduleHashOf(id),
            settlementUnitId: id,
            oracleAuthEpoch: REAL_COHORT,
            compositionRoot: e.compositionRootOf(id)
        });
        bytes32 assertionId = real.attestO5(v, address(e), _ascendingSigs(real.digestOf(v)));
        assertTrue(real.usedUnit(id), "the unit's one verdict slot is now consumed");
        assertEq(assertionId, real.digestOf(v), "the assertion id IS the full signed-verdict digest");
        assertEq(real.assertionOf(id).escrow, address(e), "assertion bound to this escrow");
        assertEq(real.mirroredUid(id), bytes32(0), "settlement did not touch EAS");

        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
        assertEq(usdc.balanceOf(recip1) + usdc.balanceOf(recip2), 1000e6 - 23_500000);
        assertEq(usdc.balanceOf(address(e)), 0);
        assertEq(e.totalLiability(), 0);
    }

    /// @dev The same end-to-end path, but the oracle mirrors a STALE fee schedule: the assertion must fail
    ///      without consuming the slot, and the corrected verdict must then assert AND release.
    function test_EndToEnd_StaleFeeMirror_DoesNotBrickTheUnit() public {
        Fixed2of3O5Attester real = new Fixed2of3O5Attester(
            vm.addr(sk1), vm.addr(sk2), vm.addr(sk3), DEAD_EAS, O5_SCHEMA, REAL_COHORT, address(0xDEC0DE)
        );
        VNextSettlementEscrowFactory f =
            new VNextSettlementEscrowFactory(address(usdc), address(real), O5_SCHEMA, real.o5TypeHash());
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        VNextSettlementEscrow e = VNextSettlementEscrow(f.createEscrow(_identity(JOB, arbiter, 1, c)));
        _fund(e, c);
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);

        O5Verdict memory v = O5Verdict({
            jobIdHash: JOB,
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            evidenceBundleHash: e.evidenceBundleHashOf(id),
            achievedTier: 1,
            requestedTier: 1,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("e2e-verdict"),
            feeBps: e.feeBpsOf(id),
            feeRecipient: e.feeRecipientOf(id),
            feeScheduleHash: keccak256("stale-fee-schedule-hash"),
            settlementUnitId: id,
            oracleAuthEpoch: REAL_COHORT,
            compositionRoot: bytes32(0)
        });
        bytes[] memory staleSigs = _ascendingSigs(real.digestOf(v));
        vm.expectRevert(O5AttesterBase.FeeHashMismatch.selector); // the attester's pre-check, not the escrow's
        real.attestO5(v, address(e), staleSigs);
        assertFalse(real.usedUnit(id), "the unit must still be assertable");

        v.feeScheduleHash = e.feeScheduleHashOf(id); // oracle refreshes its mirror
        real.attestO5(v, address(e), _ascendingSigs(real.digestOf(v)));
        e.releaseFromEvidence(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED), "settles after correction");
    }

    // ── golden vector for the oracle's off-chain mirror ───────────────────────────────────────────
    function test_emit_evidenceCommitmentGolden() public pure {
        // canonical fixed inputs (same shape as the gate-1 goldens): chainId 8453, escrow 0x…E5C0F
        uint256 cid = 8453;
        address ESC = address(0xE5C0F);
        bytes32 unitId = VNextSettlementLib.computeSettlementUnitId(cid, ESC, keccak256("golden-job"), 3, keccak256("golden-step"));
        bytes32 pkg = keccak256("golden-evidence-package");
        bytes32 commitment = VNextSettlementLib.computeEvidenceCommitment(
            cid, ESC, unitId, 1, VNextSettlementLib.EVIDENCE_PACKAGE_FORMAT_V1, pkg
        );
        console2.log("== evidence-commitment golden (mirror these off-chain) ==");
        console2.log("chainId", cid);
        console2.log("escrow", ESC);
        console2.log("compositionSchemaVersion", uint256(1));
        console2.log("packageFormat", uint256(VNextSettlementLib.EVIDENCE_PACKAGE_FORMAT_V1));
        console2.logBytes32(VNextSettlementLib.EVIDENCE_COMMITMENT_DOMAIN);
        console2.logBytes32(unitId);
        console2.logBytes32(pkg);
        console2.logBytes32(commitment);
        // pinned literal, computed with `cast abi-encode` + `cast keccak` (NOT by this library)
        assertEq(commitment, GOLDEN_EVIDENCE_COMMITMENT, "evidence-commitment golden");
    }

    /// @dev computed OUTSIDE this contract with `cast abi-encode` + `cast keccak` over the §B 7-word form
    ///      {domain, 8453, 0x…E5C0F, unitId, schemaVersion 1, format 1, keccak("golden-evidence-package")}.
    bytes32 constant GOLDEN_EVIDENCE_COMMITMENT = 0xba4753b572b0d79518e05c88932d213125d0634a2c2fbbd7e74d7d52578eb7aa;

    // ══ P0-6 — EAS is off the money path; the mirror is async, isolated and replayable ══════════════
    // These drive the REAL attester + the REAL escrow. `EAS_SLOT` is a fixed address whose CODE is
    // swapped mid-test (`vm.etch`) to model an outage and a later recovery — the attester's `eas` is an
    // immutable, so the address must stay put while its behaviour changes, exactly like a real registry.
    address constant EAS_SLOT = address(0xEA50107);

    struct P06Fixture {
        Fixed2of3O5Attester attester;
        VNextSettlementEscrow escrow;
        bytes32 unitId;
        O5Verdict verdict;
    }

    /// @dev A real, field-by-field COPY of a memory verdict. Plain assignment between memory structs binds
    ///      a reference, so a test that "tampers with a copy" would mutate the original too.
    function _copyVerdict(O5Verdict memory v) internal pure returns (O5Verdict memory) {
        return O5Verdict({
            jobIdHash: v.jobIdHash,
            milestoneIndex: v.milestoneIndex,
            stepId: v.stepId,
            evidenceBundleHash: v.evidenceBundleHash,
            achievedTier: v.achievedTier,
            requestedTier: v.requestedTier,
            decision: v.decision,
            verdictHash: v.verdictHash,
            feeBps: v.feeBps,
            feeRecipient: v.feeRecipient,
            feeScheduleHash: v.feeScheduleHash,
            settlementUnitId: v.settlementUnitId,
            oracleAuthEpoch: v.oracleAuthEpoch,
            compositionRoot: v.compositionRoot
        });
    }

    /// @dev fund + commit + build the canonical verdict, against an attester whose EAS is `easAddr`.
    function _p06Setup(address easAddr, bytes32 job) internal returns (P06Fixture memory fx) {
        fx.attester = new Fixed2of3O5Attester(
            vm.addr(sk1), vm.addr(sk2), vm.addr(sk3), easAddr, O5_SCHEMA, REAL_COHORT, address(0xDEC0DE)
        );
        VNextSettlementEscrowFactory f = new VNextSettlementEscrowFactory(
            address(usdc), address(fx.attester), O5_SCHEMA, fx.attester.o5TypeHash()
        );
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        fx.escrow = VNextSettlementEscrow(f.createEscrow(_identity(job, arbiter, 1, c)));
        _fund(fx.escrow, c);
        fx.unitId = VNextSettlementLib.computeSettlementUnitId(
            block.chainid, address(fx.escrow), job, 0, keccak256("step-0")
        );
        vm.prank(operator);
        fx.escrow.submitEvidence(fx.unitId, PKG);
        fx.verdict = O5Verdict({
            jobIdHash: job,
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            evidenceBundleHash: fx.escrow.evidenceBundleHashOf(fx.unitId),
            achievedTier: 1,
            requestedTier: 1,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256("p06-verdict"),
            feeBps: fx.escrow.feeBpsOf(fx.unitId),
            feeRecipient: fx.escrow.feeRecipientOf(fx.unitId),
            feeScheduleHash: fx.escrow.feeScheduleHashOf(fx.unitId),
            settlementUnitId: fx.unitId,
            oracleAuthEpoch: REAL_COHORT,
            compositionRoot: bytes32(0)
        });
    }

    /// @dev THE Wave-1 property: EAS UNAVAILABLE ⇒ SETTLEMENT STILL COMPLETES. The registry address holds
    ///      no code for the entire test, so any attempt to reach it would revert. Money moves anyway,
    ///      because no money path reaches it at all.
    function test_P06_EasUnavailable_SettlementStillCompletes() public {
        P06Fixture memory fx = _p06Setup(DEAD_EAS, JOB);
        assertEq(DEAD_EAS.code.length, 0, "the EAS registry has no code");

        fx.attester.attestO5(fx.verdict, address(fx.escrow), _ascendingSigs(fx.attester.digestOf(fx.verdict)));
        fx.escrow.releaseFromEvidence(fx.unitId);

        assertEq(uint256(fx.escrow.unitState(fx.unitId)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
        assertEq(usdc.balanceOf(recip1) + usdc.balanceOf(recip2), 1000e6 - 23_500000);
        assertEq(usdc.balanceOf(address(fx.escrow)), 0);
        assertEq(fx.escrow.totalLiability(), 0);
        // And the provenance obligation is not lost — it is simply still queued.
        assertEq(fx.attester.mirroredUid(fx.unitId), bytes32(0), "still on the drainable mirror queue");
    }

    /// @dev A LIVE-BUT-FAILING EAS is the harder outage shape (the call is made and reverts, rather than
    ///      never being made). Settlement must still complete, and the mirror must be the only casualty.
    function test_P06_MirrorFailureIsIsolatedFromSettlement() public {
        vm.etch(EAS_SLOT, address(new RevertingEAS()).code);
        P06Fixture memory fx = _p06Setup(EAS_SLOT, JOB);

        fx.attester.attestO5(fx.verdict, address(fx.escrow), _ascendingSigs(fx.attester.digestOf(fx.verdict)));
        // The mirror is the ONLY thing that fails.
        vm.expectRevert(RevertingEAS.EasIsDown.selector);
        fx.attester.mirrorToEAS(fx.verdict);

        fx.escrow.releaseFromEvidence(fx.unitId);
        assertEq(uint256(fx.escrow.unitState(fx.unitId)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
        assertEq(fx.attester.mirroredUid(fx.unitId), bytes32(0), "nothing was falsely marked mirrored");
    }

    /// @dev REPLAY AFTER A LONG OUTAGE: the assertion is written and settled while EAS is down; much later
    ///      EAS recovers at the same address and ANY caller drains the queue from the on-chain record. The
    ///      minted payload is byte-identical to the signed verdict, so provenance is complete, only late.
    function test_P06_MirrorReplaysAfterEasOutage() public {
        vm.etch(EAS_SLOT, address(new RevertingEAS()).code);
        P06Fixture memory fx = _p06Setup(EAS_SLOT, JOB);
        bytes32 assertionId =
            fx.attester.attestO5(fx.verdict, address(fx.escrow), _ascendingSigs(fx.attester.digestOf(fx.verdict)));
        fx.escrow.releaseFromEvidence(fx.unitId); // settles during the outage
        vm.expectRevert(RevertingEAS.EasIsDown.selector);
        fx.attester.mirrorToEAS(fx.verdict);

        vm.warp(block.timestamp + 45 days); // a long outage; the unit is long since settled
        vm.etch(EAS_SLOT, address(new MockReadWriteEAS()).code); // EAS recovers at the same address

        vm.prank(address(0xDEADBEEF)); // PERMISSIONLESS: a random third party drains the queue
        bytes32 uid = fx.attester.mirrorToEAS(fx.verdict);

        assertTrue(uid != bytes32(0), "mirrored");
        assertEq(fx.attester.mirroredUid(fx.unitId), uid, "queue entry cleared");
        EASAttestation memory a = MockReadWriteEAS(EAS_SLOT).getAttestation(uid);
        assertEq(a.schema, O5_SCHEMA, "mirrored under the pinned O5 schema");
        assertEq(a.recipient, address(fx.escrow), "recipient is the settling escrow");
        assertEq(a.attester, address(fx.attester), "the cohort is the recorded attester");
        assertEq(keccak256(a.data), keccak256(abi.encode(fx.verdict)), "payload is the signed verdict, byte-exact");
        assertEq(a.data.length, O5_VERDICT_BYTES, "448-byte O5 payload");
        assertEq(fx.attester.digestOf(fx.verdict), assertionId, "and it hashes back to the asserted digest");
    }

    /// @dev The mirror accepts ONLY the exact signed verdict, and only once. A permissionless entry point
    ///      that took a caller-chosen payload would let anyone write false provenance for a real
    ///      settlement; the digest equality is what makes "permissionless" safe.
    function test_P06_MirrorRejectsTamperedVerdictAndDoubleMirror() public {
        vm.etch(EAS_SLOT, address(new MockReadWriteEAS()).code);
        P06Fixture memory fx = _p06Setup(EAS_SLOT, JOB);
        fx.attester.attestO5(fx.verdict, address(fx.escrow), _ascendingSigs(fx.attester.digestOf(fx.verdict)));

        // `_copyVerdict` is load-bearing: `O5Verdict memory x = fx.verdict` would ALIAS (memory structs
        // are references), silently tampering with the signed verdict as well.
        O5Verdict memory tampered = _copyVerdict(fx.verdict);
        tampered.verdictHash = keccak256("a-different-verdict-document"); // a field the escrow never reads
        vm.expectRevert(O5AttesterBase.VerdictDigestMismatch.selector);
        fx.attester.mirrorToEAS(tampered);

        fx.attester.mirrorToEAS(fx.verdict); // the untouched signed verdict still mirrors
        vm.expectRevert(O5AttesterBase.AlreadyMirrored.selector);
        fx.attester.mirrorToEAS(fx.verdict);
    }

    /// @dev Nothing can be mirrored that was never asserted — the mirror is a projection of the on-chain
    ///      record, never an independent authority.
    function test_P06_MirrorRejectsUnassertedUnit() public {
        vm.etch(EAS_SLOT, address(new MockReadWriteEAS()).code);
        P06Fixture memory fx = _p06Setup(EAS_SLOT, JOB);
        vm.expectRevert(O5AttesterBase.AssertionNotFound.selector);
        fx.attester.mirrorToEAS(fx.verdict);
    }

    /// @dev The mirror carries the settlement receipt: `escrowUnitState` is read from the escrow itself, so
    ///      an indexer joining EAS provenance to on-chain settlement needs no off-chain lookup.
    function test_P06_MirrorEmitsSettlementReceiptLink() public {
        vm.etch(EAS_SLOT, address(new MockReadWriteEAS()).code);
        P06Fixture memory fx = _p06Setup(EAS_SLOT, JOB);
        bytes32 assertionId =
            fx.attester.attestO5(fx.verdict, address(fx.escrow), _ascendingSigs(fx.attester.digestOf(fx.verdict)));
        fx.escrow.releaseFromEvidence(fx.unitId);

        vm.recordLogs();
        bytes32 uid = fx.attester.mirrorToEAS(fx.verdict);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != O5_MIRRORED_TOPIC) continue;
            found = true;
            assertEq(logs[i].topics[1], fx.unitId, "settlementUnitId");
            assertEq(logs[i].topics[2], assertionId, "assertionId");
            assertEq(logs[i].topics[3], uid, "easUid");
            (uint64 cohort, address esc, bytes32 vh, uint256 state) =
                abi.decode(logs[i].data, (uint64, address, bytes32, uint256));
            assertEq(uint256(cohort), uint256(REAL_COHORT), "cohort");
            assertEq(esc, address(fx.escrow), "escrow");
            assertEq(vh, fx.verdict.verdictHash, "verdictHash");
            assertEq(state, uint256(UnitState.SETTLED_RELEASED), "settlement receipt: the escrow's own state");
        }
        assertTrue(found, "O5Mirrored emitted");
    }

    bytes32 constant O5_MIRRORED_TOPIC =
        keccak256("O5Mirrored(bytes32,bytes32,bytes32,uint64,address,bytes32,uint256)");

    /// @dev The mirror survives the cohort kill-switch: `disable()` neutralizes MONEY (the escrow rejects
    ///      release), but a settlement that already happened must still be able to acquire its provenance.
    function test_P06_MirrorStillWorksAfterCohortDisabled() public {
        vm.etch(EAS_SLOT, address(new MockReadWriteEAS()).code);
        P06Fixture memory fx = _p06Setup(EAS_SLOT, JOB);
        fx.attester.attestO5(fx.verdict, address(fx.escrow), _ascendingSigs(fx.attester.digestOf(fx.verdict)));
        fx.escrow.releaseFromEvidence(fx.unitId);

        vm.prank(address(0xDEC0DE));
        fx.attester.disable();
        assertFalse(fx.attester.enabled());
        assertTrue(fx.attester.mirrorToEAS(fx.verdict) != bytes32(0), "provenance still drainable");
    }

    /// @dev The reverse isolation: the mirror is NOT an authorization. Mirroring never releases anything,
    ///      and a unit that fails an escrow-side check stays FUNDED_ACTIVE regardless of its EAS record.
    function test_P06_MirroringIsNotAnAuthorization() public {
        vm.etch(EAS_SLOT, address(new MockReadWriteEAS()).code);
        P06Fixture memory fx = _p06Setup(EAS_SLOT, JOB);
        fx.attester.attestO5(fx.verdict, address(fx.escrow), _ascendingSigs(fx.attester.digestOf(fx.verdict)));
        fx.attester.mirrorToEAS(fx.verdict);
        assertEq(uint256(fx.escrow.unitState(fx.unitId)), uint256(UnitState.FUNDED_ACTIVE), "mirror moved no money");

        // Now disable the cohort: the EAS record exists and is perfect, and release is still refused.
        vm.prank(address(0xDEC0DE));
        fx.attester.disable();
        vm.expectRevert(VNextSettlementEscrow.OracleCohortDisabled.selector);
        fx.escrow.releaseFromEvidence(fx.unitId);
    }
}

/// @dev EAS double that is LIVE but FAILING — models the outage shape where the call is actually made.
contract RevertingEAS {
    error EasIsDown();

    function attest(AttestationRequest calldata) external payable returns (bytes32) {
        revert EasIsDown();
    }
}
