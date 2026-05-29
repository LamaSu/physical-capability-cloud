import { describe, expect, it } from "vitest";
import {
  createGCounter,
  gCounterEquals,
  gCounterIncrement,
  gCounterMerge,
  gCounterMergeAll,
  gCounterValue,
} from "../crdts/g-counter.js";

describe("G-Counter CRDT", () => {
  describe("createGCounter", () => {
    it("creates an empty counter with value 0", () => {
      const c = createGCounter();
      expect(gCounterValue(c)).toBe(0);
      expect(Object.keys(c.slots)).toHaveLength(0);
    });
  });

  describe("gCounterIncrement", () => {
    it("adds to the local replica's slot", () => {
      let c = createGCounter();
      c = gCounterIncrement(c, "us-east-1");
      expect(c.slots["us-east-1"]).toBe(1);
      c = gCounterIncrement(c, "us-east-1", 5);
      expect(c.slots["us-east-1"]).toBe(6);
      expect(gCounterValue(c)).toBe(6);
    });

    it("isolates per-replica slots", () => {
      let c = createGCounter();
      c = gCounterIncrement(c, "us-east-1", 3);
      c = gCounterIncrement(c, "eu-west-1", 7);
      expect(c.slots["us-east-1"]).toBe(3);
      expect(c.slots["eu-west-1"]).toBe(7);
      expect(gCounterValue(c)).toBe(10);
    });

    it("does not mutate input", () => {
      const c = createGCounter();
      const snap = JSON.stringify(c);
      gCounterIncrement(c, "us-east-1", 1);
      expect(JSON.stringify(c)).toBe(snap);
    });

    it("returns identical reference when delta is 0", () => {
      const c = createGCounter();
      expect(gCounterIncrement(c, "x", 0)).toBe(c);
    });

    it("rejects negative deltas", () => {
      const c = createGCounter();
      expect(() => gCounterIncrement(c, "x", -1)).toThrow(/non-negative/);
    });

    it("rejects non-integer deltas", () => {
      const c = createGCounter();
      expect(() => gCounterIncrement(c, "x", 1.5)).toThrow(/non-negative/);
    });
  });

  describe("gCounterMerge", () => {
    it("takes the per-replica MAX", () => {
      const a = gCounterIncrement(
        gCounterIncrement(createGCounter(), "r1", 3),
        "r2",
        7,
      );
      const b = gCounterIncrement(
        gCounterIncrement(createGCounter(), "r1", 5),
        "r3",
        2,
      );
      const m = gCounterMerge(a, b);
      expect(m.slots["r1"]).toBe(5); // max(3, 5)
      expect(m.slots["r2"]).toBe(7); // only in a
      expect(m.slots["r3"]).toBe(2); // only in b
      expect(gCounterValue(m)).toBe(14);
    });

    it("is commutative: merge(a, b) === merge(b, a) by value", () => {
      const a = gCounterIncrement(createGCounter(), "r1", 3);
      const b = gCounterIncrement(createGCounter(), "r1", 5);
      const ab = gCounterMerge(a, b);
      const ba = gCounterMerge(b, a);
      expect(gCounterEquals(ab, ba)).toBe(true);
    });

    it("is associative", () => {
      const a = gCounterIncrement(createGCounter(), "r1", 1);
      const b = gCounterIncrement(createGCounter(), "r2", 2);
      const c = gCounterIncrement(createGCounter(), "r3", 3);
      const left = gCounterMerge(gCounterMerge(a, b), c);
      const right = gCounterMerge(a, gCounterMerge(b, c));
      expect(gCounterEquals(left, right)).toBe(true);
    });

    it("is idempotent", () => {
      const a = gCounterIncrement(
        gCounterIncrement(createGCounter(), "r1", 3),
        "r2",
        5,
      );
      const merged = gCounterMerge(a, a);
      expect(gCounterEquals(merged, a)).toBe(true);
    });

    it("does not mutate inputs", () => {
      const a = gCounterIncrement(createGCounter(), "r1", 3);
      const b = gCounterIncrement(createGCounter(), "r1", 5);
      const aSnap = JSON.stringify(a);
      const bSnap = JSON.stringify(b);
      gCounterMerge(a, b);
      expect(JSON.stringify(a)).toBe(aSnap);
      expect(JSON.stringify(b)).toBe(bSnap);
    });
  });

  describe("gCounterMergeAll", () => {
    it("folds N replicas into one", () => {
      const states = ["a", "b", "c", "d"].map((r, i) =>
        gCounterIncrement(createGCounter(), r, i + 1),
      );
      const merged = gCounterMergeAll(states);
      expect(gCounterValue(merged)).toBe(1 + 2 + 3 + 4);
    });

    it("returns empty counter on empty input", () => {
      const merged = gCounterMergeAll([]);
      expect(gCounterValue(merged)).toBe(0);
    });
  });

  describe("monotonicity", () => {
    it("value() never decreases under any sequence of increments and merges", () => {
      let a = createGCounter();
      let b = createGCounter();
      const history: number[] = [0];
      for (let i = 0; i < 50; i++) {
        a = gCounterIncrement(a, "r1", Math.floor(Math.random() * 3));
        b = gCounterIncrement(b, "r2", Math.floor(Math.random() * 3));
        const m = gCounterMerge(a, b);
        const v = gCounterValue(m);
        for (const prior of history) {
          expect(v).toBeGreaterThanOrEqual(prior);
        }
        history.push(v);
      }
    });
  });

  describe("realistic invocationCount scenario", () => {
    it("3-region invocation tracking sums correctly", () => {
      // Region us-east-1 sees 100 invocations
      let us = createGCounter();
      for (let i = 0; i < 100; i++) us = gCounterIncrement(us, "us-east-1");

      // Region eu-west-1 sees 50 invocations
      let eu = createGCounter();
      for (let i = 0; i < 50; i++) eu = gCounterIncrement(eu, "eu-west-1");

      // Region ap-southeast-1 sees 25 invocations
      let ap = createGCounter();
      for (let i = 0; i < 25; i++)
        ap = gCounterIncrement(ap, "ap-southeast-1");

      // Each region sees the others' tallies via CRDT pull and merges
      const usView = gCounterMergeAll([us, eu, ap]);
      const euView = gCounterMergeAll([eu, us, ap]);
      const apView = gCounterMergeAll([ap, eu, us]);

      expect(gCounterValue(usView)).toBe(175);
      expect(gCounterValue(euView)).toBe(175);
      expect(gCounterValue(apView)).toBe(175);
    });
  });
});
