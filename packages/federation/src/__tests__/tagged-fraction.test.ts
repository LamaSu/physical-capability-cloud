import { describe, expect, it } from "vitest";
import {
  createTaggedFraction,
  taggedFractionEquals,
  taggedFractionMerge,
  taggedFractionMergeAll,
  taggedFractionRecord,
  taggedFractionValue,
} from "../crdts/tagged-fraction.js";

describe("Tagged-Fraction CRDT", () => {
  describe("createTaggedFraction", () => {
    it("creates an empty state with null ratio", () => {
      const s = createTaggedFraction();
      const v = taggedFractionValue(s);
      expect(v.numerator).toBe(0);
      expect(v.denominator).toBe(0);
      expect(v.ratio).toBeNull();
    });
  });

  describe("taggedFractionRecord", () => {
    it("accumulates numerator and denominator per replica", () => {
      let s = createTaggedFraction();
      s = taggedFractionRecord(s, "us-east-1", 1, 1); // success
      s = taggedFractionRecord(s, "us-east-1", 0, 1); // failure
      s = taggedFractionRecord(s, "us-east-1", 1, 1); // success
      expect(s.slots["us-east-1"]).toEqual({ numerator: 2, denominator: 3 });
      const v = taggedFractionValue(s);
      expect(v.ratio).toBeCloseTo(2 / 3, 9);
    });

    it("supports weighted observations (latency sum)", () => {
      let s = createTaggedFraction();
      s = taggedFractionRecord(s, "r1", 100); // 100ms one call
      s = taggedFractionRecord(s, "r1", 200); // 200ms one call
      s = taggedFractionRecord(s, "r1", 300); // 300ms one call
      const v = taggedFractionValue(s);
      expect(v.ratio).toBeCloseTo(200, 6); // mean latency 200ms
    });

    it("does not mutate input", () => {
      const s = createTaggedFraction();
      const snap = JSON.stringify(s);
      taggedFractionRecord(s, "r", 1, 1);
      expect(JSON.stringify(s)).toBe(snap);
    });

    it("returns identical reference on zero/zero observation", () => {
      const s = createTaggedFraction();
      expect(taggedFractionRecord(s, "r", 0, 0)).toBe(s);
    });

    it("rejects negative numerators", () => {
      expect(() =>
        taggedFractionRecord(createTaggedFraction(), "r", -1, 1),
      ).toThrow(/non-negative/);
    });

    it("rejects non-finite values", () => {
      expect(() =>
        taggedFractionRecord(createTaggedFraction(), "r", NaN, 1),
      ).toThrow(/non-negative/);
    });
  });

  describe("merge", () => {
    it("takes per-replica MAX on both numerator and denominator", () => {
      const a = taggedFractionRecord(createTaggedFraction(), "r1", 3, 5);
      const b = taggedFractionRecord(createTaggedFraction(), "r1", 4, 4);
      const m = taggedFractionMerge(a, b);
      expect(m.slots["r1"]).toEqual({ numerator: 4, denominator: 5 });
    });

    it("preserves slots only present in one operand", () => {
      const a = taggedFractionRecord(createTaggedFraction(), "r1", 1, 2);
      const b = taggedFractionRecord(createTaggedFraction(), "r2", 3, 4);
      const m = taggedFractionMerge(a, b);
      expect(m.slots["r1"]).toEqual({ numerator: 1, denominator: 2 });
      expect(m.slots["r2"]).toEqual({ numerator: 3, denominator: 4 });
    });

    it("is commutative", () => {
      const a = taggedFractionRecord(createTaggedFraction(), "r1", 7, 10);
      const b = taggedFractionRecord(createTaggedFraction(), "r1", 5, 12);
      expect(
        taggedFractionEquals(
          taggedFractionMerge(a, b),
          taggedFractionMerge(b, a),
        ),
      ).toBe(true);
    });

    it("is associative", () => {
      const a = taggedFractionRecord(createTaggedFraction(), "r1", 1, 2);
      const b = taggedFractionRecord(createTaggedFraction(), "r2", 3, 4);
      const c = taggedFractionRecord(createTaggedFraction(), "r1", 5, 6);
      const left = taggedFractionMerge(taggedFractionMerge(a, b), c);
      const right = taggedFractionMerge(a, taggedFractionMerge(b, c));
      expect(taggedFractionEquals(left, right)).toBe(true);
    });

    it("is idempotent", () => {
      const a = taggedFractionRecord(
        taggedFractionRecord(createTaggedFraction(), "r1", 1, 1),
        "r2",
        2,
        3,
      );
      expect(taggedFractionEquals(taggedFractionMerge(a, a), a)).toBe(true);
    });

    it("does not mutate inputs", () => {
      const a = taggedFractionRecord(createTaggedFraction(), "r1", 1, 1);
      const b = taggedFractionRecord(createTaggedFraction(), "r2", 2, 2);
      const aSnap = JSON.stringify(a);
      const bSnap = JSON.stringify(b);
      taggedFractionMerge(a, b);
      expect(JSON.stringify(a)).toBe(aSnap);
      expect(JSON.stringify(b)).toBe(bSnap);
    });
  });

  describe("mergeAll", () => {
    it("folds N states", () => {
      const replicas = ["us", "eu", "ap"];
      const states = replicas.map((r) =>
        taggedFractionRecord(
          taggedFractionRecord(createTaggedFraction(), r, 1, 1),
          r,
          0,
          1,
        ),
      );
      const merged = taggedFractionMergeAll(states);
      const v = taggedFractionValue(merged);
      expect(v.numerator).toBe(3); // 1 per replica
      expect(v.denominator).toBe(6); // 2 per replica
      expect(v.ratio).toBeCloseTo(0.5, 9);
    });
  });

  describe("realistic successRate scenario", () => {
    it("3-region successRate aggregates correctly", () => {
      // us: 95/100 success
      let us = createTaggedFraction();
      for (let i = 0; i < 100; i++)
        us = taggedFractionRecord(us, "us", i < 95 ? 1 : 0, 1);

      // eu: 40/50 success
      let eu = createTaggedFraction();
      for (let i = 0; i < 50; i++)
        eu = taggedFractionRecord(eu, "eu", i < 40 ? 1 : 0, 1);

      // ap: 24/25 success
      let ap = createTaggedFraction();
      for (let i = 0; i < 25; i++)
        ap = taggedFractionRecord(ap, "ap", i < 24 ? 1 : 0, 1);

      const merged = taggedFractionMergeAll([us, eu, ap]);
      const v = taggedFractionValue(merged);
      expect(v.numerator).toBe(95 + 40 + 24); // 159
      expect(v.denominator).toBe(100 + 50 + 25); // 175
      expect(v.ratio).toBeCloseTo(159 / 175, 9);
    });
  });

  describe("meanLatency scenario", () => {
    it("weighted average preserves call-count weighting across regions", () => {
      // us: 100 calls × 50ms avg
      let us = createTaggedFraction();
      for (let i = 0; i < 100; i++)
        us = taggedFractionRecord(us, "us", 50, 1);

      // eu: 10 calls × 500ms avg (high-latency outlier region)
      let eu = createTaggedFraction();
      for (let i = 0; i < 10; i++)
        eu = taggedFractionRecord(eu, "eu", 500, 1);

      const merged = taggedFractionMerge(us, eu);
      const v = taggedFractionValue(merged);
      // Weighted: (100*50 + 10*500) / (100+10) = (5000 + 5000) / 110 = 90.9
      expect(v.ratio).toBeCloseTo(10000 / 110, 6);
    });
  });
});
