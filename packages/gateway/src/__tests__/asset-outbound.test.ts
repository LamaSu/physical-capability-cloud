/**
 * Asset-as-Agent Outbound Demand — gateway route tests.
 *
 * Covers the budget envelope, the outbound-demand state machine (proposed /
 * budget_exceeded / capability_not_allowed / owner_approval_required), the
 * owner approval gate, list + detail reads, and the lazy UTC daily-cap reset.
 *
 * Strategy (mirrors the composition-engine scaffold): pure in-memory Maps, a
 * bare Fastify instance, `_clearAssetOutboundForTests()` between cases, and
 * `_seedBudgetForTests` / `_seedDemandForTests` to set up state that the
 * public API can't reach directly (yesterday's reset, expired TTL, fixed
 * createdAt for deterministic sort).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  assetOutboundRoutes,
  isNewUtcDay,
  _clearAssetOutboundForTests,
  _seedBudgetForTests,
  _seedDemandForTests,
} from "../routes/asset-outbound.js";
import {
  _registerCandidateForTests,
  _clearComposeForTests,
} from "../routes/compose.js";
import type {
  AssetAgentBudget,
  CompositionCandidate,
  OutboundDemandResponse,
} from "@pcc/spec";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const ASSET = "asset-001";
const OWNER = "did:pcc:owner-001";
const TTL_MS = 30 * 60 * 1000;

function makeBudget(overrides: Partial<AssetAgentBudget> = {}): AssetAgentBudget {
  const nowIso = new Date().toISOString();
  return {
    assetId: ASSET,
    ownerDid: OWNER,
    budgetCapUSD: 1000,
    dailyCapUSD: 500,
    spentTodayUSD: 0,
    spentLifetimeUSD: 0,
    lastResetAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

function makeDemandSeed(
  overrides: Partial<OutboundDemandResponse> = {},
): OutboundDemandResponse {
  return {
    demandId: "dmd_seed",
    assetId: ASSET,
    status: "proposed",
    budgetSnapshot: {
      spentTodayUSD: 0,
      remainingDailyUSD: 500,
      remainingLifetimeUSD: 1000,
    },
    request: {
      description: "seeded demand",
      requiredCapabilityType: "3d-printing",
      maxPriceUSD: 50,
      minAssuranceTier: 1,
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    ...overrides,
  };
}

/** A valid OutboundDemandRequest body for POST /outbound-demand. */
function demandReq(overrides: Record<string, unknown> = {}) {
  return {
    description: "Need a replacement nozzle printed",
    requiredCapabilityType: "3d-printing",
    maxPriceUSD: 50,
    minAssuranceTier: 1,
    ...overrides,
  };
}

/**
 * Seed-able composition candidate for the in-memory compose provider. The
 * outbound-demand `proposed` path now calls the real planner, so any test that
 * expects a composed solution must register at least one matching candidate.
 * Defaults line up with `demandReq()` (type "3d-printing", tier 1).
 */
function makeComposeCandidate(
  partial: Partial<CompositionCandidate> & { capabilityId: string },
): CompositionCandidate {
  return {
    capabilityId: partial.capabilityId,
    kernelId: partial.kernelId ?? `k_${partial.capabilityId}`,
    operatorAddress:
      partial.operatorAddress ?? `op_${partial.capabilityId}@example.com`,
    capabilityType: partial.capabilityType ?? "3d-printing",
    estimatedPriceUSD: partial.estimatedPriceUSD ?? 25,
    estimatedDurationMs: partial.estimatedDurationMs ?? 60_000,
    assuranceTier: partial.assuranceTier ?? 1,
    reputation: partial.reputation,
    location: partial.location,
    available: partial.available ?? true,
  };
}

// -----------------------------------------------------------------------------
// App bootstrap
// -----------------------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(assetOutboundRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  _clearAssetOutboundForTests();
  _clearComposeForTests();
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 1 — Budget CRUD
// ═════════════════════════════════════════════════════════════════════════════

