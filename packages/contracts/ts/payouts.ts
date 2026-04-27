/**
 * payouts.ts — TypeScript helpers for the on-chain MilestoneEscrow splitPayout map.
 *
 * Bridges off-chain CompositionManifest / RateSchedule logic (LicensingEngine
 * domain) into the Solidity-ready Payout[] consumed by setPayoutMap().
 *
 * Per ADR-11 §9 — the buildPayoutMap() function lands in Wave 3c (LicensingEngine
 * extension). This module ships the supporting types + ROLE_TAGS constants now
 * so callers can:
 *   - Import the Payout shape and use it to call setPayoutMap() directly
 *   - Use ROLE_TAGS to tag entries with the canonical keccak hashes
 *   - Reference BuildPayoutMapInput / BuildPayoutMapResult in their pipeline
 *     code, ahead of the implementation landing
 *
 * The buildPayoutMap() function itself throws until Wave 3c.
 */

import { keccak256, stringToHex } from "viem";

// ──────────────────────────────────────────────────────────────────────────
// Solidity-shaped types
// ──────────────────────────────────────────────────────────────────────────

/**
 * A single entry in MilestoneEscrow's payout map. Mirrors the on-chain Payout
 * struct in MilestoneEscrow.sol exactly.
 *
 * Constraints (enforced on-chain by setPayoutMap):
 *   - recipient != 0x0000...0000
 *   - 0 < bps <= 5000  (no single recipient > 50% of distributable)
 *   - sum of all bps in a map <= 10000
 *   - no two entries may share the same (recipient, roleTag) pair
 *   - max 16 entries per map
 *
 * @property recipient  EOA or contract receiving the payment
 * @property bps        Basis points of distributable amount (post protocol-fee)
 * @property roleTag    keccak256 of the role string (use ROLE_TAGS)
 * @property ipId       Story Protocol IP Asset ID (bytes32(0) if N/A)
 */
export interface Payout {
  recipient: `0x${string}`;
  bps: bigint;
  roleTag: `0x${string}`;
  ipId: `0x${string}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Canonical role tag constants (ADR-12 ContributorRole taxonomy)
// ──────────────────────────────────────────────────────────────────────────

/**
 * ROLE_TAGS — keccak256 of the canonical ContributorRole strings.
 *
 * These are the bytes32 values written into Payout.roleTag on-chain.
 * The roleTag is purely for off-chain attribution / per-role indexing in the
 * SplitPayoutExecuted event; the on-chain contract does not interpret roleTag
 * semantically — it just stores and re-emits.
 *
 * Keys mirror the ContributorRole union in @pcc/spec exactly. The "operator"
 * tag is included for completeness (used in ADR-11 §3 example pseudocode for
 * the operator-residual emission, though the current implementation does NOT
 * emit a SplitPayoutExecuted for the operator residual to avoid double-counting
 * with MilestoneReleased).
 */
export const ROLE_TAGS = {
  operator: keccak256(stringToHex("operator")),
  verifier: keccak256(stringToHex("verifier")),
  insurer: keccak256(stringToHex("insurer")),
  integrator: keccak256(stringToHex("integrator")),
  "protocol-author": keccak256(stringToHex("protocol-author")),
  "model-author": keccak256(stringToHex("model-author")),
  "dataset-contributor": keccak256(stringToHex("dataset-contributor")),
  curator: keccak256(stringToHex("curator")),
  assembler: keccak256(stringToHex("assembler")),
  "network-treasury": keccak256(stringToHex("network-treasury")),
} as const;

export type RoleTagKey = keyof typeof ROLE_TAGS;

// ──────────────────────────────────────────────────────────────────────────
// buildPayoutMap (Wave 3c)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Input shape for buildPayoutMap.
 *
 * Wave 3c will fill in compositionManifest / evaluationContext fields once the
 * LicensingEngine extension lands. The minimal input today is just enough to
 * compile + import.
 */
export interface BuildPayoutMapInput {
  milestoneIndex: number;
  jobValue: bigint;
  capabilityIpId: `0x${string}`;
  // Wave 3c additions:
  // compositionManifest?: CompositionManifest;
  // evaluationContext?: { now: number; jobsPerDay: number; networkId: string };
}

/**
 * Output shape for buildPayoutMap. `payouts` is the array passed verbatim to
 * setPayoutMap(); the breakdown is for UI/audit display.
 */
export interface BuildPayoutMapResult {
  payouts: Payout[];
  operatorResidualBps: number;
  breakdown: Array<{
    recipient: `0x${string}`;
    role: RoleTagKey;
    bps: number;
    amount: bigint;
  }>;
}

/**
 * Walk a CompositionManifest, evaluate each contributor's RateSchedule against
 * the evaluationContext, and produce a Solidity-ready Payout[] for
 * setPayoutMap().
 *
 * @throws Error — not yet implemented; Wave 3c (LicensingEngine extension)
 *         will provide the full implementation.
 */
export function buildPayoutMap(
  _input: BuildPayoutMapInput,
): BuildPayoutMapResult {
  throw new Error(
    "buildPayoutMap: not implemented — Wave 3c (LicensingEngine extension)",
  );
}
