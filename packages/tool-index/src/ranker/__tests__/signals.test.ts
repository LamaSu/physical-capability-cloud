import { describe, it, expect } from "vitest";
import {
  freshnessSignal,
  geoSignal,
  haversineKm,
  priceSignal,
  provenanceSignal,
  reputationSignal,
  TIER_VALUE,
  trustSignal,
} from "../signals.js";
import { TrustTier, DigitalCaptureClass } from "@pcc/spec";
import { makeTool } from "./fixtures.js";

describe("trustSignal", () => {
  it("returns TIER_VALUE per tier", () => {
    expect(trustSignal(makeTool({ trustTier: TrustTier.PCC_NATIVE }))).toBe(1.0);
    expect(trustSignal(makeTool({ trustTier: TrustTier.VERIFIED_PARTNER }))).toBe(0.95);
    expect(trustSignal(makeTool({ trustTier: TrustTier.AUTO_INDEXED }))).toBe(0.55);
    expect(trustSignal(makeTool({ trustTier: TrustTier.QUARANTINED }))).toBe(0);
  });
  it("table covers every tier", () => {
    for (const t of Object.values(TrustTier)) {
      expect(typeof TIER_VALUE[t]).toBe("number");
    }
  });
});

describe("provenanceSignal", () => {
  it("returns 0 for never-invoked tool", () => {
    expect(provenanceSignal(makeTool())).toBe(0);
  });
  it("rises with invocationCount × successRate × dcc-class", () => {
    const t1 = makeTool({
      invocationCount: 100,
      successRate: 0.9,
      assuranceCeiling: DigitalCaptureClass.DCC5,
    });
    const t2 = makeTool({
      invocationCount: 10,
      successRate: 0.9,
      assuranceCeiling: DigitalCaptureClass.DCC5,
    });
    expect(provenanceSignal(t1)).toBeGreaterThan(provenanceSignal(t2));
  });
  it("zero successRate zeros the signal", () => {
    const t = makeTool({
      invocationCount: 1000,
      successRate: 0,
      assuranceCeiling: DigitalCaptureClass.DCC5,
    });
    expect(provenanceSignal(t)).toBe(0);
  });
  it("saturates at high invocation counts (doesn't dominate)", () => {
    const t1 = makeTool({
      invocationCount: 10_000,
      successRate: 1,
      assuranceCeiling: DigitalCaptureClass.DCC5,
    });
    const t2 = makeTool({
      invocationCount: 100_000,
      successRate: 1,
      assuranceCeiling: DigitalCaptureClass.DCC5,
    });
    // Both should be close to 1.0; difference is small.
    expect(provenanceSignal(t1)).toBeGreaterThan(0.95);
    expect(provenanceSignal(t2)).toBeGreaterThan(0.99);
    expect(provenanceSignal(t2) - provenanceSignal(t1)).toBeLessThan(0.05);
  });
});

describe("reputationSignal", () => {
  it("pcc-native returns 1.0", () => {
    expect(reputationSignal(makeTool({ source: { ...makeTool().source, type: "pcc-native" } }))).toBe(1.0);
  });
  it("glama with overall score returns clamped value", () => {
    const t = makeTool({
      source: {
        type: "glama",
        url: "https://glama.ai/x",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        scoreSnapshot: { overall: 0.7 },
      },
    });
    expect(reputationSignal(t)).toBe(0.7);
  });
  it("smithery uses useCount sigmoid", () => {
    const tLow = makeTool({
      source: {
        type: "smithery",
        url: "https://smithery.ai/x",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        scoreSnapshot: { useCount: 100 },
      },
    });
    const tHigh = makeTool({
      source: {
        type: "smithery",
        url: "https://smithery.ai/x",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        scoreSnapshot: { useCount: 50_000 },
      },
    });
    expect(reputationSignal(tHigh)).toBeGreaterThan(reputationSignal(tLow));
  });
  it("unknown source returns neutral 0.5", () => {
    const t = makeTool({
      source: {
        type: "user-submission",
        url: "https://x.com",
        fetchedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(reputationSignal(t)).toBe(0.5);
  });
});

describe("freshnessSignal", () => {
  const NOW = Date.parse("2026-06-01T00:00:00.000Z");
  it("score is ~1.0 when just-fetched", () => {
    const t = makeTool({ lastFetchedAt: new Date(NOW).toISOString() });
    expect(freshnessSignal(t, NOW)).toBeCloseTo(1, 5);
  });
  it("decays exponentially with age", () => {
    const dayMs = 86_400_000;
    const t1 = makeTool({ lastFetchedAt: new Date(NOW - 7 * dayMs).toISOString() });
    const t2 = makeTool({ lastFetchedAt: new Date(NOW - 30 * dayMs).toISOString() });
    expect(freshnessSignal(t1, NOW)).toBeGreaterThan(freshnessSignal(t2, NOW));
  });
  it("critical drift halves the score", () => {
    const t = makeTool({
      lastFetchedAt: new Date(NOW).toISOString(),
      driftAlerts: [
        {
          type: "schema_changed",
          severity: "critical",
          detectedAt: new Date(NOW).toISOString(),
          message: "schema flipped",
        },
      ],
    });
    expect(freshnessSignal(t, NOW)).toBeLessThanOrEqual(0.5);
  });
});

describe("priceSignal", () => {
  it("returns 0.5 when either side missing", () => {
    expect(priceSignal(makeTool(), undefined)).toBe(0.5);
    expect(priceSignal(makeTool(), { maxUsd: 1 })).toBe(0.5);
  });
  it("free tool with preferFree scores 1.0", () => {
    const t = makeTool({ pricing: { perCallUsdc: "0" } });
    expect(priceSignal(t, { maxUsd: 1, preferFree: true })).toBe(1.0);
  });
  it("in-budget tool scores high", () => {
    const t = makeTool({ pricing: { perCallUsdc: "0.5" } });
    expect(priceSignal(t, { maxUsd: 1 })).toBeGreaterThanOrEqual(0.7);
  });
  it("over-budget tool scores low", () => {
    const t = makeTool({ pricing: { perCallUsdc: "10" } });
    expect(priceSignal(t, { maxUsd: 1 })).toBeLessThanOrEqual(0.2);
  });
});

describe("haversineKm + geoSignal", () => {
  it("haversine SF→LA is ~559km", () => {
    const sf = { lat: 37.7749, lng: -122.4194 };
    const la = { lat: 34.0522, lng: -118.2437 };
    const km = haversineKm(sf, la);
    expect(km).toBeGreaterThan(540);
    expect(km).toBeLessThan(580);
  });
  it("geoSignal returns 1.0 when no caller location (neutral)", () => {
    expect(geoSignal(makeTool(), undefined)).toBe(1.0);
  });
  it("geoSignal returns 1.0 when tool has no location (digital-only)", () => {
    expect(geoSignal(makeTool(), { lat: 37, lng: -122 })).toBe(1.0);
  });
  it("geoSignal decays with distance for physical tools", () => {
    const tNear = makeTool({
      source: {
        type: "pcc-native",
        url: "https://x.com",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        scoreSnapshot: { lat: 37.78, lng: -122.42 },
      },
    });
    const tFar = makeTool({
      source: {
        type: "pcc-native",
        url: "https://x.com",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        scoreSnapshot: { lat: 40.71, lng: -74.0 }, // NYC
      },
    });
    const caller = { lat: 37.77, lng: -122.42 };
    expect(geoSignal(tNear, caller)).toBeGreaterThan(geoSignal(tFar, caller));
  });
});
