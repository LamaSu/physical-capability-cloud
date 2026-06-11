// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Authored by implementer-alpha — EAS attestation-bridge migration (deliverable 1).

/**
 * @title EASAttestation
 * @notice Minimal mirror of the Ethereum Attestation Service `Attestation` struct
 *         (eas-contracts `Common.sol`). Field order and types are VERBATIM from the
 *         canonical EAS contract — they are load-bearing because the EAS contract ABI-
 *         encodes this exact layout when returning `getAttestation`. We only consume the
 *         returned struct; we never construct one for EAS.
 *
 * @dev Embedded here (rather than importing the full eas-contracts library) to avoid
 *      adding a Foundry submodule / remappings entry. See migration design §3.3 "Notes".
 *
 * @param uid             Unique attestation identifier (zero for non-existent attestations).
 * @param schema          The UID of the schema this attestation conforms to.
 * @param time            Creation timestamp (EAS-recorded, chain-authoritative).
 * @param expirationTime  Expiration timestamp (0 = never expires).
 * @param revocationTime  Revocation timestamp (0 = not revoked).
 * @param refUID          UID of a referenced/related attestation (0 = none).
 * @param recipient       The recipient of the attestation.
 * @param attester        The address that produced the attestation (the trusted-attester gate).
 * @param revocable       Whether the attestation is revocable.
 * @param data            Custom ABI-encoded attestation payload (the schema-encoded fields).
 */
struct EASAttestation {
    bytes32 uid;
    bytes32 schema;
    uint64 time;
    uint64 expirationTime;
    uint64 revocationTime;
    bytes32 refUID;
    address recipient;
    address attester;
    bool revocable;
    bytes data;
}

/**
 * @title IEAS
 * @notice Minimal EAS surface consumed by MilestoneEscrowV2. Only the read method the
 *         escrow needs to validate an attestation by UID is declared.
 */
interface IEAS {
    /// @notice Returns the attestation for the given UID. Returns a zero struct if the UID
    ///         does not exist (callers MUST check `uid != bytes32(0)`).
    function getAttestation(bytes32 uid) external view returns (EASAttestation memory);
}
