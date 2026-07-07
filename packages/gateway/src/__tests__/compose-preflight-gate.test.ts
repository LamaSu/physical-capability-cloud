/**
 * Composition-level resource pre-flight gate (R3) — end-to-end proof.
 *
 * These are the "teeth": they exercise the whole-plan gate through the real
 * `MockFDMAdapter` leaf (unchanged) and assert it refuses an infeasible composed
 * job BEFORE step 1 runs or escrows — the property that keeps R3 useful.
 *
 * Field-kit scenario (mirrors the spec): a single FDM printer with a 720 g
 * spool is shared by two print steps of a 3-step plan — step 0 needs 336 g and
 * step 2 needs 610 g. Each is feasible ALONE, but 946 g together exceeds the
 * spool. The gate holds step 0's 336 g, then finds step 2 infeasible (only 384 g
 * free), rolls the hold back, and refuses the whole composition with HTTP 409.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  composeRoutes,
  executeComposition,
  _clearComposeForTests,
  _registerCandidateForTests,
  _setStepRunnerForTests,
  _setPreflightResolverForTests,
  _getExecutionForTests,
  type PreflightResolver,
} from "../routes/compose.js";
import {
  reputationRoutes,
  _clearReputationForTests,
} from "../routes/reputation.js";
import { MockFDMAdapter } from "@pcc/kernel";
import type { CompositionCandidate, ComposeResponse } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Harness — mirrors compose.test.ts (app + candidate + reputation read-back).
// ---------------------------------------------------------------------------

/** App with compose + reputation routes so tests can read reputation over HTTP. */
function makeApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  void app.register(composeRoutes);
  void app.register(reputationRoutes);
  return app;
}

/** Candidate with an optional resourceRequirements declaration. */
function makeCandidate(
  partial: Partial<CompositionCandidate> & { capabilityId: string },
): CompositionCandidate {
  return {
    capabilityId: partial.capabilityId,
    kernelId: partial.kernelId ?? `k_${partial.capabilityId}`,
    operatorAddress: partial.operatorAddress ?? `op_${partial.capabilityId}`,
    capabilityType: partial.capabilityType ?? "3d-printing",
    estimatedPriceUSD: partial.estimatedPriceUSD ?? 10,
    estimatedDurationMs: partial.estimatedDurationMs ?? 60_000,
    assuranceTier: partial.assuranceTier ?? 1,
    reputation: partial.reputation,
    location: partial.location,
    available: partial.available ?? true,
    resourceRequirements: partial.resourceRequirements,
  };
}

/** A MockFDMAdapter seeded with a specific filament spool size. */
function makeFdm(id: string, spoolGrams: number): MockFDMAdapter {
  return new MockFDMAdapter(id, `kernel-${id}`, 10_000, {
    filamentGrams: {
      available: spoolGrams,
      bounds: { min: 1, max: spoolGrams, unit: "g" },
    },
  });
}

/**
 * Resolver over MockFDMAdapter instances keyed by the step's capabilityId.
 * Binds the adapter's real preflight/commit/rollback — the reused leaf drives
 * the gate end-to-end (no test double).
 */
function makeResolver(byCapId: Record<string, MockFDMAdapter>): PreflightResolver {
  return {
    resolve(step) {
      const adapter = byCapId[step.capabilityId];
      if (!adapter) return null;
      return {
        preflight: (req) => adapter.preflight!(req),
        commit: (id) => adapter.commitReservation!(id),
        rollback: (id) => adapter.rollbackReservation!(id),
      };
    },
  };
}

/**
 * Read the adapter's live 2-phase ledger to assert real capacity accounting.
 * `resources` is a runtime property of MockFDMAdapter (TS-private only) — this
 * reads its actual ResourceTracker, proving nothing was consumed/committed
 * beyond what the gate intended. The leaf itself stays byte-for-byte unchanged.
 */
function ledger(a: MockFDMAdapter): {
  availableFor(r: string): number;
  pendingCount(): number;
} {
  return (a as unknown as {
    resources: { availableFor(r: string): number; pendingCount(): number };
  }).resources;
}

async function propose(
  app: FastifyInstance,
  steps: string[],
  outcomeType = steps[steps.length - 1]!,
): Promise<ComposeResponse> {
  const prop = await app.inject({
    method: "POST",
    url: "/api/compose",
    payload: { outcomeType, steps, budgetUSD: 100, minAssuranceTier: 1 },
  });
  expect(prop.json().status).toBe("proposed");
  const id = prop.json().compositionId as string;
  const got = await app.inject({ method: "GET", url: `/api/compose/${id}` });
  return got.json() as ComposeResponse;
}

beforeEach(() => {
  _clearComposeForTests();
  _clearReputationForTests();
});

// ---------------------------------------------------------------------------
// 1. Infeasible step ⇒ whole job refused BEFORE any step runs or escrows.
// ---------------------------------------------------------------------------

