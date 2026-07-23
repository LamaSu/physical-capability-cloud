// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {O5Verdict, O5_VERDICT_BYTES, O5_DECISION_SETTLE} from "../src/O5Types.sol";
import {IOracleAttester} from "../src/interfaces/IOracleAttester.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {PayoutEntry, FeeSchedule, UnitState, ClaimClass, AuthorizationType, VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";
import {EASAttestation} from "../src/interfaces/IEAS.sol";

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

contract MockEAS {
    EASAttestation internal _att;

    function set(EASAttestation calldata a) external {
        _att = a;
    }

    function getAttestation(bytes32) external view returns (EASAttestation memory) {
        return _att;
    }
}

/// @dev Minimal IOracleAttester the escrow reads at fund()/release(): a settable one-way kill-switch + a
///      fixed cohort id. The escrow never calls attestO5 (evidence tests fake the attestation via MockEAS),
///      so attestO5 is a no-op — the real quorum crypto is exercised in Fixed2of3O5Attester.t.sol.
contract MockOracleAttester is IOracleAttester {
    bool public enabled = true;
    uint64 public cohortId;
    /// @dev the cohort's live O5 EIP-712 type hash — the escrow's constructor pins its metadata to this.
    bytes32 public o5TypeHash = keccak256("mock.o5.typehash");

    constructor(uint64 cohortId_) {
        cohortId = cohortId_;
    }

    function setO5TypeHash(bytes32 h) external {
        o5TypeHash = h;
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

contract VNextSettlementEscrowTest is Test {
    MockToken usdc;
    MockEAS eas;
    MockOracleAttester attester;
    VNextSettlementEscrowFactory factory;

    uint64 constant COHORT = 1; // the mock attester's cohort id, pinned into the escrow at fund()
    uint256 payerPk = 0xA11CE;
    address payer;
    address arbiter = address(0xAB12);
    address recip1 = address(0xBEEF01);
    address recip2 = address(0xBEEF02);
    address feeDest = address(0xFEE1);
    address operator = address(0x0FE7A); // the funder-designated evidence committer (§B)
    bytes32 constant PKG = keccak256("evidence-package-v1");
    bytes32 constant O5_SCHEMA = keccak256("test.o5.schema");
    bytes32 constant JOB = keccak256("job-1");
    bytes32 constant TERMS = keccak256("terms-1");

    function setUp() public {
        payer = vm.addr(payerPk);
        usdc = new MockToken();
        eas = new MockEAS();
        attester = new MockOracleAttester(COHORT);
        factory = new VNextSettlementEscrowFactory(address(usdc), address(eas), address(attester), O5_SCHEMA, bytes32(0));
        usdc.mint(payer, 1_000_000e6);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────
    function _newEscrow(bytes32 job) internal returns (VNextSettlementEscrow e) {
        e = VNextSettlementEscrow(factory.createEscrow(payer, arbiter, job, TERMS));
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
        vm.prank(payer);
        e.fund(cfgs);
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        // f = floor(1000e6 * 235 / 10000) = 23_500000
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        usdc.setTransferFromMode(MockToken.Mode.FEE_ON_TRANSFER);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.FundingDeltaMismatch.selector);
        e.fund(_oneUnitConfig(1000e6, 0, 0, 1));
    }

    function test_FundRejectsBadInvariant() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].n = 999e6; // N + F != G
        vm.prank(payer);
        vm.expectRevert(); // V1: N+F!=G (or payout sum mismatch)
        e.fund(c);
    }

    function test_FundRejectsForbiddenRecipient() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].payouts[0].recipient = address(usdc); // USDC is excluded
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        e.fund(c);
    }

    function test_FundOnlyPayerAndSealed() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        vm.expectRevert(VNextSettlementEscrow.OnlyPayer.selector);
        e.fund(c); // not the payer
        _fund(e, c);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.AlreadySealed.selector);
        e.fund(c);
    }

    // ── release via dispute-win + distribution ────────────────────────────────────────────────────
    function test_DisputeOperatorWin_ReleasesExactlyG() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.DEBIT_NO_CREDIT);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        vm.expectRevert(VNextSettlementEscrow.WrongTransferDelta.selector);
        e.resolveDispute(id, true);
    }

    function test_Classifier_FalseWithMove_RevertsAll() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 0)); // Tier-0, no fee
        bytes32 id = _unitId(e);
        VNextSettlementEscrow.BuyerApproval memory a = _buyerApproval(e, id);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSep(address(e)), _buyerStructHash(a)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerPk, digest);
        e.approveByBuyer(id, a, abi.encodePacked(r, s, v)); // relayed by anyone
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(recip1), 500e6);
    }

    function test_BuyerApproval_DirectCall() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 0));
        bytes32 id = _unitId(e);
        VNextSettlementEscrow.BuyerApproval memory a = _buyerApproval(e, id);
        vm.prank(payer);
        e.approveByBuyer(id, a, ""); // direct payer call, no signature
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    function test_BuyerApproval_RejectsWrongTier() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1)); // Tier-1
        bytes32 id = _unitId(e);
        VNextSettlementEscrow.BuyerApproval memory a = _buyerApproval(e, id);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.NotTier0.selector);
        e.approveByBuyer(id, a, "");
    }

    // ── evidence release (mock EAS) ───────────────────────────────────────────────────────────────
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

    function _o5Attestation(VNextSettlementEscrow e, bytes32 id, uint8 decision, uint8 achieved)
        internal
        view
        returns (EASAttestation memory a)
    {
        a = EASAttestation({
            uid: keccak256("uid-1"),
            schema: O5_SCHEMA,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID: bytes32(0),
            recipient: address(e),
            attester: address(attester),
            revocable: true,
            data: abi.encode(_o5FullVerdict(e, id, decision, achieved))
        });
    }

    function test_EvidenceRelease_Settle() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG); // §B: commit the package BEFORE the verdict exists
        eas.set(_o5Attestation(e, id, 1, 1)); // decision=SETTLE(1), achieved>=required
        e.releaseFromEvidence(id, keccak256("uid-1"));
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
    }

    function test_EvidenceRelease_RejectsWrongAttester() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1);
        a.attester = address(0xBAD);
        eas.set(a);
        vm.expectRevert(VNextSettlementEscrow.WrongAttester.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
    }

    function test_EvidenceRelease_RejectsUnderTier() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 2); // requiredTier 2
        _fund(e, c);
        bytes32 id = _unitId(e);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1); // achieved 1 < required 2
        a.data = abi.encode(_o5verdict(id, 1, 2, 1));
        eas.set(a);
        vm.expectRevert(VNextSettlementEscrow.RequestedTierMismatch.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
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
        VNextSettlementEscrow e = _newEscrow(keccak256("job-max"));
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
        // calldata bound (M-01): the max accepted config MUST fit the frozen MAX_CONFIG_BYTES.
        bytes memory cd = abi.encodeCall(VNextSettlementEscrow.fund, (cfgs));
        emit log_named_uint("max-config fund() calldata bytes", cd.length);
        assertLe(cd.length, VNextSettlementLib.MAX_CONFIG_BYTES, "max config must fit MAX_CONFIG_BYTES");
        // gas of the full 256-entry funding tx.
        vm.prank(payer);
        uint256 g0 = gasleft();
        e.fund(cfgs);
        emit log_named_uint("max aggregate funding gas (256 entries)", g0 - gasleft());
        assertEq(e.unitCount(), UNITS);
    }

    // ── gate-2: worst-case single-unit release (16 legs, all safe-fail -> 16 claims) ──────────────
    function test_gas_worstCaseRelease() public {
        VNextSettlementEscrow e = _newEscrow(keccak256("job-wc"));
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
        _fund(e, cfgs);
        bytes32 id = _unitId(e);
        usdc.setTransferMode(MockToken.Mode.NORMAL); // all 16 legs discharge (worst-case realistic release)
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        uint256 g0 = gasleft();
        e.resolveDispute(id, true);
        emit log_named_uint("worst-case 16-leg release gas", g0 - gasleft());
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        assertEq(e.oracleAuthEpoch(), COHORT, "fund pins the attester cohort id");

        // a fresh escrow funded while the cohort is disabled must revert (fail-closed).
        attester.setEnabled(false);
        VNextSettlementEscrow e2 = _newEscrow(keccak256("job-2"));
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.InvalidOrDisabledCohort.selector);
        e2.fund(_oneUnitConfig(1000e6, 0, 0, 1));
    }

    function test_Fund_RevertsWhenRequiredTierNeRequestedTier() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].requestedTier = 2; // != requiredTier (1)
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.TierRequestMismatch.selector);
        e.fund(c);
    }

    function test_EvidenceRelease_RevertsWhenCohortDisabled() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        eas.set(_o5Attestation(e, id, 1, 1)); // an otherwise-valid attestation already exists
        attester.setEnabled(false); // cohort disabled AFTER the mint — must neutralize it at payment time
        vm.expectRevert(VNextSettlementEscrow.OracleCohortDisabled.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
    }

    function test_EvidenceRelease_RevertsOnCohortEpochMismatch() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.oracleAuthEpoch = COHORT + 1; // wrong epoch
        a.data = abi.encode(v);
        eas.set(a);
        vm.expectRevert(VNextSettlementEscrow.OracleCohortMismatch.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
    }

    function test_EvidenceRelease_RevertsOnCompositionRootMismatch() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1)); // unit.compositionRoot == 0
        bytes32 id = _unitId(e);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.compositionRoot = keccak256("some-other-root"); // != frozen 0
        a.data = abi.encode(v);
        eas.set(a);
        vm.expectRevert(VNextSettlementEscrow.CompositionRootMismatch.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
    }

    function test_EvidenceRelease_CompositionHappyPath() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        bytes32 root = keccak256("composed-root");
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        c[0].compositionSchemaVersion = 1;
        c[0].compositionRoot = root;
        _fund(e, c);
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.compositionRoot = root; // matches the frozen unit root
        a.data = abi.encode(v);
        eas.set(a);
        e.releaseFromEvidence(id, keccak256("uid-1"));
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(feeDest), 23_500000);
    }

    // ── L-01/L-02: config-envelope pin + type-hash deployment pin ─────────────────────────────────
    /// @dev L-01: MAX_CONFIG_BYTES is the EXACT canonical envelope, not a round number above it. The
    ///      max-config fit is asserted in test_gas_maxAggregateFunding_fits; this pins the constant itself
    ///      so a future UnitConfig field cannot silently leave slack (or, worse, make the max unfundable).
    function test_MaxConfigBytes_IsTheExactCanonicalEnvelope() public pure {
        // 24,644 B at rev-3, + 512 B for §B's per-unit `evidenceCommitter` (16 units x 32 B).
        assertEq(VNextSettlementLib.MAX_CONFIG_BYTES, 25_156, "16 units x 16 legs max fund() calldata");
    }

    /// @dev L-02: a non-zero `o5TypeHash` deployment pin must equal the bound cohort's live type hash.
    function test_Constructor_RejectsTypeHashDrift() public {
        vm.expectRevert(VNextSettlementEscrow.TypeHashMismatch.selector);
        new VNextSettlementEscrowFactory(
            address(usdc), address(eas), address(attester), O5_SCHEMA, keccak256("some-other-typehash")
        );
    }

    function test_Constructor_AcceptsMatchingTypeHash() public {
        VNextSettlementEscrowFactory f = new VNextSettlementEscrowFactory(
            address(usdc), address(eas), address(attester), O5_SCHEMA, attester.o5TypeHash()
        );
        assertEq(VNextSettlementEscrow(f.implementation()).o5TypeHash(), attester.o5TypeHash());
    }

    /// @dev Zero stays the documented deferred state: unpinned, no check, no security claim (the setUp
    ///      factory already exercises it — this states the intent explicitly).
    function test_Constructor_ZeroTypeHashSkipsThePin() public view {
        assertEq(VNextSettlementEscrow(factory.implementation()).o5TypeHash(), bytes32(0));
    }

    function test_EvidenceRelease_RevertsWhenUidMismatch() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1);
        a.uid = keccak256("different-uid"); // getAttestation returns a uid != the requested easUid
        eas.set(a);
        vm.expectRevert(VNextSettlementEscrow.AttestationNotFound.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
    }

    // ══ §B — on-chain evidence binding ═════════════════════════════════════════════════════════════

    // ── funding-time binding of the committer ─────────────────────────────────────────────────────
    function test_Fund_FreezesEvidenceCommitter_AndStartsUncommitted() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        assertEq(e.evidenceCommitterOf(id), operator, "committer frozen at funding");
        assertFalse(e.evidenceCommittedOf(id), "nothing committed yet");
        vm.expectRevert(VNextSettlementEscrow.EvidenceNotCommitted.selector);
        e.evidenceBundleHashOf(id); // the default value is never readable as a commitment
    }

    function test_Fund_RejectsZeroEvidenceCommitter() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].evidenceCommitter = address(0);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        e.fund(c);
    }

    function test_Fund_RejectsExcludedEvidenceCommitter() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        VNextSettlementEscrow.UnitConfig[] memory c = _oneUnitConfig(1000e6, 0, 0, 1);
        c[0].evidenceCommitter = address(usdc); // the token can never be a caller
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        e.fund(c);
    }

    // ── submitEvidence: authority, window, one-shot ───────────────────────────────────────────────
    function test_SubmitEvidence_StoresDomainSeparatedCommitment() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.expectRevert(VNextSettlementEscrow.OnlyEvidenceCommitter.selector);
        e.submitEvidence(id, PKG); // the test contract is not the committer
        vm.prank(payer); // not even the payer, unless it designated itself
        vm.expectRevert(VNextSettlementEscrow.OnlyEvidenceCommitter.selector);
        e.submitEvidence(id, PKG);
    }

    function test_SubmitEvidence_RejectsSecondCommit() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.EvidenceAlreadyCommitted.selector);
        e.submitEvidence(id, keccak256("a-second-package")); // no re-pointing to shop for a payable verdict
        assertEq(e.evidenceBundleHashOf(id), _commitment(e, id, PKG), "first commit stands");
    }

    function test_SubmitEvidence_RejectsZeroDigest() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.ZeroEvidenceDigest.selector);
        e.submitEvidence(id, bytes32(0));
    }

    function test_SubmitEvidence_RejectsAfterReclaimAt() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.warp(block.timestamp + 30 days); // == reclaimAt
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.TooLateForEvidence.selector);
        e.submitEvidence(id, PKG);
    }

    function test_SubmitEvidence_RejectsDuringLiveDispute() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.LiveDispute.selector);
        e.submitEvidence(id, PKG);
    }

    function test_SubmitEvidence_RejectsWhenNotActive() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        eas.set(_o5Attestation(e, id, 1, 1));
        e.releaseFromEvidence(id, keccak256("uid-1")); // unit is now SETTLED_RELEASED
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.submitEvidence(id, keccak256("late-package"));
    }

    function test_SubmitEvidence_RejectsUnknownUnit() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        vm.prank(operator);
        vm.expectRevert(VNextSettlementEscrow.UnitNotFound.selector);
        e.submitEvidence(keccak256("not-a-unit"), PKG);
    }

    // ── release binding ───────────────────────────────────────────────────────────────────────────
    function test_EvidenceRelease_RevertsWithNoCommit() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        eas.set(_o5Attestation(e, id, 1, 1)); // an otherwise-perfect verdict, but nothing was committed
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev The zero/default hash must never satisfy release — this is why `evidenceCommitted` is separate.
    function test_EvidenceRelease_ZeroBundleHashCannotSatisfyAnUncommittedUnit() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.evidenceBundleHash = bytes32(0); // matches the unit's untouched storage slot
        a.data = abi.encode(v);
        eas.set(a);
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
    }

    function test_EvidenceRelease_RevertsOnDigestMismatch() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        EASAttestation memory a = _o5Attestation(e, id, 1, 1);
        O5Verdict memory v = _o5FullVerdict(e, id, 1, 1);
        v.evidenceBundleHash = _commitment(e, id, keccak256("a-different-package")); // verdict over another package
        a.data = abi.encode(v);
        eas.set(a);
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));
    }

    /// @dev Domain separation: the SAME package digest committed on a different unit yields a different
    ///      commitment, so a verdict minted for unit A can never satisfy unit B.
    function test_EvidenceCommitment_DoesNotReplayAcrossUnits() public {
        VNextSettlementEscrow e1 = _newEscrow(JOB);
        VNextSettlementEscrow e2 = _newEscrow(keccak256("job-other"));
        _fund(e1, _oneUnitConfig(1000e6, 0, 0, 1));
        _fund(e2, _oneUnitConfig(1000e6, 0, 0, 1));
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

    /// @dev ONE VERDICT PER UNIT: after a settle, a second otherwise-valid verdict (fresh uid, same
    ///      committed package, same tier) cannot settle the unit again.
    function test_OneVerdictPerUnit_SecondValidVerdictCannotSettle() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        eas.set(_o5Attestation(e, id, 1, 1));
        e.releaseFromEvidence(id, keccak256("uid-1"));
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));

        EASAttestation memory a2 = _o5Attestation(e, id, 1, 1);
        a2.uid = keccak256("uid-2"); // a brand-new, fully valid attestation over the same committed package
        eas.set(a2);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.releaseFromEvidence(id, keccak256("uid-2"));
        assertEq(usdc.balanceOf(feeDest), 23_500000, "paid exactly once");
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    /// @dev The consume-once is the UNIT's state transition, and it holds even in the partially-settled
    ///      RELEASE_ALLOCATED case (payouts stuck as claims): neither a replay of the same uid nor a fresh
    ///      verdict can allocate a second release. (`_easUidUsed` sits behind this state guard as
    ///      defense-in-depth — an attestation is bound to exactly one unit, so the state guard is what
    ///      actually fires.)
    function test_OneVerdictPerUnit_ReleaseAllocatedCannotBeReReleased() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 0, 0, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        usdc.setTransferMode(MockToken.Mode.REVERT); // stay in RELEASE_ALLOCATED (claims outstanding)
        eas.set(_o5Attestation(e, id, 1, 1));
        e.releaseFromEvidence(id, keccak256("uid-1"));
        assertEq(uint256(e.unitState(id)), uint256(UnitState.RELEASE_ALLOCATED));
        assertEq(e.liabilityOf(id), 1000e6, "still owed once, not twice");

        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.releaseFromEvidence(id, keccak256("uid-1")); // same uid

        EASAttestation memory a2 = _o5Attestation(e, id, 1, 1);
        a2.uid = keccak256("uid-2");
        eas.set(a2);
        vm.expectRevert(VNextSettlementEscrow.NotActive.selector);
        e.releaseFromEvidence(id, keccak256("uid-2")); // fresh uid, same committed package
        assertEq(e.liabilityOf(id), 1000e6, "no second allocation");
    }

    // ── refund/reclaim independence (fail-closed) ─────────────────────────────────────────────────
    /// @dev The refund path must never depend on the committer OR the attester: no commit at all still
    ///      refunds the payer in full at `reclaimAt`.
    function test_Reclaim_WorksWithNoCommit() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, keccak256("wrong-package"));
        eas.set(_o5Attestation(e, id, 1, 1)); // verdict over the RIGHT package -> unpayable against this commit
        vm.expectRevert(VNextSettlementEscrow.EvidenceBundleMismatch.selector);
        e.releaseFromEvidence(id, keccak256("uid-1"));
        vm.warp(block.timestamp + 31 days);
        uint256 before = usdc.balanceOf(payer);
        e.reclaimAfterDeadline(id);
        assertEq(usdc.balanceOf(payer), before + 1000e6);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
    }

    /// @dev Dispute-driven refund is likewise independent of any commit.
    function test_DisputeRefund_WorksWithNoCommit() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
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
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        _commit(e, id, PKG);
        uint256 before = usdc.balanceOf(payer);
        vm.prank(payer);
        e.openDispute(id);
        vm.prank(arbiter);
        e.resolveDispute(id, false);
        assertEq(usdc.balanceOf(payer), before + 1000e6);
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
}
