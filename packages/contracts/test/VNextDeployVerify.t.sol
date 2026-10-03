// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DeployVNextSettlement} from "../script/DeployVNextSettlement.s.sol";
import {VNextDeploySpec} from "../script/vnext/VNextDeploySpec.sol";
import {VNextSettlementEscrowFactory} from "../src/VNextSettlementEscrowFactory.sol";
import {SingleSignerO5Attester} from "../src/attesters/SingleSignerO5Attester.sol";

/**
 * @title VNextDeployVerifyTest
 * @notice N38 (LO-ES-2, astra H7) repro: `verify(address)` must prove the on-chain factory IS the
 *         CREATE2 output of THIS BUILD for its own read-back inputs, not merely something that LOOKS
 *         like it (same runtime length, same library link sites, getters that answer consistently).
 *
 *         THE GAP. `_verify` never re-derives the factory's OWN address. It reads the implementation
 *         back as `CREATE(factory, 1)` and checks the IMPLEMENTATION's runtime length + library link
 *         sites, but the FACTORY address itself is taken on faith from the caller. A factory that is
 *         NOT this build's CREATE2 output for its own read-back inputs — different code, OR THE SAME
 *         code at a non-spec salt — passes `verify()` regardless, as long as the implementation it
 *         built has the same runtime length, the same 3 library call sites, and getters that answer
 *         consistently.
 *
 *         THE REPRO CHOSEN HERE: same salt-TAG inputs, SAME genuine unmodified creationCode, SAME
 *         constructor args — but deployed at a salt that is NOT
 *         `VNextDeploySpec.contractSalt(CANONICAL, chainid, TAG_FACTORY, "")` (the "spec" salt for a
 *         canonical factory with these inputs). This is one of the two sub-cases the N38 fix's own
 *         revert message names: "different code OR a non-spec salt". It is deliberately preferred here
 *         over byte-patching the factory's trailing CBOR metadata (the brief's suggested primary
 *         mutation) for a reason specific to this TEST HARNESS, not to the on-chain property:
 *
 *         WHY NOT A PATCHED-METADATA BYTE. Empirically (see the investigation that produced this file),
 *         `forge test --no-dynamic-test-linking` appears to recognize `VNextSettlementEscrowFactory` as
 *         a KNOWN compiled artifact for the purpose of resolving the embedded `VNextSettlementLib`
 *         external-library reference, and that recognition is sensitive to the EXACT bytes of
 *         `type(VNextSettlementEscrowFactory).creationCode` — flipping even one byte deep inside the
 *         trailing CBOR metadata (verified: the ipfs-hash bytes, the solc-version bytes, and the very
 *         last length byte were all tried) made the harness fail to link the EMBEDDED escrow's copy of
 *         `VNextSettlementLib`, so the nested `new VNextSettlementEscrow(...)` reverted
 *         `LinkedLibraryMismatch()` (selector `0xf63f1ccf`, confirmed via `cast sig`) — a TEST-HARNESS
 *         artifact of the patch, not a real on-chain consequence (a byte in dead trailing metadata is
 *         never executed; a REAL chain would deploy and run it identically to the unpatched build). A
 *         control test deploying the fully UNMODIFIED factory creationCode TWICE, at two different
 *         salts, in one test, succeeded cleanly — ruling out "deploying twice" as the cause and
 *         confirming the harness's linker is what's sensitive to the patched bytes specifically.
 *         Switching to a non-spec SALT (zero bytes of the factory's creationCode touched) sidesteps this
 *         entirely while proving the identical property: a factory built from 100% genuine, recognized,
 *         correctly-functioning code — same length, same 3 link sites, byte-identical modulo the
 *         `factory` immutable baked into the implementation — still passes `verify()` today even though
 *         it sits at an address `_verify` never checks against the one THIS build's spec would produce.
 *
 * @dev    THE TEST PITFALL THIS FILE AVOIDS. `new X{salt: s}(...)` inside a forge TEST deploys FROM THE
 *         TEST CONTRACT, never through the canonical deterministic-deployment proxy
 *         (`VNextDeploySpec.CREATE2_DEPLOYER`) that `VNextDeploySpec.create2Address` assumes as the
 *         CREATE2 sender — that routing only happens for a `forge script` BROADCAST. `_deployViaProxy`
 *         below etches a minimal, semantically-identical CREATE2 shim at that address if the local test
 *         chain does not already have one (empirically, forge's own test backend already provides one,
 *         labeled "Create2Deployer" in traces, so the shim is unused in practice but kept as a documented
 *         fallback), then calls it with `salt ++ initcode` exactly as the real proxy is called — so every
 *         address this file computes is reachable the same way `VNextDeploySpec.create2Address` predicts
 *         it.
 *
 *         Chain id 31337 (forge's default) is neither Base nor Base Sepolia, so GATE 3/GATE 4's pins
 *         cannot be checked against a canonical token/registry; `VNEXT_ALLOW_UNKNOWN_CHAIN=1` is the
 *         documented, deliberate opt-in for exactly this case (see `_unknownChainAllowed`). Both tests
 *         in this file set it to the SAME value, so unlike `VNextDeployGatesTest`'s toggle tests there is
 *         no cross-test race on the shared host environment forge runs a suite's tests against.
 */
