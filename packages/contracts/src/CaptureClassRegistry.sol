// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title CaptureClassRegistry
 * @notice On-chain anchor for every accepted capture in the PCC Capture Verification Protocol (CVP).
 *
 * Design doc: ai/research/capture-verification-protocol.md §6 ("On-chain protocol")
 *
 * Purpose:
 *   - Replay prevention (a capture hash can only be anchored once)
 *   - Public audit trail: which class a capture claimed vs. what the detector verified
 *   - Accountability routing (submitter, jobId, challengeId)
 *   - Optional N-of-M verifier consensus via Merkle root of off-chain attestations
 *   - Permissionless dispute event (actual slashing handled by MilestoneEscrow)
 *
 * Write access:
 *   - `anchor(...)` — gateway oracle only (single EOA, GATEWAY_ORACLE_KEY)
 *   - `updateAttestations(...)` — VerifierRegistry only
 *   - `dispute(...)` — permissionless (anyone can raise a dispute event)
 *
 * The capture class (CC0..CC5) is a trust tier the operator declares, and the
 * gateway's detector pipeline may lower before anchoring. See design doc §1.
 */
contract CaptureClassRegistry {
    // ── Types ──────────────────────────────────────────────────────────────

    /// @notice Packed anchor record for a single capture.
    /// @dev Field order is intentional for storage-slot packing:
    ///   Slot 0: captureHash (bytes32)
    ///   Slot 1: manifestHash (bytes32)
    ///   Slot 2: declaredClass(1) + verifiedClass(1) + submittedBy(20) + blockAnchor(4) + attesterCount(2) = 28 bytes
    ///   Slot 3: jobId (bytes32)
    ///   Slot 4: challengeId (bytes32)
    ///   Slot 5: capturedAt (uint64, padded)
    ///   Slot 6: attestationsRoot (bytes32)
    struct CaptureAnchor {
        bytes32 captureHash;      // SHA256 of the original capture bytes
        bytes32 manifestHash;     // SHA256 of the canonical CaptureManifest JSON
        uint8 declaredClass;      // 0..5 = CC0..CC5 (operator-declared trust tier)
        uint8 verifiedClass;      // 0..5 = CC0..CC5 (after detector verification; <= declaredClass)
        address submittedBy;      // Operator wallet that submitted the capture
        bytes32 jobId;            // PCC jobId (hashed) for accountability routing
        bytes32 challengeId;      // CaptureNonceChallenge id (required for CC1+)
        uint32 blockAnchor;       // Ethereum block number at challenge time (time window bound)
        uint64 capturedAt;        // Unix seconds at capture time (client-attested)
        bytes32 attestationsRoot; // Merkle root over N-of-M verifier attestations (0 if none)
        uint16 attesterCount;     // Number of attesters included in the Merkle root
    }

    // ── Events ─────────────────────────────────────────────────────────────

    /// @notice Emitted when a new capture is anchored on chain.
    /// @param captureHash SHA256 of the capture bytes (indexed for lookup).
    /// @param jobId PCC jobId hash (indexed so a job can replay its capture stream).
    /// @param submittedBy Operator wallet (indexed for accountability queries).
    /// @param declaredClass The trust tier the operator claimed (0..5).
    /// @param verifiedClass The trust tier the gateway detector accepted (0..5, <= declaredClass).
    event CaptureAnchored(
        bytes32 indexed captureHash,
        bytes32 indexed jobId,
        address indexed submittedBy,
        uint8 declaredClass,
        uint8 verifiedClass
    );

    /// @notice Emitted when the VerifierRegistry updates N-of-M attestations for a capture.
    /// @param captureHash SHA256 of the capture bytes (indexed).
    /// @param attestationsRoot Merkle root over the set of individual verifier attestations.
    /// @param attesterCount Number of verifiers whose attestations are included in the root.
    event AttestationsUpdated(
        bytes32 indexed captureHash,
        bytes32 attestationsRoot,
        uint16 attesterCount
    );

    /// @notice Emitted when anyone raises a dispute against an anchored capture.
    /// @dev Permissionless by design. Actual slashing lives in MilestoneEscrow's dispute flow.
    /// @param captureHash SHA256 of the disputed capture (indexed).
    /// @param disputer Address raising the dispute (indexed).
    /// @param reason Free-form human-readable dispute reason.
    event CaptureDisputed(
        bytes32 indexed captureHash,
        address indexed disputer,
        string reason
    );

    // ── State ──────────────────────────────────────────────────────────────

    /// @notice captureHash -> full CaptureAnchor record.
    mapping(bytes32 => CaptureAnchor) public anchors;

    /// @notice captureHash -> true once anchored (replay prevention).
    mapping(bytes32 => bool) public exists;

    /// @notice The single privileged EOA that submits anchors on behalf of the gateway.
    /// @dev Held by the gateway process, key in GATEWAY_ORACLE_KEY env var.
    ///      Prevents a rogue operator from self-anchoring a fake verifiedClass.
    address public immutable gatewayOracle;

    /// @notice The VerifierRegistry contract allowed to update N-of-M attestations.
    /// @dev Set at deployment, cannot change. Points to VerifierRegistry.sol.
    address public immutable verifierRegistry;

    // ── Constructor ────────────────────────────────────────────────────────

    /// @notice Deploy with the gateway oracle EOA and the verifier registry contract address.
    /// @param _gatewayOracle EOA controlled by the gateway process (GATEWAY_ORACLE_KEY).
    /// @param _verifierRegistry Address of the deployed VerifierRegistry contract.
    constructor(address _gatewayOracle, address _verifierRegistry) {
        require(_gatewayOracle != address(0), "zero gateway");
        require(_verifierRegistry != address(0), "zero verifier registry");
        gatewayOracle = _gatewayOracle;
        verifierRegistry = _verifierRegistry;
    }

    // ── External: Anchor ───────────────────────────────────────────────────

    /// @notice Anchor a new capture on chain. Gateway oracle only.
    /// @dev Invariants enforced:
    ///        - caller is the gateway oracle
    ///        - captureHash has not been anchored before (replay prevention)
    ///        - declaredClass and verifiedClass are in range [0, 5]
    ///        - verifiedClass <= declaredClass (detector can downgrade but not upgrade)
    /// @param a The CaptureAnchor struct to store.
    function anchor(CaptureAnchor calldata a) external {
        require(msg.sender == gatewayOracle, "only gateway");
        require(!exists[a.captureHash], "replay");
        require(a.declaredClass <= 5 && a.verifiedClass <= 5, "invalid class");
        require(a.verifiedClass <= a.declaredClass, "verified > declared");

        exists[a.captureHash] = true;
        anchors[a.captureHash] = a;

        emit CaptureAnchored(
            a.captureHash,
            a.jobId,
            a.submittedBy,
            a.declaredClass,
            a.verifiedClass
        );
    }

    // ── External: Update Attestations ──────────────────────────────────────

    /// @notice Update the N-of-M verifier attestations for an existing anchor.
    /// @dev Only callable by the VerifierRegistry contract. The captureHash must already be anchored.
    ///      Used for CC5 (and optional CC1+) where the gateway dispatches the capture to
    ///      multiple registered verifiers; the Merkle root of their signed attestations is posted here.
    /// @param captureHash SHA256 of an already-anchored capture.
    /// @param attestationsRoot Merkle root over the set of individual verifier attestations.
    /// @param attesterCount Number of verifiers whose signed attestations are in the root.
    function updateAttestations(
        bytes32 captureHash,
        bytes32 attestationsRoot,
        uint16 attesterCount
    ) external {
        require(msg.sender == verifierRegistry, "only verifier registry");
        require(exists[captureHash], "no such capture");

        anchors[captureHash].attestationsRoot = attestationsRoot;
        anchors[captureHash].attesterCount = attesterCount;

        emit AttestationsUpdated(captureHash, attestationsRoot, attesterCount);
    }

    // ── External: Dispute ──────────────────────────────────────────────────

    /// @notice Raise a permissionless dispute event against an anchored capture.
    /// @dev This ONLY emits an event — actual slashing, bond transfer, and arbiter resolution
    ///      happen in MilestoneEscrow's dispute flow. The intent here is a cheap, public,
    ///      append-only log of challenges that off-chain indexers can surface.
    /// @param captureHash SHA256 of the capture being disputed (must already be anchored).
    /// @param reason Free-form human-readable reason for the dispute.
    function dispute(bytes32 captureHash, string calldata reason) external {
        require(exists[captureHash], "no such capture");
        emit CaptureDisputed(captureHash, msg.sender, reason);
    }

    // ── External Views ─────────────────────────────────────────────────────

    /// @notice Return the full CaptureAnchor struct for a captureHash.
    /// @dev Prefer this over the auto-generated `anchors(hash)` getter when you want
    ///      the struct as a single return value instead of an unwieldy tuple.
    /// @param captureHash SHA256 of a capture.
    /// @return The stored CaptureAnchor; fields are zero if the capture was never anchored.
    function getAnchor(bytes32 captureHash) external view returns (CaptureAnchor memory) {
        return anchors[captureHash];
    }

    /// @notice Convenience read: has this captureHash been anchored?
    /// @dev Equivalent to reading the `exists` mapping, but with a named getter for clarity.
    /// @param captureHash SHA256 of a capture.
    /// @return True if the capture has been anchored, false otherwise.
    function getExists(bytes32 captureHash) external view returns (bool) {
        return exists[captureHash];
    }
}
