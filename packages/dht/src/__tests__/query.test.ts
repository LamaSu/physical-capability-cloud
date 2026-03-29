import { describe, it, expect } from "vitest";
import { matchesQuery, rankResults, haversineKm } from "../query.js";
import type { CapabilityAnnouncement } from "@pcc/spec";

// ── Helpers ──────────────────────────────────────────────────────

function makeAnnouncement(
  overrides: Partial<CapabilityAnnouncement> = {},
): CapabilityAnnouncement {
  return {
    kernelDid: `did:pcc:kernel-${Math.random().toString(36).slice(2, 8)}`,
    kernelId: "kernel-001",
    capabilities: [{ type: "fdm_print", materials: ["PLA", "PETG"] }],
    endpoints: [],
    ttlSeconds: 300,
    timestamp: new Date().toISOString(),
    signature: "mock-sig",
    ...overrides,
  };
}

// ── matchesQuery ─────────────────────────────────────────────────

describe("matchesQuery", () => {
  it("matches when no filters are specified (empty query)", () => {
    const a = makeAnnouncement();
    expect(matchesQuery(a, {})).toBe(true);
  });

  it("matches by capability type (case insensitive)", () => {
    const a = makeAnnouncement({
      capabilities: [{ type: "fdm_print" }],
    });
    expect(matchesQuery(a, { type: "fdm_print" })).toBe(true);
    expect(matchesQuery(a, { type: "FDM_PRINT" })).toBe(true);
    expect(matchesQuery(a, { type: "laser_cut" })).toBe(false);
  });

  it("matches when any capability has the requested type", () => {
    const a = makeAnnouncement({
      capabilities: [
        { type: "fdm_print" },
        { type: "laser_cut" },
      ],
    });
    expect(matchesQuery(a, { type: "laser_cut" })).toBe(true);
  });

  it("matches by materials (any match)", () => {
    const a = makeAnnouncement({
      capabilities: [{ type: "fdm_print", materials: ["PLA", "PETG", "ABS"] }],
    });
    expect(matchesQuery(a, { materials: ["PETG"] })).toBe(true);
    expect(matchesQuery(a, { materials: ["Nylon"] })).toBe(false);
    expect(matchesQuery(a, { materials: ["Nylon", "ABS"] })).toBe(true); // ABS matches
  });

  it("material matching is case insensitive", () => {
    const a = makeAnnouncement({
      capabilities: [{ type: "fdm_print", materials: ["PLA"] }],
    });
    expect(matchesQuery(a, { materials: ["pla"] })).toBe(true);
  });

  it("matches by maxPrice (min <= maxPrice)", () => {
    const a = makeAnnouncement({
      capabilities: [
        { type: "fdm_print", priceRange: { min: 10, max: 50, currency: "USDC" } },
      ],
    });
    expect(matchesQuery(a, { maxPrice: 15 })).toBe(true);
    expect(matchesQuery(a, { maxPrice: 10 })).toBe(true);
    expect(matchesQuery(a, { maxPrice: 5 })).toBe(false);
  });

  it("rejects when no capability has a priceRange and maxPrice is set", () => {
    const a = makeAnnouncement({
      capabilities: [{ type: "fdm_print" }], // no priceRange
    });
    expect(matchesQuery(a, { maxPrice: 100 })).toBe(false);
  });

  it("combines type + materials (AND logic at announcement level)", () => {
    const a = makeAnnouncement({
      capabilities: [
        { type: "fdm_print", materials: ["PLA"] },
        { type: "laser_cut", materials: ["Acrylic"] },
      ],
    });
    // Both filters match independently across all capabilities
    expect(matchesQuery(a, { type: "fdm_print", materials: ["PLA"] })).toBe(true);
    // Acrylic exists on laser_cut, fdm_print also exists — both filters pass
    // at the announcement level (not per-capability intersection)
    expect(matchesQuery(a, { type: "fdm_print", materials: ["Acrylic"] })).toBe(true);
    // No type matches, so this fails
    expect(matchesQuery(a, { type: "bioprinter", materials: ["PLA"] })).toBe(false);
    // No material matches
    expect(matchesQuery(a, { type: "fdm_print", materials: ["Nylon"] })).toBe(false);
  });

  it("location filter does not reject (placeholder implementation)", () => {
    const a = makeAnnouncement();
    expect(
      matchesQuery(a, { location: { lat: 40.7, lng: -74.0, radiusKm: 50 } }),
    ).toBe(true);
  });
});

// ── rankResults ──────────────────────────────────────────────────

describe("rankResults", () => {
  it("ranks by queue depth (lower is better)", () => {
    const a1 = makeAnnouncement({
      kernelDid: "did:pcc:busy",
      capabilities: [{ type: "fdm_print", queueDepth: 10 }],
    });
    const a2 = makeAnnouncement({
      kernelDid: "did:pcc:idle",
      capabilities: [{ type: "fdm_print", queueDepth: 0 }],
    });

    const ranked = rankResults([a1, a2], {});
    expect(ranked[0].kernelDid).toBe("did:pcc:idle");
  });

  it("ranks by price (lower min is better)", () => {
    const a1 = makeAnnouncement({
      kernelDid: "did:pcc:expensive",
      capabilities: [
        { type: "fdm_print", priceRange: { min: 50, max: 100, currency: "USDC" } },
      ],
    });
    const a2 = makeAnnouncement({
      kernelDid: "did:pcc:cheap",
      capabilities: [
        { type: "fdm_print", priceRange: { min: 5, max: 20, currency: "USDC" } },
      ],
    });

    const ranked = rankResults([a1, a2], {});
    expect(ranked[0].kernelDid).toBe("did:pcc:cheap");
  });

  it("rewards material match breadth", () => {
    const a1 = makeAnnouncement({
      kernelDid: "did:pcc:narrow",
      capabilities: [{ type: "fdm_print", materials: ["PLA"] }],
    });
    const a2 = makeAnnouncement({
      kernelDid: "did:pcc:broad",
      capabilities: [{ type: "fdm_print", materials: ["PLA", "PETG", "ABS"] }],
    });

    const ranked = rankResults([a1, a2], { materials: ["PLA", "PETG"] });
    expect(ranked[0].kernelDid).toBe("did:pcc:broad");
  });

  it("limits results to query.limit", () => {
    const announcements = Array.from({ length: 20 }, (_, i) =>
      makeAnnouncement({ kernelDid: `did:pcc:k${i}` }),
    );

    const ranked = rankResults(announcements, { limit: 5 });
    expect(ranked).toHaveLength(5);
  });

  it("default limit is 10", () => {
    const announcements = Array.from({ length: 20 }, (_, i) =>
      makeAnnouncement({ kernelDid: `did:pcc:k${i}` }),
    );

    const ranked = rankResults(announcements, {});
    expect(ranked).toHaveLength(10);
  });
});

// ── haversineKm ──────────────────────────────────────────────────

describe("haversineKm", () => {
  it("returns 0 for the same point", () => {
    expect(haversineKm(40.7128, -74.006, 40.7128, -74.006)).toBeCloseTo(0, 2);
  });

  it("computes distance between NYC and LA (~3944 km)", () => {
    const dist = haversineKm(40.7128, -74.006, 34.0522, -118.2437);
    expect(dist).toBeGreaterThan(3900);
    expect(dist).toBeLessThan(4000);
  });

  it("computes distance between London and Paris (~344 km)", () => {
    const dist = haversineKm(51.5074, -0.1278, 48.8566, 2.3522);
    expect(dist).toBeGreaterThan(330);
    expect(dist).toBeLessThan(360);
  });
});
