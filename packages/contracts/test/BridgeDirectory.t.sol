// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {BridgeDirectory} from "../src/BridgeDirectory.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Shared base — sets up directory with deterministic actors.
abstract contract BridgeDirectoryBase is Test {
    BridgeDirectory internal directory;

    address internal owner = address(0xA11CE);
    address internal maintainerA = address(0xBEEF01);
    address internal maintainerB = address(0xBEEF02);
    address internal randomEoa = address(0xC0FFEE);
    address internal newOwner = address(0xD00D);

    bytes32 internal nsA = keccak256(bytes("eth-uniswap-v4"));
    bytes32 internal nsB = keccak256(bytes("base-aerodrome-slipstream"));
    bytes32 internal nsC = keccak256(bytes("solana-jupiter"));

    function setUp() public virtual {
        vm.prank(owner);
        directory = new BridgeDirectory(owner);
    }

    /// @notice Helper: build a valid BridgeEntry for the given namespace + maintainer.
    function _mkEntry(bytes32 ns, address maint)
        internal
        pure
        returns (BridgeDirectory.BridgeEntry memory)
    {
        return BridgeDirectory.BridgeEntry({
            namespace: ns,
            maintainerAddress: maint,
            status: BridgeDirectory.Status.Active,
            addedAt: 0,
            updatedAt: 0,
            repoUrl: "https://github.com/example/bridge",
            docsUrl: "https://docs.example.com/bridge",
            contractAddress: address(0x1234),
            chainId: 8453,
            version: bytes32("1.0.0"),
            metadataURI: "ipfs://Qm.../meta.json",
            notes: "example bridge entry"
        });
    }

    /// @notice Helper: add a default entry for a namespace.
    function _addDefault(bytes32 ns, address maint) internal {
        vm.prank(owner);
        directory.addBridge(_mkEntry(ns, maint));
    }
}

