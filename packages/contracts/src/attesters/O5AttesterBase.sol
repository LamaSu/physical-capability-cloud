// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    O5Verdict,
    O5Assertion,
    O5Adjudication,
    O5AdjudicationRecord,
    O5_DECISION_SETTLE,
    O5_ADJ_ROLE_APPEAL,
    O5_ADJ_ROLE_EMERGENCY,
    O5_ADJ_UPHOLD,
    O5_ADJ_OVERTURN
} from "../O5Types.sol";
import {IOracleAttester} from "../interfaces/IOracleAttester.sol";
import {IEAS, AttestationRequest, AttestationRequestData} from "../interfaces/IEAS.sol";
import {VNextSettlementLib} from "../libraries/VNextSettlementLib.sol";

/// @notice The minimal settlement-escrow READ surface this attester binds a verdict to before it consumes
///         a unit's one-verdict slot. Implemented by {VNextSettlementEscrow}; only ever STATICCALLed. Every
///         getter here reads a value FROZEN AT FUNDING and returns exactly one word. They all revert for a
///         unit that does not exist, and `evidenceBundleHashOf` also reverts when nothing has been committed
///         — "unreadable" is the correct fail-closed answer in each of those cases.
interface IEscrowSettlementBinding {
    function compositionRootOf(bytes32 unitId) external view returns (bytes32);
    function evidenceBundleHashOf(bytes32 unitId) external view returns (bytes32);
    function feeScheduleHashOf(bytes32 unitId) external view returns (bytes32);
    // M-01: the RAW fee fields the permanent attestation records. `feeScheduleHash` commits to these, but
    // downstream indexers/receipts/composition read the raw words, so they are pre-checked in their own right.
    function feeBpsOf(bytes32 unitId) external view returns (uint16);
    function feeRecipientOf(bytes32 unitId) external view returns (address);
    function requiredTierOf(bytes32 unitId) external view returns (uint8);
    /// @dev H-01 Wave 3 anti-brick pre-check for `adjudicate`: the assertion id the escrow ACCEPTED for
    ///      this unit (zero while nothing is accepted). Same discipline as the M-01 pre-checks — an
    ///      adjudication the escrow would reject must never burn the unit's one adjudication slot.
    function acceptedAssertionIdOf(bytes32 unitId) external view returns (bytes32);
    /// @dev P0-6 mirror only (NOT a money-path read): the escrow's authoritative settlement state for the
    ///      unit, emitted as the "settlement receipt" leg of the `O5Mirrored` link. The real escrow returns
    ///      the `UnitState` enum; declared `uint8` here because a selector depends only on name + inputs,
    ///      and this interface must not import the settlement library just to name a return type.
    function unitState(bytes32 unitId) external view returns (uint8);
}

/**
 * @title O5AttesterBase
 * @notice Shared money-path logic for a cohort-scoped O5 verdict attester (addendum §A). A concrete
 *         cohort supplies only its M-of-N signer rule via {_verifySignatures}; everything else — the
 *         EIP-712 digest, the cohort/epoch binding, the escrow↔verdict binding, one-verdict-per-unit,
 *         the one-way kill-switch, and the assertion record — is written and audited ONCE here.
 *
 *         P0-6 (§13R.1 / adjudication §2): the money path writes a DIRECT COHORT ASSERTION into this
 *         contract's own storage. It does NOT touch EAS. The four reasons are architectural, not gas:
 *         synchronous EAS was (1) a mandatory global write dependency on the money path, (2) one shared
 *         failure domain across every bound Tier-1..3 cohort, (3) an extra pre-settlement state
 *         transition, and (4) an immutable dependency for jobs that were ALREADY funded — so an EAS
 *         stall pushed every active Tier>=1 job toward refund. EAS is now an ASYNCHRONOUS provenance
 *         mirror (`mirrorToEAS`): permissionless, replayable from the on-chain assertion, and reachable
 *         from no money path in either contract. A long EAS outage therefore leaves a drainable queue
 *         (every assertion whose `mirroredUid` is still zero), never a permanently unattested settlement.
 *
 *         Trust-root properties (§A.1 money-path invariants):
 *         - Signer set + threshold are IMMUTABLE by construction in each concrete (no upgrade/module/
 *           guard/rotation/re-enable) — a mutable Safe cannot be substituted behind the address.
 *         - EOA-only ECDSA recovery (no ERC-1271) with low-s + canonical-v malleability guards — a
 *           mutable smart-account signer cannot satisfy the quorum.
 *         - `disable()` is ONE-WAY, and its reach is bounded ON PURPOSE: it stops this cohort WRITING
 *           anything further (`attestO5` and `adjudicate` both refuse a disabled cohort) and the escrow
 *           refuses to ACCEPT a pre-written assertion from it. It does NOT retroactively void what the
 *           escrow already accepted — that is what the §8.3 C-5 Model-B emergency REVIEWS — and, since the
 *           H-02 finding, it does not void an already-recorded adjudication either: because a record can
 *           only be written while the cohort is alive, a runtime "is it still enabled?" re-check could
 *           never reject a post-disable record, only hand the revoker a veto over a valid verdict.
 *         - One O5 per `settlementUnitId` (consume-once) is enforced in-contract, and the assertion
 *           record IS that marker — it is written exactly once and never mutated afterwards.
 *         - Because that slot is consumable exactly once, every field the ESCROW will re-check at release
 *           and that this contract cannot derive itself is read back from the escrow BEFORE the slot is
 *           consumed (M-01 anti-brick pre-check) — a verdict the escrow would reject can never burn the slot.
 * @dev    The escrow only READS `enabled` / `cohortId` / `assertionOf`; it never calls `attestO5` or
 *         `mirrorToEAS`. Refund/reclaim in the escrow never call this contract, so a controller fault can
 *         freeze RELEASE but never REFUND.
 */
