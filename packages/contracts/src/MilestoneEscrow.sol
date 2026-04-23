// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPGTRForwarder} from "./interfaces/IPGTRForwarder.sol";
import {IPCCProtocol} from "./interfaces/IPCCProtocol.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";

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
 *
 * Multi-stablecoin support
 * -----------------------------------------------------------------------------
 * The escrow has a DEFAULT token (set at construction) for backward compatibility.
 * It also maintains an owner-curated allowlist of approved stablecoins, each
 * with an on-chain `ReserveAttestation` pointer to a vetted reserve report
 * (maintained off-chain). Milestones added via `addMilestoneWithToken(..., token)`
 * may use any allowlisted stablecoin instead of the default.
 *
 * The default token is always considered implicitly "allowed" for backward
 * compatibility with escrows deployed before multi-stablecoin support existed.
 * Explicit attestations for the default token can still be added via
 * `allowStablecoin` and are recommended in new deployments.
 *
 * SafeERC20 is used for all transfers so the escrow is compatible with
 * tokens such as USDT that do NOT return a boolean from transfer/transferFrom.
 * Fee-on-transfer tokens are rejected: every inbound transfer is verified by
 * balance delta and reverts if the received amount does not equal the claimed
 * amount.
 */
contract MilestoneEscrow {
    using SafeERC20 for IERC20;

    // ── Types ────────────────────────────────────────────────────────────

    /**
     * @notice Metadata pointing at a vetted reserve/reserves-of-reserves report for
     *         an allowlisted stablecoin. The report itself lives off-chain; this
     *         struct only anchors governance decisions to an attestor and URL.
     *
     * @param attestor         Address of the party who vouched for the reserves.
     *                         Typically a trusted auditor, multisig, or the protocol
     *                         governor. Informational — not used for on-chain auth.
     * @param attestedAt       Block timestamp when the attestation was recorded.
     * @param reportUri        URI pointing at the reserve report (HTTP, ipfs://, ar://).
     *                         Empty string is valid but discouraged.
     * @param maxDeviationBps  Governance parameter indicating the largest deviation
     *                         (in basis points) from 1 USD that the attestor tolerates
     *                         before the token should be considered unsafe. Also
     *                         informational — not enforced on-chain because there is
     *                         no live price oracle here (by design — see Non-goals).
     * @param active           True if the stablecoin is currently allowed for NEW
     *                         milestones. Revoking sets this false without touching
     *                         existing milestones.
     */
    struct ReserveAttestation {
        address attestor;
        uint64  attestedAt;
        string  reportUri;
        uint16  maxDeviationBps;
        bool    active;
    }

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

    // ── Multi-Stablecoin Storage ────────────────────────────────────────

    /// @notice Owner-curated allowlist of approved stablecoin tokens with reserve metadata.
    mapping(address => ReserveAttestation) public reserves;

    /// @notice List of every token ever added to `reserves`, for enumeration / UIs.
    /// @dev Does not shrink when `revokeStablecoin` flips `.active = false`.
    address[] private _reserveTokens;

    /// @notice Per-milestone token override. If `address(0)`, the milestone uses
    ///         the default `token` set at construction.
    mapping(uint256 => address) public tokenOf;

    /// @notice Per-token total amount owed across all milestones (for `fund`).
    mapping(address => uint256) public totalByToken;

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

    // ── Multi-Stablecoin Events ──────────────────────────────────────────

    /// @notice Emitted when the payer adds a stablecoin to the allowlist.
    /// @param token          The ERC-20 address approved for escrow.
    /// @param attestor       Party vouching for the reserves.
    /// @param reportUri      Pointer to the off-chain reserve report.
    /// @param maxDeviationBps Largest 1-USD deviation (in bps) tolerated before this token should be revoked.
    event StablecoinAllowed(
        address indexed token,
        address indexed attestor,
        string reportUri,
        uint16 maxDeviationBps
    );

    /// @notice Emitted when a stablecoin is revoked for NEW milestones.
    /// @dev Existing milestones using this token are unaffected and will still settle.
    event StablecoinRevoked(address indexed token);

    /// @notice Emitted when a milestone is created, including the token used.
    /// @dev Supplements the (historically absent) MilestoneAdded event so callers can
    ///      reconstruct token-per-milestone from logs alone.
    event MilestoneAdded(
        uint256 indexed milestoneIndex,
        bytes32 stepId,
        address indexed operator,
        address indexed token,
        uint256 amount,
        uint256 operatorBond
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

    // ── Stablecoin Allowlist ─────────────────────────────────────────────

    /**
     * @notice Add or refresh a stablecoin on the allowlist. Only the payer (contract owner) can call.
     *
     * Updating an existing entry overwrites attestation metadata and re-activates it
     * if it had been revoked. Emits `StablecoinAllowed` either way.
     *
     * @param _token           The ERC-20 token contract. Must have code (contract, not EOA).
     * @param _attestor        Informational — the party vouching for the reserves.
     * @param _reportUri       URI pointing at the off-chain reserve report.
     * @param _maxDeviationBps Governance hint (informational).
     */
    function allowStablecoin(
        address _token,
        address _attestor,
        string calldata _reportUri,
        uint16 _maxDeviationBps
    ) external onlyPayer {
        require(_token != address(0), "Zero token");
        require(_token.code.length > 0, "Token not a contract");

        ReserveAttestation storage r = reserves[_token];
        bool isNew = r.attestedAt == 0 && !r.active && r.attestor == address(0);

        r.attestor = _attestor;
        r.attestedAt = uint64(block.timestamp);
        r.reportUri = _reportUri;
        r.maxDeviationBps = _maxDeviationBps;
        r.active = true;

        if (isNew) {
            _reserveTokens.push(_token);
        }

        emit StablecoinAllowed(_token, _attestor, _reportUri, _maxDeviationBps);
    }

    /**
     * @notice Deactivate a stablecoin — prevents NEW milestones using this token.
     *         Existing milestones that already used this token are unaffected.
     * @param _token The ERC-20 token to deactivate.
     */
    function revokeStablecoin(address _token) external onlyPayer {
        require(reserves[_token].attestedAt != 0, "Not allowlisted");
        reserves[_token].active = false;
        emit StablecoinRevoked(_token);
    }

    /**
     * @notice View helper: is a token currently accepted for new milestones?
     *         The default token (from constructor) is ALWAYS accepted even without an
     *         explicit allowlist entry (backward compatibility with single-token escrows).
     */
    function isStablecoinAllowed(address _token) public view returns (bool) {
        if (_token == address(token)) return true;
        return reserves[_token].active;
    }

    /**
     * @notice Enumerate every token that has ever been added to the reserves map.
     * @dev Includes both active and revoked entries; callers should cross-check with
     *      `reserves[token].active`.
     */
    function getReserveTokens() external view returns (address[] memory) {
        return _reserveTokens;
    }

    // ── Setup ────────────────────────────────────────────────────────────

    /**
     * @notice Add a milestone denominated in the escrow's DEFAULT token.
     *         This preserves the original single-stablecoin ABI.
     *
     * @dev Equivalent to `addMilestoneWithToken(_stepId, _operator, _amount,
     *      _operatorBond, _challengeWindowSeconds, address(token))`.
     */
    function addMilestone(
        bytes32 _stepId,
        address _operator,
        uint256 _amount,
        uint256 _operatorBond,
        uint256 _challengeWindowSeconds
    ) external onlyPayer {
        _addMilestone(
            _stepId,
            _operator,
            _amount,
            _operatorBond,
            _challengeWindowSeconds,
            address(token)
        );
    }

    /**
     * @notice Add a milestone denominated in a specific allowlisted token.
     *         The token must be on the reserves allowlist (or be the default token).
     *
     * @param _stepId                 Workflow step identifier.
     * @param _operator               Address of the operator executing the step.
     * @param _amount                 Payment amount in the chosen token's decimals.
     * @param _operatorBond           Bond the operator must deposit before evidence.
     * @param _challengeWindowSeconds Seconds the challenge window stays open after attestation.
     * @param _token                  ERC-20 token to denominate this milestone in.
     *                                MUST be `isStablecoinAllowed`.
     */
    function addMilestoneWithToken(
        bytes32 _stepId,
        address _operator,
        uint256 _amount,
        uint256 _operatorBond,
        uint256 _challengeWindowSeconds,
        address _token
    ) external onlyPayer {
        _addMilestone(
            _stepId,
            _operator,
            _amount,
            _operatorBond,
            _challengeWindowSeconds,
            _token
        );
    }

    /// @dev Internal implementation shared by both public entry points.
    function _addMilestone(
        bytes32 _stepId,
        address _operator,
        uint256 _amount,
        uint256 _operatorBond,
        uint256 _challengeWindowSeconds,
        address _token
    ) internal {
        require(!funded, "Already funded");
        require(_token != address(0), "Zero token");
        require(isStablecoinAllowed(_token), "Token not allowed");

        uint256 idx = milestones.length;
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

        // Only persist an override when it differs from the default; keeps storage clean
        // and lets single-token escrows keep their existing gas profile.
        if (_token != address(token)) {
            tokenOf[idx] = _token;
        }

        totalAmount += _amount;
        totalByToken[_token] += _amount;

        emit MilestoneAdded(idx, _stepId, _operator, _token, _amount, _operatorBond);
    }

    /**
     * @notice Resolve the token used by a specific milestone.
     * @dev Falls back to the default `token` if no override was set.
     */
    function tokenForMilestone(uint256 milestoneIndex) public view returns (address) {
        address override_ = tokenOf[milestoneIndex];
        return override_ == address(0) ? address(token) : override_;
    }

    /**
     * @notice Fund the escrow. Transfers per-token milestone totals from the payer.
     *         For each unique token used by any milestone, pulls the total owed for
     *         that token in ONE `transferFrom`. Operators must deposit their own bonds
     *         separately via `depositBond`.
     *
     * @dev Each inbound transfer is checked by balance delta — if the received amount
     *      differs from the expected (e.g. fee-on-transfer tokens), funding reverts.
     */
    function fund() external onlyPayer {
        require(!funded, "Already funded");
        require(milestones.length > 0, "No milestones");

        // Pull per-token totals. We iterate `_reserveTokens` PLUS the default token
        // so escrows that never called `allowStablecoin` still work.
        _pullToken(address(token));
        for (uint256 i = 0; i < _reserveTokens.length; i++) {
            address t = _reserveTokens[i];
            if (t != address(token)) {
                _pullToken(t);
            }
        }

        for (uint256 i = 0; i < milestones.length; i++) {
            milestones[i].status = MilestoneStatus.Funded;
        }
        funded = true;
        emit EscrowFunded(cwmId, totalAmount);
    }

    /// @dev Pulls `totalByToken[t]` from the payer for a single token and verifies
    ///      the received amount equals the expected (rejects fee-on-transfer tokens).
    function _pullToken(address t) internal {
        uint256 expected = totalByToken[t];
        if (expected == 0) return;

        IERC20 asErc20 = IERC20(t);
        uint256 before = asErc20.balanceOf(address(this));
        asErc20.safeTransferFrom(msg.sender, address(this), expected);
        uint256 actualReceived = asErc20.balanceOf(address(this)) - before;
        require(actualReceived == expected, "Fee-on-transfer token");
    }

    /**
     * @notice Operator deposits their bond for a milestone.
     *         The bond token is the SAME as the milestone's payment token.
     */
    function depositBond(uint256 milestoneIndex) external milestoneExists(milestoneIndex) {
        Milestone storage m = milestones[milestoneIndex];
        address sender = _effectiveSender();
        require(sender == m.operator, "Only operator");
        require(m.status == MilestoneStatus.Funded, "Not funded");
        require(m.operatorBond > 0, "No bond required");

        IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));
        uint256 before = tok.balanceOf(address(this));
        tok.safeTransferFrom(sender, address(this), m.operatorBond);
        require(tok.balanceOf(address(this)) - before == m.operatorBond, "Fee-on-transfer token");

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
        IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));

        emit MilestoneReleased(milestoneIndex, operator, amount);

        if (protocolRoot != address(0)) {
            IPCCProtocol root = IPCCProtocol(protocolRoot);
            uint256 feeBps = root.protocolFeeBps();
            uint256 fee = (amount * feeBps) / 10000;
            address recipient = root.feeRecipient();

            // Transfer fee to recipient (in the milestone's token)
            tok.safeTransfer(recipient, fee);

            // Transfer net payment + bond to operator (in the milestone's token)
            uint256 operatorPayout = amount - fee + operatorBond;
            tok.safeTransfer(operator, operatorPayout);

            // Accounting callback — tell the protocol which token the fee was paid in
            root.collectFee(address(tok), fee);
        } else {
            uint256 payout = amount + operatorBond; // Return bond + payment
            tok.safeTransfer(operator, payout);
        }
    }

    // ── Disputes ─────────────────────────────────────────────────────────

    /**
     * @notice File a dispute during the challenge window. Requires a bond
     *         posted in the SAME token as the milestone being disputed.
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

        IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));
        uint256 before = tok.balanceOf(address(this));
        tok.safeTransferFrom(sender, address(this), _challengerBond);
        require(tok.balanceOf(address(this)) - before == _challengerBond, "Fee-on-transfer token");

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

        IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));

        if (_challengerWon) {
            m.status = MilestoneStatus.Slashed;
            emit BondSlashed(milestoneIndex, operator, operatorBond);
            emit DisputeResolved(milestoneIndex, _challengerWon);
            // Refund payer + return challenger bond + slash operator bond
            tok.safeTransfer(payer, milestoneAmount);
            tok.safeTransfer(challenger, challengerBond + operatorBond);
        } else {
            m.status = MilestoneStatus.Released;
            emit BondSlashed(milestoneIndex, challenger, challengerBond);
            emit DisputeResolved(milestoneIndex, _challengerWon);
            // Release to operator + slash challenger bond
            uint256 payout = milestoneAmount + operatorBond + challengerBond;
            tok.safeTransfer(operator, payout);
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