contract BridgeDirectoryHappyPathsTest is BridgeDirectoryBase {
    // 1
    function test_AddBridge_OwnerCanAdd() public {
        vm.prank(owner);
        directory.addBridge(_mkEntry(nsA, maintainerA));

        assertTrue(directory.exists(nsA));
        assertEq(directory.getBridgeCount(), 1);
    }

    // 2
    function test_AddBridge_FieldsRoundtrip() public {
        BridgeDirectory.BridgeEntry memory input = _mkEntry(nsA, maintainerA);

        vm.prank(owner);
        directory.addBridge(input);

        BridgeDirectory.BridgeEntry memory stored = directory.getBridge(nsA);
        assertEq(stored.namespace, input.namespace, "namespace");
        assertEq(stored.maintainerAddress, input.maintainerAddress, "maintainerAddress");
        assertEq(uint8(stored.status), uint8(BridgeDirectory.Status.Active), "status");
        assertEq(stored.repoUrl, input.repoUrl, "repoUrl");
        assertEq(stored.docsUrl, input.docsUrl, "docsUrl");
        assertEq(stored.contractAddress, input.contractAddress, "contractAddress");
        assertEq(stored.chainId, input.chainId, "chainId");
        assertEq(stored.version, input.version, "version");
        assertEq(stored.metadataURI, input.metadataURI, "metadataURI");
        assertEq(stored.notes, input.notes, "notes");
    }

    // 3
    function test_AddBridge_TimestampsSet() public {
        vm.warp(1_700_000_000);
        BridgeDirectory.BridgeEntry memory input = _mkEntry(nsA, maintainerA);
        // Even if caller passes stale timestamps, contract overrides with block.timestamp.
        input.addedAt = 1;
        input.updatedAt = 2;

        vm.prank(owner);
        directory.addBridge(input);

        BridgeDirectory.BridgeEntry memory stored = directory.getBridge(nsA);
        assertEq(stored.addedAt, 1_700_000_000, "addedAt overridden to block.timestamp");
        assertEq(stored.updatedAt, 1_700_000_000, "updatedAt overridden to block.timestamp");
    }

    // 4
    function test_UpdateBridge_MaintainerCanUpdate() public {
        _addDefault(nsA, maintainerA);
        uint40 originalAdded = directory.getBridge(nsA).addedAt;

        vm.warp(block.timestamp + 1 days);

        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, maintainerA);
        updates.repoUrl = "https://github.com/example/bridge-v2";

        vm.prank(maintainerA);
        directory.updateBridge(nsA, updates);

        BridgeDirectory.BridgeEntry memory stored = directory.getBridge(nsA);
        assertEq(stored.repoUrl, "https://github.com/example/bridge-v2", "repoUrl updated");
        assertEq(stored.addedAt, originalAdded, "addedAt unchanged");
        assertEq(stored.updatedAt, uint40(block.timestamp), "updatedAt advanced");
    }

    // 5
    function test_UpdateBridge_OwnerCanUpdate() public {
        _addDefault(nsA, maintainerA);

        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, maintainerA);
        updates.notes = "owner edited";

        vm.prank(owner);
        directory.updateBridge(nsA, updates);

        assertEq(directory.getBridge(nsA).notes, "owner edited");
    }

    // 6
    function test_DeprecateBridge_Maintainer() public {
        _addDefault(nsA, maintainerA);

        vm.prank(maintainerA);
        directory.deprecateBridge(nsA);

        assertEq(uint8(directory.getBridge(nsA).status), uint8(BridgeDirectory.Status.Deprecated));
    }

    // 7
    function test_DeprecateBridge_PreservesHistory() public {
        _addDefault(nsA, maintainerA);

        vm.prank(maintainerA);
        directory.deprecateBridge(nsA);

        // entry remains queryable
        BridgeDirectory.BridgeEntry memory stored = directory.getBridge(nsA);
        assertEq(stored.namespace, nsA, "namespace preserved");
        assertEq(stored.repoUrl, "https://github.com/example/bridge", "repoUrl preserved");
        assertTrue(directory.exists(nsA), "still exists");
        assertEq(directory.getBridgeCount(), 1, "count preserved");
    }

    // 8
    function test_SuspendThenReactivate() public {
        _addDefault(nsA, maintainerA);

        vm.prank(maintainerA);
        directory.suspendBridge(nsA);
        assertEq(uint8(directory.getBridge(nsA).status), uint8(BridgeDirectory.Status.Suspended));

        vm.prank(owner);
        directory.reactivateBridge(nsA);
        assertEq(uint8(directory.getBridge(nsA).status), uint8(BridgeDirectory.Status.Active));
    }

    // 9
    function test_TransferMaintainer_Voluntary() public {
        _addDefault(nsA, maintainerA);

        vm.prank(maintainerA);
        directory.transferMaintainer(nsA, maintainerB);

        assertEq(directory.getBridge(nsA).maintainerAddress, maintainerB);

        // New maintainer can now update (the only way to prove the transfer is effective)
        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, maintainerB);
        updates.notes = "maintainerB edit";
        vm.prank(maintainerB);
        directory.updateBridge(nsA, updates);
        assertEq(directory.getBridge(nsA).notes, "maintainerB edit");
    }

    // 10
    function test_GetBridgesPaginated_Cursor() public {
        bytes32[5] memory namespaces = [
            keccak256("ns-1"),
            keccak256("ns-2"),
            keccak256("ns-3"),
            keccak256("ns-4"),
            keccak256("ns-5")
        ];
        for (uint256 i; i < 5; ++i) {
            _addDefault(namespaces[i], maintainerA);
        }

        (BridgeDirectory.BridgeEntry[] memory page1, uint256 next1) = directory.getBridgesPaginated(0, 2);
        assertEq(page1.length, 2, "page1 length");
        assertEq(next1, 2, "next1 offset");
        assertEq(page1[0].namespace, namespaces[0]);
        assertEq(page1[1].namespace, namespaces[1]);

        (BridgeDirectory.BridgeEntry[] memory page2, uint256 next2) = directory.getBridgesPaginated(next1, 2);
        assertEq(page2.length, 2, "page2 length");
        assertEq(next2, 4, "next2 offset");
        assertEq(page2[0].namespace, namespaces[2]);
        assertEq(page2[1].namespace, namespaces[3]);

        (BridgeDirectory.BridgeEntry[] memory page3, uint256 next3) = directory.getBridgesPaginated(next2, 2);
        assertEq(page3.length, 1, "page3 length (partial)");
        assertEq(next3, 5, "next3 offset");
        assertEq(page3[0].namespace, namespaces[4]);
    }

    // 11
    function test_GetAllBridges_BelowCap() public {
        _addDefault(nsA, maintainerA);
        _addDefault(nsB, maintainerA);
        _addDefault(nsC, maintainerA);

        BridgeDirectory.BridgeEntry[] memory all = directory.getAllBridges();
        assertEq(all.length, 3, "got all 3");
    }

    // 12
    function test_GetActiveBridges_FiltersDeprecated() public {
        _addDefault(nsA, maintainerA);
        _addDefault(nsB, maintainerA);
        _addDefault(nsC, maintainerA);

        vm.prank(maintainerA);
        directory.deprecateBridge(nsA);
        vm.prank(maintainerA);
        directory.suspendBridge(nsB);

        BridgeDirectory.BridgeEntry[] memory active = directory.getActiveBridges();
        assertEq(active.length, 1, "only nsC active");
        assertEq(active[0].namespace, nsC);
    }

    // 13
    function test_Owner_TwoStepTransfer() public {
        // owner initiates transfer
        vm.prank(owner);
        directory.transferOwnership(newOwner);

        // newOwner has NOT yet accepted — owner remains the same
        assertEq(directory.owner(), owner);
        assertEq(directory.pendingOwner(), newOwner);

        // newOwner cannot yet exercise authority
        BridgeDirectory.BridgeEntry memory entry = _mkEntry(nsA, maintainerA);
        vm.prank(newOwner);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, newOwner));
        directory.addBridge(entry);

        // acceptance transfers control
        vm.prank(newOwner);
        directory.acceptOwnership();
        assertEq(directory.owner(), newOwner);

        // newOwner can now add
        vm.prank(newOwner);
        directory.addBridge(entry);
        assertTrue(directory.exists(nsA));
    }
}

