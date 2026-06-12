/**
 * Reputation propagation through compositions — gateway route tests.
 *
 * Covers:
 *   GET  /api/reputation/:agentId                — lazy-init + state after deltas
 *   GET  /api/reputation/:agentId/deltas         — pagination
 *   GET  /api/reputation/leaderboard             — descending + kind filter
 *   POST /api/compositions/:id/step-outcome      — create / idempotent / 409 finalized
 *   GET  /api/compositions/:id/step-outcomes     — ordered list
 *   POST /api/compositions/:id/disputes          — file + 404 + status flip
 *   GET  /api/compositions/:id/disputes          — list
 *   POST /api/disputes/:id/resolve               — upheld / rejected / 409
 *   POST /api/compositions/:id/finalize-reputation — settle / idempotent / bonus
 *   clamping to [0, 1000]
 *
 * Strategy: real Fastify with `.inject()`, in-memory stores wiped per test via
 * `_clearReputationForTests`. No auth/DB mocking needed — the route is
 * storage-pure, mirroring the kernel-marketplace test harness.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { AgentReputation } from "@pcc/spec";
import {
  reputationRoutes,
  applyDelta,
  getOrInitReputation,
  recordStepOutcome,
  finalizeReputation,
  _clearReputationForTests,
  _seedReputationForTests,
} from "../routes/reputation.js";

// ---------------------------------------------------------------------------
// App + fixtures
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(reputationRoutes);
  await app.ready();
  return app;
}

function stepOutcomePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    compositionId: "comp-1",
    stepIndex: 0,
    capabilityId: "cap-3d-printing",
    agentId: "operator-alpha",
    status: "success",
    startedAt: "2026-06-11T10:00:00.000Z",
    completedAt: "2026-06-11T10:05:00.000Z",
    ...overrides,
  };
}

function disputePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    disputerId: "composer-zulu",
    stepIndex: 0,
    reason: "wrong_output",
    description: "Step 0 produced the wrong part geometry.",
    ...overrides,
  };
}

function repFixture(overrides: Partial<AgentReputation> = {}): AgentReputation {
  return {
    agentId: "seed-agent",
    kind: "operator-kernel",
    score: 500,
    positiveContributions: 0,
    negativeContributions: 0,
    disputesUpheld: 0,
    disputesRejected: 0,
    lastUpdatedAt: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Reputation propagation through compositions", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    _clearReputationForTests();
  });

  // ── GET /api/reputation/:agentId ───────────────────────────────────────

  it("1. lazy-inits an unseen agent at score 500 with zero deltas", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/reputation/never-seen-agent",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reputation.agentId).toBe("never-seen-agent");
    expect(body.reputation.score).toBe(500);
    expect(body.recentDeltas).toEqual([]);
  });

  it("2. returns updated state after a delta is applied", async () => {
    applyDelta("agent-x", 10, "step_completed");
    const res = await app.inject({
      method: "GET",
      url: "/api/reputation/agent-x",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.reputation.score).toBe(510);
    expect(body.recentDeltas).toHaveLength(1);
    expect(body.recentDeltas[0].delta).toBe(10);
    expect(body.recentDeltas[0].reason).toBe("step_completed");
  });

  // ── GET /api/reputation/:agentId/deltas ────────────────────────────────

  it("3. paginates delta history (offset + limit, newest-first)", async () => {
    for (const d of [1, 2, 3, 4, 5]) {
      applyDelta("pager-agent", d, "manual_adjustment");
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/reputation/pager-agent/deltas?limit=2&offset=1",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // newest-first is [+5,+4,+3,+2,+1]; offset 1 limit 2 -> [+4,+3]
    expect(body.deltas.map((d: { delta: number }) => d.delta)).toEqual([4, 3]);
    expect(body.count).toBe(2);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
  });

  // ── POST /api/compositions/:id/step-outcome ────────────────────────────

  it("4. creates a step outcome (201)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-1/step-outcome",
      payload: stepOutcomePayload(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.outcome.outcomeId).toBe("string");
    expect(body.outcome.status).toBe("success");
    expect(body.outcome.stepIndex).toBe(0);
    expect(body.outcome.finalReputationApplied).toBe(false);
  });

  it("5. rejects an invalid step-outcome payload (400)", async () => {
    const bad = stepOutcomePayload();
    delete bad.agentId;
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-1/step-outcome",
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("6. is idempotent on (compositionId, stepIndex) — replaces if not finalized", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-idem/step-outcome",
      payload: stepOutcomePayload({
        compositionId: "comp-idem",
        agentId: "agent-first",
        status: "success",
      }),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-idem/step-outcome",
      payload: stepOutcomePayload({
        compositionId: "comp-idem",
        agentId: "agent-second",
        status: "failed",
      }),
    });
    expect(second.statusCode).toBe(201);

    const list = await app.inject({
      method: "GET",
      url: "/api/compositions/comp-idem/step-outcomes",
    });
    const body = list.json();
    expect(body.count).toBe(1);
    expect(body.outcomes[0].agentId).toBe("agent-second");
    expect(body.outcomes[0].status).toBe("failed");
  });

  it("7. refuses to overwrite a FINALIZED outcome (409)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-final/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-final", status: "success" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-final/finalize-reputation",
      payload: { finalizerId: "engine-1" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-final/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-final", status: "failed" }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("outcome_finalized");
  });

  // ── GET /api/compositions/:id/step-outcomes ────────────────────────────

  it("8. lists step outcomes ordered by stepIndex ascending", async () => {
    for (const stepIndex of [2, 0, 1]) {
      await app.inject({
        method: "POST",
        url: "/api/compositions/comp-order/step-outcome",
        payload: stepOutcomePayload({
          compositionId: "comp-order",
          stepIndex,
          agentId: `agent-${stepIndex}`,
        }),
      });
    }
    const res = await app.inject({
      method: "GET",
      url: "/api/compositions/comp-order/step-outcomes",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outcomes.map((o: { stepIndex: number }) => o.stepIndex)).toEqual([
      0, 1, 2,
    ]);
  });

  // ── POST /api/compositions/:id/disputes ────────────────────────────────

  it("9. returns 404 when filing a dispute against a missing step outcome", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-nope/disputes",
      payload: disputePayload({ stepIndex: 5 }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("outcome_not_found");
  });

  it("10. files a pending dispute and flips the outcome status to 'disputed' (201)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-disp/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-disp", status: "success" }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-disp/disputes",
      payload: disputePayload(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().dispute.status).toBe("pending");

    const list = await app.inject({
      method: "GET",
      url: "/api/compositions/comp-disp/step-outcomes",
    });
    expect(list.json().outcomes[0].status).toBe("disputed");
  });

  it("11. rejects an invalid dispute payload (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-disp/disputes",
      payload: { disputerId: "composer-zulu", stepIndex: 0 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  // ── POST /api/disputes/:id/resolve ─────────────────────────────────────

  it("12. resolving a dispute as upheld applies -50 to the disputed agent (200)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-up/step-outcome",
      payload: stepOutcomePayload({
        compositionId: "comp-up",
        agentId: "operator-up",
        status: "success",
      }),
    });
    const filed = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-up/disputes",
      payload: disputePayload({ disputerId: "composer-up" }),
    });
    const disputeId = filed.json().dispute.disputeId;

    const res = await app.inject({
      method: "POST",
      url: `/api/disputes/${disputeId}/resolve`,
      payload: { resolverId: "arbiter-1", decision: "upheld", resolutionNote: "evidence confirmed bad" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dispute.status).toBe("upheld");
    expect(
      body.deltasApplied.some(
        (d: { reason: string; delta: number }) =>
          d.reason === "dispute_upheld" && d.delta === -50,
      ),
    ).toBe(true);

    const rep = await app.inject({ method: "GET", url: "/api/reputation/operator-up" });
    expect(rep.json().reputation.score).toBe(450);
  });

  it("13. resolving a dispute as rejected applies +5 to agent and -5 to disputer (200)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-rej/step-outcome",
      payload: stepOutcomePayload({
        compositionId: "comp-rej",
        agentId: "operator-rej",
        status: "success",
      }),
    });
    const filed = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-rej/disputes",
      payload: disputePayload({ disputerId: "composer-rej" }),
    });
    const disputeId = filed.json().dispute.disputeId;

    const res = await app.inject({
      method: "POST",
      url: `/api/disputes/${disputeId}/resolve`,
      payload: { resolverId: "arbiter-1", decision: "rejected", resolutionNote: "dispute was baseless" },
    });
    expect(res.statusCode).toBe(200);

    const agentRep = await app.inject({ method: "GET", url: "/api/reputation/operator-rej" });
    expect(agentRep.json().reputation.score).toBe(505);
    const disputerRep = await app.inject({ method: "GET", url: "/api/reputation/composer-rej" });
    expect(disputerRep.json().reputation.score).toBe(495);
  });

  it("14. rejects resolving an already-resolved dispute (409)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-twice/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-twice", status: "success" }),
    });
    const filed = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-twice/disputes",
      payload: disputePayload(),
    });
    const disputeId = filed.json().dispute.disputeId;
    await app.inject({
      method: "POST",
      url: `/api/disputes/${disputeId}/resolve`,
      payload: { resolverId: "arbiter-1", decision: "upheld", resolutionNote: "first resolution" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/disputes/${disputeId}/resolve`,
      payload: { resolverId: "arbiter-1", decision: "rejected", resolutionNote: "second attempt" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("dispute_not_pending");
  });

  // ── POST /api/compositions/:id/finalize-reputation ─────────────────────

  it("15. finalize applies success +10 / failed -15 to each step's agent", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-fin/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-fin", stepIndex: 0, agentId: "agent-ok", status: "success" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-fin/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-fin", stepIndex: 1, agentId: "agent-bad", status: "failed" }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-fin/finalize-reputation",
      payload: { finalizerId: "engine-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stepsFinalized).toBe(2);

    const ok = await app.inject({ method: "GET", url: "/api/reputation/agent-ok" });
    expect(ok.json().reputation.score).toBe(510);
    const bad = await app.inject({ method: "GET", url: "/api/reputation/agent-bad" });
    expect(bad.json().reputation.score).toBe(485);
  });

  it("16. finalize is idempotent — a second call applies no new deltas", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-idem2/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-idem2", stepIndex: 0, agentId: "agent-a", status: "success" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-idem2/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-idem2", stepIndex: 1, agentId: "agent-b", status: "failed" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-idem2/finalize-reputation",
      payload: { finalizerId: "engine-1" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-idem2/finalize-reputation",
      payload: { finalizerId: "engine-1" },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.stepsFinalized).toBe(0);
    expect(body.deltasApplied).toEqual([]);

    const a = await app.inject({ method: "GET", url: "/api/reputation/agent-a" });
    expect(a.json().reputation.score).toBe(510);
    const b = await app.inject({ method: "GET", url: "/api/reputation/agent-b" });
    expect(b.json().reputation.score).toBe(485);
  });

  it("17. finalize applies composition_completed +5 bonus to ALL participants when every step succeeds", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-bonus/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-bonus", stepIndex: 0, agentId: "agent-x", status: "success" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-bonus/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-bonus", stepIndex: 1, agentId: "agent-y", status: "success" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-bonus/finalize-reputation",
      payload: { finalizerId: "engine-1" },
    });
    // each: +10 step_completed, +5 composition_completed = +15
    const x = await app.inject({ method: "GET", url: "/api/reputation/agent-x" });
    expect(x.json().reputation.score).toBe(515);
    const y = await app.inject({ method: "GET", url: "/api/reputation/agent-y" });
    expect(y.json().reputation.score).toBe(515);
  });

  it("18. finalize skips disputed/pending outcomes (those wait for dispute resolution)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-skip/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-skip", stepIndex: 0, agentId: "agent-done", status: "success" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-skip/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-skip", stepIndex: 1, agentId: "agent-contested", status: "success" }),
    });
    // Dispute step 1 -> flips it to 'disputed'
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-skip/disputes",
      payload: disputePayload({ stepIndex: 1 }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-skip/finalize-reputation",
      payload: { finalizerId: "engine-1" },
    });
    expect(res.json().stepsFinalized).toBe(1);

    const done = await app.inject({ method: "GET", url: "/api/reputation/agent-done" });
    expect(done.json().reputation.score).toBe(510);
    // contested step skipped — no immediate delta, neutral 500
    const contested = await app.inject({ method: "GET", url: "/api/reputation/agent-contested" });
    expect(contested.json().reputation.score).toBe(500);
  });

  // ── Clamping ───────────────────────────────────────────────────────────

  it("19. clamps reputation score to [0, 1000]", () => {
    // fresh agent starts at 500; -200 -> 300 (in range)
    applyDelta("clamp-low", -200, "manual_adjustment");
    expect(getOrInitReputation("clamp-low").score).toBe(300);
    // push below zero -> clamps at 0 (not -200)
    applyDelta("clamp-low", -500, "manual_adjustment");
    expect(getOrInitReputation("clamp-low").score).toBe(0);
    // fresh agent +1000 -> 1500 -> clamps at 1000
    applyDelta("clamp-high", 1000, "manual_adjustment");
    expect(getOrInitReputation("clamp-high").score).toBe(1000);
  });

  // ── GET /api/reputation/leaderboard ────────────────────────────────────

  it("20. leaderboard returns agents descending by score and supports ?kind= filter", async () => {
    _seedReputationForTests(repFixture({ agentId: "lb-high", kind: "operator-kernel", score: 900 }));
    _seedReputationForTests(repFixture({ agentId: "lb-mid", kind: "human-skill", score: 600 }));
    _seedReputationForTests(repFixture({ agentId: "lb-low", kind: "operator-kernel", score: 300 }));

    const all = await app.inject({ method: "GET", url: "/api/reputation/leaderboard" });
    expect(all.statusCode).toBe(200);
    expect(all.json().agents.map((a: { agentId: string }) => a.agentId)).toEqual([
      "lb-high",
      "lb-mid",
      "lb-low",
    ]);

    const filtered = await app.inject({
      method: "GET",
      url: "/api/reputation/leaderboard?kind=operator-kernel",
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().agents.map((a: { agentId: string }) => a.agentId)).toEqual([
      "lb-high",
      "lb-low",
    ]);
  });

  // ── Extra coverage ─────────────────────────────────────────────────────

  it("21. resolving an unknown dispute returns 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/disputes/00000000-0000-0000-0000-000000000000/resolve",
      payload: { resolverId: "arbiter-1", decision: "upheld", resolutionNote: "n/a" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("dispute_not_found");
  });

  it("22. lists filed disputes for a composition", async () => {
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-list/step-outcome",
      payload: stepOutcomePayload({ compositionId: "comp-list", status: "success" }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-list/disputes",
      payload: disputePayload(),
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/compositions/comp-list/disputes",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.disputes[0].compositionId).toBe("comp-list");
    expect(body.disputes[0].status).toBe("pending");
  });

  // ── Exported helpers (recordStepOutcome / finalizeReputation) ──────────

  it("23. recordStepOutcome + finalizeReputation helpers match their HTTP routes", async () => {
    // ── direct helper path ──
    recordStepOutcome({
      compositionId: "comp-direct",
      stepIndex: 0,
      capabilityId: "cap-a",
      agentId: "agent-direct-0",
      status: "success",
      startedAt: "2026-06-11T10:00:00.000Z",
    });
    recordStepOutcome({
      compositionId: "comp-direct",
      stepIndex: 1,
      capabilityId: "cap-b",
      agentId: "agent-direct-1",
      status: "failed",
      startedAt: "2026-06-11T10:00:00.000Z",
    });
    const directDeltas = finalizeReputation("comp-direct", "engine-direct");

    // ── equivalent HTTP path ──
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-http/step-outcome",
      payload: stepOutcomePayload({
        compositionId: "comp-http",
        stepIndex: 0,
        capabilityId: "cap-a",
        agentId: "agent-http-0",
        status: "success",
      }),
    });
    await app.inject({
      method: "POST",
      url: "/api/compositions/comp-http/step-outcome",
      payload: stepOutcomePayload({
        compositionId: "comp-http",
        stepIndex: 1,
        capabilityId: "cap-b",
        agentId: "agent-http-1",
        status: "failed",
      }),
    });
    const httpResp = await app.inject({
      method: "POST",
      url: "/api/compositions/comp-http/finalize-reputation",
      payload: { finalizerId: "engine-http" },
    });
    const httpBody = httpResp.json();

    // identical delta reasons + step accounting (success +10 / failed -15, no bonus)
    expect(directDeltas.map((d) => d.reason).sort()).toEqual(
      httpBody.deltasApplied.map((d: { reason: string }) => d.reason).sort(),
    );
    expect(directDeltas.filter((d) => d.reason === "step_completed")).toHaveLength(1);
    expect(directDeltas.filter((d) => d.reason === "step_failed")).toHaveLength(1);
    expect(httpBody.stepsFinalized).toBe(2);

    // identical resulting scores
    expect(getOrInitReputation("agent-direct-0").score).toBe(510);
    expect(getOrInitReputation("agent-direct-1").score).toBe(485);
    expect(getOrInitReputation("agent-http-0").score).toBe(510);
    expect(getOrInitReputation("agent-http-1").score).toBe(485);
  });

  it("24. helper-applied state is consistent when read back through HTTP GETs", async () => {
    recordStepOutcome({
      compositionId: "comp-cross",
      stepIndex: 0,
      capabilityId: "cap-x",
      agentId: "agent-cross",
      status: "success",
      startedAt: "2026-06-11T10:00:00.000Z",
    });
    const deltas = finalizeReputation("comp-cross", "engine-cross");
    expect(deltas.length).toBeGreaterThan(0);

    // reputation visible via HTTP — single all-success step: +10 + +5 bonus
    const rep = await app.inject({ method: "GET", url: "/api/reputation/agent-cross" });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().reputation.score).toBe(515);
    expect(
      rep.json().recentDeltas.map((d: { reason: string }) => d.reason).sort(),
    ).toEqual(["composition_completed", "step_completed"]);

    // the helper-created outcome is now finalized + visible via HTTP
    const outc = await app.inject({
      method: "GET",
      url: "/api/compositions/comp-cross/step-outcomes",
    });
    expect(outc.json().count).toBe(1);
    expect(outc.json().outcomes[0].agentId).toBe("agent-cross");
    expect(outc.json().outcomes[0].finalReputationApplied).toBe(true);
  });
});
