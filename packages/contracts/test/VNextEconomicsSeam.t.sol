// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {PayoutEntry, PolicyIdentity, UnitState, AuthorizationType, VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";
import {MockToken, MockOracleAttester} from "./VNextSettlementEscrow.t.sol";
import {VNextReadLens} from "./helpers/VNextReadLens.sol";

using VNextReadLens for VNextSettlementEscrow;

/// @title The economics -> escrow seam (reconciliation R15 / invariant 12: prove the seam, not a unit)
/// @notice The payouts below are exactly what `compileEconomics` (@pcc/spec economics, TypeScript) emits
///         for three of the worked example agreements. Here they fund a real `VNextSettlementEscrow` and are
///         released, and every recipient, the fee recipient and the payer end with EXACTLY the compiled
///         amounts. The literals are the golden outputs in
///         packages/spec/src/__tests__/fixtures/economics-golden-v1.json; the vitest
///         `economics-forge-parity.test.ts` fails if this file and that fixture ever disagree.
/// @dev    Units are Tier-0 so release is the payer's explicit buyer approval: the seam under test is
///         economics' output vs the escrow's funding and allocation rules, not the evidence machine.
///         stepId = keccak256(nodeId), as composition's `stepIdBytes32` derives it. Test money only.
contract VNextEconomicsSeamTest is Test {
    MockToken usdc;
    MockOracleAttester attester;
    MockOracleAttester escalation;
    VNextSettlementEscrowFactory factory;

    uint256 constant PAYER_PK = 0xA11CE;
    uint256 constant OPERATOR_PK = 0x0FE7A;
    address payer;
    address operator;
    bytes32 constant O5_SCHEMA = keccak256("test.o5.schema");
    bytes32 constant TERMS = keccak256("pcc:economics:seam:terms");
    uint256 constant POLICY_EXPIRY = 1e12;
    uint256 constant FEE_BPS = 235;
    bytes32 constant JOB_POLICY_TYPEHASH_T = keccak256(
        "JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,uint256 expiry,bytes32 acceptedPolicyDigest)"
    );

    /// @dev 0xfee0000000000000000000000000000000000fee, the examples' protocol-fee treasury. Built
    ///      arithmetically because a 40-digit non-checksummed hex literal does not compile.
    function _feeTreasury() internal pure returns (address) {
        return address(uint160((uint256(0xfee) << 148) | 0xfee));
    }

    function setUp() public {
        payer = vm.addr(PAYER_PK);
        operator = vm.addr(OPERATOR_PK);
        usdc = new MockToken();
        attester = new MockOracleAttester(1);
        escalation = new MockOracleAttester(77);
        factory = new VNextSettlementEscrowFactory(address(usdc), address(attester), address(escalation), O5_SCHEMA, bytes32(0));
        usdc.mint(payer, 100_000e6);
    }

    // ── The compiled examples (golden literals) ─────────────────────────────────────────────────────

    function _leg(address to, uint256 amount) internal pure returns (PayoutEntry memory) {
        return PayoutEntry({recipient: to, amount: amount});
    }

    /// @dev One Tier-0 unit. `fExpected` is the fee the TypeScript compiler emitted; the escrow's own rule
    ///      (floor(g*feeBps/10000)) must agree with it exactly, or the seam is broken.
    function _unit(string memory nodeId, uint256 milestoneIndex, uint256 g, uint256 fExpected, PayoutEntry[] memory legs)
        internal
        view
        returns (VNextSettlementEscrow.UnitConfig memory c)
    {
        uint256 f = (g * FEE_BPS) / 10_000;
        assertEq(f, fExpected, "economics fee != escrow fee rule");
        c = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: milestoneIndex,
            stepId: keccak256(bytes(nodeId)),
            requiredTier: 0,
            requestedTier: 0,
            g: g,
            f: f,
            n: g - f,
            feeBps: uint16(FEE_BPS),
            feeRecipient: _feeTreasury(),
            reclaimAt: block.timestamp + 30 days,
            compositionSchemaVersion: 0,
            compositionRoot: bytes32(0),
            payouts: legs
        });
    }

    /// @dev ex2-print-and-mail: fixed upstream prices, postage at cost, a per-use method fee, composer margin.
    function _examplePrintAndMail() internal view returns (VNextSettlementEscrow.UnitConfig[] memory cfgs) {
        PayoutEntry[] memory u0 = new PayoutEntry[](2);
        u0[0] = _leg(address(0x0b17002), 1671000);
        u0[1] = _leg(address(0xc0a0003), 12000000);
        PayoutEntry[] memory u1 = new PayoutEntry[](4);
        u1[0] = _leg(address(0x0b17002), 1882000);
        u1[1] = _leg(address(0x3e10005), 250000);
        u1[2] = _leg(address(0xc0a1004), 680000);
        u1[3] = _leg(address(0xc0a1004), 5000000);
        cfgs = new VNextSettlementEscrow.UnitConfig[](2);
        cfgs[0] = _unit("a-print", 0, 14000000, 329000, u0);
        cfgs[1] = _unit("b-mail", 1, 8000000, 188000, u1);
    }

    /// @dev ex3-guild-repair: nested split with dust (treasury 10%, members by hours 5/3/1).
    function _exampleGuildRepair() internal view returns (VNextSettlementEscrow.UnitConfig[] memory cfgs) {
        PayoutEntry[] memory u0 = new PayoutEntry[](6);
        u0[0] = _leg(address(0xa0a003), 65289807);
        u0[1] = _leg(address(0xbe0004), 39173884);
        u0[2] = _leg(address(0xc10005), 13057962);
        u0[3] = _leg(address(0x15e0007), 2700150);
        u0[4] = _leg(address(0x1ee0006), 42500000);
        u0[5] = _leg(address(0x7ea5002), 13057962);
        cfgs = new VNextSettlementEscrow.UnitConfig[](1);
        cfgs[0] = _unit("repair", 0, 180010000, 4230235, u0);
    }

    /// @dev ex5-deck-milestones: three milestones; the build step is the one that fails in the refund test.
    function _exampleDeckMilestones() internal view returns (VNextSettlementEscrow.UnitConfig[] memory cfgs) {
        PayoutEntry[] memory u0 = new PayoutEntry[](2);
        u0[0] = _leg(address(0xb1c0102), 181200000);
        u0[1] = _leg(address(0xde50103), 600000000);
        PayoutEntry[] memory u1 = new PayoutEntry[](3);
        u1[0] = _leg(address(0x1250105), 78000000);
        u1[1] = _leg(address(0xb1c0102), 3058850000);
        u1[2] = _leg(address(0xced0104), 3210400000);
        PayoutEntry[] memory u2 = new PayoutEntry[](2);
        u2[0] = _leg(address(0x15e0106), 250000000);
        u2[1] = _leg(address(0xb1c0102), 433550000);
        cfgs = new VNextSettlementEscrow.UnitConfig[](3);
        cfgs[0] = _unit("m1-design", 0, 800000000, 18800000, u0);
        cfgs[1] = _unit("m2-build", 1, 6500000000, 152750000, u1);
        cfgs[2] = _unit("m3-inspect", 2, 700000000, 16450000, u2);
    }

    // ── Bilateral acceptance and funding (re-derived from the frozen spec, as the escrow tests do) ──

    function _identity(bytes32 job, VNextSettlementEscrow.UnitConfig[] memory cfgs) internal view returns (PolicyIdentity memory) {
        return PolicyIdentity({
            payer: payer,
            operator: operator,
            jobIdHash: job,
            termsHash: TERMS,
            policyNonce: 1,
            prePolicyRoot: keccak256(abi.encode(cfgs)),
            acceptedPolicyDigest: bytes32(0)
        });
    }

    function _unitId(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig memory c) internal view returns (bytes32) {
        return VNextSettlementLib.computeSettlementUnitId(block.chainid, address(e), e.jobIdHash(), c.milestoneIndex, c.stepId);
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

    function _acceptance(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        view
        returns (VNextSettlementEscrow.PolicyAcceptance memory)
    {
        (, uint256 nonce, bytes32 preRoot,,) = e.policy();
        bytes32 unitsRoot;
        for (uint256 i; i < cfgs.length; ++i) {
            unitsRoot = keccak256(abi.encode(unitsRoot, _unitId(e, cfgs[i])));
        }
        address f = e.factory();
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(
                    JOB_POLICY_TYPEHASH_T,
                    block.chainid,
                    f,
                    VNextSettlementEscrowFactory(f).implementation(),
                    address(e),
                    uint256(2),
                    payer,
                    operator
                ),
                abi.encode(e.jobIdHash(), TERMS, nonce, preRoot, unitsRoot, POLICY_EXPIRY, bytes32(0))
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSep(address(e)), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OPERATOR_PK, digest);
        return VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            payerSignature: bytes(""),
            operatorSignature: abi.encodePacked(r, s, v)
        });
    }

    function _escrowFor(bytes32 job, VNextSettlementEscrow.UnitConfig[] memory cfgs) internal returns (VNextSettlementEscrow) {
        return VNextSettlementEscrow(factory.createEscrow(_identity(job, cfgs)));
    }

    function _fund(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig[] memory cfgs) internal {
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, cfgs);
        vm.prank(payer);
        e.fund(cfgs, acc);
    }

    /// @dev The payer's explicit Tier-0 buyer approval, sent by the payer (no signature needed then).
    function _release(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig memory c) internal {
        bytes32 id = _unitId(e, c);
        VNextSettlementEscrow.BuyerApproval memory a = VNextSettlementEscrow.BuyerApproval({
            chainId: block.chainid,
            escrow: address(e),
            contractVersion: e.CONTRACT_VERSION(),
            settlementUnitId: id,
            payer: payer,
            jobIdHash: e.jobIdHash(),
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
        vm.prank(payer);
        e.approveByBuyer(id, a, "");
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
    }

    // ── The seam: compiled legs fund and release to the base unit ────────────────────────────────

    function test_Seam_PrintAndMail_EveryPartyPaidExactlyTheCompiledAmount() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _examplePrintAndMail();
        VNextSettlementEscrow e = _escrowFor(keccak256("ex2-print-and-mail"), cfgs);
        uint256 payerBefore = usdc.balanceOf(payer);
        _fund(e, cfgs);
        assertEq(usdc.balanceOf(address(e)), 22000000);
        _release(e, cfgs[0]);
        _release(e, cfgs[1]);

        assertEq(usdc.balanceOf(address(0x0b17002)), 3553000, "composer margin: 1.671000 + 1.882000");
        assertEq(usdc.balanceOf(address(0xc0a0003)), 12000000, "print shop fixed price");
        assertEq(usdc.balanceOf(address(0xc0a1004)), 5680000, "courier fee + postage at cost, two legs one wallet");
        assertEq(usdc.balanceOf(address(0x3e10005)), 250000, "method inventor, one use");
        assertEq(usdc.balanceOf(_feeTreasury()), 517000, "protocol fee 0.329000 + 0.188000");
        assertEq(usdc.balanceOf(address(e)), 0, "nothing left in escrow");
        assertEq(payerBefore - usdc.balanceOf(payer), 22000000, "payer spent exactly the price");
    }

    function test_Seam_GuildRepair_NestedSplitDustLandsExactly() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _exampleGuildRepair();
        VNextSettlementEscrow e = _escrowFor(keccak256("ex3-guild-repair"), cfgs);
        _fund(e, cfgs);
        _release(e, cfgs[0]);
        assertEq(usdc.balanceOf(address(0xa0a003)), 65289807);
        assertEq(usdc.balanceOf(address(0xbe0004)), 39173884);
        assertEq(usdc.balanceOf(address(0xc10005)), 13057962, "the leftover base unit went to the largest remainder");
        assertEq(usdc.balanceOf(address(0x7ea5002)), 13057962, "treasury won the tie");
        assertEq(usdc.balanceOf(address(0x1ee0006)), 42500000);
        assertEq(usdc.balanceOf(address(0x15e0007)), 2700150);
        assertEq(usdc.balanceOf(_feeTreasury()), 4230235);
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    function test_Seam_DeckMilestones_FailedBuildStepIsRefundedAndOnlyThatStep() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _exampleDeckMilestones();
        VNextSettlementEscrow e = _escrowFor(keccak256("ex5-deck-milestones"), cfgs);
        uint256 payerBefore = usdc.balanceOf(payer);
        _fund(e, cfgs);
        _release(e, cfgs[0]);
        _release(e, cfgs[2]);
        // The build step's evidence never comes: after its deadline, anyone may return its money to the payer.
        vm.warp(cfgs[1].reclaimAt);
        e.reclaimAfterDeadline(_unitId(e, cfgs[1]));
        assertEq(uint256(e.unitState(_unitId(e, cfgs[1]))), uint256(UnitState.SETTLED_REFUNDED));

        assertEq(payerBefore - usdc.balanceOf(payer), 1500000000, "spent design + inspection only");
        assertEq(usdc.balanceOf(address(0xde50103)), 600000000, "designer");
        assertEq(usdc.balanceOf(address(0xb1c0102)), 614750000, "contractor: 181.20 + 433.55, not the build share");
        assertEq(usdc.balanceOf(address(0x15e0106)), 250000000, "inspector");
        assertEq(usdc.balanceOf(address(0xced0104)), 0, "lumber: build step refunded");
        assertEq(usdc.balanceOf(address(0x1250105)), 0, "insurer: build step refunded");
        assertEq(usdc.balanceOf(_feeTreasury()), 35250000, "no fee on the refunded step");
        assertEq(usdc.balanceOf(address(e)), 0);
    }

    // ── Negative controls: output the compiler must never emit is refused by the escrow itself ─────

    function test_Negative_OneBaseUnitOverRevertsPayoutSumMismatch() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _examplePrintAndMail();
        cfgs[1].payouts[0].amount += 1;
        VNextSettlementEscrow e = _escrowFor(keccak256("neg-sum"), cfgs);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, cfgs);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.PayoutSumMismatch.selector);
        e.fund(cfgs, acc);
    }

    function test_Negative_SeventeenLegsRevertsBadLegCount() public {
        VNextSettlementEscrow.UnitConfig[] memory one = _exampleGuildRepair();
        uint256 n = one[0].n;
        PayoutEntry[] memory legs = new PayoutEntry[](17);
        for (uint256 i; i < 16; ++i) legs[i] = _leg(address(uint160(0x5000 + i)), 1);
        legs[16] = _leg(address(uint160(0x5010)), n - 16);
        one[0].payouts = legs;
        VNextSettlementEscrow e = _escrowFor(keccak256("neg-legs"), one);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, one);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.BadLegCount.selector);
        e.fund(one, acc);
    }

    function test_Negative_SettlementTokenAsRecipientRevertsForbiddenRecipient() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _examplePrintAndMail();
        cfgs[0].payouts[1].recipient = address(usdc);
        VNextSettlementEscrow e = _escrowFor(keccak256("neg-recipient"), cfgs);
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, cfgs);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.ForbiddenRecipient.selector);
        e.fund(cfgs, acc);
    }

    /// @dev Leg order is part of the funded terms: the same legs reordered are a different policy, and the
    ///      clone committed to the compiled order cannot be funded with them.
    function test_Negative_ReorderedLegsCannotFundTheCompiledClone() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _examplePrintAndMail();
        VNextSettlementEscrow e = _escrowFor(keccak256("neg-order"), cfgs);
        VNextSettlementEscrow.UnitConfig[] memory reordered = _examplePrintAndMail();
        PayoutEntry memory first = reordered[1].payouts[0];
        reordered[1].payouts[0] = reordered[1].payouts[3];
        reordered[1].payouts[3] = first;
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, reordered);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrow.PolicyRootMismatch.selector);
        e.fund(reordered, acc);
    }
}
