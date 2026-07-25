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

// ── FROZEN financial states (§1, §3) + the H-01 §8.1 post-verdict machine ────
/// @dev H-01 §8.1 frozen transition table. The five LIVE states are contiguous and ordered FIRST so
///      "the money is still committed and nothing has been allocated" is one comparison
///      (`state <= BACKUP_ASSERTED`) rather than a five-way disjunction on a size-constrained contract.
///      `FINAL_RELEASE_ALLOCATED` / `FINAL_REFUND_ALLOCATED` in the frozen table ARE
///      `RELEASE_ALLOCATED` / `REFUND_ALLOCATED` here — the allocation states already were the "final
///      outcome chosen, cash may still be outstanding" states, so the table adds no new terminal.
enum UnitState {
    AWAITING_FUNDING, // 0  not funded
    // ── LIVE (funded, no outcome allocated yet) ───────────────────────────────
    FUNDED_ACTIVE, // 1
    PRIMARY_ASSERTED, // 2  a primary-cohort SETTLE was ACCEPTED; challenge window running
    CHALLENGED, // 3  bonded challenge open; appeal window running
    BACKUP_PENDING, // 4  §8.2 C-4: primary lane CLOSED, backup cohort may assert
    BACKUP_ASSERTED, // 5  a backup SETTLE was ACCEPTED; challenge window running
    // ── OUTCOME ALLOCATED ────────────────────────────────────────────────────
    RELEASE_ALLOCATED, // 6
    REFUND_ALLOCATED, // 7
    SETTLED_RELEASED, // 8
    SETTLED_REFUNDED // 9

}

// ── FROZEN claim classes (§2) ────────────────────────────────────────────────
/// @dev PRINCIPAL/FEE/REFUND are JOB-collateral classes; BOND/DELAY_COMP/BURN are CHALLENGE-BOND
///      classes (§8.3 H-3). The escrow decrements a DIFFERENT liability bucket per group, which is how
///      "a job release/refund must never consume bond collateral" is enforced in code and not by comment.
enum ClaimClass {
    PRINCIPAL,
    FEE,
    REFUND,
    BOND, // challenge bond returned to the challenger (successful challenge)
    DELAY_COMP, // bounded, pre-agreed operator delay compensation (failed challenge)
    BURN // the forfeited remainder — to the sink, never to a counterparty, never to a treasury

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

    // ── H-01 §2.1 bilateral-acceptance EIP-712 pins (SHARED by the escrow and the factory) ───────────
    // WHY they live here: Wave 4a moved the acceptance VERIFICATION into the factory (the escrow is the
    // size-scarce per-clone implementation; the factory is deployed once). The digest is still the
    // ESCROW's — `name`/`version` below and `verifyingContract == the clone` are unchanged, so every
    // signature that validated before validates now, byte for byte. Holding ONE definition here is what
    // makes that a fact rather than a promise: a second copy of a 15-field type string in the factory
    // could drift, and a drifted typehash silently invalidates every acceptance signature ever produced.
    uint256 internal constant POLICY_VERSION_V1 = 1; // uint256: the EIP-712 field is `uint256 policyVersion`
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant EIP712_NAME_HASH = keccak256(bytes("VNextSettlementEscrow"));
    bytes32 internal constant EIP712_VERSION_HASH = keccak256(bytes("1"));
    /// @dev H-01 §2.1 — the ONE canonical `JobPolicyHash` both parties authenticate before any funds move.
    ///      It covers every term that decides WHETHER and WHEN the operator is paid: the deployment
    ///      incarnation (chainId / factory / implementation / escrow / policyVersion), both money-plane
    ///      identities, the adjudication authority and whether self-adjudication was deliberately accepted,
    ///      the job + terms identity, the policy generation (nonce) and its expiry, the pre-policy root
    ///      (== keccak256(abi.encode(UnitConfig[])), i.e. every funded term) and the units root (every
    ///      derived settlementUnitId). Binding factory+implementation+escrow is what makes a signature
    ///      unusable against a different factory, a different implementation, or a different clone.
    bytes32 internal constant JOB_POLICY_TYPEHASH = keccak256(
        "JobPolicy(uint256 chainId,address factory,address implementation,address escrow,uint256 policyVersion,address payer,address operator,address arbiter,bytes32 jobIdHash,bytes32 termsHash,uint256 policyNonce,bytes32 prePolicyRoot,bytes32 unitsRoot,bool allowSelfAdjudication,uint256 expiry)"
    );
    bytes4 internal constant ERC1271_MAGIC = 0x1626ba7e;
    /// @dev secp256k1 n/2 — the ECDSA malleability bound (a signature with `s` above it is the mirror of a
    ///      valid one and is rejected rather than accepted as a second, distinct signature).
    uint256 internal constant ECDSA_S_MAX = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ── FROZEN limits (§6) ──────────────────────────────────────────────────
    uint256 internal constant MAX_PAYOUT_LEGS_PER_UNIT = 16;
    uint256 internal constant MAX_FEE_LEGS_PER_UNIT = 1;
    uint256 internal constant MAX_SETTLEMENT_UNITS = 16;
    uint256 internal constant MAX_TOTAL_LEGS_PER_JOB = 256; // counts PAYOUT entries only (16x16); a release may add +1 fee claim

