/**
 * RateSchedule — packed Segment[] DSL for off-chain rate curve evaluation.
 *
 * Inspired by Sablier's LockupTranched + LockupDynamic encoding (scout-schedules-bravo
 * landscape research, 02-rate-schedule-dsl.md). A schedule is a sealed, content-addressed
 * sequence of segments; the contributor publishes it once per ContributorNFT version,
 * and the protocol honors it forever (until they ship a new version under a new NFT).
 *
 * Six segment kinds cover the curve types from the research:
 *   - constant:           "50bps flat from t0 to t1 (or forever)"
 *   - step:               single bps from t0 forward (used for absolute step-functions)
 *   - linear-decay:       interpolates startBps → endBps linearly between t0 and t1
 *   - exponential-decay:  bps = startBps * exp(-k * elapsed), clamped at endBps floor
 *   - adoption-indexed:   bps = clamp(scale / sqrt(jobsPerDay), floor, cap)
 *   - piecewise-value:    bps depends on jobValueCents (under threshold → low, else high)
 *
 * Evaluation: walk segments in order, find the one whose [startTime, endTime) contains
 * `now`, evaluate its formula. Schedules without a covering segment evaluate to 0 bps
 * (treated as "no payout for this contributor at this moment").
 *
 * Hashing: scheduleHash = sha256 over canonicalized JSON of {version, segments}. The
 * canonical form sorts object keys lexicographically at all depths, so two structurally-
 * identical schedules always produce the same hash.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { canonicalize } from "../util/canonical.js";

// ── Segment kinds (discriminator) ─────────────────────────────────────

export const RateSegmentKindSchema = z.enum([
  "constant",
  "step",
  "linear-decay",
  "exponential-decay",
  "adoption-indexed",
  "piecewise-value",
] as const);
export type RateSegmentKind = z.infer<typeof RateSegmentKindSchema>;

// ── Segment params per kind ────────────────────────────────────────────

/** Constant bps from startTime to endTime (endTime null = forever). */
export const ConstantSegmentSchema = z.object({
  kind: z.literal("constant"),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0).nullable(),
  bps: z.number().int().min(0).max(10000),
});
export type ConstantSegment = z.infer<typeof ConstantSegmentSchema>;

/**
 * Step segment — a single absolute bps value starting at startTime.
 * endTime is the next segment's startTime (or null for forever).
 */
export const StepSegmentSchema = z.object({
  kind: z.literal("step"),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0).nullable(),
  bps: z.number().int().min(0).max(10000),
});
export type StepSegment = z.infer<typeof StepSegmentSchema>;

/** Linear interpolation from startBps at startTime → endBps at endTime. */
export const LinearDecaySegmentSchema = z.object({
  kind: z.literal("linear-decay"),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0),
  startBps: z.number().int().min(0).max(10000),
  endBps: z.number().int().min(0).max(10000),
});
export type LinearDecaySegment = z.infer<typeof LinearDecaySegmentSchema>;

/**
 * Exponential decay: bps(t) = max(endBps, startBps * exp(-decayPerSecond * (t - startTime))).
 * `decayPerSecond` is a positive float. endBps acts as a floor.
 */
export const ExponentialDecaySegmentSchema = z.object({
  kind: z.literal("exponential-decay"),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0).nullable(),
  startBps: z.number().int().min(0).max(10000),
  endBps: z.number().int().min(0).max(10000),
  decayPerSecond: z.number().positive(),
});
export type ExponentialDecaySegment = z.infer<typeof ExponentialDecaySegmentSchema>;

/**
 * Adoption-indexed: bps = clamp(scale / sqrt(jobsPerDay), floorBps, capBps).
 * Used to express "the busier the network gets, the smaller my cut."
 * If jobsPerDay <= 0 the result is capBps.
 */
