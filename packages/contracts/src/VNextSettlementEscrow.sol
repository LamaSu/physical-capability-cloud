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
import {
    O5Assertion,
    O5AdjudicationRecord,
    O5_DECISION_SETTLE,
    O5_ADJ_ROLE_APPEAL,
    O5_ADJ_ROLE_EMERGENCY,
    O5_ADJ_UPHOLD,
    O5_ADJ_OVERTURN
} from "./O5Types.sol";
import {IOracleAttester} from "./interfaces/IOracleAttester.sol";

/// @notice ERC-1271 smart-account signature validation interface.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}

/// @notice The slice of the deploying factory the clone calls at funding. Declared locally rather than
///         imported so the escrow never depends on the factory (which imports the escrow).
/// @dev    Wave 4a: this ONE call now both verifies the bilateral acceptance and consumes the policy
///         nonce. It is the same call the clone already made on the funding path before Wave 4a — the
///         verification moved INTO it rather than alongside it, so the funding path gained no new call,
///         no new dependency and no new liveness surface. See
///         {VNextSettlementEscrowFactory.acceptPolicy} for why the trust boundary is unchanged.
interface IVNextEscrowFactory {
    function acceptPolicy(
        PolicyIdentity calldata p,
        bytes32 unitsRoot,
        address funder,
        uint256 expiry,
        bool allowSelfAdjudication,
        bytes calldata payerSignature,
        bytes calldata operatorSignature
    ) external returns (bytes32 jobPolicyHash);

    function verifyCloneSignature(address signer, bytes32 structHash, bytes calldata signature)
        external
        view
        returns (bool);
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
    /// @notice H-01 §2.5/§2.6/§8.3 C-5 — the PRECOMMITTED ESCALATION COHORT: the backup verdict quorum,
    ///         the appeal quorum, and the Model-B emergency cohort, all in one independently-deployed
    ///         attester instance (its signer set, threshold and revoker are immutable per instance, so
    ///         "independent of the primary" is a deployment fact, not a promise).
    /// @dev    WHY an IMPLEMENTATION IMMUTABLE and not per-job state: `JobPolicyHash` already binds
    ///         `implementation` (see `_hashJobPolicy`), so both parties signing the policy ARE signing this
    ///         address — "precommitted, bilaterally accepted, cannot be installed after funding" comes out
    ///         for free, with zero clone storage, zero extra policy fields, and zero factory churn. It is
    ///         the same trust shape as `authorizedOracle`, which the money path already STATICCALLs.
    ///         Wave 3 puts NO signature verification in this contract: every quorum it depends on is
    ///         verified inside an attester and read back as an immutable record.
    address public immutable escalationAttester;
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
    uint256 public constant POLICY_VERSION = VNextSettlementLib.POLICY_VERSION_V1;

    /// @dev M-01 supported assurance-tier ceiling (tiers 0..3). Funding bounds `requiredTier` to this range;
    ///      the evidence path bounds the ORACLE-asserted `achievedTier` to it too, so a verdict claiming an
    ///      unsupported tier can neither settle nor be permanently mis-recorded.
    uint8 internal constant MAX_TIER = 3;

    // ── EIP-712 + auth constants (2b-ii) ─────────────────────────────────────────────────────────
    // The EIP-712 domain pins live in {VNextSettlementLib} and are consumed by the FACTORY, which
    // rebuilds this escrow's domain (verifyingContract == this clone) for every signature check.
    bytes32 private constant BUYER_APPROVAL_TYPEHASH = keccak256(
        "BuyerApproval(uint256 chainId,address escrow,uint256 contractVersion,bytes32 settlementUnitId,address payer,bytes32 jobIdHash,bytes32 termsHash,uint256 g,uint256 f,uint256 n,bytes32 feeScheduleHash,bytes32 payoutConfigHash,uint8 decision,uint256 approvalNonce,uint256 expiry)"
    );
    bytes32 private constant ROTATE_TYPEHASH = keccak256(
        "RotateDestination(bytes32 claimId,address claimOwner,address currentDestination,address newDestination,uint256 destinationNonce,uint256 expiry,uint256 chainId,address escrow,uint256 contractVersion)"
    );
    // §2 authorization-key issuer domains (per authority type, L-01).
    bytes32 private constant AUTHDOMAIN_EVIDENCE = keccak256("PCC:vnext:auth:evidence:v1");
    bytes32 private constant AUTHDOMAIN_DISPUTE = keccak256("PCC:vnext:auth:dispute:v1");
    bytes32 private constant AUTHDOMAIN_RECLAIM = keccak256("PCC:vnext:auth:reclaim:v1");
    bytes32 private constant AUTHDOMAIN_BUYER = keccak256("PCC:vnext:auth:buyer:v1");

