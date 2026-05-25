import { describe, it, expect } from "vitest";
import {
  computeCompositionSignature,
  budgetToBand,
  DemandEnvelopeSchema,
  DemandSnapshotSchema,
  CompositionSignatureSchema,
  type DemandEnvelope,
  type DemandSnapshot,
} from "../types/demand.js";

describe("computeCompositionSignature", () => {
  it("returns a 0x-prefixed 64-hex string", () => {
    const sig = computeCompositionSignature(["3d-printing"], []);
    expect(sig).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("is deterministic regardless of capability-type input order", () => {
    const a = computeCompositionSignature(["cnc", "3d-printing", "inspection"], []);
    const b = computeCompositionSignature(["inspection", "cnc", "3d-printing"], []);
    expect(a).toBe(b);
  });

  it("is deterministic regardless of dependency-edge input order", () => {
    const a = computeCompositionSignature(
      ["a", "b", "c"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    );
    const b = computeCompositionSignature(
      ["a", "b", "c"],
      [
        { from: "b", to: "c" },
        { from: "a", to: "b" },
      ],
    );
    expect(a).toBe(b);
  });

  it("changes when capability set differs", () => {
    const a = computeCompositionSignature(["x"], []);
    const b = computeCompositionSignature(["y"], []);
    expect(a).not.toBe(b);
  });

  it("changes when edges differ for the same node set", () => {
    const a = computeCompositionSignature(
      ["a", "b"],
      [{ from: "a", to: "b" }],
    );
    const b = computeCompositionSignature(["a", "b"], []);
    expect(a).not.toBe(b);
  });

  it("passes the CompositionSignatureSchema regex", () => {
    const sig = computeCompositionSignature(["any"], []);
    expect(() => CompositionSignatureSchema.parse(sig)).not.toThrow();
  });
});

describe("budgetToBand", () => {
  it.each([
    [50, "under_100"],
    [500, "100_1k"],
    [5_000, "1k_10k"],
    [50_000, "10k_100k"],
    [500_000, "100k_plus"],
    [99, "under_100"],
    [100, "100_1k"],
    [999, "100_1k"],
    [1_000, "1k_10k"],
  ] as const)("maps %d -> %s", (amount, expected) => {
    expect(budgetToBand(amount)).toBe(expected);
  });
});

describe("DemandEnvelopeSchema", () => {
  it("accepts a minimal valid envelope", () => {
    const env: DemandEnvelope = {
      id: "den-1",
      source: "requests_api",
      compositionSignature: computeCompositionSignature(["3d-printing"], []),
      capabilityTypes: ["3d-printing"],
      summary: "build me a desk robot",
      budgetBand: "1k_10k",
      urgencyBand: "rush",
      createdAt: new Date().toISOString(),
    };
    expect(() => DemandEnvelopeSchema.parse(env)).not.toThrow();
  });

  it("rejects summary longer than 200 chars", () => {
    const env = {
      id: "den-2",
      source: "requests_api",
      compositionSignature: computeCompositionSignature(["a"], []),
      capabilityTypes: ["a"],
      summary: "x".repeat(201),
      budgetBand: "1k_10k",
      urgencyBand: "standard",
      createdAt: new Date().toISOString(),
    };
    expect(() => DemandEnvelopeSchema.parse(env)).toThrow();
  });

  it("rejects malformed composition signature", () => {
    const env = {
      id: "den-3",
      source: "requests_api",
      compositionSignature: "not-a-sig",
      capabilityTypes: ["a"],
      summary: "ok",
      budgetBand: "1k_10k",
      urgencyBand: "standard",
      createdAt: new Date().toISOString(),
    };
    expect(() => DemandEnvelopeSchema.parse(env)).toThrow();
  });
});

describe("DemandSnapshotSchema", () => {
  it("accepts a minimal snapshot", () => {
    const snap: DemandSnapshot = {
      id: "snap-1",
      window: "hour",
      windowStart: new Date(Date.now() - 3600_000).toISOString(),
      windowEnd: new Date().toISOString(),
      topCompositions: [],
      uniqueRequestersApprox: 0,
      budgetPercentiles: { p25: 0, p50: 0, p75: 0, p90: 0, p99: 0 },
      totalIntents: 0,
      computedAt: new Date().toISOString(),
    };
    expect(() => DemandSnapshotSchema.parse(snap)).not.toThrow();
  });

  it("rejects more than 50 topCompositions", () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => ({
      signature: `sig-${i}`,
      count: 1,
      geoTopN: [],
      budgetBandTopN: [],
    }));
    const snap = {
      id: "snap-2",
      window: "hour",
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      topCompositions: tooMany,
      uniqueRequestersApprox: 0,
      budgetPercentiles: { p25: 0, p50: 0, p75: 0, p90: 0, p99: 0 },
      totalIntents: 0,
      computedAt: new Date().toISOString(),
    };
    expect(() => DemandSnapshotSchema.parse(snap)).toThrow();
  });
});
