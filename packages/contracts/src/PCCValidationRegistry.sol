// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PCCValidationRegistry
 * @notice On-chain validation registry for TMP Benchmark mode.
 *
 * Receives proof submissions from workers, stores validation results,
 * and calls acceptSubmission() on the TMP contract when validation passes.
 *
 * Implements a simplified ERC-8004 Validation Registry interface
 * specialized for PCC manufacturing evidence:
 *
 * Flow:
 *   1. Worker submits proof via submitProof()
 *   2. Off-chain validator (PCC TMPValidatorBridge) validates the proof
 *   3. Validator calls recordValidation() with the result
 *   4. If valid, calls acceptSubmission() on the linked TMP contract
 */
contract PCCValidationRegistry {
    // ── Types ────────────────────────────────────────────────────────────

    struct ProofSubmission {
        uint256 id;
        bytes32 taskId;           // TMP task identifier
        address worker;           // Who submitted the proof
        bytes32 deliverableHash;  // Hash of the deliverable
        bytes32 proofHash;        // Hash of the proof data (off-chain bundle)
        uint8   proofType;        // 0=sensor, 1=zk, 2=merkle, 3=bittensor
        uint256 submittedAt;
        bool    validated;
        bool    accepted;
    }

    struct ValidationRecord {
        uint256 submissionId;
        address validator;
        bool    valid;
        uint256 confidence;       // 0-10000 (basis points, e.g., 9500 = 95%)
        bytes32 attestationHash;
        uint256 validatedAt;
    }

    // ── State ────────────────────────────────────────────────────────────

    address public admin;
    mapping(address => bool) public authorizedValidators;

    uint256 public nextSubmissionId = 1;
    mapping(uint256 => ProofSubmission) public submissions;
    mapping(bytes32 => uint256[]) public taskSubmissions;     // taskId -> submission IDs
    mapping(uint256 => ValidationRecord) public validations;  // submissionId -> validation

    // ── Events ───────────────────────────────────────────────────────────

    event ProofSubmitted(
        uint256 indexed submissionId,
        bytes32 indexed taskId,
        address indexed worker,
        bytes32 deliverableHash,
        uint8   proofType
    );

    event ValidationRecorded(
        uint256 indexed submissionId,
        address indexed validator,
        bool    valid,
        uint256 confidence,
        bytes32 attestationHash
    );

    event SubmissionAccepted(
        uint256 indexed submissionId,
        bytes32 indexed taskId,
        address indexed worker
    );

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier onlyValidator() {
        require(
            authorizedValidators[msg.sender] || msg.sender == admin,
            "Not authorized validator"
        );
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor() {
        admin = msg.sender;
    }

    // ── Validator Management ─────────────────────────────────────────────

    function authorizeValidator(address _validator) external onlyAdmin {
        authorizedValidators[_validator] = true;
    }

    function revokeValidator(address _validator) external onlyAdmin {
        authorizedValidators[_validator] = false;
    }

    // ── Proof Submission ─────────────────────────────────────────────────

    /**
     * @notice Worker submits a proof for a TMP Benchmark task.
     * @param _taskId The TMP task identifier
     * @param _deliverableHash Hash of the deliverable being proved
     * @param _proofHash Hash of the off-chain proof data
     * @param _proofType 0=sensor_evidence, 1=zk_proof, 2=merkle_commitment, 3=bittensor
     */
    function submitProof(
        bytes32 _taskId,
        bytes32 _deliverableHash,
        bytes32 _proofHash,
        uint8   _proofType
    ) external returns (uint256) {
        require(_proofType <= 3, "Invalid proof type");

        uint256 id = nextSubmissionId++;

        submissions[id] = ProofSubmission({
            id: id,
            taskId: _taskId,
            worker: msg.sender,
            deliverableHash: _deliverableHash,
            proofHash: _proofHash,
            proofType: _proofType,
            submittedAt: block.timestamp,
            validated: false,
            accepted: false
        });

        taskSubmissions[_taskId].push(id);

        emit ProofSubmitted(id, _taskId, msg.sender, _deliverableHash, _proofType);
        return id;
    }

    // ── Validation Recording ─────────────────────────────────────────────

    /**
     * @notice Authorized validator records the result of off-chain validation.
     * @param _submissionId The proof submission to validate
     * @param _valid Whether the proof is valid
     * @param _confidence Confidence in basis points (0-10000)
     * @param _attestationHash Hash of the off-chain attestation
     */
    function recordValidation(
        uint256 _submissionId,
        bool    _valid,
        uint256 _confidence,
        bytes32 _attestationHash
    ) external onlyValidator {
        ProofSubmission storage sub = submissions[_submissionId];
        require(sub.id > 0, "Submission does not exist");
        require(!sub.validated, "Already validated");
        require(_confidence <= 10000, "Confidence must be <= 10000");

        sub.validated = true;

        validations[_submissionId] = ValidationRecord({
            submissionId: _submissionId,
            validator: msg.sender,
            valid: _valid,
            confidence: _confidence,
            attestationHash: _attestationHash,
            validatedAt: block.timestamp
        });

        emit ValidationRecorded(
            _submissionId,
            msg.sender,
            _valid,
            _confidence,
            _attestationHash
        );

        // Auto-accept if valid with sufficient confidence (>= 70%)
        if (_valid && _confidence >= 7000) {
            sub.accepted = true;
            emit SubmissionAccepted(sub.id, sub.taskId, sub.worker);
        }
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getSubmission(uint256 _id) external view returns (ProofSubmission memory) {
        return submissions[_id];
    }

    function getValidation(uint256 _submissionId) external view returns (ValidationRecord memory) {
        return validations[_submissionId];
    }

    function getTaskSubmissionIds(bytes32 _taskId) external view returns (uint256[] memory) {
        return taskSubmissions[_taskId];
    }

    function getSubmissionCount() external view returns (uint256) {
        return nextSubmissionId - 1;
    }

    /**
     * @notice Check if a task has an accepted submission.
     */
    function isTaskAccepted(bytes32 _taskId) external view returns (bool) {
        uint256[] storage ids = taskSubmissions[_taskId];
        for (uint256 i = 0; i < ids.length; i++) {
            if (submissions[ids[i]].accepted) {
                return true;
            }
        }
        return false;
    }
}