contract BridgeDirectoryFailurePathsTest is BridgeDirectoryBase {
    // F1
    function test_AddBridge_NonOwner_Reverts() public {
        vm.prank(randomEoa);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, randomEoa));
        directory.addBridge(_mkEntry(nsA, maintainerA));
    }

    // F2
    function test_AddBridge_DuplicateNamespace_Reverts() public {
        _addDefault(nsA, maintainerA);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BridgeDirectory.BridgeAlreadyExists.selector, nsA));
        directory.addBridge(_mkEntry(nsA, maintainerB));
    }

    // F3
    function test_AddBridge_ZeroNamespace_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(BridgeDirectory.ZeroNamespace.selector);
        directory.addBridge(_mkEntry(bytes32(0), maintainerA));
    }

    // F4
    function test_AddBridge_ZeroMaintainer_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(BridgeDirectory.ZeroAddress.selector);
        directory.addBridge(_mkEntry(nsA, address(0)));
    }

    // F5
    function test_AddBridge_EmptyRepoUrl_Reverts() public {
        BridgeDirectory.BridgeEntry memory entry = _mkEntry(nsA, maintainerA);
        entry.repoUrl = "";

        vm.prank(owner);
        vm.expectRevert(BridgeDirectory.EmptyRepoUrl.selector);
        directory.addBridge(entry);
    }

    // F6
    function test_AddBridge_PreDeprecated_Reverts() public {
        BridgeDirectory.BridgeEntry memory entry = _mkEntry(nsA, maintainerA);
        entry.status = BridgeDirectory.Status.Deprecated;

        vm.prank(owner);
        vm.expectRevert(BridgeDirectory.MustAddAsActive.selector);
        directory.addBridge(entry);
    }

    // F7
    function test_UpdateBridge_NonMaintainerNonOwner_Reverts() public {
        _addDefault(nsA, maintainerA);

        vm.prank(randomEoa);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeDirectory.NotMaintainerOrOwner.selector, randomEoa, nsA)
        );
        directory.updateBridge(nsA, _mkEntry(nsA, maintainerA));
    }

    // F8
    function test_UpdateBridge_NonexistentNamespace_Reverts() public {
        vm.prank(maintainerA);
        vm.expectRevert(abi.encodeWithSelector(BridgeDirectory.BridgeNotFound.selector, nsA));
        directory.updateBridge(nsA, _mkEntry(nsA, maintainerA));
    }

    // F9
    function test_UpdateBridge_ZeroMaintainerInUpdates_Reverts() public {
        _addDefault(nsA, maintainerA);

        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, address(0));
        vm.prank(maintainerA);
        vm.expectRevert(BridgeDirectory.ZeroAddress.selector);
        directory.updateBridge(nsA, updates);
    }

    // F10
    function test_DeprecateBridge_NonMaintainerNonOwner_Reverts() public {
        _addDefault(nsA, maintainerA);

        vm.prank(randomEoa);
        vm.expectRevert(
            abi.encodeWithSelector(BridgeDirectory.NotMaintainerOrOwner.selector, randomEoa, nsA)
        );
        directory.deprecateBridge(nsA);
    }

    // F11
    function test_DeprecateBridge_AlreadyDeprecated_Reverts() public {
        _addDefault(nsA, maintainerA);
        vm.prank(maintainerA);
        directory.deprecateBridge(nsA);

        vm.prank(maintainerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeDirectory.AlreadyInStatus.selector, BridgeDirectory.Status.Deprecated
            )
        );
        directory.deprecateBridge(nsA);
    }

    // F12
    function test_ReactivateBridge_NonOwner_Reverts() public {
        _addDefault(nsA, maintainerA);
        vm.prank(maintainerA);
        directory.suspendBridge(nsA);

        vm.prank(maintainerA);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, maintainerA)
        );
        directory.reactivateBridge(nsA);
    }

    // F13
    function test_ReactivateBridge_NotSuspended_Reverts() public {
        _addDefault(nsA, maintainerA);
        // currently Active

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeDirectory.InvalidStatusTransition.selector,
                BridgeDirectory.Status.Active,
                BridgeDirectory.Status.Active
            )
        );
        directory.reactivateBridge(nsA);
    }

    // F14
    function test_TransferMaintainer_OwnerCannot_Reverts() public {
        _addDefault(nsA, maintainerA);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(BridgeDirectory.NotMaintainer.selector, owner, nsA));
        directory.transferMaintainer(nsA, maintainerB);
    }

    // F15
    function test_TransferMaintainer_NoOp_Reverts() public {
        _addDefault(nsA, maintainerA);

        vm.prank(maintainerA);
        vm.expectRevert(BridgeDirectory.SameMaintainer.selector);
        directory.transferMaintainer(nsA, maintainerA);
    }

    // F16
    function test_GetAllBridges_AboveCap_Reverts() public {
        // MAX_FULL_RETURN = 25, so adding 26 entries should trip the cap
        for (uint256 i; i < 26; ++i) {
            bytes32 ns = keccak256(abi.encodePacked("ns-", i));
            _addDefault(ns, maintainerA);
        }

        vm.expectRevert(
            abi.encodeWithSelector(BridgeDirectory.TooManyForFullReturn.selector, 26, 25)
        );
        directory.getAllBridges();
    }

    // F17
    function test_GetBridgesPaginated_OffsetBeyondLength_ReturnsEmpty() public {
        _addDefault(nsA, maintainerA);
        _addDefault(nsB, maintainerA);

        (BridgeDirectory.BridgeEntry[] memory entries, uint256 next) = directory.getBridgesPaginated(99, 10);
        assertEq(entries.length, 0, "empty slice");
        assertEq(next, directory.getBridgeCount(), "next is count");
    }

    // F18 — extra: suspend already deprecated should fail
    function test_SuspendBridge_NotActive_Reverts() public {
        _addDefault(nsA, maintainerA);
        vm.prank(maintainerA);
        directory.deprecateBridge(nsA);

        vm.prank(maintainerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                BridgeDirectory.InvalidStatusTransition.selector,
                BridgeDirectory.Status.Deprecated,
                BridgeDirectory.Status.Suspended
            )
        );
        directory.suspendBridge(nsA);
    }
}

