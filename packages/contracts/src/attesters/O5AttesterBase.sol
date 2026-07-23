// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {O5Verdict} from "../O5Types.sol";
import {IOracleAttester} from "../interfaces/IOracleAttester.sol";
import {IEAS, AttestationRequest, AttestationRequestData} from "../interfaces/IEAS.sol";
import {VNextSettlementLib} from "../libraries/VNextSettlementLib.sol";

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

    // ── EIP-712 (domain binds chainId + this verifier + cohortId; struct binds every O5 field) ──────
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)");
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

    // ── EIP-712 helpers ────────────────────────────────────────────────────────────────────────────
    function _digest(O5Verdict calldata v) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), _structHash(v)));
    }

    function _domainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                EIP712_NAME_HASH,
                EIP712_VERSION_HASH,
                block.chainid,
                address(this),
                bytes32(uint256(cohortId))
            )
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
