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
 * @title AttestationRequestData
 * @notice The per-attestation payload of an EAS `attest` call. Field order/types are VERBATIM from the
 *         canonical EAS `Common.sol` — the EAS contract ABI-decodes this exact layout. Consumed by the
 *         O5 cohort attester when it WRITES an O5 verdict into EAS.
 * @param recipient       The recipient of the attestation (here: the settling escrow).
 * @param expirationTime  Expiration timestamp (0 = never).
 * @param revocable       Whether the attestation is revocable (O5 mints are non-revocable).
 * @param refUID          Referenced attestation UID (0 = none).
 * @param data            ABI-encoded schema payload (here: `abi.encode(O5Verdict)`).
 * @param value           Native value forwarded with the attestation (here: 0).
 */
struct AttestationRequestData {
    address recipient;
    uint64 expirationTime;
    bool revocable;
    bytes32 refUID;
    bytes data;
    uint256 value;
}

/**
 * @title AttestationRequest
 * @notice A single-attestation `attest` request: the schema UID + its payload. Mirrors EAS `IEAS.sol`.
 */
struct AttestationRequest {
    bytes32 schema;
    AttestationRequestData data;
}

/**
 * @title IEAS
 * @notice Minimal EAS surface. `getAttestation` is the READ the escrow uses to validate an attestation
 *         by UID; `attest` is the WRITE the O5 cohort attester uses to BECOME the recorded `attester`.
 */
interface IEAS {
    /// @notice Returns the attestation for the given UID. Returns a zero struct if the UID
    ///         does not exist (callers MUST check `uid != bytes32(0)`).
    function getAttestation(bytes32 uid) external view returns (EASAttestation memory);

    /// @notice Creates a new attestation and returns its UID. `msg.sender` is recorded as the `attester`.
    function attest(AttestationRequest calldata request) external payable returns (bytes32);
}
