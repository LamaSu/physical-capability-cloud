import { describe, expect, it } from "vitest";
import {
  compareVectorClocks,
  createVectorClock,
  vectorClockHappensBeforeOrEquals,
  vectorClockMerge,
  vectorClockTick,
} from "../vector-clock.js";

describe("VectorClock", () => {
  describe("vectorClockTick", () => {
    it("starts at tick 1 for a new slot", () => {
      const v = vectorClockTick(createVectorClock(), "us-east-1");
      expect(v.ticks["us-east-1"]).toBe(1);
    });

    it("increments existing slot", () => {
      let v = vectorClockTick(createVectorClock(), "us-east-1");
      v = vectorClockTick(v, "us-east-1");
      v = vectorClockTick(v, "us-east-1");
      expect(v.ticks["us-east-1"]).toBe(3);
    });

    it("respects observedFloor", () => {
      const v = vectorClockTick(createVectorClock(), "us-east-1", 50);
      expect(v.ticks["us-east-1"]).toBe(51);
    });

    it("isolates per-region slots", () => {
      let v = vectorClockTick(createVectorClock(), "us-east-1");
      v = vectorClockTick(v, "eu-west-1");
      expect(v.ticks["us-east-1"]).toBe(1);
      expect(v.ticks["eu-west-1"]).toBe(1);
    });
  });

  describe("vectorClockMerge", () => {
    it("takes per-region MAX", () => {
      const a = { ticks: { r1: 3, r2: 7 } };
      const b = { ticks: { r1: 5, r3: 2 } };
      const m = vectorClockMerge(a, b);
      expect(m.ticks).toEqual({ r1: 5, r2: 7, r3: 2 });
    });

    it("is commutative", () => {
      const a = { ticks: { r1: 3, r2: 7 } };
      const b = { ticks: { r1: 5, r3: 2 } };
      expect(vectorClockMerge(a, b).ticks).toEqual(vectorClockMerge(b, a).ticks);
    });

    it("is idempotent", () => {
      const a = { ticks: { r1: 3, r2: 7 } };
      expect(vectorClockMerge(a, a).ticks).toEqual(a.ticks);
    });
  });

  describe("compareVectorClocks", () => {
    it("equal when identical", () => {
      expect(
        compareVectorClocks({ ticks: { r1: 1 } }, { ticks: { r1: 1 } }),
      ).toBe("equal");
    });

    it("before when a < b in every slot", () => {
      expect(
        compareVectorClocks({ ticks: { r1: 1 } }, { ticks: { r1: 2 } }),
      ).toBe("before");
    });

    it("after when a > b in every slot", () => {
      expect(
        compareVectorClocks({ ticks: { r1: 5 } }, { ticks: { r1: 2 } }),
      ).toBe("after");
    });

    it("concurrent when neither dominates", () => {
      expect(
        compareVectorClocks(
          { ticks: { r1: 5, r2: 1 } },
          { ticks: { r1: 2, r2: 7 } },
        ),
      ).toBe("concurrent");
    });

    it("treats missing slots as 0", () => {
      expect(
        compareVectorClocks({ ticks: { r1: 1 } }, { ticks: { r2: 1 } }),
      ).toBe("concurrent");
    });
  });

  describe("vectorClockHappensBeforeOrEquals", () => {
    it("true for before", () => {
      expect(
        vectorClockHappensBeforeOrEquals(
          { ticks: { r1: 1 } },
          { ticks: { r1: 5 } },
        ),
      ).toBe(true);
    });

    it("true for equal", () => {
      expect(
        vectorClockHappensBeforeOrEquals(
          { ticks: { r1: 5 } },
          { ticks: { r1: 5 } },
        ),
      ).toBe(true);
    });

    it("false for after", () => {
      expect(
        vectorClockHappensBeforeOrEquals(
          { ticks: { r1: 5 } },
          { ticks: { r1: 1 } },
        ),
      ).toBe(false);
    });

    it("false for concurrent", () => {
      expect(
        vectorClockHappensBeforeOrEquals(
          { ticks: { r1: 5, r2: 1 } },
          { ticks: { r1: 2, r2: 7 } },
        ),
      ).toBe(false);
    });
  });
});
