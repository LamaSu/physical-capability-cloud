// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {O5Verdict} from "../O5Types.sol";
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
    function requiredTierOf(bytes32 unitId) external view returns (uint8);
}

/**
 * @title O5AttesterBase
 * @notice Shared money-path logic for a cohort-scoped O5 verdict attester (addendum §A). A concrete
 *         cohort supplies only its M-of-N signer rule via {_verifySignatures}; everything else — the
 *         EIP-712 digest, the cohort/epoch binding, the escrow↔verdict binding, one-verdict-per-unit,
 *         the one-way kill-switch, and the EAS mint — is written and audited ONCE here.
 *
 *         Trust-root properties (§A.1 money-path invariants):
 *         - Signer set + threshold are IMMUTABLE by construction in each concrete (no upgrade/module/
 *           guard/rotation/re-enable) — a mutable Safe cannot be substituted behind the address.
 *         - EOA-only ECDSA recovery (no ERC-1271) with low-s + canonical-v malleability guards — a
 *           mutable smart-account signer cannot satisfy the quorum.
 *         - `disable()` is ONE-WAY: it neutralizes future mints, and (because the escrow re-checks
 *           `enabled` at release) also neutralizes already-minted attestations for the cohort.
 *         - One O5 per `settlementUnitId` (consume-once) is enforced in-contract.
 *         - Because that slot is consumable exactly once, every field the ESCROW will re-check at release
 *           and that this contract cannot derive itself is read back from the escrow BEFORE the slot is
 *           consumed (M-01 anti-brick pre-check) — a verdict the escrow would reject can never burn the slot.
 * @dev    The escrow only READS `enabled` / `cohortId`; it never calls `attestO5`. Refund/reclaim in the
 *         escrow never call this contract, so a controller fault can freeze RELEASE but never REFUND.
 */
abstract contract O5AttesterBase is IOracleAttester {
    // ── Immutable cohort config ────────────────────────────────────────────────────────────────────
    address public immutable eas; // EAS registry this cohort mints into
    bytes32 public immutable o5SchemaUid; // the pinned O5 v1.1 schema UID
    uint64 public immutable cohortId; // this cohort's label (IOracleAttester.cohortId)
    address public immutable revoker; // kill-switch holder (separately custodied from signing keys)

    // ── One-way kill-switch + consume-once ─────────────────────────────────────────────────────────
    bool public enabled; // IOracleAttester.enabled — starts true, one-way to false
    mapping(bytes32 => bool) public usedUnit; // settlementUnitId => already attested (one verdict per unit)

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
    /// @dev secp256k1 n/2 — reject high-s (malleable) signatures (EIP-2 canonical form).
    uint256 private constant ECDSA_S_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    event O5Attested(bytes32 indexed settlementUnitId, bytes32 indexed uid, address indexed escrow);
    event CohortDisabled(uint64 indexed cohortId);

    error ZeroAddress();
    error ZeroSigner();
    error DuplicateSigner();
    error OnlyRevoker();
    error CohortIsDisabled();
    error CohortMismatch();
    error EscrowVerdictMismatch();
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
    // The M-01 pre-check errors deliberately mirror the escrow's release-check names one-for-one, so a
    // trace shows exactly which release check the verdict would have failed.
    error CompositionRootMismatch();
    error EvidenceBundleMismatch();
    error FeeHashMismatch();
    error TierOutOfRange();
    error Tier0NotEvidence();
    error TierNotMet();
    error RequestedTierMismatch();

    constructor(address eas_, bytes32 o5SchemaUid_, uint64 cohortId_, address revoker_) {
        if (eas_ == address(0) || revoker_ == address(0)) revert ZeroAddress();
        eas = eas_;
        o5SchemaUid = o5SchemaUid_;
        cohortId = cohortId_;
        revoker = revoker_;
        enabled = true;
    }

    /// @notice One-way, permanent cohort kill-switch (revoker only). No re-enable exists by construction.
    function disable() external {
        if (msg.sender != revoker) revert OnlyRevoker();
        enabled = false;
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
    function attestO5(O5Verdict calldata v, address escrow, bytes[] calldata signatures)
        external
        returns (bytes32 uid)
    {
        if (!enabled) revert CohortIsDisabled();
        if (v.oracleAuthEpoch != cohortId) revert CohortMismatch();

        // Bind the EAS recipient (escrow) to the verdict. `settlementUnitId` already commits
        // (chainId, escrow, jobIdHash, milestoneIndex, stepId); recomputing it and requiring equality
        // guarantees the minted attestation's recipient is exactly the escrow the quorum signed for.
        bytes32 suid =
            VNextSettlementLib.computeSettlementUnitId(block.chainid, escrow, v.jobIdHash, v.milestoneIndex, v.stepId);
        if (suid != v.settlementUnitId) revert EscrowVerdictMismatch();

        // M-of-N quorum over the canonical digest (concrete rule). Reverts unless the quorum is met.
        _verifySignatures(_digest(v), signatures);

        // ── M-01 anti-brick pre-check ─────────────────────────────────────────────────────────────
        // Bind the verdict to the escrow's OWN state before the slot is consumed. Ordered AFTER the quorum
        // check (only an authenticated call reaches out of this contract) and BEFORE the `usedUnit` effect,
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
        // Frozen tier fields. `requiredTier` is a uint8 in 0..3 (bounded at funding) and `requiredTier ==
        // requestedTier` was frozen there too, so the escrow's three tier checks all reduce to this one read.
        // The range check first also rejects a non-canonical word from a hostile escrow (fail-closed).
        bytes32 tierWord = _escrowBindingWord(escrow, IEscrowSettlementBinding.requiredTierOf.selector, unitId);
        if (uint256(tierWord) > 3) revert TierOutOfRange();
        uint8 requiredTier = uint8(uint256(tierWord));
        if (requiredTier < 1) revert Tier0NotEvidence(); // a tier-0 unit can NEVER settle on evidence
        if (v.achievedTier < requiredTier) revert TierNotMet();
        if (v.requestedTier != requiredTier) revert RequestedTierMismatch();

        // One settle-verdict per unit. EFFECT before the external attest (checks-effects-interactions).
        if (usedUnit[v.settlementUnitId]) revert UnitAlreadyAttested();
        usedUnit[v.settlementUnitId] = true;

        // Mint into EAS; this contract becomes the recorded `attester` the escrow checks against.
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
        emit O5Attested(v.settlementUnitId, uid, escrow);
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
