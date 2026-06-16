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

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  composeRoutes,
  executeComposition,
  createProductionBinding,
  _clearComposeForTests,
  _registerCandidateForTests,
  _setStepRunnerForTests,
} from "../routes/compose.js";
import {
  _clearGraphSearchForTests,
  _seedGraphSearchForTests,
} from "../routes/graph-search.js";
import { reputationRoutes, _clearReputationForTests } from "../routes/reputation.js";
import { getCapabilityFacade, getKernelFacade } from "../facades/index.js";
import type { CompositionCandidate, RegisterGraphNodeInput } from "@pcc/spec";

function makeApp() {
  const app = Fastify({ logger: false });
  void app.register(composeRoutes);
  return app;
}

/** App with both compose + reputation routes — lets execute tests read back
 *  reputation/outcome state over HTTP (the two route modules share in-memory
 *  reputation stores). */
function makeAppWithReputation(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(composeRoutes);
  void app.register(reputationRoutes);
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

/** Build a graph-search node-registration input with sensible defaults. */
function gnode(
  over: Partial<RegisterGraphNodeInput> & { capabilityId: string },
): RegisterGraphNodeInput {
  return {
    capabilityId: over.capabilityId,
    capabilityType: over.capabilityType ?? over.capabilityId,
    kernelId: over.kernelId ?? `k_${over.capabilityId}`,
    estimatedPriceUSD: over.estimatedPriceUSD ?? 10,
    estimatedDurationMs: over.estimatedDurationMs ?? 1_000,
    assuranceTier: over.assuranceTier ?? 1,
    reputation: over.reputation ?? 500,
    available: over.available ?? true,
    inputTypes: over.inputTypes ?? [],
    outputTypes: over.outputTypes ?? [],
  };
}

// compose now reads graph-search's module state when it falls back to Dijkstra,
// so the shared graph must be reset alongside the candidate store before every
// test — otherwise stale nodes/edges leak across cases.
beforeEach(() => {
  _clearComposeForTests();
  _clearGraphSearchForTests();
});

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
  beforeEach(() => {
    _clearComposeForTests();
    _clearReputationForTests();
  });

  it("executes a proposed composition and reports completion", async () => {
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
    expect(body.status).toBe("completed");
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

describe("POST /api/compose — graph-search integration (PR #92 wiring)", () => {
  it("uses the direct 1-step provider when one matches (graph ignored)", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "direct",
        capabilityType: "widget",
        estimatedPriceUSD: 7,
      }),
    );
    _seedGraphSearchForTests({
      nodes: [
        gnode({ capabilityId: "gSeed", outputTypes: ["seed"] }),
        gnode({
          capabilityId: "gWidget",
          inputTypes: ["seed"],
          outputTypes: ["widget"],
          estimatedPriceUSD: 99,
        }),
      ],
      edges: [
        { fromCapabilityId: "gSeed", toCapabilityId: "gWidget", capabilityTypeFlow: "seed" },
      ],
    });

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "widget", budgetUSD: 100, minAssuranceTier: 1 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].capabilityId).toBe("direct");
    expect(body.totalPriceUSD).toBe(7);
  });

  it("plans a 3-step path from an outcomeChain via graph-search (totalPriceUSD = sum)", async () => {
    _seedGraphSearchForTests({
      nodes: [
        gnode({ capabilityId: "A", capabilityType: "synth", outputTypes: ["A"], estimatedPriceUSD: 5 }),
        gnode({ capabilityId: "B", capabilityType: "purify", inputTypes: ["A"], outputTypes: ["B"], estimatedPriceUSD: 8 }),
        gnode({ capabilityId: "C", capabilityType: "assay", inputTypes: ["B"], outputTypes: ["C"], estimatedPriceUSD: 12 }),
      ],
      edges: [
        { fromCapabilityId: "A", toCapabilityId: "B", capabilityTypeFlow: "A" },
        { fromCapabilityId: "B", toCapabilityId: "C", capabilityTypeFlow: "B" },
      ],
    });

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "C",
        outcomeChain: ["A", "B", "C"],
        budgetUSD: 100,
        minAssuranceTier: 1,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.steps).toHaveLength(3);
    expect(body.steps.map((s: { capabilityId: string }) => s.capabilityId)).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(body.steps[0].dependsOn).toEqual([]);
    expect(body.steps[1].dependsOn).toEqual([0]);
    expect(body.steps[2].dependsOn).toEqual([1]);
    expect(body.totalPriceUSD).toBe(25);
    expect(body.steps.map((s: { capabilityType: string }) => s.capabilityType)).toEqual([
      "synth",
      "purify",
      "assay",
    ]);
  });

  it("returns no_path_found when the outcomeChain has a gap (no B→C edge)", async () => {
    _seedGraphSearchForTests({
      nodes: [
        gnode({ capabilityId: "A", outputTypes: ["A"] }),
        gnode({ capabilityId: "B", inputTypes: ["A"], outputTypes: ["B"] }),
        gnode({ capabilityId: "C", inputTypes: ["B"], outputTypes: ["C"] }),
      ],
      edges: [
        { fromCapabilityId: "A", toCapabilityId: "B", capabilityTypeFlow: "A" },
      ],
    });

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "C",
        outcomeChain: ["A", "B", "C"],
        budgetUSD: 100,
        minAssuranceTier: 1,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("no_path_found");
    expect(body.steps).toEqual([]);
  });

  it("falls back to a graph path when no direct provider matches the outcome", async () => {
    _seedGraphSearchForTests({
      nodes: [
        gnode({ capabilityId: "raw", outputTypes: ["mid"], estimatedPriceUSD: 4 }),
        gnode({ capabilityId: "fin", inputTypes: ["mid"], outputTypes: ["gadget"], estimatedPriceUSD: 6 }),
      ],
      edges: [
        { fromCapabilityId: "raw", toCapabilityId: "fin", capabilityTypeFlow: "mid" },
      ],
    });

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "gadget", budgetUSD: 100, minAssuranceTier: 1 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.steps).toHaveLength(2);
    expect(body.steps.map((s: { capabilityId: string }) => s.capabilityId)).toEqual([
      "raw",
      "fin",
    ]);
    expect(body.totalPriceUSD).toBe(10);
  });

  it("maps a budget-priced-out graph fallback to over_budget", async () => {
    _seedGraphSearchForTests({
      nodes: [gnode({ capabilityId: "x1", outputTypes: ["pricey"], estimatedPriceUSD: 80 })],
    });

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "pricey", budgetUSD: 50, minAssuranceTier: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("over_budget");
    expect(body.steps).toEqual([]);
  });
});

