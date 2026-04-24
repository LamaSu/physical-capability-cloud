// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerificationScheme} from "./IVerificationScheme.sol";

/// @title VerificationSchemeRegistry
/// @author implementer-alpha
/// @notice Governor-gated registry mapping schemeId → IVerificationScheme impl.
///   Registration has a 24h timelock to prevent governor-key compromise from
///   swapping schemes mid-flight; deregistration is immediate for safety.
///
/// Authority model (mirrored from PCCProtocol.governor):
///   - `governor` is mutable via transferGovernor (single mutable slot)
///   - registerSchemeRequest(id, impl) → records pending + unlock timestamp
///   - registerSchemeCommit(id)        → anyone can call AFTER unlock; promotes pending → active
///   - deregisterScheme(id)            → governor only, immediate
///
/// A registered scheme's impl address is IMMUTABLE once committed — to change
/// the impl for an existing schemeId, deregister first, then register a new one.
/// This prevents silent impl-swap attacks on locked milestones.
contract VerificationSchemeRegistry {
    // ── Constants ────────────────────────────────────────────────────
    uint256 public constant TIMELOCK_SECONDS = 24 hours;

    // ── Types ────────────────────────────────────────────────────────
    struct Pending {
        address impl;
        uint256 unlockAt;
    }

    // ── State ────────────────────────────────────────────────────────

    /// @notice Privileged address that can request registrations + deregister.
    /// @dev Mutable through transferGovernor so governance can rotate.
    address public governor;

    /// @notice schemeId → active implementation address. Zero if unregistered.
    mapping(bytes32 => address) public schemes;

    /// @notice schemeId → pending registration record (impl + unlock timestamp).
    ///   Cleared on commit; overwritten by subsequent requests when slot free.
    mapping(bytes32 => Pending) public pending;

    // ── Events ───────────────────────────────────────────────────────

    event GovernorTransferred(address indexed oldGovernor, address indexed newGovernor);
    event SchemeRegistrationRequested(bytes32 indexed schemeId, address indexed impl, uint256 unlockAt);
    event SchemeRegistered(bytes32 indexed schemeId, address indexed impl);
    event SchemeDeregistered(bytes32 indexed schemeId, address indexed impl);

    // ── Modifiers ────────────────────────────────────────────────────

    modifier onlyGovernor() {
        require(msg.sender == governor, "not governor");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────

    /// @param _governor Initial governor address. Cannot be zero.
    constructor(address _governor) {
        require(_governor != address(0), "zero governor");
        governor = _governor;
    }

    // ── Governance ───────────────────────────────────────────────────

    /// @notice Rotate the governor. Only current governor may call.
    /// @param newGovernor The address to transfer governance to. Cannot be zero.
    function transferGovernor(address newGovernor) external onlyGovernor {
        require(newGovernor != address(0), "zero governor");
        emit GovernorTransferred(governor, newGovernor);
        governor = newGovernor;
    }

    // ── Scheme Lifecycle ─────────────────────────────────────────────

    /// @notice Request a scheme registration. Starts the 24h timelock.
    ///   Sanity-checks that the impl actually returns the claimed schemeId so
    ///   a typo or wrong-contract deploy is caught at request time, not commit.
    /// @param schemeId Non-zero scheme identifier. Must not already be registered or pending.
    /// @param impl Non-zero IVerificationScheme contract address whose schemeId() MUST match.
    function registerSchemeRequest(bytes32 schemeId, address impl) external onlyGovernor {
        require(schemeId != bytes32(0), "zero schemeId");
        require(impl != address(0), "zero impl");
        require(schemes[schemeId] == address(0), "already registered");
        require(pending[schemeId].impl == address(0), "request pending");

        // Sanity: impl self-reports matching schemeId (catches typo / wrong-contract deploy).
        require(IVerificationScheme(impl).schemeId() == schemeId, "schemeId mismatch");

        uint256 unlockAt = block.timestamp + TIMELOCK_SECONDS;
        pending[schemeId] = Pending({impl: impl, unlockAt: unlockAt});
        emit SchemeRegistrationRequested(schemeId, impl, unlockAt);
    }

    /// @notice Finalize a pending registration after the timelock elapses.
    /// @dev Permissionless so any observer can promote (defense against governor going dark).
    ///   If schemes[schemeId] was concurrently registered (shouldn't happen structurally
    ///   since request requires schemes[id]==0), the commit reverts — pending remains and
    ///   can be cleared by governor via a deregister+re-request flow.
    /// @param schemeId The pending scheme identifier to promote to active.
    function registerSchemeCommit(bytes32 schemeId) external {
        Pending memory p = pending[schemeId];
        require(p.impl != address(0), "no pending");
        require(block.timestamp >= p.unlockAt, "timelock active");
        require(schemes[schemeId] == address(0), "already registered");

        schemes[schemeId] = p.impl;
        delete pending[schemeId];
        emit SchemeRegistered(schemeId, p.impl);
    }

    /// @notice Immediate scheme deregistration. Governor-only, no timelock.
    ///   Use case: discovered bug in scheme logic, must pull the plug now.
    ///   Existing locked milestones pointing at this schemeId will fail to
    ///   release until governor registers a fixed impl under a NEW schemeId,
    ///   or payer refunds via the existing dispute flow.
    /// @param schemeId The scheme to deregister. Must be currently active.
    function deregisterScheme(bytes32 schemeId) external onlyGovernor {
        address impl = schemes[schemeId];
        require(impl != address(0), "not registered");
        delete schemes[schemeId];
        emit SchemeDeregistered(schemeId, impl);
    }

    // ── Views ────────────────────────────────────────────────────────

    /// @notice Active impl for a schemeId, or address(0) if unregistered.
    function getScheme(bytes32 schemeId) external view returns (address) {
        return schemes[schemeId];
    }

    /// @notice Convenience: is this schemeId currently active?
    function isRegistered(bytes32 schemeId) external view returns (bool) {
        return schemes[schemeId] != address(0);
    }
}
