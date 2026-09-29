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
 *           7. the record root is contained, and the guard and the writer both check it before touching a record,
 *              because `fs_permissions` alone does not contain a write that goes through a symlink:
 *                - the root must exist as a directory (a missing or dangling root is refused);
 *                - no symlink AT or ABOVE it (a symlinked root and a symlinked ancestor are refused);
 *                - no symlink BELOW it at any depth (a directory link, a dangling link and a link five levels
 *                  down are each refused on their own), and any entry forge cannot inspect is refused.
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

    /// @dev Committed fixtures (test/fixtures/fs-symlinks/README.md). `foundry.toml` grants READ on each fixture
    ///      root separately and on nothing wider, so every refusal is exercised without a test creating a link.
    ///      `walk/*` each hold ONE kind of link, so each kind is refused on its own.
    string internal constant WALK = "test/fixtures/fs-symlinks/walk";
    string internal constant ROOTS = "test/fixtures/fs-symlinks/roots";

    string internal constant BELOW = "symlink under the deployment record root";
    string internal constant AT_OR_ABOVE = "the deployment record root, or a directory above it, is a symlink";
    string internal constant NOT_A_DIR = "the deployment record root is missing or not a directory";
    string internal constant UNINSPECTABLE = "cannot inspect the deployment record root";

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

    // ── 7. the record root is contained ──────────────────────────────────────────────────────────

    /// @notice No grant reaches ABOVE the record root, not even to read. On forge 1.7.1 the at-or-above check detects a
    ///         symlinked root by forge REFUSING to look below it, which only happens while no grant covers the
    ///         probe path's lexical form. A read grant on `./deployments` or on the project root would silently
    ///         disarm that on 1.7.1 (1.8.0 compares the resolved path instead), so it must turn this test red.
    function test_Root_NoGrantReachesAboveTheRecordRoot() public {
        try harness.readDirOnce("deployments") {
            fail("a grant reaches deployments/ itself");
        } catch {}
        try harness.readDirOnce(".") {
            fail("a grant reaches the project root");
        } catch {}
    }

    /// @notice The real, committed record root passes, with a record in it.
    function test_Root_RealRecordTreePasses() public {
        string memory path = _writeRecord(VNextDeploySpec.MODE_PROVISIONAL, "symlink-clean", FACTORY_A);
        _assertContained("deployments/vnext");
        _clear(path);
    }

    function test_Root_RealFixtureRootPasses() public {
        _requireLinks();
        _assertContained(string.concat(ROOTS, "/real"));
    }

    /// @notice The root itself is a symlink (`roots/link -> real`). `isDir` follows the link and says yes; only
    ///         forge's refusal to look below it gives it away.
    function test_Root_SymlinkedRootIsRefused() public {
        _requireLinks();
        _assertRefused(string.concat(ROOTS, "/link"), AT_OR_ABOVE, "roots/link");
    }

    /// @notice A directory ABOVE the root is a symlink (`roots/parent-link -> parent-real`), the root below it real.
    ///         This is the shape that let forge create `deployments/vnext/<network>` inside a link's target.
    function test_Root_SymlinkedAncestorIsRefused() public {
        _requireLinks();
        _assertRefused(string.concat(ROOTS, "/parent-link/root"), AT_OR_ABOVE, "roots/parent-link/root");
    }

    function test_Root_DanglingRootIsRefused() public {
        _requireLinks();
        _assertRefused(string.concat(ROOTS, "/dangling"), NOT_A_DIR, "roots/dangling");
    }

    /// @notice A symlinked root whose target holds an entry at the probe path. Forge then CAN answer for the probe
    ///         (it exists, so its links are resolved), and only the check's `!present` stands between that answer
    ///         and a pass.
    function test_Root_PlantedProbeIsRefused() public {
        _requireLinks();
        _assertRefused(string.concat(ROOTS, "/planted-link"), "an entry exists at the deployment record root's probe path", "roots/planted-link");
    }

    /// @notice A missing root is refused rather than created: creating it would follow a symlinked ancestor.
    function test_Root_MissingRootIsRefused() public view {
        _assertRefused(string.concat(ROOTS, "/absent"), NOT_A_DIR, "roots/absent");
    }

    function test_Walk_CleanTreePasses() public view {
        _assertWalkPasses(string.concat(WALK, "/clean"));
    }

    function test_Walk_DirectoryLinkIsRefused() public {
        _requireLinks();
        _assertWalkRefused(string.concat(WALK, "/dir-link"), BELOW, "walk/dir-link/parent-link");
    }

    function test_Walk_DanglingLinkIsRefused() public {
        _requireLinks();
        _assertWalkRefused(string.concat(WALK, "/dangling"), BELOW, "walk/dangling/dangling.json");
    }

    /// @notice Five levels down. The walk used to stop at depth 3 and never saw this link.
    function test_Walk_DeepLinkIsRefused() public {
        _requireLinks();
        _assertWalkRefused(string.concat(WALK, "/deep"), BELOW, "walk/deep/a/b/c/d/deep-link");
    }

    /// @notice The walk on its own also refuses a root that resolves elsewhere: forge lists the link target's entries
    ///         under the RESOLVED path, which is not under the root's lexical path. (The full check stops this case
    ///         earlier; this pins the walk's own defense.)
    function test_Walk_EntriesListedOutsideTheRootAreRefused() public {
        _requireLinks();
        _assertWalkRefused(string.concat(ROOTS, "/link"), "forge listed an entry outside the deployment record root's path", "roots/real/README.md");
    }

    /// @notice An entry forge reports it could not inspect is refused, never taken to have vanished. `readDir` on a
    ///         path that does not exist returns exactly such an entry, so this reaches the error branch for certain.
    function test_Walk_InspectionErrorIsRefused() public view {
        _assertWalkRefused(string.concat(WALK, "/no-such-dir"), UNINSPECTABLE, "walk/no-such-dir");
    }

    /// @notice The WIRING: the rival-deployment guard checks the root (at or above) before it reads any record...
    function test_Wiring_GuardRefusesASymlinkedRoot() public {
        _requireLinks();
        harness.setRecordRoot(string.concat(ROOTS, "/link"));
        _assertGuardAborts(VNextDeploySpec.MODE_PROVISIONAL, "run-1", FACTORY_A, AT_OR_ABOVE);
    }

    /// @notice ...and walks the tree below it.
    function test_Wiring_GuardRefusesALinkBelowTheRoot() public {
        _requireLinks();
        harness.setRecordRoot(string.concat(WALK, "/dir-link"));
        _assertGuardAborts(VNextDeploySpec.MODE_PROVISIONAL, "run-1", FACTORY_A, BELOW);
    }

    /// @notice The WIRING on the write side: `_writeArtifact` refuses before it creates or writes anything. Without
    ///         its check, this empty tuple would fail the writer's next gate (the settlement-asset check), and a real
    ///         one would reach forge's write refusal on the read-only fixture: a different message either way.
    function test_Wiring_WriterRefusesASymlinkedRoot() public {
        _requireLinks();
        harness.setRecordRoot(string.concat(ROOTS, "/link"));
        _assertWriterAborts(AT_OR_ABOVE);
    }

    function test_Wiring_WriterRefusesALinkBelowTheRoot() public {
        _requireLinks();
        harness.setRecordRoot(string.concat(WALK, "/dir-link"));
        _assertWriterAborts(BELOW);
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

    /// @dev A checkout without symlink support (git core.symlinks=false, e.g. some Windows setups) turns the fixture
    ///      links into plain files. The properties are then untestable in that checkout, not false, so the tests
    ///      that need a link skip. CI (Linux) has real links. `walk/` holds three links; `roots/` is checked out the
    ///      same way, and `roots/` itself is deliberately not granted, so it cannot be listed here.
    function _requireLinks() internal {
        uint256 count;
        Vm.DirEntry[] memory entries = vm.readDir(WALK, type(uint64).max);
        for (uint256 k; k < entries.length; ++k) {
            if (entries[k].isSymlink) ++count;
        }
        if (count < 3) vm.skip(true);
    }

    function _assertContained(string memory root) internal view {
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.assertRecordRootContained, (root)));
        assertTrue(ok, string.concat("a contained record root was refused: ", _reason(ret)));
    }

    /// @dev Refused by the FULL check, for the stated reason, naming the offending path.
    function _assertRefused(string memory root, string memory fragment, string memory named) internal view {
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.assertRecordRootContained, (root)));
        assertFalse(ok, string.concat("not refused: ", root));
        string memory reason = _reason(ret);
        assertTrue(_contains(reason, fragment), string.concat("refused for the wrong reason: ", reason));
        assertTrue(_contains(reason, named), string.concat("the refusal does not name ", named, ": ", reason));
    }

    function _assertWalkPasses(string memory root) internal view {
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.assertNoSymlinksBelow, (root)));
        assertTrue(ok, string.concat("a tree with no symlinks was refused: ", _reason(ret)));
    }

    /// @dev Refused by the WALK ALONE, so each walk property is proven without the root check in front of it.
    function _assertWalkRefused(string memory root, string memory fragment, string memory named) internal view {
        (bool ok, bytes memory ret) =
            address(harness).staticcall(abi.encodeCall(DeployRecordHarness.assertNoSymlinksBelow, (root)));
        assertFalse(ok, string.concat("the walk did not refuse: ", root));
        string memory reason = _reason(ret);
        assertTrue(_contains(reason, fragment), string.concat("refused for the wrong reason: ", reason));
        assertTrue(_contains(reason, named), string.concat("the refusal does not name ", named, ": ", reason));
    }

    function _assertWriterAborts(string memory fragment) internal {
        try harness.writeArtifactProvisional("wiring") {
            fail("_writeArtifact wrote under an uncontained record root");
        } catch Error(string memory reason) {
            assertTrue(_contains(reason, fragment), string.concat("_writeArtifact failed for the wrong reason: ", reason));
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

    function assertRecordRootContained(string calldata root) external view {
        _assertRecordRootContained(root);
    }

    function assertNoSymlinksBelow(string calldata root) external view {
        _assertNoSymlinksBelow(root);
    }

    function readDirOnce(string calldata path) external view returns (uint256) {
        return vm.readDir(path, 1).length;
    }

    /// @dev The real writer, with an empty tuple. Its containment check is its first statement, so the tuple's
    ///      content never matters to the wiring tests.
    function writeArtifactProvisional(string calldata label) external {
        Inputs memory i;
        i.mode = VNextDeploySpec.MODE_PROVISIONAL;
        i.label = label;
        Tuple memory t;
        _writeArtifact(i, t);
    }

    function removeFile(string calldata path) external {
        vm.removeFile(path);
    }
}
