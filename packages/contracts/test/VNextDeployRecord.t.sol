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
 *           5. the grant does NOT reach the other tracked records under `deployments/` (least privilege);
 *           6. `VNEXT_LABEL` cannot steer the record path: traversal, separators, dots, control characters and
 *              over-long labels are refused, and a canonical run carries no label (sol review of #339);
 *           7. a symlink under the record root refuses the read and the write, because `fs_permissions` alone
 *              does not contain a write that goes through a symlinked directory or a dangling symlink.
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

    /// @dev A committed fixture holding a symlinked directory (`parent-link -> real`) and a dangling symlink
    ///      (`dangling.json -> does-not-exist.json`). `foundry.toml` grants READ on it and nothing else, so the
    ///      refusal is exercised without any test ever creating a link.
    string internal constant SYMLINK_FIXTURE = "test/fixtures/fs-symlinks";

    string internal constant LABEL_CHARSET = "VNEXT_LABEL may contain only A-Z a-z 0-9 - _";
    string internal constant LABEL_LENGTH = "VNEXT_LABEL must be 1-64 characters";

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

    // ── 6. the label cannot steer the path ───────────────────────────────────────────────────────

    function test_Label_AcceptsShortAsciiSlugs() public view {
        harness.requireValidLabel(VNextDeploySpec.MODE_PROVISIONAL, "run-1");
        harness.requireValidLabel(VNextDeploySpec.MODE_PROVISIONAL, "A_z-09");
        harness.requireValidLabel(VNextDeploySpec.MODE_PROVISIONAL, _repeat("a", 64));
        harness.requireValidLabel(VNextDeploySpec.MODE_CANONICAL, "");
        // and an accepted label lands exactly where it should: one filename under the network directory
        assertEq(
            harness.artifactPath(VNextDeploySpec.MODE_PROVISIONAL, "run-1"),
            "deployments/vnext/anvil/DRYRUN-PROVISIONAL-run-1.json"
        );
    }

    /// @notice The reviewer's traversal cases, and every separator, dot or control character that could build one.
    function test_Label_RefusesTraversalSeparatorsAndControlCharacters() public {
        string[] memory bad = new string[](11);
        bad[0] = "/../../base-sepolia/PCCProtocolV2"; // normalizes inside vnext, onto another network's name
        bad[1] = "/../../../base-sepolia/PCCProtocolV2"; // normalizes onto the tracked Base Sepolia record
        bad[2] = "/../CANONICAL"; // a provisional run landing on the canonical record
        bad[3] = "..";
        bad[4] = ".";
        bad[5] = "a/b";
        bad[6] = "a\\b"; // Windows separator
        bad[7] = "a b";
        bad[8] = "a.b";
        bad[9] = "run\n1";
        bad[10] = unicode"é";
        for (uint256 k; k < bad.length; ++k) {
            _assertLabelRefused(VNextDeploySpec.MODE_PROVISIONAL, bad[k], LABEL_CHARSET);
        }
    }

    /// @notice The WIRING, not just the validator: `_readInputs` refuses a bad label before it reads a single
    ///         environment variable. Without the check this call would fail on the missing `VNEXT_EAS` instead.
    function test_Label_IsCheckedBeforeAnyInputIsRead() public {
        try harness.readInputs(VNextDeploySpec.MODE_PROVISIONAL, "/../CANONICAL") {
            fail("_readInputs accepted a traversal label");
        } catch Error(string memory reason) {
            assertEq(reason, LABEL_CHARSET, "_readInputs did not refuse the label first");
        }
    }

    function test_Label_RefusesEmptyAndOverlong() public {
        _assertLabelRefused(VNextDeploySpec.MODE_PROVISIONAL, "", LABEL_LENGTH);
        _assertLabelRefused(VNextDeploySpec.MODE_PROVISIONAL, _repeat("a", 65), LABEL_LENGTH);
    }

    /// @notice `run()` passes "", so a label in canonical mode could only come from a stray `VNEXT_LABEL` in
    ///         `predict()`, which would then predict canonical addresses that `run()` never deploys.
    function test_Label_CanonicalCarriesNoLabel() public {
        _assertLabelRefused(VNextDeploySpec.MODE_CANONICAL, "x", "VNEXT_LABEL must be empty for a canonical deployment");
    }

    // ── 7. symlinks under the record root ────────────────────────────────────────────────────────

    function test_Symlinks_AreRefused() public {
        // A checkout without symlink support (git core.symlinks=false, e.g. some Windows setups) turns the links
        // into plain files. The property is then untestable in that checkout, not false. CI (Linux) has real links.
        if (_symlinkCount(SYMLINK_FIXTURE) < 2) vm.skip(true);
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.assertNoSymlinksUnder, (SYMLINK_FIXTURE)));
        assertFalse(ok, "a symlink under the root was not refused");
        string memory reason = _reason(ret);
        assertTrue(_contains(reason, "symlink under the deployment record root"), string.concat("wrong refusal: ", reason));
    }

    /// @notice The WIRING: the rival-deployment guard refuses a symlinked record root before it reads any record.
    function test_Symlinks_GuardRefusesBeforeReadingTheRecord() public {
        if (_symlinkCount(SYMLINK_FIXTURE) < 2) vm.skip(true);
        harness.setRecordRoot(SYMLINK_FIXTURE);
        _assertGuardAborts(VNextDeploySpec.MODE_PROVISIONAL, "run-1", FACTORY_A, "symlink under the deployment record root");
    }

    function test_Symlinks_RealRecordTreePasses() public {
        string memory path = _writeRecord(VNextDeploySpec.MODE_PROVISIONAL, "symlink-clean", FACTORY_A);
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.assertNoSymlinksUnder, ("deployments/vnext")));
        assertTrue(ok, string.concat("a record tree with no symlinks was refused: ", _reason(ret)));
        _clear(path);
    }

    // ── helpers ──────────────────────────────────────────────────────────────────────────────────

    function _assertLabelRefused(string memory mode, string memory label, string memory message) internal {
        try harness.requireValidLabel(mode, label) {
            fail(string.concat("label accepted: ", label));
        } catch Error(string memory reason) {
            assertEq(reason, message, string.concat("label refused for the wrong reason: ", label));
        }
    }

    function _repeat(string memory unit, uint256 n) internal pure returns (string memory r) {
        for (uint256 k; k < n; ++k) {
            r = string.concat(r, unit);
        }
    }

    function _symlinkCount(string memory dir) internal view returns (uint256 count) {
        Vm.DirEntry[] memory entries = vm.readDir(dir, 3);
        for (uint256 k; k < entries.length; ++k) {
            if (entries[k].isSymlink) ++count;
        }
    }

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

    function requireValidLabel(string calldata mode, string calldata label) external pure {
        _requireValidLabel(mode, label);
    }

    function readInputs(string calldata mode, string calldata label) external view {
        _readInputs(mode, label);
    }

    /// @dev Empty means the script's real root. Each test gets a fresh harness from `setUp`.
    string internal recordRootOverride;

    function setRecordRoot(string calldata root) external {
        recordRootOverride = root;
    }

    function _recordRoot() internal view override returns (string memory) {
        return bytes(recordRootOverride).length != 0 ? recordRootOverride : super._recordRoot();
    }

    function assertNoSymlinksUnder(string calldata root) external view {
        _assertNoSymlinksUnder(root);
    }

    function removeFile(string calldata path) external {
        vm.removeFile(path);
    }
}
