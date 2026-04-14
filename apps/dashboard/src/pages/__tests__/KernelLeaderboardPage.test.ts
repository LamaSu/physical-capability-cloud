/**
 * KernelLeaderboardPage unit tests for pure helpers.
 * Covers: rollup construction from capabilities, sort with nulls-last semantics.
 */

import { describe, it, expect } from "vitest";
import {
  buildLeaderboard,
  sortLeaderboard,
} from "../kernel-leaderboard-logic.js";
import type { CapabilityDTO, KernelDTO } from "../../types/dto.js";

function cap(overrides: Partial<CapabilityDTO>): CapabilityDTO {
  return {
    id: overrides.id ?? "cap-1",
    kernelId: overrides.kernelId ?? "kernel-a",
    type: overrides.type ?? "3d-printing",
    name: overrides.name ?? "Cap",
    materials: [],
    assuranceTiers: [0, 1],
    pricing: {},
    location: { lat: 0, lng: 0 },
    queueDepth: overrides.queueDepth ?? 0,
    available: true,
    ...overrides,
  } as CapabilityDTO;
}

function kernel(overrides: Partial<KernelDTO>): KernelDTO {
  return {
    id: overrides.id ?? "kernel-a",
    name: overrides.name ?? "Kernel A",
    operatorAddress: "0x00",
    location: { lat: 0, lng: 0 },
    physicalAddress: "Addr",
    maxAssuranceTier: 2,
    status: overrides.status ?? "online",
    lastHeartbeat: new Date().toISOString(),
    version: "1.0",
    capabilityCount: 0,
    capabilityTypes: [],
    totalJobsCompleted: 0,
    isStale: false,
    ...overrides,
  } as KernelDTO;
}

describe("buildLeaderboard", () => {
  it("averages assuranceScore per kernel", () => {
    const caps = [
      cap({ id: "c1", kernelId: "k1", assuranceScore: 0.8 }),
      cap({ id: "c2", kernelId: "k1", assuranceScore: 0.9 }),
      cap({ id: "c3", kernelId: "k2", assuranceScore: 0.5 }),
    ];
    const kernels = [kernel({ id: "k1" }), kernel({ id: "k2" })];
    const rows = buildLeaderboard(caps, kernels);

    const k1 = rows.find((r) => r.kernelId === "k1")!;
    const k2 = rows.find((r) => r.kernelId === "k2")!;
    expect(k1.avgScore).toBeCloseTo(0.85, 10);
    expect(k2.avgScore).toBeCloseTo(0.5, 10);
  });

  it("returns null avgScore when no capability reports a score", () => {
    const caps = [
      cap({ id: "c1", kernelId: "k1" }),
      cap({ id: "c2", kernelId: "k1" }),
    ];
    const rows = buildLeaderboard(caps, [kernel({ id: "k1" })]);
    expect(rows[0]!.avgScore).toBeNull();
    expect(rows[0]!.scoredCount).toBe(0);
    expect(rows[0]!.capabilityCount).toBe(2);
  });

  it("mixes scored and unscored capabilities correctly", () => {
    const caps = [
      cap({ id: "c1", kernelId: "k1", assuranceScore: 0.9 }),
      cap({ id: "c2", kernelId: "k1" }), // no score
    ];
    const rows = buildLeaderboard(caps, [kernel({ id: "k1" })]);
    expect(rows[0]!.avgScore).toBeCloseTo(0.9, 10);
    expect(rows[0]!.scoredCount).toBe(1);
    expect(rows[0]!.capabilityCount).toBe(2);
  });

  it("sums queue depth across capabilities", () => {
    const caps = [
      cap({ id: "c1", kernelId: "k1", queueDepth: 3 }),
      cap({ id: "c2", kernelId: "k1", queueDepth: 7 }),
    ];
    const rows = buildLeaderboard(caps, [kernel({ id: "k1" })]);
    expect(rows[0]!.queueDepth).toBe(10);
  });

  it("deduplicates capability types", () => {
    const caps = [
      cap({ id: "c1", kernelId: "k1", type: "cnc" }),
      cap({ id: "c2", kernelId: "k1", type: "cnc" }),
      cap({ id: "c3", kernelId: "k1", type: "3d-printing" }),
    ];
    const rows = buildLeaderboard(caps, [kernel({ id: "k1" })]);
    expect(rows[0]!.types.sort()).toEqual(["3d-printing", "cnc"]);
  });

  it("prefers kernel.reputation over capability.reputation", () => {
    const caps = [
      cap({ id: "c1", kernelId: "k1", reputation: 500 }),
    ];
    const kernels = [kernel({ id: "k1", reputation: 900 })];
    const rows = buildLeaderboard(caps, kernels);
    expect(rows[0]!.reputation).toBe(900);
  });

  it("falls back to capability.reputation when kernel has none", () => {
    const caps = [cap({ id: "c1", kernelId: "k1", reputation: 500 })];
    const kernels = [kernel({ id: "k1" })]; // no reputation
    const rows = buildLeaderboard(caps, kernels);
    expect(rows[0]!.reputation).toBe(500);
  });

  it("uses kernel name when kernel entry exists", () => {
    const caps = [cap({ id: "c1", kernelId: "k1", kernelName: "Old Name" })];
    const kernels = [kernel({ id: "k1", name: "Real Name" })];
    const rows = buildLeaderboard(caps, kernels);
    expect(rows[0]!.kernelName).toBe("Real Name");
  });

  it("falls back to capability.kernelName when no kernel entry", () => {
    const caps = [cap({ id: "c1", kernelId: "k1", kernelName: "Fallback" })];
    const rows = buildLeaderboard(caps, []);
    expect(rows[0]!.kernelName).toBe("Fallback");
  });

  it("returns empty array for empty inputs", () => {
    expect(buildLeaderboard([], [])).toEqual([]);
  });
});

