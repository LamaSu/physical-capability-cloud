// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPGTRForwarder} from "./interfaces/IPGTRForwarder.sol";
import {IPCCProtocolV2} from "./interfaces/IPCCProtocolV2.sol";
import {IEAS, EASAttestation} from "./interfaces/IEAS.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";

/**
 * @title MilestoneEscrowV3
 * @notice DRAFT additive escrow. NOT DEPLOYED. Live V2 (`0xbC15763F...`) untouched.
 *
 * V3 is a duplicate of `MilestoneEscrowV2` with three behavioral changes:
 *
 *   (1) FEE-FROM-ATTESTATION. `submitAttestation` now reads `feeBps` and
 *       `feeRecipient` FROM the EAS attestation's data payload (the new
 *       `pcc.evidence.v2` schema appends these two fields to the V1 schema).
 *       The attested fee is stored on the milestone and used by `release()`
 *       and the distribution helpers — `root.protocolFeeBps` /
 *       `root.feeRecipient` are NO LONGER consulted for the fee math.
 *
 *       SAFETY: a hard upper bound `MAX_FEE_BPS = 1000` (10%) is enforced
 *       at attestation submission. A malicious or compromised oracle that
 *       attests `feeBps > MAX_FEE_BPS` cannot release the milestone.
 *
 *   (2) MODE-A PAYER-APPROVAL RELEASE. New `approveAndRelease(uint256 idx)`
 *       function callable ONLY by the payer (the buyer of the capability).
 *       This is the "user-verifiable evidence" path: the buyer inspects the
 *       deliverable off-chain and signs off on-chain. No oracle attestation
 *       required, no challenge window, no fee deducted (Mode A is a direct
 *       trust path between the payer and the operator).
 *
 *   (3) ADDITIVE — no removal of V2 behavior. The oracle-attested path
 *       (Mode B) remains as in V2: `submitAttestation` → challenge window
 *       → `release`. Dispute mechanism (Mode C) is inherited verbatim.
 *
 * Schema delta (pcc.evidence.v2 vs pcc.evidence.v1):
 *
 *   V1 (7 fields):
 *     (string jobId, bytes32 kernelId, bytes32 evidenceBundleHash,
 *      string ipfsCid, uint8 assuranceTier, bool oracleVerified,
 *      bytes32 stepId)
 *
 *   V2 (9 fields — V1 + feeBps + feeRecipient):
 *     (string jobId, bytes32 kernelId, bytes32 evidenceBundleHash,
 *      string ipfsCid, uint8 assuranceTier, bool oracleVerified,
 *      bytes32 stepId, uint16 feeBps, address feeRecipient)
 *
 *   Field order mirrors the oracle-side branch `feat/oracle-evidence-v2-fee`
 *   in `LamaSu/pcc-oracle` @ `d8df8ce`.
 *
 * Replay guards (C1/C2 from V2 — PRESERVED):
 *   C1  — UID single-use: `_attestationUsed[uid]` set true on first release.
 *   C2a — recipient bound to this escrow: `a.recipient == address(this)`.
 *   C2b — stepId bound to this milestone: decoded `stepId == m.stepId`.
 *
 * EIP-1167 clone factory pattern — PRESERVED. V3 is deployable through a NEW
 * factory `PCCProtocolV3` (not provided here; this DRAFT only defines the
 * escrow). The shared implementation is deployed once, locked via
 * `_disableInitializers`, and cloned per escrow with its own
 * payer/arbiter/token/cwmId/protocolRoot. The EAS wiring (EAS address,
 * V2 schema UID, authorized oracle) lives in the implementation's
 * immutables and is identical for every clone.
 *
 * Why a new factory (rationale, same logic as V1 → V2):
 *   `PCCProtocolV2.createEscrowV2` clones a fixed `escrowImplementation`
 *   bound at construction. The immutable cannot be swapped to a V3
 *   implementation. V3 therefore ships behind a NEW factory; existing V2
 *   instances and the V2 factory remain untouched.
 *
 * DRAFT status:
 *   - NOT DEPLOYED. Gated on V2 settling cleanly + explicit owner GO.
 *   - No deploy broadcast script (`script/DeployV3.s.sol`) ships in this PR.
 *     A deploy script can be authored later; gating it on a separate PR
 *     avoids accidental fire.
 *   - The companion `PCCProtocolV3` factory is intentionally NOT included
 *     in this PR — it is a one-line change (swap the cloned impl) and
 *     should land with the deploy story, not the contract draft.
 */
