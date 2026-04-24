// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVerificationScheme
/// @author implementer-alpha
/// @notice Plugin interface for milestone-bound verification schemes.
///   Schemes are registered in VerificationSchemeRegistry and invoked by
///   MilestoneEscrow at lock/release time. A scheme defines WHAT evidence
///   an attestation must match against — CaptureChallengeV1Scheme is the
///   first concrete scheme; future schemes can plug in ZK-TLS, multi-sig
///   wet-lab sign-off, sensor-DAG consensus, etc., without escrow changes.
/// @dev Pattern converges on ERC-792 (arbitrator-as-address + opaque extraData),
///   Uniswap V4 (per-pool hook address), and ERC-7579 HOOK module type. Escrow
///   stores an opaque commitmentHash returned by onLock; scheme recomputes it
///   at onRelease to detect tampering between lock and release.
interface IVerificationScheme {
    /// @notice Stable scheme identifier. Conventionally keccak256(name+version).
    ///   Example: keccak256("CaptureChallengeV1") for CVP.
    function schemeId() external view returns (bytes32);

    /// @notice Semver-ish major version of the scheme logic (for off-chain tooling).
    function schemeVersion() external view returns (uint16);

    /// @notice Called by escrow at addMilestone() time, BEFORE any funds lock.
    /// @param escrow The escrow contract address making the call.
    /// @param stepId The milestone's stepId.
    /// @param commitmentPayload Opaque bytes the scheme decodes + validates.
    ///        For CaptureChallengeV1: abi.encode(challengeId, blockAnchor, operator, minVerifiedClass).
    /// @return commitmentHash An opaque hash the escrow stores for later onRelease checks.
    ///         MUST be non-zero on success. Reverts on invalid commitment.
    function onLock(
        address escrow,
        bytes32 stepId,
        bytes calldata commitmentPayload
    ) external returns (bytes32 commitmentHash);

    /// @notice Called by escrow at release() time (after challenge window expires).
    /// @dev view so we can gas-price cleanly and avoid reentrancy surface.
    /// @param escrow The escrow contract address making the call.
    /// @param stepId The milestone's stepId.
    /// @param commitmentHash The hash returned by onLock() at lock time.
    /// @param attestationData Opaque bytes the scheme interprets.
    ///        For CaptureChallengeV1: abi.encode(captureHash).
    /// @return valid True if attestation matches the locked commitment. False/revert blocks release.
    function onRelease(
        address escrow,
        bytes32 stepId,
        bytes32 commitmentHash,
        bytes calldata attestationData
    ) external view returns (bool valid);
}
