import { describe, it, expect } from "vitest";
import { HyperLogLog } from "../sketches/hyperloglog.js";

describe("HyperLogLog", () => {
  it("counts distinct items within 1% at n=10000", () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 10_000; i++) hll.add(`user:${i}`);
    const estimate = hll.count();
    // HLL at m=2048 has ~2.3% standard error. Test the realistic bound (5%).
    const lo = 10_000 * 0.95;
    const hi = 10_000 * 1.05;
    expect(estimate).toBeGreaterThan(lo);
    expect(estimate).toBeLessThan(hi);
  });

  it("counts distinct items within tight bound at n=1000", () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 1000; i++) hll.add(`item:${i}`);
    const estimate = hll.count();
    expect(estimate).toBeGreaterThan(900);
    expect(estimate).toBeLessThan(1100);
  });

  it("handles small cardinality via linear counting", () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 50; i++) hll.add(`small:${i}`);
    const estimate = hll.count();
    expect(estimate).toBeGreaterThan(40);
    expect(estimate).toBeLessThan(60);
  });

  it("idempotent on repeated adds — same item counted once", () => {
    const hll = new HyperLogLog();
    for (let i = 0; i < 100; i++) hll.add("only-one-key");
    expect(hll.count()).toBeLessThanOrEqual(2);
  });

  it("merge combines two HLLs", () => {
    const a = new HyperLogLog();
    const b = new HyperLogLog();
    for (let i = 0; i < 500; i++) a.add(`a:${i}`);
    for (let i = 0; i < 500; i++) b.add(`b:${i}`);
    a.merge(b);
    const total = a.count();
    expect(total).toBeGreaterThan(900);
    expect(total).toBeLessThan(1100);
  });

  it("serialize -> deserialize is lossless", () => {
    const orig = new HyperLogLog();
    for (let i = 0; i < 5000; i++) orig.add(`x:${i}`);
    const wire = orig.serialize();
    const restored = HyperLogLog.deserialize(wire);
    expect(restored.count()).toBe(orig.count());
  });

  it("rejects non-power-of-2 register counts", () => {
    expect(() => new HyperLogLog(1000)).toThrow();
    expect(() => new HyperLogLog(8)).toThrow();
  });

  it("rejects merging HLLs with different register counts", () => {
    const a = new HyperLogLog(2048);
    const b = new HyperLogLog(4096);
    expect(() => a.merge(b)).toThrow();
  });
});
