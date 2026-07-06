/**
 * Completion-driven reputation settle tests — `settleStepReputationForJob`.
 *
 * Covers the "credit at completion, not ack" seam that the physical-completion
 * paths (local kernel-service, external paid-job-flow) call once a job's real
 * outcome is known:
 *   - success credits +10 at completion; last all-success completion pays the
 *     one-time composition +5 bonus (idempotent on re-invoke);
 *   - ack-then-fail debits -15 with NO positive credit ever (deferral means the
 *     +10 was never applied at ack, so nothing to reverse);
 *   - inert for single (non-composition) jobs and unknown jobIds.
 *
 * A seeded in-memory store supplies FK-valid jobs (job-001 / job-004 →
 * cap-nyc-fdm); the (compositionId, stepIndex) bridge is threaded onto each
 * job's `parameters.__pccStep`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initStore, closeStore, getRepos } from "../db.js";
import {
  settleStepReputationForJob,
  recordStepOutcome,
  getOrInitReputation,
  _clearReputationForTests,
} from "../routes/reputation.js";

const STARTED_AT = "2026-07-06T10:00:00.000Z";

/** Record a `pending` step outcome for (compositionId, stepIndex) → agentId. */
function recordPending(
  compositionId: string,
  stepIndex: number,
  agentId: string,
): void {
  recordStepOutcome({
    compositionId,
    stepIndex,
    capabilityId: "cap-nyc-fdm",
    agentId,
    status: "pending",
    startedAt: STARTED_AT,
  });
}

/** Thread the (compositionId, stepIndex) bridge onto a seeded job row. */
function linkJobToStep(jobId: string, compositionId: string, stepIndex: number): void {
  getRepos().jobs.update(jobId, {
    parameters: { __pccStep: { compositionId, stepIndex } },
  });
}

describe("settleStepReputationForJob — credit at completion", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    _clearReputationForTests();
  });

  afterEach(() => {
    closeStore();
  });

  it("credits +10 at completion (not ack) and pays the +5 bonus once on the last success", () => {
    const compositionId = "comp-credit";
    recordPending(compositionId, 0, "op-a");
    recordPending(compositionId, 1, "op-b");
    linkJobToStep("job-001", compositionId, 0);
    linkJobToStep("job-004", compositionId, 1);

    // Ack side: pending recorded, no deltas applied yet.
    expect(getOrInitReputation("op-a").score).toBe(500);
    expect(getOrInitReputation("op-b").score).toBe(500);

    // Complete step 0 → +10 to op-a; bonus withheld (step 1 still pending).
    const d0 = settleStepReputationForJob("job-001", "success");
    expect(getOrInitReputation("op-a").score).toBe(510);
    expect(d0.some((d) => d.reason === "step_completed")).toBe(true);
    expect(d0.some((d) => d.reason === "composition_completed")).toBe(false);

    // Complete step 1 → +10 to op-b AND the one-time +5 bonus to both.
    const d1 = settleStepReputationForJob("job-004", "success");
    expect(getOrInitReputation("op-b").score).toBe(515); // +10 +5
    expect(getOrInitReputation("op-a").score).toBe(515); // +5 bonus
    expect(d1.filter((d) => d.reason === "composition_completed").length).toBe(2);

    // Idempotent: re-invoking a settled job applies nothing.
    const again = settleStepReputationForJob("job-001", "success");
    expect(again).toEqual([]);
    expect(getOrInitReputation("op-a").score).toBe(515);
    expect(getOrInitReputation("op-b").score).toBe(515);
  });

  it("ack-then-fail debits -15 and never records a positive step_completed credit", () => {
    const compositionId = "comp-fail";
    recordPending(compositionId, 0, "op-x");
    linkJobToStep("job-001", compositionId, 0);

    // Pending: no delta applied at ack.
    expect(getOrInitReputation("op-x").score).toBe(500);

    const d = settleStepReputationForJob("job-001", "failed");
    expect(getOrInitReputation("op-x").score).toBe(485); // -15
    expect(d.some((x) => x.reason === "step_failed")).toBe(true);
    expect(d.some((x) => x.reason === "step_completed")).toBe(false);

    // No positive credit ever — the +10 was never applied at ack (deferral).
    const rep = getOrInitReputation("op-x");
    expect(rep.positiveContributions).toBe(0);
    expect(rep.negativeContributions).toBe(1);
  });

  it("is inert for a single (non-composition) job — no __pccStep bridge", () => {
    // job-002 is seeded without a __pccStep bridge.
    const applied = settleStepReputationForJob("job-002", "success");
    expect(applied).toEqual([]);
  });

  it("is inert for an unknown jobId", () => {
    const applied = settleStepReputationForJob("job-does-not-exist", "success");
    expect(applied).toEqual([]);
  });
});