contract MilestoneEscrowV3 {
    using SafeERC20 for IERC20;

    // ── Types ────────────────────────────────────────────────────────────

    /**
     * @notice Metadata pointing at a vetted reserve report for an allowlisted
     *         stablecoin. Identical to V2. The report itself lives off-chain.
     */
    struct ReserveAttestation {
        address attestor;
        uint64  attestedAt;
        string  reportUri;
        uint16  maxDeviationBps;
        bool    active;
    }

    enum MilestoneStatus {
        Unfunded,     // 0
        Funded,       // 1
        Locked,       // 2
        Evidenced,    // 3
        Attested,     // 4
        Released,     // 5
        Disputed,     // 6
        Refunded,     // 7
        Slashed       // 8
    }

    /**
     * @notice Per-milestone state.
     * @dev V3 appends two fields to the V2 layout (existing fields unchanged):
     *      - `attestedFeeBps`        : fee bps decoded from the EAS attestation
     *                                  (or 0 for Mode-A payer-approval releases).
     *      - `attestedFeeRecipient`  : fee recipient decoded from the attestation
     *                                  (or address(0) for Mode-A).
     */
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
        uint8   requiredTier;
        bytes32 jobIdHash;
        bytes32 verifierAttestationUid;
        // ── V3 additions ──
        uint16  attestedFeeBps;
        address attestedFeeRecipient;
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
     *         Identical to V2.
     */
    struct Payout {
        address recipient;
        uint256 bps;
        bytes32 roleTag;
        bytes32 ipId;
    }

    /**
     * @notice Internal bundle of release-time args. Packed into one memory
     *         struct so the distribute helpers stay under solc's stack-depth
     *         limit without enabling `--via-ir` (which would slow CI builds
     *         and is not yet needed for V2). Lifetime = single release() call.
     */
    struct ReleaseArgs {
        uint256 milestoneIndex;
        uint256 amount;
        address operator;
        uint256 operatorBond;
        IERC20 tok;
        uint16 feeBps;
        address feeRecipient;
    }

    // ── State ────────────────────────────────────────────────────────────

    address public payer;
    address public arbiter;
    IERC20 public token;
    bytes32 public cwmId;

    /// @notice The PCCProtocolV3 root contract. Set per-escrow in `initialize`.
    /// @dev V3 fee math no longer consults the root — fee is read from the
    ///      attestation. The root pointer is RETAINED for accounting hooks
    ///      (`collectFee`) and for off-chain protocol-membership queries
    ///      (`isProtocolEscrow`). Zero address means standalone.
    address public protocolRoot;

    // ── EAS Wiring (immutables) ──────────────────────────────────────────

    /// @notice The Ethereum Attestation Service contract.
    IEAS public immutable eas;

    /// @notice The UID of the `pcc.evidence.v2` EAS schema this escrow gates on.
    /// @dev Different UID from V2's `pcc.evidence.v1` — the schema strings differ
    ///      (V2 appends `feeBps` + `feeRecipient`), so the registry-derived UIDs
    ///      differ too.
    bytes32 public immutable PCC_EVIDENCE_V2_SCHEMA_UID;

    /// @notice The PCC gateway oracle signer.
    address public immutable authorizedOracle;

    /// @notice Re-initialization guard for the clone/initialize pattern.
    bool private _initialized;

    Milestone[] public milestones;
    mapping(uint256 => Dispute) public disputes;

    /// @notice Tracks every EAS UID already consumed by a successful submitAttestation (C1).
    mapping(bytes32 => bool) private _attestationUsed;

    bool public funded;
    uint256 public totalAmount;

    // ── Timeout Reclaim (V3 — closes the V1/V2 locked-funds gap) ─────────

    /// @notice Block timestamp when fund() was called; anchors the reclaim clock. 0 until funded.
    uint256 public fundedAt;

    /// @notice Per-escrow window (seconds after fund()) before the payer may reclaim a
    ///         milestone still stuck pre-settlement. Payer-settable before fund() via
    ///         setReclaimDeadline; 0 falls back to DEFAULT_RECLAIM_DEADLINE.
    uint256 public reclaimDeadlineSeconds;

    /// @notice Default reclaim window when the payer sets none. Deliberately generous so a
    ///         legitimately long-running job is never clawed back mid-execution.
    uint256 public constant DEFAULT_RECLAIM_DEADLINE = 30 days;

    // ── splitPayout State (ADR-11) — identical to V2 ─────────────────────

    mapping(uint256 => Payout[]) private _payoutMap;
    mapping(uint256 => bool) public payoutMapSet;

    uint256 public constant MAX_PAYOUTS = 16;
    uint256 public constant MAX_SINGLE_BPS = 5000;
    uint8 public constant MAX_ASSURANCE_TIER = 3;

    // ── V3 Fee Cap ───────────────────────────────────────────────────────

    /// @notice Hard upper bound on the attested protocol fee.
    /// @dev SAFETY: a compromised oracle that attests `feeBps > MAX_FEE_BPS`
    ///      cannot release any milestone — `submitAttestation` reverts. This
    ///      caps worst-case oracle abuse at 10% of milestone value (vs 100%
    ///      with no cap). The number itself is intentionally well above the
    ///      protocol's current 235 bps so a legitimate governance fee bump
    ///      does not require a redeploy.
    uint16 public constant MAX_FEE_BPS = 1000; // 10%

    // ── Multi-Stablecoin Storage — identical to V2 ──────────────────────

    mapping(address => ReserveAttestation) public reserves;
    address[] private _reserveTokens;
    mapping(uint256 => address) public tokenOf;
    mapping(address => uint256) public totalByToken;

    // ── Reentrancy Guard ─────────────────────────────────────────────────

    uint256 private _locked = 1;

    // ── PGTR Trusted Forwarders ─────────────────────────────────────────

    mapping(address => bool) public trustedForwarders;

    // ── Events ───────────────────────────────────────────────────────────

    event ForwarderAdded(address indexed forwarder);
    event ForwarderRemoved(address indexed forwarder);

    event EscrowFunded(bytes32 indexed cwmId, uint256 totalAmount);
    event MilestoneLocked(uint256 indexed milestoneIndex, bytes32 stepId);
    event EvidenceSubmitted(uint256 indexed milestoneIndex, bytes32 evidenceBundleHash);

    /// @notice Emitted when a milestone is oracle-attested (Mode B).
    /// @dev The third arg is the attested feeBps; the fourth is the attested feeRecipient.
    ///      These are new to V3 — auditors can replay every fee parameter from logs alone.
    event AttestationSubmitted(
        uint256 indexed milestoneIndex,
        bytes32 attestationUid,
        uint256 challengeWindowEnd,
        uint16 attestedFeeBps,
        address attestedFeeRecipient
    );

    event MilestoneReleased(uint256 indexed milestoneIndex, address operator, uint256 amount);

    /// @notice Emitted when a payer signs off on a milestone via `approveAndRelease` (Mode A).
    /// @dev Distinct from `MilestoneReleased` so off-chain tooling can separate
    ///      user-attested from oracle-attested settlements. No fee is taken in Mode A.
    event PayerApprovedRelease(
        uint256 indexed milestoneIndex,
        address indexed approvedBy,
        uint256 amount
    );

    event DisputeFiled(uint256 indexed milestoneIndex, address challenger, uint256 bond);
    event DisputeResolved(uint256 indexed milestoneIndex, bool challengerWon);
    event MilestoneRefunded(uint256 indexed milestoneIndex, uint256 amount);
    event BondSlashed(uint256 indexed milestoneIndex, address slashedParty, uint256 amount);

    event PayoutMapSet(uint256 indexed milestoneIndex, uint256 payoutCount, uint256 totalBps);
    event SplitPayoutExecuted(
        uint256 indexed milestoneIndex,
        address indexed recipient,
        bytes32 indexed roleTag,
        bytes32 ipId,
        address token,
        uint256 amount
    );

    event StablecoinAllowed(
        address indexed token,
        address indexed attestor,
        string reportUri,
        uint16 maxDeviationBps
    );
    event StablecoinRevoked(address indexed token);

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

    /// @dev `onlyPayerEffective` honors PGTR trusted forwarders — the effective
    ///      sender (the original meta-tx signer relayed by the forwarder) is
    ///      checked, not just `msg.sender`. This matters for `approveAndRelease`
    ///      where the buyer signs from a smart-account / forwarder relay.
    modifier onlyPayerEffective() {
        require(_effectiveSender() == payer, "Only payer");
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

    // ── Errors ───────────────────────────────────────────────────────────

    error AlreadyInitialized();

    // ── Constructor (implementation only) ─────────────────────────────────

    /**
     * @notice Deploy the SHARED implementation logic for every V3 escrow clone.
     *
     * @dev EIP-1167 fault-isolation refactor. Identical pattern to V2: the
     *      implementation is LOCKED (`_initialized = true`) so it can never be
     *      initialized or called directly; only fresh clones can be initialized.
     *      The schema UID parameter is the V2 schema UID (different value from V1).
     *
     * @param _eas       The EAS contract (Base + Base Sepolia: 0x42...0021).
     * @param _schemaUid The `pcc.evidence.v2` schema UID this escrow gates on.
     * @param _oracle    The PCC gateway oracle signer. Must be non-zero.
     */
    constructor(
        address _eas,
        bytes32 _schemaUid,
        address _oracle
    ) {
        require(_eas != address(0), "Zero EAS");
        require(_oracle != address(0), "Zero oracle");
        require(_schemaUid != bytes32(0), "Schema UID unset");

        eas = IEAS(_eas);
        PCC_EVIDENCE_V2_SCHEMA_UID = _schemaUid;
        authorizedOracle = _oracle;

        _initialized = true;
    }

    // ── Initializer (clones only) ──────────────────────────────────────────

    /**
     * @notice One-time per-escrow configuration for a freshly-deployed clone.
     * @param _payer        Address that funds the escrow and can add milestones.
     * @param _arbiter      Address that resolves disputes.
     * @param _token        ERC-20 token used for payments.
     * @param _cwmId        Canonical Workflow Model identifier.
     * @param _protocolRoot PCCProtocolV3 root address. address(0) for standalone.
     */
    function initialize(
        address _payer,
        address _arbiter,
        address _token,
        bytes32 _cwmId,
        address _protocolRoot
    ) external {
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        payer = _payer;
        arbiter = _arbiter;
        token = IERC20(_token);
        cwmId = _cwmId;
        protocolRoot = _protocolRoot;

        _locked = 1;
    }

    // ── PGTR Forwarder Management — identical to V2 ─────────────────────

    function addForwarder(address forwarder) external onlyPayer {
        require(forwarder != address(0), "Zero address");
        trustedForwarders[forwarder] = true;
        emit ForwarderAdded(forwarder);
    }

    function removeForwarder(address forwarder) external onlyPayer {
        trustedForwarders[forwarder] = false;
        emit ForwarderRemoved(forwarder);
    }

    function _effectiveSender() internal view returns (address) {
        if (trustedForwarders[msg.sender]) {
            address sender = IPGTRForwarder(msg.sender).pgtrSender();
            require(sender != address(0), "PGTR: no sender set");
            return sender;
        }
        return msg.sender;
    }

    // ── Stablecoin Allowlist — identical to V2 ───────────────────────────

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

    function revokeStablecoin(address _token) external onlyPayer {
        require(reserves[_token].attestedAt != 0, "Not allowlisted");
        reserves[_token].active = false;
        emit StablecoinRevoked(_token);
    }

    function isStablecoinAllowed(address _token) public view returns (bool) {
        if (_token == address(token)) return true;
        return reserves[_token].active;
    }

    function getReserveTokens() external view returns (address[] memory) {
        return _reserveTokens;
    }

    // ── Setup ────────────────────────────────────────────────────────────

    function addMilestone(
        bytes32 _stepId,
        address _operator,
        uint256 _amount,
        uint256 _operatorBond,
        uint256 _challengeWindowSeconds,
        uint8 _requiredTier,
        string calldata _jobId
    ) external onlyPayer {
        _addMilestone(
            _stepId,
            _operator,
            _amount,
            _operatorBond,
            _challengeWindowSeconds,
            _requiredTier,
            _jobId,
            address(token)
        );
    }

    function addMilestoneWithToken(
        bytes32 _stepId,
        address _operator,
        uint256 _amount,
        uint256 _operatorBond,
        uint256 _challengeWindowSeconds,
        uint8 _requiredTier,
        string calldata _jobId,
        address _token
    ) external onlyPayer {
        _addMilestone(
            _stepId,
            _operator,
            _amount,
            _operatorBond,
            _challengeWindowSeconds,
            _requiredTier,
            _jobId,
            _token
        );
    }

    function _addMilestone(
        bytes32 _stepId,
        address _operator,
        uint256 _amount,
        uint256 _operatorBond,
        uint256 _challengeWindowSeconds,
        uint8 _requiredTier,
        string calldata _jobId,
        address _token
    ) internal {
        require(!funded, "Already funded");
        require(_token != address(0), "Zero token");
        require(isStablecoinAllowed(_token), "Token not allowed");
        require(_requiredTier <= MAX_ASSURANCE_TIER, "Invalid tier");

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
            challengeWindowSeconds: _challengeWindowSeconds,
            requiredTier: _requiredTier,
            jobIdHash: keccak256(bytes(_jobId)),
            verifierAttestationUid: bytes32(0),
            // ── V3 additions ──
            attestedFeeBps: 0,
            attestedFeeRecipient: address(0)
        }));

        if (_token != address(token)) {
            tokenOf[idx] = _token;
        }

        totalAmount += _amount;
        totalByToken[_token] += _amount;

        emit MilestoneAdded(idx, _stepId, _operator, _token, _amount, _operatorBond);
    }

    // ── splitPayout Configuration (ADR-11) — identical to V2 ────────────

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

    function getPayoutMap(uint256 milestoneIndex)
        external
        view
        milestoneExists(milestoneIndex)
        returns (Payout[] memory)
    {
        return _payoutMap[milestoneIndex];
    }

    function tokenForMilestone(uint256 milestoneIndex) public view returns (address) {
        address override_ = tokenOf[milestoneIndex];
        return override_ == address(0) ? address(token) : override_;
    }

    // ── Funding — identical to V2 ────────────────────────────────────────

    /// @notice Set the per-escrow reclaim window (seconds after fund()). Payer-only, pre-fund.
    /// @dev 0 means "use DEFAULT_RECLAIM_DEADLINE". Lets the buyer match recovery latency to
    ///      the workflow's expected duration. Immutable once funded.
    function setReclaimDeadline(uint256 _seconds) external onlyPayer {
        require(!funded, "Already funded");
        reclaimDeadlineSeconds = _seconds;
    }

    function fund() external onlyPayer {
        require(!funded, "Already funded");
        require(milestones.length > 0, "No milestones");

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
        fundedAt = block.timestamp;
        funded = true;
        emit EscrowFunded(cwmId, totalAmount);
    }

    function _pullToken(address t) internal {
        uint256 expected = totalByToken[t];
        if (expected == 0) return;

        IERC20 asErc20 = IERC20(t);
        uint256 before = asErc20.balanceOf(address(this));
        asErc20.safeTransferFrom(msg.sender, address(this), expected);
        uint256 actualReceived = asErc20.balanceOf(address(this)) - before;
        require(actualReceived == expected, "Fee-on-transfer token");
    }

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
     * @notice Bind a valid `pcc.evidence.v2` EAS attestation (by UID) to a milestone.
     *         Mode B (oracle-attested) entry point.
     *
     * @dev V3 schema decode appends `feeBps` (uint16) and `feeRecipient` (address) to
     *      the V1 7-field tuple. The attested fee is checked against `MAX_FEE_BPS`,
     *      checked for a non-zero `feeRecipient` if `feeBps > 0`, then stored on the
     *      milestone for use in `release()`.
     *
     *      Checks (in order):
     *        1.  milestone is Evidenced
     *        2.  UID not already consumed (C1)
     *        3.  attestation exists (uid != 0)
     *        4.  schema == PCC_EVIDENCE_V2_SCHEMA_UID
     *        5.  attester == authorizedOracle
     *        6.  recipient == address(this) (C2a)
     *        7.  not revoked
     *        8.  not expired
     *        9.  decoded oracleVerified is true
     *        10. assuranceTier >= requiredTier
     *        11. keccak256(bytes(jobId)) == jobIdHash
     *        12. stepId == m.stepId (C2b)
     *        13. evidenceBundleHash matches on-chain evidence
     *        14. attestedFeeBps <= MAX_FEE_BPS (V3 — fee cap)
     *        15. if attestedFeeBps > 0, attestedFeeRecipient != address(0) (V3)
     *
     * @param milestoneIndex Index of the milestone in milestones[].
     * @param easUid         The EAS attestation UID produced by the authorized oracle.
     */
    function submitAttestation(uint256 milestoneIndex, bytes32 easUid)
        external
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Evidenced, "Evidence not submitted");
        require(!_attestationUsed[easUid], "Attestation already used");

        EASAttestation memory a = eas.getAttestation(easUid);
        require(a.uid != bytes32(0),                    "Attestation not found");
        require(a.schema == PCC_EVIDENCE_V2_SCHEMA_UID, "Wrong schema");
        require(a.attester == authorizedOracle,         "Wrong attester");
        require(a.recipient == address(this),           "Wrong recipient");
        require(a.revocationTime == 0,                  "Revoked");
        require(a.expirationTime == 0 || block.timestamp <= a.expirationTime, "Expired");

        (
            string memory jobId,
            bytes32 kernelId,
            bytes32 evidenceBundleHash,
            string memory ipfsCid,
            uint8 assuranceTier,
            bool oracleVerified,
            bytes32 stepId,
            uint16 attestedFeeBps,
            address attestedFeeRecipient
        ) = abi.decode(
            a.data,
            (string, bytes32, bytes32, string, uint8, bool, bytes32, uint16, address)
        );
        // kernelId / ipfsCid carried for off-chain consumers; not gated on-chain.
        kernelId;
        ipfsCid;

        require(oracleVerified,                             "Oracle did not verify");
        require(assuranceTier >= m.requiredTier,            "Tier too low");
        require(keccak256(bytes(jobId)) == m.jobIdHash,     "jobId mismatch");
        require(stepId == m.stepId,                         "stepId mismatch");
        require(evidenceBundleHash == m.evidenceBundleHash, "Evidence mismatch");

        // V3 fee-from-attestation guards
        require(attestedFeeBps <= MAX_FEE_BPS,              "Fee exceeds MAX_FEE_BPS");
        if (attestedFeeBps > 0) {
            require(attestedFeeRecipient != address(0),     "Zero fee recipient");
        }

        // Effects: mark the UID spent BEFORE the status transition (C1 single-use).
        _attestationUsed[easUid] = true;
        m.verifierAttestationUid  = easUid;
        m.verifierAttestationHash = evidenceBundleHash;
        m.challengeWindowEnd      = block.timestamp + m.challengeWindowSeconds;
        m.status                  = MilestoneStatus.Attested;
        // V3: store decoded fee on the milestone
        m.attestedFeeBps          = attestedFeeBps;
        m.attestedFeeRecipient    = attestedFeeRecipient;

        emit AttestationSubmitted(
            milestoneIndex,
            easUid,
            m.challengeWindowEnd,
            attestedFeeBps,
            attestedFeeRecipient
        );
    }

    function attestationUsed(bytes32 easUid) external view returns (bool) {
        return _attestationUsed[easUid];
    }

    /**
     * @notice Release funds after challenge window expires (Mode B).
     *
     * @dev V3 fee math reads from `m.attestedFeeBps` / `m.attestedFeeRecipient`
     *      (populated by `submitAttestation` from the EAS attestation payload),
     *      NOT from `root.protocolFeeBps` / `root.feeRecipient`. The accounting
     *      callback `root.collectFee(token, fee)` is still invoked if a root is
     *      set, for cumulative protocol-wide fee tracking.
     */
    function release(uint256 milestoneIndex) external nonReentrant milestoneExists(milestoneIndex) {
        Milestone storage m = milestones[milestoneIndex];
        require(m.status == MilestoneStatus.Attested, "Not attested");
        require(block.timestamp >= m.challengeWindowEnd, "Challenge window open");

        m.status = MilestoneStatus.Released;

        // Pack release args into a single memory struct to keep stack depth
        // under solc's limit (avoids stack-too-deep without --via-ir).
        ReleaseArgs memory args = ReleaseArgs({
            milestoneIndex: milestoneIndex,
            amount: m.amount,
            operator: m.operator,
            operatorBond: m.operatorBond,
            tok: IERC20(tokenForMilestone(milestoneIndex)),
            feeBps: m.attestedFeeBps,
            feeRecipient: m.attestedFeeRecipient
        });

        emit MilestoneReleased(milestoneIndex, args.operator, args.amount);

        if (payoutMapSet[milestoneIndex]) {
            _distributeWithMap(args);
        } else {
            _distributeLegacy(args);
        }
    }

    /**
     * @notice Mode A — payer signs off on a milestone without oracle attestation.
     *
     * @dev Callable ONLY by the payer (buyer of the capability). Used when the
     *      buyer has user-verifiable evidence (e.g. the deliverable was inspected
     *      in person, in-band, or via a trust channel outside the oracle's scope).
     *
     *      Mode-A semantics:
     *        - milestone must be at least Evidenced (the operator must have
     *          submitted on-chain evidence — this preserves the audit trail);
     *          NOT Released/Refunded/Slashed/Disputed.
     *        - no challenge window — the payer's signoff is immediate.
     *        - no protocol fee deducted — Mode A is a direct user-to-operator
     *          settlement, not a protocol-mediated one.
     *        - bond returned in full, milestone marked Released.
     *        - PGTR forwarder-aware (`_effectiveSender`) so the buyer can sign
     *          via a smart-account meta-tx.
     *
     *      Reentrancy-guarded. Idempotent — once Released, a second call reverts.
     *
     *      Mode-A intentionally does NOT use any payout map. The buyer-direct
     *      settlement is a single transfer to the operator. A split-payout in
     *      Mode A would require the buyer to attest to the split, which is
     *      outside the user-verifiable-evidence threat model (the buyer can
     *      only attest to the deliverable, not to downstream splits).
     *
     * @param milestoneIndex Index of the milestone in milestones[].
     */
    function approveAndRelease(uint256 milestoneIndex)
        external
        nonReentrant
        onlyPayerEffective
        milestoneExists(milestoneIndex)
    {
        Milestone storage m = milestones[milestoneIndex];
        // Must be at minimum Evidenced. Reject pre-Evidenced (Funded/Locked) so the
        // operator must produce SOME on-chain evidence even in the buyer-direct path,
        // and reject post-settlement states (Released/Refunded/Slashed/Disputed) so
        // this function is idempotent and cannot race with Mode B / Mode C.
        require(
            m.status == MilestoneStatus.Evidenced || m.status == MilestoneStatus.Attested,
            "Not approvable"
        );

        m.status = MilestoneStatus.Released;

        address operator = m.operator;
        uint256 amount = m.amount;
        uint256 operatorBond = m.operatorBond;
        IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));

        emit PayerApprovedRelease(milestoneIndex, _effectiveSender(), amount);

        // No fee in Mode A — buyer-direct payment.
        uint256 payout = amount + operatorBond;
        tok.safeTransfer(operator, payout);
    }

    // ── Internal Distribution Helpers (V3 — fee args, no root.protocolFeeBps) ────

    /**
     * @dev Legacy single-operator distribution path. V3 reads fee from
     *      the per-milestone attested values (passed in by caller).
     */
    function _distributeLegacy(ReleaseArgs memory args) internal {
        if (args.feeBps > 0 && args.feeRecipient != address(0)) {
            uint256 fee = (args.amount * args.feeBps) / 10000;

            args.tok.safeTransfer(args.feeRecipient, fee);

            uint256 operatorPayout = args.amount - fee + args.operatorBond;
            args.tok.safeTransfer(args.operator, operatorPayout);

            // Optional accounting hook: notify protocol root (if set) of the fee.
            if (protocolRoot != address(0)) {
                IPCCProtocolV2(protocolRoot).collectFee(address(args.tok), fee);
            }
        } else {
            // Zero-fee path: operator gets everything.
            uint256 payout = args.amount + args.operatorBond;
            args.tok.safeTransfer(args.operator, payout);
        }
    }

    /**
     * @dev splitPayout distribution path. V3 fee is from the attestation,
     *      not from the protocol root. The inner split loop is split out to
     *      `_runSplitPayouts` to keep this function under solc's stack limit
     *      (avoiding `--via-ir`).
     */
    function _distributeWithMap(ReleaseArgs memory args) internal {
        // 1. Fee on gross — from attestation, not from root.
        uint256 protocolFee = 0;
        if (args.feeBps > 0 && args.feeRecipient != address(0)) {
            protocolFee = (args.amount * args.feeBps) / 10000;
            if (protocolFee > 0) {
                args.tok.safeTransfer(args.feeRecipient, protocolFee);
            }
            if (protocolRoot != address(0)) {
                IPCCProtocolV2(protocolRoot).collectFee(address(args.tok), protocolFee);
            }
        }

        uint256 distributable = args.amount - protocolFee;

        // 2. Per-recipient distribution. Returns the total actually distributed
        //    (sum of truncated shares; matches behavior of V2).
        uint256 distributed = _runSplitPayouts(args.milestoneIndex, distributable, args.tok);

        // 3. Operator residual + bond. Integer-truncation dust from the split
        //    loop accumulates into the operator residual (intentional — V2 parity).
        uint256 operatorAmount = (distributable - distributed) + args.operatorBond;
        if (operatorAmount > 0) {
            args.tok.safeTransfer(args.operator, operatorAmount);
        }
    }

    /**
     * @dev Inner split-payout loop — extracted to its own function so the
     *      caller (`_distributeWithMap`) stays under solc's stack-depth limit
     *      without `--via-ir`. Returns total amount actually distributed
     *      (sum of truncated shares).
     */
    function _runSplitPayouts(
        uint256 milestoneIndex,
        uint256 distributable,
        IERC20 tok
    ) internal returns (uint256 distributed) {
        Payout[] storage payouts = _payoutMap[milestoneIndex];
        address tokenAddr = address(tok);
        uint256 n = payouts.length;
        for (uint256 i = 0; i < n; i++) {
            Payout memory p = payouts[i];
            uint256 share = (distributable * p.bps) / 10000;
            if (share > 0) {
                tok.safeTransfer(p.recipient, share);
                distributed += share;
            }
            emit SplitPayoutExecuted(
                milestoneIndex,
                p.recipient,
                p.roleTag,
                p.ipId,
                tokenAddr,
                share
            );
        }
    }

    // ── Disputes (Mode C) — identical to V2 ──────────────────────────────

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

        d.resolved = true;
        d.challengerWon = _challengerWon;

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
            tok.safeTransfer(payer, milestoneAmount);
            tok.safeTransfer(challenger, challengerBond + operatorBond);
        } else {
            m.status = MilestoneStatus.Released;
            emit BondSlashed(milestoneIndex, challenger, challengerBond);
            emit DisputeResolved(milestoneIndex, _challengerWon);
            uint256 payout = milestoneAmount + operatorBond + challengerBond;
            tok.safeTransfer(operator, payout);
        }
    }

    // ── Timeout Reclaim (Mode D — closes the locked-funds gap) ───────────

    /**
     * @notice Reclaim a milestone's funds to the payer when a job has hung past the
     *         reclaim deadline without ever reaching settlement.
     *
     * @dev THE FIX for the V1/V2 locked-funds gap. Earlier versions had no reclaim,
     *      cancel, or expire path, so a milestone stuck at Funded/Locked/Evidenced
     *      (operator offline, device dead, oracle never attests) locked the payer's
     *      funds forever. This is the missing terminal exit.
     *
     *      Safety properties:
     *        - PAYER-ONLY (forwarder-aware). Funds return to the depositor; no third
     *          party can redirect a refund.
     *        - Reclaimable ONLY from pre-settlement {Funded, Locked, Evidenced}. An
     *          Attested milestone (operator holds a valid oracle verdict, in its
     *          challenge window) can NEVER be clawed back here — use fileDispute.
     *          Released/Disputed/Refunded/Slashed are terminal and rejected.
     *        - Deadline-gated: only after fundedAt + (reclaimDeadlineSeconds or
     *          DEFAULT_RECLAIM_DEADLINE).
     *        - A pre-settlement timeout is NOT proven fraud, so the operator's bond
     *          (if posted) is RETURNED to the operator, not slashed. Slashing requires
     *          a dispute finding.
     *        - CEI + nonReentrant; status set Refunded BEFORE any transfer; a second
     *          call reverts (Refunded is not reclaimable) — idempotent.
     *        - Race with submitAttestation is safe both ways: attestation-first makes
     *          the milestone Attested (not reclaimable); reclaim-first makes it Refunded
     *          and submitAttestation then reverts (it requires Evidenced).
     *
     * @param milestoneIndex Index of the milestone in milestones[].
     */
    function reclaimAfterDeadline(uint256 milestoneIndex)
        external
        nonReentrant
        onlyPayerEffective
        milestoneExists(milestoneIndex)
    {
        require(funded, "Not funded");

        Milestone storage m = milestones[milestoneIndex];
        MilestoneStatus s = m.status;
        require(
            s == MilestoneStatus.Funded ||
            s == MilestoneStatus.Locked ||
            s == MilestoneStatus.Evidenced,
            "Not reclaimable"
        );

        uint256 window = reclaimDeadlineSeconds == 0
            ? DEFAULT_RECLAIM_DEADLINE
            : reclaimDeadlineSeconds;
        require(block.timestamp >= fundedAt + window, "Deadline not reached");

        // ── Effects (CEI): mark terminal BEFORE any external call ──
        m.status = MilestoneStatus.Refunded;

        // The operator's bond is held only once a milestone passed through Locked
        // (depositBond). True at status Locked, or at Evidenced with a non-zero bond
        // (Evidenced is reachable from Locked only when operatorBond > 0; the
        // Funded->Evidenced shortcut requires operatorBond == 0, so no bond was posted).
        bool bondHeld = (s == MilestoneStatus.Locked) ||
            (s == MilestoneStatus.Evidenced && m.operatorBond > 0);

        address operator = m.operator;
        uint256 amount = m.amount;
        uint256 bond = m.operatorBond;
        IERC20 tok = IERC20(tokenForMilestone(milestoneIndex));

        emit MilestoneRefunded(milestoneIndex, amount);

        // ── Interactions ──
        tok.safeTransfer(payer, amount);
        if (bondHeld && bond > 0) {
            tok.safeTransfer(operator, bond);
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
