// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {
    O5Verdict,
    O5Assertion,
    O5Adjudication,
    O5AdjudicationRecord,
    O5_DECISION_SETTLE
} from "../src/O5Types.sol";
import {IOracleAttester} from "../src/interfaces/IOracleAttester.sol";
import {PayoutEntry, PolicyIdentity, UnitState, VNextSettlementLib} from "../src/libraries/VNextSettlementLib.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {O5AttesterBase} from "../src/attesters/O5AttesterBase.sol";

/// @dev Minimal USDC double: NORMAL-transfer semantics only. The adversarial transfer-classifier matrix
///      (fee-on-transfer, debit-no-credit, wrong-delta, ...) is already covered by
///      `VNextSettlementEscrow.t.sol`'s `MockToken` and is out of scope here — this file tests chain
///      binding, not the token-transfer classifier.
contract MockToken {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

/// @dev Minimal IOracleAttester double, mirroring `VNextSettlementEscrow.t.sol`'s `MockOracleAttester`
///      (settable per-unit assertion record; the escrow's money path only ever STATICCALLs
///      assertionOf/enabled/cohortId/disabledAt — attestO5/adjudicate are never called BY the escrow, so
///      both are harmless no-ops here, exactly as in the inherited suite's fixture).
contract MockOracleAttester is IOracleAttester {
    bool public enabled = true;
    uint64 public cohortId;
    uint64 public disabledAt;
    mapping(bytes32 => O5Assertion) internal _assertions;
    mapping(bytes32 => O5AdjudicationRecord) internal _adj;
    bytes32 public o5TypeHash = keccak256("mock.o5.typehash");
    bytes32 public o5SchemaUid = keccak256("test.o5.schema");

    /// @dev H-02: distinct per cohort — the escrow's constructor forbids a shared revoker across the two
    ///      bound cohorts (one key holder must not be able to press both kill switches).
    address public revoker;

    constructor(uint64 cohortId_) {
        cohortId = cohortId_;
        revoker = address(uint160(0xE0000 + uint256(cohortId_)));
    }

    function setAssertion(bytes32 unitId, O5Assertion memory a) external {
        _assertions[unitId] = a;
    }

    function assertionOf(bytes32 unitId) external view returns (O5Assertion memory) {
        return _assertions[unitId];
    }

    function attestO5(O5Verdict calldata, address, bytes[] calldata) external pure returns (bytes32) {
        return bytes32(0);
    }

    function disable() external {
        enabled = false;
        uint64 t = uint64(block.timestamp);
        disabledAt = t == 0 ? 1 : t;
    }

    function adjudicationOf(bytes32 unitId, uint8 role, address escrow)
        external
        view
        returns (O5AdjudicationRecord memory)
    {
        return _adj[keccak256(abi.encode(unitId, role, escrow))];
    }

    function adjudicationDecidedAt(bytes32 unitId, uint8 role, address escrow, bytes32 reviewedAssertionId)
        external
        view
        returns (uint64)
    {
        O5AdjudicationRecord storage r = _adj[keccak256(abi.encode(unitId, role, escrow))];
        if (
            r.adjudicationId == bytes32(0) || r.escrow != escrow
                || r.reviewedAssertionId != reviewedAssertionId
        ) return type(uint64).max;
        return r.decidedAt;
    }

    function adjudicate(O5Adjudication calldata, bytes[] calldata) external pure returns (bytes32) {
        return bytes32(0);
    }
}

/// @dev Minimal escrow-binding double for the O5AttesterBase M-01 anti-brick pre-check STATICCALLs
///      (used ONLY by test 3, which exercises the attester in isolation — no escrow/factory needed to
///      prove the attester's own `block.chainid` re-check). Mirrors `Fixed2of3O5Attester.t.sol`'s
///      `MockEscrowBinding` shape, trimmed to one setter.
contract MockEscrowBinding {
    mapping(bytes32 => bytes32) public root;
    mapping(bytes32 => bytes32) internal _bundle;
    mapping(bytes32 => bytes32) public feeHash;
    mapping(bytes32 => uint16) public feeBpsVal;
    mapping(bytes32 => address) public feeRecipVal;
    mapping(bytes32 => uint8) public tier;

    function setAll(bytes32 unitId, bytes32 r, bytes32 bundle, bytes32 fh, uint16 bps, address recip, uint8 t)
        external
    {
        root[unitId] = r;
        _bundle[unitId] = bundle;
        feeHash[unitId] = fh;
        feeBpsVal[unitId] = bps;
        feeRecipVal[unitId] = recip;
        tier[unitId] = t;
    }

    function compositionRootOf(bytes32 unitId) external view returns (bytes32) {
        return root[unitId];
    }

    function evidenceBundleHashOf(bytes32 unitId) external view returns (bytes32) {
        return _bundle[unitId];
    }

    function feeScheduleHashOf(bytes32 unitId) external view returns (bytes32) {
        return feeHash[unitId];
    }

    function feeBpsOf(bytes32 unitId) external view returns (uint16) {
        return feeBpsVal[unitId];
    }

    function feeRecipientOf(bytes32 unitId) external view returns (address) {
        return feeRecipVal[unitId];
    }

    function requiredTierOf(bytes32 unitId) external view returns (uint8) {
        return tier[unitId];
    }
}

/**
 * @title VNextCrossChainTest
 * @notice test-writer-india: the dual-network (Base mainnet + Base Sepolia) cross-chain rejection tests
 *         flagged by the cross-family (sol/GPT-5.6) review as the one real gap. Every unit id is derived
 *         `computeSettlementUnitId(chainId, escrow, jobIdHash, milestoneIndex, stepId)`
 *         (`src/libraries/VNextSettlementLib.sol:283-291`) — `chainId` is IN the preimage, but the CREATE2
 *         salt (`computePolicySalt`, `VNextSettlementLib.sol:300-314`) is NOT, so a payer/operator pair
 *         funding the "same" job on both networks gets the SAME clone address (test 2's headline
 *         assertion) and cross-chain safety rests ENTIRELY on the chainId bindings below, not on any
 *         accidental address divergence.
 *
 *         Deliberately does NOT inherit `VNextSettlementEscrowTest` (a second inheriting file would
 *         silently re-run that whole suite under a new contract name and corrupt the baseline counts).
 *         The fixture below is a MINIMAL, independent duplicate of the parts of that suite this file
 *         needs (MockToken, MockOracleAttester, `_oneUnitConfig`, `_fundedEscrow`, `_domainSep`, ...).
 *
 *         Real chain ids throughout (never a placeholder): Base mainnet = 8453, Base Sepolia = 84532.
 */
contract VNextCrossChainTest is Test {
    uint256 constant SEPOLIA = 84532;
    uint256 constant MAINNET = 8453;

    MockToken usdc;
    MockOracleAttester attester;
    MockOracleAttester escalation;
    VNextSettlementEscrowFactory factory;

    uint64 constant COHORT = 1;
    uint64 constant ESC_COHORT = 77;
    uint256 payerPk = 0xA11CE;
    address payer;
    address arbiter = address(0xAB12);
    address recip1 = address(0xBEEF01);
    address recip2 = address(0xBEEF02);
    address feeDest = address(0xFEE1);
    uint256 operatorPk = 0x0FE7A;
    address operator;
    bytes32 constant PKG = keccak256("xchain-evidence-package-v1");
    bytes32 constant O5_SCHEMA = keccak256("test.o5.schema");
    bytes32 constant JOB = keccak256("xchain-job");
    bytes32 constant TERMS = keccak256("xchain-terms");
    uint256 constant POLICY_EXPIRY = 1e12;

    // ── contract-level state reserved for test 3 (the O5-attester chain-binding test). Kept as STATE
    //    (not function locals) specifically to stay clear of Solidity's non-via-IR stack-too-deep limit —
    //    see the comment on `_deployO5Fixture` below. ──
    Fixed2of3O5Attester internal xAtt;
    MockEscrowBinding internal xBinding;
    address internal xEscrow;
    uint256 internal constant PKA = 0x51157A1;
    uint256 internal constant PKB = 0x51157B2;
    uint256 internal constant PKC = 0x51157C3;

    function setUp() public {
        // Explicit starting chain -- never rely on the default anvil chainid (31337) for a test whose
        // entire point is which chain we are on.
        vm.chainId(SEPOLIA);
        payer = vm.addr(payerPk);
        operator = vm.addr(operatorPk);
        usdc = new MockToken();
        attester = new MockOracleAttester(COHORT);
        escalation = new MockOracleAttester(ESC_COHORT);
        factory =
            new VNextSettlementEscrowFactory(address(usdc), address(attester), address(escalation), O5_SCHEMA, bytes32(0));
        usdc.mint(payer, 1_000_000e6);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // Minimal duplicated fixture (mirrors VNextSettlementEscrow.t.sol's helpers of the same name/shape;
    // kept independent per the task's no-inherit instruction).
    // ══════════════════════════════════════════════════════════════════════════════════════════════

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
            reclaimAt: block.timestamp + 30 days,
            compositionSchemaVersion: 0,
            compositionRoot: bytes32(0),
            payouts: po
        });
    }

    function _identity(bytes32 job, uint256 nonce, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        view
        returns (PolicyIdentity memory)
    {
        return PolicyIdentity({
            payer: payer,
            operator: operator,
            jobIdHash: job,
            termsHash: TERMS,
            policyNonce: nonce,
            prePolicyRoot: keccak256(abi.encode(cfgs))
        });
    }

    function _escrowFor(bytes32 job, uint256 nonce, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        returns (VNextSettlementEscrow e)
    {
        e = VNextSettlementEscrow(factory.createEscrow(_identity(job, nonce, cfgs)));
    }

    /// @dev The clone's EIP-712 domain -- byte-identical to VNextSettlementEscrow.t.sol's `_domainSep`.
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

    /// @dev The rolling commitment over the settlementUnitIds this escrow would freeze -- mirrors the
    ///      escrow's own private `_unitsRoot`, recomputed here from the predicted address.
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

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev RE-DERIVES the JobPolicyHash from the frozen spec (VNextSettlementLib.JOB_POLICY_TYPEHASH +
    ///      VNextSettlementEscrowFactory._hashJobPolicy's exact field order/split, `src/VNextSettlementEscrowFactory.sol:275-300`)
    ///      rather than asking the contract for it. Reads `block.chainid` LIVE (field 1 of the typehash,
    ///      `src/libraries/VNextSettlementLib.sol:150-152`) -- which is exactly the property test 5 exploits.
    function _jobPolicyDigest(
        VNextSettlementEscrow e,
        VNextSettlementEscrow.UnitConfig[] memory cfgs,
        uint256 nonce,
        bytes32 preRoot
    ) internal view returns (bytes32) {
        bytes32 job = e.jobIdHash();
        bytes32 uRoot = _unitsRootFor(address(e), job, cfgs);
        bytes32 structHash = keccak256(
            bytes.concat(
                abi.encode(
                    VNextSettlementLib.JOB_POLICY_TYPEHASH,
                    block.chainid,
                    address(factory),
                    factory.implementation(),
                    address(e),
                    VNextSettlementLib.POLICY_VERSION_V2, // WAVE 4b: 1 -> 2
                    payer,
                    operator
                ),
                abi.encode(job, TERMS, nonce, preRoot, uRoot, POLICY_EXPIRY)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSep(address(e)), structHash));
    }

    /// @dev The canonical acceptance for `e`'s own current frozen identity + the configs being funded,
    ///      signed under WHATEVER `block.chainid` is live right now (that is the point -- callers control
    ///      which chain a signature is "for" purely via `vm.chainId` before calling this helper).
    function _acceptance(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        view
        returns (VNextSettlementEscrow.PolicyAcceptance memory acc)
    {
        (, uint256 nonce, bytes32 preRoot,) = e.policy();
        bytes32 digest = _jobPolicyDigest(e, cfgs, nonce, preRoot);
        acc = VNextSettlementEscrow.PolicyAcceptance({
            expiry: POLICY_EXPIRY,
            payerSignature: bytes(""),
            operatorSignature: _sign(operatorPk, digest)
        });
    }

    function _fund(VNextSettlementEscrow e, VNextSettlementEscrow.UnitConfig[] memory cfgs) internal {
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, cfgs);
        vm.prank(payer);
        e.fund(cfgs, acc);
    }

    function _fundedEscrow(bytes32 job, uint256 nonce, VNextSettlementEscrow.UnitConfig[] memory cfgs)
        internal
        returns (VNextSettlementEscrow e)
    {
        e = _escrowFor(job, nonce, cfgs);
        _fund(e, cfgs);
    }

    /// @dev The exact unitId this escrow's single unit was frozen under -- MUST be called while
    ///      `block.chainid` still equals whatever it was AT FUNDING TIME. Calling this after a `vm.chainId`
    ///      flip recomputes a DIFFERENT (nonexistent) id and every test below is careful never to do that.
    function _unitId(VNextSettlementEscrow e) internal view returns (bytes32) {
        return VNextSettlementLib.computeSettlementUnitId(block.chainid, address(e), e.jobIdHash(), 0, keccak256("step-0"));
    }

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

    function _o5FullVerdict(VNextSettlementEscrow e, bytes32 id, uint8 decision, uint8 achieved)
        internal
        view
        returns (O5Verdict memory v)
    {
        v = O5Verdict({
            jobIdHash: e.jobIdHash(),
            milestoneIndex: 0,
            stepId: keccak256("step-0"),
            evidenceBundleHash: _commitment(e, id, PKG),
            achievedTier: achieved,
            requestedTier: 1,
            decision: decision,
            verdictHash: keccak256("xchain-verdict"),
            feeBps: e.feeBpsOf(id),
            feeRecipient: e.feeRecipientOf(id),
            feeScheduleHash: e.feeScheduleHashOf(id),
            settlementUnitId: id,
            oracleAuthEpoch: COHORT,
            compositionRoot: bytes32(0)
        });
    }

    function _assertionFor(O5Verdict memory v, address escrow) internal view returns (O5Assertion memory a) {
        a = O5Assertion({
            assertionId: keccak256("xchain-assertion-1"),
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

    function _assert(VNextSettlementEscrow e, bytes32 id, uint8 decision, uint8 achieved) internal {
        attester.setAssertion(id, _assertionFor(_o5FullVerdict(e, id, decision, achieved), address(e)));
    }

    /// @dev Commit + assert + ACCEPT, leaving the unit in PRIMARY_ASSERTED with the challenge window open.
    function _acceptNow(VNextSettlementEscrow e, bytes32 id) internal {
        _commit(e, id, PKG);
        _assert(e, id, 1, 1);
        e.acceptAssertion(id);
    }

    function _twoSigsAscending(uint256 pkA, uint256 pkB, bytes32 digest) internal pure returns (bytes[] memory sigs) {
        sigs = new bytes[](2);
        if (vm.addr(pkA) < vm.addr(pkB)) {
            sigs[0] = _sign(pkA, digest);
            sigs[1] = _sign(pkB, digest);
        } else {
            sigs[0] = _sign(pkB, digest);
            sigs[1] = _sign(pkA, digest);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // TEST 1 -- POSITIVE CONTROL (must pass before any chain-flip test can be trusted)
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_01_PositiveControl_SameChainFullSettleSucceeds() public {
        vm.chainId(SEPOLIA);
        VNextSettlementEscrow e = _fundedEscrow(JOB, 1, _oneUnitConfig(1000e6, 23_500000, 235, 1));
        bytes32 id = _unitId(e);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));

        _acceptNow(e, id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.PRIMARY_ASSERTED));

        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        e.finalize(id);

        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(recip1) + usdc.balanceOf(recip2), 1000e6 - 23_500000);
        assertEq(usdc.balanceOf(feeDest), 23_500000);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // TEST 2 -- SAME CREATE2 ADDRESS, BUT THE SETTLE (RELEASE) PATH IS STILL REJECTED CROSS-CHAIN
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_02_SameCREATE2Address_ButReleaseRejectedCrossChain_RuntimeDomainMismatch() public {
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(1000e6, 23_500000, 235, 1);
        PolicyIdentity memory ident = _identity(JOB, 1, cfgs);

        // ── the headline assertion: the CREATE2 address does not depend on chainId at all. ──
        // `computePolicySalt` (VNextSettlementLib.sol:300-314) takes no chainId parameter -- it is `pure`,
        // so it structurally CANNOT read block.chainid -- and CREATE2 itself never reads chainid in the
        // EVM. Proven here by predicting under both live chainids with zero funding having happened yet.
        vm.chainId(SEPOLIA);
        address addrSepolia = factory.predictEscrow(ident);

        vm.chainId(MAINNET);
        address addrMainnet = factory.predictEscrow(ident);
        assertEq(
            addrSepolia,
            addrMainnet,
            "CREATE2 clone address must be IDENTICAL across chains -- protection cannot come from address divergence"
        );

        // ── build + fund the policy ON CHAIN A (Sepolia), drive it to an accepted, unchallenged SETTLE ──
        vm.chainId(SEPOLIA);
        VNextSettlementEscrow e = _fundedEscrow(JOB, 1, cfgs);
        assertEq(address(e), addrSepolia, "sanity: the funded clone IS the address predicted on both chains");
        bytes32 id = _unitId(e); // computed while chainid == SEPOLIA -- this is what got frozen into storage
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));

        // commit + assert + accept all SUCCEED regardless of live chainid (VNextSettlementEscrow.sol:1006-1031,
        // 1429-1478 -- both read the unit's FROZEN u.feeSchedule.chainId, never live block.chainid; they move
        // no money, so this permissiveness is safe by design, not a gap -- see the work log's B3 resolution).
        _acceptNow(e, id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.PRIMARY_ASSERTED));

        // ── now simulate a mis-relayed / mis-configured cross-chain settle attempt: flip the LIVE chain ──
        vm.chainId(MAINNET);
        vm.warp(block.timestamp + VNextSettlementLib.CHALLENGE_WINDOW);
        vm.expectRevert(VNextSettlementEscrow.RuntimeDomainMismatch.selector);
        e.finalize(id);
        // EXACT constraint that caught it: `_assertRuntimeDomain` (VNextSettlementEscrow.sol:1163-1167),
        // called from `_allocateRelease` (:1246) which `finalize`'s PRIMARY_ASSERTED branch calls (:1580).
        // `u.feeSchedule.chainId` (frozen == SEPOLIA at funding) != live `block.chainid` (== MAINNET).

        // ── positive companion: flip BACK to the funding chain -- the identical call now succeeds. ──
        // Isolates chainId as the ONLY variable that changed between the reverting and succeeding call.
        vm.chainId(SEPOLIA);
        e.finalize(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_RELEASED));
        assertEq(usdc.balanceOf(recip1) + usdc.balanceOf(recip2), 1000e6 - 23_500000);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // TEST 3 -- A VALIDLY QUORUM-SIGNED O5 VERDICT FOR SEPOLIA IS REJECTED ON MAINNET, AT THE ATTESTER
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    struct O5Fixture {
        bytes32 job;
        uint256 mi;
        bytes32 root;
        bytes32 bundle;
        bytes32 feeHash;
        uint16 feeBps;
        address feeRecip;
        uint8 tier;
    }

    /// @dev Deploys a REAL Fixed2of3O5Attester + a minimal escrow-binding double into contract-level
    ///      state. Split out of the test function (and using state rather than locals) specifically to
    ///      keep `test_03`'s own local-variable count low -- this file originally hit "stack too deep"
    ///      (a non-via-IR Solidity limit on simultaneously-live locals in one function; this repo's
    ///      foundry.toml does not enable via-ir and this file must not change build config) with the O5
    ///      verdict-construction locals all inlined into one function.
    function _deployO5Fixture() internal {
        xAtt = new Fixed2of3O5Attester(
            vm.addr(PKA), vm.addr(PKB), vm.addr(PKC), address(0xEA5DEAD), O5_SCHEMA, COHORT, address(0xD00DFEED)
        );
        xBinding = new MockEscrowBinding();
        xEscrow = address(xBinding);
    }

    function _o5Fixture() internal pure returns (O5Fixture memory fx) {
        fx = O5Fixture({
            job: keccak256("xchain-o5-job"),
            mi: 0,
            root: keccak256("xchain-root"),
            bundle: keccak256("xchain-bundle-commitment"),
            feeHash: keccak256("xchain-fee-hash"),
            feeBps: 235,
            feeRecip: address(0xFEEDBEEF),
            tier: 1
        });
    }

    /// @dev Builds an O5Verdict whose `settlementUnitId` is computed for `suidChainId` (which may differ
    ///      from the LIVE `block.chainid` at call time -- that mismatch is exactly what test 3 exploits),
    ///      and seeds `xBinding` so the attester's M-01 STATICCALL pre-checks all match.
    function _buildO5Verdict(O5Fixture memory fx, bytes32 stepId, uint256 suidChainId)
        internal
        returns (O5Verdict memory v)
    {
        bytes32 suid = VNextSettlementLib.computeSettlementUnitId(suidChainId, xEscrow, fx.job, fx.mi, stepId);
        xBinding.setAll(suid, fx.root, fx.bundle, fx.feeHash, fx.feeBps, fx.feeRecip, fx.tier);
        v = O5Verdict({
            jobIdHash: fx.job,
            milestoneIndex: fx.mi,
            stepId: stepId,
            evidenceBundleHash: fx.bundle,
            achievedTier: fx.tier,
            requestedTier: fx.tier,
            decision: O5_DECISION_SETTLE,
            verdictHash: keccak256(abi.encode("xchain-o5-vh", stepId)),
            feeBps: fx.feeBps,
            feeRecipient: fx.feeRecip,
            feeScheduleHash: fx.feeHash,
            settlementUnitId: suid,
            oracleAuthEpoch: COHORT,
            compositionRoot: fx.root
        });
    }

    function test_03_O5VerdictSignedForSepolia_RejectedOnMainnet_EscrowVerdictMismatch() public {
        _deployO5Fixture();
        O5Fixture memory fx = _o5Fixture();

        // ── positive control: build + sign + attest ON Sepolia; a genuinely valid quorum succeeds ──
        vm.chainId(SEPOLIA);
        O5Verdict memory vGood = _buildO5Verdict(fx, keccak256("xchain-o5-step-good"), SEPOLIA);
        bytes32 assertionId = xAtt.attestO5(vGood, xEscrow, _twoSigsAscending(PKA, PKB, xAtt.digestOf(vGood)));
        assertTrue(assertionId != bytes32(0), "a genuinely chain-matched, quorum-signed verdict must succeed");

        // ── the replay: a verdict + suid built and SIGNED for Sepolia, submitted while live chainid ==
        //    Mainnet. Uses a genuinely valid 2-of-3 quorum (PKA+PKC) so the rejection cannot be attributed
        //    to anything except the chain mismatch. ──
        O5Verdict memory vReplay = _buildO5Verdict(fx, keccak256("xchain-o5-step-replay"), SEPOLIA);
        bytes32 digestReplay = xAtt.digestOf(vReplay); // computed while STILL on Sepolia
        bytes[] memory sigsReplay = _twoSigsAscending(PKA, PKC, digestReplay);

        // now flip the live chain -- what a cross-chain relay of this exact verdict+signature would look like.
        vm.chainId(MAINNET);
        vm.expectRevert(O5AttesterBase.EscrowVerdictMismatch.selector);
        xAtt.attestO5(vReplay, xEscrow, sigsReplay);
        // EXACT constraint: O5AttesterBase.sol:274-276 recomputes
        // `computeSettlementUnitId(block.chainid, escrow, ...)` with the LIVE chainid (now MAINNET) and
        // requires equality with `v.settlementUnitId` (which encodes SEPOLIA) -- BEFORE `_verifySignatures`
        // is even reached (O5AttesterBase.sol:283), so a valid quorum signature cannot rescue this.

        // ── positive companion: the IDENTICAL verdict + IDENTICAL signatures, resubmitted at the chain
        //    they were actually produced for, succeed -- proving the signature was valid all along and the
        //    chain context was the sole deciding factor. ──
        vm.chainId(SEPOLIA);
        bytes32 assertionId2 = xAtt.attestO5(vReplay, xEscrow, sigsReplay);
        assertTrue(assertionId2 != bytes32(0), "the SAME verdict+signatures succeed once the chain matches again");
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // TEST 4 -- RELEASE-PATH RE-CHECK, REFUND SIDE (a code path distinct from test 2's finalize/release)
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_04_ReclaimAfterDeadline_RefundBlockedCrossChain_RuntimeDomainMismatch() public {
        // `reclaimAfterDeadline` (VNextSettlementEscrow.sol:1730-1735) drives the REFUND branch of the same
        // allocator gate that test 2 exercised on the RELEASE branch, via a DIFFERENT public entry point,
        // and needs no evidence/assertion machinery at all -- just FUNDED_ACTIVE, past its own reclaimAt.
        vm.chainId(SEPOLIA);
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(500e6, 0, 0, 1);
        VNextSettlementEscrow e = _fundedEscrow(JOB, 2, cfgs);
        bytes32 id = _unitId(e);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.FUNDED_ACTIVE));

        uint256 reclaimAt = e.reclaimAtOf(id);
        vm.warp(reclaimAt);

        vm.chainId(MAINNET);
        vm.expectRevert(VNextSettlementEscrow.RuntimeDomainMismatch.selector);
        e.reclaimAfterDeadline(id);
        // EXACT constraint: `_assertRuntimeDomain` (VNextSettlementEscrow.sol:1163-1167), called from
        // `_allocateRefund` (:1271) which `reclaimAfterDeadline` calls directly (:1734).

        // positive companion: same unit, same deadline, correct chain -- refund proceeds normally.
        vm.chainId(SEPOLIA);
        uint256 payerBefore = usdc.balanceOf(payer);
        e.reclaimAfterDeadline(id);
        assertEq(uint256(e.unitState(id)), uint256(UnitState.SETTLED_REFUNDED));
        assertEq(usdc.balanceOf(payer), payerBefore + 500e6);
    }

    // ══════════════════════════════════════════════════════════════════════════════════════════════
    // TEST 5 -- BONUS (beyond the 4 requested): the FUNDING acceptance signature is itself chain-bound
    // ══════════════════════════════════════════════════════════════════════════════════════════════

    function test_05_BONUS_FundingAcceptanceSignature_ChainBound_RejectedCrossChain() public {
        // `JOB_POLICY_TYPEHASH`'s first field is `uint256 chainId` (VNextSettlementLib.sol:150-152), and
        // `_hashJobPolicy` populates it with LIVE block.chainid (VNextSettlementEscrowFactory.sol:286) --
        // so cross-chain protection starts even earlier than settlement: FUNDING itself with a
        // chain-A-signed acceptance is rejected on chain B.
        vm.chainId(SEPOLIA);
        VNextSettlementEscrow.UnitConfig[] memory cfgs = _oneUnitConfig(200e6, 0, 0, 1);
        VNextSettlementEscrow e = _escrowFor(JOB, 3, cfgs); // create only -- do not fund yet
        VNextSettlementEscrow.PolicyAcceptance memory acc = _acceptance(e, cfgs); // operatorSignature signed for SEPOLIA's domain

        vm.chainId(MAINNET);
        vm.prank(payer);
        vm.expectRevert(VNextSettlementEscrowFactory.BadOperatorSignature.selector);
        e.fund(cfgs, acc);
        // EXACT constraint: `VNextSettlementEscrowFactory.acceptPolicy` (:243) recomputes the JobPolicyHash
        // digest with LIVE block.chainid (now MAINNET) via `_hashJobPolicy` (:275-300) and
        // `_domainSeparator` (:304-314, also chainid-bound) and requires `operatorSignature` to validate
        // against it -- a signature produced for SEPOLIA's digest does not.

        // positive companion: the SAME acceptance, submitted back on the chain it was actually signed for,
        // funds cleanly.
        vm.chainId(SEPOLIA);
        vm.prank(payer);
        e.fund(cfgs, acc);
        assertEq(uint256(e.unitState(_unitId(e))), uint256(UnitState.FUNDED_ACTIVE));
    }
}