    // ── H-01 §8.1/§8.2 C-3 post-verdict windows — PROTOCOL CONSTANTS, deliberately not per-job ───────
    // WHY constants: every one of these is a term that decides WHETHER and WHEN the operator is paid, so
    // §2.1 requires both parties to authenticate it. They do — `JobPolicyHash` binds `implementation`
    // (VNextSettlementEscrow._hashJobPolicy), and these values live in that implementation's bytecode, so
    // signing the implementation address IS signing this schedule. Making them per-job config would add a
    // negotiation surface (a 1-second appeal window is a payer-side veto restored by the back door), more
    // funding validation, and more calldata — for a freedom neither party has asked for. v2's modular
    // policies are where a second schedule belongs: a different schedule is a different implementation.
    //
    // The whole machine is anchored BACKWARDS from `reclaimAt`, so a funded unit provably terminates by
    // its own deadline and the payer's capital is never locked past it by the escalation machinery:
    //     assertionCutoff    = reclaimAt - CHALLENGE_WINDOW - APPEAL_WINDOW      (§8.2 C-3, verbatim)
    //     primaryVerdictDue  = assertionCutoff - BACKUP_WINDOW
    // and `MIN_RECLAIM_DELAY > CHALLENGE + APPEAL + BACKUP` makes `primaryVerdictDue > fundedAt`, so both
    // subtractions are underflow-free BY CONSTRUCTION (checked once at funding, never re-derived unsafely).
    uint256 internal constant CHALLENGE_WINDOW = 2 days;
    uint256 internal constant APPEAL_WINDOW = 5 days;
    uint256 internal constant BACKUP_WINDOW = 2 days;
    /// @notice §8.3 C-5 Model B: how long the emergency cohort has to review an accepted assertion after
    ///         the asserting cohort is disabled. Silence past it REFUNDS — the one explicit exception to
    ///         "timeout preserves the last authenticated state", justified only for a declared systemic
    ///         compromise. Bounded so a disable cannot lock the payer's capital indefinitely.
    uint256 internal constant EMERGENCY_REVIEW_WINDOW = 5 days;

    // ── H-01 §8.2 H-2 challenger-only bond schedule (the "deterministic pre-agreed schedule") ────────
    // Prices {appeal cost + bounded operator delay-harm + anti-spam}. It is NOT job collateralization:
    // the CEILING is what guarantees a payer never has to risk ~the disputed amount to contest an alleged
    // high-tier compromise (which would make recourse nominal). Deterministic — the challenger picks
    // nothing, so there is no "post the minimum" griefing edge inside the frozen [min, max] band.
    uint16 internal constant CHALLENGE_BOND_BPS = 500; // 5% of G, the nominal bond
    uint16 internal constant MAX_CHALLENGE_BOND_BPS = 2000; // 20% of G — the H-2 ceiling; always wins
    uint256 internal constant MIN_CHALLENGE_BOND = 1_000_000; // 1 USDC (6dp) anti-spam floor
    uint16 internal constant DELAY_COMP_BPS = 100; // 1% of G — the operator's CAPPED delay compensation
    /// @notice The burn sink (§2.4 compensate-then-burn). USDC exposes no burn to a holder, so the
    ///         forfeited remainder is sent to a provably unspendable address. It is NOT the treasury and
    ///         NOT the counterparty: a protocol that profits from disputes tunes for more disputes, and a
    ///         counterparty that profits from winning is a bait-a-slash incentive.
    address internal constant BURN_SINK = 0x000000000000000000000000000000000000dEaD;

