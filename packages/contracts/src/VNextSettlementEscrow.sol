// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IEAS, EASAttestation} from "./interfaces/IEAS.sol";
import {SafeERC20} from "./libraries/SafeERC20.sol";
import {
    VNextSettlementLib,
    FeeSchedule,
    PayoutEntry,
    UnitState,
    ClaimClass,
    AuthorizationType
} from "./libraries/VNextSettlementLib.sol";

/// @notice ERC-1271 smart-account signature validation interface.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}

/// @notice O5/v3 attestation payload (the agreed seam §0.3 field set) decoded from `EASAttestation.data`.
///         The exact byte layout is the M2 oracle↔escrow golden-parity joint-pin — provisional until O5 opens.
struct O5Verdict {
    bytes32 jobIdHash;
    uint256 milestoneIndex;
    bytes32 stepId;
    bytes32 evidenceBundleHash;
    uint8 achievedTier;
    uint8 requestedTier;
    uint8 decision;
    bytes32 verdictHash;
    uint16 feeBps;
    address feeRecipient;
    bytes32 feeScheduleHash;
    bytes32 settlementUnitId;
}

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
    address public immutable EAS;
    address public immutable authorizedOracle;
    address public immutable factory;
    /// @dev O5/v3 schema UID + attestation EIP-712 type hash are JOINT-DEFERRED (E6, deploy-gate §8);
    ///      pinned byte-exact across escrow+oracle+evidence when O5 opens. Zero until then.
    bytes32 public immutable o5SchemaUid;
    bytes32 public immutable o5TypeHash;

    uint256 public constant CONTRACT_VERSION = 1;

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
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant ECDSA_S_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    /// @dev O5 verdict decision encoding for "settle" — joint-pinned with the oracle (M1/M2), provisional.
    uint8 public constant O5_DECISION_SETTLE = 1;
    // §2 authorization-key issuer domains (per authority type, L-01).
    bytes32 private constant AUTHDOMAIN_EVIDENCE = keccak256("PCC:vnext:auth:evidence:v1");
    bytes32 private constant AUTHDOMAIN_DISPUTE = keccak256("PCC:vnext:auth:dispute:v1");
    bytes32 private constant AUTHDOMAIN_RECLAIM = keccak256("PCC:vnext:auth:reclaim:v1");
    bytes32 private constant AUTHDOMAIN_BUYER = keccak256("PCC:vnext:auth:buyer:v1");
    /// @dev O5 verdict payload = 12 static fields = 384 bytes (M-01 length guard).
    uint256 private constant O5_VERDICT_BYTES = 384;

    // ── Per-clone (per-job) state ────────────────────────────────────────────────────────────────
    bool public initialized;
    bool public configurationSealed;
    address public payer; // immutable refund owner/destination once initialized
    address public arbiter;
    bytes32 public jobIdHash; // keccak256(bytes(jobId)) — canonical UTF-8 (§10.12 M1)
    bytes32 public termsHash;
    uint256 public totalLiability; // Σ over units of unit.liability (single-bucket, §3)
    uint256 public totalPayoutLegs;

    bytes32[] internal _unitIds;
    mapping(bytes32 => uint256) internal _unitIndexPlusOne; // existence + index (default 0 = absent)
    mapping(bytes32 => Unit) internal _units;
    mapping(bytes32 => PayoutEntry[]) internal _payouts;

    mapping(bytes32 => ClaimRecord) internal _claims;
    mapping(bytes32 => bool) internal _authorizationUsed;
    mapping(bytes32 => bool) internal _easUidUsed;

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
        uint256 reclaimAt;
        uint256 disputeWindow;
        uint256 liability; // the unit's sole current liability bucket (§3)
        uint256 remainingClaimCount; // set at allocation; SETTLED_* only when 0 (§7)
        uint256 nextApprovalNonce; // buyer-approval single-use nonce (§10.10)
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
        PayoutEntry[] payouts; // Σ amount == n; each nonzero; allowed recipients only
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
    event Initialized(address indexed payer, address indexed arbiter, bytes32 jobIdHash);
    event UnitFunded(bytes32 indexed unitId, uint256 g, uint256 f, uint256 n);
    event Funded(uint256 unitCount, uint256 totalGross, uint256 totalPayoutLegs);
    event LegDischarged(bytes32 indexed unitId, uint256 legIndex, ClaimClass class, address recipient, uint256 amount);
    event ClaimCreated(
        bytes32 indexed claimId, bytes32 indexed unitId, uint256 legIndex, ClaimClass class, address recipient, uint256 amount
    );
    event ClaimDischarged(bytes32 indexed claimId, bytes32 indexed unitId, address destination, uint256 amount);
    event ReleaseAllocated(bytes32 indexed unitId, uint256 claimCount);
    event RefundAllocated(bytes32 indexed unitId, uint256 claimCount);
    event DisputeOpened(bytes32 indexed unitId, uint256 nonce, uint256 effectiveDisputeExpiry);
    event DisputeResolved(bytes32 indexed unitId, bool operatorWins);
    event EvidenceReleased(bytes32 indexed unitId, bytes32 indexed easUid);
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
    error AttestationNotFound();
    error WrongSchema();
    error WrongAttester();
    error WrongRecipient();
    error Revoked();
    error Expired();
    error IdentityMismatch();
    error NotSettle();
    error Tier0NotEvidence();
    error TierNotMet();
    error RequestedTierMismatch();
    error FeeHashMismatch();
    error NotTier0();
    error ApprovalBindingMismatch();
    error BadNonce();
    error ApprovalExpired();
    error BadSignature();
    error MalformedO5Data();

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

    /// @param usdc canonical settlement asset (Base USDC). @param eas EAS registry.
    /// @param oracle the authorized O5 attester. @param schemaUid / typeHash O5 pins (0 until O5 opens).
    constructor(address usdc, address eas, address oracle, bytes32 schemaUid, bytes32 typeHash) {
        USDC = usdc;
        EAS = eas;
        authorizedOracle = oracle;
        o5SchemaUid = schemaUid;
        o5TypeHash = typeHash;
        factory = msg.sender;
        initialized = true; // lock the implementation; only fresh clones (initialized=false) can init
    }

    /// @notice One-time clone initialization by the factory (atomic clone+init upstream).
    function initialize(address _payer, address _arbiter, bytes32 _jobIdHash, bytes32 _termsHash)
        external
    {
        if (msg.sender != factory) revert OnlyFactory();
        if (initialized) revert AlreadyInitialized();
        if (_payer == address(0)) revert ForbiddenRecipient(); // payer is the immutable refund owner (High 9)
        initialized = true;
        _status = 1;
        payer = _payer;
        arbiter = _arbiter;
        jobIdHash = _jobIdHash;
        termsHash = _termsHash;
        emit Initialized(_payer, _arbiter, _jobIdHash);
    }

    // ── Funding + atomic freeze (E2/E8/C4) ─────────────────────────────────────────────────────────

    /// @notice Configure + atomically freeze all settlement units and reserve exactly ΣG. Callable
    ///         once by the payer while unsealed. Every domain field is derived on-chain (E5); every
    ///         unit is validated against E3 invariants; the exact aggregate gross is pulled and the
    ///         balance delta is checked (rejects fee-on-transfer / under-receipt, C4).
    function fund(UnitConfig[] calldata configs) external nonReentrant {
        if (!initialized) revert NotInitialized();
        if (msg.sender != payer) revert OnlyPayer();
        if (configurationSealed) revert AlreadySealed();
        // M-01 / §6: bound the COMPLETE fund() calldata (incl. 4-byte selector). Redundant with the leg
        // bounds below but pins the published input envelope. Max-config fit is asserted in the 2b tests.
        if (msg.data.length > VNextSettlementLib.MAX_CONFIG_BYTES) revert ConfigTooLarge();
        uint256 nConfigs = configs.length;
        if (nConfigs == 0 || nConfigs > VNextSettlementLib.MAX_SETTLEMENT_UNITS) revert BadUnitCount();
        configurationSealed = true; // effects before the external token pull (nonReentrant-guarded)

        uint256 chainId = block.chainid;
        address self = address(this);
        uint256 expectedGross;
        uint256 legTotal;

        for (uint256 i; i < nConfigs; ++i) {
            UnitConfig calldata c = configs[i];

            bytes32 unitId =
                VNextSettlementLib.computeSettlementUnitId(chainId, self, jobIdHash, c.milestoneIndex, c.stepId);
            if (_unitIndexPlusOne[unitId] != 0) revert DuplicateUnit();

            FeeSchedule memory fs = FeeSchedule({
                domainVersion: VNextSettlementLib.DOMAIN_VERSION_V1,
                chainId: chainId,
                escrow: self,
                settlementUnitId: unitId,
                feeBasis: VNextSettlementLib.FEE_BASIS_GROSS,
                g: c.g,
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

            if (c.reclaimAt <= block.timestamp) revert BadReclaim();

            Unit storage u = _units[unitId];
            u.feeSchedule = fs;
            u.feeScheduleHash = VNextSettlementLib.computeFeeScheduleHash(fs);
            u.payoutConfigHash = VNextSettlementLib.computePayoutConfigHash(unitId, _payouts[unitId]);
            u.milestoneIndex = c.milestoneIndex;
            u.stepId = c.stepId;
            u.requiredTier = c.requiredTier;
            u.requestedTier = c.requestedTier;
            u.state = UnitState.FUNDED_ACTIVE;
            u.reclaimAt = c.reclaimAt;
            u.disputeWindow = c.disputeWindow;
            u.liability = c.g; // FUNDED_ACTIVE liability == G (§3)

            _unitIds.push(unitId);
            _unitIndexPlusOne[unitId] = _unitIds.length;
            expectedGross += c.g;
            emit UnitFunded(unitId, c.g, c.f, c.n);
        }

        if (legTotal > VNextSettlementLib.MAX_TOTAL_LEGS_PER_JOB) revert TooManyLegs();
        totalPayoutLegs = legTotal;
        totalLiability = expectedGross;

        // Pull exactly ΣG and verify the received delta (C4 — rejects fee-on-transfer / under-receipt).
        uint256 beforeBal = _safeBalanceOf(self);
        IERC20(USDC).safeTransferFrom(payer, self, expectedGross);
        uint256 afterBal = _safeBalanceOf(self);
        if (afterBal < beforeBal || afterBal - beforeBal != expectedGross) revert FundingDeltaMismatch();

        emit Funded(nConfigs, expectedGross, legTotal);
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
            keccak256(abi.encode("RECLAIM", unitId, u.reclaimAt)),
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

    /// @notice Evidence release (FROZEN §9, sol H8/H3): verify the O5/v3 EAS attestation and, on a
    ///         settle verdict for a Tier>=1 unit with matching identity + fee commitment, release.
    ///         The O5 `data` byte layout is the M2 oracle-parity joint-pin (provisional until O5 opens).
    function releaseFromEvidence(bytes32 unitId, bytes32 easUid) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp >= u.reclaimAt) revert TooLateForEvidence();
        if (u.dispute.opened) revert LiveDispute(); // H7: any opened dispute blocks evidence release

        // EAS-level checks (attester / schema / recipient / revocation / expiration — allocation-time rule §7).
        EASAttestation memory a = IEAS(EAS).getAttestation(easUid);
        if (a.uid == bytes32(0)) revert AttestationNotFound();
        if (a.schema != o5SchemaUid) revert WrongSchema();
        if (a.attester != authorizedOracle) revert WrongAttester();
        if (a.recipient != address(this)) revert WrongRecipient();
        if (a.revocationTime != 0) revert Revoked();
        if (a.expirationTime != 0 && a.expirationTime <= block.timestamp) revert Expired();
        if (_easUidUsed[easUid]) revert AuthorizationUsed();
        _easUidUsed[easUid] = true;

        // M-01: the agreed O5 field set is 12 static fields = 384 bytes; reject trailing bytes. The exact
        // byte-order + final O5 schema UID/type hash are the M2 oracle-parity PRE-DEPLOY pin (§8); o5SchemaUid/
        // o5TypeHash are reserved immutables enforced there, not yet standalone security checks.
        if (a.data.length != O5_VERDICT_BYTES) revert MalformedO5Data();
        O5Verdict memory v = abi.decode(a.data, (O5Verdict));

        // H3: direct field-by-field identity vs the frozen record + recompute the unit id from frozen fields.
        if (v.settlementUnitId != unitId || v.jobIdHash != jobIdHash) revert IdentityMismatch();
        if (v.milestoneIndex != u.milestoneIndex || v.stepId != u.stepId) revert IdentityMismatch();
        bytes32 recomputed = VNextSettlementLib.computeSettlementUnitId(
            u.feeSchedule.chainId, address(this), jobIdHash, u.milestoneIndex, u.stepId
        );
        if (recomputed != unitId) revert IdentityMismatch();

        // Evidence predicate (§9): settle-only, Tier>=1, tier fulfillment + request identity, fee commitment.
        if (v.decision != O5_DECISION_SETTLE) revert NotSettle();
        if (u.requiredTier < 1) revert Tier0NotEvidence();
        if (v.achievedTier < u.requiredTier) revert TierNotMet();
        if (v.requestedTier != u.requiredTier) revert RequestedTierMismatch();
        if (v.feeScheduleHash != u.feeScheduleHash) revert FeeHashMismatch();

        _allocateRelease(
            unitId, _authorizationKey(AuthorizationType.EVIDENCE, AUTHDOMAIN_EVIDENCE, authorizedOracle, easUid, unitId)
        );
        emit EvidenceReleased(unitId, easUid);
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