    // ── Per-clone (per-job) state ────────────────────────────────────────────────────────────────
    bool public initialized;
    bool public configurationSealed;
    address public payer; // immutable refund owner/destination once initialized
    /// @notice H-01 §2.1 — the operator's MONEY-PLANE identity, frozen at initialization. It authenticates
    ///         acceptance of the funded policy (EIP-712 ECDSA, or ERC-1271 when the operator is a smart
    ///         account) and is deliberately distinct from the off-chain Ed25519 device/evidence plane and
    ///         from every payout recipient of the JOB distribution. Before this existed the escrow stored
    ///         only where to pay, never who had agreed to be paid that way.
    /// @dev    KEY-CUSTODY NOTE (Wave 3c, L-4 — stated because an earlier version of this comment claimed
    ///         "an AUTHORITY, never a destination", and that was not true of the code): it is an authority
    ///         on the JOB distribution — `_allocateRelease` pays only the frozen payout legs and the fee
    ///         recipient, never this address — but it IS the destination of ONE bond-family leg, the
    ///         §2.4 delay compensation (`_forfeitOrReturnBond` → `ClaimClass.DELAY_COMP`). So this key must
    ///         be able to RECEIVE and move USDC. It is held to the payout-recipient exclusion set in
    ///         `initialize` for exactly that reason. Paying delay-comp to a separate payout recipient
    ///         instead would be a distribution change, not a comment change, and is deliberately NOT made
    ///         here: it would alter who is compensated on a failed challenge.
    /// @dev    §2.8 (Wave 3c): this address is ALSO the evidence committer — see `submitEvidence`.
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
    /// @notice §8.3 H-3 liability bucket 1 of 4 — JOB collateral: Σ over units of unit.liability.
    uint256 public totalLiability;
    /// @notice §8.3 H-3 bucket 2 — CHALLENGE BOND: posted by a challenger and owed BACK to that
    ///         challenger until it is either returned (successful challenge) or forfeited into the
    ///         delay-comp + burnable buckets (failed challenge). Bonds are NEW USDC, never part of G/F/N.
    uint256 public bondLiability;
    /// @notice §8.3 H-3 bucket 3 — DELAY COMPENSATION owed to the operator out of a forfeited bond.
    uint256 public compLiability;
    /// @notice §8.3 H-3 bucket 4 — BURNABLE remainder of a forfeited bond, owed to the sink.
    /// @dev    The fifth named bucket in the frozen list, APPEAL FEE, is deliberately NOT carried here:
    ///         §8.3 C-1 resolved v1's appeal cost to an owner-funded adjudication RESERVE that lives
    ///         outside the per-job escrow, and the challenger's bond covers only anti-spam + operator
    ///         delay-comp. Carrying a permanently-zero slot would be accounting theatre. The invariant
    ///         this contract actually enforces is `balance >= totalLiability + bondLiability +
    ///         compLiability + burnLiability`, checked by `_requireSolvent()` before every money move.
    uint256 public burnLiability;
    uint256 public totalPayoutLegs;
    uint64 public oracleAuthEpoch; // rev-3 §A.2: the funded cohort id, pinned from the attester at fund()
    /// @dev The escalation cohort's id, pinned at funding for the same reason `oracleAuthEpoch` is: a
    ///      backup/appeal record echoing a different cohort id is not the cohort this job was funded
    ///      against. Packs into the same slot as `oracleAuthEpoch`.
    uint64 public escalationAuthEpoch;

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
        // ── H-2 bounded timestamp, written via a CHECKED downcast at funding ──────────────────────
        // Bounded at funding (reclaimAt <= now + MAX_RECLAIM_DELAY), so uint64 is provably sufficient;
        // `VNextSettlementLib.toUint64` reverts rather than truncating if that ever stops being true.
        // Widened back to uint256 by the external getter, so the published read surface is unchanged.
        // Every §8.2 C-3 deadline is DERIVED from this one anchor plus the frozen protocol windows —
        // {primaryVerdictDue, assertionCutoff, challengeDeadline, appealDeadline, backupVerdictDeadline}
        // are therefore all frozen at funding and none of them is stored, settable, or extendable.
        uint64 reclaimAt;
        // ──────────────────────────────────────────────────────────────────────────────────────────
        uint256 liability; // the unit's sole current JOB liability bucket (§3)
        uint256 remainingClaimCount; // set at allocation; SETTLED_* only when 0 (§7). JOB legs only.
        uint256 nextApprovalNonce; // buyer-approval single-use nonce (§10.10)
        // ── one packed slot: 2 + 1 + 8 = 11 bytes ─────────────────────────────────────────────────
        uint16 compositionSchemaVersion; // rev-3 §C2: frozen at funding (0 = non-composed)
        // Wave 3c: the per-unit `evidenceCommitter` slot is GONE with the payer-selectable authority. The
        // committer is the `operator` immutably-per-clone (written by `initialize`), so there is nothing
        // left to freeze here and nothing a funding-time configuration could disagree with.
        bool evidenceCommitted; // §B: separate from the hash so a zero/default hash NEVER satisfies release
        /// @dev §8.2 C-3 — `block.timestamp` AT `acceptAssertion()`, NOT the attester's mint time. This is
        ///      the whole point of the two-phase accept/finalize split: a stale assertion submitted late
        ///      starts a FULL challenge window from the moment the escrow accepted it, so it can never
        ///      have already eaten the window it is supposed to open.
        uint64 assertedAt;
        // ──────────────────────────────────────────────────────────────────────────────────────────
        bytes32 compositionRoot; // rev-3 §C2/§C3: frozen root, oracle echoes it → equality-checked at release
        bytes32 evidenceBundleHash; // §B: the domain-separated commitment, oracle echoes it → checked at release
        /// @dev The EXACT assertion this unit accepted. Every escalation verdict must name it
        ///      (`O5AdjudicationRecord.reviewedAssertionId`), so an appeal decided over one assertion can
        ///      never be applied to another. Zero until acceptance.
        bytes32 acceptedAssertionId;
        // ── one packed slot: 20 + 8 + 1 = 29 bytes ────────────────────────────────────────────────
        address challenger; // §2.2: who posted the bond (the payer); zero when unchallenged
        uint64 challengedAt; // the appeal window's anchor
        /// @dev §8.2 C-4 — set ONE-WAY by `invokeBackup`. It is simultaneously "the primary lane is
        ///      closed" and "the escalation cohort is this unit's settlement authority": once true the
        ///      unit's state can never return to FUNDED_ACTIVE, so no primary assertion is reachable
        ///      again and there is exactly one backup outcome. That is verifier-shopping closed by the
        ///      state machine rather than by a separate flag that could drift out of sync with it.
        bool backupLane;
        // ──────────────────────────────────────────────────────────────────────────────────────────
        uint256 bond; // the challenge bond currently held for this unit (0 when none)
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
        // NOTE: `disputeWindow` was REMOVED here in Wave 3 together with the free-floating dispute path it
        // parameterized. It is not left as an ignored field: `UnitConfig[]` is hashed into `prePolicyRoot`
        // and therefore into this clone's own address, so a term that no longer does anything would be a
        // term both parties sign and neither can rely on. The post-verdict windows are protocol constants
        // bound through `implementation` (see VNextSettlementLib).
        uint256 reclaimAt; // absolute timestamp; must be in the future
        uint16 compositionSchemaVersion; // rev-3 §C2 (0 = non-composed)
        bytes32 compositionRoot; // rev-3 §C2/§C3 (echoed into O5, equality-checked at release)
        // NOTE: `evidenceCommitter` was REMOVED here in Wave 3c, implementing brief §2.8 ("remove
        // `evidenceCommitter` as a payer-selected authority — the operator signs the evidence manifest").
        // It is not left as an ignored field for the same reason `disputeWindow` was not: `UnitConfig[]` is
        // hashed into `prePolicyRoot` and therefore into this clone's own address, so a term that no longer
        // does anything would be a term both parties sign and neither can rely on. The committer is now the
        // `operator` by construction — see `submitEvidence`.
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
    // ── H-01 §8.1 post-verdict state machine ─────────────────────────────────────────────────────
    /// @param assertedAt the ESCROW's clock at acceptance (§8.2 C-3), not the attester's mint time.
    event AssertionAccepted(
        bytes32 indexed unitId, bytes32 indexed assertionId, address indexed attester, uint64 assertedAt, bool backupLane
    );
    event Challenged(bytes32 indexed unitId, address indexed challenger, uint256 bond, uint64 challengedAt);
    event BackupInvoked(bytes32 indexed unitId, uint64 at);
    event EscalationResolved(bytes32 indexed unitId, bytes32 indexed adjudicationId, uint8 role, bool upheld);
    /// @param reason 0 = uncontested challenge window closed, 1 = appeal silence, 2 = backup timeout,
    ///               3 = emergency-review silence (§8.3 C-5 Model B).
    event Finalized(bytes32 indexed unitId, bool released, uint8 reason);
    event BondForfeited(bytes32 indexed unitId, uint256 delayCompensation, uint256 burned);
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
    /// @notice H-01: the operator and the payer must be distinct money-plane identities. Address inequality
    ///         is not independence, but it is a necessary condition for bilateral acceptance to mean anything.
    error PartyCollision();
    /// @notice The supplied configs do not hash to the `prePolicyRoot` bound into this clone's address.
    error PolicyRootMismatch();
    // The next three are RAISED BY THE FACTORY since Wave 4a (the acceptance verification moved there) and
    // bubble out of `fund()` unchanged — a custom error's selector is `keccak256("Name()")[0:4]` and
    // carries no contract identity. They are declared here because they are part of `fund()`'s revert
    // surface and every ABI decoder pointed at this contract must be able to name them. Costs no runtime
    // bytecode: a declared-but-unraised error emits nothing.
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
    error TooEarlyToReclaim();
    error ClaimNotFound();
    // ── H-01 §8.1 post-verdict state machine ─────────────────────────────────────────────────────
    /// @notice Only the money-plane operator may escalate to the backup cohort (§2.6: the payer must NOT
    ///         control this — a payer-invocable escalation is the withholding attack with extra steps) and,
    ///         since Wave 3c (§2.8), only the operator may commit the evidence package. One error for both
    ///         because it is one authority: the party whose payment depends on the call.
    error OnlyOperator();
    /// @notice §8.2 C-3: `now >= reclaimAt - CHALLENGE_WINDOW - APPEAL_WINDOW`. A verdict that arrives too
    ///         late for its own challenge + appeal windows to fit before the payer's deadline is refused,
    ///         rather than silently extending the payer's capital lock past `reclaimAt`.
    error AssertionCutoffPassed();
    /// @notice §2.6: the primary verdict is not yet overdue, so the backup lane is not open.
    error PrimaryVerdictNotDue();
    /// @notice The challenge window on this assertion has closed (finalization is now the only move).
    error ChallengeWindowClosed();
    /// @notice A window that must elapse before this call is still open (challenge / appeal / backup /
    ///         emergency review). Deliberately one error: the caller can read the state + deadlines view.
    error WindowStillOpen();
    /// @notice The unit is not in a state this escalation role can decide.
    error BadEscalationRole();
    /// @notice §8.3 C-5: the asserting cohort has been disabled, so ordinary finalization is PAUSED and
    ///         only the emergency cohort (or the emergency deadline) may resolve this unit.
    error EmergencyPaused();
    /// @notice The unit is not under an emergency, so the emergency role has nothing to decide.
    error NoEmergency();
    /// @notice A unit may carry at most one live challenge.
    error AlreadyChallenged();
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
    // NOTE: `OnlyEvidenceCommitter` is REMOVED (Wave 3c / §2.8). `submitEvidence` is operator-only now, so
    // the caller guard raises `OnlyOperator` — the same error `invokeBackup` raises, because it is now the
    // same authority. Keeping an error that names a configurable committer would keep advertising one.
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
    /// @param oracle the authorized O5 attester — the SOLE source of PRIMARY settlement authorization (P0-6).
    /// @param escalation the precommitted escalation cohort attester (backup verdicts + appeal + Model-B
    ///        emergency). MUST be a different deployment from `oracle`: a single cohort acting as both the
    ///        primary authority and its own appeal/emergency reviewer is not an appeal, it is a rubber
    ///        stamp, and it would make §2.5's route-diversity requirement unsatisfiable at the type level.
    /// @param schemaUid / typeHash O5 publication pins (0 until O5 opens); metadata, not runtime checks.
    constructor(address usdc, address oracle, address escalation, bytes32 schemaUid, bytes32 typeHash) {
        USDC = usdc;
        authorizedOracle = oracle;
        if (escalation == address(0) || escalation == oracle) revert ForbiddenRecipient();
        escalationAttester = escalation;
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
        // Wave 3: the ESCALATION cohort must also be live at funding and is pinned the same way. Funding a
        // job whose only recourse path is already dead would hand the payer a guaranteed refund on any
        // withheld primary verdict — i.e. the H-01 free option, restored through the escalation lane.
        if (!IOracleAttester(escalationAttester).enabled()) revert InvalidOrDisabledCohort();
        escalationAuthEpoch = IOracleAttester(escalationAttester).cohortId();
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
            // H-01 anti-costless-veto, Wave 3 form. The same-block "open a dispute, then immediately
            // refund on its expiry" sequence is now impossible for a stronger reason than a minimum
            // window: THAT PATH NO LONGER EXISTS. A payer's only way to contest an accepted SETTLE is a
            // bonded, assertion-specific challenge whose failure mode is RELEASE, and the floor above
            // (`MIN_RECLAIM_DELAY == CHALLENGE + APPEAL + BACKUP + 1 day`) is what guarantees every
            // window in the §8.1 machine has room to run before the payer's own deadline.

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
            // §B/§2.8: nothing to freeze for the evidence committer — it IS `operator`, which `initialize`
            // already held to the recipient exclusion set and which no funding input can move.
            u.state = UnitState.FUNDED_ACTIVE;
            // H-2 checked downcast into the packed slot (the value was bounded immediately above).
            u.reclaimAt = VNextSettlementLib.toUint64(c.reclaimAt);
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
        _pullExact(payer, expectedGross);

        emit Funded(nConfigs, expectedGross, legTotal);
    }