describe("sortLeaderboard", () => {
  function row(score: number | null, name = `k-${Math.random()}`) {
    return {
      kernelId: name,
      kernelName: name,
      kernelStatus: "online" as const,
      avgScore: score,
      scoredCount: score == null ? 0 : 1,
      capabilityCount: 1,
      types: [],
      queueDepth: 0,
    };
  }

  it("sorts descending by score by default", () => {
    const sorted = sortLeaderboard(
      [row(0.5, "a"), row(0.9, "b"), row(0.7, "c")],
      "desc",
    );
    expect(sorted.map((r) => r.avgScore)).toEqual([0.9, 0.7, 0.5]);
  });

  it("sorts ascending when dir='asc'", () => {
    const sorted = sortLeaderboard(
      [row(0.5, "a"), row(0.9, "b"), row(0.7, "c")],
      "asc",
    );
    expect(sorted.map((r) => r.avgScore)).toEqual([0.5, 0.7, 0.9]);
  });

  it("pushes nulls to the bottom in desc order", () => {
    const sorted = sortLeaderboard(
      [row(null, "a"), row(0.9, "b"), row(0.5, "c")],
      "desc",
    );
    expect(sorted.map((r) => r.avgScore)).toEqual([0.9, 0.5, null]);
  });

  it("pushes nulls to the bottom even in asc order", () => {
    const sorted = sortLeaderboard(
      [row(null, "a"), row(0.9, "b"), row(0.5, "c")],
      "asc",
    );
    expect(sorted.map((r) => r.avgScore)).toEqual([0.5, 0.9, null]);
  });

  it("breaks ties among nulls by kernel name", () => {
    const sorted = sortLeaderboard(
      [row(null, "charlie"), row(null, "alpha"), row(null, "bravo")],
      "desc",
    );
    expect(sorted.map((r) => r.kernelName)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [row(0.5, "a"), row(0.9, "b")];
    const copy = [...input];
    sortLeaderboard(input, "desc");
    expect(input).toEqual(copy);
  });

  it("handles empty array", () => {
    expect(sortLeaderboard([], "desc")).toEqual([]);
  });
});
