// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DeployVNextSettlement} from "../script/DeployVNextSettlement.s.sol";
import {VNextDeploySpec} from "../script/vnext/VNextDeploySpec.sol";

/**
 * @title VNextDeployRecordTest
 * @notice The deploy script's RECORD PERSISTENCE: the one part of {DeployVNextSettlement} no other test reaches.
 *
 *         The script persists each run's tuple under `deployments/vnext/<network>/` and, before any broadcast,
 *         reads the existing record back to refuse publishing a RIVAL deployment
 *         (`_guardAgainstRivalDeployment`). Both are Foundry file cheatcodes, so both depend on the
 *         `fs_permissions` grant in `foundry.toml`. Without that grant every call below reverts before it can
 *         check anything. That is also why the rest of the suite stayed green while the grant was missing:
 *         the gate tests exercise the gates in isolation and never touch the file I/O path.
 *
 *         What this file proves:
 *           1. the record round-trips: a record written under the grant is read back by the script's guard;
 *           2. the guard REFUSES a record naming a different factory (the rival-deployment property);
 *           3. a simulation writes a `DRYRUN-` path, never the deployment record itself;
 *           4. PROVISIONAL and CANONICAL records live in disjoint namespaces;
 *           5. the grant does NOT reach the other tracked records under `deployments/` (least privilege).
 *
 * @dev The guard is invoked through an explicit STATICCALL, as {VNextDeployGatesTest} does for the gates, so a
 *      passing test also proves the guard is read-only: it cannot rewrite the record it is checking.
 */
contract VNextDeployRecordTest is Test {
    DeployRecordHarness internal harness;

    address internal constant FACTORY_A = address(0xFAC701);
    address internal constant FACTORY_B = address(0xFAC702);

    /// @dev Distinctive fragment of the guard's abort message; substring match, as in {VNextDeployGatesTest}.
    string internal constant RIVAL = "an artifact already records a DIFFERENT factory";

    /// @dev A tracked record OUTSIDE `deployments/vnext`. The name is deliberately impossible to confuse with a
    ///      real record, so that a test which wrongly succeeds leaves behind something obviously stray.
    string internal constant OUTSIDE_GRANT = "deployments/base-sepolia/ESCROW-TEST-MUST-NOT-BE-WRITABLE.json";

    function setUp() public {
        harness = new DeployRecordHarness();
    }

    // ── 1. round trip ─────────────────────────────────────────────────────────────────────────────

    /// @notice With no record present the guard must simply return. `vm.exists` is itself a gated file
    ///         cheatcode, so this is the plainest negative control for the grant: it fails without it.
    function test_Record_NoRecordYet_GuardProceeds() public {
        string memory label = "record-none";
        _clear(harness.artifactPath(VNextDeploySpec.MODE_PROVISIONAL, label));
        _assertGuardPasses(VNextDeploySpec.MODE_PROVISIONAL, label, FACTORY_A);
    }

    function test_Record_SameFactory_GuardProceeds() public {
        string memory label = "record-same";
        string memory path = _writeRecord(VNextDeploySpec.MODE_PROVISIONAL, label, FACTORY_A);
        _assertGuardPasses(VNextDeploySpec.MODE_PROVISIONAL, label, FACTORY_A);
        _clear(path);
    }

    // ── 2. the rival-deployment property ─────────────────────────────────────────────────────────

    /// @notice A record naming factory A must stop a run whose inputs predict factory B. Without this, a changed
    ///         input silently publishes a second, different deployment under the same name.
    function test_Record_RivalFactory_Aborts() public {
        string memory label = "record-rival";
        string memory path = _writeRecord(VNextDeploySpec.MODE_PROVISIONAL, label, FACTORY_A);
        _assertGuardAborts(VNextDeploySpec.MODE_PROVISIONAL, label, FACTORY_B, RIVAL);
        _clear(path);
    }

    // ── 3-4. paths ───────────────────────────────────────────────────────────────────────────────

    /// @notice Forge executes a script body in full with or without `--broadcast`. A simulation must therefore
    ///         write somewhere other than the record, or a dry run would poison the rival-deployment guard.
    function test_Record_SimulationPath_IsNeverTheRecord() public view {
        string memory p = harness.artifactPath(VNextDeploySpec.MODE_CANONICAL, "");
        assertTrue(_contains(p, "/DRYRUN-CANONICAL.json"), string.concat("simulation path is not a DRYRUN path: ", p));
    }

    function test_Record_ProvisionalAndCanonical_AreDisjointNamespaces() public view {
        string memory prov = harness.artifactPath(VNextDeploySpec.MODE_PROVISIONAL, "x");
        string memory canon = harness.artifactPath(VNextDeploySpec.MODE_CANONICAL, "x");
        assertTrue(keccak256(bytes(prov)) != keccak256(bytes(canon)), "a provisional run can overwrite the canonical record");
    }

    // ── 5. least privilege ───────────────────────────────────────────────────────────────────────

    /// @notice The grant exists for `deployments/vnext` only. The other tracked records under `deployments/`
    ///         (the live Base Sepolia deployment's files) must stay unwritable from any forge test or script.
    ///         Widening the grant to `./deployments` turns this test red, which is its purpose.
    function test_Record_GrantDoesNotReachOtherDeploymentRecords() public {
        try harness.writeFile(OUTSIDE_GRANT, "{}") {
            harness.removeFile(OUTSIDE_GRANT);
            fail("the fs grant reaches tracked deployment records outside deployments/vnext");
        } catch {}
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    function _writeRecord(string memory mode, string memory label, address factory) internal returns (string memory path) {
        path = harness.artifactPath(mode, label);
        vm.createDir(string.concat("deployments/vnext/", VNextDeploySpec.networkSlug(block.chainid)), true);
        vm.writeFile(path, string.concat('{"factory":"', vm.toString(factory), '"}'));
    }

    function _clear(string memory path) internal {
        if (vm.exists(path)) vm.removeFile(path);
    }

    function _assertGuardPasses(string memory mode, string memory label, address predicted) internal {
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.guardAgainstRivalDeployment, (mode, label, predicted)));
        assertTrue(ok, string.concat("guard aborted unexpectedly: ", _reason(ret)));
    }

    function _assertGuardAborts(string memory mode, string memory label, address predicted, string memory fragment)
        internal
    {
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.guardAgainstRivalDeployment, (mode, label, predicted)));
        assertFalse(ok, "the guard did NOT abort");
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

/// @dev Exposes {DeployVNextSettlement}'s record persistence as external entry points. The guard is `view` so the
///      tests can reach it through a STATICCALL; the two file helpers exist only so the least-privilege test can
///      attempt a write through an ordinary external call and catch the refusal.
contract DeployRecordHarness is DeployVNextSettlement {
    function artifactPath(string calldata mode, string calldata label) external view returns (string memory) {
        Inputs memory i;
        i.mode = mode;
        i.label = label;
        return _artifactPath(i);
    }

    function guardAgainstRivalDeployment(string calldata mode, string calldata label, address predictedFactory)
        external
        view
    {
        Inputs memory i;
        i.mode = mode;
        i.label = label;
        _guardAgainstRivalDeployment(i, predictedFactory);
    }

    function writeFile(string calldata path, string calldata data) external {
        vm.writeFile(path, data);
    }

    function removeFile(string calldata path) external {
        vm.removeFile(path);
    }
}