    // ── H-01 bilateral acceptance (§2.1 + §8.2 H-1) ───────────────────────────────────────────────

    /// @dev The single place a funded escrow proves BOTH parties authenticated the complete configuration.
    ///      Three steps, in this order:
    ///        1. the escrow's own ADDRESS commits to the terms — `prePolicyRoot` is in the CREATE2 salt
    ///           preimage, so re-deriving it from the supplied configs proves this clone is being funded
    ///           with exactly the terms the address was predicted from, before any signature is read.
    ///           This stays HERE and only here: it is what makes the address commit to the exact funded
    ///           terms, and the factory never sees the configs (they are the calldata this bound would
    ///           otherwise have to carry twice);
    ///        2. the units root is derived from the ids this clone just froze;
    ///        3. ONE call to the factory — which recomputes the CREATE2 address from the identity passed
    ///           back to it and requires it to equal `msg.sender` (the self-consistency proof: a clone can
    ///           only fund itself if its stored identity really is the one its own address commits to),
    ///           then rejects implicit self-adjudication, rejects an expired acceptance, consumes the
    ///           policy generation (retiring it and every older one, failing closed if either party
    ///           revoked), and validates BOTH acceptance signatures against ONE canonical `JobPolicyHash`.
    ///
    ///      WAVE 4a: steps 2-5 of the pre-Wave-4a sequence are now the body of that single call, in the
    ///      same order, over the same digest (the EIP-712 `verifyingContract` is still THIS clone). Nothing
    ///      became optional: `fund()` reaches a funded state only through this call and the call reverts
    ///      unless every one of those checks passes, so a funded escrow still cannot exist without a
    ///      genuine, verified bilateral acceptance. The reverts bubble through unchanged — a custom error's
    ///      selector carries no contract identity — which is why the declarations above are retained here.
    function _acceptPolicy(UnitConfig[] calldata configs, PolicyAcceptance calldata acceptance) private {
        if (keccak256(abi.encode(configs)) != _prePolicyRoot) revert PolicyRootMismatch();

        bytes32 root = _unitsRoot();
        bytes32 ph = IVNextEscrowFactory(factory).acceptPolicy(
            PolicyIdentity({
                payer: payer,
                operator: operator,
                arbiter: arbiter,
                jobIdHash: jobIdHash,
                termsHash: termsHash,
                policyNonce: _policyNonce,
                prePolicyRoot: _prePolicyRoot
            }),
            root,
            msg.sender, // the payer leg is implicit ONLY for a direct payer-sent tx (see `OnlyPayer` above)
            acceptance.expiry,
            acceptance.allowSelfAdjudication,
            acceptance.payerSignature,
            acceptance.operatorSignature
        );

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

    // NOTE: `_hashJobPolicy` moved to {VNextSettlementEscrowFactory} in Wave 4a together with the
    // acceptance verification. The type string it hashes is pinned once in {VNextSettlementLib}, and the
    // digest still uses THIS clone as the EIP-712 `verifyingContract`, so the hash is byte-identical.

    // ── Recipient exclusion set (High 9) ──────────────────────────────────────────────────────────
    function _requireAllowedRecipient(address r) internal view {
        if (r == address(0) || r == address(this) || r == USDC || r == factory) revert ForbiddenRecipient();
    }

    /// @dev C4 exact-receipt pull, shared by `fund` (ΣG) and `challenge` (the bond). A token that takes a
    ///      fee on transfer, or credits less than it was asked for, fails here instead of leaving the
    ///      escrow quietly under-collateralized against a liability bucket it just increased.
    function _pullExact(address from, uint256 amount) private {
        uint256 beforeBal = _safeBalanceOf(address(this));
        IERC20(USDC).safeTransferFrom(from, address(this), amount);
        uint256 afterBal = _safeBalanceOf(address(this));
        if (afterBal < beforeBal || afterBal - beforeBal != amount) revert FundingDeltaMismatch();
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

    // NOTE: `evidenceCommitterOf(bytes32)` is REMOVED (Wave 3c / brief §2.8). The committer is no longer a
    // per-unit configurable authority, so a per-unit getter for it would publish a degree of freedom that
    // does not exist. The successor read surface is the existing `operator()` — one value for the whole
    // clone, which is exactly what the authority now is.

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

    /// @notice Commit the evidence package this unit will be settled against (§B). One shot, BY THE
    ///         OPERATOR only, while the unit is still live and undisputed.
    /// @dev    §2.8 (Wave 3c) — the committer is BOUND TO `operator`, not selected at funding. The brief
    ///         required this authority to be removed from the payer's side, and removal (not disclosure) is
    ///         the fix: while `evidenceCommitter` was a `UnitConfig` field, `payer` was a legal value, and a
    ///         payer-committer that simply never commits is a costless, terminal refund lever — both
    ///         settlement lanes require `evidenceCommitted` (here and, on the attester side, through
    ///         `evidenceBundleHashOf`), so a withheld commitment strands release while leaving the deadline
    ///         refund untouched. That is H-01's outcome (operator performs, payer refunds unilaterally)
    ///         reached through the §B commit gate instead of the retired `openDispute`. Binding the
    ///         committer to the party whose payment depends on it removes the lever entirely: the only
    ///         address that can strand the release path is the one that loses by doing so.
    /// @dev    The stored value is the DOMAIN-SEPARATED commitment, not `packageDigest` itself, so the same
    ///         package hash committed for another chain/escrow/unit/schema-version/format can never satisfy
    ///         this unit's release (`VNextSettlementLib.computeEvidenceCommitment`). One-shot + the release
    ///         check together mean the committer selects the package BEFORE any verdict exists, and can
    ///         never re-point a funded unit at a second package to shop for a payable verdict.
    ///         This function is on the RELEASE path only: refund/reclaim never reads any of these fields, so
    ///         a missing, late, or wrong commit simply fails closed to the payer's refund at `reclaimAt`.
    function submitEvidence(bytes32 unitId, bytes32 packageDigest) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        if (msg.sender != operator) revert OnlyOperator();
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp >= u.reclaimAt) revert TooLateForEvidence();
        // The retired `LiveDispute` guard here is SUBSUMED, not dropped: a dispute used to be a flag on a
        // still-FUNDED_ACTIVE unit, so it needed its own check. Wave 3's equivalents (PRIMARY_ASSERTED /
        // CHALLENGED / BACKUP_*) are STATES, and the `FUNDED_ACTIVE` requirement one line up already
        // excludes every one of them.
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

    /// @notice H-01 §8.1 — the complete post-verdict record for a unit, in ONE read (collapsed by design:
    ///         the frozen size-reclamation order prefers collapsing read surfaces, and a verifier needs
    ///         these fields together or not at all).
    /// @return state_ the §8.1 state.
    /// @return assertedAt_ the ESCROW's acceptance timestamp (§8.2 C-3), 0 until accepted.
    /// @return acceptedAssertionId_ the exact assertion under this unit's post-verdict machine.
    /// @return backupLane_ true once the primary lane was closed one-way (§8.2 C-4).
    /// @return challenger_ / challengedAt_ / bond_ the live bonded challenge, if any.
    function settlement(bytes32 unitId)
        external
        view
        onlyExisting(unitId)
        returns (
            UnitState state_,
            uint64 assertedAt_,
            bytes32 acceptedAssertionId_,
            bool backupLane_,
            address challenger_,
            uint64 challengedAt_,
            uint256 bond_
        )
    {
        Unit storage u = _units[unitId];
        return (u.state, u.assertedAt, u.acceptedAssertionId, u.backupLane, u.challenger, u.challengedAt, u.bond);
    }

    // NOTE: there is deliberately NO `deadlinesOf` / `liabilityBuckets` convenience view. Every deadline
    // is `reclaimAt` (published by `reclaimAtOf`) or `assertedAt`/`challengedAt` (published by
    // `settlement`) plus a compile-time window from {VNextSettlementLib}, and every bucket already has a
    // public accessor. On a contract at its EIP-170 ceiling, a derived view is bytecode spent on
    // arithmetic any caller can do for free.

    /// @notice §8.2 H-2 — the exact bond `challenge()` will pull for this unit. Deterministic.
    function requiredBondOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        return VNextSettlementLib.challengeBond(_units[unitId].feeSchedule.g);
    }

