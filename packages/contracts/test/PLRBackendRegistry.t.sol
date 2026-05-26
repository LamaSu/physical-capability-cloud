// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/PLRBackendRegistry.sol";
import "../src/ContributorNFT.sol";
import "../src/RateScheduleRegistry.sol";
import {RoleTags} from "../src/RoleTags.sol";

/**
 * @title PLRBackendRegistryTest
 * @notice Coverage for the PLR backend-author registry — registration,
 *         kill-switch, timelocked authorship transfer, governance recovery,
 *         and the view helpers.
 *
 *         Coverage matrix:
 *           Registration
 *             1.  register happy path emits BackendRegistered + records all fields
 *             2.  register reverts on empty module path
 *             3.  register reverts on already-claimed module path
 *             4.  register reverts if schedule isn't in RateScheduleRegistry
 *             5.  register reverts if msg.sender != ownerOf(tokenId)
 *             6.  register reverts if tokenId's role != BACKEND_AUTHOR
 *           Kill-switch
 *             7.  setEnabled by author flips state + emits event
 *             8.  setEnabled by delegated agent works
 *             9.  setEnabled by unauthorized reverts
 *            10.  setEnabled reverts before MIN_TOGGLE_INTERVAL elapses
 *            11.  assertEnabled passes for unregistered backends
 *            12.  assertEnabled passes for registered+enabled
 *            13.  assertEnabled reverts BackendDisabled after kill-switch
 *           Mutators
 *            14.  setManifestCid by agent works
 *            15.  setScheduleHash by author works; reverts for agent
 *            16.  setScheduleHash reverts if new hash not published
 *            17.  setDelegatedAgent by author works; clearing works
 *           Authorship transfer (14-day timelock)
 *            18.  propose + execute happy path after 14 days
 *            19.  propose-then-execute-before-timelock reverts TransferNotReady
 *            20.  proposing a second transfer while one pends reverts
 *            21.  propose(0) cancels a pending transfer
 *            22.  propose reverts when caller isn't current author
 *            23.  propose reverts if new tokenId's role != BACKEND_AUTHOR
 *           Recovery (30-day governance window)
 *            24.  recoverAuthorship from non-governance reverts
 *            25.  recover + claim happy path after 30 days
 *            26.  claim-before-window reverts RecoveryNotReady
 *           Views
 *            27.  getRecord returns zero struct for unregistered
 *            28.  authorOf returns NFT owner
 *            29.  listAllModulePathKeys pagination
 *            30.  listEnabled filters disabled entries
 *            31.  deriveIpId is deterministic
 *            32.  totalBackends counts all
 */
