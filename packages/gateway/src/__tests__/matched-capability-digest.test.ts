/**
 * matchedCapabilityDigest — the binding field composition's compositionRoot
 * commits to (coord #1439/#1456).
 *
 * These tests pin the two properties that make it worth committing to:
 * it MOVES when the deal changes, and it does NOT move on noise.
 */
import { describe, it, expect } from "vitest";
import {
  matchedCapabilityDigest,
  matchedCapabilityDigestPreImage,
  type MatchedCapabilitySnapshot,
} from "../services/matched-capability-digest.js";

const SNAP: MatchedCapabilitySnapshot = {
  capabilityId: "cap-123",
  capabilityType: "wood-fired-pizza",
  kernelId: "kernel-marios",
  price: 12,
  currency: "USDC",
  assuranceTiers: [1, 0, 2],
};

describe("moves when the commitment changes", () => {
  const base = matchedCapabilityDigest(SNAP);
  it("moves on price", () => {
    expect(matchedCapabilityDigest({ ...SNAP, price: 12.01 })).not.toBe(base);
  });
  it("moves on currency", () => {
    expect(matchedCapabilityDigest({ ...SNAP, currency: "USD" })).not.toBe(base);
  });
  it("moves on kernelId — same capability, different performer, different deal", () => {
    expect(matchedCapabilityDigest({ ...SNAP, kernelId: "kernel-other" })).not.toBe(base);
  });
  it("moves on capabilityType", () => {
    expect(matchedCapabilityDigest({ ...SNAP, capabilityType: "fdm" })).not.toBe(base);
  });
  it("moves on assuranceTiers — the evidence obligation", () => {
    expect(matchedCapabilityDigest({ ...SNAP, assuranceTiers: [0, 1] })).not.toBe(base);
  });
});

describe("does NOT move on noise", () => {
  const base = matchedCapabilityDigest(SNAP);
  it("is stable under assuranceTiers ORDER", () => {
    expect(matchedCapabilityDigest({ ...SNAP, assuranceTiers: [2, 1, 0] })).toBe(base);
  });
  it("is stable under float representation of the same money", () => {
    // 12, 12.0 and 12.004 all mean 12.00 to two decimals.
    expect(matchedCapabilityDigest({ ...SNAP, price: 12.0 })).toBe(base);
    expect(matchedCapabilityDigest({ ...SNAP, price: 12.004 })).toBe(base);
  });
  it("ignores fields not in the snapshot type", () => {
    const noisy = { ...SNAP, score: 0.93, name: "Mario's Oven" } as MatchedCapabilitySnapshot;
    expect(matchedCapabilityDigest(noisy)).toBe(base);
  });
});

describe("fails closed", () => {
  it("refuses a non-finite price rather than digesting it", () => {
    expect(() => matchedCapabilityDigest({ ...SNAP, price: NaN })).toThrow(TypeError);
    expect(() => matchedCapabilityDigest({ ...SNAP, price: Infinity })).toThrow(TypeError);
  });
});

describe("framing", () => {
  it("returns 0x-prefixed 32-byte hex", () => {
    expect(matchedCapabilityDigest(SNAP)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("exposes a diffable pre-image with sorted tiers and fixed-precision price", () => {
    const pre = matchedCapabilityDigestPreImage(SNAP);
    expect(pre).toContain('"price":"12.00"');
    expect(pre).toContain('"assuranceTiers":[0,1,2]');
    expect(pre).not.toMatch(/\s/);
  });
});