describe("POST /api/compose/:id/execute — reputation wiring", () => {
  beforeEach(() => {
    _clearComposeForTests();
    _clearReputationForTests();
  });

  function registerSteps(
    specs: {
      capabilityType: string;
      capabilityId: string;
      operatorAddress: string;
      price?: number;
    }[],
  ): void {
    for (const s of specs) {
      _registerCandidateForTests(
        makeCandidate({
          capabilityId: s.capabilityId,
          capabilityType: s.capabilityType,
          operatorAddress: s.operatorAddress,
          estimatedPriceUSD: s.price ?? 10,
        }),
      );
    }
  }

  async function proposeTwoStep(app: FastifyInstance): Promise<string> {
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "print",
        steps: ["prep", "print"],
        budgetUSD: 100,
        minAssuranceTier: 1,
      },
    });
    expect(prop.json().status).toBe("proposed");
    return prop.json().compositionId;
  }

  it("all-success execute records success outcomes, finalizes, and bumps each participant +15", async () => {
    registerSteps([
      { capabilityType: "prep", capabilityId: "cap-prep", operatorAddress: "op-prep" },
      { capabilityType: "print", capabilityId: "cap-print", operatorAddress: "op-print" },
    ]);
    const app = makeAppWithReputation();
    const id = await proposeTwoStep(app);

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });
    expect(exec.statusCode).toBe(202);
    expect(exec.json().status).toBe("completed");
    expect(exec.json().workflowId).toMatch(/^wf_/);

    const outc = await app.inject({
      method: "GET",
      url: `/api/compositions/${id}/step-outcomes`,
    });
    expect(outc.json().count).toBe(2);
    expect(
      outc.json().outcomes.every((o: { status: string }) => o.status === "success"),
    ).toBe(true);
    expect(
      outc
        .json()
        .outcomes.every((o: { finalReputationApplied: boolean }) => o.finalReputationApplied),
    ).toBe(true);

    const prep = await app.inject({ method: "GET", url: "/api/reputation/op-prep" });
    expect(prep.json().reputation.score).toBe(515);
    const print = await app.inject({ method: "GET", url: "/api/reputation/op-print" });
    expect(print.json().reputation.score).toBe(515);
  });

  it("a mid-stream failure debits -15, short-circuits downstream steps, and skips the bonus", async () => {
    registerSteps([
      { capabilityType: "prep", capabilityId: "cap-prep", operatorAddress: "op-prep" },
      { capabilityType: "print", capabilityId: "cap-print", operatorAddress: "op-print" },
      { capabilityType: "inspect", capabilityId: "cap-inspect", operatorAddress: "op-inspect" },
    ]);
    const app = makeAppWithReputation();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "inspect",
        steps: ["prep", "print", "inspect"],
        budgetUSD: 100,
        minAssuranceTier: 1,
      },
    });
    const id = prop.json().compositionId;

    _setStepRunnerForTests((step) => {
      if (step.index === 1) throw new Error("evidence verification failed");
    });

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });
    expect(exec.statusCode).toBe(202);
    expect(exec.json().status).toBe("failed");

    const outc = await app.inject({
      method: "GET",
      url: `/api/compositions/${id}/step-outcomes`,
    });
    expect(outc.json().count).toBe(2);
    expect(outc.json().outcomes.map((o: { status: string }) => o.status)).toEqual([
      "success",
      "failed",
    ]);

    const prep = await app.inject({ method: "GET", url: "/api/reputation/op-prep" });
    expect(prep.json().reputation.score).toBe(510);
    const print = await app.inject({ method: "GET", url: "/api/reputation/op-print" });
    expect(print.json().reputation.score).toBe(485);
    const inspect = await app.inject({ method: "GET", url: "/api/reputation/op-inspect" });
    expect(inspect.json().reputation.score).toBe(500);
  });

  it("exposes the post-execute reputation (with deltas) via GET /api/reputation/:agentId", async () => {
    registerSteps([
      { capabilityType: "print", capabilityId: "cap-solo", operatorAddress: "op-solo" },
    ]);
    const app = makeAppWithReputation();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "print", budgetUSD: 100, minAssuranceTier: 1 },
    });
    const id = prop.json().compositionId;

    await app.inject({ method: "POST", url: `/api/compose/${id}/execute`, payload: {} });

    const rep = await app.inject({ method: "GET", url: "/api/reputation/op-solo" });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().reputation.score).toBe(515);
    expect(
      rep.json().recentDeltas.map((d: { reason: string }) => d.reason).sort(),
    ).toEqual(["composition_completed", "step_completed"]);
  });

  it("is idempotent: re-executing a completed composition replays the result and applies no new deltas", async () => {
    registerSteps([
      { capabilityType: "print", capabilityId: "cap-idem", operatorAddress: "op-idem" },
    ]);
    const app = makeAppWithReputation();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "print", budgetUSD: 100, minAssuranceTier: 1 },
    });
    const id = prop.json().compositionId;

    const first = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().workflowId).toBe(first.json().workflowId);
    expect(second.json().status).toBe("completed");

    const rep = await app.inject({ method: "GET", url: "/api/reputation/op-idem" });
    expect(rep.json().reputation.score).toBe(515);
    const deltas = await app.inject({
      method: "GET",
      url: "/api/reputation/op-idem/deltas",
    });
    expect(deltas.json().total).toBe(2);
  });

  it("executeComposition runs in-process and returns a structured result", async () => {
    registerSteps([
      { capabilityType: "prep", capabilityId: "cap-prep", operatorAddress: "op-prep" },
      { capabilityType: "print", capabilityId: "cap-print", operatorAddress: "op-print" },
    ]);
    const app = makeAppWithReputation();
    const id = await proposeTwoStep(app);

    const got = await app.inject({ method: "GET", url: `/api/compose/${id}` });
    const result = await executeComposition(got.json());

    expect(result.status).toBe("completed");
    expect(result.stepsExecuted).toBe(2);
    expect(result.failedStepIndex).toBeNull();
    expect(result.deltasApplied).toHaveLength(4);

    const prep = await app.inject({ method: "GET", url: "/api/reputation/op-prep" });
    expect(prep.json().reputation.score).toBe(515);
  });
});