describe("POST /api/compose/:id/execute — whole-plan preflight gate refuses infeasible plans", () => {
  it("refuses the whole composition (409) before any step runs when a later step is infeasible", async () => {
    // Field-kit plan: two prints share one 720 g spool; 336 + 610 = 946 > 720.
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-print-a",
        capabilityType: "print-a",
        operatorAddress: "op-a",
        resourceRequirements: { filamentGrams: 336 },
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-inspect",
        capabilityType: "inspect",
        operatorAddress: "op-inspect",
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-print-b",
        capabilityType: "print-b",
        operatorAddress: "op-b",
        resourceRequirements: { filamentGrams: 610 },
      }),
    );

    const fdm = makeFdm("fdm-shared", 720); // one spool, two print steps
    _setPreflightResolverForTests(
      makeResolver({ "cap-print-a": fdm, "cap-print-b": fdm }),
    );

    // Spy the step runner — it must NEVER be called (the gate precedes step 1).
    const runner = vi.fn();
    _setStepRunnerForTests(runner);

    const app = makeApp();
    const composition = await propose(app, ["print-a", "inspect", "print-b"]);
    const id = composition.compositionId;

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });

    // 409 with the typed refusal body.
    expect(exec.statusCode).toBe(409);
    const body = exec.json();
    expect(body.error).toBe("composition_preflight_refused");
    expect(body.failedStepIndex).toBe(2);
    expect(body.capabilityId).toBe("cap-print-b");
    expect(body.refusal.code).toBe("insufficient_resource");
    expect(body.refusal.details.resource).toBe("filamentGrams");

    // No step executed.
    expect(runner).not.toHaveBeenCalled();

    // No execution row saved.
    expect(_getExecutionForTests(id)).toBeUndefined();

    // No reputation delta landed on any participant.
    for (const op of ["op-a", "op-inspect", "op-b"]) {
      const rep = await app.inject({ method: "GET", url: `/api/reputation/${op}` });
      expect(rep.json().reputation.score).toBe(500);
    }

    // Composition stays "proposed" — re-planable/re-executable later.
    const got = await app.inject({ method: "GET", url: `/api/compose/${id}` });
    expect(got.json().status).toBe("proposed");

    // Every hold rolled back — full spool restored, no pending reservations.
    expect(ledger(fdm).availableFor("filamentGrams")).toBe(720);
    expect(ledger(fdm).pendingCount()).toBe(0);
  });

  it("re-executing after a refusal 409s again (proves no execution row was persisted)", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-xl",
        capabilityType: "print-xl",
        operatorAddress: "op-xl",
        resourceRequirements: { filamentGrams: 900 }, // > spool
      }),
    );
    const fdm = makeFdm("fdm-1", 720);
    _setPreflightResolverForTests(makeResolver({ "cap-xl": fdm }));

    const app = makeApp();
    const composition = await propose(app, ["print-xl"]);
    const id = composition.compositionId;

    const first = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });
    expect(first.statusCode).toBe(409);
    // 900 exceeds the calibrated max (720) → out_of_calibrated_range.
    expect(first.json().refusal.code).toBe("out_of_calibrated_range");
    expect(first.json().failedStepIndex).toBe(0);

    // A stored execution row would replay as 202; instead the gate refuses anew.
    const second = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(ledger(fdm).pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Fully-feasible plan passes, executes, and commits per-step holds.
// ---------------------------------------------------------------------------

describe("POST /api/compose/:id/execute — whole-plan preflight gate passes feasible plans", () => {
  it("runs a feasible plan to completion and commits each step's hold", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-a",
        capabilityType: "print-a",
        operatorAddress: "op-a",
        resourceRequirements: { filamentGrams: 200 },
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-b",
        capabilityType: "print-b",
        operatorAddress: "op-b",
        resourceRequirements: { filamentGrams: 300 },
      }),
    );

    const fdm = makeFdm("fdm-shared", 720); // 200 + 300 = 500 <= 720
    _setPreflightResolverForTests(
      makeResolver({ "cap-a": fdm, "cap-b": fdm }),
    );

    const runner = vi.fn();
    _setStepRunnerForTests(runner);

    const app = makeApp();
    const composition = await propose(app, ["print-a", "print-b"]);
    const id = composition.compositionId;

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${id}/execute`,
      payload: {},
    });

    expect(exec.statusCode).toBe(202);
    expect(exec.json().status).toBe("completed");
    expect(exec.json().workflowId).toMatch(/^wf_/);

    // Both steps ran.
    expect(runner).toHaveBeenCalledTimes(2);

    // Execution row persisted.
    expect(_getExecutionForTests(id)?.status).toBe("completed");

    // Capacity permanently consumed by exactly the committed reservations.
    expect(ledger(fdm).availableFor("filamentGrams")).toBe(720 - 500);
    expect(ledger(fdm).pendingCount()).toBe(0);
  });

  it("commits holds across SEPARATE adapters, deducting each adapter's own tracker", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-p1",
        capabilityType: "print-1",
        operatorAddress: "op-p1",
        resourceRequirements: { filamentGrams: 400 },
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-p2",
        capabilityType: "print-2",
        operatorAddress: "op-p2",
        resourceRequirements: { filamentGrams: 250 },
      }),
    );

    const fdm1 = makeFdm("fdm-1", 720);
    const fdm2 = makeFdm("fdm-2", 500);
    _setPreflightResolverForTests(
      makeResolver({ "cap-p1": fdm1, "cap-p2": fdm2 }),
    );

    const app = makeApp();
    const composition = await propose(app, ["print-1", "print-2"]);

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${composition.compositionId}/execute`,
      payload: {},
    });
    expect(exec.json().status).toBe("completed");

    expect(ledger(fdm1).availableFor("filamentGrams")).toBe(720 - 400);
    expect(ledger(fdm2).availableFor("filamentGrams")).toBe(500 - 250);
    expect(ledger(fdm1).pendingCount()).toBe(0);
    expect(ledger(fdm2).pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Mid-run failure rolls back the failed + unreached holds (acceptance #4).
// ---------------------------------------------------------------------------

describe("executeComposition — mid-run failure rolls back holds correctly", () => {
  it("commits succeeded steps, rolls back the failed step + all unreached holds", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-0",
        capabilityType: "s0",
        operatorAddress: "op-0",
        resourceRequirements: { filamentGrams: 100 },
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-1",
        capabilityType: "s1",
        operatorAddress: "op-1",
        resourceRequirements: { filamentGrams: 150 },
      }),
    );
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-2",
        capabilityType: "s2",
        operatorAddress: "op-2",
        resourceRequirements: { filamentGrams: 200 },
      }),
    );

    const fdm = makeFdm("fdm-shared", 720); // 450 held, plenty of room
    const resolver = makeResolver({
      "cap-0": fdm,
      "cap-1": fdm,
      "cap-2": fdm,
    });

    const app = makeApp();
    const composition = await propose(app, ["s0", "s1", "s2"]);

    // Runner throws on the middle step; step 2 must never be reached.
    const result = await executeComposition(composition, {
      preflightResolver: resolver,
      runStep: (step) => {
        if (step.index === 1) throw new Error("mid-run boom");
      },
    });

    expect(result.status).toBe("failed");
    expect(result.failedStepIndex).toBe(1);
    expect(result.stepsExecuted).toBe(2); // s0 + s1 ran, s2 short-circuited

    // Only step 0's 100 g committed; step 1 (failed) + step 2 (unreached) rolled back.
    expect(ledger(fdm).availableFor("filamentGrams")).toBe(720 - 100);
    expect(ledger(fdm).pendingCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Backward compatibility — un-annotated steps skip the gate entirely.
// ---------------------------------------------------------------------------

describe("POST /api/compose/:id/execute — un-annotated steps skip the gate", () => {
  it("runs to completion and never consults the resolver when no step declares resources", async () => {
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "cap-x", capabilityType: "px", operatorAddress: "op-x" }),
    );
    _registerCandidateForTests(
      makeCandidate({ capabilityId: "cap-y", capabilityType: "py", operatorAddress: "op-y" }),
    );

    // A resolver that FAILS the test if it is ever consulted for an un-annotated
    // step (the gate must short-circuit on "no requirements" before resolving).
    const resolveSpy = vi.fn(() => null);
    _setPreflightResolverForTests({ resolve: resolveSpy });

    const app = makeApp();
    const composition = await propose(app, ["px", "py"]);

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${composition.compositionId}/execute`,
      payload: {},
    });

    expect(exec.statusCode).toBe(202);
    expect(exec.json().status).toBe("completed");
    // No step declared resourceRequirements → resolver never consulted.
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("with NO resolver at all, a resource-declaring plan still runs (gate is a no-op)", async () => {
    _registerCandidateForTests(
      makeCandidate({
        capabilityId: "cap-z",
        capabilityType: "pz",
        operatorAddress: "op-z",
        resourceRequirements: { filamentGrams: 999999 }, // would refuse IF checked
      }),
    );
    // Deliberately DO NOT set a resolver — default is the no-op gate.

    const app = makeApp();
    const composition = await propose(app, ["pz"]);

    const exec = await app.inject({
      method: "POST",
      url: `/api/compose/${composition.compositionId}/execute`,
      payload: {},
    });

    // No resolver ⇒ nothing is checked ⇒ existing behaviour (completes).
    expect(exec.statusCode).toBe(202);
    expect(exec.json().status).toBe("completed");
  });
});