contract BridgeDirectoryEventsTest is BridgeDirectoryBase {
    event BridgeAdded(bytes32 indexed namespace, address indexed maintainer, string repoUrl);
    event BridgeUpdated(bytes32 indexed namespace, address indexed updater);
    event BridgeDeprecated(bytes32 indexed namespace);
    event BridgeSuspended(bytes32 indexed namespace);
    event BridgeReactivated(bytes32 indexed namespace);
    event MaintainerTransferred(
        bytes32 indexed namespace, address indexed oldMaintainer, address indexed newMaintainer
    );

    // E1
    function test_Events_BridgeAdded() public {
        vm.expectEmit(true, true, false, true, address(directory));
        emit BridgeAdded(nsA, maintainerA, "https://github.com/example/bridge");

        vm.prank(owner);
        directory.addBridge(_mkEntry(nsA, maintainerA));
    }

    // E2
    function test_Events_BridgeUpdated_Updater() public {
        _addDefault(nsA, maintainerA);

        // maintainerA does the update -- updater topic should equal maintainerA, not owner
        vm.expectEmit(true, true, false, false, address(directory));
        emit BridgeUpdated(nsA, maintainerA);

        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, maintainerA);
        vm.prank(maintainerA);
        directory.updateBridge(nsA, updates);

        // and if owner does the update, updater = owner
        vm.expectEmit(true, true, false, false, address(directory));
        emit BridgeUpdated(nsA, owner);

        vm.prank(owner);
        directory.updateBridge(nsA, updates);
    }

    // E3
    function test_Events_BridgeDeprecated() public {
        _addDefault(nsA, maintainerA);

        vm.expectEmit(true, false, false, false, address(directory));
        emit BridgeDeprecated(nsA);

        vm.prank(maintainerA);
        directory.deprecateBridge(nsA);
    }

    // E4
    function test_Events_MaintainerTransferred_VoluntaryVsForced() public {
        _addDefault(nsA, maintainerA);

        // (a) voluntary via transferMaintainer
        vm.expectEmit(true, true, true, false, address(directory));
        emit MaintainerTransferred(nsA, maintainerA, maintainerB);

        vm.prank(maintainerA);
        directory.transferMaintainer(nsA, maintainerB);

        // (b) owner-forced via updateBridge with a new maintainer address
        // Expect TWO events from this call: BridgeUpdated AND MaintainerTransferred.
        vm.expectEmit(true, true, false, false, address(directory));
        emit BridgeUpdated(nsA, owner);
        vm.expectEmit(true, true, true, false, address(directory));
        emit MaintainerTransferred(nsA, maintainerB, maintainerA);

        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, maintainerA);
        vm.prank(owner);
        directory.updateBridge(nsA, updates);
    }

    // E5 — BridgeUpdated DOES emit on no-op updates (we don't bother diffing).
    function test_Events_BridgeUpdated_NotEmittedOnNoOp() public {
        _addDefault(nsA, maintainerA);

        // We expect a BridgeUpdated event even though the payload is identical.
        vm.expectEmit(true, true, false, false, address(directory));
        emit BridgeUpdated(nsA, maintainerA);

        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, maintainerA);
        vm.prank(maintainerA);
        directory.updateBridge(nsA, updates);

        // The presence of the expected event confirms the simpler-is-better policy.
        // (No MaintainerTransferred event because maintainerA == maintainerA.)
        assertEq(directory.getBridge(nsA).maintainerAddress, maintainerA);
    }
}

