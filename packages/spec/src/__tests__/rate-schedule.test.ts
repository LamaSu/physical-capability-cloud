/**
 * Tests for rate-schedule.ts — segment DSL, evaluator, and hash computation.
 */

import { describe, it, expect } from "vitest";
import {
  RateScheduleSchema,
  evaluateRateSchedule,
  computeScheduleHash,
  assertScheduleIsWellFormed,
  type RateSchedule,
  type RateSegment,
} from "../types/rate-schedule.js";

// ── Helpers ────────────────────────────────────────────────────────────

const ZERO_HASH = "0x" + "0".repeat(64);
const PUBLISHED = "2026-04-22T00:00:00.000Z";

const ctx = (overrides: Partial<{ now: number; jobValueCents: number; jobsPerDay: number }> = {}) => ({
  now: 1_700_000_000,
  jobValueCents: 1000,
  jobsPerDay: 100,
  ...overrides,
});

function makeSchedule(segments: RateSegment[], version = 1): RateSchedule {
  const partial = { version, segments, publishedAt: PUBLISHED };
  return {
    ...partial,
    scheduleHash: computeScheduleHash(partial),
  };
}

// ── Schema validation ──────────────────────────────────────────────────

describe("RateScheduleSchema", () => {
  it("accepts a minimal constant-segment schedule", () => {
    const s = makeSchedule([
      { kind: "constant", startTime: 0, endTime: null, bps: 500 },
    ]);
    expect(() => RateScheduleSchema.parse(s)).not.toThrow();
  });

  it("rejects empty segment arrays", () => {
    expect(() =>
      RateScheduleSchema.parse({
        scheduleHash: ZERO_HASH,
        version: 1,
        segments: [],
        publishedAt: PUBLISHED,
      }),
    ).toThrow();
  });

  it("rejects a malformed scheduleHash", () => {
    expect(() =>
      RateScheduleSchema.parse({
        scheduleHash: "not-a-hash",
        version: 1,
        segments: [{ kind: "constant", startTime: 0, endTime: null, bps: 500 }],
        publishedAt: PUBLISHED,
      }),
    ).toThrow();
  });

  it("rejects bps > 10000 in any segment kind", () => {
    expect(() =>
      RateScheduleSchema.parse({
        scheduleHash: ZERO_HASH,
        version: 1,
        segments: [{ kind: "constant", startTime: 0, endTime: null, bps: 12000 }],
        publishedAt: PUBLISHED,
      }),
    ).toThrow();
  });

  it("accepts all six segment kinds in one schedule", () => {
    const segments: RateSegment[] = [
      { kind: "constant", startTime: 0, endTime: 100, bps: 500 },
      { kind: "step", startTime: 100, endTime: 200, bps: 400 },
      { kind: "linear-decay", startTime: 200, endTime: 300, startBps: 400, endBps: 100 },
      { kind: "exponential-decay", startTime: 300, endTime: 400, startBps: 300, endBps: 50, decayPerSecond: 0.01 },
      { kind: "adoption-indexed", startTime: 400, endTime: 500, scale: 1000, floorBps: 10, capBps: 800 },
      { kind: "piecewise-value", startTime: 500, endTime: null, thresholdCents: 5000, bpsLow: 0, bpsHigh: 250 },
    ];
    const s = makeSchedule(segments);
    expect(() => RateScheduleSchema.parse(s)).not.toThrow();
    expect(s.segments).toHaveLength(6);
  });
});

// ── evaluateRateSchedule — per-kind ──────────────────────────────────────

describe("evaluateRateSchedule — constant", () => {
  it("returns the segment's bps inside [startTime, endTime)", () => {
    const s = makeSchedule([{ kind: "constant", startTime: 0, endTime: 1000, bps: 750 }]);
    const r = evaluateRateSchedule(s, ctx({ now: 500 }));
    expect(r.bps).toBe(750);
    expect(r.segmentIndex).toBe(0);
    expect(r.kind).toBe("constant");
  });

  it("returns 0 / -1 when now is before any segment", () => {
    const s = makeSchedule([{ kind: "constant", startTime: 1000, endTime: null, bps: 500 }]);
    const r = evaluateRateSchedule(s, ctx({ now: 500 }));
    expect(r.bps).toBe(0);
    expect(r.segmentIndex).toBe(-1);
  });

  it("returns 0 / -1 when now is after the last (closed) segment", () => {
    const s = makeSchedule([{ kind: "constant", startTime: 0, endTime: 100, bps: 500 }]);
    const r = evaluateRateSchedule(s, ctx({ now: 500 }));
    expect(r.bps).toBe(0);
    expect(r.segmentIndex).toBe(-1);
  });

  it("matches the half-open boundary correctly: now == startTime hits, now == endTime misses", () => {
    const s = makeSchedule([
      { kind: "constant", startTime: 100, endTime: 200, bps: 300 },
      { kind: "constant", startTime: 200, endTime: 300, bps: 600 },
    ]);
    expect(evaluateRateSchedule(s, ctx({ now: 100 })).bps).toBe(300);
    // boundary: at exactly endTime of first segment, falls into second
    expect(evaluateRateSchedule(s, ctx({ now: 200 })).bps).toBe(600);
    expect(evaluateRateSchedule(s, ctx({ now: 199 })).bps).toBe(300);
    expect(evaluateRateSchedule(s, ctx({ now: 300 })).bps).toBe(0);
  });
});

