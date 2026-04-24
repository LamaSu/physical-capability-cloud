// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/VerificationSchemeRegistry.sol";
import {IVerificationScheme} from "../src/IVerificationScheme.sol";

/// @title MockScheme
/// @notice Minimal IVerificationScheme for registry tests. Returns a configurable schemeId.
///   Not used to test onLock/onRelease logic — CaptureChallengeV1Scheme.t.sol covers that.
contract MockScheme is IVerificationScheme {
    bytes32 public immutable _id;
    uint16 public immutable _version;

    constructor(bytes32 id_, uint16 v_) {
        _id = id_;
        _version = v_;
    }

    function schemeId() external view override returns (bytes32) {
        return _id;
    }

    function schemeVersion() external view override returns (uint16) {
        return _version;
    }

    function onLock(address, bytes32, bytes calldata) external pure override returns (bytes32) {
        return keccak256("mock-lock");
    }

    function onRelease(address, bytes32, bytes32, bytes calldata) external pure override returns (bool) {
        return true;
    }
}

/**
 * @title VerificationSchemeRegistryTest
 * @notice Foundry test suite for the governor-gated, timelocked scheme registry.
 *
 * Spec: ai/supervisor/wave7-spec.md §"VerificationSchemeRegistry.sol"
 *
 * Coverage (14 cases):
 *   - Constructor validation
 *   - registerSchemeRequest: timelock start, zero-id reject, zero-impl reject,
 *     schemeId-mismatch reject, duplicate reject
 *   - registerSchemeCommit: pre-timelock revert, post-timelock success, permissionless
 *   - deregisterScheme: governor-only, immediate
 *   - transferGovernor: state + event
 *   - Re-registration after deregister requires full 24h timelock again
 *   - View: getScheme returns zero for unregistered
 */