    /// @notice The assertion id this unit accepted, or zero. Read by the escalation attester's anti-brick
    ///         pre-check so an adjudication naming the wrong assertion can never burn the unit's slot.
    function acceptedAssertionIdOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].acceptedAssertionId;
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

    /// @dev Global solvency gate (C1 / DI-3): escrow USDC must cover ALL outstanding liabilities across
    ///      EVERY §8.3 H-3 bucket — job collateral AND challenge-bond collateral. This one line is what
    ///      makes "a job release/refund must never consume bond collateral" structural: a release may only
    ///      proceed while the balance still covers the bond buckets on top of the job bucket, so paying G
    ///      out can never dip into a challenger's stake, an operator's unpaid delay-comp, or a pending burn.
    function _requireSolvent() private view {
        if (_safeBalanceOf(address(this)) < totalLiability + bondLiability + compLiability + burnLiability) {
            revert Insolvent();
        }
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
    ///      Wave 3: ONE settler for both liability families. `class <= REFUND` is a JOB leg and moves the
    ///      job buckets; anything above is a BOND-family leg (§8.3 H-3) and moves only its own bucket, so
    ///      a bond leg can never touch `u.liability` / `totalLiability` and a job leg can never touch a
    ///      bond bucket. Only JOB legs count toward `remainingClaimCount` (the return value), which keeps
    ///      SETTLED_* meaning exactly what §7 froze it to mean.
    function _settleLeg(
        bytes32 unitId,
        Unit storage u,
        uint256 legIndex,
        ClaimClass class,
        address recipient,
        uint256 amount
    ) private returns (uint256 claimCreated) {
        if (amount == 0) return 0;
        bool job = class <= ClaimClass.REFUND;
        if (_tryTransferExact(recipient, amount) == TransferResult.DISCHARGE) {
            if (job) {
                u.liability -= amount;
                totalLiability -= amount;
            } else {
                _releaseBondBucket(class, amount);
            }
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
        return job ? 1 : 0;
    }

    /// @dev The SINGLE release allocator (sol C2). All release authorities converge here, so the
    ///      distribution is identical regardless of authority. Consumes FUNDED_ACTIVE before transfers.
    function _allocateRelease(bytes32 unitId, bytes32 authKey) private {
        Unit storage u = _units[unitId];
        // Wave 3: the live set is the five contiguous §8.1 states, not FUNDED_ACTIVE alone — a release can
        // now be reached from PRIMARY_ASSERTED / BACKUP_ASSERTED (uncontested) or CHALLENGED (uphold or
        // appeal silence). Each caller enforces its OWN precise precondition first; this is the shared
        // "nothing has been allocated for this unit yet" gate.
        if (u.state > UnitState.BACKUP_ASSERTED) revert NotActive();
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
        if (u.state > UnitState.BACKUP_ASSERTED) revert NotActive();
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
        ClaimClass cl = c.class;
        if (_tryTransferExact(dest, amount) != TransferResult.DISCHARGE) revert ClaimStillUnpayable();
        delete _claims[claimId];
        emit ClaimDischarged(claimId, unitId, dest, amount);
        // §8.3 H-3: which bucket this claim was collateralized out of decides which bucket it releases.
        // A bond-family claim NEVER touches `u.liability` / `totalLiability`, and therefore never lets
        // bond money settle a job leg (nor a job leg settle a bond).
        if (cl > ClaimClass.REFUND) {
            _releaseBondBucket(cl, amount);
            return;
        }
        u.liability -= amount;
        totalLiability -= amount;
        // `remainingClaimCount` counts JOB legs only, so SETTLED_* keeps its frozen §7 meaning ("every
        // leg of the distribution is discharged") and is not held open by an unrelated bond claim.
        u.remainingClaimCount -= 1;
        if (u.remainingClaimCount == 0) {
            u.state = u.state == UnitState.REFUND_ALLOCATED ? UnitState.SETTLED_REFUNDED : UnitState.SETTLED_RELEASED;
        }
    }

    /// @dev Decrement the §8.3 H-3 bond-family bucket a discharged/settled aux leg belonged to.
    function _releaseBondBucket(ClaimClass cl, uint256 amount) private {
        if (cl == ClaimClass.BOND) {
            bondLiability -= amount;
        } else if (cl == ClaimClass.DELAY_COMP) {
            compLiability -= amount;
        } else {
            burnLiability -= amount;
        }
    }

    // ── H-01 §8.1 POST-VERDICT STATE MACHINE ──────────────────────────────────────────────────────
    //
    // This section REPLACES the retired `openDispute` / `resolveDispute` / `refundOnDisputeExpiry` trio.
    // Those were a free-floating payer veto: a costless call that blocked a valid neutral SETTLE and, on
    // adjudicator silence, auto-refunded. Nothing here reintroduces that shape. Every path below obeys the
    // §0 invariant — once both parties accepted the unit and a valid neutral SETTLE exists, the payer may
    // only DELAY settlement by posting a bond and invoking the precommitted appeal, and every silence
    // resolves to the LAST AUTHENTICATED STATE (release), never to the escalator's preferred outcome.
    //
    //   FUNDED_ACTIVE    --accept primary SETTLE----------> PRIMARY_ASSERTED
    //                    --operator invokes backup--------> BACKUP_PENDING   (one-way, C-4)
    //                    --reclaimAt, nothing accepted----> REFUND_ALLOCATED
    //   PRIMARY_ASSERTED --challenge window elapses-------> RELEASE_ALLOCATED    (default RELEASE)
    //                    --bonded challenge---------------> CHALLENGED
    //   CHALLENGED       --appeal UPHOLD------------------> RELEASE_ALLOCATED
    //                    --appeal OVERTURN----------------> REFUND_ALLOCATED
    //                    --appeal window elapses (SILENCE)-> RELEASE_ALLOCATED
    //   BACKUP_PENDING   --accept backup SETTLE-----------> BACKUP_ASSERTED
    //                    --assertion cutoff (timeout)-----> REFUND_ALLOCATED
    //   BACKUP_ASSERTED  --same two exits as PRIMARY_ASSERTED
    //   any of the five  --asserting cohort DISABLED------> emergency review (Model B), silence -> REFUND
    //
    // The whole machine is permissionlessly drivable: `acceptAssertion`, `finalize` and `resolveEscalation`
    // take no privileged sender, so no keeper's absence can strand a unit or restore a party's veto.

    /// @notice §8.2 C-3 — the latest moment an assertion may be ACCEPTED, primary or backup.
    /// @dev    `reclaimAt - CHALLENGE_WINDOW - APPEAL_WINDOW`, verbatim from the freeze. Underflow-free by
    ///         construction: funding requires `reclaimAt >= now + MIN_RECLAIM_DELAY` and
    ///         `MIN_RECLAIM_DELAY == CHALLENGE + APPEAL + BACKUP + 1 day`. It exists so a late verdict can
    ///         never extend the payer's capital lock past its own `reclaimAt`.
    function _assertionCutoff(Unit storage u) private view returns (uint256) {
        return uint256(u.reclaimAt) - VNextSettlementLib.CHALLENGE_WINDOW - VNextSettlementLib.APPEAL_WINDOW;
    }

    /// @dev The cohort that is (or would be) this unit's settlement authority. §8.2 C-4 makes this
    ///      one-way: before escalation it is the primary; after `invokeBackup` it is the escalation cohort
    ///      and can never be the primary again.
    function _assertingAttester(Unit storage u) private view returns (address) {
        return u.backupLane ? escalationAttester : authorizedOracle;
    }

    /// @dev §8.3 C-5 (Model B) — 0 when no emergency is open for this unit, else the IMMUTABLE deadline
    ///      `disabledAt + EMERGENCY_REVIEW_WINDOW`. `disabledAt` is write-once inside a one-way switch
    ///      (`O5AttesterBase.disable`), so the revoker can neither extend it, reset it, nor pick the outcome
    ///      behind it. It reads the PRIMARY cohort only — scoping it to "either bound cohort" would hand the
    ///      escalation cohort's revoker a kill-switch over every healthy primary settlement, a brand-new
    ///      veto of exactly the class H-01 exists to delete, and a unit that escalated AWAY from a disabled
    ///      primary is not a second victim of that primary's emergency.
    ///
    ///      TWO EXCLUSIONS (Wave 3c). C-5's load-bearing property is that the revoker may INITIATE but
    ///      never CHOOSE the financial result. Each exclusion is a case where the unrestricted form handed
    ///      the result to one key holder outright:
    ///
    ///      (1) THE BACKUP LANE IS EXCLUDED. After `invokeBackup` the unit's settlement authority IS
    ///          `escalationAttester` — which is simultaneously the appeal quorum and the Model-B emergency
    ///          cohort. Opening an emergency there appoints the body that was just killed as its own
    ///          reviewer: `adjudicate` requires `enabled`, `resolveEscalation(EMERGENCY)` refuses a disabled
    ///          cohort, and the APPEAL role is locked out by the emergency itself — so the only reachable
    ///          exit was the emergency-silence REFUND, i.e. one key holder unilaterally refunding every
    ///          escalated unit, including ones holding a valid accepted backup SETTLE. With no independent
    ///          reviewer in existence there is no honest review to wait for, so the backup lane resolves
    ///          under its ORDINARY windows to the LAST AUTHENTICATED STATE (§0): an accepted backup SETTLE
    ///          releases at its challenge deadline (or on appeal silence), and a backup lane that never
    ///          produced a SETTLE still refunds at the assertion cutoff — the §8.1 "backup silent ⇒ refund"
    ///          default, unchanged. The PRIMARY lane keeps full Model B, where the reviewer is a genuinely
    ///          independent deployment (the escrow's constructor rejects `escalation == oracle`).
    ///      (2) A RELEASE THAT WAS ALREADY DUE IS EXCLUDED. The emergency reviews a settlement still inside
    ///          its window; it must not reach BACK over one whose window had already closed at the moment
    ///          the compromise was declared. Without this, the difference between release and refund is
    ///          whether any permissionless keeper happened to transact — and §8.1's expanded invariant names
    ///          "relayer inactivity" explicitly as something that must not improve the payer's outcome. Note
    ///          the old behaviour was not protection but a RACE the operator wins by calling `finalize` the
    ///          instant the window closes; this makes the outcome deterministic instead of timing-dependent.
    function _emergencyDeadline(Unit storage u) private view returns (uint256) {
        if (u.backupLane) return 0; // (1)
        uint256 d = IOracleAttester(authorizedOracle).disabledAt();
        if (d == 0) return 0;
        uint64 a = u.assertedAt;
        if (a != 0) {
            // (2) the instant `finalize` would have released this unit, had anyone called it. CHALLENGED
            // is anchored on the appeal window; every other accepted state on the challenge window. (A unit
            // can only become CHALLENGED strictly INSIDE the challenge window, so the appeal deadline is
            // always the later of the two and the branch is exhaustive.)
            uint256 due = u.state == UnitState.CHALLENGED
                ? uint256(u.challengedAt) + VNextSettlementLib.APPEAL_WINDOW
                : uint256(a) + VNextSettlementLib.CHALLENGE_WINDOW;
            if (d >= due) return 0;
        }
        return d + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;
    }

    /// @notice §2.2 + §8.2 C-3 — ACCEPT a cohort SETTLE for this unit. Permissionless.
    /// @dev    THE central Wave-3 change: a valid SETTLE no longer transfers funds. It creates a pending
    ///         settlement stamped with the ESCROW's own clock, opening a bounded challenge window; the
    ///         money moves later, from `finalize` or an escalation verdict. The full release predicate
    ///         (identity, tier, fee commitment, cohort epoch, composition root, evidence binding,
    ///         kill-switch) is enforced HERE, unchanged and in the same order — acceptance is exactly as
    ///         hard as release used to be, and the split only inserts a window, never a weaker check.
    ///
    ///         Lane routing is by state, not by an argument, so a caller cannot choose which cohort is
    ///         consulted: FUNDED_ACTIVE reads the primary, BACKUP_PENDING reads the escalation cohort.
    ///         Because `invokeBackup` is one-way and no state returns to FUNDED_ACTIVE, a primary
    ///         assertion is structurally unreachable after escalation (§8.2 C-4, no verifier-shopping).
    function acceptAssertion(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        UnitState s = u.state;
        bool backup = s == UnitState.BACKUP_PENDING;
        if (!backup && s != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp >= _assertionCutoff(u)) revert AssertionCutoffPassed();

        address att = backup ? escalationAttester : authorizedOracle;
        O5Assertion memory a = IOracleAttester(att).assertionOf(unitId);
        if (a.assertionId == bytes32(0)) revert AttestationNotFound();
        if (a.escrow != address(this)) revert WrongRecipient(); // the `attestation.recipient` check

        // H3 identity — see the note on the release predicate below: recomputing the id from the escrow's
        // OWN frozen fields pins jobIdHash / milestoneIndex / stepId / escrow by collision resistance.
        bytes32 recomputed = VNextSettlementLib.computeSettlementUnitId(
            u.feeSchedule.chainId, address(this), jobIdHash, u.milestoneIndex, u.stepId
        );
        if (recomputed != unitId) revert IdentityMismatch();

        // Evidence predicate (§9): settle-only, Tier>=1, tier fulfillment + request identity, fee commitment.
        if (a.decision != O5_DECISION_SETTLE) revert NotSettle();
        if (u.requiredTier < 1) revert Tier0NotEvidence();
        if (a.achievedTier > MAX_TIER) revert TierOutOfRange(); // M-01: bound the oracle-asserted tier (0..3)
        if (a.achievedTier < u.requiredTier) revert TierNotMet();
        if (a.requestedTier != u.requiredTier) revert RequestedTierMismatch();
        if (a.feeScheduleHash != u.feeScheduleHash) revert FeeHashMismatch();
        // M-01: also bind the RAW fee fields carried in the permanent assertion, not just their 13-field hash.
        if (a.feeBps != u.feeSchedule.feeBps) revert FeeBpsMismatch();
        if (a.feeRecipient != u.feeSchedule.feeRecipient) revert FeeRecipientMismatch();

        // rev-3 §A.2/§C3: cohort-epoch binding + composition-root binding, per LANE. The backup lane pins
        // the escalation cohort's own funded epoch for exactly the reason the primary lane pins its own.
        if (a.oracleAuthEpoch != (backup ? escalationAuthEpoch : oracleAuthEpoch)) revert OracleCohortMismatch();
        if (a.compositionRoot != u.compositionRoot) revert CompositionRootMismatch();

        // §B on-chain evidence binding: the verdict must be over the package this unit committed to.
        if (!u.evidenceCommitted || a.evidenceBundleHash != u.evidenceBundleHash) revert EvidenceBundleMismatch();

        // Kill-switch AT ACCEPTANCE TIME, and again at finalization (see `finalize`): a one-way disable
        // neutralizes an otherwise-valid pre-written assertion at BOTH ends of the challenge window.
        if (!IOracleAttester(att).enabled()) revert OracleCohortDisabled();

        // §8.2 C-3: the escrow's OWN clock, never `a.assertedAt`. A verdict minted weeks ago and submitted
        // one hour before the cutoff still gets a full, fresh challenge window.
        uint64 nowTs = uint64(block.timestamp);
        u.assertedAt = nowTs;
        u.acceptedAssertionId = a.assertionId;
        u.state = backup ? UnitState.BACKUP_ASSERTED : UnitState.PRIMARY_ASSERTED;
        emit AssertionAccepted(unitId, a.assertionId, att, nowTs, backup);
    }

    /// @notice §2.2/§2.3 — the payer contests THIS EXACT accepted assertion, posting the frozen bond.
    /// @dev    This is a challenge TO the oracle verdict, not a veto OF it: it buys an appeal, and its
    ///         failure mode (including appeal silence) is RELEASE. The bond is pulled atomically with the
    ///         same delta discipline as funding, so "challenger never completes the bond ⇒ the challenge
    ///         never opens ⇒ release" is true by construction rather than by a separate timeout.
    function challenge(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        if (msg.sender != payer) revert OnlyPayer();
        Unit storage u = _units[unitId];
        UnitState s = u.state;
        if (s != UnitState.PRIMARY_ASSERTED && s != UnitState.BACKUP_ASSERTED) revert NotActive();
        if (u.bond != 0) revert AlreadyChallenged();
        if (block.timestamp >= uint256(u.assertedAt) + VNextSettlementLib.CHALLENGE_WINDOW) {
            revert ChallengeWindowClosed();
        }
        uint256 bond = VNextSettlementLib.challengeBond(u.feeSchedule.g);

        // Effects before the token pull (nonReentrant-guarded).
        u.state = UnitState.CHALLENGED;
        u.challenger = msg.sender;
        u.challengedAt = uint64(block.timestamp);
        u.bond = bond;
        bondLiability += bond;

        _pullExact(msg.sender, bond);
        emit Challenged(unitId, msg.sender, bond, u.challengedAt);
    }

    /// @notice §2.6/§8.2 C-4 — the OPERATOR closes the primary lane and opens the backup cohort.
    /// @dev    Operator-only and one-way. Operator-only because this is the operator's recourse against a
    ///         WITHHELD verdict; a payer-invocable escalation would just be the withholding attack with an
    ///         extra step. One-way because the state can never return to FUNDED_ACTIVE, so there is
    ///         exactly one backup outcome and no shopping between two live lanes.
    ///         Two triggers: the primary verdict is overdue (`>= primaryVerdictDue`), or the primary
    ///         cohort has been disabled — in which case the lane is provably closed and waiting out the
    ///         clock would only burn the operator's remaining window (§8.3 C-5, pre-assertion branch).
    ///
    ///         OPERATIONAL ORDER (not a hazard, but it must be stated): commit the evidence package
    ///         BEFORE escalating. `submitEvidence` requires FUNDED_ACTIVE, and this call leaves it, so an
    ///         operator that escalates with nothing committed cannot then commit — and the backup cohort
    ///         cannot assert over an uncommitted package (§B is enforced on the attester side too), so the
    ///         unit would simply time out to a refund. That ordering is inherent to §B: the package is
    ///         selected before any verdict exists, and escalation is a request for a verdict.
    function invokeBackup(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        if (msg.sender != operator) revert OnlyOperator();
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        uint256 cutoff = _assertionCutoff(u);
        if (block.timestamp >= cutoff) revert AssertionCutoffPassed();
        if (
            block.timestamp < cutoff - VNextSettlementLib.BACKUP_WINDOW
                && IOracleAttester(authorizedOracle).disabledAt() == 0
        ) revert PrimaryVerdictNotDue();
        u.backupLane = true;
        u.state = UnitState.BACKUP_PENDING;
        emit BackupInvoked(unitId, uint64(block.timestamp));
    }

    /// @notice §8.1 — drive a unit past whichever window has now elapsed. Permissionless.
    /// @dev    The safety defaults live here, and every one of them preserves the LAST AUTHENTICATED
    ///         STATE: an unchallenged assertion releases, a challenge that outlives its appeal releases
    ///         (silence must not refund, or the payer regains the veto through appeal-liveness failure),
    ///         a backup lane that produced no verdict refunds, and a declared emergency that produced no
    ///         verdict refunds. The emergency branch is checked FIRST because §8.3 C-5 makes it the one
    ///         deliberate exception: while the asserting cohort is disabled, ordinary finalization PAUSES.
    function finalize(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        UnitState s = u.state;
        if (s > UnitState.BACKUP_ASSERTED) revert NotActive();

        uint256 emergencyDue = _emergencyDeadline(u);
        if (emergencyDue != 0) {
            if (block.timestamp < emergencyDue) revert WindowStillOpen();
            _forfeitOrReturnBond(unitId, u, false); // the challenger is made whole; the emergency is not its fault
            _allocateRefund(unitId, _deadlineAuthKey(unitId, u));
            emit Finalized(unitId, false, 3);
            return;
        }

        // WAVE 3c — the two `enabled()` RE-CHECKS THAT STOOD HERE ARE REMOVED, deliberately and provably:
        //   * they were already DEAD on the primary lane. `O5AttesterBase.disable()` (:222-231) is the sole
        //     writer of BOTH `enabled` and `disabledAt`, in one one-way move with `disabledAt` clamped
        //     non-zero, so `!enabled() ⟺ disabledAt() != 0` — and `disabledAt() != 0` is precisely what the
        //     emergency branch above intercepts first. A conforming attester could never reach these lines
        //     with a disabled cohort;
        //   * where they were NOT dead they were the bug. The emergency branch now deliberately declines
        //     two cases (a backup lane whose reviewer is the disabled body, and a release that was already
        //     due before the disable — see `_emergencyDeadline`); with the re-check still here, those two
        //     units would revert on EVERY exit and be BRICKED forever, since `reclaimAfterDeadline` needs
        //     FUNDED_ACTIVE. A permanent lock-up is strictly worse than the refund it replaced.
        // Nothing that reads a verdict lost its kill-switch: `acceptAssertion` still refuses to accept an
        // assertion from a disabled cohort, and `resolveEscalation` still refuses a disabled escalation
        // cohort's adjudication. What is gone is only the re-read, at payment time, of a switch whose
        // "on" state the branch above already owns.
        if (s == UnitState.PRIMARY_ASSERTED || s == UnitState.BACKUP_ASSERTED) {
            if (block.timestamp < uint256(u.assertedAt) + VNextSettlementLib.CHALLENGE_WINDOW) {
                revert WindowStillOpen();
            }
            _allocateRelease(unitId, _assertionAuthKey(unitId, u));
            emit Finalized(unitId, true, 0);
            emit EvidenceReleased(unitId, u.acceptedAssertionId);
        } else if (s == UnitState.CHALLENGED) {
            if (block.timestamp < uint256(u.challengedAt) + VNextSettlementLib.APPEAL_WINDOW) {
                revert WindowStillOpen();
            }
            // Appeal silence ⇒ RELEASE, and the bond is forfeited: the challenge failed to produce an
            // overturn, so §2.4's compensate-then-burn applies exactly as it does to an explicit UPHOLD.
            _forfeitOrReturnBond(unitId, u, true);
            _allocateRelease(unitId, _assertionAuthKey(unitId, u));
            emit Finalized(unitId, true, 1);
            emit EvidenceReleased(unitId, u.acceptedAssertionId);
        } else if (s == UnitState.BACKUP_PENDING) {
            // §8.1: backup REJECT / timeout ⇒ refund. The backup verdict deadline IS the assertion cutoff.
            if (block.timestamp < _assertionCutoff(u)) revert WindowStillOpen();
            _allocateRefund(unitId, _deadlineAuthKey(unitId, u));
            emit Finalized(unitId, false, 2);
        } else {
            revert NotActive(); // FUNDED_ACTIVE with no emergency: `reclaimAfterDeadline` is the exit
        }
    }

    /// @notice §2.5/§8.3 C-5 — apply a typed escalation verdict (APPEAL or Model-B EMERGENCY).
    /// @dev    Permissionless: the escrow READS an immutable, quorum-verified record out of the escalation
    ///         attester and applies its OWN frozen distribution. The record carries no amount and no
    ///         recipient, so this quorum can only select release-or-refund — never move, resize or
    ///         redirect money. There is no signature verification in this contract at all.
    /// @param role `O5_ADJ_ROLE_APPEAL` (only while CHALLENGED and no emergency) or
    ///        `O5_ADJ_ROLE_EMERGENCY` (only while an emergency is open, for any accepted assertion).
    function resolveEscalation(bytes32 unitId, uint8 role) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        UnitState s = u.state;
        uint256 emergencyDue = _emergencyDeadline(u);
        bool emergency = emergencyDue != 0;

        if (role == O5_ADJ_ROLE_APPEAL) {
            // Model B: once an emergency is declared, the appeal quorum no longer decides this unit — the
            // emergency cohort reviews the exact assertion instead. Otherwise a pre-signed appeal could
            // pre-empt the systemic-compromise review that was declared precisely to override it.
            if (emergency) revert EmergencyPaused();
            if (s != UnitState.CHALLENGED) revert NotActive();
            if (block.timestamp >= uint256(u.challengedAt) + VNextSettlementLib.APPEAL_WINDOW) {
                revert WindowStillOpen(); // the window closed; `finalize` now owns the (release) default
            }
        } else if (role == O5_ADJ_ROLE_EMERGENCY) {
            if (!emergency) revert NoEmergency();
            // Wave 3c: the emergency deadline is TERMINAL, symmetrically with the appeal deadline one
            // branch up. Without this the deadline bounded nothing: past it, `finalize` (→ refund) and a
            // late UPHOLD (→ release) were both live and the first transaction won, so "silence ⇒ refund AT
            // the immutable deadline" was in truth "⇒ refund unless the cohort outruns the keeper". Same
            // error as the appeal branch by design (see `WindowStillOpen`): one error for "this call is not
            // the one this window admits right now", with the state + deadlines readable from the views.
            if (block.timestamp >= emergencyDue) revert WindowStillOpen();
            if (s < UnitState.PRIMARY_ASSERTED || s > UnitState.BACKUP_ASSERTED) revert NotActive();
        } else {
            revert BadEscalationRole();
        }

        O5AdjudicationRecord memory r = IOracleAttester(escalationAttester).adjudicationOf(unitId, role);
        if (r.adjudicationId == bytes32(0)) revert AttestationNotFound();
        if (r.escrow != address(this)) revert WrongRecipient();
        // Assertion-specific by construction: a verdict signed over one assertion cannot be applied to
        // another, and `acceptedAssertionId` is nonzero only in the accepted states gated above.
        if (r.reviewedAssertionId != u.acceptedAssertionId) revert IdentityMismatch();
        // A killed escalation cohort's pre-written verdict must not move money, exactly as a killed
        // primary cohort's pre-written assertion must not (the symmetric rev-3 kill-switch property).
        if (IOracleAttester(escalationAttester).disabledAt() != 0) revert OracleCohortDisabled();

        bool upheld = r.outcome == O5_ADJ_UPHOLD; // the attester admits only UPHOLD | OVERTURN
        bytes32 authKey = _authorizationKey(
            AuthorizationType.DISPUTE, AUTHDOMAIN_DISPUTE, escalationAttester, r.adjudicationId, unitId
        );
        // §2.4 compensate-then-burn on a failed challenge; full return on a successful one.
        _forfeitOrReturnBond(unitId, u, upheld);
        if (upheld) {
            _allocateRelease(unitId, authKey);
            emit EvidenceReleased(unitId, u.acceptedAssertionId);
        } else {
            _allocateRefund(unitId, authKey);
        }
        emit EscalationResolved(unitId, r.adjudicationId, role, upheld);
    }

    /// @dev §2.4 slash waterfall. `forfeit == false` returns the whole bond to the challenger; `true`
    ///      pays the operator its BOUNDED, pre-agreed delay compensation and BURNS the remainder.
    ///      The remainder goes to neither counterparty and to no treasury: winning a challenge is never a
    ///      profit (that would price a bait-a-slash), and a protocol that earned from disputes would be
    ///      tuned for more of them. Called BEFORE the job allocation so the bond buckets are already
    ///      correct when `_requireSolvent()` runs inside the allocator.
    function _forfeitOrReturnBond(bytes32 unitId, Unit storage u, bool forfeit) private {
        uint256 b = u.bond;
        if (b == 0) return;
        u.bond = 0;
        if (!forfeit) {
            _settleLeg(unitId, u, VNextSettlementLib.BOND_LEG_INDEX, ClaimClass.BOND, u.challenger, b);
            return;
        }
        uint256 comp = VNextSettlementLib.delayCompensation(u.feeSchedule.g, b);
        uint256 burn = b - comp;
        // Move the value between buckets first: the totals must stay exact even if a leg becomes a claim.
        bondLiability -= b;
        compLiability += comp;
        burnLiability += burn;
        _settleLeg(unitId, u, VNextSettlementLib.DELAY_COMP_LEG_INDEX, ClaimClass.DELAY_COMP, operator, comp);
        _settleLeg(unitId, u, VNextSettlementLib.BURN_LEG_INDEX, ClaimClass.BURN, VNextSettlementLib.BURN_SINK, burn);
        emit BondForfeited(unitId, comp, burn);
    }

    /// @notice §8.2 C-2 — permissionless payer refund at/after `reclaimAt`, ONLY from FUNDED_ACTIVE.
    /// @dev    This is the reclaim exclusion, and it is enforced by the state machine rather than by a
    ///         flag: an accepted SETTLE leaves FUNDED_ACTIVE and NOTHING returns a unit to it, so ordinary
    ///         deadline reclaim is disabled PERMANENTLY from the moment of acceptance. A missing keeper
    ///         does not restore it — `finalize` is permissionless and can be called at any later time — and
    ///         a validly-opened challenge (CHALLENGED) equally cannot be bypassed back into a refund here.
    function reclaimAfterDeadline(bytes32 unitId) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
        if (block.timestamp < u.reclaimAt) revert TooEarlyToReclaim();
        _allocateRefund(unitId, _deadlineAuthKey(unitId, u));
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

    /// @dev The evidence authorization key for a unit's ACCEPTED assertion. Issuer = the lane's cohort,
    ///      raw id = the assertion id (the FULL signed verdict hash) — the same envelope the pre-Wave-3
    ///      release path consumed, so the single-use replay guard carries forward unchanged.
    function _assertionAuthKey(bytes32 unitId, Unit storage u) private view returns (bytes32) {
        return _authorizationKey(
            AuthorizationType.EVIDENCE, AUTHDOMAIN_EVIDENCE, _assertingAttester(u), u.acceptedAssertionId, unitId
        );
    }

    /// @dev The deadline-refund authorization key (ordinary reclaim, backup timeout, emergency timeout).
    ///      One key for all three because the state machine admits at most ONE of them per unit: each
    ///      leaves the live set, and nothing re-enters it.
    function _deadlineAuthKey(bytes32 unitId, Unit storage u) private view returns (bytes32) {
        return _authorizationKey(
            AuthorizationType.RECLAIM,
            AUTHDOMAIN_RECLAIM,
            address(this),
            // uint256() is explicit, not cosmetic: `abi.encode` pads a uint64 to the same 32 bytes, so the
            // authorization key is byte-identical to the pre-packing form — stated so it stays that way.
            keccak256(abi.encode("RECLAIM", unitId, uint256(u.reclaimAt))),
            unitId
        );
    }

    // ── Crypto authorities (INCREMENT 2b-ii) ──────────────────────────────────────────
    //
    // `releaseFromEvidence` is RETIRED. Its entire predicate now lives in `acceptAssertion` above,
    // unchanged and in the same order — the only difference is what a passing verdict produces: a pending
    // settlement with a fresh challenge window instead of an immediate transfer. There is still exactly
    // ONE evidence predicate to audit and no second release path, which was the P0-6 property; the money
    // simply moves from `finalize` / `resolveEscalation` once the §8.1 machine has run.

    /// @notice Tier-0 buyer approval (FROZEN §10.10, sol C5): a distinct authorization type. Only the
    ///         immutable payer authorizes — a direct call or a relayable EIP-712/ERC-1271 signature.
    function approveByBuyer(bytes32 unitId, BuyerApproval calldata approval, bytes calldata signature)
        external
        nonReentrant
        onlyExisting(unitId)
    {
        Unit storage u = _units[unitId];
        // §8.3 C-6: Tier-0 is UNCHANGED by Wave 3 — explicit buyer approval or deadline refund, and no
        // optimistic operator-assertion path. The `FUNDED_ACTIVE` requirement subsumes the retired
        // `LiveDispute` guard, and a Tier-0 unit never enters the §8.1 evidence machine at all
        // (`acceptAssertion` rejects `requiredTier < 1`).
        if (u.state != UnitState.FUNDED_ACTIVE) revert NotActive();
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
            if (!_isValidSignature(payer, structHash, signature)) revert BadSignature();
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
        if (!_isValidSignature(owner, structHash, signature)) revert BadSignature();
        emit ClaimDestinationRotated(claimId, current, newDestination, nonce);
    }

    // ── EIP-712 + signature helpers ──────────────────────────────────────────────────────────────
    // `_domainSeparator` / `_typedDataHash` / `_isValidSignature` moved to
    // {VNextSettlementEscrowFactory.verifyCloneSignature} in Wave 4a, together with the acceptance
    // verification. The digest is unchanged: the factory builds it with `verifyingContract == msg.sender`,
    // which is this clone. Everything that decides WHETHER a signature may authorize anything — the field
    // bindings, the nonce, the expiry, the state guards — stays here; only the "is this signature valid
    // over this hash" predicate is answered next door.
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

    /// @dev Validate `signer`'s signature over the EIP-712 digest of `structHash` in THIS clone's domain.
    ///      One hop to the factory (see {VNextSettlementEscrowFactory.verifyCloneSignature}); ERC-1271 for
    ///      contracts, malleability-guarded ECDSA for EOAs, exactly as before Wave 4a.
    function _isValidSignature(address signer, bytes32 structHash, bytes calldata signature)
        private
        view
        returns (bool)
    {
        return IVNextEscrowFactory(factory).verifyCloneSignature(signer, structHash, signature);
    }
}