contract VNextDeployVerifyTest is Test {
    address internal constant SIGNER_P = address(0x9001);
    address internal constant REVOKER_P = address(0x9002);
    address internal constant SIGNER_E = address(0x9003);
    address internal constant REVOKER_E = address(0x9004);
    address internal constant EAS_ADDR = address(0x9EA5);
    address internal constant USDC_ADDR = address(0x90DC);
    bytes32 internal constant SCHEMA = keccak256("vnext.verify-repro.schema");
    uint64 internal constant PRIMARY_COHORT = 1;
    uint64 internal constant ESCALATION_COHORT = 2;

    /// @dev Deliberately NOT `VNextDeploySpec.contractSalt(CANONICAL, chainid, TAG_FACTORY, "")` — any
    ///      salt other than the real spec salt demonstrates the gap; this one is simply unmistakable.
    bytes32 internal constant NON_SPEC_SALT = keccak256("N38-repro: not this build's spec salt for these inputs");

    /// @dev M1 (astra pack-410 Q2): the lead's exact mixed-band value — escalation in the PROVISIONAL
    ///      band while the primary (`PRIMARY_COHORT` above) stays canonical.
    uint64 internal constant ESCALATION_COHORT_MIXED_PROVISIONAL = 0xF000000000000002;

    /// @dev M2 (astra pack-410 Q4): distinct, clearly-in-band provisional cohort ids.
    uint64 internal constant PRIMARY_COHORT_PROVISIONAL = VNextDeploySpec.PROVISIONAL_COHORT_FLOOR + 1;
    uint64 internal constant ESCALATION_COHORT_PROVISIONAL = VNextDeploySpec.PROVISIONAL_COHORT_FLOOR + 2;
    string internal constant REVIEW_LABEL = "review-test";

    DeployVNextSettlement internal dvs;

    function setUp() public {
        vm.chainId(31337); // forge's default local test chain: neither Base nor Base Sepolia
        vm.etch(USDC_ADDR, hex"60006000fd"); // non-empty, never executed - just needs code.length > 0
        // VerifyHarness (below), not `vm.setEnv("VNEXT_ALLOW_UNKNOWN_CHAIN", "1")`: forge runs a FULL
        // `forge test` invocation's suites in PARALLEL against one shared host environment, and
        // VNextDeployGatesTest/VNextDeployRecordTest's own tests deliberately toggle this exact variable
        // between "0" and "1" while running — confirmed by running this file as part of the full suite,
        // where `vm.setEnv` here raced and failed intermittently. Moving the flag into EVM state (a
        // `virtual` override, the established pattern in this codebase for this exact hazard) is isolated
        // per test and cannot race with anything.
        dvs = new VerifyHarness();
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                  STACK CONSTRUCTION (shared)
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Deploys the two cohorts through the proxy at the CANONICAL salts the real script would use,
    ///      and returns everything needed to deploy a factory at the canonical spec salt (or any other
    ///      salt) with the real, read-back-shaped constructor args.
    function _buildCohorts()
        internal
        returns (address primary, address escalation, bytes32 specFactorySalt, bytes memory ctorArgs)
    {
        bytes32 primarySalt = VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_CANONICAL, block.chainid, VNextDeploySpec.TAG_PRIMARY_ATTESTER, ""
        );
        primary = _deployViaProxy(
            primarySalt,
            abi.encodePacked(
                type(SingleSignerO5Attester).creationCode,
                abi.encode(SIGNER_P, EAS_ADDR, SCHEMA, PRIMARY_COHORT, REVOKER_P)
            )
        );

        bytes32 escalationSalt = VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_CANONICAL, block.chainid, VNextDeploySpec.TAG_ESCALATION_ATTESTER, ""
        );
        escalation = _deployViaProxy(
            escalationSalt,
            abi.encodePacked(
                type(SingleSignerO5Attester).creationCode,
                abi.encode(SIGNER_E, EAS_ADDR, SCHEMA, ESCALATION_COHORT, REVOKER_E)
            )
        );

        bytes32 typeHash = SingleSignerO5Attester(primary).o5TypeHash();
        ctorArgs = abi.encode(USDC_ADDR, primary, escalation, SCHEMA, typeHash);
        specFactorySalt =
            VNextDeploySpec.contractSalt(VNextDeploySpec.MODE_CANONICAL, block.chainid, VNextDeploySpec.TAG_FACTORY, "");
    }

    /// @dev M2 (astra pack-410 Q4): the provisional-mode mirror of {_buildCohorts} — same proxy helper,
    ///      provisional-band cohort ids, and PROVISIONAL-mode salts (primary attester, escalation
    ///      attester, factory) all under the given label, exactly as `provisional()` would produce for
    ///      `VNEXT_LABEL=<label>`.
    function _buildProvisionalCohorts(string memory label)
        internal
        returns (address primary, address escalation, bytes32 factorySalt, bytes memory ctorArgs)
    {
        bytes32 primarySalt = VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_PROVISIONAL, block.chainid, VNextDeploySpec.TAG_PRIMARY_ATTESTER, label
        );
        primary = _deployViaProxy(
            primarySalt,
            abi.encodePacked(
                type(SingleSignerO5Attester).creationCode,
                abi.encode(SIGNER_P, EAS_ADDR, SCHEMA, PRIMARY_COHORT_PROVISIONAL, REVOKER_P)
            )
        );

        bytes32 escalationSalt = VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_PROVISIONAL, block.chainid, VNextDeploySpec.TAG_ESCALATION_ATTESTER, label
        );
        escalation = _deployViaProxy(
            escalationSalt,
            abi.encodePacked(
                type(SingleSignerO5Attester).creationCode,
                abi.encode(SIGNER_E, EAS_ADDR, SCHEMA, ESCALATION_COHORT_PROVISIONAL, REVOKER_E)
            )
        );

        bytes32 typeHash = SingleSignerO5Attester(primary).o5TypeHash();
        ctorArgs = abi.encode(USDC_ADDR, primary, escalation, SCHEMA, typeHash);
        factorySalt = VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_PROVISIONAL, block.chainid, VNextDeploySpec.TAG_FACTORY, label
        );
    }

    /// @dev Etches a minimal CREATE2 shim at `VNextDeploySpec.CREATE2_DEPLOYER` if the local test chain
    ///      does not already have one, then deploys THROUGH it (never via a direct `new{salt}`, which
    ///      inside a test would deploy from this contract instead — see the file-level doc). Asserts the
    ///      result lands exactly where `VNextDeploySpec.create2Address` predicts, so every address this
    ///      file produces is reachable the same way the real script's predictions are.
    function _deployViaProxy(bytes32 salt, bytes memory initcode) internal returns (address deployed) {
        address proxy = VNextDeploySpec.CREATE2_DEPLOYER;
        if (proxy.code.length == 0) {
            vm.etch(proxy, type(TestCreate2Proxy).runtimeCode);
        }
        (bool ok, bytes memory ret) = proxy.call(abi.encodePacked(salt, initcode));
        require(ok, "test proxy: CREATE2 deployment failed");
        require(ret.length == 20, "test proxy: did not return a 20-byte address");
        deployed = address(bytes20(ret));
        require(deployed.code.length > 0, "test proxy: nothing deployed at the returned address");
        address predicted = VNextDeploySpec.create2Address(salt, keccak256(initcode));
        require(deployed == predicted, "test proxy: deployed address disagrees with VNextDeploySpec.create2Address");
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                      1. THE POSITIVE CONTROL
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice An honestly-deployed factory — this build's unmodified creationCode, the canonical SPEC
    ///         salt, read-back constructor args — must pass `verify()`. Pins the happy path so the repro
    ///         test below is read against a baseline that is known to work.
    function test_PositiveControl_HonestFactory_VerifyPasses() public {
        (,, bytes32 specFactorySalt, bytes memory ctorArgs) = _buildCohorts();
        address honestFactory = _deployViaProxy(
            specFactorySalt, abi.encodePacked(type(VNextSettlementEscrowFactory).creationCode, ctorArgs)
        );

        try dvs.verify(honestFactory) returns (DeployVNextSettlement.Tuple memory t) {
            assertEq(t.factory, honestFactory, "returned tuple names a different factory");
        } catch Error(string memory reason) {
            fail(string.concat("positive control: verify() reverted on an honestly-deployed factory: ", reason));
        }
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                      2. THE REPRO
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice THE GAP. Same genuine, unmodified factory creationCode, same constructor args — deployed
    ///         at a salt that is NOT this build's spec salt for these inputs. The implementation it
    ///         builds has the same runtime length and the same 3 library link sites as a genuine deploy
    ///         (it differs from the honest implementation only in the `factory` immutable baked into its
    ///         runtime, which `_verify` never compares against anything). `verify()` on this factory's
    ///         address must revert. On unmodified master it does not: this assertion FAILS there, which
    ///         is the reproduction. After the N38 fix it passes.
    function test_Repro_FactoryAtNonSpecSalt_VerifyMustRevert() public {
        (,, bytes32 specFactorySalt, bytes memory ctorArgs) = _buildCohorts();
        bytes memory honestCode = type(VNextSettlementEscrowFactory).creationCode;

        address specFactory = _deployViaProxy(specFactorySalt, abi.encodePacked(honestCode, ctorArgs));
        address rogueFactory = _deployViaProxy(NON_SPEC_SALT, abi.encodePacked(honestCode, ctorArgs));
        assertTrue(
            rogueFactory != specFactory,
            "a different salt must land at a different CREATE2 address - fixture is wrong if it does not"
        );

        // Sanity: the gap is exactly that the IMPLEMENTATION built off-spec is indistinguishable from
        // the honest one by every check `_verify` runs on it today (same length, same 3 link sites).
        // It is NOT byte-identical: the `factory` immutable baked into each implementation's runtime
        // differs (it equals that implementation's own creator), which is precisely the detail `_verify`
        // never cross-checks against a re-derived expectation.
        address specImpl = VNextSettlementEscrowFactory(specFactory).implementation();
        address rogueImpl = VNextSettlementEscrowFactory(rogueFactory).implementation();
        assertTrue(rogueImpl != specImpl, "sanity: two different factories must build two different implementations");
        assertEq(rogueImpl.code.length, specImpl.code.length, "sanity: implementations should be identical runtime length");

        try dvs.verify(rogueFactory) returns (DeployVNextSettlement.Tuple memory) {
            fail(
                "SECURITY GAP (N38): verify(address) ACCEPTED a factory built from this build's OWN genuine "
                "creationCode and the real read-back constructor args, but deployed at a NON-SPEC salt - "
                "it must revert"
            );
        } catch Error(string memory reason) {
            assertTrue(
                _contains(reason, "not this build's CREATE2 output"),
                string.concat("verify() reverted, but for the wrong reason: ", reason)
            );
        }
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                      3. M1 (astra pack-410 Q2, MEDIUM): MIXED-BAND COHORTS
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice THE LEAD'S REPRO. Primary cohort id `1` (canonical band), escalation cohort id
    ///         `0xF000000000000002` (provisional band), factory at the CANONICAL spec salt. `_verify`
    ///         infers the mode from the primary cohort alone and `_assertCohortSeparation` checks only
    ///         that the two ids are DISTINCT, never that they share a band — so this passed `verify()`
    ///         at `08f24f12`. It must revert.
    function test_M1_MixedBandCohorts_VerifyMustRejectBandMismatch() public {
        bytes32 primarySalt = VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_CANONICAL, block.chainid, VNextDeploySpec.TAG_PRIMARY_ATTESTER, ""
        );
        address primary = _deployViaProxy(
            primarySalt,
            abi.encodePacked(
                type(SingleSignerO5Attester).creationCode,
                abi.encode(SIGNER_P, EAS_ADDR, SCHEMA, PRIMARY_COHORT, REVOKER_P)
            )
        );

        bytes32 escalationSalt = VNextDeploySpec.contractSalt(
            VNextDeploySpec.MODE_CANONICAL, block.chainid, VNextDeploySpec.TAG_ESCALATION_ATTESTER, ""
        );
        address escalation = _deployViaProxy(
            escalationSalt,
            abi.encodePacked(
                type(SingleSignerO5Attester).creationCode,
                abi.encode(SIGNER_E, EAS_ADDR, SCHEMA, ESCALATION_COHORT_MIXED_PROVISIONAL, REVOKER_E)
            )
        );
        assertTrue(
            VNextDeploySpec.isProvisionalCohort(ESCALATION_COHORT_MIXED_PROVISIONAL)
                && !VNextDeploySpec.isProvisionalCohort(PRIMARY_COHORT),
            "fixture is wrong: primary must be canonical-band and escalation provisional-band"
        );

        bytes32 typeHash = SingleSignerO5Attester(primary).o5TypeHash();
        bytes memory ctorArgs = abi.encode(USDC_ADDR, primary, escalation, SCHEMA, typeHash);
        bytes32 factorySalt =
            VNextDeploySpec.contractSalt(VNextDeploySpec.MODE_CANONICAL, block.chainid, VNextDeploySpec.TAG_FACTORY, "");
        address factory =
            _deployViaProxy(factorySalt, abi.encodePacked(type(VNextSettlementEscrowFactory).creationCode, ctorArgs));

        try dvs.verify(factory) returns (DeployVNextSettlement.Tuple memory) {
            fail(
                "SECURITY GAP (N38 follow-up M1): verify(address) ACCEPTED a factory whose primary cohort "
                "is canonical-band and escalation cohort is provisional-band - it must reject mixed bands"
            );
        } catch Error(string memory reason) {
            assertTrue(
                _contains(reason, "different bands"),
                string.concat("verify() reverted, but for the wrong reason: ", reason)
            );
        }
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                      4. M2 (astra pack-410 Q4, MEDIUM): PROVISIONAL COVERAGE
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice The provisional positive control: genuine provisional-band cohorts and factory, deployed
    ///         through the same proxy helper, with the correct label supplied through the `virtual`
    ///         accessor (never `vm.setEnv` — see the file-level doc on the env race). `verify()` must
    ///         pass. This is COVERAGE, not a bug: it already worked at `08f24f12`, just untested.
    function test_M2_ProvisionalPositiveControl_VerifyPassesWithCorrectLabel() public {
        (,, bytes32 factorySalt, bytes memory ctorArgs) = _buildProvisionalCohorts(REVIEW_LABEL);
        address factory =
            _deployViaProxy(factorySalt, abi.encodePacked(type(VNextSettlementEscrowFactory).creationCode, ctorArgs));

        DeployVNextSettlement labeled = new VerifyLabelHarness(REVIEW_LABEL);
        try labeled.verify(factory) returns (DeployVNextSettlement.Tuple memory t) {
            assertEq(t.factory, factory, "returned tuple names a different factory");
        } catch Error(string memory reason) {
            fail(string.concat("provisional positive control: verify() reverted unexpectedly: ", reason));
        }
    }

    /// @notice An EMPTY label must revert with the "VNEXT_LABEL is required" message, never reaching the
    ///         address re-derivation.
    function test_M2_ProvisionalEmptyLabel_VerifyMustRevert() public {
        (,, bytes32 factorySalt, bytes memory ctorArgs) = _buildProvisionalCohorts(REVIEW_LABEL);
        address factory =
            _deployViaProxy(factorySalt, abi.encodePacked(type(VNextSettlementEscrowFactory).creationCode, ctorArgs));

        DeployVNextSettlement labeled = new VerifyLabelHarness("");
        try labeled.verify(factory) returns (DeployVNextSettlement.Tuple memory) {
            fail("verify() accepted an EMPTY VNEXT_LABEL for a provisional factory - it must revert");
        } catch Error(string memory reason) {
            assertTrue(
                _contains(reason, "VNEXT_LABEL is required"),
                string.concat("verify() reverted, but for the wrong reason: ", reason)
            );
        }
    }

    /// @notice A DIFFERENT (non-empty, wrong) label re-derives the WRONG salt and must revert with the
    ///         address-equality message, not the "label is required" one.
    function test_M2_ProvisionalWrongLabel_VerifyMustRevert() public {
        (,, bytes32 factorySalt, bytes memory ctorArgs) = _buildProvisionalCohorts(REVIEW_LABEL);
        address factory =
            _deployViaProxy(factorySalt, abi.encodePacked(type(VNextSettlementEscrowFactory).creationCode, ctorArgs));

        DeployVNextSettlement labeled = new VerifyLabelHarness("a-different-label");
        try labeled.verify(factory) returns (DeployVNextSettlement.Tuple memory) {
            fail("verify() accepted the WRONG VNEXT_LABEL for a provisional factory - it must revert");
        } catch Error(string memory reason) {
            assertTrue(
                _contains(reason, "not this build's CREATE2 output"),
                string.concat("verify() reverted, but for the wrong reason: ", reason)
            );
        }
    }

    /// @notice THE ONE REAL environment-variable case (astra pack-410 Q4's fourth bullet): the variable
    ///         genuinely MISSING, exercised through the UN-overridden `_verifyLabel` -> `vm.envString`
    ///         path, so forge's own environment-not-found revert fires. Safe to do for real: nothing in
    ///         this entire file ever calls `vm.setEnv("VNEXT_LABEL", ...)` — the other three label cases
    ///         above go through the `virtual` accessor instead — so there is nothing anywhere in this
    ///         suite for this test to race with.
    function test_M2_ProvisionalMissingLabelEnvVar_VerifyMustRevert() public {
        (,, bytes32 factorySalt, bytes memory ctorArgs) = _buildProvisionalCohorts(REVIEW_LABEL);
        address factory =
            _deployViaProxy(factorySalt, abi.encodePacked(type(VNextSettlementEscrowFactory).creationCode, ctorArgs));

        // `dvs` is a plain VerifyHarness: it does NOT override _verifyLabel, so `verify` reaches the
        // real `vm.envString("VNEXT_LABEL")`. That failure is a CHEATCODE-level revert, not a standard
        // `Error(string)` from this script's own `require` — a Solidity `catch Error(string)` clause
        // does not match it and the exception propagates uncaught, so `vm.expectRevert` (which matches
        // any revert encoding) is used instead of this file's usual try/catch pattern.
        vm.expectRevert(bytes("vm.envString: environment variable \"VNEXT_LABEL\" not found"));
        dvs.verify(factory);
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return false;
        for (uint256 i; i + n.length <= h.length; ++i) {
            bool match_ = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }
}

/// @dev `_unknownChainAllowed` moved into EVM state, isolated per test — see the `setUp` comment above
///      for why this file never calls `vm.setEnv("VNEXT_ALLOW_UNKNOWN_CHAIN", ...)`. This file never
///      needs the `false` branch, so the override is unconditional (no storage toggle needed, unlike
///      `DeployGatesHarnessNoEnv`, which other tests exercise both ways).
contract VerifyHarness is DeployVNextSettlement {
    function _unknownChainAllowed() internal pure override returns (bool) {
        return true;
    }
}

/// @dev M2 (astra pack-410 Q4): `_verifyLabel` ALSO moved into EVM state — a fixed label supplied at
///      construction, isolated per test. This is the "cover empty and missing through the accessor"
///      half of the brief's instruction; the "missing" case is covered separately through the
///      UN-overridden `VerifyHarness` (see {VNextDeployVerifyTest.test_M2_ProvisionalMissingLabelEnvVar_VerifyMustRevert}),
///      since simulating "missing" through this accessor would not exercise forge's real
///      environment-not-found revert at all.
contract VerifyLabelHarness is VerifyHarness {
    string internal _fixedLabel;

    constructor(string memory label_) {
        _fixedLabel = label_;
    }

    function _verifyLabel() internal view override returns (string memory) {
        return _fixedLabel;
    }
}

/// @dev Minimal stand-in for the canonical deterministic-deployment proxy at
///      `VNextDeploySpec.CREATE2_DEPLOYER`. Kept as a documented fallback for a local test chain that
///      does not pre-populate that address; empirically, forge's own test backend already provides one
///      (labeled "Create2Deployer" in traces), so this shim goes unused in practice. Semantically
///      identical for every property this test depends on: called with `salt (32 bytes) ++ initcode`, it
///      CREATE2s FROM ITSELF (so `msg.sender` inside the deployment is this contract's own address, i.e.
///      `CREATE2_DEPLOYER` once etched there) and returns the raw 20-byte deployed address — exactly the
///      calling convention `VNextDeploySpec.create2Address` assumes. The low-level `return` is
///      deliberate: a typed `returns (bytes memory)` would ABI-encode (offset + length + padded data)
///      instead of the raw 20 bytes the real proxy returns.
contract TestCreate2Proxy {
    fallback() external payable {
        require(msg.data.length > 32, "TestCreate2Proxy: calldata too short for salt + initcode");
        bytes32 salt;
        assembly ("memory-safe") {
            salt := calldataload(0)
        }
        uint256 len = msg.data.length - 32;
        bytes memory initcode = new bytes(len);
        assembly ("memory-safe") {
            calldatacopy(add(initcode, 0x20), 32, len)
        }
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(initcode, 0x20), len, salt)
        }
        require(deployed != address(0), "TestCreate2Proxy: CREATE2 failed");
        bytes memory out = abi.encodePacked(deployed);
        assembly ("memory-safe") {
            return(add(out, 0x20), 20)
        }
    }
}
