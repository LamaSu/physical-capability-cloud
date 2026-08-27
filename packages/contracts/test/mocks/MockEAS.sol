// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IEAS, EASAttestation, AttestationRequest} from "../../src/interfaces/IEAS.sol";

/**
 * @title MockEAS
 * @notice Test double for the Ethereum Attestation Service.
 *
 * Implements IEAS.getAttestation(bytes32) returning a settable EASAttestation.
 * Tests control every field via setAttestation() or the field-level setters.
 * An unset (unknown) uid returns a zero struct — uid==bytes32(0) — which causes
 * MilestoneEscrowV2.submitAttestation to revert "Attestation not found".
 *
 * Helper encodeData() ABI-encodes the 7-field pcc.evidence.v1 schema payload:
 *   (string jobId, bytes32 kernelId, bytes32 evidenceBundleHash, string ipfsCid,
 *    uint8 assuranceTier, bool oracleVerified, bytes32 stepId)
 *
 * Authored by: test-writer-echo
 */
contract MockEAS is IEAS {
    // uid → full attestation
    mapping(bytes32 => EASAttestation) private _attestations;

    // ── Batch setter ────────────────────────────────────────────────────────

    /**
     * @notice Store a full attestation for the given uid.
     * @dev The uid field of `att` MUST match `uid` for the escrow's `a.uid != 0` check.
     */
    function setAttestation(bytes32 uid, EASAttestation memory att) external {
        _attestations[uid] = att;
    }

    // ── Field-level setters for ergonomic per-test mutation ──────────────────

    function setAttester(bytes32 uid, address attester_) external {
        _attestations[uid].attester = attester_;
    }

    function setSchema(bytes32 uid, bytes32 schema_) external {
        _attestations[uid].schema = schema_;
    }

    function setRecipient(bytes32 uid, address recipient_) external {
        _attestations[uid].recipient = recipient_;
    }

    function setRevocationTime(bytes32 uid, uint64 t) external {
        _attestations[uid].revocationTime = t;
    }

    function setExpirationTime(bytes32 uid, uint64 t) external {
        _attestations[uid].expirationTime = t;
    }

    function setData(bytes32 uid, bytes memory data_) external {
        _attestations[uid].data = data_;
    }

    // ── IEAS implementation ──────────────────────────────────────────────────

    /**
     * @notice Returns the attestation for uid.  Returns a zero struct (uid == 0)
     *         for any uid that was never set — mirrors EAS behaviour for unknown uids.
     */
    function getAttestation(bytes32 uid) external view override returns (EASAttestation memory) {
        return _attestations[uid];
    }

    /**
     * @notice Record a new attestation (the EAS write surface). `msg.sender` becomes the `attester`.
     *         Returns a deterministic uid and stores the full struct so a later getAttestation resolves it.
     */
    function attest(AttestationRequest calldata request) external payable override returns (bytes32 uid) {
        uid = keccak256(abi.encode(request.schema, request.data.recipient, request.data.data, msg.sender, block.number));
        EASAttestation storage a = _attestations[uid];
        a.uid = uid;
        a.schema = request.schema;
        a.time = uint64(block.timestamp);
        a.expirationTime = request.data.expirationTime;
        a.revocationTime = 0;
        a.refUID = request.data.refUID;
        a.recipient = request.data.recipient;
        a.attester = msg.sender;
        a.revocable = request.data.revocable;
        a.data = request.data.data;
    }

    // ── Schema-payload helper ────────────────────────────────────────────────

    /**
     * @notice ABI-encode the 7-field pcc.evidence.v1 schema payload used by
     *         MilestoneEscrowV2.submitAttestation's abi.decode call.
     *
     * @param jobId               PCC job id string.
     * @param kernelId            bytes32 kernel identifier.
     * @param evidenceBundleHash  sha256/keccak evidence bundle hash.
     * @param ipfsCid             IPFS CID (may be empty).
     * @param assuranceTier       0-3 tier actually achieved.
     * @param oracleVerified      oracle pass/fail verdict.
     * @param stepId              per-milestone binding — keccak256(bytes(stepIdString)).
     */
    function encodeData(
        string memory jobId,
        bytes32 kernelId,
        bytes32 evidenceBundleHash,
        string memory ipfsCid,
        uint8 assuranceTier,
        bool oracleVerified,
        bytes32 stepId
    ) external pure returns (bytes memory) {
        return abi.encode(jobId, kernelId, evidenceBundleHash, ipfsCid, assuranceTier, oracleVerified, stepId);
    }
}
