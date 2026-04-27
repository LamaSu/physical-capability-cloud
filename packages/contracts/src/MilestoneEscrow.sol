// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPGTRForwarder} from "./interfaces/IPGTRForwarder.sol";
import {IPCCProtocol} from "./interfaces/IPCCProtocol.sol";

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

    /**
     * @notice A single payment destination in a multi-recipient payout map.
     * @dev Stored per-milestone by the payer via setPayoutMap() before fund().
     *      After funding, the map is immutable and consumed by release().
     *
     * @param recipient  EOA or contract receiving the payment.
     * @param bps        Basis points of distributable amount (post protocol-fee). Max 5000 (50%).
     * @param roleTag    keccak256 hash of the role name (e.g. keccak256("integrator")).
     *                   Canonical set defined in packages/contracts/ts/payouts.ts.
     * @param ipId       Story Protocol IP Asset ID for off-chain attribution. bytes32(0) if N/A.
     */
    struct Payout {
        address recipient;
        uint256 bps;
        bytes32 roleTag;
        bytes32 ipId;
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

    // ── splitPayout State (ADR-11) ───────────────────────────────────────

    /// @notice Per-milestone payout map. Set by payer after addMilestone() and before fund().
    /// @dev Private + read via getPayoutMap() so we return Payout[] memory cleanly.
    mapping(uint256 => Payout[]) private _payoutMap;

    /// @notice True if a payout map has been set for a milestone.
    /// @dev Public so off-chain tooling can cheaply query whether split is active.
    mapping(uint256 => bool) public payoutMapSet;

    /// @notice Maximum payouts per milestone. Caps release() loop gas at ~450k worst-case.
    uint256 public constant MAX_PAYOUTS = 16;

    /// @notice Per-payout basis-point ceiling. Sanity floor: no single recipient takes >50%.
    uint256 public constant MAX_SINGLE_BPS = 5000;

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

    // ── splitPayout Events (ADR-11) ──────────────────────────────────────

    /// @notice Emitted when a payer registers a payout map for a milestone.
    event PayoutMapSet(uint256 indexed milestoneIndex, uint256 payoutCount, uint256 totalBps);

    /// @notice Emitted per-recipient during release() when a payout map is active.
    /// @dev Off-chain indexers (Graph subgraph) use these for per-role revenue dashboards.
    event SplitPayoutExecuted(
        uint256 indexed milestoneIndex,
        address indexed recipient,
        bytes32 indexed roleTag,
        bytes32 ipId,
        address token,
        uint256 amount
    );

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

    // ── splitPayout Configuration (ADR-11) ───────────────────────────────

    /**
     * @notice Register a payout map for a milestone.
     * @dev Per ADR-11 §4:
     *      - Callable only by payer (onlyPayer modifier)
     *      - Milestone must still be Unfunded (map is immutable after fund())
     *      - No prior map may already be set (single-shot, no re-configuration)
     *      - payouts.length <= MAX_PAYOUTS (16)
     *      - Each entry: recipient != 0, bps in (0, MAX_SINGLE_BPS]
     *        (bps=0 entries are REJECTED — omit the entry instead. Minor deviation
     *        from ADR-11 §8 wording; eliminates no-op attribution events that would
     *        confuse off-chain indexers and burn gas.)
     *      - No duplicate (recipient, roleTag) pairs (O(n²), bounded by MAX_PAYOUTS)
     *      - Sum of bps <= 10000 (operator collects residual 10000 - sum)
     *
     *      The operator is NEVER an explicit entry — they receive the residual
     *      (10000 - totalBps) of distributable plus their bond in full.
     *      The protocol fee is deducted FIRST in release() on the gross amount,
     *      and the payout map distributes the net (distributable) remainder.
     *
     * @param milestoneIndex Index of the milestone in milestones[].
     * @param payouts Array of Payout entries. Must satisfy all rules above.
     */
    function setPayoutMap(uint256 milestoneIndex, Payout[] calldata payouts)
        external
        onlyPayer
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Unfunded, "Milestone already funded");
        require(!payoutMapSet[milestoneIndex], "Payout map already set");
        require(payouts.length <= MAX_PAYOUTS, "Too many payouts");

        uint256 totalBps = 0;
        uint256 n = payouts.length;
        for (uint256 i = 0; i < n; i++) {
            Payout calldata p = payouts[i];
            require(p.recipient != address(0), "Zero recipient");
            require(p.bps > 0, "Zero bps - omit the entry instead");
            require(p.bps <= MAX_SINGLE_BPS, "Single payout > 50% of milestone");

            // Reject duplicate (recipient, roleTag) pairs. O(n^2) but bounded by MAX_PAYOUTS.
            for (uint256 j = i + 1; j < n; j++) {
                require(
                    !(payouts[j].recipient == p.recipient && payouts[j].roleTag == p.roleTag),
                    "Duplicate recipient+roleTag"
                );
            }

            totalBps += p.bps;
            _payoutMap[milestoneIndex].push(p);
        }
        require(totalBps <= 10000, "Total bps exceeds 100%");

        payoutMapSet[milestoneIndex] = true;
        emit PayoutMapSet(milestoneIndex, n, totalBps);
    }

    /**
     * @notice Read the payout map for a milestone.
     * @dev Returns empty array if no map has been set.
     * @param milestoneIndex Index of the milestone.
     * @return The full Payout[] (copy, not storage reference).
     */
    function getPayoutMap(uint256 milestoneIndex)
        external
        view
        milestoneExists(milestoneIndex)
        returns (Payout[] memory)
    {
        return _payoutMap[milestoneIndex];
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
     * @notice Verifier submits attestation hash. Opens challenge window.
     * @dev Only authorized verifiers may call this. The milestone's operator is
     *      explicitly blocked from self-attesting their own evidence.
     */
    function submitAttestation(uint256 milestoneIndex, bytes32 _attestationHash)
        external
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(authorizedVerifiers[msg.sender], "Not an authorized verifier");
        require(msg.sender != m.operator, "Operator cannot self-attest");
        require(m.status == MilestoneStatus.Evidenced, "Evidence not submitted");

        m.verifierAttestationHash = _attestationHash;
        m.challengeWindowEnd = block.timestamp + m.challengeWindowSeconds;
        m.status = MilestoneStatus.Attested;
        emit AttestationSubmitted(milestoneIndex, _attestationHash, m.challengeWindowEnd);
    }

    /**
     * @notice Release funds to operator after challenge window expires.
     *
     * If a protocolRoot is set, deducts the protocol fee from the milestone
     * payment (not the bond) and transfers it to the fee recipient before
     * paying the operator. The bond is always returned to the operator in full.
     *
     * Fee flow (when protocolRoot is set):
     *   fee = milestone.amount * protocolRoot.protocolFeeBps() / 10000
     *   token.transfer(protocolRoot.feeRecipient(), fee)
     *   token.transfer(operator, milestone.amount - fee + operatorBond)
     *   protocolRoot.collectFee(token, fee)  // accounting
     */
    function release(uint256 milestoneIndex) external nonReentrant milestoneExists(milestoneIndex) {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Attested, "Not attested");
        require(block.timestamp >= m.challengeWindowEnd, "Challenge window open");

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

            // Accounting callback
            root.collectFee(address(token), fee);
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