export const AdoptionIndexedSegmentSchema = z.object({
  kind: z.literal("adoption-indexed"),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0).nullable(),
  scale: z.number().positive(),
  floorBps: z.number().int().min(0).max(10000),
  capBps: z.number().int().min(0).max(10000),
});
export type AdoptionIndexedSegment = z.infer<typeof AdoptionIndexedSegmentSchema>;

/**
 * Piecewise-value: bps depends on jobValueCents.
 * If jobValueCents < thresholdCents → bpsLow, else → bpsHigh.
 */
export const PiecewiseValueSegmentSchema = z.object({
  kind: z.literal("piecewise-value"),
  startTime: z.number().int().min(0),
  endTime: z.number().int().min(0).nullable(),
  thresholdCents: z.number().int().min(0),
  bpsLow: z.number().int().min(0).max(10000),
  bpsHigh: z.number().int().min(0).max(10000),
});
export type PiecewiseValueSegment = z.infer<typeof PiecewiseValueSegmentSchema>;

// ── Discriminated union ─────────────────────────────────────────────────

export const RateSegmentSchema = z.discriminatedUnion("kind", [
  ConstantSegmentSchema,
  StepSegmentSchema,
  LinearDecaySegmentSchema,
  ExponentialDecaySegmentSchema,
  AdoptionIndexedSegmentSchema,
  PiecewiseValueSegmentSchema,
]);
export type RateSegment = z.infer<typeof RateSegmentSchema>;

// ── RateSchedule ─────────────────────────────────────────────────────────

/**
 * A sealed, content-addressed rate schedule.
 *
 * @property scheduleHash  sha256 of canonical {version, segments} as 0x<64 hex>.
 *                         A schedule's identity. Two structurally-identical schedules
 *                         (same version, same segments) MUST have the same hash.
 * @property version       Schema version. v=1 is first published. Bumping = a new
 *                         schedule + a new ContributorNFT version (the prior schedule
 *                         remains immutable for any payouts that pre-date the bump).
 * @property segments      Ordered piecewise pieces. startTime monotonically non-decreasing.
 *                         Each segment's startTime ≥ prior segment's endTime (gaps allowed
 *                         and evaluate to 0 bps; overlaps are forbidden by validation).
 * @property notes         Author rationale; not load-bearing.
 * @property publishedAt   ISO 8601 — when the contributor sealed this schedule.
 */
export const RateScheduleSchema = z.object({
  scheduleHash: z.string().regex(/^0x[a-f0-9]{64}$/i),
  version: z.number().int().min(1),
  segments: z.array(RateSegmentSchema).min(1),
  notes: z.string().optional(),
  publishedAt: z.string(),
});
export type RateSchedule = z.infer<typeof RateScheduleSchema>;

// ── Evaluation ────────────────────────────────────────────────────────────

export interface RateScheduleEvaluationContext {
  /** Unix seconds at evaluation moment. */
  now: number;
  /** Job value in cents (used by piecewise-value segments). */
  jobValueCents: number;
  /** Rolling 24h job count (used by adoption-indexed segments). */
  jobsPerDay: number;
}

export interface RateScheduleEvaluationResult {
  /** Effective bps (0-10000) at the evaluation moment. */
  bps: number;
  /** Index into segments[] of the matched segment, or -1 if no segment matched. */
  segmentIndex: number;
  /** Kind of the matched segment. Defaults to "constant" when nothing matched. */
  kind: RateSegmentKind;
}

/**
 * Returns true when `now` falls inside the half-open interval [start, end). When
 * end is null, the segment runs forever (start ≤ now).
 */
function segmentCovers(seg: RateSegment, now: number): boolean {
  if (now < seg.startTime) return false;
  if (seg.kind === "linear-decay") {
    // linear-decay always has a numeric endTime
    return now < seg.endTime;
  }
  return seg.endTime === null || now < seg.endTime;
}

/**
 * Evaluate a rate schedule at a given moment. Pure, deterministic.
 * Returns 0 bps + segmentIndex=-1 if no segment matches `now`.
 */
