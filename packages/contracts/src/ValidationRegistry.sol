// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";

/**
 * @title ValidationRegistry
 * @notice ERC-8004 Validation Registry for PCC.
 *
 * Stores on-chain attestations about entity capabilities and certifications.
 * Validators (authorized entities) can attest to:
 *   - Machine capabilities (verified by physical inspection or evidence)
 *   - Operator certifications (safety, quality, specific equipment)
 *   - Verifier qualifications (tier authorization)
 *
 * Each attestation has an expiry and can be revoked.
 */
contract ValidationRegistry {
    // ── Types ────────────────────────────────────────────────────────────

    struct Attestation {
        uint256 id;
        uint256 subjectId;        // Entity being attested
        address validator;         // Who is attesting
        bytes32 claimHash;         // SHA-256 of claim data (capability spec, cert details)
        string claimType;          // "capability", "certification", "tier_authorization"
        uint256 issuedAt;
        uint256 expiresAt;
        bool revoked;
    }

    // ── State ────────────────────────────────────────────────────────────

    IdentityRegistry public identityRegistry;
    address public admin;
    mapping(address => bool) public authorizedValidators;

    uint256 public nextAttestationId = 1;
    mapping(uint256 => Attestation) public attestations;              // attestation ID -> attestation
    mapping(uint256 => uint256[]) public entityAttestations;          // entity ID -> attestation IDs
    mapping(address => uint256[]) public validatorAttestations;       // validator -> attestation IDs

    // ── Events ───────────────────────────────────────────────────────────

    event AttestationCreated(
        uint256 indexed attestationId,
        uint256 indexed subjectId,
        address indexed validator,
        string claimType,
        bytes32 claimHash
    );
    event AttestationRevoked(uint256 indexed attestationId, address indexed revokedBy);
    event ValidatorAuthorized(address indexed validator);
    event ValidatorRevoked(address indexed validator);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier onlyValidator() {
        require(authorizedValidators[msg.sender] || msg.sender == admin, "Not authorized validator");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(address _identityRegistry) {
        admin = msg.sender;
        identityRegistry = IdentityRegistry(_identityRegistry);
    }

    // ── Validator Management ─────────────────────────────────────────────

    function authorizeValidator(address _validator) external onlyAdmin {
        authorizedValidators[_validator] = true;
        emit ValidatorAuthorized(_validator);
    }

    function revokeValidator(address _validator) external onlyAdmin {
        authorizedValidators[_validator] = false;
        emit ValidatorRevoked(_validator);
    }

    // ── Attestation ──────────────────────────────────────────────────────

    /**
     * @notice Create an attestation for an entity.
     */
    function attest(
        uint256 _subjectId,
        bytes32 _claimHash,
        string calldata _claimType,
        uint256 _durationSeconds
    ) external onlyValidator returns (uint256) {
        uint256 id = nextAttestationId++;

        attestations[id] = Attestation({
            id: id,
            subjectId: _subjectId,
            validator: msg.sender,
            claimHash: _claimHash,
            claimType: _claimType,
            issuedAt: block.timestamp,
            expiresAt: block.timestamp + _durationSeconds,
            revoked: false
        });

        entityAttestations[_subjectId].push(id);
        validatorAttestations[msg.sender].push(id);

        emit AttestationCreated(id, _subjectId, msg.sender, _claimType, _claimHash);
        return id;
    }

    /**
     * @notice Revoke an attestation. Only the original validator or admin.
     */
    function revokeAttestation(uint256 attestationId) external {
        Attestation storage a = attestations[attestationId];
        require(a.id > 0, "Attestation does not exist");
        require(
            msg.sender == a.validator || msg.sender == admin,
            "Not authorized to revoke"
        );
        require(!a.revoked, "Already revoked");

        a.revoked = true;
        emit AttestationRevoked(attestationId, msg.sender);
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getAttestation(uint256 attestationId) external view returns (Attestation memory) {
        return attestations[attestationId];
    }

    function getEntityAttestationIds(uint256 entityId) external view returns (uint256[] memory) {
        return entityAttestations[entityId];
    }

    function getValidatorAttestationIds(address validator) external view returns (uint256[] memory) {
        return validatorAttestations[validator];
    }

    /**
     * @notice Check if an entity has a valid (non-expired, non-revoked) attestation of a given type.
     */
    function hasValidAttestation(uint256 entityId, string calldata claimType) external view returns (bool) {
        uint256[] storage ids = entityAttestations[entityId];
        for (uint256 i = 0; i < ids.length; i++) {
            Attestation storage a = attestations[ids[i]];
            if (
                !a.revoked &&
                a.expiresAt > block.timestamp &&
                keccak256(bytes(a.claimType)) == keccak256(bytes(claimType))
            ) {
                return true;
            }
        }
        return false;
    }

    function getAttestationCount() external view returns (uint256) {
        return nextAttestationId - 1;
    }
}
