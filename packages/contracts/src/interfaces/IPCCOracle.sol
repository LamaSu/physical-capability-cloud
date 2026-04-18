// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPCCOracle
 * @notice Interface for the PCC Verification Oracle. Returns a signed
 *         attestation that an off-chain verification passed, which the
 *         protocol requires before collecting fees on a settlement.
 *
 * ── Attestation schema (v1) ────────────────────────────────────────────
 *
 * The `Attestation` struct is versioned. Fields MUST be kept in the
 * declared order because on-chain code computes the canonical signing
 * input as `abi.encode(all fields except signature)`. Changing the order
 * or omitting fields is an ABI break and will invalidate every in-flight
 * signature.
 *
 * Forward compatibility:
 * - `version` lets future schemas bump (v2, v3, …) without reshuffling the
 *   current fields. Verifier implementations branch on version.
 * - `extraData` is a typed escape hatch for version-specific extension
 *   fields (e.g. `chainId`, `zkProofRoot`, per-capability metadata). v1
 *   MUST emit `extraData = 0x` (empty) — a non-empty v1 extraData does
 *   NOT invalidate a signature, but nothing in v1 interprets it.
 *   When v2 is introduced, `extraData` will hold an ABI-encoded v2
 *   extension payload, and the v2 branch of `verifyAttestation` will
 *   decode it.
 * - `signature` stays LAST. Callers build the signing hash as:
 *     keccak256(abi.encode(version, escrowAddress, jobId, evidenceHash,
 *                          tier, verified, timestamp, nonce, extraData))
 *   which deliberately excludes `signature`. Attackers cannot swap any
 *   individual field (including `extraData`) without invalidating the
 *   signature.
 */
interface IPCCOracle {
    /// @notice v1 schema version constant (use when constructing v1 attestations).
    /// @dev Exposed as a library-style constant via a view on implementations.
    struct Attestation {
        uint8   version;         // Schema version. v1 = 1. verifyAttestation rejects unsupported.
        address escrowAddress;   // Escrow this attestation is for
        string  jobId;           // Off-chain job identifier (non-empty)
        bytes32 evidenceHash;    // Hash of the evidence bundle
        uint8   tier;            // Assurance tier (0-3)
        bool    verified;        // Verification verdict from oracle
        uint256 timestamp;       // Unix seconds when oracle produced this
        bytes32 nonce;           // Replay-protection nonce
        bytes   extraData;       // Versioned extension payload (0x for v1)
        bytes   signature;       // ECDSA(signing hash) by oracleAddress()
    }

    /// @notice Verify an oracle attestation signature.
    /// @dev Implementations MUST:
    ///      1. Return false on unsupported `version`.
    ///      2. Compute signingHash = keccak256(abi.encode(
    ///           version, escrowAddress, jobId, evidenceHash, tier,
    ///           verified, timestamp, nonce, extraData
    ///         )) — i.e. every field except `signature`.
    ///      3. ECDSA-recover the signer from signingHash + signature.
    ///      4. Return true iff recovered signer == oracleAddress().
    /// @param attestation The attestation to verify.
    /// @return valid True if the signature is from the authorized oracle.
    function verifyAttestation(
        Attestation calldata attestation
    ) external view returns (bool valid);

    /// @notice Get the oracle's signing address.
    function oracleAddress() external view returns (address);
}