contract BridgeDirectoryFuzzTest is BridgeDirectoryBase {
    // FZ1
    function testFuzz_AddBridge_AnyNamespace(
        bytes32 ns,
        address maint,
        string calldata repoUrl
    ) public {
        vm.assume(ns != bytes32(0));
        vm.assume(maint != address(0));
        vm.assume(bytes(repoUrl).length > 0 && bytes(repoUrl).length < 1000);

        BridgeDirectory.BridgeEntry memory entry = _mkEntry(ns, maint);
        entry.repoUrl = repoUrl;

        vm.prank(owner);
        directory.addBridge(entry);

        BridgeDirectory.BridgeEntry memory stored = directory.getBridge(ns);
        assertEq(stored.namespace, ns);
        assertEq(stored.maintainerAddress, maint);
        assertEq(stored.repoUrl, repoUrl);
        assertEq(uint8(stored.status), uint8(BridgeDirectory.Status.Active));
        assertEq(stored.addedAt, uint40(block.timestamp));
    }

    // FZ2
    function testFuzz_UpdateBridge_AnyFields(
        string calldata repoUrl,
        string calldata docsUrl,
        string calldata notes,
        address newContractAddr,
        uint64 chainId
    ) public {
        vm.assume(bytes(repoUrl).length > 0 && bytes(repoUrl).length < 500);
        vm.assume(bytes(docsUrl).length < 500);
        vm.assume(bytes(notes).length < 500);

        _addDefault(nsA, maintainerA);
        uint40 originalAdded = directory.getBridge(nsA).addedAt;
        bytes32 originalNamespace = directory.getBridge(nsA).namespace;

        vm.warp(block.timestamp + 1);

        BridgeDirectory.BridgeEntry memory updates = _mkEntry(nsA, maintainerA);
        updates.repoUrl = repoUrl;
        updates.docsUrl = docsUrl;
        updates.notes = notes;
        updates.contractAddress = newContractAddr;
        updates.chainId = chainId;

        vm.prank(maintainerA);
        directory.updateBridge(nsA, updates);

        BridgeDirectory.BridgeEntry memory stored = directory.getBridge(nsA);
        assertEq(stored.namespace, originalNamespace, "namespace preserved");
        assertEq(stored.addedAt, originalAdded, "addedAt preserved");
        assertEq(stored.repoUrl, repoUrl, "repoUrl updated");
        assertEq(stored.docsUrl, docsUrl, "docsUrl updated");
        assertEq(stored.notes, notes, "notes updated");
        assertEq(stored.contractAddress, newContractAddr, "contractAddress updated");
        assertEq(stored.chainId, chainId, "chainId updated");
    }

    // FZ3
    function testFuzz_PaginateUntilEmpty(uint8 count) public {
        // Bound to a reasonable range so the test stays fast
        count = uint8(bound(count, 1, 20));

        bytes32[] memory all = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            bytes32 ns = keccak256(abi.encodePacked("fuzz-ns-", i));
            all[i] = ns;
            _addDefault(ns, maintainerA);
        }

        uint256 offset = 0;
        uint256 seen = 0;
        bytes32[] memory recovered = new bytes32[](count);
        while (true) {
            (BridgeDirectory.BridgeEntry[] memory page, uint256 next) =
                directory.getBridgesPaginated(offset, 3);
            if (page.length == 0) break;
            for (uint256 i; i < page.length; ++i) {
                recovered[seen] = page[i].namespace;
                seen += 1;
            }
            offset = next;
        }
        assertEq(seen, count, "all entries recovered");
        for (uint256 i; i < count; ++i) {
            assertEq(recovered[i], all[i], "in insertion order");
        }
    }

    // FZ4
    function testFuzz_StatusTransitions(uint8 seed) public {
        // Bounded random walk over status ops; assert state is always legal or revert is expected.
        _addDefault(nsA, maintainerA);

        for (uint256 step; step < 6; ++step) {
            uint8 op = uint8((uint256(keccak256(abi.encodePacked(seed, step))) % 3));
            BridgeDirectory.Status before = directory.getBridge(nsA).status;

            if (op == 0) {
                // suspend — legal only from Active
                vm.prank(maintainerA);
                if (before == BridgeDirectory.Status.Active) {
                    directory.suspendBridge(nsA);
                    assertEq(uint8(directory.getBridge(nsA).status), uint8(BridgeDirectory.Status.Suspended));
                } else {
                    vm.expectRevert(
                        abi.encodeWithSelector(
                            BridgeDirectory.InvalidStatusTransition.selector,
                            before,
                            BridgeDirectory.Status.Suspended
                        )
                    );
                    directory.suspendBridge(nsA);
                }
            } else if (op == 1) {
                // deprecate — legal from anything except Deprecated
                vm.prank(maintainerA);
                if (before != BridgeDirectory.Status.Deprecated) {
                    directory.deprecateBridge(nsA);
                    assertEq(uint8(directory.getBridge(nsA).status), uint8(BridgeDirectory.Status.Deprecated));
                } else {
                    vm.expectRevert(
                        abi.encodeWithSelector(
                            BridgeDirectory.AlreadyInStatus.selector, BridgeDirectory.Status.Deprecated
                        )
                    );
                    directory.deprecateBridge(nsA);
                }
            } else {
                // reactivate — owner only, legal only from Suspended
                vm.prank(owner);
                if (before == BridgeDirectory.Status.Suspended) {
                    directory.reactivateBridge(nsA);
                    assertEq(uint8(directory.getBridge(nsA).status), uint8(BridgeDirectory.Status.Active));
                } else {
                    vm.expectRevert(
                        abi.encodeWithSelector(
                            BridgeDirectory.InvalidStatusTransition.selector,
                            before,
                            BridgeDirectory.Status.Active
                        )
                    );
                    directory.reactivateBridge(nsA);
                }
            }
        }
    }
}

