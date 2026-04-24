// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVerificationScheme} from "../IVerificationScheme.sol";

/// @notice Minimal on-chain view of CaptureClassRegistry for the scheme adapter.
/// @dev Field order mirrors the real contract's CaptureAnchor struct exactly.
///   We define it locally (instead of importing CaptureClassRegistry.sol) to keep
///   this scheme independent of the deeper CVP type surface — any contract that
///   exposes the same struct + two view methods is a valid upstream anchor source.
interface ICaptureClassRegistry {
    struct CaptureAnchor {
        bytes32 captureHash;
        bytes32 manifestHash;
        uint8 declaredClass;
        uint8 verifiedClass;
        address submittedBy;
        bytes32 jobId;
        bytes32 challengeId;
        uint32 blockAnchor;
        uint64 capturedAt;
        bytes32 attestationsRoot;
        uint16 attesterCount;
    }

    function getAnchor(bytes32 captureHash) external view returns (CaptureAnchor memory);

    function exists(bytes32 captureHash) external view returns (bool);
}

/// @title CaptureChallengeV1Scheme
/// @author implementer-alpha
/// @notice IVerificationScheme adapter for PCC's Capture Verification Protocol (CVP).
///
/// Commitment model:
///   At lock: operator commits to a specific challengeId + blockAnchor bound to
///     their wallet address and a minimum verified CVP class. The commitmentHash
///     binds (SCHEME_ID, challengeId, blockAnchor, operator, minVerifiedClass) so
///     only captures produced during that challenge window, by that operator, at
///     or above that verifiedClass threshold can release the milestone.
///
///   At release: the attestationData names a captureHash already anchored in
///     CaptureClassRegistry. The adapter looks up the anchor and checks:
///       - anchor.challengeId   matches committed challengeId
///       - anchor.blockAnchor   matches committed blockAnchor
///       - anchor.submittedBy   matches committed operator
///       - anchor.verifiedClass >= committed minVerifiedClass
///
/// This makes replay of an old capture cryptographically impossible: the
/// commitment was made BEFORE the challenge was answered, and the anchor records
/// the challenge the capture actually answered. Mismatch anywhere reverts/fails.
///
/// Commitment storage is keyed by keccak256(escrow, stepId) so multiple escrows
/// sharing this adapter cannot collide on the same stepId.
contract CaptureChallengeV1Scheme is IVerificationScheme {
    // ── Constants ────────────────────────────────────────────────────

    /// @notice Canonical scheme identifier. VerificationSchemeRegistry pins this.
    bytes32 public constant SCHEME_ID = keccak256("CaptureChallengeV1");

    /// @notice Semver major. Bumping this requires a brand-new SCHEME_ID.
    uint16 public constant SCHEME_VERSION = 1;

    // ── Immutables ───────────────────────────────────────────────────

    /// @notice Upstream CVP on-chain anchor registry.
    ICaptureClassRegistry public immutable captureRegistry;

    // ── Types ────────────────────────────────────────────────────────

    struct Commitment {
        bytes32 challengeId;
        uint32 blockAnchor;
        address operator;
        uint8 minVerifiedClass;
        bool set;
    }

    // ── State ────────────────────────────────────────────────────────

    /// @notice keccak256(escrow, stepId) → Commitment. One commitment per (escrow, stepId).
    mapping(bytes32 => Commitment) private _commitments;

    // ── Constructor ──────────────────────────────────────────────────

    /// @param _captureRegistry Deployed CaptureClassRegistry (CVP) address.
    constructor(address _captureRegistry) {
        require(_captureRegistry != address(0), "zero registry");
        captureRegistry = ICaptureClassRegistry(_captureRegistry);
    }

    // ── IVerificationScheme: identity ────────────────────────────────

    function schemeId() external pure override returns (bytes32) {
        return SCHEME_ID;
    }

    function schemeVersion() external pure override returns (uint16) {
        return SCHEME_VERSION;
    }

    // ── IVerificationScheme: lifecycle hooks ─────────────────────────

    /// @notice Record the operator's commitment to a specific (challengeId,
    ///   blockAnchor, operator, minVerifiedClass) at escrow lock time. Idempotent
    ///   per (escrow, stepId) — double-commit reverts.
    /// @inheritdoc IVerificationScheme
    function onLock(
        address escrow,
        bytes32 stepId,
        bytes calldata commitmentPayload
    ) external override returns (bytes32 commitmentHash) {
        (bytes32 challengeId, uint32 blockAnchor, address operator, uint8 minVerifiedClass) =
            abi.decode(commitmentPayload, (bytes32, uint32, address, uint8));

        require(challengeId != bytes32(0), "zero challengeId");
        require(operator != address(0), "zero operator");
        require(minVerifiedClass <= 5, "class out of range");

        bytes32 key = _key(escrow, stepId);
        require(!_commitments[key].set, "already committed");

        _commitments[key] = Commitment({
            challengeId: challengeId,
            blockAnchor: blockAnchor,
            operator: operator,
            minVerifiedClass: minVerifiedClass,
            set: true
        });

        commitmentHash = keccak256(
            abi.encode(SCHEME_ID, challengeId, blockAnchor, operator, minVerifiedClass)
        );
    }

    /// @notice Validate the submitted capture against the commitment recorded
    ///   at onLock time. Returns true only if all four fields match and the
    ///   stored commitmentHash reconstructs identically from storage.
    /// @inheritdoc IVerificationScheme
    function onRelease(
        address escrow,
        bytes32 stepId,
        bytes32 commitmentHash,
        bytes calldata attestationData
    ) external view override returns (bool valid) {
        bytes32 key = _key(escrow, stepId);
        Commitment memory c = _commitments[key];
        require(c.set, "no commitment");

        // Reconstruct hash to catch storage tampering (redundant with escrow-side check,
        // belt-and-suspenders — the escrow holds the hash, we hold the preimage).
        bytes32 expected = keccak256(
            abi.encode(SCHEME_ID, c.challengeId, c.blockAnchor, c.operator, c.minVerifiedClass)
        );
        require(expected == commitmentHash, "commitment mismatch");

        bytes32 captureHash = abi.decode(attestationData, (bytes32));
        require(captureRegistry.exists(captureHash), "no such capture");

        ICaptureClassRegistry.CaptureAnchor memory a = captureRegistry.getAnchor(captureHash);

        return (
            a.challengeId == c.challengeId &&
            a.blockAnchor == c.blockAnchor &&
            a.submittedBy == c.operator &&
            a.verifiedClass >= c.minVerifiedClass
        );
    }

    // ── View helpers (for off-chain tooling + tests) ─────────────────

    /// @notice Inspect a stored commitment. Returns zeroed struct if unset.
    function getCommitment(address escrow, bytes32 stepId) external view returns (Commitment memory) {
        return _commitments[_key(escrow, stepId)];
    }

    /// @notice Deterministic commitment key. Exposed for off-chain indexers.
    function commitmentKey(address escrow, bytes32 stepId) external pure returns (bytes32) {
        return _key(escrow, stepId);
    }

    // ── Internals ────────────────────────────────────────────────────

    function _key(address escrow, bytes32 stepId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(escrow, stepId));
    }
}