export function evaluateRateSchedule(
  schedule: RateSchedule,
  context: RateScheduleEvaluationContext,
): RateScheduleEvaluationResult {
  const { now, jobValueCents, jobsPerDay } = context;

  for (let i = 0; i < schedule.segments.length; i++) {
    const seg = schedule.segments[i];
    if (!segmentCovers(seg, now)) continue;

    let bps: number;
    switch (seg.kind) {
      case "constant":
      case "step":
        bps = seg.bps;
        break;

      case "linear-decay": {
        const span = seg.endTime - seg.startTime;
        if (span <= 0) {
          bps = seg.startBps;
        } else {
          const elapsed = now - seg.startTime;
          const t = Math.min(1, Math.max(0, elapsed / span));
          bps = seg.startBps + (seg.endBps - seg.startBps) * t;
        }
        break;
      }

      case "exponential-decay": {
        const elapsed = Math.max(0, now - seg.startTime);
        const decayed = seg.startBps * Math.exp(-seg.decayPerSecond * elapsed);
        bps = Math.max(seg.endBps, decayed);
        break;
      }

      case "adoption-indexed": {
        if (jobsPerDay <= 0) {
          bps = seg.capBps;
        } else {
          const raw = seg.scale / Math.sqrt(jobsPerDay);
          bps = Math.max(seg.floorBps, Math.min(seg.capBps, raw));
        }
        break;
      }

      case "piecewise-value":
        bps = jobValueCents < seg.thresholdCents ? seg.bpsLow : seg.bpsHigh;
        break;
    }

    // Round + clamp to legal bps range.
    const finalBps = Math.max(0, Math.min(10000, Math.round(bps)));
    return { bps: finalBps, segmentIndex: i, kind: seg.kind };
  }

  // No segment matched — silent gap. Treat as "no payout right now."
  return { bps: 0, segmentIndex: -1, kind: "constant" };
}

// ── Hashing ───────────────────────────────────────────────────────────────

/**
 * Compute the canonical scheduleHash for a RateSchedule (sans the hash field
 * itself). Returns a 0x-prefixed sha256 hex digest. Deterministic — sorted keys
 * at all depths via `canonicalize`.
 *
 * Note: although the on-chain payout map uses bytes32 fields filled with viem
 * keccak256 values, the schedule-hash here is purely off-chain content addressing.
 * It needs the right shape (0x + 64 hex) and determinism, not a specific algo.
 * sha256 keeps @pcc/spec viem-free (no new transitive deps).
 */
export function computeScheduleHash(
  schedule: Omit<RateSchedule, "scheduleHash"> | RateSchedule,
): `0x${string}` {
  const payload = {
    version: schedule.version,
    segments: schedule.segments,
  };
  const canonical = canonicalize(payload);
  const hex = createHash("sha256").update(canonical).digest("hex");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Validate that a RateSchedule's segments are non-overlapping and time-ordered.
 * Throws on violation. Used by upstream `setRateSchedule` callers; pure.
 */
export function assertScheduleIsWellFormed(schedule: RateSchedule): void {
  let prevEnd: number | null = null;
  for (let i = 0; i < schedule.segments.length; i++) {
    const seg = schedule.segments[i];

    if (prevEnd !== null && seg.startTime < prevEnd) {
      throw new Error(
        `RateSchedule segments[${i}] startTime ${seg.startTime} overlaps prior segment endTime ${prevEnd}`,
      );
    }

    // For linear-decay, endTime is required and must be > startTime.
    if (seg.kind === "linear-decay") {
      if (seg.endTime <= seg.startTime) {
        throw new Error(
          `RateSchedule segments[${i}] linear-decay endTime ${seg.endTime} must exceed startTime ${seg.startTime}`,
        );
      }
    }

    if (seg.endTime !== null && seg.endTime < seg.startTime) {
      throw new Error(
        `RateSchedule segments[${i}] endTime ${seg.endTime} cannot precede startTime ${seg.startTime}`,
      );
    }

    prevEnd = seg.endTime;
  }
}