describe("evaluateRateSchedule — step", () => {
  it("step segments behave like constant inside their interval", () => {
    const s = makeSchedule([
      { kind: "step", startTime: 0, endTime: 1000, bps: 80 },
      { kind: "step", startTime: 1000, endTime: 2000, bps: 40 },
      { kind: "step", startTime: 2000, endTime: null, bps: 10 },
    ]);
    expect(evaluateRateSchedule(s, ctx({ now: 0 })).bps).toBe(80);
    expect(evaluateRateSchedule(s, ctx({ now: 1500 })).bps).toBe(40);
    expect(evaluateRateSchedule(s, ctx({ now: 999_999 })).bps).toBe(10);
  });
});

describe("evaluateRateSchedule — linear-decay", () => {
  it("interpolates linearly between startBps and endBps", () => {
    const s = makeSchedule([
      { kind: "linear-decay", startTime: 0, endTime: 100, startBps: 1000, endBps: 200 },
    ]);
    expect(evaluateRateSchedule(s, ctx({ now: 0 })).bps).toBe(1000);
    // 50% elapsed → halfway: 1000 - (800 * 0.5) = 600
    expect(evaluateRateSchedule(s, ctx({ now: 50 })).bps).toBe(600);
    // very close to end → close to 200
    expect(evaluateRateSchedule(s, ctx({ now: 99 })).bps).toBe(208);
  });

  it("clamps to [startBps, endBps] when elapsed is out of band", () => {
    const s = makeSchedule([
      { kind: "linear-decay", startTime: 100, endTime: 200, startBps: 500, endBps: 100 },
    ]);
    // before startTime → no segment matches
    expect(evaluateRateSchedule(s, ctx({ now: 50 })).bps).toBe(0);
    // exactly at startTime → startBps
    expect(evaluateRateSchedule(s, ctx({ now: 100 })).bps).toBe(500);
  });
});

describe("evaluateRateSchedule — exponential-decay", () => {
  it("decays from startBps toward endBps floor with given rate", () => {
    const s = makeSchedule([
      { kind: "exponential-decay", startTime: 0, endTime: null, startBps: 1000, endBps: 100, decayPerSecond: 0.01 },
    ]);
    // at startTime → startBps
    expect(evaluateRateSchedule(s, ctx({ now: 0 })).bps).toBe(1000);
    // after a few seconds: 1000 * exp(-0.01 * 100) = 1000 * exp(-1) ≈ 367.88
    const r = evaluateRateSchedule(s, ctx({ now: 100 }));
    expect(r.bps).toBeGreaterThan(360);
    expect(r.bps).toBeLessThan(370);
  });

  it("clamps at endBps floor for large elapsed times", () => {
    const s = makeSchedule([
      { kind: "exponential-decay", startTime: 0, endTime: null, startBps: 1000, endBps: 100, decayPerSecond: 0.01 },
    ]);
    // after 10000 seconds → far past floor
    expect(evaluateRateSchedule(s, ctx({ now: 10_000 })).bps).toBe(100);
  });
});

describe("evaluateRateSchedule — adoption-indexed", () => {
  it("returns capBps when jobsPerDay <= 0 (avoid division by zero)", () => {
    const s = makeSchedule([
      { kind: "adoption-indexed", startTime: 0, endTime: null, scale: 1000, floorBps: 10, capBps: 500 },
    ]);
    expect(evaluateRateSchedule(s, ctx({ jobsPerDay: 0 })).bps).toBe(500);
    expect(evaluateRateSchedule(s, ctx({ jobsPerDay: -5 })).bps).toBe(500);
  });

  it("clamps to floorBps for high jobsPerDay", () => {
    const s = makeSchedule([
      { kind: "adoption-indexed", startTime: 0, endTime: null, scale: 100, floorBps: 5, capBps: 500 },
    ]);
    // 100 / sqrt(1_000_000) = 0.1 → below floor
    expect(evaluateRateSchedule(s, ctx({ jobsPerDay: 1_000_000 })).bps).toBe(5);
  });

  it("clamps to capBps for low jobsPerDay", () => {
    const s = makeSchedule([
      { kind: "adoption-indexed", startTime: 0, endTime: null, scale: 1000, floorBps: 5, capBps: 500 },
    ]);
    // 1000 / sqrt(1) = 1000 → above cap
    expect(evaluateRateSchedule(s, ctx({ jobsPerDay: 1 })).bps).toBe(500);
  });

  it("returns clamped middle value for typical adoption", () => {
    const s = makeSchedule([
      { kind: "adoption-indexed", startTime: 0, endTime: null, scale: 1000, floorBps: 5, capBps: 500 },
    ]);
    // 1000 / sqrt(100) = 100
    expect(evaluateRateSchedule(s, ctx({ jobsPerDay: 100 })).bps).toBe(100);
  });
});

