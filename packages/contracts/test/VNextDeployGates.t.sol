// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DeployVNextSettlement} from "../script/DeployVNextSettlement.s.sol";
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
    //                                          FIXTURES
    // ════════════════════════════════════════════════════════════════════════════════════════════════

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
}

/// @dev The harness the rule tests actually use: identical to {DeployGatesHarness} except that GATE 1's
///      opt-in is a storage slot instead of a host environment variable, so each test gets its own
///      isolated copy. See {VNextDeployGatesTest._setOverlapAllowed} for why that matters.
contract DeployGatesHarnessNoEnv is DeployGatesHarness {
    bool public allowOverlap;

    function setAllowOverlap(bool allowed) external {
        allowOverlap = allowed;
    }

    function _signerOverlapAllowed() internal view override returns (bool) {
        return allowOverlap;
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
