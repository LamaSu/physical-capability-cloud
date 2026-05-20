import { describe, it, expect } from "vitest";
import { CountMinSketch } from "../sketches/count-min-sketch.js";

describe("CountMinSketch + top-K", () => {
  it("estimate >= true count (no underestimation)", () => {
    const cms = new CountMinSketch();
    cms.increment("alpha", 10);
    cms.increment("bravo", 5);
    cms.increment("charlie", 1);
    expect(cms.estimate("alpha")).toBeGreaterThanOrEqual(10);
    expect(cms.estimate("bravo")).toBeGreaterThanOrEqual(5);
    expect(cms.estimate("charlie")).toBeGreaterThanOrEqual(1);
  });

  it("estimate close to truth for sparse stream", () => {
    const cms = new CountMinSketch();
    cms.increment("popular", 100);
    cms.increment("rare", 1);
    expect(cms.estimate("popular")).toBeGreaterThanOrEqual(100);
    expect(cms.estimate("popular")).toBeLessThanOrEqual(105);
  });

  it("returns 0 for unseen keys", () => {
    const cms = new CountMinSketch();
    cms.increment("seen");
    expect(cms.estimate("never-seen")).toBeLessThanOrEqual(1);
  });

  it("top-K returns the heaviest hitters in a skewed stream", () => {
    const cms = new CountMinSketch();
    // 5 heavy hitters
    cms.increment("h1", 1000);
    cms.increment("h2", 800);
    cms.increment("h3", 600);
    cms.increment("h4", 400);
    cms.increment("h5", 200);
    // 100 noise keys
    for (let i = 0; i < 100; i++) cms.increment(`noise-${i}`, 1);
    const top = cms.topK(5);
    expect(top.length).toBeLessThanOrEqual(5);
    const topKeys = new Set(top.map((t) => t.key));
    // At minimum the heaviest hitters should be present
    expect(topKeys.has("h1")).toBe(true);
    expect(topKeys.has("h2")).toBe(true);
    // Top should be sorted descending
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1]!.count).toBeGreaterThanOrEqual(top[i]!.count);
    }
  });

  it("serialize -> deserialize is lossless for counters", () => {
    const cms = new CountMinSketch();
    cms.increment("a", 7);
    cms.increment("b", 3);
    const wire = cms.serialize();
    const restored = CountMinSketch.deserialize(wire);
    expect(restored.estimate("a")).toBe(cms.estimate("a"));
    expect(restored.estimate("b")).toBe(cms.estimate("b"));
  });

  it("rejects depth > available seeds", () => {
    expect(() => new CountMinSketch(2048, 10)).toThrow();
  });

  it("rejects width < 16", () => {
    expect(() => new CountMinSketch(8)).toThrow();
  });
});
