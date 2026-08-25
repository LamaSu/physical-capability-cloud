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
    ///         attester instance (its signer set, threshold and revoker are immutable per instance).
    /// @dev    DEPLOY GATE — §2.5 ROUTE DIVERSITY IS NOT ENFORCED HERE (adversarial-review L-2, corrected
    ///         in Wave 3c; an earlier version of this comment called independence "a deployment fact, not a
    ///         promise", which overstated it). The only structural check is `escalation != oracle` in the
    ///         constructor. Immutability makes each signer set FIXED, not DIVERSE: two attester deployments
    ///         carrying the SAME three signers pass every check here and in both attesters, and §2.5's
    ///         route-diversity requirement would be silently unsatisfied — the appeal would be the primary
    ///         reviewing itself. It is deliberately not checked on-chain because the concrete signer getters
    ///         belong to `Fixed2of3O5Attester`, not to `IOracleAttester`, and requiring them would forbid
    ///         any other quorum shape (e.g. 3-of-5) at the type level. So it is a DEPLOYMENT-REVIEW item:
    ///         assert signer-set disjointness between `oracle` and `escalation` in the deploy gate, next to
    ///         the `VNextSettlementLib` code-hash assertion (see that library's deploy-gate note).
    /// @dev    Wave 3c also narrows what this cohort's revoker can do to a unit — see `_emergencyDeadline`.
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
    /// @dev WAVE 4c — the `o5SchemaUid` / `o5TypeHash` IMMUTABLES AND THEIR GETTERS ARE REMOVED FROM THE
    ///      ESCROW. Both were PUBLICATION-ONLY deployment metadata: neither was ever read by any escrow code
    ///      path (with the EAS read gone in P0-6 there is no runtime `WrongSchema` check), and the oracle
    ///      lane confirmed (#577 (d)) that its `EscrowStateReader` reads NEITHER — they are oracle-side
    ///      EIP-712 constants matched through the codehash pin, never a live escrow read.
    ///
    ///      What is NOT removed is the thing that gave them their value: the M-02/L-02 CONSTRUCTOR PINS
    ///      below still compare the deployed values byte-for-byte against `IOracleAttester(oracle)`, so a
    ///      schema/type-hash divergence still aborts the deployment. The pins read the constructor
    ///      PARAMETERS directly, so deleting the immutables cannot weaken them.
    ///
    ///      The published read surface moves UP to {VNextSettlementEscrowFactory}, which is the correct
    ///      publication point anyway: both values are implementation-wide constants shared by every clone,
    ///      not per-clone state, and the factory is the contract that chose them. This is a relocation of a
    ///      read surface, not a deletion of one — and it buys runtime bytecode on the contract that is at
    ///      the EIP-170 ceiling, spent from the contract that has ~20 KiB of headroom.

    uint256 public constant CONTRACT_VERSION = 1;
    /// @dev H-01 §2.1 policy-version pin, bound into every acceptance signature. A future policy shape
    ///      bumps this, and yesterday's signatures stop validating instead of silently meaning something new.
    uint256 public constant POLICY_VERSION = VNextSettlementLib.POLICY_VERSION_V2;

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
    ///         §2.4 delay compensation (`_disposeBond` → `ClaimClass.DELAY_COMP`). So this key must
    ///         be able to RECEIVE and move USDC. It is held to the payout-recipient exclusion set in
    ///         `initialize` for exactly that reason. Paying delay-comp to a separate payout recipient
    ///         instead would be a distribution change, not a comment change, and is deliberately NOT made
    ///         here: it would alter who is compensated on a failed challenge.
    /// @dev    §2.8 (Wave 3c): this address is ALSO the evidence committer — see `submitEvidence`.
    address public operator;
    /// @dev WAVE 4b — `arbiter` and `_selfAdjudicationAccepted` ARE REMOVED, storage slot and all. The
    ///      Wave-3 state machine left no code path that reads an arbiter: every money decision is a cohort
    ///      quorum record, and `resolveDispute` (its only caller, ever) no longer exists. A stored address
    ///      no function consults is not a safeguard, it is a liability — it was in the CREATE2 salt and in
    ///      `JOB_POLICY_TYPEHASH`, so both parties had to agree on a value that could not affect a single
    ///      wei, while a typo in it silently moved the escrow's address. No ghost/reserved slot is kept:
    ///      preserving layout would preserve nothing that matters here (there are no deployed clones, and
    ///      every salt moves anyway), and a permanently-zero field is accounting theatre.
    bytes32 public jobIdHash; // keccak256(bytes(jobId)) — canonical UTF-8 (§10.12 M1)
    bytes32 public termsHash;
    /// @dev H-01 §8.2 H-1 — this clone's policy generation, bound into the CREATE2 salt and consumed at
    ///      the factory during `fund()`.
    uint256 internal _policyNonce;
    /// @dev keccak256(abi.encode(UnitConfig[])) — the address-independent commitment to the exact funded
    ///      terms, bound into the CREATE2 salt. `fund()` re-derives it from the supplied configs, so the
    ///      escrow's own ADDRESS proves which terms it may be funded with, before any signature is read.
    bytes32 internal _prePolicyRoot;
    /// @dev BATCH-1 item 3 — the bilaterally-committed `AcceptedJobPolicyV1` digest. OPAQUE TO THIS
    ///      CONTRACT: stored, republished via `policy()`, and passed back to the factory for the acceptance
    ///      digest. There is deliberately NO code path in this escrow that decodes or interprets it, which
    ///      is what lets composition/evidence/oracle change its CONTENTS with zero escrow change.
    bytes32 internal _acceptedPolicyDigest;
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

    /// @dev The THREE challenge-bond dispositions, and the ONE question that selects between them:
    ///      was the challenge ADJUDICATED, and if so, did it lose? (§2.4 + §8.3 C-1.)
    ///      `COMP_RETURN` is the C-1 rule for an UNADJUDICATED end: the operator still receives its
    ///      capped, pre-agreed delay compensation, and the UNUSED remainder goes back to the challenger
    ///      rather than to the sink. Burning is a penalty, and a penalty needs a finding; silence is the
    ///      absence of one. See `_disposeBond` for why the distinction is economic and not cosmetic.
    enum BondDisposition {
        RETURN_ALL, // no adjudicated loss, and no delay chargeable to the challenger
        COMP_RETURN, // §8.3 C-1: unadjudicated end — capped delay-comp, the REST returned
        COMP_BURN // §2.4: an adjudicated loss — capped delay-comp, the REST burned

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
    event Initialized(address indexed payer, address indexed operator, bytes32 jobIdHash);
    /// @notice H-01 §2.1 — emitted once, at funding, recording that BOTH parties authenticated this exact
    ///         policy. `unitsRoot` is the rolling commitment over the settlementUnitIds derived from this
    ///         escrow's address; `policyNonce` is the generation the factory consumed in the same call.
    event PolicyAccepted(
        bytes32 indexed jobPolicyHash,
        address indexed payer,
        address indexed operator,
        uint256 policyNonce,
        bytes32 unitsRoot
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
    // ── {Finalized} outcome-cause codes ───────────────────────────────────────────────────────────────
    // NAMED as of BATCH-1 item 2. These were bare literals at their emit sites, which made the read
    // surface's `refundReason` mapping a comment-archaeology exercise. `internal constant` is inlined at
    // compile time, so naming them costs ZERO runtime bytecode on a contract at the EIP-170 ceiling.
    //
    // CAUTION FOR INDEXERS — {Finalized} FIRES AT *ALLOCATION*, NOT AT SETTLEMENT. It marks the transition
    // INTO `RELEASE_ALLOCATED`/`REFUND_ALLOCATED` (states 6/7), where money may still be owed. The real
    // 6->8 / 7->9 flip happens in `dischargeClaim` and emits NO event of its own, so a `finalizedBlock`
    // derived from THIS event is wrong for any unit with an outstanding claim. Derive it from the block of
    // the `ClaimDischarged` that zeroed `remainingClaimCount`.
    uint8 internal constant FINALIZED_REASON_UNCONTESTED_RELEASE = 0;
    uint8 internal constant FINALIZED_REASON_APPEAL_SILENCE_RELEASE = 1;
    // Backup lane produced no accepted release by its deadline. The escrow CANNOT distinguish a backup
    // "reject" from a backup "timeout" — both leave via the same `BACKUP_PENDING` branch — so this is
    // deliberately ONE honest cause rather than two the contract cannot witness.
    uint8 internal constant FINALIZED_REASON_BACKUP_NO_RELEASE = 2;
    uint8 internal constant FINALIZED_REASON_EMERGENCY_SILENCE_REFUND = 3;
    // BATCH-1 item 2: deadline reclaim is now WITNESSED rather than inferred by elimination.
    uint8 internal constant FINALIZED_REASON_DEADLINE_RECLAIM = 4;

    /// @param reason one of the `FINALIZED_REASON_*` codes above: 0 = uncontested challenge window closed,
    ///               1 = appeal silence, 2 = backup produced no release by its deadline, 3 = emergency-review
    ///               silence (§8.3 C-5 Model B), 4 = deadline reclaim.
    event Finalized(bytes32 indexed unitId, bool released, uint8 reason);
    /// @dev The full disposition of a challenge bond, in one line: `delayCompensation + remainder == bond`
    ///      always, and `burned` says where the remainder went (sink if true, back to the challenger if
    ///      false). It replaces the old `BondForfeited`, which could only describe a forfeiture and so had
    ///      no way to state the §8.3 C-1 outcome (compensate, then RETURN the remainder) — an event named
    ///      "forfeited" firing on a return would have been a false log.
    event BondDisposed(bytes32 indexed unitId, uint256 delayCompensation, uint256 remainder, bool burned);
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
    // The next two are RAISED BY THE FACTORY since Wave 4a (the acceptance verification moved there) and
    // bubble out of `fund()` unchanged — a custom error's selector is `keccak256("Name()")[0:4]` and
    // carries no contract identity. They are declared here because they are part of `fund()`'s revert
    // surface and every ABI decoder pointed at this contract must be able to name them. Costs no runtime
    // bytecode: a declared-but-unraised error emits nothing.
    // WAVE 4b: `SelfAdjudicationNotAccepted` is REMOVED from this list. With no arbiter there is nothing
    // to self-adjudicate, so neither contract can raise it and a decoder that still names it is decoding
    // a selector nothing emits.
    /// @notice The bilateral acceptance expired before funding.
    error PolicyExpired();
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
    /// @notice WAVE 4b — an APPEAL verdict recorded inside `[challengedAt, min(appealDue, disabledAt))` is
    ///         FINAL for this unit, so the emergency role may not decide it. Raised only by
    ///         `resolveEscalation(EMERGENCY)`; the appeal itself remains applicable and permissionless.
    error AppealIsFinal();
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
    /// @notice M-01: the linked {VNextSettlementLib} is not the one this build was compiled against.
    ///         Deploy-time only (raised in the constructor) — it aborts the deployment.
    error LinkedLibraryMismatch();
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
        // ── M-01 (sol 4th-family): THE LINKED-LIBRARY GATE, in code rather than in a comment ──────────
        // The three {VNextSettlementLib} calls on the funding path are DELEGATECALLs, so they execute in
        // the CLONE'S OWN STORAGE. A hostile link therefore does not merely return a wrong hash: a
        // malicious `computePayoutConfigHash` can rewrite `_payouts[unitId][0].recipient` AFTER the signed
        // entries validated, return the HONEST hash so bilateral acceptance and funding both succeed, and
        // let a later, entirely VALID settle pay a substituted recipient. That was previously a
        // deploy-review note ("assert the code hash before use"), which nothing enforced.
        //
        // The expectation is derived at COMPILE TIME from this build's own library — nothing here is
        // supplied by a deployer, so a hostile deployment cannot satisfy it by also supplying a matching
        // hash. The ONLY byte-difference between the compile-time template and the deployed library is the
        // library's own address, which solc emits as the PUSH20 operand of the call-protection prologue
        // (`0x73 <20-byte address> 0x30 ...`) and which is filled in at LINK time; splicing the linked
        // address into that operand makes the two byte-identical (verified: exactly 20 differing bytes, at
        // offsets 1..20). FAIL-CLOSED: a different library, a mutable proxy, an unlinked build, or a future
        // prologue shape this splice no longer matches all ABORT the deployment — of the implementation and
        // therefore of the factory that constructs it — rather than shipping clones whose funding path
        // delegatecalls unknown code.
        bytes memory expectedLib = type(VNextSettlementLib).runtimeCode;
        address linkedLib = address(VNextSettlementLib);
        assembly ("memory-safe") {
            let p := add(expectedLib, 0x21) // 0x20 length word + the 1-byte PUSH20 opcode
            mstore(p, or(shl(96, linkedLib), and(mload(p), shr(160, not(0)))))
        }
        if (keccak256(expectedLib) != linkedLib.codehash) revert LinkedLibraryMismatch();
        // ── H-02: the two cohorts must not share a KILL-SWITCH HOLDER ────────────────────────────────
        // §8.3 C-5 freezes that a revoker may INITIATE but never CHOOSE the financial result. Disabling
        // the PRIMARY opens the Model-B emergency (whose silence refunds); disabling the ESCALATION cohort
        // stops any emergency verdict from being written at all. Separately custodied, that pair of moves
        // needs two independent key holders; in ONE hand it is a unilateral "refund every accepted SETTLE"
        // switch — C-5's property restated as an address inequality. Deploy-time only, so it costs no
        // runtime bytecode, and it is exactly the shape of the separation `Fixed2of3O5Attester` already
        // enforces between its revoker and its signers.
        if (IOracleAttester(oracle).revoker() == IOracleAttester(escalation).revoker()) revert PartyCollision();
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
        // WAVE 4b: the arbiter exclusion check that stood here is REMOVED with the field. It read "none of
        // {0, this escrow, the token, the factory} can ever CALL `resolveDispute`, so any of them as
        // arbiter makes every opened dispute unresolvable" — and `resolveDispute` has not existed since
        // Wave 3 replaced the dispute path with the §8.1 state machine. It was validating an input that no
        // function could act on. The adjudication authority that DOES decide money now is the escalation
        // cohort, and it is an implementation immutable checked in the constructor (`escalation != oracle`,
        // distinct revokers) — not a per-job address anyone can get wrong at initialization.
        initialized = true;
        _status = 1;
        payer = p.payer;
        operator = p.operator;
        jobIdHash = p.jobIdHash;
        termsHash = p.termsHash;
        _policyNonce = p.policyNonce;
        _prePolicyRoot = p.prePolicyRoot;
        // BATCH-1 item 3. Deliberately UNVALIDATED: zero is a legitimate value meaning "no accepted-policy
        // commitment for this job". The escrow asserts only that whatever digest is here was signed by both
        // parties and is bound into this clone's address; what it MEANS is composition/oracle's to define.
        _acceptedPolicyDigest = p.acceptedPolicyDigest;
        emit Initialized(p.payer, p.operator, p.jobIdHash);
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
    ///         policy, and the funding parameters that made the veto costless (an unbounded reclaim
    ///         horizon, a gross too small to carry a bond) are rejected here rather than resolved
    ///         later. (The other two — a zero dispute window and a self-selected arbiter — are no longer
    ///         rejected because they are no longer EXPRESSIBLE: Wave 3 retired the dispute path and Wave 4b
    ///         removed the arbiter.) Order is deliberate: freeze -> re-derive the pre-policy root -> constraints
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
    ///           then rejects an expired acceptance, consumes the policy generation (retiring it and every
    ///           older one, failing closed if either party revoked), and validates BOTH acceptance
    ///           signatures against ONE canonical `JobPolicyHash`.
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
                jobIdHash: jobIdHash,
                termsHash: termsHash,
                policyNonce: _policyNonce,
                prePolicyRoot: _prePolicyRoot,
                acceptedPolicyDigest: _acceptedPolicyDigest
            }),
            root,
            msg.sender, // the payer leg is implicit ONLY for a direct payer-sent tx (see `OnlyPayer` above)
            acceptance.expiry,
            acceptance.payerSignature,
            acceptance.operatorSignature
        );

        _jobPolicyHash = ph;
        emit PolicyAccepted(ph, payer, operator, _policyNonce, root);
    }

    /// @notice The complete bilateral-acceptance record in ONE read. A COLLAPSED getter by design: the
    ///         frozen size-reclamation order prefers collapsing read surfaces over four separate dispatch
    ///         entries, and reading the policy atomically is also the correct shape for a verifier.
    ///         `jobPolicyHash_` is zero until the escrow is funded — i.e. until acceptance actually happened.
    ///         BATCH-1 item 3 appends `acceptedPolicyDigest_` as the FINAL return value, so existing tuple
    ///         indices 0-3 are unchanged and any caller destructuring by position keeps working.
    function policy()
        external
        view
        returns (
            address operator_,
            uint256 policyNonce_,
            bytes32 prePolicyRoot_,
            bytes32 jobPolicyHash_,
            bytes32 acceptedPolicyDigest_
        )
    {
        return (operator, _policyNonce, _prePolicyRoot, _jobPolicyHash, _acceptedPolicyDigest);
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

    /// @notice WAVE 4c — the unit's whole frozen fee schedule in ONE read.
    /// @dev    REPLACES eleven one-field accessors (`feeDomainVersion`, `feeChainId`, `escrowOf`,
    ///         `settlementUnitIdOf`, `feeBasisOf`, `gross`, `fee`, `net`, `denominatorOf`,
    ///         `roundingRuleOf`, `feeSplitConfigHashOf`). Each cost a dispatch-table entry, a body, and an
    ///         inlined existence check, on a contract sitting 134 bytes under the EIP-170 ceiling. The
    ///         schedule is written ONCE at funding and frozen thereafter, so a consumer wanting two of
    ///         these fields was already paying two calls to read one immutable record — one struct read is
    ///         strictly better for them.
    ///
    ///         THE THREE FEE SELECTORS THE O5 ATTESTER STATICCALLS ARE DELIBERATELY NOT COLLAPSED HERE.
    ///         `O5AttesterBase._escrowBindingWord` requires `returndatasize() == 32` EXACTLY and reverts
    ///         `EscrowBindingUnreadable` otherwise, so folding `feeScheduleHashOf` / `feeBpsOf` /
    ///         `feeRecipientOf` into a multi-word return would make EVERY `attestO5` revert — nothing
    ///         stolen, but settlement silently degraded to refund-only. They keep their own selectors and
    ///         their exact one-word returns below; `feeBps` / `feeRecipient` appearing in this struct too
    ///         is intentional duplication.
    function feeAmountsOf(bytes32 unitId)
        external
        view
        onlyExisting(unitId)
        returns (uint256 g_, uint256 f_, uint256 n_)
    {
        FeeSchedule storage fs = _units[unitId].feeSchedule;
        return (fs.g, fs.f, fs.n);
    }

    // ── The ONE-WORD fee selectors the O5 attester STATICCALLs. Do not reshape. ───────────────────────
    function feeBpsOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint16) {
        return _units[unitId].feeSchedule.feeBps;
    }

    function feeRecipientOf(bytes32 unitId) external view onlyExisting(unitId) returns (address) {
        return _units[unitId].feeSchedule.feeRecipient;
    }

    function feeScheduleHashOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].feeScheduleHash;
    }

    /// @notice rev-3 §C2/§C3 read surface (M-01): the funding-frozen composition commitment. The oracle
    ///         attester STATICCALLs this to bind its verdict to the SAME root the escrow will check at
    ///         release — without it a stale-root verdict would consume the unit's one-verdict slot and
    ///         permanently strand evidence settlement for that unit.
    function compositionRootOf(bytes32 unitId) external view onlyExisting(unitId) returns (bytes32) {
        return _units[unitId].compositionRoot;
    }

    // NOTE: `compositionSchemaVersionOf`, `payoutConfigHashOf` and `evidenceCommittedOf` are COLLAPSED
    // into `unitTerms` below (WAVE 4c). All three are funding-frozen or one-shot fields that a consumer
    // wants alongside the rest of the unit's terms, never alone.

    // NOTE: `evidenceCommitterOf(bytes32)` is REMOVED (Wave 3c / brief §2.8). The committer is no longer a
    // per-unit configurable authority, so a per-unit getter for it would publish a degree of freedom that
    // does not exist. The successor read surface is the existing `operator()` — one value for the whole
    // clone, which is exactly what the authority now is.

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

    /// @notice WAVE 4c — the unit's remaining funding-frozen TERMS in ONE read.
    /// @dev    Replaces seven one-field accessors (`milestoneIndexOf`, `stepIdOf`, `requestedTierOf`,
    ///         `reclaimAtOf`, `payoutConfigHashOf`, `compositionSchemaVersionOf`, `evidenceCommittedOf`).
    ///         Same reasoning as `feeScheduleOf`: every field here is written once at funding (or, for
    ///         `evidenceCommitted`, once by `submitEvidence`) and a verifier wants them together.
    ///         `requiredTierOf` is NOT folded in — the O5 attester STATICCALLs it and requires a bare
    ///         32-byte return (see `feeScheduleOf`'s note).
    /// @return milestoneIndex_ the unit's milestone position in the job.
    /// @return stepId_ the unit's step identifier within the job.
    /// @return requestedTier_ frozen at funding; `requiredTier == requestedTier` is enforced there.
    /// @return reclaimAt_ the §8.2 C-3 deadline anchor every derived window hangs off.
    /// @return payoutConfigHash_ the frozen payout configuration commitment.
    /// @return compositionSchemaVersion_ rev-3 §C2 (0 = non-composed).
    /// @return evidenceCommitted_ §B — whether an evidence package has been committed. Kept SEPARATE from
    ///         `evidenceBundleHashOf` on purpose: that getter REVERTS while uncommitted so a default zero
    ///         can never read as a valid commitment, which makes this flag the only non-reverting way to
    ///         ask the question.
    function unitTerms(bytes32 unitId)
        external
        view
        onlyExisting(unitId)
        returns (
            uint256 milestoneIndex_,
            bytes32 stepId_,
            uint8 requestedTier_,
            uint256 reclaimAt_,
            bytes32 payoutConfigHash_,
            uint16 compositionSchemaVersion_,
            bool evidenceCommitted_
        )
    {
        Unit storage u = _units[unitId];
        return (
            u.milestoneIndex,
            u.stepId,
            u.requestedTier,
            u.reclaimAt,
            u.payoutConfigHash,
            u.compositionSchemaVersion,
            u.evidenceCommitted
        );
    }

    /// @notice The unit's required assurance tier. ONE-WORD BY CONTRACT — the O5 attester STATICCALLs this
    ///         selector and rejects any return that is not exactly 32 bytes.
    function requiredTierOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint8) {
        return _units[unitId].requiredTier;
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

    // ── ATT-01: the escalation WINDOW ANCHORS, published for the attester ─────────────────────────────
    //
    // WHY THESE EXIST AND WHY THEY LIVE HERE. `O5AttesterBase.adjudicate()` consumed its one-shot
    // (unitId, role, escrow) slot after checking WHICH assertion was under review but never WHETHER the
    // role's window had OPENED. An appeal record written before its window therefore burned the slot
    // permanently, and the legitimate later appeal could not be recorded — an anti-brick gap.
    //
    // The fix binds the window ANCHOR into the adjudication's slot key and signed payload. The anchor
    // cannot be self-declared by the attester or its caller, so it has to be READ FROM THE AUTHORITY on
    // which window applies — and for BOTH roles that authority is this contract, not the attester:
    //   * the APPEAL anchor is `challengedAt`, which only this contract writes;
    //   * the EMERGENCY anchor is the PRIMARY cohort's `disabledAt` — NOT the escalation attester's own —
    //     and, more importantly, whether an emergency window exists AT ALL is decided by the four §8.3 C-5
    //     exclusions that only `_emergencyDeadline` implements. An attester reading a raw `disabledAt`
    //     would gate on a window this escrow does not agree exists.
    //
    // Both are ONE-WORD by contract: the attester STATICCALLs them through a helper that rejects any
    // return that is not exactly 32 bytes. Do not reshape them into multi-return getters.

    /// @notice The APPEAL window's anchor, or 0 if no appeal window is open for this unit.
    /// @dev    Gated on `CHALLENGED` deliberately: outside that state there is no appeal to adjudicate, so
    ///         a zero here is the attester's "this role's window has not opened" signal rather than an
    ///         ambiguous timestamp. The window itself is `challengedAt + APPEAL_WINDOW` — arithmetic the
    ///         caller does for free from a compile-time constant (see the note above `settlement`).
    function challengedAtOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        Unit storage u = _units[unitId];
        // D-1/D-2 (sol cross-family review): "state == CHALLENGED" was NOT the same claim as "an appeal
        // window is OPEN", and the gap was exploitable as a slot burn. Two cases it let through:
        //   D-1 EMPTY WINDOW. `_appealWindow` CAPS `due` at the emergency declaration instant, so a disable
        //      at or before `challengedAt` yields `due <= from` -- no appeal can EVER qualify. `adjudicate`
        //      still accepted a quorum record and CONSUMED the one-shot slot, which `resolveEscalation`
        //      then rejected as `EmergencyPaused`. ATT-01 narrowed the burn window; it did not close it.
        //   D-2 LATE. The anchor stayed non-zero past `due`, so a verdict decided after the window could
        //      still burn the slot before the escrow rejected it on time.
        // Reusing `_appealWindow` is deliberate: it already owns the state guard AND the emergency cap, so
        // this getter cannot drift from the predicate `finalize`/`resolveEscalation` actually apply.
        // COST: this getter now STATICCALLs the primary attester (via `_emergencyDeadline`) and can revert
        // if that attester is unreadable. Accepted — an unreadable primary already fails `finalize` and
        // `resolveEscalation`, so a getter that fails with them is consistent rather than newly fragile.
        // D-2 IS DELIBERATELY *NOT* FIXED HERE, and that is a finding in its own right. Gating this on
        // `block.timestamp < due` — the obvious reading of sol's D-2 — RE-INTRODUCES RELAY-TIME EXPIRY,
        // which is precisely the H-01 bug this contract exists to have deleted: a verdict DECIDED inside
        // its window must stay resolvable FOREVER, because `decidedAt` owns the window and no relayer's
        // inactivity may change the financial outcome. Proven by test, not by argument:
        // `test_WAVE4B_TimelyAppealRecordedBeforeDisable_IsHonoured` fails with that gate in place.
        // The late-record slot burn D-2 describes is therefore ACCEPTED as the cheaper of two evils —
        // a burnable slot on a record the escrow will reject anyway, versus a timely verdict made
        // unrecordable by relay latency.
        // FAIL OPEN ON AN UNREADABLE PRIMARY (sol re-review of 94ee6d5b). The first cut of D-1 called
        // `_emergencyDeadline` directly, which STATICCALLs the primary attester -- and I wrongly accepted
        // that as harmless because "finalize and resolveEscalation revert too". THAT REASONING MISSED THE
        // IRREVERSIBLE PART. Those reverting is TEMPORARY; a missed appeal window is PERMANENT. The attack
        // it opened: quorum submits a valid OVERTURN in-window -> primary is made transiently unreadable
        // -> this getter reverts -> the attester reports EscrowBindingUnreadable and STORES NOTHING -> hold
        // it unreadable past `due`, restore it with disabledAt == 0 -> every later adjudication is stamped
        // LATE and rejected -> `finalize` sees silence and RELEASES, when a timely OVERTURN should have
        // REFUNDED. That is money to the wrong party, introduced by my own fix.
        //
        // So: try the primary, and on ANY failure fall back to the LOCAL `challengedAt`. Failing open is
        // safe HERE and only here, because this getter merely decides whether a record may be WRITTEN --
        // the escrow still applies its own authoritative `[from, due)` check at resolution
        // (`_decidedIn`), so a record admitted under a stale-open window is still rejected on time. The
        // worst residual is the D-2 slot burn, which is financially inert.
        uint256 emergencyDue;
        try IOracleAttester(authorizedOracle).disabledAt() returns (uint64) {
            emergencyDue = _emergencyDeadline(u);
        } catch {
            emergencyDue = 0; // unreadable primary => assume no emergency cap => widest legitimate window
        }
        (uint256 from, uint256 due) = _appealWindow(u, emergencyDue);
        return due > from ? from : 0;
    }

    /// @notice The EMERGENCY review window's anchor, or 0 if no emergency window exists for this unit.
    /// @dev    DERIVED FROM `_emergencyDeadline` RATHER THAN FROM `disabledAt` DIRECTLY, on purpose. That
    ///         function is the sole implementation of the four exclusions (backup lane, already-due
    ///         release, Tier-0, never outliving `reclaimAt`); re-deriving the anchor here would duplicate
    ///         them, and a duplicate is a divergence waiting to happen on the money path. Subtracting the
    ///         window back off the deadline is exact — `_emergencyDeadline` returns either 0 or
    ///         `disabledAt + EMERGENCY_REVIEW_WINDOW` and nothing else — and it cannot underflow, because
    ///         the non-zero branch is only reached after `d != 0` was established.
    function emergencyAnchorOf(bytes32 unitId) external view onlyExisting(unitId) returns (uint256) {
        Unit storage u = _units[unitId];
        // D-3 (sol): `_emergencyDeadline` has no current-time or terminal-state gate, so this reported a
        // live-looking anchor AFTER the review window closed and even after the unit settled — letting a
        // record that the escrow can never apply consume the one-shot emergency slot. Gate both here: the
        // deadline must still be in the future, and the unit must still be in a state an emergency can
        // decide (anything past BACKUP_ASSERTED already has an outcome allocated).
        if (u.state > UnitState.BACKUP_ASSERTED) return 0;
        // Terminal-state gate KEPT (D-3). Time gate DROPPED for the same H-01 reason as the appeal
        // anchor above: an emergency verdict decided inside its review window must remain recordable
        // and resolvable after the window closes.
        uint256 e = _emergencyDeadline(u);
        if (e == 0) return 0;
        return e - VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;
    }

    /// @notice WAVE 4c — the unit's three LIVE counters in ONE read.
    /// @dev    Replaces `liabilityOf`, `payoutCount` and `remainingClaimCountOf`. Unlike `feeScheduleOf` /
    ///         `unitTerms`, these fields MUTATE, which makes the collapse a correctness improvement rather
    ///         than only a size one: three separate calls can straddle a state change and observe a torn
    ///         view (a liability already decremented against a claim count not yet decremented), whereas
    ///         one call cannot. None of the three is in `IEscrowSettlementBinding`, so no attester
    ///         STATICCALL is reshaped.
    /// @return liability_ the unit's outstanding job-collateral liability.
    /// @return payoutCount_ the number of payout legs recorded for the unit.
    /// @return remainingClaimCount_ outstanding collateralized claims; a unit reaches SETTLED_* only at 0 (§7).
    function unitCounters(bytes32 unitId)
        external
        view
        onlyExisting(unitId)
        returns (uint256 liability_, uint256 payoutCount_, uint256 remainingClaimCount_)
    {
        return (_units[unitId].liability, _payouts[unitId].length, _units[unitId].remainingClaimCount);
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

    // NOTE: `remainingClaimCountOf` is COLLAPSED into `unitCounters` above (WAVE 4c).

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
    ///      FOUR EXCLUSIONS (1)-(2) Wave 3c, (3)-(4) the sol 4th-family audit. C-5's load-bearing property
    ///      is that the revoker may INITIATE but
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
    ///      (3) TIER-0 IS EXCLUDED (M-02, sol 4th-family). A Tier-0 unit can enter NEITHER assertion lane
    ///          (`acceptAssertion` rejects `requiredTier < 1`), so there is no settlement for an emergency
    ///          to review and the only thing an emergency could do there is hand the payer an EARLY refund
    ///          at `disabledAt + EMERGENCY_REVIEW_WINDOW`. §8.3 C-6 freezes Tier-0 to "buyer approval or
    ///          reclaim only"; without this exclusion a payer who is also the primary cohort's revoker
    ///          could race that refund months ahead of the bilaterally signed `reclaimAt` — an undocumented
    ///          early-refund authority over a unit the primary cohort has no role in at all.
    ///      (4) IT NEVER OUTLIVES `reclaimAt` (M-03, sol 4th-family). Everything else in §8.1 is anchored
    ///          BACKWARDS from `reclaimAt` so a funded unit provably terminates by its own deadline; this
    ///          one deadline was anchored on `disabledAt` instead and could land up to a full
    ///          EMERGENCY_REVIEW_WINDOW PAST it, with ordinary reclaim permanently excluded — the payer's
    ///          capital locked beyond the date both parties signed. When the review cannot fit, NO
    ///          emergency opens (rather than a truncated one): a shortened window would let the revoker
    ///          pick the moment and thereby the result — disable one second before the appeal expires,
    ///          leave the cohort ~no time to decide, and collect the silence refund — which is precisely
    ///          the C-5 property this exclusion list exists to protect. With no emergency, the unit
    ///          resolves under its ORDINARY windows to the LAST AUTHENTICATED STATE, before `reclaimAt`.
    function _emergencyDeadline(Unit storage u) private view returns (uint256) {
        if (u.backupLane || u.requiredTier == 0) return 0; // (1) + (3)
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
        uint256 e = d + VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;
        if (e > u.reclaimAt) return 0; // (4)
        return e;
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
        // D-4 (sol): CLAMPED NON-ZERO, matching the discipline already applied to `disabledAt` and
        // `decidedAt`. Zero is this system's "no such window" sentinel — `challengedAtOf` returns 0 to mean
        // "no appeal window is open" — so an unclamped genesis timestamp would make a GENUINE challenge
        // indistinguishable from an absent one and permanently unadjudicable. Irrelevant on a live chain;
        // included because the same reasoning was already accepted twice elsewhere and a lone exception is
        // how a sentinel invariant rots.
        uint64 ct = uint64(block.timestamp);
        u.challengedAt = ct == 0 ? 1 : ct;
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
        // M-03 (sol 4th-family): an emergency outcome that is ALREADY DUE is TERMINAL, so escalation may
        // not reach back over it. Escalating sets `backupLane`, which makes `_emergencyDeadline` return 0
        // — i.e. it would ERASE a refund that the §8.3 C-5 clock had already awarded and reopen settlement,
        // leaving "full-G refund vs backup settlement" decided by whichever transaction the block ordered
        // first, PAST a deadline the machine calls terminal. The exclusion is one-sided on purpose: while
        // the emergency is still OPEN, escalating remains the operator's designed recourse against a dead
        // primary cohort (and closes the emergency, per exclusion (1) — a lane whose reviewer is the body
        // just killed has no honest review to wait for).
        uint256 emg = _emergencyDeadline(u);
        if (emg != 0 && block.timestamp >= emg) revert NotActive();
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

        // ── H-01 (sol 4th-family): the ESCALATION DEFAULTS, guarded ONCE ─────────────────────────────
        // Both deadline defaults that an escalation quorum could have pre-empted — the emergency-silence
        // REFUND and the appeal-silence RELEASE — share one gate, because they share one rule: SILENCE
        // means the quorum never DECIDED, not that nobody RELAYED. A record decided inside the window is
        // already authenticated, so it owns this unit's outcome however late it arrives, and the default
        // must stand aside for it. Otherwise a quorum could rule at `due - 1` and the party the ruling
        // went against would simply not relay it and collect the default at `due` — "relayer inactivity
        // must not improve either party's outcome", broken by whoever transacts first.
        // Never a brick: `resolveEscalation` is permissionless and stays callable forever, and
        // `_decidedIn` re-checks exactly the bindings that call re-checks (see it), so every record
        // this defers to is one that somebody can always apply.
        //
        // WAVE 4b — THE GLOBAL RULE (see `_appealWindow`). Two changes, both about not DISCARDING a
        // verdict that was already decided in time:
        //   (a) the APPEAL check now runs even when an emergency is open, because an appeal recorded
        //       BEFORE the declaration is final and the emergency must not erase it. Patching only
        //       `resolveEscalation` would have left `finalize` handing that unit the emergency-silence
        //       refund — first-relayer-wins, moved rather than fixed;
        //   (b) both checks are TWO-SIDED, so a record decided before its own window opened (a
        //       pre-challenge appeal, a pre-declaration emergency) no longer blocks the default forever.
        uint256 emergencyDue = _emergencyDeadline(u);
        // Wait out whichever default deadline governs this state before firing it.
        uint256 defaultDue = emergencyDue != 0
            ? emergencyDue
            : (s == UnitState.CHALLENGED ? uint256(u.challengedAt) + VNextSettlementLib.APPEAL_WINDOW : 0);
        if (defaultDue != 0 && block.timestamp < defaultDue) revert WindowStillOpen();
        // A FINAL appeal owns this unit — checked first, because it is the one that can pre-empt BOTH
        // defaults (its window is capped at `disabledAt`, so it is only ever the strictly earlier verdict).
        if (_appealIsFinal(unitId, u, emergencyDue)) revert WindowStillOpen();
        if (
            emergencyDue != 0
                && _decidedIn(
                    unitId,
                    O5_ADJ_ROLE_EMERGENCY,
                    emergencyDue - VNextSettlementLib.EMERGENCY_REVIEW_WINDOW, // == disabledAt
                    emergencyDue,
                    u.acceptedAssertionId
                )
        ) revert WindowStillOpen();

        if (emergencyDue != 0) {
            // The challenger is made WHOLE — not merely un-penalised. This end refunds the job, so the
            // challenge was vindicated in substance and no delay is chargeable to it; and the emergency
            // is not the challenger's doing either way.
            _disposeBond(unitId, u, BondDisposition.RETURN_ALL);
            _allocateRefund(unitId, _deadlineAuthKey(unitId, u));
            emit Finalized(unitId, false, FINALIZED_REASON_EMERGENCY_SILENCE_REFUND);
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
        // The kill-switch that remains is the one at the SOURCE: `acceptAssertion` refuses an assertion
        // from a disabled cohort, and `O5AttesterBase.attestO5` / `adjudicate` refuse to WRITE one at all.
        // What is gone is only the re-read, at payment time, of a switch whose "on" state the branch above
        // already owns. (The symmetric re-read in `resolveEscalation` is gone too — H-02 — for the
        // stronger reason that it could only ever veto a record written while the cohort was alive.)
        if (s == UnitState.PRIMARY_ASSERTED || s == UnitState.BACKUP_ASSERTED) {
            if (block.timestamp < uint256(u.assertedAt) + VNextSettlementLib.CHALLENGE_WINDOW) {
                revert WindowStillOpen();
            }
            _allocateRelease(unitId, _assertionAuthKey(unitId, u));
            emit Finalized(unitId, true, FINALIZED_REASON_UNCONTESTED_RELEASE);
            emit EvidenceReleased(unitId, u.acceptedAssertionId);
        } else if (s == UnitState.CHALLENGED) {
            // The appeal window (and the H-01 "was it already decided?" guard) were both applied above.
            // §8.3 C-1 — appeal silence ⇒ RELEASE, operator's capped delay-comp, UNUSED BOND RETURNED.
            // The release half is the safety default (silence must not refund, or the payer regains the
            // veto through appeal-liveness failure). The bond half is NOT §2.4: §2.4 disposes of a FAILED
            // challenge, and no challenge failed here — the quorum never ruled. Three reasons this is the
            // frozen rule and not a softening of it:
            //   (a) it costs the operator nothing. `delayCompensation` is paid identically either way; the
            //       old forfeiture sent the remainder to the burn sink, so it bought the operator zero
            //       extra compensation and only destroyed the challenger's capital;
            //   (b) it closes a gain-from-silence. §0's invariant is that NEITHER party improves its
            //       outcome by an authority going quiet. Under forfeiture, an appeal cohort that would
            //       have OVERTURNED could instead go quiet and hand the operator the release AND a
            //       stripped counterparty — a payoff for inducing silence, on the operator's side;
            //   (c) it keeps a revoker out of the financial result (§8.3 C-5). `_emergencyDeadline` reads
            //       only the PRIMARY cohort, and `O5AttesterBase.adjudicate` refuses to WRITE for a
            //       disabled one — so disabling the escalation attester stops any FUTURE appeal verdict
            //       and routes every UNRULED challenge to exactly this line. With forfeiture, pressing
            //       that kill switch WAS a decision to confiscate bonds. (Since H-02 it can no longer
            //       reach a verdict that was ALREADY recorded, which is the other half of the property.)
            // The anti-spam function is not lost: the challenger still pays the operator's full scheduled
            // delay cost. What it no longer pays is a penalty for someone else's failure to rule.
            _disposeBond(unitId, u, BondDisposition.COMP_RETURN);
            _allocateRelease(unitId, _assertionAuthKey(unitId, u));
            emit Finalized(unitId, true, FINALIZED_REASON_APPEAL_SILENCE_RELEASE);
            emit EvidenceReleased(unitId, u.acceptedAssertionId);
        } else if (s == UnitState.BACKUP_PENDING) {
            // §8.1: backup REJECT / timeout ⇒ refund. The backup verdict deadline IS the assertion cutoff.
            if (block.timestamp < _assertionCutoff(u)) revert WindowStillOpen();
            _allocateRefund(unitId, _deadlineAuthKey(unitId, u));
            emit Finalized(unitId, false, FINALIZED_REASON_BACKUP_NO_RELEASE);
        } else {
            revert NotActive(); // FUNDED_ACTIVE with no emergency: `reclaimAfterDeadline` is the exit
        }
    }

    /// @notice §2.5/§8.3 C-5 — apply a typed escalation verdict (APPEAL or Model-B EMERGENCY).
    /// @dev    Permissionless: the escrow READS an immutable, quorum-verified record out of the escalation
    ///         attester and applies its OWN frozen distribution. The record carries no amount and no
    ///         recipient, so this quorum can only select release-or-refund — never move, resize or
    ///         redirect money. There is no signature verification in this contract at all.
    /// @param role `O5_ADJ_ROLE_APPEAL` (only while CHALLENGED, and only for a verdict decided inside
    ///        `[challengedAt, min(appealDue, disabledAt))`) or `O5_ADJ_ROLE_EMERGENCY` (only while an
    ///        emergency is open, for a verdict decided inside `[disabledAt, emergencyDue)`, and only when
    ///        no earlier appeal is already final). WAVE 4b: the two windows are disjoint and exhaustive by
    ///        construction, so exactly one role can ever own a unit — see `_appealWindow`.
    function resolveEscalation(bytes32 unitId, uint8 role) external nonReentrant onlyExisting(unitId) {
        Unit storage u = _units[unitId];
        UnitState s = u.state;
        uint256 emergencyDue = _emergencyDeadline(u);
        uint256 decisionFrom; // the window the verdict had to be DECIDED inside — never "relayed inside"
        uint256 decisionDue;

        if (role == O5_ADJ_ROLE_APPEAL) {
            if (s != UnitState.CHALLENGED) revert NotActive();
            // ── WAVE 4b: THE BLANKET `if (emergencyDue != 0) revert EmergencyPaused()` IS REPLACED ───
            // It read "once an emergency is declared, the appeal quorum no longer decides this unit",
            // and it reverted BEFORE anything consulted the stored `decidedAt` — so it discarded appeals
            // that had ALREADY been recorded, in time, before the disable existed. That is the 4th
            // instance of the H-01 class: relayer inactivity plus a later disable improving the payer's
            // outcome. What replaces it is not a weakening but a BOUND: the appeal's window is CAPPED at
            // the declaration instant, so a verdict recorded before it stands and everything from the
            // declaration onward belongs to the emergency cohort. A merely pre-signed appeal cannot slip
            // through, because `decidedAt` is stamped by the attester at WRITE time and is not a signed
            // field — see `_appealWindow` for the full argument.
            (decisionFrom, decisionDue) = _appealWindow(u, emergencyDue);
            // Also new: a LOWER bound at `challengedAt`. An appeal record can be written any time after
            // the assertion is accepted, i.e. potentially BEFORE the challenge it purports to answer was
            // ever filed; such a verdict ruled on nothing and must not decide this unit.
            if (decisionDue <= decisionFrom) revert EmergencyPaused(); // the emergency owns the whole window
        } else if (role == O5_ADJ_ROLE_EMERGENCY) {
            if (emergencyDue == 0) revert NoEmergency();
            if (s < UnitState.PRIMARY_ASSERTED || s > UnitState.BACKUP_ASSERTED) revert NotActive();
            // WAVE 4b: a LOWER bound at `disabledAt`. `adjudicate` requires only that the ESCALATION
            // cohort is enabled — it never consults the PRIMARY cohort's `disabledAt` — so an EMERGENCY
            // record could be written BEFORE any emergency was declared and then activate once one was.
            // A verdict reviewing a compromise that had not happened yet is a pre-signed veto waiting to
            // pounce; it is now inert, and the unit resolves under its ordinary windows.
            decisionFrom = emergencyDue - VNextSettlementLib.EMERGENCY_REVIEW_WINDOW; // == disabledAt
            decisionDue = emergencyDue;
            // And the emergency DEFERS to a final earlier appeal, so the two roles cannot both apply.
            // Not a brick: the appeal this defers to satisfies the APPEAL branch above by construction,
            // and that branch is permissionless and stays callable forever.
            if (_appealIsFinal(unitId, u, emergencyDue)) revert AppealIsFinal();
        } else {
            revert BadEscalationRole();
        }

        O5AdjudicationRecord memory r =
        // ATT-01: `decisionFrom` IS this role's window anchor -- `challengedAt` for APPEAL (see
        // `_appealWindow`), `disabledAt` for EMERGENCY (line above) -- so the escrow looks the record up
        // under the window it itself derived. A record filed against any other window is NOT FOUND, which
        // is the correct fail-closed answer. The cast is safe: both branches derive from uint64 storage.
            IOracleAttester(escalationAttester).adjudicationOf(unitId, role, address(this), uint64(decisionFrom));
        if (r.adjudicationId == bytes32(0)) revert AttestationNotFound();
        if (r.escrow != address(this)) revert WrongRecipient();
        // Assertion-specific by construction: a verdict signed over one assertion cannot be applied to
        // another, and `acceptedAssertionId` is nonzero only in the accepted states gated above.
        if (r.reviewedAssertionId != u.acceptedAssertionId) revert IdentityMismatch();
        // ── H-01 (sol 4th-family): THE RECORDED DECISION TIME OWNS THE WINDOW ────────────────────────
        // This check was `block.timestamp >= <deadline>`, i.e. it expired an ALREADY-AUTHENTICATED verdict
        // on RELAY time. `decidedAt` proves when the quorum ruled, and it was stored but never read; so a
        // quorum could record a timely EMERGENCY UPHOLD at `emergencyDue - 1`, nobody would relay this
        // call, and at `emergencyDue` the payer's `finalize` collected the silence refund — the §0
        // invariant's "relayer inactivity must not improve the payer's outcome", broken in one line. The
        // appeal role broke it symmetrically, discarding a timely OVERTURN into the release default.
        // A record decided INSIDE its window therefore stays resolvable forever (this call is
        // permissionless, so it cannot be withheld), and the deadline defaults in `finalize` stand aside
        // for it. What the deadline still bounds is what it always meant to bound: a verdict DECIDED late.
        // WAVE 4b adds the symmetric LOWER bound — a verdict DECIDED EARLY, before the window it answers
        // had opened, is equally not an answer to it. `[decisionFrom, decisionDue)`.
        if (uint256(r.decidedAt) < decisionFrom || uint256(r.decidedAt) >= decisionDue) revert WindowStillOpen();
        // ── H-02 (sol 4th-family): THE `disabledAt() != 0` RE-CHECK THAT STOOD HERE IS REMOVED ───────
        // It could not do the job it claimed. `O5AttesterBase.adjudicate` refuses a disabled cohort, so
        // EVERY stored record necessarily predates the disable — the check could never reject a
        // post-disable record because none can exist. What it actually did was let the escalation cohort's
        // revoker, AFTER seeing an immutable verdict it disliked, delete that verdict's effect and take the
        // silence default instead: suppress an EMERGENCY UPHOLD and collect the refund, suppress an APPEAL
        // OVERTURN and force the release, or suppress an UPHOLD to change the bond disposition. That is
        // §8.3 C-5 inverted — the revoker CHOOSING the financial result, not merely initiating a review.
        // The residual is stated plainly rather than papered over: a compromised escalation cohort's
        // pre-disable record now stands, because there is no fourth authority to review it. That is the
        // SAME shape the primary lane already accepts — an accepted primary assertion is not voided by a
        // later disable either; it is reviewed (Model B) — and it is strictly better than a kill-switch
        // that doubles as a verdict veto.

        bool upheld = r.outcome == O5_ADJ_UPHOLD; // the attester admits only UPHOLD | OVERTURN
        bytes32 authKey = _authorizationKey(
            AuthorizationType.DISPUTE, AUTHDOMAIN_DISPUTE, escalationAttester, r.adjudicationId, unitId
        );
        // §2.4 compensate-then-burn on a failed challenge; full return on a successful one. This is the
        // ADJUDICATED branch — a quorum ruled on the exact accepted assertion — so it is the one place a
        // burn is a finding rather than an assumption. (Both roles qualify: the EMERGENCY reviewer decides
        // the same assertion on its merits, and an UPHOLD from it means the challenge was wrong.)
        _disposeBond(unitId, u, upheld ? BondDisposition.COMP_BURN : BondDisposition.RETURN_ALL);
        if (upheld) {
            _allocateRelease(unitId, authKey);
            emit EvidenceReleased(unitId, u.acceptedAssertionId);
        } else {
            _allocateRefund(unitId, authKey);
        }
        emit EscalationResolved(unitId, r.adjudicationId, role, upheld);
    }

    /// @dev §2.4 slash waterfall + §8.3 C-1. The operator's delay compensation is the SAME capped,
    ///      pre-agreed schedule amount in both `COMP_*` dispositions; the only thing the disposition
    ///      changes is where the UNUSED remainder goes — the sink (`COMP_BURN`) or back to the challenger
    ///      (`COMP_RETURN`). That is the whole point of separating them, and it is why "forfeit on
    ///      silence" was not a stricter version of the same rule: it paid the operator not one wei more,
    ///      so its extra severity was pure destruction of the challenger's capital, triggered by an event
    ///      the challenger did not cause and could not prevent.
    ///
    ///      WHERE THE LINE FALLS. Burning is a PENALTY and a penalty needs a FINDING:
    ///        * an adjudicated loss (appeal UPHOLD, emergency UPHOLD) is a finding -> `COMP_BURN`;
    ///        * an adjudicated win (OVERTURN) means no delay is chargeable at all -> `RETURN_ALL`;
    ///        * silence — the appeal quorum never ruled, or its cohort was disabled so it never could —
    ///          is the ABSENCE of a finding -> `COMP_RETURN` (§8.3 C-1: "SETTLE releases + fixed
    ///          delay-comp to the operator + unused challenger bond returned").
    ///      Three properties survive intact: the remainder still never reaches a treasury or a
    ///      counterparty on a lost challenge, winning is still never a profit (the operator's take is
    ///      capped by `delayCompensation` in every branch), and the job buckets are never touched here.
    ///      Called BEFORE the job allocation so the bond buckets are already correct when
    ///      `_requireSolvent()` runs inside the allocator.
    function _disposeBond(bytes32 unitId, Unit storage u, BondDisposition d) private {
        uint256 b = u.bond;
        if (b == 0) return;
        u.bond = 0;
        uint256 comp = d == BondDisposition.RETURN_ALL ? 0 : VNextSettlementLib.delayCompensation(u.feeSchedule.g, b);
        uint256 rest = b - comp;
        bool burn = d == BondDisposition.COMP_BURN;
        // Move the value between buckets FIRST: the totals must stay exact even if a leg becomes a claim.
        // Only the compensated part ever leaves the bond bucket unless the remainder is being burned — a
        // returned remainder is still challenger money and stays collateralized as `BOND` throughout.
        bondLiability -= burn ? b : comp;
        compLiability += comp;
        if (burn) burnLiability += rest;
        _settleLeg(unitId, u, VNextSettlementLib.DELAY_COMP_LEG_INDEX, ClaimClass.DELAY_COMP, operator, comp);
        if (burn) {
            _settleLeg(unitId, u, VNextSettlementLib.BURN_LEG_INDEX, ClaimClass.BURN, VNextSettlementLib.BURN_SINK, rest);
        } else {
            _settleLeg(unitId, u, VNextSettlementLib.BOND_LEG_INDEX, ClaimClass.BOND, u.challenger, rest);
        }
        emit BondDisposed(unitId, comp, rest, burn);
    }

    /// @dev H-01 — "did the escalation quorum already DECIDE this, INSIDE its own window?" Read as ONE WORD
    ///      (the attester applies the escrow/assertion bindings itself and answers `type(uint64).max` —
    ///      "never" — when nothing applies), so a deadline default costs one staticcall and two comparisons
    ///      rather than a full record decode on a contract at its EIP-170 ceiling.
    ///
    ///      WHY A DEFAULT MUST STAND ASIDE FOR IT, and why that is not a brick: the bindings checked
    ///      attester-side are EXACTLY the ones `resolveEscalation` re-checks (record exists, bound to this
    ///      escrow, reviews this unit's accepted assertion), and that function is permissionless and stays
    ///      callable forever. So every record this returns true for is one that SOMEBODY can always
    ///      apply — deferring to it can delay a unit but can never strand one. A record naming a different
    ///      escrow, or a different assertion, answers "never" and the ordinary default proceeds untouched.
    ///
    ///      WAVE 4b — THE WINDOW IS NOW TWO-SIDED: `[from, due)`, not just `< due`. An upper bound alone
    ///      admitted verdicts decided BEFORE the window they claim to answer even opened — a pre-challenge
    ///      APPEAL and a pre-declaration EMERGENCY (see `resolveEscalation`). Both are the same defect and
    ///      both are closed by the same `from`.
    function _decidedIn(bytes32 unitId, uint8 role, uint256 from, uint256 due, bytes32 acceptedId)
        private
        view
        returns (bool)
    {
        uint256 d = uint256(
            // ATT-01: `from` IS the window anchor for both roles, so the lookup is scoped to exactly the
            // window being asked about. A verdict recorded against a different window is not found here.
            IOracleAttester(escalationAttester).adjudicationDecidedAt(
                unitId, role, address(this), acceptedId, uint64(from)
            )
        );
        return d >= from && d < due;
    }

    /// @dev WAVE 4b (the GLOBAL appeal rule) — the half-open window `[from, due)` inside which an APPEAL
    ///      verdict for this unit is FINAL. `due <= from` means no appeal can qualify.
    ///
    ///      THE RULE, stated once and applied in all three places that could otherwise disagree
    ///      (`finalize`, `resolveEscalation(APPEAL)`, `resolveEscalation(EMERGENCY)`):
    ///          challengedAt <= appeal.decidedAt    <  min(appealDue, disabledAt)  => APPEAL is final
    ///          disabledAt   <= emergency.decidedAt <  emergencyDue                => EMERGENCY owns
    ///      AT EQUALITY, EMERGENCY WINS — `<` on the appeal's upper bound, `<=` on the emergency's lower
    ///      one. Timestamps cannot order two transactions inside one block, so a tie must be broken by a
    ///      stated rule rather than by whichever call is mined first; the emergency (a declared systemic
    ///      compromise) is the safer owner of an ambiguous instant.
    ///
    ///      WHY THIS IS THE 4th INSTANCE OF THE H-01 CLASS. `resolveEscalation(APPEAL)` reverted
    ///      `EmergencyPaused` the moment ANY emergency was open, before anything consulted the stored
    ///      `decidedAt`. So an appeal quorum could record a timely verdict, nobody would relay it, and a
    ///      LATER disable would erase it — relayer inactivity plus a disable improving the payer's outcome,
    ///      which is exactly the invariant §0 exists to protect and exactly what H-01/H-02 fixed elsewhere.
    ///
    ///      WHY DEFERRING TO AN EARLIER APPEAL IS SAFE — i.e. why this does NOT reopen the pre-signed-appeal
    ///      hole that the blanket `EmergencyPaused` was protecting. `decidedAt` is stamped by the ATTESTER
    ///      from `block.timestamp` when it WRITES the record (`O5AttesterBase.adjudicate`), and it is not a
    ///      field of the signed struct (`_adjDigest` does not cover it), so signers cannot supply or
    ///      backdate it. A merely pre-signed, unrecorded appeal submitted after the declaration therefore
    ///      lands with `decidedAt >= disabledAt` and is REJECTED — the anti-capture property is intact.
    ///      What is honoured is only a strictly EARLIER ON-CHAIN RECORD, which is already an immutable
    ///      quorum decision; letting the revoker erase THAT is the financial veto H-02 removed.
    function _appealWindow(Unit storage u, uint256 emergencyDue) private view returns (uint256 from, uint256 due) {
        if (u.state != UnitState.CHALLENGED) return (0, 0); // no appeal is in play for any other state
        from = uint256(u.challengedAt);
        due = from + VNextSettlementLib.APPEAL_WINDOW;
        if (emergencyDue != 0) {
            // `_emergencyDeadline` returns `disabledAt + EMERGENCY_REVIEW_WINDOW`, so the declaration
            // instant is recoverable exactly, with no second staticcall to the attester.
            uint256 declaredAt = emergencyDue - VNextSettlementLib.EMERGENCY_REVIEW_WINDOW;
            if (declaredAt < due) due = declaredAt;
        }
    }

    /// @dev Does a FINAL appeal verdict exist for this unit? (The rule above, as one predicate.)
    function _appealIsFinal(bytes32 unitId, Unit storage u, uint256 emergencyDue) private view returns (bool) {
        (uint256 from, uint256 due) = _appealWindow(u, emergencyDue);
        return due > from && _decidedIn(unitId, O5_ADJ_ROLE_APPEAL, from, due, u.acceptedAssertionId);
    }

    /// @notice M-04 — issue ONE ERC-1271 `isValidSignature` staticcall FROM THIS CLONE, for the factory.
    /// @dev    Wave 4a moved signature validation into the factory for bytecode economy; that silently
    ///         changed the `msg.sender` a smart-account signer observes from the clone to the factory, and
    ///         ERC-1271 explicitly permits caller-aware validation. This relay restores the pre-Wave-4a
    ///         caller for every 1271 check the factory performs on this clone's behalf, at the cost of one
    ///         small function rather than the whole EIP-712 + ECDSA machinery coming back.
    ///
    ///         It is SAFE because of what it cannot do: it is `view` (so callers reach it by STATICCALL and
    ///         it can write nothing, here or downstream), the inner call is a STATICCALL, it returns the
    ///         first returndata word verbatim and decides nothing (the factory compares it to the magic
    ///         value), and it is gated to `factory` — which is an implementation immutable this contract
    ///         already trusts unconditionally. The gate matters: without it, ANY caller could make an
    ///         arbitrary read-only call appear to originate from this escrow, which is precisely the
    ///         caller-aware trust this fix exists to preserve. `data` is required to be an
    ///         `isValidSignature` call so the relay stays what its name says it is.

    /// @notice M-04 — issue ONE ERC-1271 `isValidSignature` STATICCALL FROM THIS CLONE, for the factory.
    /// @dev    WHY IT EXISTS. Wave 4a moved signature validation into the factory for bytecode economy.
    ///         The digest was unaffected (it is still built over this clone's own EIP-712 domain), but the
    ///         `msg.sender` a smart-account signer observes changed from the clone to the factory — and
    ///         ERC-1271 explicitly permits CALLER-AWARE validation. A caller-aware wallet that only honours
    ///         its owner's signatures when the query comes from ITS escrow therefore stopped validating
    ///         entirely: e.g. a smart-account payout recipient holding a failed-payment claim could never
    ///         authorize a destination rotation again, leaving that claim permanently unpayable. This relay
    ///         restores the pre-Wave-4a caller for every 1271 check the factory performs on this clone's
    ///         behalf — bilateral acceptance at funding, and buyer-approval / claim-rotation through
    ///         `verifyCloneSignature` — for one small function instead of the whole EIP-712 + ECDSA
    ///         machinery coming back.
    ///
    ///         WHY IT IS SAFE. It is `view` (callers reach it by STATICCALL; nothing here or downstream can
    ///         write), the inner call is a STATICCALL, it decides NOTHING (it returns the first returndata
    ///         word verbatim and the factory compares it to the magic value), and it is gated to `factory`
    ///         — an implementation immutable this contract already trusts unconditionally and already
    ///         delegates every signature predicate to. The gate is load-bearing: without it ANY caller
    ///         could make a read-only call appear to originate from this escrow, which is exactly the
    ///         caller-aware trust this fix exists to preserve. The relayed calldata is required to be an
    ///         `isValidSignature` call, so the relay stays what its name says it is.
    ///
    ///         CALLING CONVENTION. The 1271 calldata is appended AFTER this function's 36-byte head rather
    ///         than passed as a `bytes` argument: on a contract at its EIP-170 ceiling, ABI-decoding one
    ///         dynamic argument costs ~75 B more than reading the tail directly, and the payload is
    ///         forwarded verbatim either way. The factory builds it with
    ///         `bytes.concat(abi.encodeWithSelector(erc1271Check.selector, signer), <1271 calldata>)`.
    ///         Any other returndata shape leaves `word` zero, which the factory reads as "did not validate"
    ///         — fail-closed.
    function erc1271Check(address signer) external view returns (bytes32 word) {
        if (msg.sender != factory) revert OnlyFactory();
        assembly ("memory-safe") {
            let n := sub(calldatasize(), 0x24)
            let p := mload(0x40)
            calldatacopy(p, 0x24, n)
            // Narrow the relay to ERC-1271 and nothing else. Read from CALLDATA, not from the copy: a
            // short tail reads as zeros there by EVM rule, whereas unwritten memory is merely usually
            // zero. A non-1271 payload (or any other returndata shape) simply leaves `word` at zero, which
            // the factory reads as "did not validate" — fail-closed, and one branch instead of a revert.
            if eq(shr(224, calldataload(0x24)), 0x1626ba7e) {
                if staticcall(gas(), signer, p, n, p, 0x20) {
                    if eq(returndatasize(), 0x20) { word := mload(p) }
                }
            }
        }
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
        // BATCH-1 item 2 (gen-UI's ask). WITHOUT this emit, a deadline reclaim produced a BARE
        // `RefundAllocated` with no companion event, so the read surface could only identify the cause BY
        // ELIMINATION — "a RefundAllocated with no `Finalized` and no `EscalationResolved` in the same tx".
        // That derivation is silently broken by any future path that emits a bare `RefundAllocated`, which
        // makes a MONEY-CAUSE label depend on an invariant nothing enforces. Now the cause is WITNESSED.
        // Reason 4 joins the codes emitted by `finalize`: 0 uncontested release, 1 appeal-silence release,
        // 2 backup-no-release refund, 3 emergency-silence refund.
        emit Finalized(unitId, false, FINALIZED_REASON_DEADLINE_RECLAIM);
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
