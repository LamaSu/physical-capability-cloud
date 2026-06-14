// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPGTRForwarder} from "./interfaces/IPGTRForwarder.sol";
import {IPCCProtocolV2} from "./interfaces/IPCCProtocolV2.sol";
import {IEAS, EASAttestation} from "./interfaces/IEAS.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";

/**
 * @title MilestoneEscrowV2
 * @notice EAS-gated milestone escrow for Physical Capability Cloud workflows.
 *
 * V2 is a duplicate of `MilestoneEscrow` (V1) with ONE behavioral change: the
 * release-gating attestation step now reads a REAL on-chain Ethereum Attestation
 * Service (EAS) record by UID and validates its provenance + payload, instead of
 * accepting a bare bytes32 from an allowlisted EOA.
 *
 * Authored by implementer-alpha — EAS attestation-bridge migration (deliverable 2).
 * See ai/research/eas-migration-design.md §3.3 for the authoritative spec.
 *
 * Each workflow (CWM) gets a MilestoneEscrowV2 instance. The escrow holds funds
 * for each step (milestone) and releases them to operators after:
 *   1. Evidence bundle hash is submitted by the kernel
 *   2. A valid EAS attestation (produced by the authorized oracle) is bound by UID
 *   3. Challenge window expires without dispute
 *
 * If disputed, an arbiter resolves. Bonds are slashed for proven fraud.
 *
 * Flow: fund → submitEvidence → submitAttestation(easUid) → [challenge window] → release
 *
 * EAS gating (vs V1)
 * -----------------------------------------------------------------------------
 * V1 `submitAttestation(uint256, bytes32)` accepted any bytes32 from any allowlisted
 * verifier — the oracle's verdict never touched the chain and was never validated by it.
 * V2 `submitAttestation(uint256, bytes32 easUid)` instead:
 *   - reads `IEAS.getAttestation(easUid)`
 *   - requires the attestation exists, uses the PCC evidence schema, was produced by the
 *     `authorizedOracle`, is not revoked, and is not expired
 *   - decodes the schema payload and requires `oracleVerified == true`, the achieved tier
 *     meets the milestone's `requiredTier`, the attested `jobId` matches the milestone's
 *     `jobIdHash`, the attested `stepId` matches the milestone's `stepId`, and the attested
 *     `evidenceBundleHash` matches the on-chain evidence
 *   - binds the attestation to THIS escrow (`recipient == address(this)`) and consumes each
 *     UID at most once (single-use guard) — closing the cross-escrow / cross-milestone /
 *     UID-replay defects (security review C1/C2)
 * The old `authorizedVerifiers` allowlist + `addVerifier`/`removeVerifier` are REMOVED in V2
 * (security review L2): they were never consulted by `submitAttestation` and only created a
 * misleading-authority surface. The EAS `attester` field is the sole provenance gate. The old
 * "operator cannot self-attest" guard is subsumed: an operator cannot forge an attestation
 * whose `attester == authorizedOracle`, so relaying the UID is permissionless.
 *
 * Multi-stablecoin support
 * -----------------------------------------------------------------------------
 * Identical to V1: a DEFAULT token (set at construction) plus an owner-curated allowlist
 * of approved stablecoins, each with an on-chain `ReserveAttestation` pointer to a vetted
 * reserve report (maintained off-chain). Milestones added via `addMilestoneWithToken`
 * may use any allowlisted stablecoin instead of the default. SafeERC20 is used for all
 * transfers; fee-on-transfer tokens are rejected by balance-delta checks.
 */
