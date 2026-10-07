/**
 * Exact evaluation of a sealed rate schedule, for verifying a royalty rate a clause pinned from it
 * (docs/ECONOMIC_AGREEMENTS.md §2.4, "Pinned rates").
 *
 * `evaluateRateSchedule` (types/rate-schedule.ts) computes in floating point (division, sqrt, exp,
 * Math.round). A verdict that decides whether a deal is refused must not depend on how one platform
 * rounds a double, so the compiler evaluates in exact integer arithmetic instead. It uses the same
 * segment choice and the same round-half-up rule; only the arithmetic is exact. A segment whose rate
 * cannot be evaluated exactly, or that needs a fact the server did not supply, is reported as
 * unverifiable rather than approximated:
 *
 *   constant, step             the segment's bps
 *   linear-decay               round-half-up(startBps + (endBps − startBps) × elapsed / span), exactly
 *   piecewise-value            bpsLow when the unit's value in cents < thresholdCents, else bpsHigh
 *   capture-class-indexed      byClass[captureClass] when the server supplied a class the segment
 *                              pins, else `default`
 *   adoption-indexed           capBps when jobsPerDay <= 0; else round-half-up(scale / sqrt(jobsPerDay))
 *                              exactly, clamped to [floorBps, capBps]; unverifiable when the server
 *                              supplied no jobsPerDay
 *   exponential-decay          endBps when startBps <= endBps (the curve never rises above the floor);
 *                              otherwise unverifiable (e^x has no exact value to round)
 *   no covering segment        0 bps
 */

import type { RateSchedule, RateSegment } from "../types/rate-schedule.js";

export const CAPTURE_CLASS_IDS = ["CC0", "CC1", "CC2", "CC3", "CC4", "CC5"] as const;
export type CaptureClassId = (typeof CAPTURE_CLASS_IDS)[number];

export interface ExactRateContext {
  /** The moment the rate applies: the agreement's `asOf`. */
  now: number;
  /** The unit's gross in hundredths of the currency's major unit, rounded down (§2.4). */
  valueCents: bigint;
  /** Server fact: rolling 24h job count. null when the server did not supply it. */
  jobsPerDay: number | null;
  /** Server fact: the capture class the unit's evidence is held to. null when unknown. */
  captureClass: CaptureClassId | null;
}

export type ExactRate =
  | { ok: true; bps: number; segmentIndex: number }
  | { ok: false; reason: "exponential-decay" | "adoption-needs-jobs-per-day"; segmentIndex: number };

/** Hundredths of the major unit, rounded down: floor(gross × 100 / 10^decimals). */
export function valueInCents(gross: bigint, decimals: number): bigint {
  return (gross * 100n) / 10n ** BigInt(decimals);
}

function covers(seg: RateSegment, now: number): boolean {
  if (now < seg.startTime) return false;
  return seg.endTime === null || now < seg.endTime;
}

/** floor(sqrt(n)) for n >= 0, exactly. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt: negative");
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length + 1) >> 1n); // >= sqrt(n)
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** A finite positive double as an exact fraction p / q, with q a power of two. */
export function exactFraction(x: number): { p: bigint; q: bigint } {
  if (!Number.isFinite(x) || x <= 0) throw new RangeError("exactFraction: expected a finite positive number");
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const exponent = (hi >>> 20) & 0x7ff;
  let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exponent === 0) {
    e = -1074; // subnormal
  } else {
    mantissa |= 1n << 52n;
    e = exponent - 1075;
  }
  return e >= 0 ? { p: mantissa << BigInt(e), q: 1n } : { p: mantissa, q: 1n << BigInt(-e) };
}

/** round-half-up(p / (q × sqrt(j))) for p, q, j > 0, exactly. */
function roundScaleOverSqrt(p: bigint, q: bigint, j: bigint): bigint {
  // m = floor(2p / (q sqrt j)) = isqrt(floor(4p² / (q² j))); the rounded value r satisfies 2r − 1 <= m.
  const m = isqrt((4n * p * p) / (q * q * j));
  return (m + 1n) / 2n;
}

function clampBps(v: bigint): number {
  return Number(v < 0n ? 0n : v > 10_000n ? 10_000n : v);
}

export function evaluateScheduleExact(schedule: Pick<RateSchedule, "segments">, ctx: ExactRateContext): ExactRate {
  const i = schedule.segments.findIndex((s) => covers(s, ctx.now));
  if (i < 0) return { ok: true, bps: 0, segmentIndex: -1 };
  const seg = schedule.segments[i]!;
  switch (seg.kind) {
    case "constant":
    case "step":
      return { ok: true, bps: clampBps(BigInt(seg.bps)), segmentIndex: i };
    case "linear-decay": {
      const span = BigInt(seg.endTime) - BigInt(seg.startTime); // > 0 whenever the segment covers now
      const elapsed = BigInt(ctx.now) - BigInt(seg.startTime);
      const num = BigInt(seg.startBps) * span + (BigInt(seg.endBps) - BigInt(seg.startBps)) * elapsed; // >= 0
      return { ok: true, bps: clampBps((2n * num + span) / (2n * span)), segmentIndex: i };
    }
    case "piecewise-value":
      return { ok: true, bps: clampBps(BigInt(ctx.valueCents < BigInt(seg.thresholdCents) ? seg.bpsLow : seg.bpsHigh)), segmentIndex: i };
    case "capture-class-indexed": {
      const pinned = ctx.captureClass === null ? undefined : seg.byClass[ctx.captureClass];
      return { ok: true, bps: clampBps(BigInt(pinned ?? seg.default)), segmentIndex: i };
    }
    case "adoption-indexed": {
      if (ctx.jobsPerDay === null) return { ok: false, reason: "adoption-needs-jobs-per-day", segmentIndex: i };
      if (ctx.jobsPerDay <= 0) return { ok: true, bps: clampBps(BigInt(seg.capBps)), segmentIndex: i };
      const { p, q } = exactFraction(seg.scale);
      const rounded = roundScaleOverSqrt(p, q, BigInt(ctx.jobsPerDay));
      // max(floor, min(cap, ·)) exactly as the float evaluator; rounding is monotone and fixes
      // integers, so rounding before the clamp gives the same value as rounding after it.
      const floor = BigInt(seg.floorBps);
      const cap = BigInt(seg.capBps);
      const inCap = rounded < cap ? rounded : cap;
      return { ok: true, bps: clampBps(inCap > floor ? inCap : floor), segmentIndex: i };
    }
    case "exponential-decay":
      if (seg.startBps <= seg.endBps) return { ok: true, bps: clampBps(BigInt(seg.endBps)), segmentIndex: i };
      return { ok: false, reason: "exponential-decay", segmentIndex: i };
  }
}
