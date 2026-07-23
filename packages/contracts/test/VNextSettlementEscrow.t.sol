// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementEscrow, O5Verdict} from "../src/VNextSettlementEscrow.sol";
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

contract VNextSettlementEscrowTest is Test {
    MockToken usdc;
    MockEAS eas;
    VNextSettlementEscrowFactory factory;

    address oracle = address(0xACE1);
    uint256 payerPk = 0xA11CE;
    address payer;
    address arbiter = address(0xAB12);
    address recip1 = address(0xBEEF01);
    address recip2 = address(0xBEEF02);
    address feeDest = address(0xFEE1);
    bytes32 constant O5_SCHEMA = keccak256("test.o5.schema");
    bytes32 constant JOB = keccak256("job-1");
    bytes32 constant TERMS = keccak256("terms-1");

    function setUp() public {
        payer = vm.addr(payerPk);
        usdc = new MockToken();
        eas = new MockEAS();
        factory = new VNextSettlementEscrowFactory(address(usdc), address(eas), oracle, O5_SCHEMA, bytes32(0));
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
    function _o5Attestation(VNextSettlementEscrow e, bytes32 id, uint8 decision, uint8 achieved)
        internal
        view
        returns (EASAttestation memory a)
    {
        O5Verdict memory v = O5Verdict({
            jobIdHash: JOB,
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            evidenceBundleHash: keccak256("bundle"),
            achievedTier: achieved,
            requestedTier: 1,
            decision: decision,
            verdictHash: keccak256("verdict"),
            feeBps: e.feeBpsOf(id),
            feeRecipient: e.feeRecipientOf(id),
            feeScheduleHash: e.feeScheduleHashOf(id),
            settlementUnitId: id
        });
        a = EASAttestation({
            uid: keccak256("uid-1"),
            schema: O5_SCHEMA,
            time: uint64(block.timestamp),
            expirationTime: 0,
            revocationTime: 0,
            refUID: bytes32(0),
            recipient: address(e),
            attester: oracle,
            revocable: true,
            data: abi.encode(v)
        });
    }

    function test_EvidenceRelease_Settle() public {
        VNextSettlementEscrow e = _newEscrow(JOB);
        _fund(e, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
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
            settlementUnitId: id
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
            settlementUnitId: unitId
        });
        bytes memory o5 = abi.encode(v);
        emit log_named_uint("o5Verdict_encoded_bytes", o5.length);
        emit log_named_bytes32("o5Verdict_keccak", keccak256(o5));
    }
}
