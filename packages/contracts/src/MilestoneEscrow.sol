// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPGTRForwarder} from "./interfaces/IPGTRForwarder.sol";
import {IPCCProtocol} from "./interfaces/IPCCProtocol.sol";
import {IPCCOracle} from "./interfaces/IPCCOracle.sol";

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

    /// @notice The PCCProtocol root contract. Set at deployment (immutable).
    /// @dev Zero address means no protocol root (standalone / legacy deployment).
    address public immutable protocolRoot;

    Milestone[] public milestones;
    mapping(uint256 => Dispute) public disputes;

    bool public funded;
    uint256 public totalAmount;

    // ── Reentrancy Guard ─────────────────────────────────────────────────

    uint256 private _locked = 1;

    // ── Access Control ───────────────────────────────────────────────────

    /// @notice Addresses authorized to submit verifier attestations.
    mapping(address => bool) public authorizedVerifiers;

    // ── PGTR Trusted Forwarders ─────────────────────────────────────────

    /// @notice Trusted PGTR forwarder contracts that can relay calls on behalf of users.
    mapping(address => bool) public trustedForwarders;

    // ── Events ───────────────────────────────────────────────────────────

    event ForwarderAdded(address indexed forwarder);
    event ForwarderRemoved(address indexed forwarder);

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

    modifier nonReentrant() {
        require(_locked == 1, "Reentrant call");
        _locked = 2;
        _;
        _locked = 1;
    }

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

    /**
     * @param _payer      Address that funds the escrow and can add milestones.
     * @param _arbiter    Address that resolves disputes.
     * @param _token      ERC-20 token used for payments.
     * @param _cwmId      Canonical Workflow Model identifier.
     * @param _protocolRoot PCCProtocol root address. Set to address(0) for standalone/legacy use.
     *                    When non-zero, a 1.5% (configurable) fee is deducted on release().
     */
    constructor(
        address _payer,
        address _arbiter,
        address _token,
        bytes32 _cwmId,
        address _protocolRoot
    ) {
        payer = _payer;
        arbiter = _arbiter;
        token = IERC20(_token);
        cwmId = _cwmId;
        protocolRoot = _protocolRoot;
    }

    // ── PGTR Forwarder Management ──────────────────────────────────────

    /**
     * @notice Add a trusted PGTR forwarder. Only the payer (contract owner) can add.
     * @param forwarder Address of the PCCForwarder contract to trust.
     */
    function addForwarder(address forwarder) external onlyPayer {
        require(forwarder != address(0), "Zero address");
        trustedForwarders[forwarder] = true;
        emit ForwarderAdded(forwarder);
    }

    /**
     * @notice Remove a trusted PGTR forwarder. Only the payer (contract owner) can remove.
     * @param forwarder Address of the forwarder to remove.
     */
    function removeForwarder(address forwarder) external onlyPayer {
        trustedForwarders[forwarder] = false;
        emit ForwarderRemoved(forwarder);
    }

    /**
     * @notice Resolve the effective sender. If called via a trusted PGTR forwarder,
     *         returns the original payer from the forwarder. Otherwise returns msg.sender.
     * @dev This maintains backward compatibility: direct calls still work as before.
     */
    function _effectiveSender() internal view returns (address) {
        if (trustedForwarders[msg.sender]) {
            // msg.sender is a trusted forwarder — get the original caller
            address sender = IPGTRForwarder(msg.sender).pgtrSender();
            require(sender != address(0), "PGTR: no sender set");
            return sender;
        }
        return msg.sender;
    }

    // ── Verifier Management ──────────────────────────────────────────────

    /**
     * @notice Authorize an address to submit attestations. Only the arbiter can manage verifiers.
     * @param verifier Address to authorize as a verifier.
     */
    function addVerifier(address verifier) external onlyArbiter {
        require(verifier != address(0), "Zero address");
        authorizedVerifiers[verifier] = true;
    }

    /**
     * @notice Remove an authorized verifier. Only the arbiter can manage verifiers.
     * @param verifier Address to deauthorize.
     */
    function removeVerifier(address verifier) external onlyArbiter {
        authorizedVerifiers[verifier] = false;
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
        address sender = _effectiveSender();
        require(sender == m.operator, "Only operator");
        require(m.status == MilestoneStatus.Funded, "Not funded");
        require(m.operatorBond > 0, "No bond required");

        require(token.transferFrom(sender, address(this), m.operatorBond), "Bond transfer failed");
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
        require(_effectiveSender() == m.operator, "Only operator");
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
     * @notice Verifier submits an oracle-signed attestation. Opens challenge window.
     * @dev Only authorized verifiers may call this. The milestone's operator is
     *      explicitly blocked from self-attesting their own evidence.
     *
     *      When a protocol root is configured, the attestation is verified on-chain
     *      against the oracle verifier before the challenge window opens. This
     *      fails closed on invalid signatures so bad attestations never enter the
     *      challenge window in the first place.
     *
     *      The stored attestationHash is keccak256(abi.encode(attestation)), which
     *      binds the milestone to the exact struct that release() must later pass
     *      back in for on-chain re-verification at settlement time.
     *
     * @param milestoneIndex The milestone being attested.
     * @param attestation The oracle-signed attestation for this milestone.
     */
    function submitAttestation(
        uint256 milestoneIndex,
        IPCCOracle.Attestation calldata attestation
    )
        external
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(authorizedVerifiers[msg.sender], "Not an authorized verifier");
        require(msg.sender != m.operator, "Operator cannot self-attest");
        require(m.status == MilestoneStatus.Evidenced, "Evidence not submitted");
        require(attestation.escrowAddress == address(this), "Attestation for wrong escrow");

        // Early oracle gate: if a protocol root is configured, fail closed on
        // invalid oracle signatures so a bad attestation never opens the window.
        if (protocolRoot != address(0)) {
            address oracle = IPCCProtocol(protocolRoot).oracleVerifier();
            require(oracle != address(0), "Oracle verifier not set");
            require(
                IPCCOracle(oracle).verifyAttestation(attestation),
                "Invalid oracle attestation"
            );
        }

        bytes32 attestationHash = keccak256(abi.encode(attestation));
        m.verifierAttestationHash = attestationHash;
        m.challengeWindowEnd = block.timestamp + m.challengeWindowSeconds;
        m.status = MilestoneStatus.Attested;
        emit AttestationSubmitted(milestoneIndex, attestationHash, m.challengeWindowEnd);
    }

    /**
     * @notice Release funds to operator after challenge window expires.
     *
     * The caller must supply the full oracle-signed Attestation struct that
     * was used to open the challenge window. It is re-verified on-chain
     * (double-checked at settlement time via PCCProtocol.collectFeeWithAttestation)
     * so a bad attestation fails the release even if the challenge window
     * trivially expires.
     *
     * Fee flow (when protocolRoot is set):
     *   fee = milestone.amount * protocolRoot.protocolFeeBps() / 10000
     *   token.transfer(protocolRoot.feeRecipient(), fee)
     *   token.transfer(operator, milestone.amount - fee + operatorBond)
     *   protocolRoot.collectFeeWithAttestation(token, fee, attestation)
     *     which re-runs IPCCOracle.verifyAttestation(attestation).
     *
     * Standalone escrows (protocolRoot == address(0)) ignore the attestation
     * argument and pay out the full amount + bond.
     *
     * @param milestoneIndex The milestone being released.
     * @param attestation The same oracle attestation struct submitted via
     *        submitAttestation. keccak256(abi.encode(attestation)) must equal
     *        the stored verifierAttestationHash.
     */
    function release(
        uint256 milestoneIndex,
        IPCCOracle.Attestation calldata attestation
    ) external nonReentrant milestoneExists(milestoneIndex) {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Attested, "Not attested");
        require(block.timestamp >= m.challengeWindowEnd, "Challenge window open");

        // Bind release to the exact attestation that opened the challenge window.
        require(
            keccak256(abi.encode(attestation)) == m.verifierAttestationHash,
            "Attestation mismatch"
        );

        // ── Checks-Effects-Interactions: update state before any external calls ──
        m.status = MilestoneStatus.Released;

        // Cache values needed for transfers before any external calls
        address operator = m.operator;
        uint256 amount = m.amount;
        uint256 operatorBond = m.operatorBond;

        emit MilestoneReleased(milestoneIndex, operator, amount);

        if (protocolRoot != address(0)) {
            IPCCProtocol root = IPCCProtocol(protocolRoot);
            uint256 feeBps = root.protocolFeeBps();
            uint256 fee = (amount * feeBps) / 10000;
            address recipient = root.feeRecipient();

            // Transfer fee to recipient
            require(token.transfer(recipient, fee), "Fee transfer failed");

            // Transfer net payment + bond to operator
            uint256 operatorPayout = amount - fee + operatorBond;
            require(token.transfer(operator, operatorPayout), "Transfer failed");

            // Oracle-gated accounting callback. Re-verifies the attestation
            // on-chain via PCCProtocol.requiresOracle modifier. No fee is
            // recorded without a valid oracle signature.
            root.collectFeeWithAttestation(address(token), fee, attestation);
        } else {
            uint256 payout = amount + operatorBond; // Return bond + payment
            require(token.transfer(operator, payout), "Transfer failed");
        }
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
        address sender = _effectiveSender();
        require(m.status == MilestoneStatus.Attested, "Cannot dispute");
        require(block.timestamp < m.challengeWindowEnd, "Challenge window closed");
        require(_challengerBond > 0, "Bond required");

        require(token.transferFrom(sender, address(this), _challengerBond), "Bond transfer failed");

        disputes[milestoneIndex] = Dispute({
            challenger: sender,
            challengerBond: _challengerBond,
            challengerEvidenceHash: _challengerEvidenceHash,
            reason: _reason,
            resolved: false,
            challengerWon: false
        });

        m.status = MilestoneStatus.Disputed;
        emit DisputeFiled(milestoneIndex, sender, _challengerBond);
    }

    /**
     * @notice Arbiter resolves a dispute.
     */
    function resolveDispute(uint256 milestoneIndex, bool _challengerWon)
        external
        nonReentrant
        onlyArbiter
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Disputed, "Not disputed");

        Dispute storage d = disputes[milestoneIndex];
        require(!d.resolved, "Already resolved");

        // ── Checks-Effects-Interactions: update state before any external calls ──
        d.resolved = true;
        d.challengerWon = _challengerWon;

        // Cache values needed for transfers before any external calls
        address challenger = d.challenger;
        uint256 challengerBond = d.challengerBond;
        address operator = m.operator;
        uint256 operatorBond = m.operatorBond;
        uint256 milestoneAmount = m.amount;

        if (_challengerWon) {
            m.status = MilestoneStatus.Slashed;
            emit BondSlashed(milestoneIndex, operator, operatorBond);
            emit DisputeResolved(milestoneIndex, _challengerWon);
            // Refund payer + return challenger bond + slash operator bond
            require(token.transfer(payer, milestoneAmount), "Refund failed");
            require(token.transfer(challenger, challengerBond + operatorBond), "Challenger payout failed");
        } else {
            m.status = MilestoneStatus.Released;
            emit BondSlashed(milestoneIndex, challenger, challengerBond);
            emit DisputeResolved(milestoneIndex, _challengerWon);
            // Release to operator + slash challenger bond
            uint256 payout = milestoneAmount + operatorBond + challengerBond;
            require(token.transfer(operator, payout), "Operator payout failed");
        }
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
