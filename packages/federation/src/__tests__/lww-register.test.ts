import { describe, expect, it } from "vitest";
import {
  compareTimestamps,
  createLWWRegister,
  isKillStamped,
  lwwRegisterKillWrite,
  lwwRegisterMerge,
  lwwRegisterMergeAll,
  lwwRegisterWrite,
} from "../crdts/lww-register.js";

describe("LWW-Register CRDT", () => {
  describe("compareTimestamps", () => {
    it("tick takes precedence", () => {
      const lo = { tick: 5, replica: "z" };
      const hi = { tick: 6, replica: "a" };
      expect(compareTimestamps(lo, hi)).toBeLessThan(0);
      expect(compareTimestamps(hi, lo)).toBeGreaterThan(0);
    });

    it("replica id is the tiebreaker", () => {
      const a = { tick: 5, replica: "alpha" };
      const b = { tick: 5, replica: "bravo" };
      expect(compareTimestamps(a, b)).toBeLessThan(0);
      expect(compareTimestamps(b, a)).toBeGreaterThan(0);
    });

    it("returns 0 on identical timestamps", () => {
      const t = { tick: 5, replica: "r" };
      expect(compareTimestamps(t, t)).toBe(0);
    });
  });

  describe("write semantics", () => {
    it("first write seeds the register at tick 1", () => {
      const w = lwwRegisterWrite(
        createLWWRegister<string>(),
        "r1",
        "hello",
      );
      expect(w.value).toBe("hello");
      expect(w.ts).toEqual({ tick: 1, replica: "r1" });
    });

    it("subsequent writes monotonically advance the tick", () => {
      let r = createLWWRegister<string>();
      r = lwwRegisterWrite(r, "r1", "a");
      r = lwwRegisterWrite(r, "r1", "b");
      r = lwwRegisterWrite(r, "r1", "c");
      expect(r.value).toBe("c");
      expect(r.ts?.tick).toBe(3);
    });

    it("observed-tick floor dominates the local tick", () => {
      const r = lwwRegisterWrite(
        createLWWRegister<string>(),
        "r1",
        "a",
        99, // we've seen tick 99 from elsewhere
      );
      expect(r.ts?.tick).toBe(100);
    });
  });

  describe("merge", () => {
    it("higher tick wins", () => {
      const a = lwwRegisterWrite(createLWWRegister<string>(), "r1", "old");
      const b = lwwRegisterWrite(
        createLWWRegister<string>(),
        "r2",
        "new",
        a.ts?.tick,
      );
      const m = lwwRegisterMerge(a, b);
      expect(m.value).toBe("new");
    });

    it("equal tick: tiebreaker on replica id (lex order)", () => {
      const a = {
        value: "value-from-alpha",
        ts: { tick: 5, replica: "alpha" },
      };
      const b = {
        value: "value-from-bravo",
        ts: { tick: 5, replica: "bravo" },
      };
      const m1 = lwwRegisterMerge(a, b);
      const m2 = lwwRegisterMerge(b, a);
      expect(m1.value).toBe("value-from-bravo"); // bravo > alpha
      expect(m2.value).toBe("value-from-bravo"); // same answer regardless of order
    });

    it("undefined register loses to any defined one", () => {
      const empty = createLWWRegister<string>();
      const defined = lwwRegisterWrite(empty, "r", "x");
      expect(lwwRegisterMerge(empty, defined).value).toBe("x");
      expect(lwwRegisterMerge(defined, empty).value).toBe("x");
    });

    it("two empties merge to empty", () => {
      const merged = lwwRegisterMerge(
        createLWWRegister<string>(),
        createLWWRegister<string>(),
      );
      expect(merged.value).toBeUndefined();
    });

    it("is commutative", () => {
      const a = lwwRegisterWrite(createLWWRegister<string>(), "r1", "a");
      const b = lwwRegisterWrite(
        createLWWRegister<string>(),
        "r2",
        "b",
        a.ts?.tick,
      );
      expect(lwwRegisterMerge(a, b).value).toBe(
        lwwRegisterMerge(b, a).value,
      );
    });

    it("is associative", () => {
      let a = lwwRegisterWrite(createLWWRegister<string>(), "r1", "a");
      let b = lwwRegisterWrite(
        createLWWRegister<string>(),
        "r2",
        "b",
        a.ts?.tick,
      );
      let c = lwwRegisterWrite(
        createLWWRegister<string>(),
        "r3",
        "c",
        b.ts?.tick,
      );
      const left = lwwRegisterMerge(lwwRegisterMerge(a, b), c);
      const right = lwwRegisterMerge(a, lwwRegisterMerge(b, c));
      expect(left.value).toBe(right.value);
    });

    it("is idempotent", () => {
      const a = lwwRegisterWrite(createLWWRegister<string>(), "r1", "a");
      expect(lwwRegisterMerge(a, a)).toEqual(a);
    });
  });

  describe("mergeAll", () => {
    it("picks the latest among N", () => {
      const states = [];
      let floor = 0;
      for (let i = 0; i < 10; i++) {
        const r = lwwRegisterWrite(
          createLWWRegister<number>(),
          `r${i}`,
          i,
          floor,
        );
        states.push(r);
        floor = r.ts!.tick;
      }
      const m = lwwRegisterMergeAll(states);
      expect(m.value).toBe(9); // last write
    });
  });

  describe("kill ops", () => {
    it("kill-stamped writes have a tick + sentinel replica", () => {
      const k = lwwRegisterKillWrite(
        createLWWRegister<string>(),
        "QUARANTINED",
      );
      expect(k.value).toBe("QUARANTINED");
      expect(isKillStamped(k)).toBe(true);
    });

    it("kill at tick N+1 wins against any later normal write at lower tick", () => {
      // normal write at tick 1
      const normal = lwwRegisterWrite(
        createLWWRegister<string>(),
        "operator",
        "VERIFIED_PARTNER",
      );
      // kill at higher tick
      const kill = lwwRegisterKillWrite(
        normal,
        "QUARANTINED",
      );
      expect(lwwRegisterMerge(normal, kill).value).toBe("QUARANTINED");
      expect(lwwRegisterMerge(kill, normal).value).toBe("QUARANTINED");
      expect(isKillStamped(lwwRegisterMerge(normal, kill))).toBe(true);
    });

    it("kill at equal tick wins on replica-id tiebreak (sentinel sorts last)", () => {
      // normal write writer "zzz" at tick 5
      const normalState = {
        value: "VERIFIED",
        ts: { tick: 5, replica: "zzz" },
      };
      // craft a kill at the same tick — sentinel "￿kill" is > any printable ascii
      const killState = lwwRegisterKillWrite(
        { value: undefined, ts: { tick: 4, replica: "" } },
        "QUARANTINED",
      );
      // tick = 5 for the kill
      expect(killState.ts?.tick).toBe(5);
      const merged = lwwRegisterMerge(normalState, killState);
      expect(merged.value).toBe("QUARANTINED");
    });
  });

  describe("realistic trust-tier scenario", () => {
    it("us-east promotes, eu-west's later kill wins, demotion is monotonic", () => {
      // us-east promotes to PARTNER at tick 5
      const usPromote = lwwRegisterWrite(
        createLWWRegister<string>(),
        "us-east-1",
        "VERIFIED_PARTNER",
        4,
      );
      expect(usPromote.value).toBe("VERIFIED_PARTNER");

      // eu-west sees a security issue, quarantines at tick 7
      const euKill = lwwRegisterKillWrite(usPromote, "QUARANTINED");
      expect(euKill.value).toBe("QUARANTINED");

      // us-east tries to re-promote at tick 8 (normal write)
      const usRepromote = lwwRegisterWrite(
        euKill,
        "us-east-1",
        "VERIFIED_PARTNER",
        euKill.ts?.tick,
      );
      // normal-write at floor=euKill.tick dominates kill by raw tick
      // (operator override is allowed per §7.2 "without operator override")
      expect(usRepromote.value).toBe("VERIFIED_PARTNER");
      // usPromote ticked 5 (floor 4 → 5); euKill ticked 6 (floor 5 → 6);
      // usRepromote ticked 7 (floor 6 → 7).
      expect(usRepromote.ts?.tick).toBe(7);
    });
  });
});
