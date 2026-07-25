// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {
    VNextSettlementLib,
    FeeSchedule,
    PayoutEntry,
    PolicyIdentity,
    UnitState,
    ClaimClass,
    AuthorizationType
} from "./libraries/VNextSettlementLib.sol";
import {O5Assertion, O5_DECISION_SETTLE} from "./O5Types.sol";
import {IOracleAttester} from "./interfaces/IOracleAttester.sol";

/// @notice ERC-1271 smart-account signature validation interface.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}

/// @notice The slice of the deploying factory the clone calls at funding. Declared locally rather than
///         imported so the escrow never depends on the factory (which imports the escrow).
interface IVNextEscrowFactory {
    function consumePolicyNonce(PolicyIdentity calldata p) external returns (address implementation);
}

// `O5Assertion` (the direct cohort assertion the money path reads) and `O5_DECISION_SETTLE` live in
// ./O5Types.sol and are imported above, so the escrow and the cohort attester share one canonical struct.

/**
 * @title VNextSettlementEscrow
 * @notice Per-job immutable USDC settlement escrow (V-next). One EIP-1167 clone per job
 *         (implementation immutables shared across clones; per-job state in clone storage),
 *         matching the MilestoneEscrowV3 clone pattern. Implements the FROZEN spec
 *         (ai/research/vnext-money-out-FROZEN-v1.0.md, escrow lane 9de363c7): the settlement-unit
 *         state machine (§1/§3), the atomic 13-field freeze + reserve-exactly-ΣG at funding
 *         (E2/E8/C4), and the three release authorizations converging on one frozen distribution
 *         (§10.10). Byte-exact primitives live in {VNextSettlementLib}.
 * @dev    INCREMENT 2a: interface + storage + funding/freeze + E2 getters. The money-out paths
 *         (tryTransferExact three-way, the single _allocateRelease behind evidence/dispute/buyer
 *         authorities, dispute/reclaim, claim records + rotation) land in increment 2b and are
 *         stubbed here with `NotYetImplemented`. Built to the sol pre-implementation review guards.
 */