contract PLRBackendRegistryTest is Test {
    RateScheduleRegistry scheduleRegistry;
    ContributorNFT nft;
    PLRBackendRegistry registry;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);
    address gov = address(0x60E);
    address agent1 = address(0xA1);
    address operator = address(0x09E);

    bytes constant SCHED_BYTES = bytes(
        '{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":10}]}'
    );
    bytes constant SCHED_BYTES_2 = bytes(
        '{"version":1,"segments":[{"kind":"constant","startTime":0,"endTime":null,"bps":25}]}'
    );
    bytes32 SCHED_HASH;
    bytes32 SCHED_HASH_2;

    string constant MODULE_PATH =
        "pylabrobot.liquid_handling.backends.hamilton.STAR";
    string constant MODULE_PATH_2 =
        "pylabrobot.liquid_handling.backends.opentrons.OT2";

    bytes32 MODULE_KEY;
    bytes32 MODULE_KEY_2;

    bytes32 constant CID = bytes32(uint256(0xCAFEBABE));
    bytes32 constant CID_2 = bytes32(uint256(0xDEADBEEF));

    function setUp() public {
        scheduleRegistry = new RateScheduleRegistry();
        nft = new ContributorNFT(address(scheduleRegistry));
        registry = new PLRBackendRegistry(
            address(nft),
            address(scheduleRegistry),
            gov
        );

        SCHED_HASH = sha256(SCHED_BYTES);
        SCHED_HASH_2 = sha256(SCHED_BYTES_2);
        scheduleRegistry.publish(SCHED_BYTES, SCHED_HASH);
        scheduleRegistry.publish(SCHED_BYTES_2, SCHED_HASH_2);

        MODULE_KEY = keccak256(bytes(MODULE_PATH));
        MODULE_KEY_2 = keccak256(bytes(MODULE_PATH_2));
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    function _mintNftFor(address to, bytes32 role, bytes32 scheduleHash)
        internal
        returns (uint256)
    {
        return nft.mint(to, role, scheduleHash, bytes32(0), "ipfs://x");
    }

    function _registerAlice() internal returns (uint256 tokenId, bytes32 key) {
        tokenId = _mintNftFor(alice, RoleTags.BACKEND_AUTHOR, SCHED_HASH);
        vm.prank(alice);
        key = registry.register(
            MODULE_PATH,
            tokenId,
            SCHED_HASH,
            bytes32(0),
            CID
        );
    }

    function _delegatedAgentBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    // ──────────────────────────────────────────────────────────────────────
    // 1. register happy path
    // ──────────────────────────────────────────────────────────────────────

    function test_register_emitsAndPersists() public {
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );

        vm.expectEmit(true, true, false, true);
        emit PLRBackendRegistry.BackendRegistered(
            MODULE_KEY,
            MODULE_PATH,
            alice,
            tokenId,
            SCHED_HASH,
            bytes32(0),
            CID
        );

        vm.prank(alice);
        bytes32 key = registry.register(
            MODULE_PATH,
            tokenId,
            SCHED_HASH,
            bytes32(0),
            CID
        );

        assertEq(key, MODULE_KEY);
        assertTrue(registry.claimed(MODULE_KEY));

        PLRBackendRegistry.BackendRecord memory r = registry.getRecord(MODULE_PATH);
        assertEq(r.scheduleHash, SCHED_HASH);
        assertEq(r.delegatedAgentId, bytes32(0));
        assertEq(r.manifestCid, CID);
        assertEq(r.contributorTokenId, tokenId);
        assertTrue(r.enabled);
        assertEq(r.registeredAt, uint64(block.timestamp));
        assertEq(r.lastEnabledChange, uint64(block.timestamp));

        assertEq(registry.totalBackends(), 1);
        assertEq(registry.authorOf(MODULE_PATH), alice);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 2. empty module path reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_register_revertsOnEmptyModulePath() public {
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.EmptyModulePath.selector);
        registry.register("", tokenId, SCHED_HASH, bytes32(0), CID);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 3. already-claimed reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_register_revertsOnDoubleClaim() public {
        (uint256 tokenId, ) = _registerAlice();
        uint256 t2 = _mintNftFor(bob, RoleTags.BACKEND_AUTHOR, SCHED_HASH);

        vm.prank(bob);
        vm.expectRevert(PLRBackendRegistry.AlreadyClaimed.selector);
        registry.register(MODULE_PATH, t2, SCHED_HASH, bytes32(0), CID);
        // Silence unused-var warning on the helper return.
        tokenId;
    }

    // ──────────────────────────────────────────────────────────────────────
    // 4. unpublished schedule reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_register_revertsOnUnpublishedSchedule() public {
        bytes32 fakeHash = keccak256("not-published");
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.ScheduleNotRegistered.selector);
        registry.register(MODULE_PATH, tokenId, fakeHash, bytes32(0), CID);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 5. caller-is-not-owner reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_register_revertsWhenCallerNotNftOwner() public {
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(bob); // bob doesn't own the token
        vm.expectRevert(PLRBackendRegistry.UnauthorizedActor.selector);
        registry.register(MODULE_PATH, tokenId, SCHED_HASH, bytes32(0), CID);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 6. wrong-role-tag reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_register_revertsWhenTokenRoleNotBackendAuthor() public {
        // Mint an integrator-role token, then try to register as backend-author.
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.INTEGRATOR,
            SCHED_HASH
        );
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.TokenIdRoleMismatch.selector);
        registry.register(MODULE_PATH, tokenId, SCHED_HASH, bytes32(0), CID);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 7. setEnabled by author
    // ──────────────────────────────────────────────────────────────────────

    function test_setEnabled_byAuthor() public {
        (, bytes32 key) = _registerAlice();
        // Skip past the 60s grief window.
        vm.warp(block.timestamp + 61);

        vm.expectEmit(true, true, false, true);
        emit PLRBackendRegistry.BackendEnabledChanged(
            key,
            alice,
            false,
            uint64(block.timestamp)
        );

        vm.prank(alice);
        registry.setEnabled(key, false);

        PLRBackendRegistry.BackendRecord memory r = registry.getRecord(MODULE_PATH);
        assertFalse(r.enabled);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 8. setEnabled by delegated agent
    // ──────────────────────────────────────────────────────────────────────

    function test_setEnabled_byDelegatedAgent() public {
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        registry.register(
            MODULE_PATH,
            tokenId,
            SCHED_HASH,
            _delegatedAgentBytes32(agent1),
            CID
        );

        vm.warp(block.timestamp + 61);
        vm.prank(agent1);
        registry.setEnabled(MODULE_KEY, false);

        assertFalse(registry.isEnabled(MODULE_PATH));
    }

    // ──────────────────────────────────────────────────────────────────────
    // 9. setEnabled by unauthorized
    // ──────────────────────────────────────────────────────────────────────

    function test_setEnabled_revertsForUnauthorized() public {
        (, bytes32 key) = _registerAlice();
        vm.warp(block.timestamp + 61);
        vm.prank(bob);
        vm.expectRevert(PLRBackendRegistry.UnauthorizedActor.selector);
        registry.setEnabled(key, false);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 10. MIN_TOGGLE_INTERVAL enforced
    // ──────────────────────────────────────────────────────────────────────

    function test_setEnabled_revertsTooFast() public {
        (, bytes32 key) = _registerAlice();
        // Same block as register — within grief window.
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.TogglingTooFast.selector);
        registry.setEnabled(key, false);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 11. assertEnabled passes for unregistered
    // ──────────────────────────────────────────────────────────────────────

    function test_assertEnabled_passesForUnregistered() public view {
        // No revert expected — the registry default-allows unregistered modules
        // so the aggregator integration can be toggled off via env flag during
        // rollout without breaking existing behavior.
        registry.assertEnabled("pylabrobot.never.registered");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 12. assertEnabled passes for enabled
    // ──────────────────────────────────────────────────────────────────────

    function test_assertEnabled_passesForRegisteredEnabled() public {
        _registerAlice();
        registry.assertEnabled(MODULE_PATH); // no revert
    }

    // ──────────────────────────────────────────────────────────────────────
    // 13. assertEnabled reverts BackendDisabled
    // ──────────────────────────────────────────────────────────────────────

    function test_assertEnabled_revertsWhenDisabled() public {
        (, bytes32 key) = _registerAlice();
        vm.warp(block.timestamp + 61);
        vm.prank(alice);
        registry.setEnabled(key, false);

        vm.expectRevert(PLRBackendRegistry.BackendDisabled.selector);
        registry.assertEnabled(MODULE_PATH);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 14. setManifestCid by agent
    // ──────────────────────────────────────────────────────────────────────

    function test_setManifestCid_byAgent() public {
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        registry.register(
            MODULE_PATH,
            tokenId,
            SCHED_HASH,
            _delegatedAgentBytes32(agent1),
            CID
        );

        vm.expectEmit(true, false, false, true);
        emit PLRBackendRegistry.ManifestCidUpdated(MODULE_KEY, CID, CID_2);
        vm.prank(agent1);
        registry.setManifestCid(MODULE_KEY, CID_2);
        assertEq(registry.getRecord(MODULE_PATH).manifestCid, CID_2);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 15. setScheduleHash author-only
    // ──────────────────────────────────────────────────────────────────────

    function test_setScheduleHash_authorOnly() public {
        uint256 tokenId = _mintNftFor(
            alice,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        registry.register(
            MODULE_PATH,
            tokenId,
            SCHED_HASH,
            _delegatedAgentBytes32(agent1),
            CID
        );

        // Agent CANNOT change schedule.
        vm.prank(agent1);
        vm.expectRevert(PLRBackendRegistry.UnauthorizedActor.selector);
        registry.setScheduleHash(MODULE_KEY, SCHED_HASH_2);

        // Author CAN.
        vm.prank(alice);
        registry.setScheduleHash(MODULE_KEY, SCHED_HASH_2);
        assertEq(registry.getRecord(MODULE_PATH).scheduleHash, SCHED_HASH_2);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 16. setScheduleHash reverts on unpublished hash
    // ──────────────────────────────────────────────────────────────────────

    function test_setScheduleHash_revertsOnUnpublished() public {
        (, bytes32 key) = _registerAlice();
        bytes32 fake = keccak256("nope");
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.ScheduleNotRegistered.selector);
        registry.setScheduleHash(key, fake);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 17. setDelegatedAgent author-only + clearing
    // ──────────────────────────────────────────────────────────────────────

    function test_setDelegatedAgent_authorOnly() public {
        (, bytes32 key) = _registerAlice();
        // Bob can't set it.
        vm.prank(bob);
        vm.expectRevert(PLRBackendRegistry.UnauthorizedActor.selector);
        registry.setDelegatedAgent(key, _delegatedAgentBytes32(agent1));

        // Alice can set, then clear.
        vm.prank(alice);
        registry.setDelegatedAgent(key, _delegatedAgentBytes32(agent1));
        assertEq(
            registry.getRecord(MODULE_PATH).delegatedAgentId,
            _delegatedAgentBytes32(agent1)
        );
        vm.prank(alice);
        registry.setDelegatedAgent(key, bytes32(0));
        assertEq(registry.getRecord(MODULE_PATH).delegatedAgentId, bytes32(0));
    }

    // ──────────────────────────────────────────────────────────────────────
    // 18. authorship transfer happy path
    // ──────────────────────────────────────────────────────────────────────

    function test_authorshipTransfer_happyPath() public {
        (, bytes32 key) = _registerAlice();
        // Mint a new BACKEND_AUTHOR NFT for carol.
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );

        vm.prank(alice);
        registry.proposeAuthorshipTransfer(key, newTokenId);

        // Cannot execute before timelock.
        vm.expectRevert(PLRBackendRegistry.TransferNotReady.selector);
        registry.executeAuthorshipTransfer(key);

        // Advance 14 days.
        vm.warp(block.timestamp + 14 days);
        registry.executeAuthorshipTransfer(key);

        assertEq(registry.authorOf(MODULE_PATH), carol);
        assertEq(registry.getRecord(MODULE_PATH).contributorTokenId, newTokenId);
        assertEq(registry.getRecord(MODULE_PATH).delegatedAgentId, bytes32(0));
    }

    // ──────────────────────────────────────────────────────────────────────
    // 19. execute-before-timelock reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_authorshipTransfer_executeRevertsBeforeTimelock() public {
        (, bytes32 key) = _registerAlice();
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        registry.proposeAuthorshipTransfer(key, newTokenId);

        // 13 days, 23 hours — still not ready.
        vm.warp(block.timestamp + 14 days - 1);
        vm.expectRevert(PLRBackendRegistry.TransferNotReady.selector);
        registry.executeAuthorshipTransfer(key);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 20. double-propose reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_authorshipTransfer_doubleProposeReverts() public {
        (, bytes32 key) = _registerAlice();
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        uint256 newTokenId2 = _mintNftFor(
            bob,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        registry.proposeAuthorshipTransfer(key, newTokenId);
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.TransferAlreadyPending.selector);
        registry.proposeAuthorshipTransfer(key, newTokenId2);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 21. cancel pending transfer with 0
    // ──────────────────────────────────────────────────────────────────────

    function test_authorshipTransfer_cancelWithZero() public {
        (, bytes32 key) = _registerAlice();
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        registry.proposeAuthorshipTransfer(key, newTokenId);
        vm.prank(alice);
        registry.proposeAuthorshipTransfer(key, 0);
        // Re-propose should now succeed.
        vm.prank(alice);
        registry.proposeAuthorshipTransfer(key, newTokenId);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 22. propose by non-author reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_authorshipTransfer_proposeRevertsByNonAuthor() public {
        (, bytes32 key) = _registerAlice();
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(bob);
        vm.expectRevert(PLRBackendRegistry.UnauthorizedActor.selector);
        registry.proposeAuthorshipTransfer(key, newTokenId);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 23. propose with wrong role reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_authorshipTransfer_proposeRevertsOnWrongRole() public {
        (, bytes32 key) = _registerAlice();
        uint256 wrongTokenId = _mintNftFor(
            carol,
            RoleTags.INTEGRATOR,
            SCHED_HASH
        );
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.TokenIdRoleMismatch.selector);
        registry.proposeAuthorshipTransfer(key, wrongTokenId);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 24. recoverAuthorship non-governance reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_recoverAuthorship_revertsForNonGovernance() public {
        (, bytes32 key) = _registerAlice();
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(alice);
        vm.expectRevert(PLRBackendRegistry.NotGovernance.selector);
        registry.recoverAuthorship(key, newTokenId);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 25. recovery happy path after 30 days
    // ──────────────────────────────────────────────────────────────────────

    function test_recoverAuthorship_happyPath() public {
        (, bytes32 key) = _registerAlice();
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );

        vm.prank(gov);
        registry.recoverAuthorship(key, newTokenId);

        // Cannot claim before window.
        vm.expectRevert(PLRBackendRegistry.RecoveryNotReady.selector);
        registry.claimRecovery(key);

        vm.warp(block.timestamp + 30 days);
        registry.claimRecovery(key);

        assertEq(registry.authorOf(MODULE_PATH), carol);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 26. claim-before-window reverts
    // ──────────────────────────────────────────────────────────────────────

    function test_recovery_claimBeforeWindow() public {
        (, bytes32 key) = _registerAlice();
        uint256 newTokenId = _mintNftFor(
            carol,
            RoleTags.BACKEND_AUTHOR,
            SCHED_HASH
        );
        vm.prank(gov);
        registry.recoverAuthorship(key, newTokenId);
        vm.warp(block.timestamp + 30 days - 1);
        vm.expectRevert(PLRBackendRegistry.RecoveryNotReady.selector);
        registry.claimRecovery(key);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 27. getRecord returns zero for unregistered
    // ──────────────────────────────────────────────────────────────────────

    function test_getRecord_zeroForUnregistered() public view {
        PLRBackendRegistry.BackendRecord memory r = registry.getRecord(
            "pylabrobot.unknown.x"
        );
        assertEq(r.scheduleHash, bytes32(0));
        assertEq(r.contributorTokenId, 0);
        assertFalse(r.enabled);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 28. authorOf reverts for unregistered, returns owner for registered
    // ──────────────────────────────────────────────────────────────────────

    function test_authorOf_returnsOwner() public {
        _registerAlice();
        assertEq(registry.authorOf(MODULE_PATH), alice);
    }

    function test_authorOf_revertsForUnregistered() public {
        vm.expectRevert(PLRBackendRegistry.NotClaimed.selector);
        registry.authorOf("pylabrobot.unknown.x");
    }

    // ──────────────────────────────────────────────────────────────────────
    // 29. listAllModulePathKeys pagination
    // ──────────────────────────────────────────────────────────────────────

    function test_listAllModulePathKeys_pagination() public {
        // Register 2 backends.
        _registerAlice();
        uint256 t2 = _mintNftFor(bob, RoleTags.BACKEND_AUTHOR, SCHED_HASH);
        vm.prank(bob);
        registry.register(MODULE_PATH_2, t2, SCHED_HASH, bytes32(0), CID);

        bytes32[] memory page = registry.listAllModulePathKeys(0, 10);
        assertEq(page.length, 2);
        assertEq(page[0], MODULE_KEY);
        assertEq(page[1], MODULE_KEY_2);

        // offset past end returns empty.
        bytes32[] memory empty = registry.listAllModulePathKeys(5, 10);
        assertEq(empty.length, 0);

        // Zero limit reverts.
        vm.expectRevert(PLRBackendRegistry.InvalidPageSize.selector);
        registry.listAllModulePathKeys(0, 0);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 30. listEnabled filters disabled
    // ──────────────────────────────────────────────────────────────────────

    function test_listEnabled_filtersDisabled() public {
        _registerAlice();
        uint256 t2 = _mintNftFor(bob, RoleTags.BACKEND_AUTHOR, SCHED_HASH);
        vm.prank(bob);
        registry.register(MODULE_PATH_2, t2, SCHED_HASH, bytes32(0), CID);

        vm.warp(block.timestamp + 61);
        vm.prank(alice);
        registry.setEnabled(MODULE_KEY, false);

        bytes32[] memory keys = registry.listEnabled(0, 10);
        assertEq(keys.length, 1);
        assertEq(keys[0], MODULE_KEY_2);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 31. deriveIpId is deterministic
    // ──────────────────────────────────────────────────────────────────────

    function test_deriveIpId_isDeterministic() public view {
        bytes32 a = registry.deriveIpId(MODULE_PATH, 0);
        bytes32 b = registry.deriveIpId(MODULE_PATH, 0);
        assertEq(a, b);

        bytes32 expected = keccak256(
            abi.encodePacked("pylabrobot:", MODULE_PATH, ":", uint8(0))
        );
        assertEq(a, expected);

        // Different major version → different id.
        bytes32 c = registry.deriveIpId(MODULE_PATH, 1);
        assertTrue(c != a);
    }

    // ──────────────────────────────────────────────────────────────────────
    // 32. totalBackends counts all
    // ──────────────────────────────────────────────────────────────────────

    function test_totalBackends_increments() public {
        assertEq(registry.totalBackends(), 0);
        _registerAlice();
        assertEq(registry.totalBackends(), 1);
        uint256 t2 = _mintNftFor(bob, RoleTags.BACKEND_AUTHOR, SCHED_HASH);
        vm.prank(bob);
        registry.register(MODULE_PATH_2, t2, SCHED_HASH, bytes32(0), CID);
        assertEq(registry.totalBackends(), 2);
    }
}
