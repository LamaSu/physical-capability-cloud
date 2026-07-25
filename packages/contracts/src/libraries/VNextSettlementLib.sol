// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title VNextSettlementLib
 * @notice Byte-exact primitives + pure invariant checks for the V-next unified
 *         settlement escrow. Encodes the FROZEN spec (ai/research/vnext-money-out-FROZEN-v1.0.md,
 *         escrow lane 9de363c7): §2 typed hashes, §10 enforcement (E1/E3/E4/E6), §10.11
 *         canonical settlementUnitId. All hashing is ABI-standard `abi.encode` (NOT
 *         `encodePacked`). These functions are mirrored byte-exact by the oracle +
 *         evidence lanes (coord bulletins #382 / #393) — do not change a field, type,
 *         or order without a cross-lane re-pin.
 * @dev    Stateless. The stateful escrow (fund/release/dispute/buyerApprove/reclaim) and
 *         `tryTransferExact` (three-way + both-delta + solvency) live in
 *         VNextSettlementEscrow.sol.
 */

// ── FROZEN financial states (§1, §3) ─────────────────────────────────────────
enum UnitState {
    AWAITING_FUNDING,
    FUNDED_ACTIVE,
    RELEASE_ALLOCATED,
    REFUND_ALLOCATED,
    SETTLED_RELEASED,
    SETTLED_REFUNDED
}

// ── FROZEN claim classes (§2) ────────────────────────────────────────────────
enum ClaimClass {
    PRINCIPAL,
    FEE,
    REFUND
}

/// @notice FROZEN §2 `authorizationType` + §10.10. Buyer-approval is a DISTINCT
///         release-authorization type, never a widened evidence predicate.
enum AuthorizationType {
    EVIDENCE,
    DISPUTE,
    RECLAIM,
    BUYER_APPROVAL
}

// ── FROZEN §2 structs ────────────────────────────────────────────────────────

/// @notice Model-A payout (§2 P0-3): exact amounts stored at funding; Σ amount == N; no rounding.
struct PayoutEntry {
    address recipient;
    uint256 amount;
}

/// @notice The 13 fee-schedule fields atomically frozen at funding (§2, E2).
///         `feeScheduleHash = keccak256(abi.encode(all 13, in this order))`.
struct FeeSchedule {
    uint8 domainVersion; // == DOMAIN_VERSION_V1
    uint256 chainId; // block.chainid (E5) — never caller input
    address escrow; // address(this) (E5)
    bytes32 settlementUnitId; // §10.11 canonical derivation
    uint8 feeBasis; // GROSS (0)
    uint256 g; // gross G
    uint256 f; // fee F
    uint256 n; // net N
    uint16 feeBps;
    uint256 denominator; // 10000
    uint8 roundingRule; // FLOOR (0)
    address feeRecipient;
    bytes32 feeSplitConfigHash; // bytes32(0) in v1 (no split)
}

/// @notice H-01 §8.2 H-1 — the BILATERAL POLICY IDENTITY the CREATE2 salt binds and the clone is
///         initialized with. It supersedes the rev-3 `(payer, arbiter, jobIdHash, termsHash)` salt tuple:
///         the same front-run property (the address the payer computes can only ever be occupied by a
///         clone bearing the intended authorities) now covers the OPERATOR, the POLICY NONCE and the
///         PRE-POLICY ROOT as well, so an address commits to WHO may adjudicate, WHO must accept, WHICH
///         policy generation this is, and the EXACT funded terms.
/// @dev    `prePolicyRoot == keccak256(abi.encode(UnitConfig[]))` — the address-INDEPENDENT half of the
///         policy. It is computable before the escrow address exists, which is what breaks the circular
///         dependency (§8.2 H-1): predict the address from this root, derive the settlementUnitIds from
///         the predicted address, then build the full `JobPolicyHash` over both.
struct PolicyIdentity {
    address payer;
    address operator; // money-plane operator identity (ECDSA or ERC-1271); NOT a payout destination
    address arbiter;
    bytes32 jobIdHash;
    bytes32 termsHash;
    uint256 policyNonce;
    bytes32 prePolicyRoot;
}

/// @notice Raised by the explicit checked downcasts (H-2). A value that does not fit its packed width
///         reverts rather than silently truncating.
error ValueOverflow();

library VNextSettlementLib {
    // ── FROZEN pinned constants (§6, E6) ────────────────────────────────────
    uint8 internal constant DOMAIN_VERSION_V1 = 1;
    uint16 internal constant MAX_FEE_BPS = 1000; // 10% hard cap (seam §0.1 / #391 confirmed)
    uint256 internal constant FEE_DENOMINATOR = 10_000;
    uint8 internal constant FEE_BASIS_GROSS = 0;
    uint8 internal constant ROUNDING_FLOOR = 0;
    bytes32 internal constant SETTLEMENT_UNIT_DOMAIN = keccak256("PCC:vnext:settlement-unit:v1");
    // H-01 §8.2 H-1 domains: the CREATE2 salt over the bilateral policy identity, and the factory-side
    // nonce key that scopes revoke-before-funding / newer-invalidates-older to one (payer, operator, job).
    bytes32 internal constant POLICY_SALT_DOMAIN = keccak256("PCC:vnext:policy-salt:v1");
    bytes32 internal constant POLICY_NONCE_DOMAIN = keccak256("PCC:vnext:policy-nonce:v1");
    // §B on-chain evidence binding: the domain tag + the package-format label of the committed digest.
    bytes32 internal constant EVIDENCE_COMMITMENT_DOMAIN = keccak256("PCC:vnext:evidence-commitment:v1");
    uint8 internal constant EVIDENCE_PACKAGE_FORMAT_V1 = 1;

    // ── FROZEN limits (§6) ──────────────────────────────────────────────────
    uint256 internal constant MAX_PAYOUT_LEGS_PER_UNIT = 16;
    uint256 internal constant MAX_FEE_LEGS_PER_UNIT = 1;
    uint256 internal constant MAX_SETTLEMENT_UNITS = 16;
    uint256 internal constant MAX_TOTAL_LEGS_PER_JOB = 256; // counts PAYOUT entries only (16x16); a release may add +1 fee claim

    // ── H-01 §13.1/H-2 funding-parameter bounds (sized from PHYSICAL REALITY, not from the attack) ───
    // LOWER: the operator's floor. A funded job may never carry a deadline so near that the physical work
    // + evidence + the (Wave-3) challenge/appeal windows cannot fit before the payer may reclaim.
    uint256 internal constant MIN_RECLAIM_DELAY = 1 days;
    // UPPER: long-lead tooling, castings and regulated QC legitimately run months, so ~1 year is the
    // honest ceiling; it also keeps `primaryAssertionCutoff = reclaimAt - challengeWindow - appealWindow`
    // (§8.2 C-3) inside a bounded horizon and makes every timestamp provably fit its packed uint64.
    uint256 internal constant MAX_RECLAIM_DELAY = 365 days;
    // The arbiter must have a real interval to act in. A zero window is what made `openDispute` and
    // `refundOnDisputeExpiry` legal in the SAME BLOCK (the H-01 costless-veto path).
    uint256 internal constant MIN_DISPUTE_WINDOW = 1 days;
    // Per-signature calldata bound for the bilateral acceptance. Generous for an ERC-1271 smart account
    // (a 5-owner Safe bundle is ~360 B; a WebAuthn assertion ~500 B) and it is what makes the funding
    // calldata envelope below an EXACT number rather than an open-ended one.
    uint256 internal constant MAX_SIGNATURE_BYTES = 1024;
    // §6 funding-calldata DoS bound (feeds no hash/golden/parity value). L-01: this MUST be >= the calldata
    // size of the largest config the contract SEMANTICALLY ACCEPTS, or that config reverts `ConfigTooLarge`
    // and the bound becomes a funding DoS on a legal input. MAX_TOTAL_LEGS_PER_JOB (256) == 16 units x 16
    // legs, so the 16x16 config IS accepted and IS the envelope. Full derivation (ABI encoding of
    // `fund(UnitConfig[],PolicyAcceptance)`, selector included) — re-derive and re-pin on ANY UnitConfig,
    // PolicyAcceptance or MAX_SIGNATURE_BYTES change:
    //     4                       selector
    //   + 32                      offset to the UnitConfig[] argument
    //   + 32                      offset to the PolicyAcceptance argument (dynamic — it carries two bytes)
    //   + 32                      UnitConfig[] length
    //   + 16 x 32   =   512       one head offset per UnitConfig element
    //   + 16 x (480 + 1056)       per unit: 480 B static head (15 words = 14 fields + the payouts offset)
    //                             + 1056 B payouts tail (32 B length + 16 legs x 64 B per PayoutEntry)
    //   + 4 x 32    =   128       PolicyAcceptance head: expiry, allowSelfAdjudication, 2 bytes offsets
    //   + 2 x (32 + 1024) = 2,112 the two signatures: 32 B length + MAX_SIGNATURE_BYTES payload each
    //   ------------------------
    //   = 4 + 64 + 25,120 + 2,240  =  27,428 B
    // History: 24,644 B at rev-3 (13 head words); +512 B when §B added `evidenceCommitter` (14th word)
    // -> 25,156 B; +2,272 B for the H-01 bilateral `PolicyAcceptance` argument -> 27,428 B.
    // `test_gas_maxAggregateFunding_fits` builds the true 16x16 maximum with two MAX_SIGNATURE_BYTES
    // signatures and asserts BOTH that it fits and that it equals this constant exactly, so drift in either
    // direction fails the suite. The real griefing caps remain MAX_SETTLEMENT_UNITS /
    // MAX_PAYOUT_LEGS_PER_UNIT / MAX_TOTAL_LEGS_PER_JOB / MAX_SIGNATURE_BYTES.
    uint256 internal constant MAX_CONFIG_BYTES = 27_428;

    // Reserved claim leg indices (§2/§7): PRINCIPAL uses the payout entry index; FEE/REFUND use these sentinels.
    uint256 internal constant FEE_LEG_INDEX = type(uint256).max;
    uint256 internal constant REFUND_LEG_INDEX = type(uint256).max - 1;

    /// @notice §10.11 canonical `settlementUnitId` — the E1 immutable bijection resolved
    ///         SOLELY from the signed job identity + escrow domain. `chainId` MUST be
    ///         `block.chainid` and `escrow` MUST be `address(this)` at the call site (E5).
    function computeSettlementUnitId(
        uint256 chainId,
        address escrow,
        bytes32 jobIdHash,
        uint256 milestoneIndex,
        bytes32 stepId
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(SETTLEMENT_UNIT_DOMAIN, chainId, escrow, jobIdHash, milestoneIndex, stepId));
    }

    /// @notice H-01 §8.2 H-1 — the CREATE2 salt over the BILATERAL POLICY IDENTITY. Every field the clone
    ///         is initialized with is in the preimage, so the address a payer/operator computes can only
    ///         ever be occupied by a clone bearing exactly those authorities and exactly those terms; a
    ///         front-run that alters ANY of them lands at a DIFFERENT address neither party ever funds.
    ///         This supersedes (and strictly widens) the rev-3 `(payer, arbiter, jobIdHash, termsHash)`
    ///         tuple — `arbiter` survives as one component of the identity because it is still a money
    ///         authority until the Wave-3 state machine retires it.
    function computePolicySalt(
        address payer,
        address operator,
        address arbiter,
        bytes32 jobIdHash,
        bytes32 termsHash,
        uint256 policyNonce,
        bytes32 prePolicyRoot
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POLICY_SALT_DOMAIN, payer, operator, arbiter, jobIdHash, termsHash, policyNonce, prePolicyRoot
            )
        );
    }

    /// @notice The factory-side nonce scope: cancellation and newer-invalidates-older are per
    ///         (payer, operator, job), never global — one funded policy generation per job.
    function computePolicyKey(address payer, address operator, bytes32 jobIdHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(POLICY_NONCE_DOMAIN, payer, operator, jobIdHash));
    }

    /// @notice H-2 explicit checked downcasts. Solidity's `uint64(x)` truncates silently; these revert.
    ///         Used at the funding boundary for every value that lands in a narrowed packed slot.
    function toUint64(uint256 v) internal pure returns (uint64) {
        if (v > type(uint64).max) revert ValueOverflow();
        return uint64(v);
    }

    function toUint128(uint256 v) internal pure returns (uint128) {
        if (v > type(uint128).max) revert ValueOverflow();
        return uint128(v);
    }

    /// @notice §B canonical evidence commitment — the ONE domain-separated form of a committed evidence
    ///         package. The raw `packageDigest` is never stored or compared on its own: the same package
    ///         hash committed under a different chain, escrow, unit, composition schema version, or package
    ///         format yields a different commitment, so a digest can never be replayed across units.
    /// @dev    The oracle mirrors this EXACTLY and echoes the result as `O5Verdict.evidenceBundleHash`
    ///         (i.e. the O5 field carries this commitment, not the raw package digest). Byte-exact ABI
    ///         `abi.encode` of 7 static words {domain, chainId, escrow, settlementUnitId, schemaVersion,
    ///         packageFormat, packageDigest}, in this order — changing a field, type, or position is a
    ///         cross-lane re-pin. Golden vector: `test_emit_evidenceCommitmentGolden`.
    function computeEvidenceCommitment(
        uint256 chainId,
        address escrow,
        bytes32 settlementUnitId,
        uint16 compositionSchemaVersion,
        uint8 packageFormat,
        bytes32 packageDigest
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EVIDENCE_COMMITMENT_DOMAIN,
                chainId,
                escrow,
                settlementUnitId,
                compositionSchemaVersion,
                packageFormat,
                packageDigest
            )
        );
    }

    /// @notice §2 `feeScheduleHash` — 13-field ABI-standard keccak (#382 authoritative).
    function computeFeeScheduleHash(FeeSchedule memory s) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                s.domainVersion,
                s.chainId,
                s.escrow,
                s.settlementUnitId,
                s.feeBasis,
                s.g,
                s.f,
                s.n,
                s.feeBps,
                s.denominator,
                s.roundingRule,
                s.feeRecipient,
                s.feeSplitConfigHash
            )
        );
    }

    /// @notice §2 `payoutConfigHash` (Model-A): keccak256(abi.encode(unitId, entries)); Σ entries.amount == N.
    function computePayoutConfigHash(bytes32 settlementUnitId, PayoutEntry[] memory entries)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(settlementUnitId, entries));
    }

    /// @notice §2 `claimId` — 5-field domain-separated keccak. `legIndex`: PRINCIPAL = the payout entry
    ///         index; FEE = FEE_LEG_INDEX; REFUND = REFUND_LEG_INDEX. Frozen §2 form (NOT the older v4.2
    ///         form that included authorizationKey).
    function computeClaimId(
        uint256 chainId,
        address escrow,
        bytes32 settlementUnitId,
        uint256 legIndex,
        ClaimClass claimClass
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, escrow, settlementUnitId, legIndex, uint8(claimClass)));
    }

    /// @notice E4 fee math — full-precision floor(x*y/denominator). OpenZeppelin `Math.mulDiv`
    ///         (rounding down), embedded to avoid a submodule. Never a raw `x*y/d` that can overflow.
    function mulDivFloor(uint256 x, uint256 y, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(x, y, not(0))
                prod0 := mul(x, y)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0, "mulDiv: denom==0");
                return prod0 / denominator;
            }
            require(denominator > prod1, "mulDiv: overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(x, y, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (0 - denominator);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
            return result;
        }
    }

    /// @notice E3 full V1 invariant conformance. Reverts with a specific reason on any violation
    ///         (→ `contradiction` / reject at commit). Enforced identically by the oracle verdict.
    function checkV1Invariants(FeeSchedule memory s) internal pure {
        require(s.domainVersion == DOMAIN_VERSION_V1, "V1: domainVersion");
        require(s.feeBasis == FEE_BASIS_GROSS, "V1: feeBasis");
        require(s.denominator == FEE_DENOMINATOR, "V1: denominator");
        require(s.roundingRule == ROUNDING_FLOOR, "V1: roundingRule");
        require(s.feeSplitConfigHash == bytes32(0), "V1: feeSplitConfigHash");
        require(s.feeBps <= MAX_FEE_BPS, "V1: feeBps>MAX");
        require(s.g > 0, "V1: G==0");
        require(s.n > 0, "V1: N==0");
        require(s.f < s.g, "V1: F>=G");
        require(s.n + s.f == s.g, "V1: N+F!=G");
        require(s.f == mulDivFloor(s.g, s.feeBps, FEE_DENOMINATOR), "V1: F!=mulDiv");
        if (s.feeBps > 0) {
            require(s.feeRecipient != address(0), "V1: fee>0 recipient==0");
        } else {
            require(s.f == 0 && s.feeRecipient == address(0), "V1: fee==0 rep");
        }
    }
}
