// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DeployVNextSettlement} from "../script/DeployVNextSettlement.s.sol";
import {VNextDeploySpec} from "../script/vnext/VNextDeploySpec.sol";
import {Fixed2of3O5Attester} from "../src/attesters/Fixed2of3O5Attester.sol";
import {SingleSignerO5Attester} from "../src/attesters/SingleSignerO5Attester.sol";

/**
 * @title VNextDeployGatesTest
 * @notice Negative tests for the two DEPLOY GATES in {DeployVNextSettlement} — the pair no constructor
 *         can enforce, so they hold only if this file says they do.
 *
 *           GATE 1  route diversity (§2.5): no two-signature quorum can control both routes.
 *           GATE 2  both cohorts alive at deploy: a `disable()`d cohort must never reach a broadcast.
 *
 * @dev "ABORTS BEFORE ANY BROADCAST", asserted rather than asserted-about. Every gate below is invoked
 *      through an explicit `STATICCALL` (see {_run}). A STATICCALL reverts on ANY state change, so a gate
 *      that could send a transaction — or mutate anything at all — could not return successfully from one.
 *      The gates being reachable this way is therefore a mechanical proof of the "nothing was broadcast"
 *      half of each test, on top of the revert the test is checking for. The end-to-end ORDERING claim
 *      (that `_deploy` calls the gates before its first `vm.startBroadcast`) is proven separately by the
 *      anvil CLI runs recorded in `ai/research/vnext-deploy-gates-log.md`.
 */