describe("evaluateRateSchedule — piecewise-value", () => {
  it("returns bpsLow for jobValueCents below threshold", () => {
    const s = makeSchedule([
      { kind: "piecewise-value", startTime: 0, endTime: null, thresholdCents: 1000, bpsLow: 0, bpsHigh: 200 },
    ]);
    expect(evaluateRateSchedule(s, ctx({ jobValueCents: 999 })).bps).toBe(0);
  });

  it("returns bpsHigh for jobValueCents at or above threshold", () => {
    const s = makeSchedule([
      { kind: "piecewise-value", startTime: 0, endTime: null, thresholdCents: 1000, bpsLow: 0, bpsHigh: 200 },
    ]);
    expect(evaluateRateSchedule(s, ctx({ jobValueCents: 1000 })).bps).toBe(200);
    expect(evaluateRateSchedule(s, ctx({ jobValueCents: 100_000 })).bps).toBe(200);
  });
});

// ── computeScheduleHash determinism ───────────────────────────────────────

describe("computeScheduleHash", () => {
  it("returns a 0x-prefixed 64-hex-char digest", () => {
    const s = makeSchedule([{ kind: "constant", startTime: 0, endTime: null, bps: 500 }]);
    expect(s.scheduleHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("two structurally identical schedules yield the same hash", () => {
    const s1 = makeSchedule([
      { kind: "constant", startTime: 0, endTime: 100, bps: 500 },
      { kind: "step", startTime: 100, endTime: null, bps: 200 },
    ]);
    const s2 = makeSchedule([
      { kind: "constant", startTime: 0, endTime: 100, bps: 500 },
      { kind: "step", startTime: 100, endTime: null, bps: 200 },
    ]);
    expect(s1.scheduleHash).toBe(s2.scheduleHash);
  });

  it("different segment params yield different hashes", () => {
    const a = makeSchedule([{ kind: "constant", startTime: 0, endTime: null, bps: 500 }]);
    const b = makeSchedule([{ kind: "constant", startTime: 0, endTime: null, bps: 501 }]);
    expect(a.scheduleHash).not.toBe(b.scheduleHash);
  });

  it("a different version yields a different hash even with identical segments", () => {
    const segments: RateSegment[] = [{ kind: "constant", startTime: 0, endTime: null, bps: 500 }];
    const v1 = computeScheduleHash({ version: 1, segments, publishedAt: PUBLISHED });
    const v2 = computeScheduleHash({ version: 2, segments, publishedAt: PUBLISHED });
    expect(v1).not.toBe(v2);
  });

  it("publishedAt does NOT affect the hash (not part of the canonical body)", () => {
    const segments: RateSegment[] = [{ kind: "constant", startTime: 0, endTime: null, bps: 500 }];
    const a = computeScheduleHash({ version: 1, segments, publishedAt: "2026-01-01T00:00:00Z" });
    const b = computeScheduleHash({ version: 1, segments, publishedAt: "2026-12-31T23:59:59Z" });
    expect(a).toBe(b);
  });
});

// ── assertScheduleIsWellFormed ────────────────────────────────────────────

describe("assertScheduleIsWellFormed", () => {
  it("accepts non-overlapping ordered segments", () => {
    const s = makeSchedule([
      { kind: "constant", startTime: 0, endTime: 100, bps: 500 },
      { kind: "constant", startTime: 100, endTime: 200, bps: 200 },
    ]);
    expect(() => assertScheduleIsWellFormed(s)).not.toThrow();
  });

  it("throws on overlapping segments", () => {
    const s = makeSchedule([
      { kind: "constant", startTime: 0, endTime: 200, bps: 500 },
      { kind: "constant", startTime: 100, endTime: 300, bps: 200 },
    ]);
    expect(() => assertScheduleIsWellFormed(s)).toThrow(/overlaps/);
  });

  it("throws when linear-decay endTime <= startTime", () => {
    const s = makeSchedule([
      { kind: "linear-decay", startTime: 100, endTime: 100, startBps: 500, endBps: 200 },
    ]);
    expect(() => assertScheduleIsWellFormed(s)).toThrow(/linear-decay/);
  });
});
