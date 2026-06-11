/**
 * Composition engine tests.
 *
 * Covers the four scenarios that gate the engine's correctness:
 *   - empty candidate pool → no_path_found
 *   - single-step picks the cheapest at or above the required tier
 *   - multi-step composes in order with linear dependsOn
 *   - over-budget returns over_budget without committing
 *
 * Plus optimization variants (speed, quality), location filtering,
 * expiry, and the execute stub.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import {
  composeRoutes,
  _clearComposeForTests,
  _registerCandidateForTests,
} from "../routes/compose.js";
import type { CompositionCandidate } from "@pcc/spec";

function makeApp() {
  const app = Fastify({ logger: false });
  void app.register(composeRoutes);
  return app;
}

function makeCandidate(
  partial: Partial<CompositionCandidate> & { capabilityId: string },
): CompositionCandidate {
  return {
    capabilityId: partial.capabilityId,
    kernelId: partial.kernelId ?? `k_${partial.capabilityId}`,
    operatorAddress:
      partial.operatorAddress ?? `op_${partial.capabilityId}@example.com`,
    capabilityType: partial.capabilityType ?? "3d-printing",
    estimatedPriceUSD: partial.estimatedPriceUSD ?? 10,
    estimatedDurationMs: partial.estimatedDurationMs ?? 60_000,
    assuranceTier: partial.assuranceTier ?? 1,
    reputation: partial.reputation,
    location: partial.location,
    available: partial.available ?? true,
  };
}

describe("POST /api/compose — no_path_found", () => {
  beforeEach(() => _clearComposeForTests());

  it("returns no_path_found when the candidate pool is empty", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 100, minAssuranceTier: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("no_path_found");
    expect(body.steps).toEqual([]);
    expect(body.rejectionReason).toContain("3d-printing");
  });

  it("returns no_path_found when no candidate meets the assurance tier", async () => {
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "c1", assuranceTier: 0 }),
    );
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 100, minAssuranceTier: 2 },
    });
    expect(res.json().status).toBe("no_path_found");
  });
});

describe("POST /api/compose — single-step optimization", () => {
  beforeEach(() => _clearComposeForTests());

  it("picks the cheapest candidate when optimizeFor=price (default)", async () => {
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "expensive", estimatedPriceUSD: 50 }),
    );
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "cheap", estimatedPriceUSD: 10 }),
    );
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "mid", estimatedPriceUSD: 25 }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 100, minAssuranceTier: 1 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].capabilityId).toBe("cheap");
    expect(body.totalPriceUSD).toBe(10);
    expect(body.budgetRemainingUSD).toBe(90);
  });

  it("picks the fastest candidate when optimizeFor=speed", async () => {
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "slow", estimatedDurationMs: 600_000 }),
    );
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "fast", estimatedDurationMs: 30_000 }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "3d-printing",
        budgetUSD: 100,
        minAssuranceTier: 1,
        optimizeFor: "speed",
      },
    });
    expect(res.json().steps[0].capabilityId).toBe("fast");
  });

  it("picks the highest-tier + highest-reputation candidate when optimizeFor=quality", async () => {
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "low", assuranceTier: 1, reputation: 100 }),
    );
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "mid", assuranceTier: 2, reputation: 100 }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "high",
        assuranceTier: 2,
        reputation: 800,
      }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "3d-printing",
        budgetUSD: 100,
        minAssuranceTier: 1,
        optimizeFor: "quality",
      },
    });
    expect(res.json().steps[0].capabilityId).toBe("high");
  });
});

describe("POST /api/compose — multi-step", () => {
  beforeEach(() => _clearComposeForTests());

  it("composes a linear DAG with dependsOn pointers", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "prep",
        capabilityType: "preparation",
        estimatedPriceUSD: 5,
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "exec",
        capabilityType: "3d-printing",
        estimatedPriceUSD: 20,
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "verify",
        capabilityType: "inspection",
        estimatedPriceUSD: 8,
      }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "3d-printing",
        steps: ["preparation", "3d-printing", "inspection"],
        budgetUSD: 100,
        minAssuranceTier: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.steps).toHaveLength(3);
    expect(body.steps[0].capabilityId).toBe("prep");
    expect(body.steps[0].dependsOn).toEqual([]);
    expect(body.steps[1].capabilityId).toBe("exec");
    expect(body.steps[1].dependsOn).toEqual([0]);
    expect(body.steps[2].capabilityId).toBe("verify");
    expect(body.steps[2].dependsOn).toEqual([1]);
    expect(body.totalPriceUSD).toBe(33);
  });

  it("uses the lowest assurance tier across steps as the effective tier", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "high",
        capabilityType: "preparation",
        assuranceTier: 3,
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "low",
        capabilityType: "3d-printing",
        assuranceTier: 1,
      }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "3d-printing",
        steps: ["preparation", "3d-printing"],
        budgetUSD: 100,
        minAssuranceTier: 1,
      },
    });
    expect(res.json().effectiveAssuranceTier).toBe(1);
  });
});

describe("POST /api/compose — budget", () => {
  beforeEach(() => _clearComposeForTests());

  it("returns over_budget when total exceeds the budget", async () => {
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "c1", estimatedPriceUSD: 60 }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 50, minAssuranceTier: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("over_budget");
    expect(body.totalPriceUSD).toBe(60);
    expect(body.budgetRemainingUSD).toBe(0);
    expect(body.rejectionReason).toContain("budget");
  });

  it("returns over_budget when multi-step total exceeds the budget", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "a",
        capabilityType: "preparation",
        estimatedPriceUSD: 30,
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "b",
        capabilityType: "execution",
        estimatedPriceUSD: 30,
      }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "execution",
        steps: ["preparation", "execution"],
        budgetUSD: 50,
        minAssuranceTier: 1,
      },
    });
    expect(res.json().status).toBe("over_budget");
  });
});

describe("POST /api/compose — location filtering", () => {
  beforeEach(() => _clearComposeForTests());

  it("filters candidates outside the location radius", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "near",
        location: { lat: 37.77, lng: -122.42 },
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "far",
        location: { lat: 40.71, lng: -74.0 }, // NYC
      }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "3d-printing",
        budgetUSD: 100,
        minAssuranceTier: 1,
        location: { lat: 37.77, lng: -122.42, radiusKm: 100 }, // SF
      },
    });
    expect(res.json().steps[0].capabilityId).toBe("near");
  });
});

describe("GET /api/compose/:id", () => {
  beforeEach(() => _clearComposeForTests());

  it("retrieves a previously-proposed composition", async () => {
    _registerCandidateForTests(makeCandidate({ capabilityId: "c1" }));
    const app = makeApp();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 100, minAssuranceTier: 1 },
    });
    const id = prop.json().compositionId;

    const got = await app.inject({ method: "GET", url: `/api/compose/${id}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().compositionId).toBe(id);
  });

  it("returns 404 for unknown id", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "GET",
      url: "/api/compose/cmp_unknown",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/compose/:id/execute", () => {
  beforeEach(() => _clearComposeForTests());

  it("queues a proposed composition (stub workflow id)", async () => {
    _registerCandidateForTests(makeCandidate({ capabilityId: "c1" }));
    const app = makeApp();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 100, minAssuranceTier: 1 },
    });
    const id = prop.json().compositionId;

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });
    expect(exec.statusCode).toBe(202);
    const body = exec.json();
    expect(body.compositionId).toBe(id);
    expect(body.workflowId).toMatch(/^wf_/);
    expect(body.status).toBe("queued");
  });

  it("rejects executing an over_budget composition", async () => {
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "c1", estimatedPriceUSD: 999 }),
    );
    const app = makeApp();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 50, minAssuranceTier: 1 },
    });
    const id = prop.json().compositionId;

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });
    expect(exec.statusCode).toBe(409);
  });

  it("returns 404 for executing an unknown composition", async () => {
    const app = makeApp();
    const exec = await app.inject({
      method: "POST",
      url: "/api/compose/cmp_nope/execute",
      payload: {},
    });
    expect(exec.statusCode).toBe(404);
  });
});

describe("POST /api/compose/_dev/register-candidate", () => {
  beforeEach(() => _clearComposeForTests());

  it("registers a candidate via the dev endpoint", async () => {
    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose/_dev/register-candidate",
      payload: {
        capabilityId: "viaApi",
        kernelId: "k1",
        operatorAddress: "op@example.com",
        capabilityType: "3d-printing",
        estimatedPriceUSD: 12,
        estimatedDurationMs: 60_000,
        assuranceTier: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().capabilityId).toBe("viaApi");

    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "3d-printing", budgetUSD: 100, minAssuranceTier: 1 },
    });
    expect(prop.json().steps[0].capabilityId).toBe("viaApi");
  });
});