contract VNextDeployGatesTest is Test {
    DeployGatesHarnessNoEnv internal harness;

    // Two disjoint signer sets, plus separately custodied revokers (the attesters reject revoker==signer).
    address internal constant P1 = address(0xA1);
    address internal constant P2 = address(0xA2);
    address internal constant P3 = address(0xA3);
    address internal constant E1 = address(0xB1);
    address internal constant E2 = address(0xB2);
    address internal constant E3 = address(0xB3);
    address internal constant REV_P = address(0xDEAD01);
    address internal constant REV_E = address(0xDEAD02);
    address internal constant EAS = address(0xEA5);
    bytes32 internal constant SCHEMA = keccak256("o5.schema");
    /// @dev Plain EOAs: predicted cohort addresses that this run has not deployed into yet.
    address internal constant NO_CODE_A = address(0xE0DE01);
    address internal constant NO_CODE_B = address(0xE0DE02);

    // Distinctive fragments of each abort message. Substring matching, so a reword does not turn the suite
    // red for no security reason — but the fragment is specific enough to name WHICH gate fired.
    string internal constant SHARED_QUORUM = "quorum-sized group of signers sits on BOTH routes";
    string internal constant LAUNCH_POLICY = "Launch policy is FULLY DISJOINT";
    string internal constant UNREADABLE = "unrecognised attester shape";
    string internal constant DEAD_COHORT = "GATE 2 dead cohort";
    // GATE 3 (DEP-01) — the settlement asset.
    string internal constant USDC_NO_CODE = "settlement asset has no code on this chain";
    string internal constant USDC_NOT_CANONICAL = "the settlement asset is NOT the canonical USDC for this chain";
    string internal constant USDC_UNPINNED_CHAIN = "no canonical settlement asset is pinned for this chain";
    string internal constant PROVISIONAL_TOOK_CANONICAL = "must settle in its own throwaway token";
    // GATE 4 (PROV-01) — the provenance registries.
    string internal constant EAS_ZERO = "VNEXT_EAS is zero";
    string internal constant EAS_NOT_CANONICAL = "the EAS address is not the canonical registry";
    string internal constant EAS_NO_CODE = "the canonical EAS address holds NO code on this chain";
    string internal constant REGISTRY_NO_CODE = "the canonical EAS SchemaRegistry holds NO code on this chain";
    string internal constant EAS_UNPINNED_CHAIN = "no canonical EAS is pinned for this chain";

    /// @dev A perfectly good ERC-20 that simply is not the one Circle issues — the whole point of DEP-01
    ///      is that nothing downstream can tell the difference, so the fixture must not be degenerate.
    address internal constant IMPOSTOR_TOKEN = address(0xDECAF0);
    /// @dev A contract with the EAS call surface at the wrong address. Also indistinguishable downstream.
    address internal constant IMPOSTOR_EAS = address(0xDECAF1);
    /// @dev Any chain that is neither Base nor Base Sepolia. 31337 is the local anvil the flows run on.
    uint256 internal constant CHAIN_ANVIL = 31337;

    function setUp() public {
        harness = new DeployGatesHarnessNoEnv();
    }

    /// @dev The GATE 1 opt-in is driven through EVM STATE here, never `vm.setEnv`. `forge` runs the tests
    ///      inside a suite in PARALLEL against ONE shared host environment, and it rolls back EVM state
    ///      between tests but not the process environment — so an env-driven flag races with every other
    ///      test that sets it. Measured on this exact suite before the seam existed: 3 of 5 identical runs
    ///      of unmutated code failed, with a different test flipping each time. The production reader
    ///      (`_signerOverlapAllowed` -> `vm.envOr`) is pinned instead by
    ///      {test_Gate1_OptIn_IsReadFromTheEnvironment}, which is the ONLY test in this file permitted to
    ///      touch that variable, so nothing can race with it.
    function _setOverlapAllowed(bool allowed) internal {
        harness.setAllowOverlap(allowed);
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //          GATE 1 — ROUTE DIVERSITY, READ FROM THE DEPLOYED COHORTS (the `verify()` form)
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice THE HEADLINE CASE the audit escalated: two DIFFERENT attester addresses holding the SAME
    ///         signer set. Every check the escrow's constructor can make passes — the addresses differ and
    ///         the revokers differ — and the appeal is still the primary reviewing itself.
    function test_Gate1_IdenticalSignerSetsAtDifferentAddresses_Abort() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        address escalation = _fixed(P1, P2, P3, REV_E, 2);

        // The two properties the escrow DOES enforce both hold, so nothing on chain would object.
        assertTrue(primary != escalation, "fixture is wrong: the cohorts must sit at different addresses");
        assertTrue(
            Fixed2of3O5Attester(primary).revoker() != Fixed2of3O5Attester(escalation).revoker(),
            "fixture is wrong: H-02 distinct revokers must hold"
        );

        _assertAborts(_onChain(primary, escalation), SHARED_QUORUM);

        // And the opt-in does NOT buy it. A shared quorum is never a deliberate-act-away.
        _setOverlapAllowed(true);
        _assertAborts(_onChain(primary, escalation), SHARED_QUORUM);
    }

    function test_Gate1_DisjointCohorts_Pass() public {
        _setOverlapAllowed(false);
        (uint256 overlap, uint256 floor) =
            _assertPasses(_onChain(_fixed(P1, P2, P3, REV_P, 1), _fixed(E1, E2, E3, REV_E, 2)));
        assertEq(overlap, 0, "disjoint sets must intersect in nothing");
        assertEq(floor, 2, "two 2-of-3 cohorts have a quorum floor of 2");
    }

    /// @notice Exactly `min(thresholds)` shared signers is already a shared quorum — the boundary, tested
    ///         at the boundary. Two of the three primary signers also sit on the escalation cohort, so that
    ///         pair alone can reach quorum on both routes.
    function test_Gate1_SharedQuorum_AbortsEvenWithExplicitOptIn() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        address escalation = _fixed(P1, P2, E3, REV_E, 2); // intersection {P1,P2} == 2 == floor

        _assertAborts(_onChain(primary, escalation), SHARED_QUORUM);
        _setOverlapAllowed(true);
        _assertAborts(_onChain(primary, escalation), SHARED_QUORUM);
    }

    /// @notice One shared signer is BELOW the quorum floor, so the invariant permits it — but the launch
    ///         policy does not, and the default refuses it.
    function test_Gate1_SubQuorumOverlap_AbortsUnderTheDefaultLaunchPolicy() public {
        _setOverlapAllowed(false);
        _assertAborts(_onChain(_fixed(P1, P2, P3, REV_P, 1), _fixed(P1, E2, E3, REV_E, 2)), LAUNCH_POLICY);
    }

    function test_Gate1_SubQuorumOverlap_AcceptedOnlyWithTheExplicitOptIn() public {
        _setOverlapAllowed(false);
        _setOverlapAllowed(true);
        (uint256 overlap, uint256 floor) =
            _assertPasses(_onChain(_fixed(P1, P2, P3, REV_P, 1), _fixed(P1, E2, E3, REV_E, 2)));
        assertEq(overlap, 1, "one signer sits on both routes");
        assertEq(floor, 2, "still below the quorum floor, which is why the opt-in can reach it at all");
    }

    /// @notice Pins the PRODUCTION opt-in reader: `VNEXT_ALLOW_SIGNER_OVERLAP` really is the variable
    ///         {DeployVNextSettlement._signerOverlapAllowed} consults, and `0` really does mean refuse —
    ///         without this, the EVM-state seam every other test uses could drift away from the flag an
    ///         operator actually sets. This test is the SOLE owner of that environment variable in the
    ///         suite (see {_setOverlapAllowed}), so nothing can race with it.
    function test_Gate1_OptIn_IsReadFromTheEnvironment() public {
        DeployGatesHarness envHarness = new DeployGatesHarness();
        bytes memory gateCall = _onChain(_fixed(P1, P2, P3, REV_P, 1), _fixed(P1, E2, E3, REV_E, 2)); // overlap 1

        vm.setEnv("VNEXT_ALLOW_SIGNER_OVERLAP", "0");
        (bool ok,) = address(envHarness).staticcall(gateCall);
        assertFalse(ok, "unset/0 must refuse even sub-quorum overlap");

        vm.setEnv("VNEXT_ALLOW_SIGNER_OVERLAP", "1");
        (ok,) = address(envHarness).staticcall(gateCall);
        assertTrue(ok, "an explicit 1 must accept sub-quorum overlap");

        vm.setEnv("VNEXT_ALLOW_SIGNER_OVERLAP", "0"); // leave the process as it was found
    }

    /// @notice Why the floor is `min(thresholds)` and not the primary's threshold: a 2-of-3 primary whose
    ///         appeal is a 1-of-1 escalation is captured by ONE shared key. Taking the primary's 2 would
    ///         wave this through.
    function test_Gate1_MixedThresholds_FloorIsTheSmallerThreshold() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        address escalation = _single(P1, REV_E, 2); // the escalation's ONLY signer is a primary signer

        _setOverlapAllowed(true); // even opted in
        _assertAborts(_onChain(primary, escalation), SHARED_QUORUM);
    }

    function test_Gate1_TwoSingleSignerCohorts_SharedSignerIsASharedQuorum() public {
        _setOverlapAllowed(false);
        _setOverlapAllowed(true);
        _assertAborts(_onChain(_single(P1, REV_P, 1), _single(P1, REV_E, 2)), SHARED_QUORUM);
    }

    function test_Gate1_TwoSingleSignerCohorts_DistinctSignersPass() public {
        _setOverlapAllowed(false);
        (uint256 overlap, uint256 floor) = _assertPasses(_onChain(_single(P1, REV_P, 1), _single(E1, REV_E, 2)));
        assertEq(overlap, 0);
        assertEq(floor, 1, "a 1-of-1 pair has a quorum floor of 1");
    }

    /// @notice A quorum this script cannot READ is a quorum it cannot prove diverse. The gate must abort,
    ///         not pass vacuously — otherwise introducing a new attester type silently disables it.
    function test_Gate1_UnreadableAttesterShape_Aborts() public {
        _setOverlapAllowed(false);
        address opaque = address(new OpaqueQuorumAttester());
        _assertAborts(_onChain(_fixed(P1, P2, P3, REV_P, 1), opaque), UNREADABLE);
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //        GATE 1 — ROUTE DIVERSITY, READ FROM THE CONFIGURED INPUTS (the pre-deploy form)
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    function test_Gate1_Inputs_Disjoint_Pass() public {
        _setOverlapAllowed(false);
        (uint256 overlap, uint256 floor) = _assertPasses(_fromInputs(false, P1, P2, P3, E1, E2, E3));
        assertEq(overlap, 0);
        assertEq(floor, 2);
    }

    function test_Gate1_Inputs_SharedQuorum_AbortsEvenWithExplicitOptIn() public {
        _setOverlapAllowed(false);
        _setOverlapAllowed(true);
        _assertAborts(_fromInputs(false, P1, P2, P3, P2, P3, E3), SHARED_QUORUM);
    }

    function test_Gate1_Inputs_SubQuorumOverlap_AbortsByDefault_PassesOptedIn() public {
        _setOverlapAllowed(false);
        _assertAborts(_fromInputs(false, P1, P2, P3, P3, E2, E3), LAUNCH_POLICY);

        _setOverlapAllowed(true);
        (uint256 overlap,) = _assertPasses(_fromInputs(false, P1, P2, P3, P3, E2, E3));
        assertEq(overlap, 1);
    }

    /// @notice SINGLE_SIGNER inputs: only `signer0` is a real member, so signers 1 and 2 must be ignored.
    ///         A shared signer0 is a shared quorum; a shared signer1 is not a shared anything.
    function test_Gate1_Inputs_SingleSigner_ReadsOnlySigner0() public {
        _setOverlapAllowed(false);
        _setOverlapAllowed(true);
        _assertAborts(_fromInputs(true, P1, P2, P3, P1, E2, E3), SHARED_QUORUM);

        // Same call, differing only in signer0: the unused slots overlap completely and must not matter.
        (uint256 overlap, uint256 floor) = _assertPasses(_fromInputs(true, P1, P2, P3, E1, P2, P3));
        assertEq(overlap, 0, "signers 1 and 2 are not members of a SINGLE_SIGNER cohort");
        assertEq(floor, 1);
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                     GATE 2 — BOTH COHORTS ALIVE, BEFORE ANY BROADCAST
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    function test_Gate2_BothCohortsAlive_Pass() public {
        _setOverlapAllowed(false);
        _assertPassesVoid(_beforeBroadcast(_fixed(P1, P2, P3, REV_P, 1), _fixed(E1, E2, E3, REV_E, 2)));
    }

    function test_Gate2_DisabledPrimary_AbortsBeforeBroadcast() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        address escalation = _fixed(E1, E2, E3, REV_E, 2);
        _kill(primary, REV_P);

        _assertAborts(_beforeBroadcast(primary, escalation), DEAD_COHORT);
    }

    function test_Gate2_DisabledEscalation_AbortsBeforeBroadcast() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        address escalation = _fixed(E1, E2, E3, REV_E, 2);
        _kill(escalation, REV_E);

        _assertAborts(_beforeBroadcast(primary, escalation), DEAD_COHORT);
    }

    /// @notice GATE 2 is independent of GATE 1: a perfectly route-diverse pair still aborts if one half is
    ///         dead. Without this, "the signer sets are disjoint" could be mistaken for "the stack is
    ///         deployable".
    function test_Gate2_IsIndependentOfRouteDiversity() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        address escalation = _fixed(E1, E2, E3, REV_E, 2);
        _assertPassesVoid(_beforeBroadcast(primary, escalation)); // diverse AND alive
        _kill(primary, REV_P);
        _assertAborts(_beforeBroadcast(primary, escalation), DEAD_COHORT); // diverse, dead
    }

    /// @notice A predicted address with NO code is a cohort this run is about to CREATE. It is `enabled` by
    ///         construction (`O5AttesterBase.sol:225`) and has no signer set to read, so GATE 2 must skip
    ///         it here rather than revert on an address that is simply not occupied yet — otherwise the
    ///         very first deployment of a cohort pair could never proceed.
    function test_Gate2_UndeployedCohortAddresses_AreSkippedNotRejected() public {
        _setOverlapAllowed(false);
        _assertPassesVoid(_beforeBroadcast(NO_CODE_A, NO_CODE_B));
    }

    /// @notice The half-resumed case: primary already on chain (and dead), escalation not yet deployed.
    ///         Skipping the empty address must not skip the occupied one.
    function test_Gate2_HalfResumedRun_StillCatchesTheDeadHalf() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        _kill(primary, REV_P);
        _assertAborts(_beforeBroadcast(primary, NO_CODE_A), DEAD_COHORT);
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                       "BEFORE ANY BROADCAST", ASSERTED MECHANICALLY
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Both gates run to completion inside a STATICCALL, which the EVM aborts on any state change.
    ///         A gate able to broadcast a transaction (or write a single slot) could not pass this test.
    ///         The harness's nonce is checked either side as a second, independent reading of the same
    ///         fact: nothing was sent.
    function test_Gates_RunEntirelyWithinAStaticCall_SoNothingCanBeSent() public {
        _setOverlapAllowed(false);
        address primary = _fixed(P1, P2, P3, REV_P, 1);
        address escalation = _fixed(E1, E2, E3, REV_E, 2);
        uint64 nonceBefore = vm.getNonce(address(harness));

        _assertPasses(_onChain(primary, escalation));
        _assertPassesVoid(_beforeBroadcast(primary, escalation));

        assertEq(vm.getNonce(address(harness)), nonceBefore, "a gate sent something");
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //            GATE 3 (DEP-01) — THE SETTLEMENT ASSET IS THE CANONICAL TOKEN, NOT MERELY A TOKEN
    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //
    // Every fixture below etches REAL CODE at the impostor address. That is deliberate: the old check was
    // `usdc.code.length > 0`, so a fixture with an empty impostor would pass these tests for the OLD
    // reason and prove nothing about the new one. The impostor is always a live, conforming-looking
    // contract — exactly the thing no escrow invariant can distinguish from the real token.

    function test_Gate3_Base_WrongToken_Aborts() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etch(VNextDeploySpec.USDC_BASE); // the real one is present and reachable...
        _etch(IMPOSTOR_TOKEN); // ...and the configured one is live too. Only the ADDRESS differs.
        _assertAborts(_settlementAsset(IMPOSTOR_TOKEN, false), USDC_NOT_CANONICAL);
    }

    function test_Gate3_Base_CanonicalToken_Proceeds() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etch(VNextDeploySpec.USDC_BASE);
        _assertPassesVoid(_settlementAsset(VNextDeploySpec.USDC_BASE, false));
    }

    function test_Gate3_BaseSepolia_WrongToken_Aborts() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE_SEPOLIA);
        _etch(VNextDeploySpec.USDC_BASE_SEPOLIA);
        _etch(IMPOSTOR_TOKEN);
        _assertAborts(_settlementAsset(IMPOSTOR_TOKEN, false), USDC_NOT_CANONICAL);
    }

    function test_Gate3_BaseSepolia_CanonicalToken_Proceeds() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE_SEPOLIA);
        _etch(VNextDeploySpec.USDC_BASE_SEPOLIA);
        _assertPassesVoid(_settlementAsset(VNextDeploySpec.USDC_BASE_SEPOLIA, false));
    }

    /// @notice The likeliest real fumble, and the one a per-chain pin exists for: a `.env` carried across
    ///         networks. Base's USDC is canonical — on Base. On Base Sepolia it is just another token, and
    ///         a check that asked "is this a known USDC?" instead of "is this THIS CHAIN's USDC?" would
    ///         wave it straight through.
    function test_Gate3_CanonicalTokenOfTheWrongChain_IsStillWrong() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE_SEPOLIA);
        _etch(VNextDeploySpec.USDC_BASE);
        _assertAborts(_settlementAsset(VNextDeploySpec.USDC_BASE, false), USDC_NOT_CANONICAL);

        // ...and symmetrically, so neither direction is special-cased by accident.
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etch(VNextDeploySpec.USDC_BASE_SEPOLIA);
        _assertAborts(_settlementAsset(VNextDeploySpec.USDC_BASE_SEPOLIA, false), USDC_NOT_CANONICAL);
    }

    /// @notice The pre-existing has-code check is KEPT, not replaced. It fires first, because "nothing is
    ///         deployed there" is a more actionable report than "that is the wrong token".
    function test_Gate3_EmptyAddress_StillFailsTheOriginalCodeCheck() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _assertAborts(_settlementAsset(VNextDeploySpec.USDC_BASE, false), USDC_NO_CODE);
        _assertAborts(_settlementAsset(address(0), false), USDC_NO_CODE);
    }

    /// @notice A PROVISIONAL deployment is held to the INVERSE rule. Its throwaway token is what makes it
    ///         structurally incapable of moving real funds, so a provisional run that somehow acquired the
    ///         canonical asset has lost the property, not gained a convenience.
    function test_Gate3_Provisional_MustNotSettleInTheCanonicalToken() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE_SEPOLIA);
        _etch(VNextDeploySpec.USDC_BASE_SEPOLIA);
        _assertAborts(_settlementAsset(VNextDeploySpec.USDC_BASE_SEPOLIA, true), PROVISIONAL_TOOK_CANONICAL);
    }

    function test_Gate3_Provisional_ThrowawayToken_Proceeds() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE_SEPOLIA);
        _etch(IMPOSTOR_TOKEN);
        _assertPassesVoid(_settlementAsset(IMPOSTOR_TOKEN, true));
    }

    /// @notice An unrecognised chain has no canonical token to compare against. It must NOT pass silently:
    ///         "I could not check this" and "I checked this" are different answers and the script says so.
    function test_Gate3_UnknownChain_DoesNotSilentlyPass() public {
        vm.chainId(CHAIN_ANVIL);
        _etch(IMPOSTOR_TOKEN);
        _setUnknownChainAllowed(false);
        _assertAborts(_settlementAsset(IMPOSTOR_TOKEN, false), USDC_UNPINNED_CHAIN);
    }

    function test_Gate3_UnknownChain_ProceedsOnlyWithTheExplicitOptIn() public {
        vm.chainId(CHAIN_ANVIL);
        _etch(IMPOSTOR_TOKEN);
        _setUnknownChainAllowed(true);
        _assertPassesVoid(_settlementAsset(IMPOSTOR_TOKEN, false));
    }

    /// @notice The opt-in waives the IDENTITY pin only. It is not a global "skip GATE 3", so an address
    ///         with no code at all is still refused on an unknown chain.
    function test_Gate3_UnknownChainOptIn_DoesNotWaiveTheCodeCheck() public {
        vm.chainId(CHAIN_ANVIL);
        _setUnknownChainAllowed(true);
        _assertAborts(_settlementAsset(IMPOSTOR_TOKEN, false), USDC_NO_CODE);
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //          GATE 4 (PROV-01) — THE PROVENANCE REGISTRIES ARE THE CANONICAL PREDEPLOYS
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    function test_Gate4_Base_NonCanonicalEas_Aborts() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etchProvenancePredeploys();
        _etch(IMPOSTOR_EAS); // live, EAS-shaped, wrong address
        _assertAborts(_provenanceRegistries(IMPOSTOR_EAS), EAS_NOT_CANONICAL);
    }

    function test_Gate4_BaseSepolia_NonCanonicalEas_Aborts() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE_SEPOLIA);
        _etchProvenancePredeploys();
        _etch(IMPOSTOR_EAS);
        _assertAborts(_provenanceRegistries(IMPOSTOR_EAS), EAS_NOT_CANONICAL);
    }

    function test_Gate4_CanonicalPredeploys_Proceed() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etchProvenancePredeploys();
        _assertPassesVoid(_provenanceRegistries(VNextDeploySpec.EAS));

        vm.chainId(VNextDeploySpec.CHAIN_BASE_SEPOLIA);
        _assertPassesVoid(_provenanceRegistries(VNextDeploySpec.EAS));
    }

    /// @notice The SchemaRegistry is not an input — it is pinned to the OP-Stack predeploy — so the only
    ///         way for it to be non-canonical is for the canonical address to hold something other than
    ///         the registry. Empty is the checkable case: a chain without the registry deployed cannot
    ///         have registered the pinned O5 schema uid, so the mirror's premise is already false.
    /// @dev    HONEST LIMIT, stated where a reviewer will read it: this proves code EXISTS at the pinned
    ///         registry address, not that the code IS a SchemaRegistry. Confirming the registration itself
    ///         (schema string, `resolver == address(0)`, `revocable == false`) is the ORACLE lane's.
    function test_Gate4_SchemaRegistryMissing_Aborts() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etch(VNextDeploySpec.EAS); // EAS present...
        // ...SchemaRegistry deliberately NOT etched.
        _assertAborts(_provenanceRegistries(VNextDeploySpec.EAS), REGISTRY_NO_CODE);
    }

    /// @notice The canonical ADDRESS with nothing at it makes `mirrorToEAS` a permanent no-op rather than
    ///         a mirror — a pin that only compared addresses would call that a pass.
    function test_Gate4_CanonicalEasAddressWithNoCode_Aborts() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etch(VNextDeploySpec.EAS_SCHEMA_REGISTRY); // registry present, EAS itself empty
        _assertAborts(_provenanceRegistries(VNextDeploySpec.EAS), EAS_NO_CODE);
    }

    /// @notice The pre-existing non-zero check is KEPT and still fires first.
    function test_Gate4_ZeroEas_StillFailsTheOriginalCheck() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etchProvenancePredeploys();
        _assertAborts(_provenanceRegistries(address(0)), EAS_ZERO);
    }

    function test_Gate4_UnknownChain_DoesNotSilentlyPass() public {
        vm.chainId(CHAIN_ANVIL);
        _etch(IMPOSTOR_EAS);
        _setUnknownChainAllowed(false);
        _assertAborts(_provenanceRegistries(IMPOSTOR_EAS), EAS_UNPINNED_CHAIN);
    }

    function test_Gate4_UnknownChain_ProceedsOnlyWithTheExplicitOptIn() public {
        vm.chainId(CHAIN_ANVIL);
        _etch(IMPOSTOR_EAS);
        _setUnknownChainAllowed(true);
        _assertPassesVoid(_provenanceRegistries(IMPOSTOR_EAS));
    }

    function test_Gate4_UnknownChainOptIn_DoesNotWaiveTheZeroCheck() public {
        vm.chainId(CHAIN_ANVIL);
        _setUnknownChainAllowed(true);
        _assertAborts(_provenanceRegistries(address(0)), EAS_ZERO);
    }

    /// @notice `eas` is a per-attester immutable set from a constructor argument, so the two cohorts CAN
    ///         be wired to different registries. A tuple reporting the primary's registry while the
    ///         escalation quietly mirrored elsewhere would be a true statement that misleads, so the
    ///         disagreement is refused before either address is compared to the canonical one.
    function test_Gate4_CohortsWiredToDifferentRegistries_Abort() public {
        address primary = _fixedWithEas(P1, P2, P3, REV_P, 1, VNextDeploySpec.EAS);
        address escalation = _fixedWithEas(E1, E2, E3, REV_E, 2, IMPOSTOR_EAS);
        _assertAborts(_cohortsShareEas(primary, escalation), "mirror into DIFFERENT EAS registries");
    }

    function test_Gate4_CohortsSharingOneRegistry_ReturnIt() public {
        address primary = _fixedWithEas(P1, P2, P3, REV_P, 1, VNextDeploySpec.EAS);
        address escalation = _fixedWithEas(E1, E2, E3, REV_E, 2, VNextDeploySpec.EAS);
        (bool ok, bytes memory ret) = _run(_cohortsShareEas(primary, escalation));
        assertTrue(ok, string.concat("gate aborted unexpectedly: ", _reason(ret)));
        assertEq(abi.decode(ret, (address)), VNextDeploySpec.EAS, "must report the registry both cohorts share");
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                  GATES 3 + 4 — CROSS-CUTTING PROPERTIES OF THE TWO PINS
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @notice Both pins name the enforcement point that fired. Three points check the same address from
    ///         three different sources (configured inputs / chain state / deployment artifact), so a
    ///         reviewer reading only a revert needs to know WHICH source disagreed.
    function test_Gates34_AbortMessageNamesTheEnforcementPointThatFired() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etchProvenancePredeploys();
        _etch(IMPOSTOR_TOKEN);
        _etch(IMPOSTOR_EAS);

        _assertAborts(_settlementAssetFrom(IMPOSTOR_TOKEN, false, "chain state"), "GATE 3 DEP-01 (chain state)");
        _assertAborts(
            _settlementAssetFrom(IMPOSTOR_TOKEN, false, "deployment artifact"), "GATE 3 DEP-01 (deployment artifact)"
        );
        _assertAborts(_provenanceRegistriesFrom(IMPOSTOR_EAS, "chain state"), "GATE 4 PROV-01 (chain state)");
        _assertAborts(
            _provenanceRegistriesFrom(IMPOSTOR_EAS, "deployment artifact"), "GATE 4 PROV-01 (deployment artifact)"
        );
    }

    /// @notice Pins the PRODUCTION opt-in reader, exactly as {test_Gate1_OptIn_IsReadFromTheEnvironment}
    ///         does for GATE 1: `VNEXT_ALLOW_UNKNOWN_CHAIN` really is the variable
    ///         {DeployVNextSettlement._unknownChainAllowed} consults, and unset really does mean refuse.
    ///         Without this, the EVM-state seam the tests above use could drift away from the flag an
    ///         operator actually sets. This test is the SOLE owner of that variable in the suite.
    function test_Gates34_UnknownChainOptIn_IsReadFromTheEnvironment() public {
        DeployGatesHarness envHarness = new DeployGatesHarness();
        vm.chainId(CHAIN_ANVIL);
        _etch(IMPOSTOR_TOKEN);
        bytes memory gateCall = _settlementAsset(IMPOSTOR_TOKEN, false);

        vm.setEnv("VNEXT_ALLOW_UNKNOWN_CHAIN", "0");
        (bool ok,) = address(envHarness).staticcall(gateCall);
        assertFalse(ok, "unset/0 must refuse an unverifiable settlement asset");

        vm.setEnv("VNEXT_ALLOW_UNKNOWN_CHAIN", "1");
        (ok,) = address(envHarness).staticcall(gateCall);
        assertTrue(ok, "an explicit 1 must accept it deliberately");

        vm.setEnv("VNEXT_ALLOW_UNKNOWN_CHAIN", "0"); // leave the process as it was found
    }

    /// @notice The GATE 1/GATE 2 proof, extended to the two new gates: both run to completion inside a
    ///         STATICCALL, which the EVM aborts on ANY state change — so neither can broadcast a
    ///         transaction or write a slot. The nonce either side is the second, independent reading.
    /// @dev    "no artifact written" is proven by CONSTRUCTION rather than by assertion: both gates are
    ///         `internal view` and reached here through `external view`, and `vm.writeJson` is declared
    ///         non-view on `Vm`, so a gate able to write the deployment artifact would not compile. The
    ///         end-to-end form of the same claim (a real pending broadcast that spends zero nonces and
    ///         leaves no file) is the N-DEP anvil pair in `ai/research/vnext-dep01-prov01-log.md`.
    function test_Gates34_RunEntirelyWithinAStaticCall_SoNothingCanBeSent() public {
        vm.chainId(VNextDeploySpec.CHAIN_BASE);
        _etchProvenancePredeploys();
        _etch(VNextDeploySpec.USDC_BASE);
        uint64 nonceBefore = vm.getNonce(address(harness));

        _assertPassesVoid(_settlementAsset(VNextDeploySpec.USDC_BASE, false));
        _assertPassesVoid(_provenanceRegistries(VNextDeploySpec.EAS));

        assertEq(vm.getNonce(address(harness)), nonceBefore, "a gate sent something");
    }

    // ════════════════════════════════════════════════════════════════════════════════════════════════
    //                                          FIXTURES
    // ════════════════════════════════════════════════════════════════════════════════════════════════

    /// @dev Put NON-EMPTY runtime at `at`. The bytes are never executed — both gates only ever read
    ///      `code.length` — but they must be non-empty or the fixture would satisfy the new pins for the
    ///      OLD reason and the tests would prove nothing.
    function _etch(address at) internal {
        vm.etch(at, hex"60006000fd");
    }

    function _etchProvenancePredeploys() internal {
        _etch(VNextDeploySpec.EAS);
        _etch(VNextDeploySpec.EAS_SCHEMA_REGISTRY);
    }

    /// @dev GATE 3/GATE 4's unknown-chain opt-in, driven through EVM STATE rather than `vm.setEnv`, for
    ///      the reason spelled out on {_setOverlapAllowed}: forge runs a suite's tests in PARALLEL against
    ///      one shared process environment. {test_Gates34_UnknownChainOptIn_IsReadFromTheEnvironment} is
    ///      the sole owner of the real variable.
    function _setUnknownChainAllowed(bool allowed) internal {
        harness.setAllowUnknownChain(allowed);
    }

    function _settlementAsset(address usdc, bool provisionalDeployment) internal pure returns (bytes memory) {
        return _settlementAssetFrom(usdc, provisionalDeployment, "configured inputs");
    }

    function _settlementAssetFrom(address usdc, bool provisionalDeployment, string memory source)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(DeployGatesHarness.settlementAsset, (usdc, provisionalDeployment, source));
    }

    function _provenanceRegistries(address eas) internal pure returns (bytes memory) {
        return _provenanceRegistriesFrom(eas, "configured inputs");
    }

    function _provenanceRegistriesFrom(address eas, string memory source) internal pure returns (bytes memory) {
        return abi.encodeCall(DeployGatesHarness.provenanceRegistries, (eas, source));
    }

    function _cohortsShareEas(address p, address e) internal pure returns (bytes memory) {
        return abi.encodeCall(DeployGatesHarness.cohortsShareEas, (p, e));
    }

    /// @dev {_fixed} with the registry as a parameter — the two cohorts' `eas` immutables are independent.
    function _fixedWithEas(address s0, address s1, address s2, address revoker, uint64 cohortId, address eas_)
        internal
        returns (address)
    {
        return address(new Fixed2of3O5Attester(s0, s1, s2, eas_, SCHEMA, cohortId, revoker));
    }


    function _fixed(address s0, address s1, address s2, address revoker, uint64 cohortId) internal returns (address) {
        return address(new Fixed2of3O5Attester(s0, s1, s2, EAS, SCHEMA, cohortId, revoker));
    }

    function _single(address s0, address revoker, uint64 cohortId) internal returns (address) {
        return address(new SingleSignerO5Attester(s0, EAS, SCHEMA, cohortId, revoker));
    }

    function _kill(address attester, address revoker) internal {
        vm.prank(revoker);
        Fixed2of3O5Attester(attester).disable();
        assertFalse(Fixed2of3O5Attester(attester).enabled(), "fixture is wrong: the cohort should be dead");
    }

    function _onChain(address p, address e) internal pure returns (bytes memory) {
        return abi.encodeCall(DeployGatesHarness.routeDiversityOnChain, (p, e));
    }

    function _beforeBroadcast(address p, address e) internal pure returns (bytes memory) {
        return abi.encodeCall(DeployGatesHarness.cohortsBeforeBroadcast, (p, e));
    }

    function _fromInputs(bool singleSigner, address p0, address p1, address p2, address e0, address e1, address e2)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(DeployGatesHarness.routeDiversityFromInputs, (singleSigner, p0, p1, p2, e0, e1, e2));
    }

    // ── Invocation + assertion plumbing (every call is an explicit STATICCALL) ───────────────────────

    function _run(bytes memory callData) internal view returns (bool ok, bytes memory ret) {
        (ok, ret) = address(harness).staticcall(callData);
    }

    function _assertPasses(bytes memory callData) internal returns (uint256 overlap, uint256 quorumFloor) {
        (bool ok, bytes memory ret) = _run(callData);
        assertTrue(ok, string.concat("gate aborted unexpectedly: ", _reason(ret)));
        (overlap, quorumFloor) = abi.decode(ret, (uint256, uint256));
    }

    function _assertPassesVoid(bytes memory callData) internal {
        (bool ok, bytes memory ret) = _run(callData);
        assertTrue(ok, string.concat("gate aborted unexpectedly: ", _reason(ret)));
    }

    function _assertAborts(bytes memory callData, string memory fragment) internal {
        (bool ok, bytes memory ret) = _run(callData);
        assertFalse(ok, "the gate did NOT abort");
        string memory reason = _reason(ret);
        assertTrue(_contains(reason, fragment), string.concat("aborted for the wrong reason: ", reason));
    }

    /// @dev Unwrap `Error(string)`. Returns the empty string for any other revert shape.
    function _reason(bytes memory ret) internal pure returns (string memory) {
        if (ret.length < 68) return "";
        bytes memory body = new bytes(ret.length - 4);
        for (uint256 i = 4; i < ret.length; ++i) {
            body[i - 4] = ret[i];
        }
        return abi.decode(body, (string));
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

/// @dev Exposes {DeployVNextSettlement}'s internal gates as `external view` entry points. `view` is not
///      cosmetic here: it is what lets every test invoke them through a STATICCALL and thereby prove no
///      broadcast is reachable from inside a gate.
contract DeployGatesHarness is DeployVNextSettlement {
    function routeDiversityOnChain(address primary, address escalation) external view returns (uint256, uint256) {
        return _assertOnChainRouteDiversity(primary, escalation);
    }

    function cohortsBeforeBroadcast(address primary, address escalation) external view {
        _assertCohortsBeforeBroadcast(primary, escalation);
    }

    function routeDiversityFromInputs(
        bool singleSigner,
        address p0,
        address p1,
        address p2,
        address e0,
        address e1,
        address e2
    ) external view returns (uint256, uint256) {
        Inputs memory i;
        i.attesterType = singleSigner ? AttesterType.SINGLE_SIGNER : AttesterType.FIXED_2OF3;
        i.primary = CohortInput({signer0: p0, signer1: p1, signer2: p2, revoker: address(0xDEAD01), cohortId: 1});
        i.escalation = CohortInput({signer0: e0, signer1: e1, signer2: e2, revoker: address(0xDEAD02), cohortId: 2});
        return _assertInputRouteDiversity(i);
    }

    /// @dev GATE 3. `source` is a parameter rather than a constant so the tests can exercise all three
    ///      enforcement points' messages through one entry point.
    function settlementAsset(address usdc, bool provisionalDeployment, string calldata source) external view {
        _assertSettlementAsset(usdc, provisionalDeployment, source);
    }

    /// @dev GATE 4.
    function provenanceRegistries(address eas, string calldata source) external view {
        _assertProvenanceRegistries(eas, source);
    }

    /// @dev GATE 4's which-registry precondition, as {_verify} reaches it.
    function cohortsShareEas(address primary, address escalation) external view returns (address) {
        return _assertCohortsShareEas(primary, escalation);
    }
}

/// @dev The harness the rule tests actually use: identical to {DeployGatesHarness} except that GATE 1's
///      opt-in is a storage slot instead of a host environment variable, so each test gets its own
///      isolated copy. See {VNextDeployGatesTest._setOverlapAllowed} for why that matters.
contract DeployGatesHarnessNoEnv is DeployGatesHarness {
    bool public allowOverlap;
    /// @dev GATE 3/GATE 4's unknown-chain opt-in, moved into EVM state for the same reason as
    ///      {allowOverlap}: forge isolates EVM state per test but not the host environment.
    bool public allowUnknownChain;

    function setAllowOverlap(bool allowed) external {
        allowOverlap = allowed;
    }

    function setAllowUnknownChain(bool allowed) external {
        allowUnknownChain = allowed;
    }

    function _signerOverlapAllowed() internal view override returns (bool) {
        return allowOverlap;
    }

    function _unknownChainAllowed() internal view override returns (bool) {
        return allowUnknownChain;
    }
}

/// @dev A cohort with the {IOracleAttester} lifecycle surface but NEITHER `signer0()` nor `signer()` — a
///      stand-in for any future quorum shape this script has not been taught to read.
contract OpaqueQuorumAttester {
    bool public enabled = true;
    uint64 public disabledAt;
    address public revoker = address(0xDEAD03);
    uint64 public cohortId = 7;
}
