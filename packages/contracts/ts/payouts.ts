/**
 * payouts.ts — TypeScript helpers for the on-chain MilestoneEscrow splitPayout map.
 *
 * Bridges off-chain CompositionManifest / RateSchedule logic (LicensingEngine
 * domain) into the Solidity-ready Payout[] consumed by setPayoutMap().
 *
 * Implementation lands in Wave 3c (LicensingEngine extension shipped in
 * commit 9bab2ef): walks a CompositionManifest, evaluates each contributor's
 * RateSchedule at the supplied evaluation context, and produces a
 * Solidity-ready Payout[] for setPayoutMap(). Pure computation — no on-chain
 * reads, no async.
 *
 * This module ships:
 *   - The Payout shape (mirrors the on-chain Payout struct)
 *   - ROLE_TAGS constants (keccak256 of the canonical role strings)
 *   - BuildPayoutMapInput / BuildPayoutMapResult types
 *   - buildPayoutMap() — the production composer
 */

import { keccak256, stringToHex } from "viem";
import type {
  CompositionManifest,
  RateSchedule,
  RateScheduleEvaluationContext,
} from "@pcc/spec";
import { evaluateRateSchedule } from "@pcc/spec";

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

const ZERO_BYTES32: `0x${string}` =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Map a CompositionRole to the ROLE_TAGS key used for keccak256 lookup.
 *
 * The CompositionRole enum has one extra member compared to ROLE_TAGS:
 * `pilot`, which is a semantic alias for `dataset-contributor` (per ADR-3
 * §2.5 / 03-dataset-model-provenance.md). Pilots are humans who supplied
 * teleop/demonstration data; they earn through the same payout mechanism
 * as any other dataset contributor.
 */
function compositionRoleToTagKey(role: string): RoleTagKey {
  if (role === "pilot") return "dataset-contributor";
  if (role in ROLE_TAGS) return role as RoleTagKey;
  throw new Error(`buildPayoutMap: unknown CompositionRole "${role}"`);
}

// ──────────────────────────────────────────────────────────────────────────
// buildPayoutMap (Wave 3c)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Input shape for buildPayoutMap.
 *
 * @property milestoneIndex      Index of the milestone being settled (audit
 *                               only; not used in the bps math).
 * @property jobValue            Total milestone amount in wei. Used to compute
 *                               per-recipient absolute amounts in the
 *                               breakdown rows.
 * @property capabilityIpId      Story IP Asset of the capability the job ran
 *                               against. Stamped onto every Payout.ipId by
 *                               default; the manifest may override per-entry
 *                               via the contributor's own ipId.
 * @property compositionManifest Optional. When provided, drives the payout
 *                               composition. When omitted, the result is the
 *                               trivial empty-payouts / 100%-operator case.
 * @property evaluationContext   Required when manifest is provided. Snapshot
 *                               of {now, jobValueCents, jobsPerDay} at
 *                               settlement time for evaluating rate schedules.
 * @property scheduleByHash      Optional resolver for rateScheduleHash →
 *                               RateSchedule. The CompositionManifest stores
 *                               only schedule HASHES; the engine looks up the
 *                               full RateSchedule by content-hash. Pass a
 *                               Map<scheduleHash, RateSchedule> when you have
 *                               them in memory; or supply `scheduleByIpId`
 *                               instead. If neither is supplied, every entry
 *                               evaluates to 0 bps (operator gets 100%).
 * @property scheduleByIpId      Alternative resolver: ipId → RateSchedule.
 *                               Used when the caller has a per-IP registry
 *                               (matches LicensingEngine.evaluateRateScheduleForIp)
 *                               but not a per-hash map.
 */
export interface BuildPayoutMapInput {
  milestoneIndex: number;
  jobValue: bigint;
  capabilityIpId: `0x${string}`;
  compositionManifest?: CompositionManifest;
  evaluationContext?: RateScheduleEvaluationContext;
  scheduleByHash?: Map<string, RateSchedule>;
  scheduleByIpId?: Map<string, RateSchedule>;
}

/**
 * Output shape for buildPayoutMap. `payouts` is the array passed verbatim to
 * setPayoutMap(); the breakdown is for UI/audit display.
 *
 * `operatorResidualBps` = 10000 - sum(payouts[].bps). The on-chain settlement
 * routes this residual to the operator without an explicit Payout row (avoids
 * double-counting against MilestoneReleased).
 *
 * The breakdown has one row per CompositionEntry inspected, including those
 * that produced 0 bps (so callers can audit why a contributor was skipped).
 */