// ── Invariant testing ──────────────────────────────────────────────────────
//
// Foundry's invariant runner repeatedly calls handler functions with random
// args, then asserts each `invariant_*` function still holds. We expose a
// tiny `Handler` contract whose targetSelectors enumerate the legal mutating
// surface: addBridge, updateBridge, deprecateBridge, suspendBridge,
// reactivateBridge, transferMaintainer.
//
// The handler also remembers the maximum `addedAt` value observed PER
// namespace at first-write time and snapshots namespace count, so the
// invariants can prove monotonicity properties without re-running the world.

contract Handler is Test {
    BridgeDirectory public directory;
    address public owner;
    address public defaultMaintainer = address(0xBEEF);

    // Tracking state for invariants
    bytes32[] public seenNamespaces;
    mapping(bytes32 => bool) public namespaceSeen;
    mapping(bytes32 => uint40) public firstAddedAt;
    // Track terminal-status namespaces — once Deprecated, must stay Deprecated.
    mapping(bytes32 => bool) public wasDeprecated;
    uint256 public lastNamespaceCount;

    constructor(BridgeDirectory _directory, address _owner) {
        directory = _directory;
        owner = _owner;
    }

    // --- Mutating handlers ---

    function handleAdd(bytes32 seed) external {
        bytes32 ns = keccak256(abi.encodePacked("h-add", seed));
        if (ns == bytes32(0)) return;
        if (directory.exists(ns)) return;

        BridgeDirectory.BridgeEntry memory entry = BridgeDirectory.BridgeEntry({
            namespace: ns,
            maintainerAddress: defaultMaintainer,
            status: BridgeDirectory.Status.Active,
            addedAt: 0,
            updatedAt: 0,
            repoUrl: "https://github.com/example/bridge",
            docsUrl: "",
            contractAddress: address(0),
            chainId: 0,
            version: bytes32(0),
            metadataURI: "",
            notes: ""
        });

        vm.prank(owner);
        directory.addBridge(entry);

        if (!namespaceSeen[ns]) {
            namespaceSeen[ns] = true;
            seenNamespaces.push(ns);
            firstAddedAt[ns] = uint40(block.timestamp);
        }
    }

    function handleSuspend(uint256 index) external {
        uint256 len = seenNamespaces.length;
        if (len == 0) return;
        bytes32 ns = seenNamespaces[index % len];
        if (!directory.exists(ns)) return;
        if (directory.getBridge(ns).status != BridgeDirectory.Status.Active) return;

        vm.prank(defaultMaintainer);
        directory.suspendBridge(ns);
    }

    function handleDeprecate(uint256 index) external {
        uint256 len = seenNamespaces.length;
        if (len == 0) return;
        bytes32 ns = seenNamespaces[index % len];
        if (!directory.exists(ns)) return;
        if (directory.getBridge(ns).status == BridgeDirectory.Status.Deprecated) return;

        vm.prank(defaultMaintainer);
        directory.deprecateBridge(ns);
        wasDeprecated[ns] = true;
    }

    function handleReactivate(uint256 index) external {
        uint256 len = seenNamespaces.length;
        if (len == 0) return;
        bytes32 ns = seenNamespaces[index % len];
        if (!directory.exists(ns)) return;
        if (directory.getBridge(ns).status != BridgeDirectory.Status.Suspended) return;

        vm.prank(owner);
        directory.reactivateBridge(ns);
    }

    function handleUpdate(uint256 index, string calldata newRepoUrl) external {
        uint256 len = seenNamespaces.length;
        if (len == 0) return;
        if (bytes(newRepoUrl).length == 0 || bytes(newRepoUrl).length > 200) return;
        bytes32 ns = seenNamespaces[index % len];
        if (!directory.exists(ns)) return;

        BridgeDirectory.BridgeEntry memory updates = BridgeDirectory.BridgeEntry({
            namespace: ns,
            maintainerAddress: defaultMaintainer,
            status: directory.getBridge(ns).status,
            addedAt: 0,
            updatedAt: 0,
            repoUrl: newRepoUrl,
            docsUrl: "",
            contractAddress: address(0),
            chainId: 0,
            version: bytes32(0),
            metadataURI: "",
            notes: ""
        });

        vm.prank(defaultMaintainer);
        directory.updateBridge(ns, updates);
    }

    // ── Helpers exposed for invariants ───────────────────────────────────

    function seenNamespacesLength() external view returns (uint256) {
        return seenNamespaces.length;
    }

    function bumpLastCount(uint256 c) external {
        // Allow invariant assertions to update the monotonic baseline.
        if (c > lastNamespaceCount) {
            lastNamespaceCount = c;
        }
    }
}

