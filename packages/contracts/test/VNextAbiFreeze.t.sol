// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {VNextSettlementEscrow} from "../src/VNextSettlementEscrow.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {
    ClaimClass,
    PayoutEntry,
    PolicyIdentity,
    UnitState,
    VNextSettlementLib
} from "../src/libraries/VNextSettlementLib.sol";
import {MockToken, MockOracleAttester} from "./VNextSettlementEscrow.t.sol";

/**
 * @title VNextAbiFreezeTest
 * @notice Freezes the V-next settlement ABI for off-chain compilers (reconciliation ledger R14).
 *         The byte contract is `docs/VNEXT_SETTLEMENT_ABI.md`.
 *
 *         Every `GOLDEN_*` literal below was computed OUTSIDE this repo's code, by a clean-room
 *         implementation (pure Python stdlib: its own Keccak-256 and ABI encoder) that read only the doc.
 *         The same literals are pinned against the public TS compiler (`packages/contracts/ts/vnext`,
 *         `ts/__tests__/vnext-compiler.test.ts`), so passing both suites means the doc, the TS compiler
 *         and these contracts agree byte for byte.
 *
 *         What this proves, and against what:
 *         1. The domain constants and the input types are frozen: the Lib constants and 16 function
 *            selectors equal the literals. A selector covers the full nested struct tuple type.
 *         2. END TO END on the real contracts: a factory deployed at the pinned address predicts and
 *            creates the pinned escrow. That escrow accepts `fund()` carrying payer and operator
 *            signatures over the INDEPENDENTLY COMPUTED digest, sent by a relayer so both signatures
 *            are checked. It then reads back the pinned pre-policy root, JobPolicy hash, units root,
 *            unit ids, fee-schedule hashes, payout-config hashes and evidence commitment.
 *         3. The negative (R14): a config that differs from the committed one by ONE byte is rejected
 *            (`PolicyRootMismatch`), and a changed signed field voids both signatures.
 *
 *         Re-pin only under the doc's §9: recompute with an implementation other than these contracts,
 *         never by copying forge output back into this file.
 */
