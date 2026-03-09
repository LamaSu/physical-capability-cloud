// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IdentityRegistry} from "./IdentityRegistry.sol";

/**
 * @title ReputationRegistry
 * @notice ERC-8004 Reputation Registry for PCC entities.
 *
 * Tracks reputation scores (0-1000) for registered entities.
 * Scores are updated by authorized attesters (verifiers, escrow contracts).
 *
 * Reputation events:
 *   - job_completed: +10 to +50 depending on tier
 *   - dispute_won: +20 (for the winner)
 *   - dispute_lost: -50 to -200 depending on severity
 *   - verification_performed: +5 to +20
 *   - bond_slashed: -100 to -500
 */
contract ReputationRegistry {
    // ── Types ────────────────────────────────────────────────────────────

    struct ReputationRecord {
        uint256 entityId;
        uint256 score;          // 0-1000
        uint256 totalJobs;
        uint256 successfulJobs;
        uint256 disputesWon;
        uint256 disputesLost;
        uint256 lastUpdated;
    }

    // ── State ────────────────────────────────────────────────────────────

    IdentityRegistry public identityRegistry;
    address public admin;
    mapping(address => bool) public authorizedAttesters;
    mapping(uint256 => ReputationRecord) public reputations;  // entityId -> reputation

    // ── Events ───────────────────────────────────────────────────────────

    event ReputationUpdated(
        uint256 indexed entityId,
        uint256 oldScore,
        uint256 newScore,
        string reason
    );
    event AttesterAuthorized(address indexed attester);
    event AttesterRevoked(address indexed attester);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin");
        _;
    }

    modifier onlyAttester() {
        require(authorizedAttesters[msg.sender] || msg.sender == admin, "Not authorized attester");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(address _identityRegistry) {
        admin = msg.sender;
        identityRegistry = IdentityRegistry(_identityRegistry);
    }

    // ── Attester Management ──────────────────────────────────────────────

    function authorizeAttester(address _attester) external onlyAdmin {
        authorizedAttesters[_attester] = true;
        emit AttesterAuthorized(_attester);
    }

    function revokeAttester(address _attester) external onlyAdmin {
        authorizedAttesters[_attester] = false;
        emit AttesterRevoked(_attester);
    }

    // ── Reputation Updates ───────────────────────────────────────────────

    /**
     * @notice Record a successful job completion. Increases reputation.
     */
    function recordJobCompletion(uint256 entityId, uint256 bonus) external onlyAttester {
        ReputationRecord storage rep = reputations[entityId];
        _initIfNeeded(rep, entityId);

        uint256 oldScore = rep.score;
        uint256 increase = 10 + (bonus > 40 ? 40 : bonus); // 10-50
        rep.score = _clamp(rep.score + increase);
        rep.totalJobs++;
        rep.successfulJobs++;
        rep.lastUpdated = block.timestamp;

        emit ReputationUpdated(entityId, oldScore, rep.score, "job_completed");
    }

    /**
     * @notice Record a dispute outcome.
     */
    function recordDisputeOutcome(uint256 entityId, bool won) external onlyAttester {
        ReputationRecord storage rep = reputations[entityId];
        _initIfNeeded(rep, entityId);

        uint256 oldScore = rep.score;
        if (won) {
            rep.score = _clamp(rep.score + 20);
            rep.disputesWon++;
        } else {
            rep.score = rep.score > 50 ? rep.score - 50 : 0;
            rep.disputesLost++;
        }
        rep.lastUpdated = block.timestamp;

        emit ReputationUpdated(entityId, oldScore, rep.score, won ? "dispute_won" : "dispute_lost");
    }

    /**
     * @notice Record a bond slash. Severe reputation penalty.
     */
    function recordSlash(uint256 entityId, uint256 penalty) external onlyAttester {
        ReputationRecord storage rep = reputations[entityId];
        _initIfNeeded(rep, entityId);

        uint256 oldScore = rep.score;
        uint256 actualPenalty = penalty > 500 ? 500 : penalty; // cap at 500
        rep.score = rep.score > actualPenalty ? rep.score - actualPenalty : 0;
        rep.lastUpdated = block.timestamp;

        emit ReputationUpdated(entityId, oldScore, rep.score, "bond_slashed");
    }

    /**
     * @notice Admin can set reputation directly (for bootstrapping/corrections).
     */
    function setReputation(uint256 entityId, uint256 score) external onlyAdmin {
        ReputationRecord storage rep = reputations[entityId];
        _initIfNeeded(rep, entityId);

        uint256 oldScore = rep.score;
        rep.score = _clamp(score);
        rep.lastUpdated = block.timestamp;

        emit ReputationUpdated(entityId, oldScore, rep.score, "admin_set");
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getReputation(uint256 entityId) external view returns (ReputationRecord memory) {
        return reputations[entityId];
    }

    function getScore(uint256 entityId) external view returns (uint256) {
        return reputations[entityId].score;
    }

    // ── Internal ─────────────────────────────────────────────────────────

    function _initIfNeeded(ReputationRecord storage rep, uint256 entityId) internal {
        if (rep.entityId == 0) {
            rep.entityId = entityId;
            rep.score = 500; // Start at midpoint
            rep.lastUpdated = block.timestamp;
        }
    }

    function _clamp(uint256 score) internal pure returns (uint256) {
        return score > 1000 ? 1000 : score;
    }
}