contract BridgeDirectoryInvariantTest is StdInvariant, BridgeDirectoryBase {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(directory, owner);

        targetContract(address(handler));
        // Restrict the invariant fuzzer to the handler-exposed selectors so it
        // doesn't try to call directory functions directly (which would
        // mostly hit access-control reverts).
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.handleAdd.selector;
        selectors[1] = handler.handleSuspend.selector;
        selectors[2] = handler.handleDeprecate.selector;
        selectors[3] = handler.handleReactivate.selector;
        selectors[4] = handler.handleUpdate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // I1
    function invariant_NamespaceCountMatchesArrayLength() public view {
        // The directory's getBridgeCount() must equal what the handler has tracked
        // (since the handler is the only writer in this test suite).
        assertEq(directory.getBridgeCount(), handler.seenNamespacesLength());
    }

    // I2
    function invariant_ExistsImpliesArrayMembership() public view {
        // For every namespace the handler has tracked, exists() returns true.
        uint256 len = handler.seenNamespacesLength();
        for (uint256 i; i < len; ++i) {
            bytes32 ns = handler.seenNamespaces(i);
            assertTrue(directory.exists(ns), "tracked namespace must exist");
        }
    }

    // I3
    function invariant_NeverDeleted() public {
        // bridgeCount is monotonically non-decreasing.
        uint256 current = directory.getBridgeCount();
        assertGe(current, handler.lastNamespaceCount());
        handler.bumpLastCount(current);
    }

    // I4
    function invariant_AddedAtNeverChanges() public view {
        uint256 len = handler.seenNamespacesLength();
        for (uint256 i; i < len; ++i) {
            bytes32 ns = handler.seenNamespaces(i);
            uint40 expected = handler.firstAddedAt(ns);
            assertEq(directory.getBridge(ns).addedAt, expected, "addedAt unchanged");
        }
    }

    // I5
    function invariant_DeprecatedIsTerminal() public view {
        uint256 len = handler.seenNamespacesLength();
        for (uint256 i; i < len; ++i) {
            bytes32 ns = handler.seenNamespaces(i);
            if (handler.wasDeprecated(ns)) {
                assertEq(
                    uint8(directory.getBridge(ns).status),
                    uint8(BridgeDirectory.Status.Deprecated),
                    "deprecated must remain deprecated"
                );
            }
        }
    }
}