contract VNextAbiFreezeTest is Test {
    // ── golden inputs (doc §8) ──────────────────────────────────────────────────────────────────
    uint256 internal constant CHAIN_ID = 8453;
    uint256 internal constant FUNDING_TIME = 1_800_000_000;
    uint256 internal constant EXPIRY = 1_900_000_000;
    uint256 internal constant POLICY_NONCE = 7;
    address internal constant FACTORY_DEPLOYER = address(0xD1);
    /// @dev Well-known anvil test accounts 0 and 1: public keys, used ONLY as golden test signers.
    uint256 internal constant PAYER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant OPERATOR_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    address internal constant PAYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant OPERATOR = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant FEE_DEST = 0x4444444444444444444444444444444444444444;
    address internal constant PAYEE_A = 0x1111111111111111111111111111111111111111;
    address internal constant PAYEE_B = 0x2222222222222222222222222222222222222222;
    address internal constant PAYEE_C = 0x3333333333333333333333333333333333333333;
    address internal constant RELAYER = address(0xBEEF);
    bytes32 internal constant O5_SCHEMA = keccak256("test.o5.schema"); // MockOracleAttester's pinned schema UID

    // ── golden outputs (computed from the doc alone) ────────────────────────────────────────────
    bytes32 constant GOLDEN_SETTLEMENT_UNIT_DOMAIN = 0x2999f23df0b8dc0a4395e01bb071b526a68d659e9834e3952f403a9b7e3b511a;
    bytes32 constant GOLDEN_POLICY_SALT_DOMAIN = 0x9c545f70e44ba4292821022010c5750f92d0a3f2cbf06099ed1eaec2ba2ec8ef;
    bytes32 constant GOLDEN_POLICY_NONCE_DOMAIN = 0x4100c882ff75eaf8d18f6a8be89328b40d631d33d71e71bbe1f469f6f06f7b2c;
    bytes32 constant GOLDEN_EVIDENCE_COMMITMENT_DOMAIN =
        0xae13dc2c47a210d242db75f30fde58d99e336c5c6cfea063b095efadbc5cf5f0;
    bytes32 constant GOLDEN_EIP712_DOMAIN_TYPEHASH = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f;
    bytes32 constant GOLDEN_EIP712_NAME_HASH = 0xe2e457cd120e2826d4315f6af338fb561270850be7d01f8c8d75ee8924c18969;
    bytes32 constant GOLDEN_EIP712_VERSION_HASH = 0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6;
    bytes32 constant GOLDEN_JOB_POLICY_TYPEHASH = 0xda434b1043344df560573b6643eb6441876460071a7660bbe9f73214d62db142;

    bytes32 constant GOLDEN_JOB_ID_HASH = 0xefe464484039d8b2610c0719aa007f2ec19d1b7a3cab39e44b9a2e9b6cc9ad07;
    bytes32 constant GOLDEN_TERMS_HASH = 0x5bd8b6812d7f76d3ac1aecf197e53ad8dac34d43f382762570779cc43d2042bc;
    bytes32 constant GOLDEN_ACCEPTED_POLICY_DIGEST = 0xca2881812de3c0ed41b81d5ae29ea56f6aa4bae1b0b960e79bdd532057ae6430;
    bytes32 constant GOLDEN_STEP_A = 0x012e76b28f24b769f2172713b56b980f5c9a9b24b8c9cb5f41b3cbf6dc136d6d;
    bytes32 constant GOLDEN_STEP_B = 0x2bb8b6d8553474bc66bf364fffa4611181ddc005540fa6385a08c316bcede4f1;
    bytes32 constant GOLDEN_COMPOSITION_ROOT = 0xd3afcdc6d5d44ae571b83908fa7331a73644e2f5f1ec82455e7e60f0f2cde6db;
    bytes32 constant GOLDEN_PACKAGE_DIGEST = 0x85d72263a9d80c5eeecff75b5dd16e4d8cccc6441b7fe3c1c72d613bc1307d39;

    address constant GOLDEN_FACTORY = 0xc5806EA76348d369460284F39E7b65027e6052Ba;
    address constant GOLDEN_IMPLEMENTATION = 0x0448F3d8EFEaEc835E18bccA58539233BAE5a5A6;
    bytes32 constant GOLDEN_INIT_CODE_HASH = 0xba9d6c77ac1a8f5e64b35d8b87228496f1fad0bb189e9688ed7252857b4f0b1a;
    bytes32 constant GOLDEN_PRE_POLICY_ROOT = 0xc715f1c1249e4fb6e7b8bd64593b1eb84f4161d3b601b5a8bfb965de70871222;
    bytes32 constant GOLDEN_SALT = 0x2d1c6150450f10c652a7e59f26f0dd3ad0e39606e1fd071beabbf6f71353a425;
    address constant GOLDEN_ESCROW = 0x4c3c893eF98D67C55f88E7c6F491bb63606d4682;
    bytes32 constant GOLDEN_UNIT_ID_0 = 0x89fdc0545fa70c1557b4773ec4be1ad099c3eba97f62c1b505fa52e2562738a1;
    bytes32 constant GOLDEN_UNIT_ID_1 = 0x8baa29d524fcaa98cb7820ebd653bf3c656720069988de57e6ecec49460d4510;
    bytes32 constant GOLDEN_UNITS_ROOT = 0x59cab750ff6458bb2f54033aa684ab5f8af18671019b73c3ecf2871f4d34d54a;
    bytes32 constant GOLDEN_JOB_POLICY_HASH = 0x9a76ae0d585f1ca8162005f051704b26d7077e5aff6c22b9406c00bda0976b47;
    bytes32 constant GOLDEN_DOMAIN_SEPARATOR = 0xb9653bb57f2627de01133194170d328d16d728b81a7a17c2490d861a4af57880;
    bytes32 constant GOLDEN_DIGEST = 0x70396a1657b195306d333213cb89663fbab819ef9982557a30250e335dd65156;
    bytes32 constant GOLDEN_POLICY_KEY = 0xdbe1329b76f15734ac713883218519118d309989e4405d840ae804ba2615d969;
    bytes32 constant GOLDEN_FEE_SCHEDULE_HASH_0 = 0x258438ded8181cd3430f8ba0afa19e0416f01386c42fe5628a31655f64882d7c;
    bytes32 constant GOLDEN_FEE_SCHEDULE_HASH_1 = 0x197076bc51efdb4e475f7aedc50c0b7927847df52094fb8548a726fa1540b5b7;
    bytes32 constant GOLDEN_PAYOUT_CONFIG_HASH_0 = 0x76a1ace900e1466f058778acc04080011182e02cc61097cb95185c1d02e243a4;
    bytes32 constant GOLDEN_PAYOUT_CONFIG_HASH_1 = 0xe1c96f82e4d08d43719bda865e8f5dd015c2c05393d9193962cc287ea54c3110;
    bytes32 constant GOLDEN_CLAIM_U0_PRINCIPAL_0 = 0x8def2fb8a9c7ad07664aa4cc582436792ed218afb571c1a3688cec5e0b7ee872;
    bytes32 constant GOLDEN_CLAIM_U0_PRINCIPAL_1 = 0x65bb6d604a0cad95371fd60eae5c70513de5c5480a106f847fa2df6dde196ad8;
    bytes32 constant GOLDEN_CLAIM_U0_PRINCIPAL_2 = 0x172fd16edc971a0a44ee3b241973222669ae81021f6ba8de34a16c72d0c3d96d;
    bytes32 constant GOLDEN_CLAIM_U0_FEE = 0xeb8b9fc5b6cc1c0556eb0debfe023150e82eafc69a1a65d673c4ba2b7e367964;
    bytes32 constant GOLDEN_CLAIM_U0_REFUND = 0x4d69ba3166cfe5f97567528fd7a604b8e4eba4d4edba822cf48dea9d0cc1ea67;
    bytes32 constant GOLDEN_CLAIM_U1_PRINCIPAL_0 = 0xe27061a0182573bd4bd244ef44c7451791a976e2eb3c2a6f6921e5e7571f0e2c;
    bytes32 constant GOLDEN_CLAIM_U1_REFUND = 0xa5511656bf6c0c6e96186853618a271f366397bd195c067f79105cdad6a949e9;
    bytes32 constant GOLDEN_EVIDENCE_COMMITMENT_U0 = 0x0c21605cc29c989f04c14b696ca7196fdc208c6483ebf77321ab6cc13b605439;
    uint256 constant GOLDEN_TOTAL_GROSS = 1_000_000_010;
    uint256 constant GOLDEN_ENCODED_CONFIGS_LENGTH = 1280;

    MockToken internal usdc;
    VNextSettlementEscrowFactory internal factory;

    function setUp() public {
        vm.chainId(CHAIN_ID);
        vm.warp(FUNDING_TIME);
        usdc = new MockToken();
        MockOracleAttester oracle = new MockOracleAttester(1);
        MockOracleAttester escalation = new MockOracleAttester(77);
        // The factory is CREATE(FACTORY_DEPLOYER, 0); its constructor deploys the implementation at its nonce 1.
        vm.prank(FACTORY_DEPLOYER);
        factory = new VNextSettlementEscrowFactory(
            address(usdc), address(oracle), address(escalation), O5_SCHEMA, bytes32(0)
        );
    }

    // ── 1. the frozen constants and input types ─────────────────────────────────────────────────

    function test_Freeze_DomainConstants() public pure {
        assertEq(VNextSettlementLib.SETTLEMENT_UNIT_DOMAIN, GOLDEN_SETTLEMENT_UNIT_DOMAIN, "SETTLEMENT_UNIT_DOMAIN");
        assertEq(VNextSettlementLib.POLICY_SALT_DOMAIN, GOLDEN_POLICY_SALT_DOMAIN, "POLICY_SALT_DOMAIN");
        assertEq(VNextSettlementLib.POLICY_NONCE_DOMAIN, GOLDEN_POLICY_NONCE_DOMAIN, "POLICY_NONCE_DOMAIN");
        assertEq(
            VNextSettlementLib.EVIDENCE_COMMITMENT_DOMAIN, GOLDEN_EVIDENCE_COMMITMENT_DOMAIN, "EVIDENCE_COMMITMENT_DOMAIN"
        );
        assertEq(VNextSettlementLib.EIP712_DOMAIN_TYPEHASH, GOLDEN_EIP712_DOMAIN_TYPEHASH, "EIP712_DOMAIN_TYPEHASH");
        assertEq(VNextSettlementLib.EIP712_NAME_HASH, GOLDEN_EIP712_NAME_HASH, "EIP712_NAME_HASH");
        assertEq(VNextSettlementLib.EIP712_VERSION_HASH, GOLDEN_EIP712_VERSION_HASH, "EIP712_VERSION_HASH");
        assertEq(VNextSettlementLib.JOB_POLICY_TYPEHASH, GOLDEN_JOB_POLICY_TYPEHASH, "JOB_POLICY_TYPEHASH");
        assertEq(VNextSettlementLib.POLICY_VERSION_V2, 2, "POLICY_VERSION");
        assertEq(uint256(VNextSettlementLib.EVIDENCE_PACKAGE_FORMAT_V1), 1, "EVIDENCE_PACKAGE_FORMAT_V1");
        // doc §1 limits a compiler must refuse against
        assertEq(uint256(VNextSettlementLib.MAX_FEE_BPS), 1000);
        assertEq(VNextSettlementLib.FEE_DENOMINATOR, 10_000);
        assertEq(VNextSettlementLib.MIN_BONDABLE_GROSS, 5);
        assertEq(VNextSettlementLib.MAX_SETTLEMENT_UNITS, 16);
        assertEq(VNextSettlementLib.MAX_PAYOUT_LEGS_PER_UNIT, 16);
        assertEq(VNextSettlementLib.MAX_TOTAL_LEGS_PER_JOB, 256);
        assertEq(VNextSettlementLib.MIN_RECLAIM_DELAY, 864_000);
        assertEq(VNextSettlementLib.MAX_RECLAIM_DELAY, 31_536_000);
        assertEq(VNextSettlementLib.MAX_SIGNATURE_BYTES, 1024);
        assertEq(VNextSettlementLib.MAX_CONFIG_BYTES, 26_372);
    }

    /// @dev A selector hashes the function name AND its complete parameter types, nested struct tuples
    ///      included, so these pins freeze the input ABI that compilers encode against (doc §7).
    function test_Freeze_Selectors() public pure {
        assertEq(VNextSettlementEscrowFactory.createEscrow.selector, bytes4(0x886deb02), "createEscrow");
        assertEq(VNextSettlementEscrowFactory.predictEscrow.selector, bytes4(0xa5b0de55), "predictEscrow");
        assertEq(VNextSettlementEscrowFactory.saltOf.selector, bytes4(0xb9f0389f), "saltOf");
        assertEq(VNextSettlementEscrowFactory.policyKey.selector, bytes4(0x68fe3ce4), "policyKey");
        assertEq(VNextSettlementEscrowFactory.revokePolicy.selector, bytes4(0xd4a3d9af), "revokePolicy");
        assertEq(VNextSettlementEscrow.fund.selector, bytes4(0x7976bcc7), "fund");
        assertEq(VNextSettlementEscrow.policy.selector, bytes4(0x0505c8c9), "policy");
        assertEq(VNextSettlementEscrow.unitState.selector, bytes4(0x4ea93b0c), "unitState");
        assertEq(VNextSettlementEscrow.unitCount.selector, bytes4(0xf584fbf6), "unitCount");
        assertEq(VNextSettlementEscrow.unitIdAt.selector, bytes4(0x57853e8e), "unitIdAt");
        assertEq(VNextSettlementEscrow.unitTerms.selector, bytes4(0x2ad489ed), "unitTerms");
        assertEq(VNextSettlementEscrow.feeScheduleHashOf.selector, bytes4(0xee274758), "feeScheduleHashOf");
        assertEq(VNextSettlementEscrow.payoutAt.selector, bytes4(0x1e7d162f), "payoutAt");
        assertEq(VNextSettlementEscrow.finalize.selector, bytes4(0x92584d80), "finalize");
        assertEq(VNextSettlementEscrow.reclaimAfterDeadline.selector, bytes4(0xb3f8fa4a), "reclaimAfterDeadline");
        assertEq(VNextSettlementEscrow.dischargeClaim.selector, bytes4(0xb409a86d), "dischargeClaim");
    }

    /// @dev The golden inputs themselves, hashed here from their doc §8 preimages.
    function test_Freeze_GoldenInputs() public pure {
        assertEq(keccak256("pcc:vnext:golden:job"), GOLDEN_JOB_ID_HASH);
        assertEq(keccak256("pcc:vnext:golden:terms"), GOLDEN_TERMS_HASH);
        assertEq(keccak256("pcc:vnext:golden:accepted-policy"), GOLDEN_ACCEPTED_POLICY_DIGEST);
        assertEq(keccak256("pcc:vnext:golden:step-a"), GOLDEN_STEP_A);
        assertEq(keccak256("pcc:vnext:golden:step-b"), GOLDEN_STEP_B);
        assertEq(keccak256("pcc:vnext:golden:composition-root"), GOLDEN_COMPOSITION_ROOT);
        assertEq(keccak256("pcc:vnext:golden:evidence-package"), GOLDEN_PACKAGE_DIGEST);
        assertEq(vm.addr(PAYER_PK), PAYER, "payer key");
        assertEq(vm.addr(OPERATOR_PK), OPERATOR, "operator key");
    }

    // ── 2. the golden job, end to end on the real contracts ────────────────────────────────────

    function test_Freeze_GoldenJob_EndToEnd() public {
        _assertDeployment();
        VNextSettlementEscrow e = _createGoldenEscrow();

        // Both parties sign the INDEPENDENTLY COMPUTED digest. A relayer funds, so the payer's signature
        // is required and checked too; any drift in unitsRoot / JobPolicy / domain fails the signatures.
        usdc.mint(PAYER, GOLDEN_TOTAL_GROSS);
        vm.recordLogs();
        vm.prank(RELAYER);
        e.fund(_goldenConfigs(), _goldenAcceptance());
        assertEq(_emittedUnitsRoot(), GOLDEN_UNITS_ROOT, "PolicyAccepted.unitsRoot");

        _assertPolicy(e);
        _assertUnits(e);
        assertEq(usdc.balanceOf(address(e)), GOLDEN_TOTAL_GROSS, "fund() pulled exactly the gross");
        assertEq(usdc.balanceOf(PAYER), 0);

        // The evidence commitment the escrow STORES uses its fixed layout label 1 (doc §4).
        vm.prank(OPERATOR);
        e.submitEvidence(GOLDEN_UNIT_ID_0, GOLDEN_PACKAGE_DIGEST);
        assertEq(e.evidenceBundleHashOf(GOLDEN_UNIT_ID_0), GOLDEN_EVIDENCE_COMMITMENT_U0, "stored evidence commitment");
    }

    /// @dev The deployment incarnation the digest binds: factory, implementation, clone init code.
    function _assertDeployment() internal view {
        assertEq(address(factory), GOLDEN_FACTORY, "factory address");
        assertEq(factory.implementation(), GOLDEN_IMPLEMENTATION, "implementation address");
        assertEq(
            keccak256(
                abi.encodePacked(
                    hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
                    GOLDEN_IMPLEMENTATION,
                    hex"5af43d82803e903d91602b57fd5bf3"
                )
            ),
            GOLDEN_INIT_CODE_HASH,
            "EIP-1167 init code hash"
        );
    }

    /// @dev Encode, predict and create. The identity carries the LITERAL root, so `fund()` itself checks the
    ///      independently computed value against the configs it is given.
    function _createGoldenEscrow() internal returns (VNextSettlementEscrow e) {
        bytes memory encoded = abi.encode(_goldenConfigs());
        assertEq(encoded.length, GOLDEN_ENCODED_CONFIGS_LENGTH, "abi.encode(configs) length");
        assertEq(keccak256(encoded), GOLDEN_PRE_POLICY_ROOT, "prePolicyRoot");

        PolicyIdentity memory id = _goldenIdentity();
        assertEq(factory.saltOf(id), GOLDEN_SALT, "CREATE2 salt");
        assertEq(factory.predictEscrow(id), GOLDEN_ESCROW, "predicted escrow");
        assertEq(factory.policyKey(PAYER, OPERATOR, GOLDEN_JOB_ID_HASH), GOLDEN_POLICY_KEY, "policy key");

        e = VNextSettlementEscrow(factory.createEscrow(id));
        assertEq(address(e), GOLDEN_ESCROW, "created escrow");
    }

    function _assertPolicy(VNextSettlementEscrow e) internal view {
        (address operator_, uint256 nonce_, bytes32 preRoot_, bytes32 policyHash_, bytes32 acceptedDigest_) =
            e.policy();
        assertEq(operator_, OPERATOR);
        assertEq(nonce_, POLICY_NONCE);
        assertEq(preRoot_, GOLDEN_PRE_POLICY_ROOT, "stored prePolicyRoot");
        assertEq(policyHash_, GOLDEN_JOB_POLICY_HASH, "stored JobPolicy hash");
        assertEq(acceptedDigest_, GOLDEN_ACCEPTED_POLICY_DIGEST);
        assertEq(
            keccak256(abi.encodePacked("\x19\x01", GOLDEN_DOMAIN_SEPARATOR, GOLDEN_JOB_POLICY_HASH)),
            GOLDEN_DIGEST,
            "digest == 0x1901 || domainSeparator || jobPolicyHash"
        );
    }

    function _assertUnits(VNextSettlementEscrow e) internal view {
        assertEq(e.unitCount(), 2);
        assertEq(e.unitIdAt(0), GOLDEN_UNIT_ID_0, "unit id 0");
        assertEq(e.unitIdAt(1), GOLDEN_UNIT_ID_1, "unit id 1");
        assertEq(e.feeScheduleHashOf(GOLDEN_UNIT_ID_0), GOLDEN_FEE_SCHEDULE_HASH_0, "fee schedule 0");
        assertEq(e.feeScheduleHashOf(GOLDEN_UNIT_ID_1), GOLDEN_FEE_SCHEDULE_HASH_1, "fee schedule 1");
        (,,,, bytes32 payoutHash0,,) = e.unitTerms(GOLDEN_UNIT_ID_0);
        assertEq(payoutHash0, GOLDEN_PAYOUT_CONFIG_HASH_0, "payout config 0");
        (,,,, bytes32 payoutHash1,,) = e.unitTerms(GOLDEN_UNIT_ID_1);
        assertEq(payoutHash1, GOLDEN_PAYOUT_CONFIG_HASH_1, "payout config 1");
        assertEq(uint256(e.unitState(GOLDEN_UNIT_ID_0)), uint256(UnitState.FUNDED_ACTIVE));
        assertEq(uint256(e.unitState(GOLDEN_UNIT_ID_1)), uint256(UnitState.FUNDED_ACTIVE));
    }

    function test_Freeze_ClaimIdsAndEvidenceCommitment() public pure {
        assertEq(_claim(GOLDEN_UNIT_ID_0, 0, ClaimClass.PRINCIPAL), GOLDEN_CLAIM_U0_PRINCIPAL_0);
        assertEq(_claim(GOLDEN_UNIT_ID_0, 1, ClaimClass.PRINCIPAL), GOLDEN_CLAIM_U0_PRINCIPAL_1);
        assertEq(_claim(GOLDEN_UNIT_ID_0, 2, ClaimClass.PRINCIPAL), GOLDEN_CLAIM_U0_PRINCIPAL_2);
        assertEq(_claim(GOLDEN_UNIT_ID_0, VNextSettlementLib.FEE_LEG_INDEX, ClaimClass.FEE), GOLDEN_CLAIM_U0_FEE);
        assertEq(_claim(GOLDEN_UNIT_ID_0, VNextSettlementLib.REFUND_LEG_INDEX, ClaimClass.REFUND), GOLDEN_CLAIM_U0_REFUND);
        assertEq(_claim(GOLDEN_UNIT_ID_1, 0, ClaimClass.PRINCIPAL), GOLDEN_CLAIM_U1_PRINCIPAL_0);
        assertEq(_claim(GOLDEN_UNIT_ID_1, VNextSettlementLib.REFUND_LEG_INDEX, ClaimClass.REFUND), GOLDEN_CLAIM_U1_REFUND);
        assertEq(
            VNextSettlementLib.computeEvidenceCommitment(
                CHAIN_ID, GOLDEN_ESCROW, GOLDEN_UNIT_ID_0, 3, VNextSettlementLib.EVIDENCE_PACKAGE_FORMAT_V1, GOLDEN_PACKAGE_DIGEST
            ),
            GOLDEN_EVIDENCE_COMMITMENT_U0
        );
        assertEq(
            VNextSettlementLib.computeSettlementUnitId(CHAIN_ID, GOLDEN_ESCROW, GOLDEN_JOB_ID_HASH, 0, GOLDEN_STEP_A),
            GOLDEN_UNIT_ID_0
        );
    }

    // ── 3. the negatives: one changed byte is rejected ──────────────────────────────────────────

    /// @dev R14's negative: the escrow's address commits to the exact configs (prePolicyRoot is in the CREATE2
    ///      salt), so funding it with configs that differ by ONE byte must revert `PolicyRootMismatch`. Each
    ///      mutation keeps every per-unit rule valid, so the root check is the only thing that can fire. The
    ///      golden configs still fund afterwards: the failed attempts consumed nothing.
    function test_Freeze_OneConfigByteChanged_IsRejected() public {
        VNextSettlementEscrow e = VNextSettlementEscrow(factory.createEscrow(_goldenIdentity()));
        VNextSettlementEscrow.PolicyAcceptance memory acc = _goldenAcceptance();
        usdc.mint(PAYER, GOLDEN_TOTAL_GROSS);

        for (uint256 m; m < 5; ++m) {
            VNextSettlementEscrow.UnitConfig[] memory c = _goldenConfigs();
            if (m == 0) c[0].reclaimAt += 1;
            else if (m == 1) c[0].payouts[2].recipient = 0x3333333333333333333333333333333333333332;
            else if (m == 2) c[0].compositionRoot = bytes32(uint256(GOLDEN_COMPOSITION_ROOT) ^ 1);
            else if (m == 3) c[1].milestoneIndex += 1;
            else (c[0], c[1]) = (c[1], c[0]); // the same units in the other order
            vm.expectRevert(VNextSettlementEscrow.PolicyRootMismatch.selector);
            vm.prank(RELAYER);
            e.fund(c, acc);
        }

        vm.prank(RELAYER);
        e.fund(_goldenConfigs(), acc);
        assertEq(usdc.balanceOf(address(e)), GOLDEN_TOTAL_GROSS);
    }

    /// @dev A changed SIGNED field voids the signatures: the escrow recomputes the digest from its own identity,
    ///      the funded configs and the supplied expiry. The payer leg is checked first when a relayer funds;
    ///      the operator leg alone when the payer funds directly.
    function test_Freeze_OneSignedFieldChanged_IsRejected() public {
        VNextSettlementEscrow e = VNextSettlementEscrow(factory.createEscrow(_goldenIdentity()));
        VNextSettlementEscrow.UnitConfig[] memory configs = _goldenConfigs();
        usdc.mint(PAYER, GOLDEN_TOTAL_GROSS);

        VNextSettlementEscrow.PolicyAcceptance memory acc = _goldenAcceptance();
        acc.expiry = EXPIRY + 1; // signed over EXPIRY
        vm.expectRevert(VNextSettlementEscrowFactory.BadSignature.selector);
        vm.prank(RELAYER);
        e.fund(configs, acc);

        acc = _goldenAcceptance();
        acc.payerSignature = "";
        acc.operatorSignature = _sign(OPERATOR_PK, bytes32(uint256(GOLDEN_DIGEST) ^ 1));
        vm.expectRevert(VNextSettlementEscrowFactory.BadOperatorSignature.selector);
        vm.prank(PAYER);
        e.fund(configs, acc);

        vm.prank(RELAYER);
        e.fund(configs, _goldenAcceptance());
        assertEq(usdc.balanceOf(address(e)), GOLDEN_TOTAL_GROSS);
    }

    // ── fixtures ────────────────────────────────────────────────────────────────────────────────

    function _goldenConfigs() internal pure returns (VNextSettlementEscrow.UnitConfig[] memory c) {
        c = new VNextSettlementEscrow.UnitConfig[](2);
        PayoutEntry[] memory p0 = new PayoutEntry[](3);
        p0[0] = PayoutEntry({recipient: PAYEE_A, amount: 500_000_000});
        p0[1] = PayoutEntry({recipient: PAYEE_B, amount: 300_000_000});
        p0[2] = PayoutEntry({recipient: PAYEE_C, amount: 176_500_003});
        c[0] = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: 0,
            stepId: GOLDEN_STEP_A,
            requiredTier: 2,
            requestedTier: 2,
            g: 1_000_000_003,
            f: 23_500_000,
            n: 976_500_003,
            feeBps: 235,
            feeRecipient: FEE_DEST,
            reclaimAt: FUNDING_TIME + 30 days,
            compositionSchemaVersion: 3,
            compositionRoot: GOLDEN_COMPOSITION_ROOT,
            payouts: p0
        });
        PayoutEntry[] memory p1 = new PayoutEntry[](1);
        p1[0] = PayoutEntry({recipient: PAYEE_A, amount: 7});
        c[1] = VNextSettlementEscrow.UnitConfig({
            milestoneIndex: 0x0102030405060708090a0b0c0d0e0f10, // above 2^53
            stepId: GOLDEN_STEP_B,
            requiredTier: 0,
            requestedTier: 0,
            g: 7,
            f: 0,
            n: 7,
            feeBps: 0,
            feeRecipient: address(0),
            reclaimAt: FUNDING_TIME + 365 days, // exactly MAX_RECLAIM_DELAY
            compositionSchemaVersion: 0,
            compositionRoot: bytes32(0),
            payouts: p1
        });
    }

    function _goldenIdentity() internal pure returns (PolicyIdentity memory) {
        return PolicyIdentity({
            payer: PAYER,
            operator: OPERATOR,
            jobIdHash: GOLDEN_JOB_ID_HASH,
            termsHash: GOLDEN_TERMS_HASH,
            policyNonce: POLICY_NONCE,
            prePolicyRoot: GOLDEN_PRE_POLICY_ROOT,
            acceptedPolicyDigest: GOLDEN_ACCEPTED_POLICY_DIGEST
        });
    }

    function _goldenAcceptance() internal pure returns (VNextSettlementEscrow.PolicyAcceptance memory) {
        return VNextSettlementEscrow.PolicyAcceptance({
            expiry: EXPIRY,
            payerSignature: _sign(PAYER_PK, GOLDEN_DIGEST),
            operatorSignature: _sign(OPERATOR_PK, GOLDEN_DIGEST)
        });
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _claim(bytes32 unitId, uint256 legIndex, ClaimClass cls) internal pure returns (bytes32) {
        return VNextSettlementLib.computeClaimId(CHAIN_ID, GOLDEN_ESCROW, unitId, legIndex, cls);
    }

    /// @dev `PolicyAccepted(bytes32 indexed jobPolicyHash, address indexed payer, address indexed operator,
    ///      uint256 policyNonce, bytes32 unitsRoot)`: the units root is the second data word.
    function _emittedUnitsRoot() internal returns (bytes32 unitsRoot) {
        bytes32 topic = keccak256("PolicyAccepted(bytes32,address,address,uint256,bytes32)");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) {
                assertEq(logs[i].topics[1], GOLDEN_JOB_POLICY_HASH, "PolicyAccepted.jobPolicyHash");
                (, unitsRoot) = abi.decode(logs[i].data, (uint256, bytes32));
                return unitsRoot;
            }
        }
        revert("PolicyAccepted was not emitted");
    }
}