contract MilestoneEscrowV2 {
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

    /**
     * @notice Per-milestone state.
     * @dev V2 appends three fields to the V1 layout (existing fields unchanged):
     *      - `requiredTier`            : minimum assurance tier the attestation must report.
     *      - `jobIdHash`               : keccak256(bytes(jobId)) bound at creation; the EAS
     *                                    attestation's jobId must hash to this.
     *      - `verifierAttestationUid`  : the EAS UID that released the milestone (0 until attested).
     *      `verifierAttestationHash` is RETAINED (set to evidenceBundleHash on success) for
     *      ABI/back-compat with V1 consumers reading the struct.
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
        // ── V2 additions ──
        uint8   requiredTier;
        bytes32 jobIdHash;
        bytes32 verifierAttestationUid;
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

    /// @notice The PCCProtocol root contract. Set per-escrow in `initialize`.
    /// @dev Zero address means no protocol root (standalone / legacy deployment).
    ///      Moved from immutable to storage for the EIP-1167 clone refactor: the
    ///      factory address is not known when the shared implementation is deployed,
    ///      and it differs per factory, so each clone records its own root at init.
    ///      When non-zero, a fee is deducted on release().
    address public protocolRoot;

    // ── EAS Wiring (immutables) ──────────────────────────────────────────

    /// @notice The Ethereum Attestation Service contract.
    /// @dev Base + Base Sepolia predeploy 0x4200000000000000000000000000000000000021.
    IEAS public immutable eas;

    /// @notice The UID of the `pcc.evidence.v1` EAS schema this escrow gates on.
    /// @dev keccak256(abi.encodePacked(schemaString, address(0), true)) — registered out-of-band (G1).
    bytes32 public immutable PCC_EVIDENCE_SCHEMA_UID;

    /// @notice The PCC gateway oracle signer. Must equal the EAS attestation's `attester`.
    address public immutable authorizedOracle;

    /// @notice Re-initialization guard for the clone/initialize pattern (EIP-1167).
    /// @dev The implementation contract sets this true in its constructor (the
    ///      `_disableInitializers` pattern) so the implementation itself can never be
    ///      initialized or used directly — only freshly-cloned proxies (whose storage
    ///      starts zeroed, so `_initialized == false`) can call `initialize` exactly once.
    bool private _initialized;

    Milestone[] public milestones;
    mapping(uint256 => Dispute) public disputes;

    /// @notice Tracks every EAS UID already consumed by a successful submitAttestation.
    /// @dev SECURITY (review C1): without this, one oracle attestation could release N
    ///      milestones (cross-milestone replay). Set true the first time a UID releases a
    ///      milestone; any subsequent submitAttestation with the same UID reverts.
    mapping(bytes32 => bool) private _attestationUsed;

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

    /// @notice Highest assurance tier the oracle ever emits (0-3). Used to range-validate
    ///         a milestone's requiredTier at creation (review L4).
    uint8 public constant MAX_ASSURANCE_TIER = 3;

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

    // ── PGTR Trusted Forwarders ─────────────────────────────────────────

    /// @notice Trusted PGTR forwarder contracts that can relay calls on behalf of users.
    mapping(address => bool) public trustedForwarders;

    // ── Events ───────────────────────────────────────────────────────────

    event ForwarderAdded(address indexed forwarder);
    event ForwarderRemoved(address indexed forwarder);

    event EscrowFunded(bytes32 indexed cwmId, uint256 totalAmount);
    event MilestoneLocked(uint256 indexed milestoneIndex, bytes32 stepId);
    event EvidenceSubmitted(uint256 indexed milestoneIndex, bytes32 evidenceBundleHash);
    /// @notice Emitted when a milestone is attested.
    /// @dev In V2 the second arg carries the EAS UID (was the raw attestation hash in V1).
    event AttestationSubmitted(uint256 indexed milestoneIndex, bytes32 attestationUid, uint256 challengeWindowEnd);
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

    // ── Errors ───────────────────────────────────────────────────────────

    /// @notice Thrown when `initialize` is called on an already-initialized escrow.
    /// @dev Covers both the second `initialize` on a clone AND any `initialize` on the
    ///      locked implementation (whose constructor pre-sets `_initialized = true`).
    error AlreadyInitialized();

    // ── Constructor (implementation only) ─────────────────────────────────

    /**
     * @notice Deploy the SHARED implementation logic for every escrow clone.
     *
     * @dev EIP-1167 fault-isolation refactor. The values set here live in the
     *      implementation's CODE and are shared by every clone via delegatecall:
     *        - `eas`, `PCC_EVIDENCE_SCHEMA_UID`, `authorizedOracle` are immutable and
     *          IDENTICAL for every escrow, so they are correctly baked into the shared
     *          code here and read by all clones.
     *      The PER-ESCROW config (`payer`, `arbiter`, `token`, `cwmId`, `protocolRoot`)
     *      is NOT set here — it differs per escrow (and `protocolRoot` is the factory
     *      address, unknown at implementation-deploy time) and is written to each
     *      clone's own storage by `initialize` after cloning.
     *
     *      The constructor also LOCKS the implementation: it sets `_initialized = true`
     *      so the implementation contract itself can never be initialized or used
     *      directly (the `_disableInitializers` pattern). Only fresh clones — whose
     *      storage starts zeroed, so `_initialized == false` — can be initialized.
     *
     * @param _eas          The EAS contract (Base + Base Sepolia: 0x42...0021).
     * @param _schemaUid    The `pcc.evidence.v1` schema UID this escrow gates on.
     * @param _oracle       The PCC gateway oracle signer (== EAS attester). Must be non-zero.
     */
    constructor(
        address _eas,
        bytes32 _schemaUid,
        address _oracle
    ) {
        require(_eas != address(0), "Zero EAS");
        require(_oracle != address(0), "Zero oracle");
        // SECURITY (review H1): a zero schema UID silently breaks the release gate
        // (a.schema == 0 never matches a real registry-derived UID) and permanently
        // locks every milestone's funds. The value is immutable — reject at construction.
        require(_schemaUid != bytes32(0), "Schema UID unset");

        eas = IEAS(_eas);
        PCC_EVIDENCE_SCHEMA_UID = _schemaUid;
        authorizedOracle = _oracle;

        // Lock the implementation: only clones (with zeroed storage) may initialize.
        _initialized = true;
    }

    // ── Initializer (clones only) ──────────────────────────────────────────

    /**
     * @notice One-time per-escrow configuration for a freshly-deployed clone.
     *
     * @dev Sets the PER-ESCROW config that differs across escrows and therefore
     *      cannot live in the shared implementation code. Each clone has its own
     *      storage, so these writes affect ONLY this clone — the heart of the
     *      fault-isolation guarantee.
     *
     *      Reverts `AlreadyInitialized` if called twice, and is unreachable on the
     *      implementation contract (its constructor already set `_initialized = true`).
     *      The reentrancy guard slot `_locked` also starts at 0 in a fresh clone, so
     *      it is set to 1 here to arm the `nonReentrant` modifier.
     *
     *      NOTE: the H1 zero-schema guard is enforced once, on the implementation, at
     *      construction. Clones share that immutable through delegatecall, so a clone
     *      can never observe a zero schema UID — no per-clone H1 re-check is needed.
     *
     * @param _payer        Address that funds the escrow and can add milestones.
     * @param _arbiter      Address that resolves disputes.
     * @param _token        ERC-20 token used for payments.
     * @param _cwmId        Canonical Workflow Model identifier.
     * @param _protocolRoot PCCProtocol root address (the factory). address(0) for
     *                      standalone/legacy use; when non-zero, a fee is deducted on release().
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

        // Arm the reentrancy guard for this clone (storage starts at 0).
        _locked = 1;
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
     *         This preserves the original single-stablecoin ABI shape, EXTENDED with the
     *         V2 `_requiredTier` and `_jobId` params required for EAS gating.
     *
     * @dev Equivalent to `addMilestoneWithToken(_stepId, _operator, _amount,
     *      _operatorBond, _challengeWindowSeconds, _requiredTier, _jobId, address(token))`.
     *
     * @param _requiredTier Minimum assurance tier the EAS attestation must report.
     * @param _jobId        The PCC job id; bound on-chain as keccak256(bytes(_jobId)).
     */
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

    /**
     * @notice Add a milestone denominated in a specific allowlisted token.
     *         The token must be on the reserves allowlist (or be the default token).
     *
     * @param _stepId                 Workflow step identifier.
     * @param _operator               Address of the operator executing the step.
     * @param _amount                 Payment amount in the chosen token's decimals.
     * @param _operatorBond           Bond the operator must deposit before evidence.
     * @param _challengeWindowSeconds Seconds the challenge window stays open after attestation.
     * @param _requiredTier           Minimum assurance tier the EAS attestation must report.
     * @param _jobId                  The PCC job id; bound on-chain as keccak256(bytes(_jobId)).
     * @param _token                  ERC-20 token to denominate this milestone in.
     *                                MUST be `isStablecoinAllowed`.
     */
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

    /// @dev Internal implementation shared by both public entry points.
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
        // SECURITY (review L4): requiredTier must be in the oracle's 0-3 domain.
        // tier 0 silently disables tier gating; tier 4..255 can never release (oracle
        // only emits 0-3), permanently locking the milestone. Reject out-of-range.
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
            // ── V2 additions ──
            requiredTier: _requiredTier,
            jobIdHash: keccak256(bytes(_jobId)),
            verifierAttestationUid: bytes32(0)
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
     * @notice Bind a valid EAS attestation (by UID) to a milestone and open the challenge window.
     *
     * @dev V2 replaces V1's bare-bytes32 `submitAttestation`. The UID is resolved against EAS
     *      and validated for provenance + payload. See ai/research/eas-migration-design.md §3.3.
     *
     *      Checks (in order):
     *        1. milestone is Evidenced
     *        2. UID not already consumed (single-use guard — review C1)
     *        3. attestation exists (uid != 0)
     *        4. attestation uses the PCC evidence schema
     *        5. attester == authorizedOracle (provenance — replaces the allowlist gate)
     *        6. recipient == address(this) (binds the attestation to THIS escrow — review C2a)
     *        7. not revoked
     *        8. not expired
     *        9. decoded `oracleVerified` is true
     *       10. decoded `assuranceTier` >= milestone.requiredTier
     *       11. keccak256(bytes(decoded jobId)) == milestone.jobIdHash
     *       12. decoded `stepId` == milestone.stepId (binds to THIS milestone — review C2b)
     *       13. decoded `evidenceBundleHash` == milestone.evidenceBundleHash (binds to on-chain evidence)
     *
     *      Together checks 2/6/12 close the attestation-replay defects: 6 stops cross-escrow
     *      replay (a UID minted for escrow A names A as recipient, so escrow B rejects it), 12
     *      stops cross-milestone replay within an escrow, and 2 stops re-use of the same UID.
     *
     *      `submitAttestation` is PERMISSIONLESS to relay: anyone may submit the UID; only a
     *      real oracle attestation passes. The operator cannot forge `attester == authorizedOracle`,
     *      so the V1 "operator cannot self-attest" guard is intrinsic.
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
        // SECURITY (review C1): one UID may release at most one milestone, ever.
        require(!_attestationUsed[easUid], "Attestation already used");

        EASAttestation memory a = eas.getAttestation(easUid);
        require(a.uid != bytes32(0),                 "Attestation not found");
        require(a.schema == PCC_EVIDENCE_SCHEMA_UID, "Wrong schema");
        require(a.attester == authorizedOracle,      "Wrong attester");
        // SECURITY (review C2a): the oracle mints each attestation with recipient = the
        // escrow address. A UID minted for escrow A (recipient == A) cannot satisfy escrow B.
        require(a.recipient == address(this),        "Wrong recipient");
        require(a.revocationTime == 0,               "Revoked");
        require(a.expirationTime == 0 || block.timestamp <= a.expirationTime, "Expired");

        (
            string memory jobId,
            bytes32 kernelId,
            bytes32 evidenceBundleHash,
            string memory ipfsCid,
            uint8 assuranceTier,
            bool oracleVerified,
            bytes32 stepId
        ) = abi.decode(a.data, (string, bytes32, bytes32, string, uint8, bool, bytes32));
        // kernelId / ipfsCid are carried in the schema for off-chain consumers; not gated on-chain.
        kernelId;
        ipfsCid;

        require(oracleVerified,                             "Oracle did not verify");
        require(assuranceTier >= m.requiredTier,            "Tier too low");
        require(keccak256(bytes(jobId)) == m.jobIdHash,     "jobId mismatch");
        // SECURITY (review C2b): bind the attestation to THIS milestone, not just its job.
        // m.stepId is the bytes32 bound at creation. The off-chain producer derives the same
        // value as keccak256(utf8(stepIdString)) — see oracle-client.ts AttestEvidenceInput.stepId.
        require(stepId == m.stepId,                         "stepId mismatch");
        require(evidenceBundleHash == m.evidenceBundleHash, "Evidence mismatch");

        // Effects: mark the UID spent BEFORE the status transition (C1 single-use).
        _attestationUsed[easUid] = true;
        m.verifierAttestationUid  = easUid;
        m.verifierAttestationHash = evidenceBundleHash; // back-compat field (V1 consumers)
        m.challengeWindowEnd      = block.timestamp + m.challengeWindowSeconds;
        m.status                  = MilestoneStatus.Attested;
        emit AttestationSubmitted(milestoneIndex, easUid, m.challengeWindowEnd);
    }

    /**
     * @notice True if the given EAS UID has already released a milestone in this escrow.
     * @dev Exposed for off-chain tooling / tests (review C1). A consumed UID can never be
     *      reused by `submitAttestation`.
     */
    function attestationUsed(bytes32 easUid) external view returns (bool) {
        return _attestationUsed[easUid];
    }

    /**
     * @notice Release funds after challenge window expires.
     *
     * @dev Two distribution paths (CEI preserved in both):
     *
     *      1. Legacy (no payout map set):
     *           protocol fee → feeRecipient (if protocolRoot != 0)
     *           amount - fee + bond → operator
     *
     *      2. splitPayout (payoutMapSet[idx] == true) per ADR-11 §3:
     *           protocol fee → feeRecipient (FIRST, on gross amount)
     *           distributable = amount - fee
     *           for each Payout p in _payoutMap[idx]:
     *               (distributable * p.bps) / 10000 → p.recipient
     *               emit SplitPayoutExecuted
     *           operator receives (distributable - sumDistributed) + bond
     *
     *      Operator's bond is ALWAYS returned in full, regardless of path.
     *      `m.status = Released` is set BEFORE any external call (CEI),
     *      and `nonReentrant` provides defense-in-depth.
     *
     *      The legacy path is byte-equivalent to the prior implementation
     *      so existing escrows/tests are unaffected.
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

        if (payoutMapSet[milestoneIndex]) {
            _distributeWithMap(milestoneIndex, amount, operator, operatorBond, tok);
        } else {
            _distributeLegacy(amount, operator, operatorBond, tok);
        }
    }

    // ── Internal Distribution Helpers (release() split for stack-depth) ─────

    /**
     * @dev Legacy single-operator distribution path. Behavior is identical to
     *      the pre-splitPayout `release()` body — fee deduction (if root set),
     *      operator receives net + bond. Existing tests rely on this exact flow.
     *
     *      `tok` is the milestone-specific token resolved by the caller via
     *      `tokenForMilestone(idx)`. This parameter is required for multi-stablecoin
     *      compatibility (one escrow may host milestones in USDC, USDT, DAI, etc.).
     */
    function _distributeLegacy(
        uint256 amount,
        address operator,
        uint256 operatorBond,
        IERC20 tok
    ) internal {
        if (protocolRoot != address(0)) {
            IPCCProtocolV2 root = IPCCProtocolV2(protocolRoot);
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

    /**
     * @dev splitPayout distribution path (ADR-11 §3).
     *
     *      1. Deduct protocol fee on the GROSS amount and route to feeRecipient
     *         (if protocolRoot is set). Notify root via collectFee().
     *      2. distributable = amount - protocolFee
     *      3. For each Payout p, transfer (distributable * p.bps) / 10000 to
     *         p.recipient and emit SplitPayoutExecuted.
     *      4. Operator receives (distributable - sumDistributed) + bond. Any
     *         integer dust from per-recipient truncation accumulates into the
     *         operator residual (intentional, prevents stuck funds).
     *
     *      Read of `_payoutMap[idx]` is via storage pointer for gas efficiency.
     *      Each iteration copies the Payout into memory before transferring.
     *
     *      `tok` is the milestone-specific token resolved by the caller via
     *      `tokenForMilestone(idx)`. Required for multi-stablecoin escrows.
     *      All transfers go through `safeTransfer` (USDT compatibility — USDT does
     *      not return a bool from transfer).
     */
    function _distributeWithMap(
        uint256 milestoneIndex,
        uint256 amount,
        address operator,
        uint256 operatorBond,
        IERC20 tok
    ) internal {
        // 1. Protocol fee on gross (in the milestone's token)
        uint256 protocolFee = 0;
        address tokenAddr = address(tok);
        if (protocolRoot != address(0)) {
            IPCCProtocolV2 root = IPCCProtocolV2(protocolRoot);
            uint256 feeBps = root.protocolFeeBps();
            protocolFee = (amount * feeBps) / 10000;
            if (protocolFee > 0) {
                tok.safeTransfer(root.feeRecipient(), protocolFee);
            }
            // Accounting hook fires regardless (root may want to record zero-fee event)
            root.collectFee(tokenAddr, protocolFee);
        }

        uint256 distributable = amount - protocolFee;

        // 2. Per-recipient distribution (in the milestone's token)
        Payout[] storage payouts = _payoutMap[milestoneIndex];
        uint256 distributed = 0;
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

        // 3. Operator residual + bond. Subtraction is safe: distributed is the
        //    sum of (distributable * p.bps) / 10000 for each p, and totalBps in
        //    setPayoutMap() is required to be <= 10000, so distributed <= distributable.
        uint256 operatorAmount = (distributable - distributed) + operatorBond;
        if (operatorAmount > 0) {
            tok.safeTransfer(operator, operatorAmount);
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
