// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/**
 * @title MilestoneEscrow
 * @notice Escrow contract for Physical Capability Cloud workflows.
 *
 * Each workflow (CWM) gets a MilestoneEscrow instance. The escrow holds funds
 * for each step (milestone) and releases them to operators after:
 *   1. Evidence bundle hash is submitted by the kernel
 *   2. Verifier attestation is submitted
 *   3. Challenge window expires without dispute
 *
 * If disputed, an arbiter resolves. Bonds are slashed for proven fraud.
 *
 * Flow: fund → submitEvidence → submitAttestation → [challenge window] → release
 */
contract MilestoneEscrow {
    // ── Types ────────────────────────────────────────────────────────────

    enum MilestoneStatus {
        Unfunded,     // 0 - Created but no funds
        Funded,       // 1 - Payer deposited funds
        Locked,       // 2 - Step is in progress
        Evidenced,    // 3 - Evidence submitted by kernel
        Attested,     // 4 - Verifier attested; challenge window open
        Released,     // 5 - Payment sent to operator
        Disputed,     // 6 - Under arbitration
        Refunded,     // 7 - Funds returned to payer
        Slashed       // 8 - Operator bond slashed
    }

    struct Milestone {
        bytes32 stepId;
        address operator;
        uint256 amount;
        uint256 operatorBond;
        MilestoneStatus status;
        bytes32 evidenceBundleHash;
        bytes32 verifierAttestationHash;
        uint256 challengeWindowEnd;
        uint256 challengeWindowSeconds;
    }

    struct Dispute {
        address challenger;
        uint256 challengerBond;
        bytes32 challengerEvidenceHash;
        string reason;
        bool resolved;
        bool challengerWon;
    }

    // ── State ────────────────────────────────────────────────────────────

    address public payer;
    address public arbiter;
    IERC20 public token;
    bytes32 public cwmId;

    Milestone[] public milestones;
    mapping(uint256 => Dispute) public disputes;

    bool public funded;
    uint256 public totalAmount;

    // ── Events ───────────────────────────────────────────────────────────

    event EscrowFunded(bytes32 indexed cwmId, uint256 totalAmount);
    event MilestoneLocked(uint256 indexed milestoneIndex, bytes32 stepId);
    event EvidenceSubmitted(uint256 indexed milestoneIndex, bytes32 evidenceBundleHash);
    event AttestationSubmitted(uint256 indexed milestoneIndex, bytes32 attestationHash, uint256 challengeWindowEnd);
    event MilestoneReleased(uint256 indexed milestoneIndex, address operator, uint256 amount);
    event DisputeFiled(uint256 indexed milestoneIndex, address challenger, uint256 bond);
    event DisputeResolved(uint256 indexed milestoneIndex, bool challengerWon);
    event MilestoneRefunded(uint256 indexed milestoneIndex, uint256 amount);
    event BondSlashed(uint256 indexed milestoneIndex, address slashedParty, uint256 amount);

    // ── Modifiers ────────────────────────────────────────────────────────

    modifier onlyPayer() {
        require(msg.sender == payer, "Only payer");
        _;
    }

    modifier onlyArbiter() {
        require(msg.sender == arbiter, "Only arbiter");
        _;
    }

    modifier milestoneExists(uint256 idx) {
        require(idx < milestones.length, "Milestone does not exist");
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────

    constructor(
        address _payer,
        address _arbiter,
        address _token,
        bytes32 _cwmId
    ) {
        payer = _payer;
        arbiter = _arbiter;
        token = IERC20(_token);
        cwmId = _cwmId;
    }

    // ── Setup ────────────────────────────────────────────────────────────

    /**
     * @notice Add a milestone. Must be called before funding.
     */
    function addMilestone(
        bytes32 _stepId,
        address _operator,
        uint256 _amount,
        uint256 _operatorBond,
        uint256 _challengeWindowSeconds
    ) external onlyPayer {
        require(!funded, "Already funded");
        milestones.push(Milestone({
            stepId: _stepId,
            operator: _operator,
            amount: _amount,
            operatorBond: _operatorBond,
            status: MilestoneStatus.Unfunded,
            evidenceBundleHash: bytes32(0),
            verifierAttestationHash: bytes32(0),
            challengeWindowEnd: 0,
            challengeWindowSeconds: _challengeWindowSeconds
        }));
        totalAmount += _amount;
    }

    /**
     * @notice Fund the escrow. Transfers totalAmount + total operator bonds from payer.
     *         Operators must also deposit their bonds separately.
     */
    function fund() external onlyPayer {
        require(!funded, "Already funded");
        require(milestones.length > 0, "No milestones");

        require(token.transferFrom(msg.sender, address(this), totalAmount), "Transfer failed");

        for (uint256 i = 0; i < milestones.length; i++) {
            milestones[i].status = MilestoneStatus.Funded;
        }
        funded = true;
        emit EscrowFunded(cwmId, totalAmount);
    }

    /**
     * @notice Operator deposits their bond for a milestone.
     */
    function depositBond(uint256 milestoneIndex) external milestoneExists(milestoneIndex) {
        Milestone storage m = milestones[milestoneIndex];
        require(msg.sender == m.operator, "Only operator");
        require(m.status == MilestoneStatus.Funded, "Not funded");
        require(m.operatorBond > 0, "No bond required");

        require(token.transferFrom(msg.sender, address(this), m.operatorBond), "Bond transfer failed");
        m.status = MilestoneStatus.Locked;
        emit MilestoneLocked(milestoneIndex, m.stepId);
    }

    // ── Execution Flow ───────────────────────────────────────────────────

    /**
     * @notice Operator submits evidence bundle hash after job completion.
     */
    function submitEvidence(uint256 milestoneIndex, bytes32 _evidenceBundleHash)
        external
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(msg.sender == m.operator, "Only operator");
        require(
            m.status == MilestoneStatus.Locked ||
            (m.status == MilestoneStatus.Funded && m.operatorBond == 0),
            "Invalid status"
        );

        m.evidenceBundleHash = _evidenceBundleHash;
        m.status = MilestoneStatus.Evidenced;
        emit EvidenceSubmitted(milestoneIndex, _evidenceBundleHash);
    }

    /**
     * @notice Verifier submits attestation hash. Opens challenge window.
     */
    function submitAttestation(uint256 milestoneIndex, bytes32 _attestationHash)
        external
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Evidenced, "Evidence not submitted");

        m.verifierAttestationHash = _attestationHash;
        m.challengeWindowEnd = block.timestamp + m.challengeWindowSeconds;
        m.status = MilestoneStatus.Attested;
        emit AttestationSubmitted(milestoneIndex, _attestationHash, m.challengeWindowEnd);
    }

    /**
     * @notice Release funds to operator after challenge window expires.
     */
    function release(uint256 milestoneIndex) external milestoneExists(milestoneIndex) {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Attested, "Not attested");
        require(block.timestamp >= m.challengeWindowEnd, "Challenge window open");

        uint256 payout = m.amount + m.operatorBond; // Return bond + payment
        require(token.transfer(m.operator, payout), "Transfer failed");

        m.status = MilestoneStatus.Released;
        emit MilestoneReleased(milestoneIndex, m.operator, m.amount);
    }

    // ── Disputes ─────────────────────────────────────────────────────────

    /**
     * @notice File a dispute during the challenge window. Requires a bond.
     */
    function fileDispute(
        uint256 milestoneIndex,
        uint256 _challengerBond,
        bytes32 _challengerEvidenceHash,
        string calldata _reason
    ) external milestoneExists(milestoneIndex) {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Attested, "Cannot dispute");
        require(block.timestamp < m.challengeWindowEnd, "Challenge window closed");
        require(_challengerBond > 0, "Bond required");

        require(token.transferFrom(msg.sender, address(this), _challengerBond), "Bond transfer failed");

        disputes[milestoneIndex] = Dispute({
            challenger: msg.sender,
            challengerBond: _challengerBond,
            challengerEvidenceHash: _challengerEvidenceHash,
            reason: _reason,
            resolved: false,
            challengerWon: false
        });

        m.status = MilestoneStatus.Disputed;
        emit DisputeFiled(milestoneIndex, msg.sender, _challengerBond);
    }

    /**
     * @notice Arbiter resolves a dispute.
     */
    function resolveDispute(uint256 milestoneIndex, bool _challengerWon)
        external
        onlyArbiter
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Disputed, "Not disputed");

        Dispute storage d = disputes[milestoneIndex];
        require(!d.resolved, "Already resolved");

        d.resolved = true;
        d.challengerWon = _challengerWon;

        if (_challengerWon) {
            // Refund payer + return challenger bond + slash operator bond
            uint256 refund = m.amount;
            require(token.transfer(payer, refund), "Refund failed");
            require(token.transfer(d.challenger, d.challengerBond + m.operatorBond), "Challenger payout failed");
            m.status = MilestoneStatus.Slashed;
            emit BondSlashed(milestoneIndex, m.operator, m.operatorBond);
        } else {
            // Release to operator + slash challenger bond
            uint256 payout = m.amount + m.operatorBond + d.challengerBond;
            require(token.transfer(m.operator, payout), "Operator payout failed");
            m.status = MilestoneStatus.Released;
            emit BondSlashed(milestoneIndex, d.challenger, d.challengerBond);
        }

        emit DisputeResolved(milestoneIndex, _challengerWon);
    }

    // ── Views ────────────────────────────────────────────────────────────

    function getMilestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    function getMilestone(uint256 idx) external view returns (Milestone memory) {
        return milestones[idx];
    }

    function getDispute(uint256 idx) external view returns (Dispute memory) {
        return disputes[idx];
    }
}