// ---------------------------------------------------------------------------
// Production binding — verifies real job submission + workflow id
// ---------------------------------------------------------------------------

describe("createProductionBinding", () => {
  function registerProdSteps(
    specs: { capabilityType: string; capabilityId: string; operatorAddress: string }[],
  ): void {
    for (const s of specs) {
      _registerCandidateForTests(
        makeCandidate({
          capabilityId: s.capabilityId,
          capabilityType: s.capabilityType,
          operatorAddress: s.operatorAddress,
        }),
      );
    }
  }

  afterEach(() => {
    vi.restoreAllMocks();
    _clearComposeForTests();
    _clearGraphSearchForTests();
  });

  it("submits a real job via JobFacade for each step and returns a workflow id", async () => {
    // Arrange: stub JobFacade.submit to return a successful ack
    const submitMock = vi.fn().mockResolvedValue({
      success: true,
      data: { jobId: "job-stub-001", deviceId: null, status: "queued" },
    });
    const stubFacade = { submit: submitMock };

    // Register a candidate and build a composition
    registerProdSteps([
      { capabilityType: "print", capabilityId: "cap-prod", operatorAddress: "op-prod" },
    ]);
    const app = makeApp();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "print", budgetUSD: 100, minAssuranceTier: 1 },
    });
    const composition = prop.json();

    // Act: execute with production binding, injecting the stub facade
    const binding = createProductionBinding(() => stubFacade as never);
    const result = await executeComposition(composition, binding);

    // Assert: job was submitted, execution succeeded, workflow id is present
    expect(submitMock).toHaveBeenCalledOnce();
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ capabilityId: "cap-prod", kernelId: expect.any(String) }),
    );
    expect(result.status).toBe("completed");
    expect(result.stepsExecuted).toBe(1);
    expect(result.workflowId).toBeTruthy();
    expect(result.failedStepIndex).toBeNull();
  });

  it("marks a step failed and short-circuits when JobFacade.submit returns an error", async () => {
    // Arrange: stub JobFacade.submit to return failure
    const submitMock = vi.fn().mockResolvedValue({
      success: false,
      error: { code: "no_capability_found_for_kernel", message: "No capability", httpStatus: 400 },
    });
    const stubFacade = { submit: submitMock };

    // Register two candidates — second should never be executed
    registerProdSteps([
      { capabilityType: "prep", capabilityId: "cap-a", operatorAddress: "op-a" },
      { capabilityType: "print", capabilityId: "cap-b", operatorAddress: "op-b" },
    ]);
    const app = makeApp();
    const prop = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "print",
        steps: ["prep", "print"],
        budgetUSD: 100,
        minAssuranceTier: 1,
      },
    });
    const composition = prop.json();

    const binding = createProductionBinding(() => stubFacade as never);
    const result = await executeComposition(composition, binding);

    expect(result.status).toBe("failed");
    expect(result.failedStepIndex).toBe(0);
    expect(result.stepsExecuted).toBe(1); // short-circuited after first failure
    // Only one submit call — second step was never reached
    expect(submitMock).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Production wiring — CapabilityFacade-backed provider