describe("PUT /api/assets/:id/budget", () => {
  it("creates a new budget (201)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/assets/${ASSET}/budget`,
      payload: { ownerDid: OWNER, budgetCapUSD: 1000, dailyCapUSD: 200 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.assetId).toBe(ASSET);
    expect(body.ownerDid).toBe(OWNER);
    expect(body.budgetCapUSD).toBe(1000);
    expect(body.dailyCapUSD).toBe(200);
    expect(body.spentTodayUSD).toBe(0);
    expect(body.spentLifetimeUSD).toBe(0);
    expect(body.lastResetAt).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
  });

  it("updates an existing budget (200) and preserves spend + createdAt", async () => {
    const first = await app.inject({
      method: "PUT",
      url: `/api/assets/${ASSET}/budget`,
      payload: { ownerDid: OWNER, budgetCapUSD: 1000, dailyCapUSD: 200 },
    });
    const createdAt = first.json().createdAt;

    const res = await app.inject({
      method: "PUT",
      url: `/api/assets/${ASSET}/budget`,
      payload: { ownerDid: OWNER, budgetCapUSD: 5000, dailyCapUSD: 750 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.budgetCapUSD).toBe(5000);
    expect(body.dailyCapUSD).toBe(750);
    expect(body.spentLifetimeUSD).toBe(0);
    expect(body.createdAt).toBe(createdAt);
  });

  it("rejects an invalid payload (400)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/assets/${ASSET}/budget`,
      payload: { ownerDid: OWNER, budgetCapUSD: -10, dailyCapUSD: 200 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});

describe("GET /api/assets/:id/budget", () => {
  it("returns 404 when no budget is set", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("budget_not_found");
  });

  it("returns the budget after a PUT", async () => {
    await app.inject({
      method: "PUT",
      url: `/api/assets/${ASSET}/budget`,
      payload: { ownerDid: OWNER, budgetCapUSD: 1000, dailyCapUSD: 200 },
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().budgetCapUSD).toBe(1000);
    expect(res.json().dailyCapUSD).toBe(200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 2 — Posting outbound demand
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/assets/:id/outbound-demand", () => {
  it("returns 404 when no budget is set", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("budget_not_found");
  });

  it("rejects an invalid demand payload (400)", async () => {
    _seedBudgetForTests(makeBudget());
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: -5 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("→ budget_exceeded when over the daily cap", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 10, budgetCapUSD: 1000 }));
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 50 }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("budget_exceeded");
    expect(res.json().composedSolution).toBeUndefined();

    // No spend occurred.
    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentLifetimeUSD).toBe(0);
  });

  it("→ budget_exceeded when over the lifetime cap (within daily)", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 1000, budgetCapUSD: 10 }));
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 50 }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("budget_exceeded");
  });

  it("→ capability_not_allowed when type not whitelisted", async () => {
    _seedBudgetForTests(
      makeBudget({ allowedCapabilityTypes: ["cnc", "laser-cutting"] }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ requiredCapabilityType: "3d-printing", maxPriceUSD: 50 }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("capability_not_allowed");
  });

  it("→ owner_approval_required without spending when the flag is set", async () => {
    _seedBudgetForTests(makeBudget({ requiresOwnerApproval: true }));
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 50 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("owner_approval_required");
    expect(body.composedSolution).toBeUndefined();

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentTodayUSD).toBe(0);
    expect(budgetRes.json().spentLifetimeUSD).toBe(0);
  });

  it("→ proposed with a composed solution and charges the budget", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 500, budgetCapUSD: 1000 }));
    // The planner now drives the price: a single $120 candidate of the demanded
    // type, within the $120 max → totalPriceUSD 120, one step.
    _registerCandidateForTests(
      makeComposeCandidate({ capabilityId: "prop_cap", estimatedPriceUSD: 120 }),
    );
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 120 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.composedSolution).toBeDefined();
    expect(body.composedSolution.compositionId).toMatch(/^cmp_/);
    expect(body.composedSolution.totalPriceUSD).toBe(120); // candidate price
    expect(body.composedSolution.stepCount).toBe(1);
    expect(body.budgetSnapshot.spentTodayUSD).toBe(120);
    expect(body.budgetSnapshot.remainingDailyUSD).toBe(380);
    expect(body.budgetSnapshot.remainingLifetimeUSD).toBe(880);

    // Persisted on the budget.
    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentTodayUSD).toBe(120);
    expect(budgetRes.json().spentLifetimeUSD).toBe(120);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 3 — Owner approval gate
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /api/assets/:id/outbound-demand/:demandId/approve", () => {
  async function seedAwaitingApproval(maxPriceUSD = 100): Promise<string> {
    _seedBudgetForTests(
      makeBudget({ requiresOwnerApproval: true, dailyCapUSD: 500, budgetCapUSD: 1000 }),
    );
    const created = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD }),
    });
    expect(created.json().status).toBe("owner_approval_required");
    return created.json().demandId;
  }

  it("transitions owner_approval_required → approved and charges the budget", async () => {
    const demandId = await seedAwaitingApproval(100);
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand/${demandId}/approve`,
      payload: { approved: true, approverDid: OWNER },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("approved");
    expect(body.composedSolution.totalPriceUSD).toBe(100);

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentTodayUSD).toBe(100);
    expect(budgetRes.json().spentLifetimeUSD).toBe(100);
  });

  it("transitions to rejected when approved=false, with no spend", async () => {
    const demandId = await seedAwaitingApproval(100);
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand/${demandId}/approve`,
      payload: { approved: false, approverDid: OWNER, note: "Too expensive right now" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("rejected");
    expect(body.rejectionReason).toBe("Too expensive right now");
    expect(body.composedSolution).toBeUndefined();

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentLifetimeUSD).toBe(0);
  });

  it("returns 409 when the demand is not awaiting approval", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 500, budgetCapUSD: 1000 }));
    _registerCandidateForTests(
      makeComposeCandidate({ capabilityId: "approve_409_cap", estimatedPriceUSD: 40 }),
    );
    const created = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 50 }),
    });
    expect(created.json().status).toBe("proposed");
    const demandId = created.json().demandId;

    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand/${demandId}/approve`,
      payload: { approved: true, approverDid: OWNER },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_state");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 4 — List + detail reads
// ═════════════════════════════════════════════════════════════════════════════

describe("GET /api/assets/:id/outbound-demand (list + detail)", () => {
  it("lists demands sorted by createdAt descending", async () => {
    _seedDemandForTests(
      makeDemandSeed({ demandId: "dmd_a", createdAt: "2026-06-01T00:00:00.000Z" }),
    );
    _seedDemandForTests(
      makeDemandSeed({ demandId: "dmd_b", createdAt: "2026-06-03T00:00:00.000Z" }),
    );
    _seedDemandForTests(
      makeDemandSeed({ demandId: "dmd_c", createdAt: "2026-06-02T00:00:00.000Z" }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/outbound-demand`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(3);
    expect(body.demands.map((d: { demandId: string }) => d.demandId)).toEqual([
      "dmd_b",
      "dmd_c",
      "dmd_a",
    ]);
  });

  it("filters the list by ?status=", async () => {
    _seedDemandForTests(
      makeDemandSeed({ demandId: "dmd_p", status: "proposed", createdAt: "2026-06-01T00:00:00.000Z" }),
    );
    _seedDemandForTests(
      makeDemandSeed({ demandId: "dmd_r", status: "rejected", createdAt: "2026-06-02T00:00:00.000Z" }),
    );
    _seedDemandForTests(
      makeDemandSeed({ demandId: "dmd_p2", status: "proposed", createdAt: "2026-06-03T00:00:00.000Z" }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/outbound-demand?status=proposed`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(2);
    expect(
      body.demands.every((d: { status: string }) => d.status === "proposed"),
    ).toBe(true);
  });

  it("returns a single demand, and 404 for an unknown id", async () => {
    _seedDemandForTests(makeDemandSeed({ demandId: "dmd_one" }));
    const ok = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/outbound-demand/dmd_one`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().demandId).toBe("dmd_one");

    const missing = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/outbound-demand/dmd_nope`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("demand_not_found");
  });

  it("returns 410 for a demand past its TTL", async () => {
    _seedDemandForTests(
      makeDemandSeed({
        demandId: "dmd_old",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/outbound-demand/dmd_old`,
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("demand_expired");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 5 — Daily cap auto-reset
// ═════════════════════════════════════════════════════════════════════════════

describe("daily cap auto-reset", () => {
  it("resets spentTodayUSD when lastResetAt is a previous UTC day, then succeeds", async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    _seedBudgetForTests(
      makeBudget({
        dailyCapUSD: 100,
        budgetCapUSD: 10000,
        spentTodayUSD: 95, // only 5 remaining today WITHOUT a reset
        spentLifetimeUSD: 95,
        lastResetAt: yesterday,
      }),
    );
    // A $50 candidate so the proposed path charges exactly the $50 we assert on.
    _registerCandidateForTests(
      makeComposeCandidate({ capabilityId: "reset_cap", estimatedPriceUSD: 50 }),
    );

    // maxPrice 50 > 5 (pre-reset remaining) but ≤ 100 (post-reset) → proposed.
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 50 }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("proposed");

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    // Daily reset to 0 then charged 50; lifetime carries forward 95 + 50.
    expect(budgetRes.json().spentTodayUSD).toBe(50);
    expect(budgetRes.json().spentLifetimeUSD).toBe(145);
  });

  it("isNewUtcDay detects a UTC day rollover", () => {
    expect(
      isNewUtcDay("2026-06-01T23:59:59.000Z", new Date("2026-06-02T00:00:01.000Z")),
    ).toBe(true);
    expect(
      isNewUtcDay("2026-06-02T00:00:00.000Z", new Date("2026-06-02T23:00:00.000Z")),
    ).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Section 6 — composition-engine wiring (mock synthesis → real /api/compose)
// ═════════════════════════════════════════════════════════════════════════════
//
// The proposed branch of POST /outbound-demand now calls the composition
// planner instead of fabricating a solution. These cases drive each of the
// planner's three terminal statuses through the demand state machine and
// assert the spend counters move ONLY on a real `proposed` plan.

describe("composition-engine wiring", () => {
  it("proposed: composes a real solution from a seeded candidate", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 500, budgetCapUSD: 1000 }));
    _registerCandidateForTests(
      makeComposeCandidate({
        capabilityId: "wire_happy",
        capabilityType: "3d-printing",
        estimatedPriceUSD: 30,
        assuranceTier: 1,
      }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 100 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.composedSolution.compositionId).toMatch(/^cmp_/);
    // Charged the ACTUAL composed price ($30), not the $100 ceiling.
    expect(body.composedSolution.totalPriceUSD).toBe(30);
    expect(body.composedSolution.stepCount).toBe(1);
    expect(body.budgetSnapshot.spentTodayUSD).toBe(30);
    expect(body.budgetSnapshot.remainingDailyUSD).toBe(470);

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentLifetimeUSD).toBe(30);
  });

  it("proposed: optimizeFor=price picks the cheapest matching candidate", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 500, budgetCapUSD: 1000 }));
    _registerCandidateForTests(
      makeComposeCandidate({ capabilityId: "pricey", estimatedPriceUSD: 80 }),
    );
    _registerCandidateForTests(
      makeComposeCandidate({ capabilityId: "cheapest", estimatedPriceUSD: 15 }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 100, preferredOptimization: "price" }),
    });
    expect(res.json().status).toBe("proposed");
    expect(res.json().composedSolution.totalPriceUSD).toBe(15);

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentLifetimeUSD).toBe(15);
  });

  it("rejected (no_path_found): no candidate seeded → no spend", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 500, budgetCapUSD: 1000 }));
    // Deliberately seed NO compose candidates.
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 100 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("rejected");
    expect(body.composedSolution).toBeUndefined();
    expect(body.rejectionReason).toBeTruthy();

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentTodayUSD).toBe(0);
    expect(budgetRes.json().spentLifetimeUSD).toBe(0);
  });

  it("budget_exceeded (over_budget): cheapest path above maxPriceUSD → no spend", async () => {
    // Caps are generous so the pre-budget gate passes; the planner itself
    // rejects because the only candidate costs more than the $50 max.
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 500, budgetCapUSD: 1000 }));
    _registerCandidateForTests(
      makeComposeCandidate({ capabilityId: "too_dear", estimatedPriceUSD: 60 }),
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({ maxPriceUSD: 50 }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("budget_exceeded");
    expect(body.composedSolution).toBeUndefined();

    const budgetRes = await app.inject({
      method: "GET",
      url: `/api/assets/${ASSET}/budget`,
    });
    expect(budgetRes.json().spentTodayUSD).toBe(0);
    expect(budgetRes.json().spentLifetimeUSD).toBe(0);
  });

  it("rejected demand carries the planner's rejectionReason", async () => {
    _seedBudgetForTests(makeBudget({ dailyCapUSD: 500, budgetCapUSD: 1000 }));
    // A demand for a type with no seeded candidate; whitelist is open so the
    // request reaches the planner, which fails to find a path.
    const res = await app.inject({
      method: "POST",
      url: `/api/assets/${ASSET}/outbound-demand`,
      payload: demandReq({
        requiredCapabilityType: "laser-cutting",
        maxPriceUSD: 100,
      }),
    });
    expect(res.json().status).toBe("rejected");
    expect(res.json().rejectionReason).toContain("laser-cutting");
  });
});