abstract contract O5AttesterBase is IOracleAttester {
    // ── Immutable cohort config ────────────────────────────────────────────────────────────────────
    /// @dev EAS registry the ASYNC MIRROR writes into. Never read or written by `attestO5`, and never
    ///      reachable from the escrow's money path — that is the whole point of P0-6.
    address public immutable eas;
    bytes32 public immutable o5SchemaUid; // the pinned O5 v1.1 schema UID (mirror payload + escrow pin)
    uint64 public immutable cohortId; // this cohort's label (IOracleAttester.cohortId)
    address public immutable revoker; // kill-switch holder (separately custodied from signing keys)

    // ── One-way kill-switch + consume-once ─────────────────────────────────────────────────────────
    bool public enabled; // IOracleAttester.enabled — starts true, one-way to false
    /// @dev H-01 §8.3 C-5 (Model B): the block timestamp `disable()` was called at; 0 while enabled.
    ///      WRITE-ONCE by construction — `disable()` is one-way and refuses a second call — which is what
    ///      makes the escrow's emergency deadline (`disabledAt + EMERGENCY_REVIEW_WINDOW`) IMMUTABLE. The
    ///      revoker cannot extend it, cannot reset it, and cannot decide the financial outcome with it.
    ///      Packed into the same slot as `enabled`.
    uint64 public disabledAt;

    /// @dev settlementUnitId => the immutable cohort assertion. Write-once: `attestO5` is the only writer
    ///      and refuses a unit that already has one, so no code path mutates a written record. This
    ///      mapping IS the consume-once marker (`usedUnit` below is a view over it), which is why the
    ///      money path costs one record write and no separate flag slot.
    mapping(bytes32 => O5Assertion) internal _assertions;

    /// @dev keccak256(abi.encode(settlementUnitId, role, escrow)) => the immutable escalation adjudication.
    ///      Write-once per (unit, role, escrow): `adjudicate` is the only writer and refuses an occupied
    ///      slot, so the APPEAL verdict and the Model-B EMERGENCY verdict are independent one-shot
    ///      decisions and neither can consume the other's slot.
    ///      M-05: `escrow` joined the key because nothing here can REBIND a claimed escrow to a unit — the
    ///      unit id commits to its escrow by construction, but a keccak cannot be inverted to recover it.
    ///      So a quorum-signed record naming the WRONG escrow used to consume the RIGHT escrow's slot and
    ///      brick it (the real escrow rejects a foreign record, and the slot can never be rewritten). With
    ///      `escrow` in the key such a record occupies only its own slot.
    mapping(bytes32 => O5AdjudicationRecord) internal _adjudications;

    /// @dev settlementUnitId => the EAS uid of the ASYNC provenance mirror; zero = not yet mirrored.
    ///      The un-mirrored set is exactly the drainable queue after an EAS outage. Nothing on any money
    ///      path reads this.
    mapping(bytes32 => bytes32) public mirroredUid;

    // ── EIP-712 (domain binds chainId + this verifier; the struct binds every O5 field) ─────────────
    // The domain has NO `salt`: a per-cohort attester is deployed at its own address, so `verifyingContract`
    // already separates cohorts, and `oracleAuthEpoch` (checked == cohortId in attestO5) binds the cohort
    // INSIDE the signed struct. `salt = bytes32(cohortId)` was therefore cryptographically redundant, and
    // `salt` is EIP-712's least-supported domain field off-chain — dropping it removes a live mirroring
    // hazard. The domain is now the standard 4-field EIP-712 domain.
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME_HASH = keccak256(bytes("PCC:O5Attester"));
    bytes32 private constant EIP712_VERSION_HASH = keccak256(bytes("1"));
    bytes32 private constant O5_TYPEHASH = keccak256(
        "O5Verdict(bytes32 jobIdHash,uint256 milestoneIndex,bytes32 stepId,bytes32 evidenceBundleHash,uint8 achievedTier,uint8 requestedTier,uint8 decision,bytes32 verdictHash,uint16 feeBps,address feeRecipient,bytes32 feeScheduleHash,bytes32 settlementUnitId,uint64 oracleAuthEpoch,bytes32 compositionRoot)"
    );
    /// @dev H-01 §2.5 — the escalation adjudication type. A SEPARATE typehash from `O5_TYPEHASH` under the
    ///      SAME domain, so an O5 SETTLE signature can never be replayed as an UPHOLD (and vice versa), and
    ///      `role` inside the struct separates APPEAL from EMERGENCY for the same reason.
    bytes32 private constant O5_ADJUDICATION_TYPEHASH = keccak256(
        "O5Adjudication(bytes32 settlementUnitId,address escrow,bytes32 reviewedAssertionId,uint8 role,uint8 outcome,uint64 oracleAuthEpoch)"
    );
    /// @dev secp256k1 n/2 — reject high-s (malleable) signatures (EIP-2 canonical form).
    uint256 private constant ECDSA_S_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /// @notice A cohort assertion was written. `verdict` carries the FULL `abi.encode(O5Verdict)` payload
    ///         (448 B) so the assertion is replayable into the EAS mirror from on-chain data alone — the
    ///         record itself deliberately stores a digest rather than 14 words (§13R.1).
    event O5Asserted(
        bytes32 indexed settlementUnitId,
        bytes32 indexed assertionId,
        address indexed escrow,
        uint64 cohort,
        bytes verdict
    );
    /// @notice The async EAS provenance mirror completed for an assertion. Carries the full link
    ///         {cohort, settlementUnitId, assertionId, verdictHash, settlement receipt}: `escrowUnitState`
    ///         is the escrow's own authoritative settlement state for the unit at mirror time (the
    ///         `UnitState` enum), read tolerantly — see `_tolerantUnitState`.
    event O5Mirrored(
        bytes32 indexed settlementUnitId,
        bytes32 indexed assertionId,
        bytes32 indexed easUid,
        uint64 cohort,
        address escrow,
        bytes32 verdictHash,
        uint256 escrowUnitState
    );
    event CohortDisabled(uint64 indexed cohortId);
    /// @notice A typed escalation adjudication (appeal or Model-B emergency) was written.
    event O5Adjudicated(
        bytes32 indexed settlementUnitId,
        bytes32 indexed adjudicationId,
        address indexed escrow,
        uint8 role,
        uint8 outcome,
        bytes32 reviewedAssertionId
    );

    error ZeroAddress();
    error ZeroSigner();
    error DuplicateSigner();
    error OnlyRevoker();
    error CohortIsDisabled();
    error CohortMismatch();
    error EscrowVerdictMismatch();
    error NotSettleVerdict();
    error UnitAlreadyAttested();
    error WrongSignatureCount();
    error SignersNotSortedOrUnique();
    error NotAuthorizedSigner();
    error MalleableSignature();
    error BadSignatureLength();
    error BadSignatureV();
    error BadSignature();
    error RevokerIsSigner();
    error EscrowBindingUnreadable();
    error InvalidAttestationUid();
    error ZeroAssertionId();
    error AssertionNotFound();
    error AlreadyMirrored();
    error VerdictDigestMismatch();
    // The M-01 pre-check errors deliberately mirror the escrow's release-check names one-for-one, so a
    // trace shows exactly which release check the verdict would have failed.
    error CompositionRootMismatch();
    error EvidenceBundleMismatch();
    error FeeHashMismatch();
    error FeeBpsMismatch();
    error FeeRecipientMismatch();
    error TierOutOfRange();
    error Tier0NotEvidence();
    error TierNotMet();
    error RequestedTierMismatch();
    // Wave 3 (escalation adjudication)
    error BadAdjudicationRole();
    error BadAdjudicationOutcome();
    error UnitAlreadyAdjudicated();
    error ZeroReviewedAssertion();
    error ReviewedAssertionMismatch();

    constructor(address eas_, bytes32 o5SchemaUid_, uint64 cohortId_, address revoker_) {
        if (eas_ == address(0) || revoker_ == address(0)) revert ZeroAddress();
        eas = eas_;
        o5SchemaUid = o5SchemaUid_;
        cohortId = cohortId_;
        revoker = revoker_;
        enabled = true;
    }

    /// @notice One-way, permanent cohort kill-switch (revoker only). No re-enable exists by construction.
    /// @dev H-01 §8.3 C-5: `disabledAt` is stamped in the SAME one-way move, so it is written at most
    ///      once. A second call reverts (`CohortIsDisabled`), which is what forbids the revoker from
    ///      resetting or extending the escrow-side emergency deadline derived from it.
    function disable() external {
        if (msg.sender != revoker) revert OnlyRevoker();
        if (!enabled) revert CohortIsDisabled();
        enabled = false;
        // Never store a zero: the escrow reads `disabledAt != 0` as "this cohort is dead", and a genesis
        // timestamp of 0 must not read as "still alive". Fail-closed by clamping to 1.
        uint64 t = uint64(block.timestamp);
        disabledAt = t == 0 ? 1 : t;
        emit CohortDisabled(cohortId);
    }

    /// @notice The canonical O5 EIP-712 digest the cohort signers sign — exposed for the off-chain mirror.
    function digestOf(O5Verdict calldata v) external view returns (bytes32) {
        return _digest(v);
    }

    /// @inheritdoc IOracleAttester
    /// @dev L-02: the cohort's LIVE O5 EIP-712 type hash. The escrow carries a `o5TypeHash` deployment pin
    ///      and, when that pin is non-zero, requires it to equal this value at construction — so an
    ///      off-chain signer mirroring the escrow's published pin can never sign a digest under a type hash
    ///      this cohort does not use. Exposed (not private) precisely so that check can exist.
    function o5TypeHash() external pure returns (bytes32) {
        return O5_TYPEHASH;
    }

    /// @inheritdoc IOracleAttester
    function assertionOf(bytes32 settlementUnitId) external view returns (O5Assertion memory) {
        return _assertions[settlementUnitId];
    }

    /// @notice Whether this unit's one verdict slot has been consumed (one O5 per `settlementUnitId`).
    /// @dev    Derived from the assertion record rather than a separate flag: the record is written
    ///         exactly once, so `assertionId != 0` IS "already attested". Same semantics and same public
    ///         ABI as the former storage mapping, one fewer money-path slot write.
    function usedUnit(bytes32 settlementUnitId) external view returns (bool) {
        return _assertions[settlementUnitId].assertionId != bytes32(0);
    }

    /// @inheritdoc IOracleAttester
    function attestO5(O5Verdict calldata v, address escrow, bytes[] calldata signatures)
        external
        returns (bytes32 assertionId)
    {
        if (!enabled) revert CohortIsDisabled();
        if (v.oracleAuthEpoch != cohortId) revert CohortMismatch();

        // Bind the settling escrow to the verdict. `settlementUnitId` already commits
        // (chainId, escrow, jobIdHash, milestoneIndex, stepId); recomputing it and requiring equality
        // guarantees the assertion's bound escrow is exactly the escrow the quorum signed for. This is
        // ALSO what lets the escrow's release path drop four field-by-field identity comparisons: the
        // escrow independently recomputes the same id from ITS frozen fields, so equality there plus this
        // equality here pins jobIdHash / milestoneIndex / stepId / escrow by collision resistance.
        bytes32 suid =
            VNextSettlementLib.computeSettlementUnitId(block.chainid, escrow, v.jobIdHash, v.milestoneIndex, v.stepId);
        if (suid != v.settlementUnitId) revert EscrowVerdictMismatch();

        // M-of-N quorum over the canonical digest (concrete rule). Reverts unless the quorum is met.
        // The digest doubles as the assertion id: it is the FULL signed verdict hash (all 14 fields plus
        // the EIP-712 domain), so recording it binds the entire verdict even though the escrow only
        // re-checks a subset of the fields.
        assertionId = _digest(v);
        _verifySignatures(assertionId, signatures);

        // SETTLE-only guard (anti-brick, decision counterpart of the M-01 escrow-read checks below). The O5
        // rail is normatively EVIDENCE/SETTLE-only: hold/reject verdicts carry NO on-chain assertion. The
        // escrow ALSO rejects a non-SETTLE verdict at release (`NotSettle`), so asserting one here would
        // only consume the unit's one-verdict slot and brick it to refund-only. Guard it BEFORE the slot is
        // consumed — `decision` is the oracle's own policy field (not escrow state), so it is checked
        // directly rather than read back. A non-SETTLE verdict burns nothing; a real SETTLE still asserts.
        if (v.decision != O5_DECISION_SETTLE) revert NotSettleVerdict();

        // ── M-01 anti-brick pre-check ─────────────────────────────────────────────────────────────
        // Bind the verdict to the escrow's OWN state before the slot is consumed. Ordered AFTER the quorum
        // check (only an authenticated call reaches out of this contract) and BEFORE the record write,
        // so any mismatch — or an escrow that is unfunded / has not yet committed its package — consumes
        // nothing and can simply be re-attempted with a corrected verdict. It also enforces §B's
        // commit-before-verdict rule on the oracle side.
        //
        // SCOPE RULE — pre-check exactly the fields that are (a) re-checked by the escrow at release,
        // (b) FROZEN AT FUNDING, and (c) not already derivable here:
        //  * frozen  ⇒ a mismatch is a CORRECTABLE oracle-input error, and burning the one verdict slot on
        //              it strands evidence settlement for the unit forever (refund-only). Guard these.
        //  * mutable ⇒ deliberately NOT pre-checked (`dispute.opened`, `reclaimAt`, cohort `enabled()`).
        //              Those states are terminal-to-refund anyway, so a slot burned against them costs
        //              nothing, and a read of them here would be stale by release time regardless.
        //  * derivable ⇒ jobIdHash / milestoneIndex / stepId / settlementUnitId are already bound by the
        //              `computeSettlementUnitId` equality above; `oracleAuthEpoch` by the cohort check.
        //              `decision` is the oracle's own verdict, not escrow state.
        bytes32 unitId = v.settlementUnitId;
        if (_escrowBindingWord(escrow, IEscrowSettlementBinding.compositionRootOf.selector, unitId) != v.compositionRoot)
        {
            revert CompositionRootMismatch(); // §C3
        }
        if (
            _escrowBindingWord(escrow, IEscrowSettlementBinding.evidenceBundleHashOf.selector, unitId)
                != v.evidenceBundleHash
        ) revert EvidenceBundleMismatch(); // §B (this getter reverts while uncommitted ⇒ commit-before-verdict)
        if (
            _escrowBindingWord(escrow, IEscrowSettlementBinding.feeScheduleHashOf.selector, unitId)
                != v.feeScheduleHash
        ) revert FeeHashMismatch(); // a stale 13-field fee mirror is the most likely correctable mismatch
        // The RAW fee words the permanent attestation records (M-01). The hash above already binds them, but
        // an oracle mirroring only the hash could sign a true `feeScheduleHash` beside a false `feeBps`/
        // `feeRecipient`, minting an attestation whose economics downstream consumers read wrong. Both are
        // FROZEN AT FUNDING ⇒ correctly pre-checkable, and the escrow re-checks both at release, so a mismatch
        // here would burn the slot: guard them. `feeBpsOf`/`feeRecipientOf` return one left-padded word each.
        if (
            _escrowBindingWord(escrow, IEscrowSettlementBinding.feeBpsOf.selector, unitId)
                != bytes32(uint256(v.feeBps))
        ) revert FeeBpsMismatch();
        if (
            _escrowBindingWord(escrow, IEscrowSettlementBinding.feeRecipientOf.selector, unitId)
                != bytes32(uint256(uint160(v.feeRecipient)))
        ) revert FeeRecipientMismatch();
        // Frozen tier fields. `requiredTier` is a uint8 in 0..3 (bounded at funding) and `requiredTier ==
        // requestedTier` was frozen there too, so the escrow's three tier checks all reduce to this one read.
        // The range check first also rejects a non-canonical word from a hostile escrow (fail-closed).
        bytes32 tierWord = _escrowBindingWord(escrow, IEscrowSettlementBinding.requiredTierOf.selector, unitId);
        if (uint256(tierWord) > 3) revert TierOutOfRange();
        uint8 requiredTier = uint8(uint256(tierWord));
        if (requiredTier < 1) revert Tier0NotEvidence(); // a tier-0 unit can NEVER settle on evidence
        // M-01: bound the ORACLE-asserted tier to the supported max (0..3) as well. `achievedTier` is only
        // lower-bounded below (`>= requiredTier`), so without this an out-of-range tier would mint and be
        // permanently attested. It is the oracle's own field (not escrow state), so it is checked directly.
        if (v.achievedTier > 3) revert TierOutOfRange();
        if (v.achievedTier < requiredTier) revert TierNotMet();
        if (v.requestedTier != requiredTier) revert RequestedTierMismatch();

        // L-02's intent on the assertion rail: a zero identifier is never a real assertion, and the
        // all-zero record is what `assertionOf` returns for an un-asserted unit. Guard it explicitly so
        // the "absent" and "present" cases can never be confused, even though a keccak digest is not
        // realistically zero. (The EAS-uid form of this guard now lives in `mirrorToEAS`.)
        if (assertionId == bytes32(0)) revert ZeroAssertionId();

        // One settle-verdict per unit. The record write IS the consume-once effect, and it is the LAST
        // effect in the function — checks-effects-interactions holds trivially because P0-6 removed the
        // interaction entirely: `attestO5` now makes NO external call after this point. Every read that
        // could fail (the escrow bindings above) has already happened, so a verdict the escrow would
        // reject still burns nothing and can be re-attempted with a corrected verdict.
        if (_assertions[v.settlementUnitId].assertionId != bytes32(0)) revert UnitAlreadyAttested();
        _assertions[v.settlementUnitId] = O5Assertion({
            assertionId: assertionId,
            feeScheduleHash: v.feeScheduleHash,
            compositionRoot: v.compositionRoot,
            evidenceBundleHash: v.evidenceBundleHash,
            escrow: escrow,
            assertedAt: uint64(block.timestamp),
            achievedTier: v.achievedTier,
            requestedTier: v.requestedTier,
            decision: v.decision,
            feeRecipient: v.feeRecipient,
            oracleAuthEpoch: v.oracleAuthEpoch,
            feeBps: v.feeBps
        });
        // The FULL 448-byte verdict goes in the log, not in storage (§13R.1): logs are on-chain, so the
        // async mirror stays replayable from chain data, without paying 14 SSTOREs on the money path.
        emit O5Asserted(v.settlementUnitId, assertionId, escrow, cohortId, abi.encode(v));
    }

    // ── H-01 Wave 3: the typed escalation adjudication (appeal + Model-B emergency) ─────────────────

    /// @notice The consume-once storage key for one (unit, role, escrow) adjudication slot.
    function adjudicationKey(bytes32 settlementUnitId, uint8 role, address escrow) public pure returns (bytes32) {
        return keccak256(abi.encode(settlementUnitId, role, escrow));
    }

    /// @inheritdoc IOracleAttester
    function adjudicationOf(bytes32 settlementUnitId, uint8 role, address escrow)
        external
        view
        returns (O5AdjudicationRecord memory)
    {
        return _adjudications[adjudicationKey(settlementUnitId, role, escrow)];
    }

    /// @inheritdoc IOracleAttester
    /// @dev H-01: the one-word form of the read above, for the escrow's deadline defaults. Everything the
    ///      escrow would re-check about the record's BINDING is applied here (existence, bound escrow,
    ///      reviewed assertion), so an answer other than `max` means "this escrow would apply this record"
    ///      and the caller only has to compare the timestamp against its own window. Anything unbound
    ///      answers `max` ("never"), i.e. fails toward the ordinary deadline default — never inside a
    ///      window, so an absent record can never stall a unit.
    function adjudicationDecidedAt(bytes32 settlementUnitId, uint8 role, address escrow, bytes32 reviewedAssertionId)
        external
        view
        returns (uint64)
    {
        O5AdjudicationRecord storage r = _adjudications[adjudicationKey(settlementUnitId, role, escrow)];
        if (
            r.adjudicationId == bytes32(0) || r.escrow != escrow
                || r.reviewedAssertionId != reviewedAssertionId
        ) return type(uint64).max;
        return r.decidedAt;
    }

    /// @notice The canonical adjudication EIP-712 digest the escalation quorum signs — for the off-chain side.
    function adjudicationDigestOf(O5Adjudication calldata a) external view returns (bytes32) {
        return _adjDigest(a);
    }

    /// @notice Write a typed UPHOLD/OVERTURN over ONE EXACT accepted assertion, from a valid quorum.
    /// @dev    This is the whole of Wave 3's new authority surface, and it lives HERE rather than in the
    ///         escrow for two reasons: (1) this contract already owns the EIP-712 + m-of-n + consume-once
    ///         machinery (`_verifySignatures`, `_digest`, the write-once record discipline), so the
    ///         escalation quorum is the SAME audited code path as the primary quorum; (2) the escrow is at
    ///         its EIP-170 ceiling and must stay a money contract — per-job state, deadlines, distribution
    ///         and the liability buckets — with **no signature verification in it at all**.
    ///
    ///         The record carries NO amount and NO recipient. The escrow reads only `{outcome, role,
    ///         reviewedAssertionId, escrow}` and applies its OWN frozen distribution, so this quorum
    ///         selects a path and can never move, redirect, or resize money (§2.5 "no distribution
    ///         authority"). `reviewedAssertionId` binds the decision to one exact assertion, so an appeal
    ///         verdict cannot be recycled onto a later assertion for the same unit.
    ///
    ///         ANTI-BRICK (same rule as the M-01 pre-check in `attestO5`): the slot is consume-once, so
    ///         everything correctable is checked BEFORE it is consumed — including reading the escrow's
    ///         own `acceptedAssertionIdOf` and requiring equality. A verdict the escrow would reject
    ///         therefore burns nothing and can be re-signed. A unit with nothing accepted yet is
    ///         unreadable/zero and fails closed here.
    function adjudicate(O5Adjudication calldata a, bytes[] calldata signatures)
        external
        returns (bytes32 adjudicationId)
    {
        if (!enabled) revert CohortIsDisabled();
        if (a.oracleAuthEpoch != cohortId) revert CohortMismatch();
        if (a.role != O5_ADJ_ROLE_APPEAL && a.role != O5_ADJ_ROLE_EMERGENCY) revert BadAdjudicationRole();
        if (a.outcome != O5_ADJ_UPHOLD && a.outcome != O5_ADJ_OVERTURN) revert BadAdjudicationOutcome();
        if (a.escrow == address(0)) revert ZeroAddress();
        if (a.reviewedAssertionId == bytes32(0)) revert ZeroReviewedAssertion();

        adjudicationId = _adjDigest(a);
        _verifySignatures(adjudicationId, signatures);
        if (adjudicationId == bytes32(0)) revert ZeroAssertionId();

        // Anti-brick: bind to the assertion the escrow ACTUALLY accepted, before consuming the slot.
        if (
            _escrowBindingWord(a.escrow, IEscrowSettlementBinding.acceptedAssertionIdOf.selector, a.settlementUnitId)
                != a.reviewedAssertionId
        ) revert ReviewedAssertionMismatch();

        bytes32 k = adjudicationKey(a.settlementUnitId, a.role, a.escrow);
        if (_adjudications[k].adjudicationId != bytes32(0)) revert UnitAlreadyAdjudicated();
        // H-01: `decidedAt` is the AUTHORITATIVE decision time — the escrow's windows are measured against
        // it, not against the block that happens to relay the record. Clamped non-zero for the same reason
        // `disabledAt` is: the escrow reads 0 as "nothing applicable", so a genesis timestamp must never
        // read as the absence of a verdict that exists.
        uint64 t = uint64(block.timestamp);
        _adjudications[k] = O5AdjudicationRecord({
            adjudicationId: adjudicationId,
            reviewedAssertionId: a.reviewedAssertionId,
            escrow: a.escrow,
            decidedAt: t == 0 ? 1 : t,
            role: a.role,
            outcome: a.outcome
        });
        emit O5Adjudicated(a.settlementUnitId, adjudicationId, a.escrow, a.role, a.outcome, a.reviewedAssertionId);
    }

    function _adjDigest(O5Adjudication calldata a) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                _domainSeparator(),
                keccak256(
                    abi.encode(
                        O5_ADJUDICATION_TYPEHASH,
                        a.settlementUnitId,
                        a.escrow,
                        a.reviewedAssertionId,
                        a.role,
                        a.outcome,
                        a.oracleAuthEpoch
                    )
                )
            )
        );
    }

    // ── Async EAS provenance mirror (P0-6 item 4) — NOT ON ANY MONEY PATH ──────────────────────────
    /// @notice Mirror an already-written cohort assertion into EAS. PERMISSIONLESS: anyone may drain the
    ///         queue, so provenance never depends on a privileged keeper being alive.
    /// @dev    Safety of "permissionless": the only thing a caller supplies is `v`, and it is accepted
    ///         ONLY if `_digest(v)` equals the stored `assertionId` — i.e. only the exact 14-field verdict
    ///         the cohort quorum signed can ever be mirrored. The caller chooses nothing else: the schema,
    ///         recipient and revocability are taken from immutable/recorded state.
    ///
    ///         ISOLATION (the property Wave 1 must prove): no escrow money path reaches this function, and
    ///         `attestO5` does not call it. If EAS is unavailable this call reverts and the assertion stays
    ///         un-mirrored — `mirroredUid[unitId] == 0` marks it as still queued — while settlement
    ///         proceeds unaffected. When EAS recovers, the same call succeeds. That is the difference
    ///         between "provenance lag" and "funds stuck", and it is the whole architectural point.
    ///
    ///         Deliberately NOT gated on `enabled`: a disabled cohort's past assertions still deserve
    ///         provenance, and this path moves no money. One-shot per unit (`AlreadyMirrored`) so the
    ///         provenance record cannot be multiplied.
    /// @param v the full O5 verdict, exactly as signed. Recoverable from the `O5Asserted` log.
    function mirrorToEAS(O5Verdict calldata v) external returns (bytes32 uid) {
        bytes32 unitId = v.settlementUnitId;
        O5Assertion storage a = _assertions[unitId];
        bytes32 assertionId = a.assertionId;
        if (assertionId == bytes32(0)) revert AssertionNotFound();
        if (mirroredUid[unitId] != bytes32(0)) revert AlreadyMirrored();
        // Proves the supplied 448 bytes ARE the signed verdict: the digest covers all 14 fields plus the
        // domain, so no substituted field can survive this equality.
        if (_digest(v) != assertionId) revert VerdictDigestMismatch();

        address escrow = a.escrow;
        // Read the settlement receipt BEFORE the mint so the emitted state is the escrow's own
        // authoritative unit state, and read it TOLERANTLY: the mirror must never be blockable by escrow
        // state (that would re-create the coupling P0-6 removes).
        uint256 unitState = _tolerantUnitState(escrow, unitId);

        // L-01: CLAIM the one-shot marker BEFORE the external mint (checks-effects-interactions). `attest`
        // is a call into an EAS registry that may run a resolver, and a hostile one can reenter here; with
        // the marker written afterwards BOTH calls read zero, BOTH mint, and the outer write overwrites the
        // inner uid — two mirrors for one assertion, and one of them permanently unreferenced. The sentinel
        // is `assertionId` (non-zero by the guard above) purely so no extra constant is needed; the real
        // uid replaces it below. Nothing is lost on failure: `attest` reverting rolls the marker back with
        // the transaction, so the assertion simply stays on the drainable queue.
        mirroredUid[unitId] = assertionId;

        uid = IEAS(eas).attest(
            AttestationRequest({
                schema: o5SchemaUid,
                data: AttestationRequestData({
                    recipient: escrow,
                    expirationTime: 0,
                    revocable: false,
                    refUID: bytes32(0),
                    data: abi.encode(v),
                    value: 0
                })
            })
        );
        // L-02 (mirror form): a zero uid means EAS recorded nothing. Reverting leaves `mirroredUid` unset,
        // so the assertion simply stays on the drainable queue instead of being marked mirrored falsely.
        if (uid == bytes32(0)) revert InvalidAttestationUid();
        mirroredUid[unitId] = uid;
        emit O5Mirrored(unitId, assertionId, uid, cohortId, escrow, v.verdictHash, unitState);
    }

    /// @dev `unitState(bytes32)` off the settling escrow, or `type(uint256).max` when unreadable (no code,
    ///      missing getter, reverting getter, wrong return width). Tolerant BY DESIGN — this feeds a log
    ///      field on a provenance path, never a decision.
    function _tolerantUnitState(address escrow, bytes32 unitId) private view returns (uint256) {
        (bool ok, bytes memory ret) =
            escrow.staticcall(abi.encodeWithSelector(IEscrowSettlementBinding.unitState.selector, unitId));
        if (!ok || ret.length != 32) return type(uint256).max;
        return abi.decode(ret, (uint256));
    }

    // ── Escrow binding read (M-01) ─────────────────────────────────────────────────────────────────
    /// @dev Read one `bytes32`-returning, `bytes32`-taking binding getter off the settling escrow.
    ///      STATICCALL only: the escrow cannot write state, emit, or re-enter through it, so this adds a
    ///      read — not a reentrancy surface — and no state of this contract is touched. The return buffer is
    ///      capped at one word so a hostile escrow cannot returndata-bomb the oracle's transaction.
    ///      FAIL-CLOSED: no code at `escrow`, a missing getter, a reverting getter (unit not funded, or no
    ///      evidence committed yet), or any return length other than 32 all revert here — i.e. before
    ///      `usedUnit` is consumed, so nothing is burned and the call can be retried once the escrow is ready.
    function _escrowBindingWord(address escrow, bytes4 selector, bytes32 unitId) private view returns (bytes32 word) {
        bytes memory cd = abi.encodeWithSelector(selector, unitId);
        bool ok;
        uint256 len;
        assembly ("memory-safe") {
            // scratch after the free-memory pointer; read back immediately, never retained
            let out := mload(0x40)
            ok := staticcall(gas(), escrow, add(cd, 0x20), mload(cd), out, 0x20)
            len := returndatasize()
            word := mload(out)
        }
        if (!ok || len != 32) revert EscrowBindingUnreadable();
    }

    // ── EIP-712 helpers ────────────────────────────────────────────────────────────────────────────
    function _digest(O5Verdict calldata v) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), _structHash(v)));
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, EIP712_NAME_HASH, EIP712_VERSION_HASH, block.chainid, address(this))
        );
    }

    function _structHash(O5Verdict calldata v) private pure returns (bytes32) {
        // Split the 15-word encode to avoid stack-too-deep. Every field is static, so
        // bytes.concat(abi.encode(a), abi.encode(b)) == abi.encode(a, b) — the EIP-712 hash is identical.
        return keccak256(
            bytes.concat(
                abi.encode(
                    O5_TYPEHASH,
                    v.jobIdHash,
                    v.milestoneIndex,
                    v.stepId,
                    v.evidenceBundleHash,
                    v.achievedTier,
                    v.requestedTier
                ),
                abi.encode(
                    v.decision,
                    v.verdictHash,
                    v.feeBps,
                    v.feeRecipient,
                    v.feeScheduleHash,
                    v.settlementUnitId,
                    v.oracleAuthEpoch,
                    v.compositionRoot
                )
            )
        );
    }

    /// @dev EOA-only ECDSA recover with low-s + canonical-v malleability guards. NO ERC-1271 by design:
    ///      a fixed-quorum cohort must not be satisfiable by a mutable smart-account signer.
    function _recoverEOA(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignatureLength();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > ECDSA_S_MAX) revert MalleableSignature();
        if (v != 27 && v != 28) revert BadSignatureV();
        address rec = ecrecover(digest, v, r, s);
        if (rec == address(0)) revert BadSignature();
        return rec;
    }

    /// @dev Concrete cohorts verify their M-of-N rule over `digest`; MUST revert unless the quorum holds.
    function _verifySignatures(bytes32 digest, bytes[] calldata signatures) internal view virtual;
}
