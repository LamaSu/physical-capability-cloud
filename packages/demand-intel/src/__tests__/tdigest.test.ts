import { describe, it, expect } from "vitest";
import { TDigest } from "../sketches/tdigest.js";

describe("TDigest", () => {
  it("p50 within 5% of true median for uniform [0, 1000]", () => {
    const td = new TDigest();
    for (let i = 0; i < 10_000; i++) {
      td.add(Math.random() * 1000);
    }
    const median = td.quantile(0.5);
    expect(median).toBeGreaterThan(450);
    expect(median).toBeLessThan(550);
  });

  it("p99 within 10% for uniform [0, 1000]", () => {
    const td = new TDigest();
    for (let i = 0; i < 10_000; i++) {
      td.add(Math.random() * 1000);
    }
    const p99 = td.quantile(0.99);
    expect(p99).toBeGreaterThan(900);
    expect(p99).toBeLessThan(1100);
  });

  it("returns the only value when count=1", () => {
    const td = new TDigest();
    td.add(42);
    expect(td.quantile(0.5)).toBe(42);
    expect(td.quantile(0.99)).toBe(42);
  });

  it("returns NaN for an empty digest", () => {
    const td = new TDigest();
    expect(td.quantile(0.5)).toBeNaN();
  });

  it("merge combines two digests", () => {
    const a = new TDigest();
    const b = new TDigest();
    for (let i = 0; i < 5_000; i++) a.add(Math.random() * 500);
    for (let i = 0; i < 5_000; i++) b.add(500 + Math.random() * 500);
    a.merge(b);
    // Merged distribution is uniform over [0, 1000]; median ~500
    const median = a.quantile(0.5);
    expect(median).toBeGreaterThan(400);
    expect(median).toBeLessThan(600);
  });

  it("serialize -> deserialize preserves quantiles", () => {
    const orig = new TDigest();
    for (let i = 0; i < 5_000; i++) orig.add(Math.random() * 1000);
    const p50 = orig.quantile(0.5);
    const wire = orig.serialize();
    const restored = TDigest.deserialize(wire);
    const p50r = restored.quantile(0.5);
    expect(Math.abs(p50 - p50r)).toBeLessThan(10);
  });

  it("rejects compression < 10", () => {
    expect(() => new TDigest(5)).toThrow();
  });

  it("rejects out-of-range quantile", () => {
    const td = new TDigest();
    td.add(1);
    expect(() => td.quantile(-0.1)).toThrow();
    expect(() => td.quantile(1.1)).toThrow();
  });
});
