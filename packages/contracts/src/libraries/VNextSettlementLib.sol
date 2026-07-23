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

library VNextSettlementLib {
    // ── FROZEN pinned constants (§6, E6) ────────────────────────────────────
    uint8 internal constant DOMAIN_VERSION_V1 = 1;
    uint16 internal constant MAX_FEE_BPS = 1000; // 10% hard cap (seam §0.1 / #391 confirmed)
    uint256 internal constant FEE_DENOMINATOR = 10_000;
    uint8 internal constant FEE_BASIS_GROSS = 0;
    uint8 internal constant ROUNDING_FLOOR = 0;
    bytes32 internal constant SETTLEMENT_UNIT_DOMAIN = keccak256("PCC:vnext:settlement-unit:v1");

    // ── FROZEN limits (§6) ──────────────────────────────────────────────────
    uint256 internal constant MAX_PAYOUT_LEGS_PER_UNIT = 16;
    uint256 internal constant MAX_FEE_LEGS_PER_UNIT = 1;
    uint256 internal constant MAX_SETTLEMENT_UNITS = 16;
    uint256 internal constant MAX_TOTAL_LEGS_PER_JOB = 256; // counts PAYOUT entries only (16x16); a release may add +1 fee claim
    uint256 internal constant MAX_CONFIG_BYTES = 24576; // §6 funding-calldata bound

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