    // ── H-01 §13.1/H-2 funding-parameter bounds (sized from PHYSICAL REALITY, not from the attack) ───
    // LOWER: the operator's floor. A funded job may never carry a deadline so near that the physical work
    // + evidence + the challenge/appeal/backup windows cannot fit before the payer may reclaim. This is
    // now a DERIVED floor, not a taste: at exactly MIN_RECLAIM_DELAY the operator still has 1 day of
    // working time before `primaryVerdictDue`, and the full §8.1 machine fits before `reclaimAt`.
    uint256 internal constant MIN_RECLAIM_DELAY = CHALLENGE_WINDOW + APPEAL_WINDOW + BACKUP_WINDOW + 1 days;
    // UPPER: long-lead tooling, castings and regulated QC legitimately run months, so ~1 year is the
    // honest ceiling; it also keeps `primaryAssertionCutoff = reclaimAt - challengeWindow - appealWindow`
    // (§8.2 C-3) inside a bounded horizon and makes every timestamp provably fit its packed uint64.
    uint256 internal constant MAX_RECLAIM_DELAY = 365 days;
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
    //   + 16 x (448 + 1056)       per unit: 448 B static head (14 words = 13 fields + the payouts offset)
    //                             + 1056 B payouts tail (32 B length + 16 legs x 64 B per PayoutEntry)
    //   + 4 x 32    =   128       PolicyAcceptance head: expiry, allowSelfAdjudication, 2 bytes offsets
    //   + 2 x (32 + 1024) = 2,112 the two signatures: 32 B length + MAX_SIGNATURE_BYTES payload each
    //   ------------------------
    //   = 4 + 64 + 24,576 + 2,240  =  26,916 B
    // History: 24,644 B at rev-3 (13 head words); +512 B when §B added `evidenceCommitter` (14th word)
    // -> 25,156 B; +2,272 B for the H-01 bilateral `PolicyAcceptance` argument -> 27,428 B; -512 B when
    // Wave 3 retired `disputeWindow` with the dispute path (13 head words again) -> 26,916 B.
    // `test_gas_maxAggregateFunding_fits` builds the true 16x16 maximum with two MAX_SIGNATURE_BYTES
    // signatures and asserts BOTH that it fits and that it equals this constant exactly, so drift in either
    // direction fails the suite. The real griefing caps remain MAX_SETTLEMENT_UNITS /
    // MAX_PAYOUT_LEGS_PER_UNIT / MAX_TOTAL_LEGS_PER_JOB / MAX_SIGNATURE_BYTES.
    uint256 internal constant MAX_CONFIG_BYTES = 26_916;

    // Reserved claim leg indices (§2/§7): PRINCIPAL uses the payout entry index; FEE/REFUND use these sentinels.
    uint256 internal constant FEE_LEG_INDEX = type(uint256).max;
    uint256 internal constant REFUND_LEG_INDEX = type(uint256).max - 1;
    // H-01 §8.3 H-3 bond-bucket legs. Distinct sentinels so a bond leg's `claimId` can never collide with
    // a job leg's for the same unit (`computeClaimId` mixes legIndex AND class, but distinct indices keep
    // the two accounting families separable in logs and off-chain indexers as well).
    uint256 internal constant BOND_LEG_INDEX = type(uint256).max - 2;
    uint256 internal constant DELAY_COMP_LEG_INDEX = type(uint256).max - 3;
    uint256 internal constant BURN_LEG_INDEX = type(uint256).max - 4;

    /// @notice §8.2 H-2 — the deterministic challenger-only bond for a unit of gross `g`.
    /// @dev    `clamp(5% of G, MIN_CHALLENGE_BOND, 20% of G)`, with the CEILING applied LAST so it always
    ///         wins: the frozen rule is `minimumBond <= bond <= maxFraction x G`, and when the anti-spam
    ///         floor would exceed the ceiling (a very small job) the ceiling is the binding constraint —
    ///         a payer must never risk more than `MAX_CHALLENGE_BOND_BPS` of G to contest. Never zero: a
    ///         zero bond is a free challenge, i.e. the costless veto H-01 exists to remove.
    /// @dev NOT `mulDivFloor`: `g` is bounded to uint128 at funding (`toUint128`) and the bps factors are
    ///      uint16 constants, so `g * bps < 2^128 * 2^16 = 2^144` can never overflow uint256. A plain
    ///      checked multiply is therefore exact AND provably safe here, and it keeps the 512-bit mulDiv
    ///      body out of the escrow's bytecode at three extra call sites.
    function challengeBond(uint256 g) internal pure returns (uint256 b) {
        b = (g * CHALLENGE_BOND_BPS) / FEE_DENOMINATOR;
        if (b < MIN_CHALLENGE_BOND) b = MIN_CHALLENGE_BOND;
        uint256 cap = (g * MAX_CHALLENGE_BOND_BPS) / FEE_DENOMINATOR;
        if (b > cap) b = cap;
        if (b == 0) b = 1;
    }

    /// @notice §2.4 — the operator's BOUNDED, pre-agreed delay compensation out of a forfeited bond.
    /// @dev    Capped at both `DELAY_COMP_BPS x G` and the bond itself, so "winning is never a profit":
    ///         the operator is reimbursed a scheduled harm estimate, never the challenger's whole stake.
    function delayCompensation(uint256 g, uint256 bond) internal pure returns (uint256 c) {
        c = (g * DELAY_COMP_BPS) / FEE_DENOMINATOR; // see `challengeBond`: overflow-free by the uint128 bound
        if (c > bond) c = bond;
    }

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