contract VNextSettlementEscrow {
    using SafeERC20 for IERC20;

    // ── Implementation immutables (baked into impl bytecode; shared by every clone) ──────────────
    address public immutable USDC;
    address public immutable authorizedOracle;
    address public immutable factory;
    /// @dev P0-6: there is NO `EAS` immutable. The escrow reads no attestation registry at all — money
    ///      authorization comes from `IOracleAttester(authorizedOracle).assertionOf(unitId)`, which touches
    ///      only the attester's own storage. EAS is now an async provenance mirror owned entirely by the
    ///      attester, so the escrow has no reference to it and no code path that could acquire one.
    /// @dev O5/v3 schema UID + attestation EIP-712 type hash are JOINT-DEFERRED (E6, deploy-gate §8);
    ///      pinned byte-exact across escrow+oracle+evidence when O5 opens. Zero until then. Both are now
    ///      PUBLISHED DEPLOYMENT METADATA ONLY (see the M-02/L-02 constructor pins): with the EAS read gone
    ///      there is no runtime `WrongSchema` check, so `o5SchemaUid` names the schema the cohort's mirror
    ///      writes under, and the constructor pin is what stops that published value from drifting away
    ///      from the attester's real one.
    bytes32 public immutable o5SchemaUid;
    /// @dev L-02 — NOT a runtime security check. The release predicate's trust root is
    ///      `attestation.attester == authorizedOracle`; the quorum digest's type hash lives INSIDE the
    ///      attester. This immutable is DEPLOYMENT METADATA published for the off-chain signer/mirror. To
    ///      stop that published value from drifting away from the cohort's real one, the constructor pins
    ///      it: when non-zero it MUST equal `IOracleAttester(oracle).o5TypeHash()`. Zero = the documented
    ///      deferred state (unpinned, no check, and no security claim is made for it).
    bytes32 public immutable o5TypeHash;

    uint256 public constant CONTRACT_VERSION = 1;
    /// @dev H-01 §2.1 policy-version pin, bound into every acceptance signature. A future policy shape
    ///      bumps this, and yesterday's signatures stop validating instead of silently meaning something new.
    uint256 public constant POLICY_VERSION = 1;

    /// @dev M-01 supported assurance-tier ceiling (tiers 0..3). Funding bounds `requiredTier` to this range;
    ///      the evidence path bounds the ORACLE-asserted `achievedTier` to it too, so a verdict claiming an
    ///      unsupported tier can neither settle nor be permanently mis-recorded.
    uint8 internal constant MAX_TIER = 3;

    // ── EIP-712 + auth constants (2b-ii) ─────────────────────────────────────────────────────────
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME_HASH = keccak256(bytes("VNextSettlementEscrow"));
    bytes32 private constant EIP712_VERSION_HASH = keccak256(bytes("1"));
    bytes32 private constant BUYER_APPROVAL_TYPEHASH = keccak256(
        "BuyerApproval(uint256 chainId,address escrow,uint256 contractVersion,bytes32 settlementUnitId,address payer,bytes32 jobIdHash,bytes32 termsHash,uint256 g,uint256 f,uint256 n,bytes32 feeScheduleHash,bytes32 payoutConfigHash,uint8 decision,uint256 approvalNonce,uint256 expiry)"
    );
    bytes32 private constant ROTATE_TYPEHASH = keccak256(
        "RotateDestination(bytes32 claimId,address claimOwner,address currentDestination,address newDestination,uint256 destinationNonce,uint256 expiry,uint256 chainId,address escrow,uint256 contractVersion)"
    );
    /// @dev H-01 §2.1 — the ONE canonical `JobPolicyHash` both parties authenticate before any funds move.
    ///      It covers every term that decides WHETHER and WHEN the operator is paid: the deployment
    ///      incarnation (chainId / factory / implementation / escrow / policyVersion), both money-plane
    ///      identities, the adjudication authority and whether self-adjudication was deliberately accepted,
    ///      the job + terms identity, the policy generation (nonce) and its expiry, the pre-policy root
    ///      (== keccak256(abi.encode(UnitConfig[])), i.e. every funded term) and the units root (every
    ///      derived settlementUnitId). Binding factory+implementation+escrow is what makes a signature
    ///      unusable against a different factory, a different implementation, or a different clone.
    bytes32 private constant JOB_POLICY_TYPEHASH = keccak256(
        "JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,address arbiter,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,bool allowSelfAdjudication,uint256 expiry)"
    );
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant ECDSA_S_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    // §2 authorization-key issuer domains (per authority type, L-01).
    bytes32 private constant AUTHDOMAIN_EVIDENCE = keccak256("PCC:vnext:auth:evidence:v1");
    bytes32 private constant AUTHDOMAIN_DISPUTE = keccak256("PCC:vnext:auth:dispute:v1");
    bytes32 private constant AUTHDOMAIN_RECLAIM = keccak256("PCC:vnext:auth:reclaim:v1");
    bytes32 private constant AUTHDOMAIN_BUYER = keccak256("PCC:vnext:auth:buyer:v1");

    // ── Per-clone (per-job) state ────────────────────────────────────────────────────────────────
    bool public initialized;
    bool public configurationSealed;
    address public payer; // immutable refund owner/destination once initialized
    /// @notice H-01 §2.1 — the operator's MONEY-PLANE identity, frozen at initialization. This is an
    ///         AUTHORITY, never a destination: it authenticates acceptance of the funded policy (EIP-712
    ///         ECDSA, or ERC-1271 when the operator is a smart account) and is deliberately distinct from
    ///         the off-chain Ed25519 device/evidence plane and from every payout recipient. Before this
    ///         existed the escrow stored only where to pay, never who had agreed to be paid that way.
    address public operator;
    /// @dev Whether the funded policy explicitly accepted an arbiter equal to the payer or the operator.
    ///      Default false; settable only by a signature from BOTH parties over a policy carrying it.
    bool internal _selfAdjudicationAccepted;
    address public arbiter;
    bytes32 public jobIdHash; // keccak256(bytes(jobId)) — canonical UTF-8 (§10.12 M1)
    bytes32 public termsHash;
    /// @dev H-01 §8.2 H-1 — this clone's policy generation, bound into the CREATE2 salt and consumed at
    ///      the factory during `fund()`.
    uint256 internal _policyNonce;
    /// @dev keccak256(abi.encode(UnitConfig[])) — the address-independent commitment to the exact funded
    ///      terms, bound into the CREATE2 salt. `fund()` re-derives it from the supplied configs, so the
    ///      escrow's own ADDRESS proves which terms it may be funded with, before any signature is read.
    bytes32 internal _prePolicyRoot;
    /// @dev The EIP-712 struct hash of the policy both parties authenticated, written at funding. Zero
    ///      until funded; it is the on-chain record that bilateral acceptance actually happened and the
    ///      anchor the post-verdict state machine will reference.
    bytes32 internal _jobPolicyHash;
    uint256 public totalLiability; // Σ over units of unit.liability (single-bucket, §3)
    uint256 public totalPayoutLegs;
    uint64 public oracleAuthEpoch; // rev-3 §A.2: the funded cohort id, pinned from the attester at fund()

    bytes32[] internal _unitIds;
    mapping(bytes32 => uint256) internal _unitIndexPlusOne; // existence + index (default 0 = absent)
    mapping(bytes32 => Unit) internal _units;
    mapping(bytes32 => PayoutEntry[]) internal _payouts;

    mapping(bytes32 => ClaimRecord) internal _claims;
    mapping(bytes32 => bool) internal _authorizationUsed;
    // P0-6: `_easUidUsed` is gone with the EAS read. Evidence replay is now triple-guarded WITHOUT it:
    // the attester writes at most ONE assertion per settlementUnitId (consume-once at the source), the
    // unit leaves FUNDED_ACTIVE on the first release, and the §2 authorization key — derived from the
    // assertion id — is single-use in `_authorizationUsed`.

    uint256 private _status; // reentrancy guard: 1 = not entered, 2 = entered

    /// @dev tryTransferExact outcome (§5). REVERT-ALL is expressed by reverting, not a return value.
    enum TransferResult {
        DISCHARGE,
        CLAIM
    }

    struct Unit {
        FeeSchedule feeSchedule; // all 13 fee-schedule fields, frozen (E2)
        bytes32 feeScheduleHash;
        bytes32 payoutConfigHash;
        uint256 milestoneIndex;
        bytes32 stepId;
        uint8 requiredTier;
        uint8 requestedTier;
        UnitState state;
        // ── one packed slot: H-2 bounded timestamps, written via CHECKED downcasts at funding ─────
        // Both are bounded at funding (reclaimAt <= now + MAX_RECLAIM_DELAY, disputeWindow <=
        // MAX_RECLAIM_DELAY), so uint64 is provably sufficient; `VNextSettlementLib.toUint64` reverts
        // rather than truncating if that ever stops being true. Widened back to uint256 by the external
        // getters, so the published read surface is unchanged.
        uint64 reclaimAt;
        uint64 disputeWindow;
        // ──────────────────────────────────────────────────────────────────────────────────────────
        uint256 liability; // the unit's sole current liability bucket (§3)
        uint256 remainingClaimCount; // set at allocation; SETTLED_* only when 0 (§7)
        uint256 nextApprovalNonce; // buyer-approval single-use nonce (§10.10)
        // ── one packed slot: 2 + 20 + 1 = 23 bytes ────────────────────────────────────────────────
        uint16 compositionSchemaVersion; // rev-3 §C2: frozen at funding (0 = non-composed)
        address evidenceCommitter; // §B: the ONLY caller of submitEvidence, frozen at funding
        bool evidenceCommitted; // §B: separate from the hash so a zero/default hash NEVER satisfies release
        // ──────────────────────────────────────────────────────────────────────────────────────────
        bytes32 compositionRoot; // rev-3 §C2/§C3: frozen root, oracle echoes it → equality-checked at release
        bytes32 evidenceBundleHash; // §B: the domain-separated commitment, oracle echoes it → checked at release
        Dispute dispute;
    }

    struct Dispute {
        bool opened;
        bool resolved;
        uint256 nonce;
        uint256 openedAt;
        uint256 adjudicationDeadline;
        uint256 effectiveDisputeExpiry;
    }

    struct ClaimRecord {
        bool exists;
        bytes32 settlementUnitId; // H-01: owning unit, set atomically at claim creation (2b) so discharge finds it
        address claimOwner;
        address claimDestination;
        uint256 amount;
        ClaimClass class;
        uint256 destinationNonce;
    }

    /// @notice Funding input per settlement unit. The escrow derives settlementUnitId + the domain
    ///         fields on-chain (E5) — the payer never supplies chainId/escrow/settlementUnitId.
    struct UnitConfig {
        uint256 milestoneIndex;
        bytes32 stepId;
        uint8 requiredTier;
        uint8 requestedTier;
        uint256 g;
        uint256 f;
        uint256 n;
        uint16 feeBps;
        address feeRecipient;
        uint256 disputeWindow;
        uint256 reclaimAt; // absolute timestamp; must be in the future
        uint16 compositionSchemaVersion; // rev-3 §C2 (0 = non-composed)
        bytes32 compositionRoot; // rev-3 §C2/§C3 (echoed into O5, equality-checked at release)
        // §B BINDING RULE: the evidence committer is chosen by the FUNDER, at funding, and frozen — the
        // payer is the only caller of fund(), so the committer is always funder-designated (the payer
        // itself, or an operator it trusts). No third party can ever commit, and therefore no third party
        // can strand a good job by racing in a wrong package digest (the one-shot commit is anti-grief).
        // It is an authority, never a money destination: it is checked against the same exclusion set as a
        // payout recipient (non-zero, not this escrow, not the token, not the factory) because none of
        // those can be a legitimate caller. Tier-0 units never use it; a value is still required so the
        // field can never be left at a default that silently means "anyone".
        address evidenceCommitter;
        PayoutEntry[] payouts; // Σ amount == n; each nonzero; allowed recipients only
    }

    /// @notice H-01 §2.1 bilateral acceptance, supplied to `fund()`. Both parties sign the SAME
    ///         `JobPolicyHash`; the escrow recomputes that hash from its OWN frozen identity plus the
    ///         configs actually being funded, so a signature over any other terms simply does not validate.
    /// @dev    `payerSignature` MAY be empty — but ONLY when `msg.sender == payer`, i.e. the payer
    ///         authenticated by sending the transaction itself. Delegated/agent funding (any other caller)
    ///         always requires an explicit payer signature; there is no path where the payer's acceptance
    ///         is assumed. `operatorSignature` is ALWAYS required: the operator never sends this tx.
    struct PolicyAcceptance {
        uint256 expiry; // acceptance is not open-ended; funding after this reverts
        bool allowSelfAdjudication; // both parties deliberately accept arbiter == payer or == operator
        bytes payerSignature;
        bytes operatorSignature;
    }

    /// @notice §10.10 payer-signed authorization (EIP-712) — used by the money-out path (2b).
    struct BuyerApproval {
        uint256 chainId;
        address escrow;
        uint256 contractVersion;
        bytes32 settlementUnitId;
        address payer;
        bytes32 jobIdHash;
        bytes32 termsHash;
        uint256 g;
        uint256 f;
        uint256 n;
        bytes32 feeScheduleHash;
        bytes32 payoutConfigHash;
        uint8 decision; // == uint8(AuthorizationType.BUYER_APPROVAL)
        uint256 approvalNonce;
        uint256 expiry;
    }

    // ── Events ───────────────────────────────────────────────────────────────────────────────────
    event Initialized(address indexed payer, address indexed operator, address indexed arbiter, bytes32 jobIdHash);
    /// @notice H-01 §2.1 — emitted once, at funding, recording that BOTH parties authenticated this exact
    ///         policy. `unitsRoot` is the rolling commitment over the settlementUnitIds derived from this
    ///         escrow's address; `policyNonce` is the generation the factory consumed in the same call.
    event PolicyAccepted(
        bytes32 indexed jobPolicyHash,
        address indexed payer,
        address indexed operator,
        uint256 policyNonce,
        bytes32 unitsRoot,
        bool allowSelfAdjudication
    );
    event UnitFunded(bytes32 indexed unitId, uint256 g, uint256 f, uint256 n);
    event Funded(uint256 unitCount, uint256 totalGross, uint256 totalPayoutLegs);
    event OracleCohortPinned(uint64 indexed cohort); // rev-3 §A.2

    event LegDischarged(bytes32 indexed unitId, uint256 legIndex, ClaimClass class, address recipient, uint256 amount);
    event ClaimCreated(
        bytes32 indexed claimId, bytes32 indexed unitId, uint256 legIndex, ClaimClass class, address recipient, uint256 amount
    );
    event ClaimDischarged(bytes32 indexed claimId, bytes32 indexed unitId, address destination, uint256 amount);
    event ReleaseAllocated(bytes32 indexed unitId, uint256 claimCount);
    event RefundAllocated(bytes32 indexed unitId, uint256 claimCount);
    event DisputeOpened(bytes32 indexed unitId, uint256 nonce, uint256 effectiveDisputeExpiry);
    event DisputeResolved(bytes32 indexed unitId, bool operatorWins);
    event EvidenceReleased(bytes32 indexed unitId, bytes32 indexed assertionId);
    /// @param packageDigest the raw evidence-package digest the committer supplied.
    /// @param commitment    the domain-separated form actually stored + checked at release (§B).
    event EvidenceCommitted(bytes32 indexed unitId, bytes32 packageDigest, bytes32 commitment);
    event BuyerApproved(bytes32 indexed unitId, uint256 approvalNonce);
    event ClaimDestinationRotated(
        bytes32 indexed claimId, address previousDestination, address newDestination, uint256 nonce
    );

    // ── Errors ───────────────────────────────────────────────────────────────────────────────────
    error AlreadyInitialized();
    error NotInitialized();
    error OnlyFactory();
    error OnlyPayer();
    error AlreadySealed();
    error Reentrancy();
    error BadUnitCount();
    error BadLegCount();
    error TooManyLegs();
    error DuplicateUnit();
    error ZeroPayout();
    error PayoutSumMismatch();
    error ForbiddenRecipient();
    error BadReclaim();
    /// @notice H-01 §13.1/H-2: the dispute window is outside [MIN_DISPUTE_WINDOW, MAX_RECLAIM_DELAY]. A
    ///         zero window is what let `openDispute` and `refundOnDisputeExpiry` run in the SAME BLOCK.
    error BadDisputeWindow();
    /// @notice H-01: the operator and the payer must be distinct money-plane identities. Address inequality
    ///         is not independence, but it is a necessary condition for bilateral acceptance to mean anything.
    error PartyCollision();
    /// @notice The supplied configs do not hash to the `prePolicyRoot` bound into this clone's address.
    error PolicyRootMismatch();
    /// @notice The bilateral acceptance expired before funding.
    error PolicyExpired();
    /// @notice arbiter == payer or arbiter == operator without both parties signing `allowSelfAdjudication`.
    error SelfAdjudicationNotAccepted();
    /// @notice The operator did not authenticate this exact funded policy.
    error BadOperatorSignature();
    /// @notice A supplied acceptance signature exceeds MAX_SIGNATURE_BYTES.
    error SignatureTooLarge();
    error BalanceReadFailed();
    error FundingDeltaMismatch();
    error ConfigTooLarge();
    error UnitNotFound();
    error NotYetImplemented();
    error InvalidRecipient();
    error InsufficientLocalBalance();
    error ContradictoryTokenState();
    error NonCanonicalTransferReturn();
    error WrongTransferDelta();
    error Insolvent();
    error NotActive();
    error AuthorizationUsed();
    error RuntimeDomainMismatch();
    error TooLateToDispute();
    error DisputeAlreadyOpen();
    error NotArbiter();
    error NoLiveDispute();
    error DisputeExpired();
    error DisputeWindowOpen();
    error TooEarlyToReclaim();
    error LiveDispute();
    error ClaimNotFound();
    error ClaimStillUnpayable();
    error TooLateForEvidence();
    /// @dev P0-6: "no cohort assertion is bound to this unit" (an all-zero record ⇒ zero assertion id).
    ///      Carries L-02's intent forward: a zero/absent identifier fails closed instead of reading as a
    ///      default. The EAS-shaped siblings — `WrongSchema` / `WrongAttester` / `Revoked` / `Expired` /
    ///      `MalformedO5Data` — are DELETED, not silently dropped: each is structurally subsumed by the
    ///      direct read (see `releaseFromEvidence`), so keeping them would imply checks that no longer
    ///      exist.
    error AttestationNotFound();
    /// @dev The assertion is bound to a different escrow (the `attestation.recipient` check's successor).
    error WrongRecipient();
    error IdentityMismatch();
    error NotSettle();
    error Tier0NotEvidence();
    error TierNotMet();
    error RequestedTierMismatch();
    error FeeHashMismatch();
    error FeeBpsMismatch();
    error FeeRecipientMismatch();
    error NotTier0();
    error ApprovalBindingMismatch();
    error BadNonce();
    error ApprovalExpired();
    error BadSignature();
    // rev-3 §A.2/§C3/§E hardenings
    error InvalidOrDisabledCohort();
    error OracleCohortMismatch();
    error OracleCohortDisabled();
    error CompositionRootMismatch();
    error TierRequestMismatch();
    error TierOutOfRange();
    error TypeHashMismatch();
    error SchemaUidMismatch();
    // §B on-chain evidence binding
    error OnlyEvidenceCommitter();
    error ZeroEvidenceDigest();
    error EvidenceAlreadyCommitted();
    error EvidenceNotCommitted();
    error EvidenceBundleMismatch();

    modifier nonReentrant() {
        _enterGuard();
        _;
        _status = 1;
    }

    /// @dev Guard entry wrapped in a function so the shared money-out functions (2b) do not each
    ///      inline the check — keeps runtime bytecode under the EIP-170 limit.
    function _enterGuard() private {
        if (_status == 2) revert Reentrancy();
        _status = 2;
    }

    /// @dev Existence guard for unit-keyed views/paths (L-01). Wrapped for bytecode economy.
    function _requireUnitExists(bytes32 unitId) private view {
        if (_unitIndexPlusOne[unitId] == 0) revert UnitNotFound();
    }

    modifier onlyExisting(bytes32 unitId) {
        _requireUnitExists(unitId);
        _;
    }

    /// @param usdc canonical settlement asset (Base USDC).
    /// @param oracle the authorized O5 attester — the SOLE source of evidence-release authorization (P0-6).
    /// @param schemaUid / typeHash O5 publication pins (0 until O5 opens); metadata, not runtime checks.
    constructor(address usdc, address oracle, bytes32 schemaUid, bytes32 typeHash) {
        USDC = usdc;
        authorizedOracle = oracle;
        o5SchemaUid = schemaUid;
        // M-02: pin the published schema-UID metadata SYMMETRICALLY with the type-hash pin below. Without
        // it a one-char schema divergence would make every mint burn a unit's one-verdict slot and every
        // release revert `WrongSchema`, silently turning a whole cohort refund-only. Deploy-time only and
        // fail-closed: a mismatch — or an `oracle` that does not expose the getter — aborts the deployment.
        if (schemaUid != bytes32(0) && IOracleAttester(oracle).o5SchemaUid() != schemaUid) revert SchemaUidMismatch();
        // L-02: pin the published type-hash metadata to the bound cohort's live value when it is set.
        // Deploy-time only (constructor code, not runtime bytecode) and fail-closed: a mismatch — or an
        // `oracle` that does not expose the getter — aborts the deployment rather than shipping an escrow
        // whose published pin disagrees with the attester the money path actually trusts.
        if (typeHash != bytes32(0) && IOracleAttester(oracle).o5TypeHash() != typeHash) revert TypeHashMismatch();
        o5TypeHash = typeHash;
        factory = msg.sender;
        initialized = true; // lock the implementation; only fresh clones (initialized=false) can init
    }

    /// @notice One-time clone initialization by the factory (atomic clone+init upstream). Every field
    ///         written here is in the CREATE2 salt preimage, so this clone's authorities and terms are
    ///         exactly the ones its address commits to — initialization cannot introduce an authority the
    ///         address does not already prove.
    function initialize(PolicyIdentity calldata p) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (initialized) revert AlreadyInitialized();
        if (p.payer == address(0)) revert ForbiddenRecipient(); // payer is the immutable refund owner (High 9)
        // The operator is an AUTHORITY, so it is held to the same exclusion set as a money destination:
        // none of {0, this escrow, the token, the factory} can be a signing counterparty, and a zero
        // operator would silently mean "nobody has to accept" — the exact H-01 hole.
        _requireAllowedRecipient(p.operator);
        if (p.operator == p.payer) revert PartyCollision();
        // The arbiter is held to the same exclusion set for the same reason: zero, this escrow, the token
        // and the factory can none of them ever CALL `resolveDispute`, so any of them as arbiter makes
        // every opened dispute unresolvable and silently expire to a refund. A zero arbiter in particular
        // is never a deliberate choice, it is a default. Payer/operator arbiters ARE expressible, but only
        // via the bilaterally-signed `allowSelfAdjudication` flag checked at funding.
        _requireAllowedRecipient(p.arbiter);
        initialized = true;
        _status = 1;
        payer = p.payer;
        operator = p.operator;
        arbiter = p.arbiter;
        jobIdHash = p.jobIdHash;
        termsHash = p.termsHash;
        _policyNonce = p.policyNonce;
        _prePolicyRoot = p.prePolicyRoot;
        emit Initialized(p.payer, p.operator, p.arbiter, p.jobIdHash);
    }

    // ── Funding + atomic freeze (E2/E8/C4) ─────────────────────────────────────────────────────────

    /// @notice Configure + atomically freeze all settlement units, verify BILATERAL ACCEPTANCE, consume the
    ///         policy nonce, and reserve exactly ΣG — all in one transaction, so a funded escrow is by
    ///         construction one whose complete terms both parties authenticated. Every domain field is
    ///         derived on-chain (E5); every unit is validated against E3 invariants; the exact aggregate
    ///         gross is pulled and the balance delta is checked (rejects fee-on-transfer / under-receipt, C4).
    /// @dev    H-01 closure. Before this, the escrow could prove only that the PAYER selected the
    ///         authorities; the operator's presence in the contract was a payout address, which authenticates
    ///         nothing. Now no path reaches a funded state without an operator signature over the exact
    ///         policy, and the funding parameters that made the veto costless (a zero dispute window, a
    ///         self-selected arbiter, an unbounded reclaim horizon) are rejected here rather than resolved
    ///         later. Order is deliberate: freeze -> re-derive the pre-policy root -> parameter constraints
    ///         -> consume the nonce -> verify both signatures -> THEN pull funds. Any failure reverts the
    ///         whole call, so "verifies both signatures AND consumes the nonce atomically" is structural.
    function fund(UnitConfig[] calldata configs, PolicyAcceptance calldata acceptance) external nonReentrant {
        if (!initialized) revert NotInitialized();
        if (configurationSealed) revert AlreadySealed();
        // M-01 / §6: bound the COMPLETE fund() calldata (incl. 4-byte selector). Redundant with the leg
        // bounds below but pins the published input envelope. Max-config fit is asserted in the 2b tests.
        if (msg.data.length > VNextSettlementLib.MAX_CONFIG_BYTES) revert ConfigTooLarge();
        if (
            acceptance.payerSignature.length > VNextSettlementLib.MAX_SIGNATURE_BYTES
                || acceptance.operatorSignature.length > VNextSettlementLib.MAX_SIGNATURE_BYTES
        ) revert SignatureTooLarge();
        uint256 nConfigs = configs.length;
        if (nConfigs == 0 || nConfigs > VNextSettlementLib.MAX_SETTLEMENT_UNITS) revert BadUnitCount();
        // The payer leg of the acceptance: implicit ONLY for a direct payer-sent transaction. Any other
        // caller (a relayer, an agent, a composition parent) must carry an explicit payer signature, which
        // is verified against the same JobPolicyHash below. Checked here so a caller with no payer
        // authorization at all fails immediately rather than after the whole freeze loop.
        if (msg.sender != payer && acceptance.payerSignature.length == 0) revert OnlyPayer();

        // rev-3 §A.2: pin this escrow to the oracle attester's cohort. Funding is rejected if the cohort is
        // disabled (fail-closed); the pinned epoch is echoed by every O5 verdict and re-checked at release.
        // enabled()/cohortId() are external view (STATICCALL) on the immutable, trusted attester.
        if (!IOracleAttester(authorizedOracle).enabled()) revert InvalidOrDisabledCohort();
        oracleAuthEpoch = IOracleAttester(authorizedOracle).cohortId();
        emit OracleCohortPinned(oracleAuthEpoch);

        configurationSealed = true; // effects before the external token pull (nonReentrant-guarded)

        uint256 chainId = block.chainid;
        address self = address(this);
        uint256 expectedGross;
        uint256 legTotal;

        for (uint256 i; i < nConfigs; ++i) {
            UnitConfig calldata c = configs[i];

            // §E hardening: the evidence path settles at requiredTier and the stored requestedTier was dead —
            // pin them equal and bound the tier range so exactly one verdict (at the required tier) is payable.
            if (c.requiredTier != c.requestedTier) revert TierRequestMismatch();
            if (c.requiredTier > 3) revert TierOutOfRange();

            // H-2 explicit checked narrowing at the funding boundary. G is still STORED as uint256 — the
            // point is the CHECK: bounding gross to uint128 keeps ΣG over <= 16 units nowhere near uint256
            // overflow and makes the Wave-3 packed liability buckets safe by construction. `toUint128`
            // reverts (ValueOverflow) instead of truncating, which is the whole difference from `uint128(x)`.
            uint256 g = VNextSettlementLib.toUint128(c.g);

            bytes32 unitId =
                VNextSettlementLib.computeSettlementUnitId(chainId, self, jobIdHash, c.milestoneIndex, c.stepId);
            if (_unitIndexPlusOne[unitId] != 0) revert DuplicateUnit();

            FeeSchedule memory fs = FeeSchedule({
                domainVersion: VNextSettlementLib.DOMAIN_VERSION_V1,
                chainId: chainId,
                escrow: self,
                settlementUnitId: unitId,
                feeBasis: VNextSettlementLib.FEE_BASIS_GROSS,
                g: g,
                f: c.f,
                n: c.n,
                feeBps: c.feeBps,
                denominator: VNextSettlementLib.FEE_DENOMINATOR,
                roundingRule: VNextSettlementLib.ROUNDING_FLOOR,
                feeRecipient: c.feeRecipient,
                feeSplitConfigHash: bytes32(0)
            });
            VNextSettlementLib.checkV1Invariants(fs); // E3 (incl. F == mulDiv(G,feeBps,10000))

            uint256 legs = c.payouts.length;
            if (legs == 0 || legs > VNextSettlementLib.MAX_PAYOUT_LEGS_PER_UNIT) revert BadLegCount();
            legTotal += legs;

            uint256 sum;
            for (uint256 j; j < legs; ++j) {
                PayoutEntry calldata p = c.payouts[j];
                if (p.amount == 0) revert ZeroPayout(); // never a zero-value claim (High 9)
                _requireAllowedRecipient(p.recipient);
                sum += p.amount;
                _payouts[unitId].push(p);
            }
            if (sum != c.n) revert PayoutSumMismatch();
            // fee leg present iff F>0 (E8); feeRecipient is committed whenever feeBps>0 (E3), validate it then.
            if (c.feeBps > 0) _requireAllowedRecipient(c.feeRecipient);

            // H-2 §13.1 RECLAIM BOUNDS. Before this the funding path enforced only the LOWER edge
            // (`reclaimAt <= block.timestamp` reverts), so an unbounded far-future deadline was legal and a
            // payer could pin the operator's settlement horizon for a decade. Both edges are now bounded,
            // and the ceiling is sized from PHYSICAL REALITY (long-lead tooling, castings and regulated QC
            // legitimately run months) rather than from the attack — it must accommodate
            // `primaryAssertionCutoff = reclaimAt - challengeWindow - appealWindow` (§8.2 C-3).
            if (c.reclaimAt <= block.timestamp) revert BadReclaim();
            uint256 reclaimDelay = c.reclaimAt - block.timestamp;
            if (
                reclaimDelay < VNextSettlementLib.MIN_RECLAIM_DELAY
                    || reclaimDelay > VNextSettlementLib.MAX_RECLAIM_DELAY
            ) revert BadReclaim();
            // H-01 anti-costless-veto. With a nonzero minimum window,
            // `effectiveDisputeExpiry = min(openedAt + disputeWindow, reclaimAt)` is STRICTLY greater than
            // `openedAt` — `openDispute` already requires `openedAt < reclaimAt`, so both branches of the
            // min exceed `openedAt`. `refundOnDisputeExpiry` requires `now >= effectiveDisputeExpiry`, so
            // the same-block openDispute -> refundOnDisputeExpiry sequence is impossible BY CONSTRUCTION,
            // not by policy. The upper edge keeps the value inside its checked uint64 packing.
            if (
                c.disputeWindow < VNextSettlementLib.MIN_DISPUTE_WINDOW
                    || c.disputeWindow > VNextSettlementLib.MAX_RECLAIM_DELAY
            ) revert BadDisputeWindow();

            Unit storage u = _units[unitId];
            u.feeSchedule = fs;
            u.feeScheduleHash = VNextSettlementLib.computeFeeScheduleHash(fs);
            u.payoutConfigHash = VNextSettlementLib.computePayoutConfigHash(unitId, _payouts[unitId]);
            u.milestoneIndex = c.milestoneIndex;
            u.stepId = c.stepId;
            u.requiredTier = c.requiredTier;
            u.requestedTier = c.requestedTier;
            // rev-3 §C2: freeze the composition commitment as-is (the composition lane owns the root's
            // internal structure; the escrow only equality-checks it against the O5 echo at release).
            u.compositionSchemaVersion = c.compositionSchemaVersion;
            u.compositionRoot = c.compositionRoot;
            // §B: freeze the funder-designated evidence committer (see UnitConfig for the binding rule).
            _requireAllowedRecipient(c.evidenceCommitter);
            u.evidenceCommitter = c.evidenceCommitter;
            u.state = UnitState.FUNDED_ACTIVE;
            // H-2 checked downcasts into the packed slot (both values were bounded immediately above).
            u.reclaimAt = VNextSettlementLib.toUint64(c.reclaimAt);
            u.disputeWindow = VNextSettlementLib.toUint64(c.disputeWindow);
            u.liability = g; // FUNDED_ACTIVE liability == G (§3)

            _unitIds.push(unitId);
            _unitIndexPlusOne[unitId] = _unitIds.length;
            expectedGross += g;
            emit UnitFunded(unitId, g, c.f, c.n);
        }

        if (legTotal > VNextSettlementLib.MAX_TOTAL_LEGS_PER_JOB) revert TooManyLegs();
        totalPayoutLegs = legTotal;
        totalLiability = expectedGross;

        // H-01: bilateral acceptance + policy-nonce consumption, BEFORE any money moves. Extracted so the
        // freeze loop above keeps its own stack; a revert here rolls the entire freeze back.
        _acceptPolicy(configs, acceptance);

        // Pull exactly ΣG and verify the received delta (C4 — rejects fee-on-transfer / under-receipt).
        uint256 beforeBal = _safeBalanceOf(self);
        IERC20(USDC).safeTransferFrom(payer, self, expectedGross);
        uint256 afterBal = _safeBalanceOf(self);
        if (afterBal < beforeBal || afterBal - beforeBal != expectedGross) revert FundingDeltaMismatch();

        emit Funded(nConfigs, expectedGross, legTotal);
    }

    // ── H-01 bilateral acceptance (§2.1 + §8.2 H-1) ───────────────────────────────────────────────

    /// @dev The single place a funded escrow proves BOTH parties authenticated the complete configuration.
    ///      Five steps, in this order:
    ///        1. the escrow's own ADDRESS commits to the terms — `prePolicyRoot` is in the CREATE2 salt
    ///           preimage, so re-deriving it from the supplied configs proves this clone is being funded
    ///           with exactly the terms the address was predicted from, before any signature is read;
    ///        2. self-adjudication is expressible but never implicit;
    ///        3. acceptance is time-bounded;
    ///        4. the policy generation is consumed at the factory (retiring it and every older one, and
    ///           failing closed if either party revoked) — which also returns the implementation so the
    ///           signatures bind the exact deployment incarnation;
    ///        5. both signatures are checked against ONE canonical `JobPolicyHash`.
    function _acceptPolicy(UnitConfig[] calldata configs, PolicyAcceptance calldata acceptance) private {
        if (keccak256(abi.encode(configs)) != _prePolicyRoot) revert PolicyRootMismatch();

        // "Address inequality is not independence": an arbiter that IS one of the parties is a costless
        // veto (or a self-release), so it is rejected unless BOTH parties signed a policy that says so.
        // The flag lives inside the signed hash, so it can never be supplied by whoever sends the tx alone.
        if (!acceptance.allowSelfAdjudication && (arbiter == payer || arbiter == operator)) {
            revert SelfAdjudicationNotAccepted();
        }
        if (block.timestamp > acceptance.expiry) revert PolicyExpired();

        // Passing the identity BACK to the factory is also a self-consistency proof: `consumePolicyNonce`
        // recomputes the salt from these fields and requires the resulting CREATE2 address to equal
        // `msg.sender`. So a clone can only ever fund itself if its stored identity really is the one its
        // own address commits to — the initialization cannot have drifted from the salt.
        address impl = IVNextEscrowFactory(factory).consumePolicyNonce(
            PolicyIdentity({
                payer: payer,
                operator: operator,
                arbiter: arbiter,
                jobIdHash: jobIdHash,
                termsHash: termsHash,
                policyNonce: _policyNonce,
                prePolicyRoot: _prePolicyRoot
            })
        );

        bytes32 root = _unitsRoot();
        bytes32 ph = _hashJobPolicy(impl, root, acceptance.allowSelfAdjudication, acceptance.expiry);
        bytes32 digest = _typedDataHash(ph);
        // Delegated/agent funding: an absent payer signature was already rejected as `OnlyPayer` at entry;
        // a present one must actually validate. A direct payer-sent tx authenticates itself.
        if (msg.sender != payer && !_isValidSignature(payer, digest, acceptance.payerSignature)) {
            revert BadSignature();
        }
        // The operator NEVER sends this transaction, so its acceptance is always an explicit signature —
        // ECDSA for an EOA, ERC-1271 for a smart account (both handled by `_isValidSignature`).
        if (!_isValidSignature(operator, digest, acceptance.operatorSignature)) revert BadOperatorSignature();

        _jobPolicyHash = ph;
        _selfAdjudicationAccepted = acceptance.allowSelfAdjudication;
        emit PolicyAccepted(ph, payer, operator, _policyNonce, root, acceptance.allowSelfAdjudication);
    }

    /// @notice The complete bilateral-acceptance record in ONE read. A COLLAPSED getter by design: the
    ///         frozen size-reclamation order prefers collapsing read surfaces over four separate dispatch
    ///         entries, and reading the policy atomically is also the correct shape for a verifier.
    ///         `jobPolicyHash_` is zero until the escrow is funded — i.e. until acceptance actually happened.
    function policy()
        external
        view
        returns (
            address operator_,
            address arbiter_,
            uint256 policyNonce_,
            bytes32 prePolicyRoot_,
            bytes32 jobPolicyHash_,
            bool selfAdjudicationAccepted_
        )
    {
        return (operator, arbiter, _policyNonce, _prePolicyRoot, _jobPolicyHash, _selfAdjudicationAccepted);
    }

    /// @dev The rolling commitment over every settlementUnitId this escrow froze, in funding order:
    ///      `r_0 = 0; r_k = keccak256(abi.encode(r_{k-1}, unitId_k))`. Both parties reproduce it off-chain
    ///      from the PREDICTED escrow address alone (step 4 of the §8.2 H-1 sequence), which is what lets
    ///      them sign over the unit ids before the clone exists. Derivationally redundant with
    ///      {escrow, prePolicyRoot} — carried because §2.1 requires the commitment to cover the unit ids
    ///      explicitly, and because it is what an operator actually checks before signing.
    function _unitsRoot() private view returns (bytes32 r) {
        uint256 n = _unitIds.length;
        for (uint256 i; i < n; ++i) {
            r = keccak256(abi.encode(r, _unitIds[i]));
        }
    }

    /// @dev EIP-712 struct hash of the frozen policy. Split into two `abi.encode` calls to avoid
    ///      stack-too-deep; all 16 words are static, so `bytes.concat(abi.encode(..), abi.encode(..))`
    ///      equals `abi.encode(all 16)` and the EIP-712 hash is identical.
    function _hashJobPolicy(address impl, bytes32 unitsRoot, bool allowSelfAdjudication, uint256 expiry)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            bytes.concat(
                abi.encode(
                    JOB_POLICY_TYPEHASH, block.chainid, factory, impl, address(this), POLICY_VERSION, payer, operator
                ),
                abi.encode(
                    arbiter, jobIdHash, termsHash, _policyNonce, _prePolicyRoot, unitsRoot, allowSelfAdjudication,
                    expiry
                )
            )
        );
    }

    // ── Recipient exclusion set (High 9) ──────────────────────────────────────────────────────────
    function _requireAllowedRecipient(address r) internal view {
        if (r == address(0) || r == address(this) || r == USDC || r == factory) revert ForbiddenRecipient();
    }

    // ── Safe balance read (C1): staticcall balanceOf; require success + exactly 32 bytes ──────────
    function _safeBalanceOf(address account) internal view returns (uint256) {
        (bool ok, bytes memory ret) = USDC.staticcall(abi.encodeCall(IERC20.balanceOf, (account)));
        if (!ok || ret.length != 32) revert BalanceReadFailed();
        return abi.decode(ret, (uint256));
    }

    // ── E2 named getters (all 13 frozen fields + record; existence-checked, revert on absent) ──────
    function unitExists(bytes32 unitId) public view returns (bool) {
        return _unitIndexPlusOne[unitId] != 0;
    }

    function unitState(bytes32 unitId) external view onlyExisting(unitId) returns (UnitState) {
        return _units[unitId].state;
    }

    function feeDomainVersion(bytes32 unitId) external view onlyExisting(unitId) returns (uint8) {
        return _units[unitId].feeSchedule.domainVersion;
    }

    function feeChainId(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].feeSchedule.chainId;
    }

    function escrowOf(bytes32 unitId) external view onlyExisting(unitId) returns (address) {
        return _units[unitId].feeSchedule.escrow;
    }

    function settlementUnitIdOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].feeSchedule.settlementUnitId;
    }

    function feeBasisOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint8) {
        return _units[unitId].feeSchedule.feeBasis;
    }

    function gross(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].feeSchedule.g;
    }

    function fee(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].feeSchedule.f;
    }

    function net(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].feeSchedule.n;
    }

    function feeBpsOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint16) {
        return _units[unitId].feeSchedule.feeBps;
    }

    function denominatorOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].feeSchedule.denominator;
    }

    function roundingRuleOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint8) {
        return _units[unitId].feeSchedule.roundingRule;
    }

    function feeRecipientOf(bytes32 unitId) external view onlyExisting(unitId) returns (address) {
        return _units[unitId].feeSchedule.feeRecipient;
    }

    function feeSplitConfigHashOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].feeSchedule.feeSplitConfigHash;
    }

    function feeScheduleHashOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].feeScheduleHash;
    }

    function payoutConfigHashOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].payoutConfigHash;
    }

    /// @notice rev-3 §C2/§C3 read surface (M-01): the funding-frozen composition commitment. The oracle
    ///         attester STATICCALLs this to bind its verdict to the SAME root the escrow will check at
    ///         release — without it a stale-root verdict would consume the unit's one-verdict slot and
    ///         permanently strand evidence settlement for that unit.
    function compositionRootOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].compositionRoot;
    }

    /// @notice rev-3 §C2: the funding-frozen composition schema version (0 = non-composed).
    function compositionSchemaVersionOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint16) {
        return _units[unitId].compositionSchemaVersion;
    }

    /// @notice §B: the funding-frozen evidence committer — the only address `submitEvidence` accepts.
    function evidenceCommitterOf(bytes32 unitId) external view onlyExisting(unitId) returns (address) {
        return _units[unitId].evidenceCommitter;
    }

    /// @notice §B: whether an evidence package has been committed for this unit.
    function evidenceCommittedOf(bytes32 unitId) external view onlyExisting(unitId) returns (bool) {
        return _units[unitId].evidenceCommitted;
    }

    /// @notice §B: the committed evidence commitment the O5 verdict must echo.
    /// @dev    REVERTS with `EvidenceNotCommitted` when nothing is committed rather than returning zero —
    ///         the default value must never be readable as a valid commitment by any consumer (that is the
    ///         same reason `evidenceCommitted` is a separate flag). The oracle attester STATICCALLs this
    ///         before minting, so an uncommitted unit fails closed instead of burning its verdict slot.
    function evidenceBundleHashOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        Unit storage u = _units[unitId];
        if (!u.evidenceCommitted) revert EvidenceNotCommitted();
        return u.evidenceBundleHash;
    }

    // ── §B on-chain evidence binding ──────────────────────────────────────────────────────────────

    /// @notice Commit the evidence package this unit will be settled against (§B). One shot, by the
    ///         funding-frozen committer only, while the unit is still live and undisputed.
    /// @dev    The stored value is the DOMAIN-SEPARATED commitment, not `packageDigest` itself, so the same
    ///         package hash committed for another chain/escrow/unit/schema-version/format can never satisfy
    ///         this unit's release (`VNextSettlementLib.computeEvidenceCommitment`). One-shot + the release
    ///         check together mean the committer selects the package BEFORE any verdict exists, and can
    ///         never re-point a funded unit at a second package to shop for a payable verdict.
    ///         This function is on the RELEASE path only: refund/reclaim never reads any of these fields, so
    ///         a missing, late, or wrong commit simply fails closed to the payer's refund at `reclaimAt`.
    function submitEvidence(bytes32 unitId, bytes32 packageDigest) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        if (msg.sender != u.evidenceCommitter) revert OnlyEvidenceCommitter();
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp >= u.reclaimAt) revert TooLateForEvidence();
        if (u.dispute.opened) revert LiveDispute();
        if (packageDigest == bytes32(0)) revert ZeroEvidenceDigest();
        if (u.evidenceCommitted) revert EvidenceAlreadyCommitted();

        // The unit's FROZEN chainId (== block.chainid at funding; the release path re-checks that they
        // still agree via `_assertRuntimeDomain`), mirroring how `settlementUnitId` itself was derived.
        bytes32 commitment = VNextSettlementLib.computeEvidenceCommitment(
            u.feeSchedule.chainId,
            address(this),
            unitId,
            u.compositionSchemaVersion,
            VNextSettlementLib.EVIDENCE_PACKAGE_FORMAT_V1,
            packageDigest
        );
        u.evidenceBundleHash = commitment;
        u.evidenceCommitted = true;
        emit EvidenceCommitted(unitId, packageDigest, commitment);
    }

    function milestoneIndexOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].milestoneIndex;
    }

    function stepIdOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].stepId;
    }

    function requiredTierOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint8) {
        return _units[unitId].requiredTier;
    }

    function requestedTierOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint8) {
        return _units[unitId].requestedTier;
    }

    function reclaimAtOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].reclaimAt;
    }

    function disputeWindowOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].disputeWindow;
    }

    function liabilityOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].liability;
    }

    function payoutCount(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _payouts[unitId].length;
    }

    function payoutAt(bytes32 unitId, uint256 index)
        external
        view
        onlyExisting(unitId)
        returns (address recipient, uint256 amount)
    {
        PayoutEntry storage p = _payouts[unitId][index];
        return (p.recipient, p.amount);
    }

    function unitCount() external view returns (uint256) {
        return _unitIds.length;
    }

    function unitIdAt(uint256 index) external view returns (bytes32) {
        return _unitIds[index];
    }

    // ── L-01 claim / dispute / one-shot read surfaces (views only; no new authority or mutation) ────
    /// @notice The full collateralized-claim record for `claimId`. Existence-checked, mirroring the
    ///         `!c.exists → ClaimNotFound` guard `dischargeClaim` uses.
    function claimOf(bytes32 claimId) external view returns (ClaimRecord memory) {
        ClaimRecord storage c = _claims[claimId];
        if (!c.exists) revert ClaimNotFound();
        return c;
    }

    /// @notice The dispute record for a unit (opened/resolved/nonce/timing). Existence-checked.
    function disputeOf(bytes32 unitId) external view onlyExisting(unitId) returns (Dispute memory) {
        return _units[unitId].dispute;
    }

    /// @notice Outstanding collateralized claims for a unit; a unit reaches SETTLED_* only once this hits 0 (§7).
    function remainingClaimCountOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return _units[unitId].remainingClaimCount;
    }

    /// @notice Whether a §2 authorization key has already been consumed (release/refund/dispute single-use).
    function authorizationUsed(bytes32 authKey) external view returns (bool) {
        return _authorizationUsed[authKey];
    }

    // P0-6: `easUidUsed(bytes32)` is REMOVED with the EAS read path. The equivalent read surface is now
    // `authorizationUsed(authKey)` above (the key is derived from the assertion id) and, at the source,
    // `IOracleAttester(authorizedOracle).usedUnit(unitId)`.

    // ── Money-out machinery (INCREMENT 2b) ───────────────────────────────────────────────────────
    // Every money-out entry shares the reentrancy guard, gates on global solvency, routes
    // release/refund through a single internal allocator (distribution equality by construction),
    // uses tryTransferExact (three-way + both-delta), and consumes the unit before any transfer.
    // FROZEN §§4/5/9/10.10 + sol guards C1–C5 / H6–H10.

    /// @dev Global solvency gate (C1 / DI-3): escrow USDC must cover ALL outstanding liabilities.
    function _requireSolvent() private view {
        if (_safeBalanceOf(address(this)) < totalLiability) revert Insolvent();
    }

    /// @dev Runtime-domain check (E5/H2/H6): the frozen chainId/escrow must equal the live values.
    function _assertRuntimeDomain(Unit storage u) private view {
        if (u.feeSchedule.chainId != block.chainid || u.feeSchedule.escrow != address(this)) {
            revert RuntimeDomainMismatch();
        }
    }

    /// @dev tryTransferExact (FROZEN §5, sol C1): DISCHARGE = accepted return AND both exact deltas;
    ///      CLAIM = the call reverted AND balances unchanged; everything else REVERTS the whole tx.
    function _tryTransferExact(address recipient, uint256 amount) private returns (TransferResult) {
        if (recipient == address(this)) revert InvalidRecipient();
        uint256 escrowBefore = _safeBalanceOf(address(this));
        if (escrowBefore < amount) revert InsufficientLocalBalance();
        uint256 recipientBefore = _safeBalanceOf(recipient);

        (bool ok, bytes memory ret) = USDC.call(abi.encodeCall(IERC20.transfer, (recipient, amount)));

        uint256 escrowAfter = _safeBalanceOf(address(this));
        uint256 recipientAfter = _safeBalanceOf(recipient);

        if (!ok) {
            if (escrowAfter != escrowBefore || recipientAfter != recipientBefore) revert ContradictoryTokenState();
            return TransferResult.CLAIM;
        }
        bool accepted = ret.length == 0 || (ret.length == 32 && abi.decode(ret, (uint256)) == 1);
        if (!accepted) revert NonCanonicalTransferReturn();
        if (
            escrowAfter != escrowBefore - amount || recipientAfter < recipientBefore
                || recipientAfter - recipientBefore != amount
        ) revert WrongTransferDelta();
        return TransferResult.DISCHARGE;
    }

    /// @dev Settle one leg during allocation: DISCHARGE decrements both liability buckets; CLAIM
    ///      records a collateralized claim and leaves liability (still owed — a CLAIM never ADDS
    ///      liability, §3 / sol C3). Returns 1 iff a claim was created.
    function _settleLeg(
        bytes32 unitId,
        Unit storage u,
        uint256 legIndex,
        ClaimClass class,
        address recipient,
        uint256 amount
    ) private returns (uint256 claimCreated) {
        if (_tryTransferExact(recipient, amount) == TransferResult.DISCHARGE) {
            u.liability -= amount;
            totalLiability -= amount;
            emit LegDischarged(unitId, legIndex, class, recipient, amount);
            return 0;
        }
        bytes32 cid = VNextSettlementLib.computeClaimId(u.feeSchedule.chainId, address(this), unitId, legIndex, class);
        _claims[cid] = ClaimRecord({
            exists: true,
            settlementUnitId: unitId,
            claimOwner: recipient,
            claimDestination: recipient,
            amount: amount,
            class: class,
            destinationNonce: 0
        });
        emit ClaimCreated(cid, unitId, legIndex, class, recipient, amount);
        return 1;
    }

    /// @dev The SINGLE release allocator (sol C2). All release authorities converge here, so the
    ///      distribution is identical regardless of authority. Consumes FUNDED_ACTIVE before transfers.
    function _allocateRelease(bytes32 unitId, bytes32 authKey) private {
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        _assertRuntimeDomain(u);
        _requireSolvent();
        if (_authorizationUsed[authKey]) revert AuthorizationUsed();
        _authorizationUsed[authKey] = true;
        u.state = UnitState.RELEASE_ALLOCATED;

        FeeSchedule storage fs = u.feeSchedule;
        uint256 legs = _payouts[unitId].length;
        uint256 remaining;
        for (uint256 i; i < legs; ++i) {
            PayoutEntry storage p = _payouts[unitId][i];
            remaining += _settleLeg(unitId, u, i, ClaimClass.PRINCIPAL, p.recipient, p.amount);
        }
        if (fs.f > 0) {
            remaining += _settleLeg(unitId, u, VNextSettlementLib.FEE_LEG_INDEX, ClaimClass.FEE, fs.feeRecipient, fs.f);
        }
        u.remainingClaimCount = remaining;
        if (remaining == 0) u.state = UnitState.SETTLED_RELEASED;
        emit ReleaseAllocated(unitId, remaining);
    }

    /// @dev The refund allocator: the entire committed G returns to the immutable payer (one leg).
    function _allocateRefund(bytes32 unitId, bytes32 authKey) private {
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        _assertRuntimeDomain(u);
        _requireSolvent();
        if (_authorizationUsed[authKey]) revert AuthorizationUsed();
        _authorizationUsed[authKey] = true;
        u.state = UnitState.REFUND_ALLOCATED;

        uint256 remaining =
            _settleLeg(unitId, u, VNextSettlementLib.REFUND_LEG_INDEX, ClaimClass.REFUND, payer, u.feeSchedule.g);
        u.remainingClaimCount = remaining;
        if (remaining == 0) u.state = UnitState.SETTLED_REFUNDED;
        emit RefundAllocated(unitId, remaining);
    }

    /// @notice Discharge an existing collateralized claim (sol C3). A safe-revert here reverts the
    ///         whole call (restoring the claim); only an exact both-delta transfer clears it.
    function dischargeClaim(bytes32 claimId) external nonReentrant {
        ClaimRecord storage c = _claims[claimId];
        if (!c.exists) revert ClaimNotFound();
        bytes32 unitId = c.settlementUnitId; // H-01
        Unit storage u = _units[unitId];
        _requireSolvent();
        address dest = c.claimDestination;
        uint256 amount = c.amount;
        if (_tryTransferExact(dest, amount) != TransferResult.DISCHARGE) revert ClaimStillUnpayable();
        u.liability -= amount;
        totalLiability -= amount;
        delete _claims[claimId];
        u.remainingClaimCount -= 1;
        emit ClaimDischarged(claimId, unitId, dest, amount);
        if (u.remainingClaimCount == 0) {
            u.state = u.state == UnitState.REFUND_ALLOCATED ? UnitState.SETTLED_REFUNDED : UnitState.SETTLED_RELEASED;
        }
    }

    // ── Dispute + reclaim authorities (FROZEN §4) ─────────────────────────────────────────────────

    /// @notice Payer opens a dispute before `reclaimAt`; blocks evidence release, arms arbitration.
    function openDispute(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        if (msg.sender != payer) revert OnlyPayer();
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp >= u.reclaimAt) revert TooLateToDispute();
        if (u.dispute.opened) revert DisputeAlreadyOpen(); // single dispute (v1)
        u.dispute.opened = true;
        u.dispute.nonce += 1;
        u.dispute.openedAt = block.timestamp;
        uint256 deadline = block.timestamp + u.disputeWindow; // checked (0.8)
        u.dispute.adjudicationDeadline = deadline;
        uint256 eff = deadline < u.reclaimAt ? deadline : u.reclaimAt; // min(deadline, reclaimAt)
        u.dispute.effectiveDisputeExpiry = eff;
        emit DisputeOpened(unitId, u.dispute.nonce, eff);
    }

    /// @notice Arbiter resolves before `effectiveDisputeExpiry`: operator-win → release, else refund.
    function resolveDispute(bytes32 unitId, bool operatorWins) external nonReentrant onlyExisting(unitId) {
        if (msg.sender != arbiter) revert NotArbiter();
        Unit storage u = _units[unitId];
        if (!u.dispute.opened || u.dispute.resolved) revert NoLiveDispute();
        if (block.timestamp >= u.dispute.effectiveDisputeExpiry) revert DisputeExpired();
        u.dispute.resolved = true;
        bytes32 authKey = _disputeAuthKey(unitId, u.dispute.nonce, operatorWins, u.dispute.adjudicationDeadline);
        if (operatorWins) {
            _allocateRelease(unitId, authKey);
        } else {
            _allocateRefund(unitId, authKey);
        }
        emit DisputeResolved(unitId, operatorWins);
    }

    /// @notice Permissionless payer refund once an opened dispute passes `effectiveDisputeExpiry`
    ///         unresolved — available even before `reclaimAt` (no dead interval, §4).
    function refundOnDisputeExpiry(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        if (!u.dispute.opened || u.dispute.resolved) revert NoLiveDispute();
        if (block.timestamp < u.dispute.effectiveDisputeExpiry) revert DisputeWindowOpen();
        u.dispute.resolved = true;
        bytes32 authKey = _disputeAuthKey(unitId, u.dispute.nonce, false, u.dispute.adjudicationDeadline);
        _allocateRefund(unitId, authKey);
        emit DisputeResolved(unitId, false);
    }

    /// @notice Permissionless payer refund at/after `reclaimAt` when no dispute is live.
    function reclaimAfterDeadline(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp < u.reclaimAt) revert TooEarlyToReclaim();
        if (u.dispute.opened && !u.dispute.resolved) revert LiveDispute(); // use refundOnDisputeExpiry first
        bytes32 authKey = _authorizationKey(
            AuthorizationType.RECLAIM,
            AUTHDOMAIN_RECLAIM,
            address(this),
            // uint256() is explicit, not cosmetic: `abi.encode` pads a uint64 to the same 32 bytes, so the
            // authorization key is byte-identical to the pre-packing form — stated so it stays that way.
            keccak256(abi.encode("RECLAIM", unitId, uint256(u.reclaimAt))),
            unitId
        );
        _allocateRefund(unitId, authKey);
    }

    /// @dev §2 authorization-key envelope (L-01): binds type + issuer domain + issuer + raw id + chain + escrow + unit.
    function _authorizationKey(
        AuthorizationType authType,
        bytes32 issuerDomain,
        address issuer,
        bytes32 rawAuthorizationId,
        bytes32 unitId
    ) private view returns (bytes32) {
        return keccak256(
            abi.encode(uint8(authType), issuerDomain, issuer, rawAuthorizationId, block.chainid, address(this), unitId)
        );
    }

    function _disputeAuthKey(bytes32 unitId, uint256 nonce, bool operatorWins, uint256 adjudicationDeadline)
        private
        view
        returns (bytes32)
    {
        bytes32 rawId = keccak256(abi.encode("DISPUTE", unitId, nonce, operatorWins, adjudicationDeadline));
        return _authorizationKey(AuthorizationType.DISPUTE, AUTHDOMAIN_DISPUTE, arbiter, rawId, unitId);
    }

    // ── Crypto authorities (INCREMENT 2b-ii) ─────────────────────────────────────────────────────

    /// @notice Evidence release (FROZEN §9, sol H8/H3): read the DIRECT COHORT ASSERTION bound to this
    ///         unit and, on a settle verdict for a Tier>=1 unit with matching identity + fee commitment,
    ///         release. P0-6: this is the ONLY evidence-release path — the EAS-read path is deleted, not
    ///         retained behind a flag, so there is exactly one release predicate to audit and no bypass.
    /// @dev    The money path now makes exactly two STATICCALLs, both to the escrow's own immutable
    ///         `authorizedOracle` (`assertionOf`, `enabled`). It reads no attestation registry and depends
    ///         on no global write, so no external outage can strand a funded job on the release side.
    ///
    ///         Checks structurally SUBSUMED by reading the attester directly (each was an EAS artifact):
    ///          * `attestation.attester == authorizedOracle` → the escrow CALLS `authorizedOracle`; "who
    ///            asserted" is now the identity of the callee, not a field to compare.
    ///          * `attestation.uid == requestedUid` → the record is KEYED by `settlementUnitId`, which is
    ///            the argument, so it is bound to the requested unit by construction. The caller no longer
    ///            selects which verdict to present at all.
    ///          * `attestation.schema == o5SchemaUid` → there is no ABI blob to type; the record is a typed
    ///            struct with one canonical shape.
    ///          * `data.length == O5_VERDICT_BYTES` → same reason: nothing is decoded from bytes.
    ///          * `revocationTime == 0` → O5 records were already minted non-revocable, and the assertion
    ///            record is write-once by construction. The cohort kill-switch (`enabled`, re-checked
    ///            below) remains the real revocation lever and is unchanged.
    ///          * `expirationTime` → O5 mints always used "never expires"; the unit's own `reclaimAt`
    ///            (checked above) is the real time bound and is unchanged.
    ///         Everything else is preserved verbatim, in the same order, below.
    function releaseFromEvidence(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp >= u.reclaimAt) revert TooLateForEvidence();
        if (u.dispute.opened) revert LiveDispute(); // H7: any opened dispute blocks evidence release

        // The one money-path read (replaces `IEAS.getAttestation`). Fail-closed: an un-asserted unit
        // returns the all-zero record, whose zero `assertionId` is rejected on the next line (L-02).
        O5Assertion memory a = IOracleAttester(authorizedOracle).assertionOf(unitId);
        if (a.assertionId == bytes32(0)) revert AttestationNotFound();
        if (a.escrow != address(this)) revert WrongRecipient(); // the `attestation.recipient` check

        // H3 identity. The attester bound `computeSettlementUnitId(chainid, escrow, jobIdHash,
        // milestoneIndex, stepId) == v.settlementUnitId` before writing, and this record is keyed by that
        // same id; recomputing the id here from the escrow's OWN FROZEN fields and requiring equality
        // therefore pins jobIdHash / milestoneIndex / stepId / escrow by collision resistance — the same
        // guarantee the four field-by-field comparisons used to give, without carrying the fields.
        bytes32 recomputed = VNextSettlementLib.computeSettlementUnitId(
            u.feeSchedule.chainId, address(this), jobIdHash, u.milestoneIndex, u.stepId
        );
        if (recomputed != unitId) revert IdentityMismatch();

        // Evidence predicate (§9): settle-only, Tier>=1, tier fulfillment + request identity, fee commitment.
        // The attester also pre-checks these (M-01 anti-brick) against the SAME frozen escrow state; they
        // are re-checked here because this is the contract that moves the money and the fields it compares
        // against are its own storage, not a value another contract reported.
        if (a.decision != O5_DECISION_SETTLE) revert NotSettle();
        if (u.requiredTier < 1) revert Tier0NotEvidence();
        if (a.achievedTier > MAX_TIER) revert TierOutOfRange(); // M-01: bound the oracle-asserted tier (0..3)
        if (a.achievedTier < u.requiredTier) revert TierNotMet();
        if (a.requestedTier != u.requiredTier) revert RequestedTierMismatch();
        if (a.feeScheduleHash != u.feeScheduleHash) revert FeeHashMismatch();
        // M-01: also bind the RAW fee fields carried in the permanent assertion, not just their 13-field
        // hash — downstream receipts/indexers read these words directly, so a true-hash/false-economics
        // verdict must be rejected here too (the attester pre-checks the same two fields before asserting).
        if (a.feeBps != u.feeSchedule.feeBps) revert FeeBpsMismatch();
        if (a.feeRecipient != u.feeSchedule.feeRecipient) revert FeeRecipientMismatch();

        // rev-3 §A.2/§C3: cohort-epoch binding + composition-root binding + kill-switch AT PAYMENT TIME.
        // The epoch echo must match the funded cohort; the echoed root must equal the frozen unit root
        // (so the oracle verdict cryptographically covers the composition root); and the cohort must still
        // be enabled — a one-way disable neutralizes an otherwise-valid pre-written assertion here.
        if (a.oracleAuthEpoch != oracleAuthEpoch) revert OracleCohortMismatch();
        if (a.compositionRoot != u.compositionRoot) revert CompositionRootMismatch();

        // §B on-chain evidence binding: the verdict must be over the package this unit committed to, and a
        // unit with nothing committed can never release on evidence. The `evidenceCommitted` flag is checked
        // separately from the hash so a zero/default `evidenceBundleHash` on BOTH sides can never match.
        // With `requiredTier == requestedTier` frozen at funding (§E), at most ONE assertion per unit at the
        // source, and the unit state consumed once here, exactly one verdict — the one over the committed
        // package, at the required tier — is ever payable for a unit.
        if (!u.evidenceCommitted || a.evidenceBundleHash != u.evidenceBundleHash) revert EvidenceBundleMismatch();

        if (!IOracleAttester(authorizedOracle).enabled()) revert OracleCohortDisabled();

        // §2 authorization key: `rawAuthorizationId` is the assertion id (the FULL signed verdict hash),
        // taking over from the EAS uid. Single-use in `_authorizationUsed`, which is what carries the old
        // `_easUidUsed` replay guard forward on the new rail.
        _allocateRelease(
            unitId,
            _authorizationKey(AuthorizationType.EVIDENCE, AUTHDOMAIN_EVIDENCE, authorizedOracle, a.assertionId, unitId)
        );
        emit EvidenceReleased(unitId, a.assertionId);
    }

    /// @notice Tier-0 buyer approval (FROZEN §10.10, sol C5): a distinct authorization type. Only the
    ///         immutable payer authorizes — a direct call or a relayable EIP-712/ERC-1271 signature.
    function approveByBuyer(bytes32 unitId, BuyerApproval calldata approval, bytes calldata signature)
        external
        nonReentrant
        onlyExisting(unitId)
    {
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (u.dispute.opened) revert LiveDispute();
        if (block.timestamp >= u.reclaimAt) revert TooLateForEvidence();
        if (u.requiredTier != 0 || u.requestedTier != 0) revert NotTier0();

        // Bind every field to the frozen record + runtime (chainId/escrow from E5).
        if (
            approval.chainId != block.chainid || approval.escrow != address(this)
                || approval.contractVersion != CONTRACT_VERSION || approval.settlementUnitId != unitId
                || approval.payer != payer || approval.jobIdHash != jobIdHash || approval.termsHash != termsHash
                || approval.g != u.feeSchedule.g || approval.f != u.feeSchedule.f || approval.n != u.feeSchedule.n
                || approval.feeScheduleHash != u.feeScheduleHash || approval.payoutConfigHash != u.payoutConfigHash
                || approval.decision != uint8(AuthorizationType.BUYER_APPROVAL)
        ) revert ApprovalBindingMismatch();
        if (approval.approvalNonce != u.nextApprovalNonce) revert BadNonce();
        if (block.timestamp > approval.expiry) revert ApprovalExpired();

        // Consume the nonce BEFORE the ERC-1271/ECDSA call (sol C5). A failed check reverts, rolling it back.
        u.nextApprovalNonce = approval.approvalNonce + 1;
        bytes32 structHash = _hashBuyerApproval(approval);
        if (msg.sender != payer) {
            if (!_isValidSignature(payer, _typedDataHash(structHash), signature)) revert BadSignature();
        }

        // §2 buyer authorization key (L-01): issuer = payer, rawAuthorizationId = the EIP-712 struct hash.
        _allocateRelease(
            unitId, _authorizationKey(AuthorizationType.BUYER_APPROVAL, AUTHDOMAIN_BUYER, payer, structHash, unitId)
        );
        emit BuyerApproved(unitId, approval.approvalNonce);
    }

    /// @notice Rotate a claim's destination (FROZEN §5.2, H2): the claim owner authorizes a new
    ///         destination; the nonce + destination are written optimistically BEFORE the signature
    ///         call (under the shared guard), so a bad signature reverts the whole rotation.
    function rotateClaimDestination(bytes32 claimId, address newDestination, uint256 expiry, bytes calldata signature)
        external
        nonReentrant
    {
        ClaimRecord storage c = _claims[claimId];
        if (!c.exists) revert ClaimNotFound();
        if (block.timestamp > expiry) revert ApprovalExpired();
        _requireAllowedRecipient(newDestination);

        address owner = c.claimOwner;
        address current = c.claimDestination;
        uint256 nonce = c.destinationNonce;

        // Optimistic write BEFORE the external signature call (§5.2).
        c.destinationNonce = nonce + 1;
        c.claimDestination = newDestination;

        bytes32 structHash = keccak256(
            abi.encode(
                ROTATE_TYPEHASH, claimId, owner, current, newDestination, nonce, expiry, block.chainid, address(this),
                CONTRACT_VERSION
            )
        );
        if (!_isValidSignature(owner, _typedDataHash(structHash), signature)) revert BadSignature();
        emit ClaimDestinationRotated(claimId, current, newDestination, nonce);
    }

    // ── EIP-712 + signature helpers ──────────────────────────────────────────────────────────────
    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this))
        );
    }

    function _typedDataHash(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _hashBuyerApproval(BuyerApproval calldata a) private pure returns (bytes32) {
        // Split the 16-field encode to avoid stack-too-deep. All fields are static, so
        // bytes.concat(abi.encode(...), abi.encode(...)) == abi.encode(all 16) — the EIP-712 hash is identical.
        return keccak256(
            bytes.concat(
                abi.encode(
                    BUYER_APPROVAL_TYPEHASH, a.chainId, a.escrow, a.contractVersion, a.settlementUnitId, a.payer,
                    a.jobIdHash, a.termsHash
                ),
                abi.encode(a.g, a.f, a.n, a.feeScheduleHash, a.payoutConfigHash, a.decision, a.approvalNonce, a.expiry)
            )
        );
    }

    /// @dev Validate `signer`'s signature over `digest`: ERC-1271 for contracts (strict 32-byte magic
    ///      word, rejecting dirty padding), malleability-guarded ECDSA for EOAs.
    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature) private view returns (bool) {
        if (signer.code.length > 0) {
            (bool ok, bytes memory ret) =
                signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
            return ok && ret.length == 32 && abi.decode(ret, (bytes32)) == bytes32(ERC1271_MAGIC);
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 vByte;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            vByte := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > ECDSA_S_MAX) return false;
        if (vByte != 27 && vByte != 28) return false;
        address recovered = ecrecover(digest, vByte, r, s);
        return recovered != address(0) && recovered == signer;
    }
}