export interface BuildPayoutMapResult {
  payouts: Payout[];
  operatorResidualBps: number;
  breakdown: Array<{
    recipient: `0x${string}`;
    role: RoleTagKey;
    bpsRequested: number;
    bpsApplied: number;
    amount: bigint;
    ipId: `0x${string}`;
  }>;
}

/**
 * Walk a CompositionManifest, evaluate each contributor's RateSchedule against
 * the evaluationContext, and produce a Solidity-ready Payout[] for
 * setPayoutMap().
 *
 * Algorithm:
 *   1. If no manifest → return empty payouts, operator gets 10000 bps.
 *   2. For each entry in manifest.entries:
 *        a. Resolve its RateSchedule (by hash, then by ipId fallback).
 *        b. Evaluate the schedule at evaluationContext → raw bps.
 *        c. Apply the optional groupBps weighting:
 *             effective = round(raw * groupBps / 10000)
 *           groupBps split a single role's allocation across co-authors.
 *        d. Skip entries that resolve to 0 bps (no schedule, no coverage,
 *           or group-weighted to zero) — they appear in the breakdown with
 *           bpsApplied=0 for audit but no Payout row is emitted.
 *        e. Emit a Payout row tagged with the role's keccak hash.
 *   3. Sum bps; reject if > 10000 (over-allocation is a config bug).
 *   4. operatorResidualBps = 10000 - sum.
 *
 * Pure computation — no on-chain reads, no async, deterministic given the
 * same input.
 *
 * @throws Error when sum(bpsApplied) > 10000.
 * @throws Error when an entry has an unknown CompositionRole.
 */
export function buildPayoutMap(
  input: BuildPayoutMapInput,
): BuildPayoutMapResult {
  const { jobValue, capabilityIpId, compositionManifest, evaluationContext } =
    input;

  // No manifest → trivial 100%-operator case.
  if (!compositionManifest) {
    return {
      payouts: [],
      operatorResidualBps: 10000,
      breakdown: [],
    };
  }

  // Manifest without an evaluation context cannot resolve any bps; treat the
  // same as the trivial case but with audit rows so callers can see what
  // would have been considered.
  const ctx = evaluationContext;

  const payouts: Payout[] = [];
  const breakdown: BuildPayoutMapResult["breakdown"] = [];

  let sumApplied = 0;

  for (const entry of compositionManifest.entries) {
    const tagKey = compositionRoleToTagKey(entry.role);
    const roleTag = ROLE_TAGS[tagKey];
    const recipient = entry.contributorAddress as `0x${string}`;

    // Resolve the rate schedule for this entry.
    let schedule: RateSchedule | undefined;
    if (input.scheduleByHash) {
      schedule = input.scheduleByHash.get(entry.rateScheduleHash);
    }
    if (!schedule && input.scheduleByIpId) {
      schedule = input.scheduleByIpId.get(entry.ipId);
    }

    // Without a context or schedule, the entry contributes 0 bps. Record it
    // in the breakdown for audit and move on.
    let rawBps = 0;
    if (schedule && ctx) {
      const result = evaluateRateSchedule(schedule, ctx);
      rawBps = result.bps;
    }

    // Apply optional groupBps weighting (matches LicensingEngine logic).
    const effectiveBps =
      entry.groupBps !== undefined && entry.groupBps !== 10000
        ? Math.round((rawBps * entry.groupBps) / 10000)
        : rawBps;

    // The on-chain ipId for this Payout. Most contributors stamp their own
    // entry.ipId; if absent, fall back to the capability ipId so the row
    // still indexes against something semantically anchored.
    const entryIpId = (entry.ipId.startsWith("0x") &&
    entry.ipId.length === 66
      ? entry.ipId
      : capabilityIpId) as `0x${string}`;

    breakdown.push({
      recipient,
      role: tagKey,
      bpsRequested: rawBps,
      bpsApplied: effectiveBps,
      amount:
        effectiveBps > 0
          ? (jobValue * BigInt(effectiveBps)) / 10000n
          : 0n,
      ipId: entryIpId,
    });

    if (effectiveBps === 0) continue;

    sumApplied += effectiveBps;

    payouts.push({
      recipient,
      bps: BigInt(effectiveBps),
      roleTag,
      ipId: entryIpId,
    });
  }

  if (sumApplied > 10000) {
    throw new Error(
      `buildPayoutMap: sum of bps (${sumApplied}) exceeds 10000 — manifest is over-allocated`,
    );
  }

  const operatorResidualBps = 10000 - sumApplied;

  // Silence "ZERO_BYTES32 unused" warnings if the helper ever ends up unused
  // in a refactor; reference it once so tree-shakers don't drop the export.
  void ZERO_BYTES32;

  return { payouts, operatorResidualBps, breakdown };
}