contract VerificationSchemeRegistryTest is Test {
    VerificationSchemeRegistry registry;

    address governor = address(0x60);  // "governor"
    address attacker = address(0xBAD);
    address observer = address(0x0B5); // permissionless committer

    bytes32 constant ID_A = keccak256("SchemeA");
    bytes32 constant ID_B = keccak256("SchemeB");

    MockScheme schemeA;
    MockScheme schemeB;

    // ── Events (mirrored for vm.expectEmit) ──────────────────────────

    event GovernorTransferred(address indexed oldGovernor, address indexed newGovernor);
    event SchemeRegistrationRequested(bytes32 indexed schemeId, address indexed impl, uint256 unlockAt);
    event SchemeRegistered(bytes32 indexed schemeId, address indexed impl);
    event SchemeDeregistered(bytes32 indexed schemeId, address indexed impl);

    function setUp() public {
        registry = new VerificationSchemeRegistry(governor);
        schemeA = new MockScheme(ID_A, 1);
        schemeB = new MockScheme(ID_B, 1);
    }

    // ── Constructor ──────────────────────────────────────────────────

    function test_constructor_requires_governor() public {
        vm.expectRevert("zero governor");
        new VerificationSchemeRegistry(address(0));
    }

    function test_constructor_sets_governor() public view {
        assertEq(registry.governor(), governor);
    }

    // ── registerSchemeRequest ────────────────────────────────────────

    function test_registerSchemeRequest_starts_timelock() public {
        uint256 expectedUnlock = block.timestamp + 24 hours;

        vm.expectEmit(true, true, false, true, address(registry));
        emit SchemeRegistrationRequested(ID_A, address(schemeA), expectedUnlock);

        vm.prank(governor);
        registry.registerSchemeRequest(ID_A, address(schemeA));

        (address pImpl, uint256 pUnlock) = registry.pending(ID_A);
        assertEq(pImpl, address(schemeA));
        assertEq(pUnlock, expectedUnlock);
        // Scheme NOT yet active
        assertEq(registry.schemes(ID_A), address(0));
        assertEq(registry.isRegistered(ID_A), false);
    }

    function test_registerSchemeRequest_rejects_zero_schemeId() public {
        vm.prank(governor);
        vm.expectRevert("zero schemeId");
        registry.registerSchemeRequest(bytes32(0), address(schemeA));
    }

    function test_registerSchemeRequest_rejects_zero_impl() public {
        vm.prank(governor);
        vm.expectRevert("zero impl");
        registry.registerSchemeRequest(ID_A, address(0));
    }

    function test_registerSchemeRequest_rejects_schemeId_mismatch() public {
        // schemeA.schemeId() == ID_A, but we request registration under ID_B
        vm.prank(governor);
        vm.expectRevert("schemeId mismatch");
        registry.registerSchemeRequest(ID_B, address(schemeA));
    }

    function test_registerSchemeRequest_rejects_duplicate_pending() public {
        vm.startPrank(governor);
        registry.registerSchemeRequest(ID_A, address(schemeA));
        vm.expectRevert("request pending");
        registry.registerSchemeRequest(ID_A, address(schemeA));
        vm.stopPrank();
    }

    function test_registerSchemeRequest_rejects_non_governor() public {
        vm.prank(attacker);
        vm.expectRevert("not governor");
        registry.registerSchemeRequest(ID_A, address(schemeA));
    }

    // ── registerSchemeCommit ─────────────────────────────────────────

    function test_registerSchemeCommit_rejects_before_unlock() public {
        vm.prank(governor);
        registry.registerSchemeRequest(ID_A, address(schemeA));

        // Exactly 1 second before unlock → still locked
        vm.warp(block.timestamp + 24 hours - 1);
        vm.expectRevert("timelock active");
        registry.registerSchemeCommit(ID_A);
    }

    function test_registerSchemeCommit_succeeds_at_unlock() public {
        vm.prank(governor);
        registry.registerSchemeRequest(ID_A, address(schemeA));

        vm.warp(block.timestamp + 24 hours);

        vm.expectEmit(true, true, false, false, address(registry));
        emit SchemeRegistered(ID_A, address(schemeA));

        registry.registerSchemeCommit(ID_A);

        assertEq(registry.schemes(ID_A), address(schemeA));
        assertEq(registry.isRegistered(ID_A), true);
        assertEq(registry.getScheme(ID_A), address(schemeA));

        // Pending cleared
        (address pImpl, uint256 pUnlock) = registry.pending(ID_A);
        assertEq(pImpl, address(0));
        assertEq(pUnlock, 0);
    }

    function test_registerSchemeCommit_permissionless() public {
        vm.prank(governor);
        registry.registerSchemeRequest(ID_A, address(schemeA));
        vm.warp(block.timestamp + 24 hours);

        // Non-governor address promotes — MUST succeed (anti-dark-governor)
        vm.prank(observer);
        registry.registerSchemeCommit(ID_A);

        assertEq(registry.schemes(ID_A), address(schemeA));
    }

    function test_registerSchemeCommit_rejects_no_pending() public {
        vm.expectRevert("no pending");
        registry.registerSchemeCommit(ID_A);
    }

    // ── deregisterScheme ─────────────────────────────────────────────

    function test_deregisterScheme_governor_only() public {
        _requestAndCommit(ID_A, address(schemeA));

        vm.prank(attacker);
        vm.expectRevert("not governor");
        registry.deregisterScheme(ID_A);
    }

    function test_deregisterScheme_immediate() public {
        _requestAndCommit(ID_A, address(schemeA));
        assertEq(registry.isRegistered(ID_A), true);

        vm.expectEmit(true, true, false, false, address(registry));
        emit SchemeDeregistered(ID_A, address(schemeA));

        vm.prank(governor);
        registry.deregisterScheme(ID_A);

        assertEq(registry.schemes(ID_A), address(0));
        assertEq(registry.isRegistered(ID_A), false);
    }

    function test_deregisterScheme_rejects_unregistered() public {
        vm.prank(governor);
        vm.expectRevert("not registered");
        registry.deregisterScheme(ID_A);
    }

    // ── transferGovernor ─────────────────────────────────────────────

    function test_transferGovernor_updates_and_emits() public {
        address newGov = address(0xABCD);

        vm.expectEmit(true, true, false, false, address(registry));
        emit GovernorTransferred(governor, newGov);

        vm.prank(governor);
        registry.transferGovernor(newGov);

        assertEq(registry.governor(), newGov);

        // Old governor now rejected
        vm.prank(governor);
        vm.expectRevert("not governor");
        registry.transferGovernor(address(0xBEEF));

        // New governor accepted
        vm.prank(newGov);
        registry.transferGovernor(governor);
        assertEq(registry.governor(), governor);
    }

    function test_transferGovernor_rejects_zero() public {
        vm.prank(governor);
        vm.expectRevert("zero governor");
        registry.transferGovernor(address(0));
    }

    // ── Re-registration after deregister ─────────────────────────────

    function test_re_register_after_deregister_requires_full_timelock() public {
        // Initial register + commit + deregister
        _requestAndCommit(ID_A, address(schemeA));
        vm.prank(governor);
        registry.deregisterScheme(ID_A);

        // Request a new registration (re-use same schemeId, same impl for simplicity)
        uint256 newUnlockAt = block.timestamp + 24 hours;
        vm.prank(governor);
        registry.registerSchemeRequest(ID_A, address(schemeA));

        // Cannot commit before the NEW unlockAt — timelock resets on every request
        vm.warp(newUnlockAt - 1);
        vm.expectRevert("timelock active");
        registry.registerSchemeCommit(ID_A);

        // At exactly new unlockAt, commit succeeds
        vm.warp(newUnlockAt);
        registry.registerSchemeCommit(ID_A);
        assertEq(registry.schemes(ID_A), address(schemeA));
    }

    // ── View: unregistered returns zero ──────────────────────────────

    function test_getScheme_returns_zero_for_unregistered() public view {
        assertEq(registry.getScheme(ID_A), address(0));
        assertEq(registry.isRegistered(ID_A), false);
    }

    // ── Helpers ──────────────────────────────────────────────────────

    function _requestAndCommit(bytes32 schemeId, address impl) internal {
        vm.prank(governor);
        registry.registerSchemeRequest(schemeId, impl);
        vm.warp(block.timestamp + 24 hours);
        registry.registerSchemeCommit(schemeId);
    }
}