// (PCC_COMPOSE_USE_FACADE=true). Verifies /api/compose draws REAL registered
// capabilities through the facade path, not the dev candidate pool.
// ---------------------------------------------------------------------------

describe("POST /api/compose — CapabilityFacade-backed provider (production wiring)", () => {
  beforeEach(() => {
    _clearComposeForTests();
    _clearGraphSearchForTests();
    process.env.PCC_COMPOSE_USE_FACADE = "true";
  });

  afterEach(() => {
    delete process.env.PCC_COMPOSE_USE_FACADE;
    _clearComposeForTests();
  });

  /** Register a kernel + a capability through the REAL facade write path so the
   *  facade-backed provider can read them back via CapabilityFacade.listByType. */
  async function registerRealCapability(opts: {
    kernelId: string;
    operatorAddress: string;
    capabilityId: string;
    type: string;
    baseCostUSD: number;
  }): Promise<void> {
    const kernel = await getKernelFacade().register({
      id: opts.kernelId,
      name: `Kernel ${opts.kernelId}`,
      operatorAddress: opts.operatorAddress,
      location: { lat: 37.77, lng: -122.42 },
      maxAssuranceTier: 2,
    });
    expect(kernel.success).toBe(true);

    const cap = await getCapabilityFacade().create({
      id: opts.capabilityId,
      kernelId: opts.kernelId,
      type: opts.type,
      name: `${opts.type} @ ${opts.kernelId}`,
      pricing: {
        currency: "USDC",
        baseCost: String(opts.baseCostUSD),
        minimum: String(opts.baseCostUSD),
      },
      assuranceTiers: [0, 1, 2],
      location: { lat: 37.77, lng: -122.42 },
    });
    expect(cap.success).toBe(true);
  }

  it("draws a single real registered capability (not the dev pool) and proposes it", async () => {
    await registerRealCapability({
      kernelId: "kernel-facade-1",
      operatorAddress: "op-facade-1@example.com",
      capabilityId: "cap-facade-print",
      type: "facade-3d-printing",
      baseCostUSD: 18,
    });

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "facade-3d-printing", budgetUSD: 100, minAssuranceTier: 1 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].capabilityId).toBe("cap-facade-print");
    // operatorAddress resolved via KernelFacade, not present on CapabilityDTO.
    expect(body.steps[0].operatorAddress).toBe("op-facade-1@example.com");
    expect(body.steps[0].estimatedPriceUSD).toBe(18);
    expect(body.totalPriceUSD).toBe(18);
  });

  it("plans a multi-step DAG (make-pizza → deliver-pizza) from real facade capabilities", async () => {
    await registerRealCapability({
      kernelId: "kernel-pizzeria",
      operatorAddress: "op-pizzeria@example.com",
      capabilityId: "cap-make-pizza",
      type: "make-pizza",
      baseCostUSD: 12,
    });
    await registerRealCapability({
      kernelId: "kernel-courier",
      operatorAddress: "op-courier@example.com",
      capabilityId: "cap-deliver-pizza",
      type: "deliver-pizza",
      baseCostUSD: 7,
    });

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: {
        outcomeType: "deliver-pizza",
        steps: ["make-pizza", "deliver-pizza"],
        budgetUSD: 50,
        minAssuranceTier: 1,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("proposed");
    expect(body.steps).toHaveLength(2);
    expect(body.steps.map((s: { capabilityId: string }) => s.capabilityId)).toEqual([
      "cap-make-pizza",
      "cap-deliver-pizza",
    ]);
    expect(body.steps.map((s: { capabilityType: string }) => s.capabilityType)).toEqual([
      "make-pizza",
      "deliver-pizza",
    ]);
    // Linear DAG dependsOn wiring.
    expect(body.steps[0].dependsOn).toEqual([]);
    expect(body.steps[1].dependsOn).toEqual([0]);
    // Operators resolved per step via KernelFacade.
    expect(body.steps[0].operatorAddress).toBe("op-pizzeria@example.com");
    expect(body.steps[1].operatorAddress).toBe("op-courier@example.com");
    expect(body.totalPriceUSD).toBe(19);
  });

  it("ignores the dev candidate pool while the facade provider is active", async () => {
    // A candidate injected into the dev pool must NOT surface via the facade path.
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "dev-pool-only", capabilityType: "facade-only-type" }),
    );

    const app = makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/compose",
      payload: { outcomeType: "facade-only-type", budgetUSD: 100, minAssuranceTier: 1 },
    });

    // No REAL capability of this type exists → facade finds nothing,
    // graph-search has no node → no_path_found (the dev pool was ignored).
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("no_path_found");
  });
});
