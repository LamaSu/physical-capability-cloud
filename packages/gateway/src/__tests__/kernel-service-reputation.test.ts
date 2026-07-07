/**
 * Runtime coverage for the LOCAL completion path's reputation settle in
 * `KernelService.submitJob` (kernel-service.ts).
 *
 * The settle seam itself is unit-tested in reputation-completion.test.ts, and
 * the EXTERNAL path is covered in paid-job-flow-reputation.test.ts. This file
 * closes the remaining gap the seam's wiring had on the LOCAL path: a local job
 * that SUCCEEDS but produced NO in-memory evidence bundle used to leave its
 * composition step outcome `pending` forever, because the success settle was
 * trapped inside the `if (bundle)` guard after processEvidence. The fix moves
 * the success settle out to fire on ANY successful local completion (mirroring
 * the already-unconditional failure settle), inert for non-composition jobs.
 *
 * We drive the REAL fire-and-forget local runner path with a stub runner that
 * resolves `{ success: true }` WITHOUT emitting an evidence bundle — so the
 * service never captures a `completedBundle` for the job (the exact caveat
 * precondition) — and assert the in-memory ledger is still credited end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initStore, closeStore, getRepos } from "../db.js";
import {
  initKernelService,
  resetKernelService,
  getKernelService,
} from "../services/kernel-service.js";
import {
  recordStepOutcome,
  getOrInitReputation,
  _clearReputationForTests,
} from "../routes/reputation.js";
import type { KernelConfig } from "@pcc/kernel";

const STARTED_AT = "2026-07-06T10:00:00.000Z";

const mockConfig: KernelConfig = {
  kernelId: "kernel-repcredit-001",
  mockMode: true,
  devices: [
    {
      id: "dev-test-machine",
      type: "machine",
      adapterType: "mock",
      config: { kernelId: "kernel-repcredit-001", jobDurationMs: 20 },
    },
  ],
};

/**
 * Stub JobRunner: resolves success WITHOUT emitting any evidence bundle, so the
 * KernelService's emitter never populates `completedBundles` for the job — the
 * exact "success with no in-memory bundle" precondition of the caveat.
 */
function makeNoBundleRunner(bundleId?: string) {
  return {
    run: vi.fn(async () => ({ success: true, bundleId, error: undefined })),
  };
}

/** Access the private KernelService maps (same cast pattern as kernel-service-preflight.test.ts). */
function internals(svc: unknown) {
  return svc as unknown as {
    runners: Map<string, unknown>;
    completedBundles: Map<string, unknown>;
  };
}

/** Poll the ledger until the fire-and-forget completion has settled (or time out). */
async function waitForScore(agentId: string, target: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (getOrInitReputation(agentId).score === target) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("KernelService local completion — reputation settle without in-memory bundle", () => {
  beforeEach(() => {
    process.env.PCC_DB_PATH = ":memory:";
    // Deferral/pending recording is a compose-loop concern; the settle seam
    // itself is mode-independent. Ensure a clean env for the local path.
    delete process.env.PCC_COMPOSE_EXECUTE_REAL;
    initStore({ seed: true });
    resetKernelService();
    initKernelService(mockConfig);
    _clearReputationForTests();
  });

  afterEach(() => {
    resetKernelService();
    closeStore();
    vi.restoreAllMocks();
  });

  it("credits the step (+10, +5 bonus) on local success even when NO in-memory bundle was captured", async () => {
    const svc = getKernelService();
    const io = internals(svc);

    // Replace the device's runner with one that succeeds but emits NO bundle.
    io.runners.set("dev-test-machine", makeNoBundleRunner("bundle-local-x"));

    // A 1-step composition: record its pending outcome and bridge job-001 → step 0
    // via the same `parameters.__pccStep` carrier the real compose loop writes.
    const compositionId = "comp-local-ok";
    recordStepOutcome({
      compositionId,
      stepIndex: 0,
      capabilityId: "cap-nyc-fdm",
      agentId: "op-local",
      status: "pending",
      startedAt: STARTED_AT,
    });
    getRepos().jobs.update("job-001", {
      parameters: { __pccStep: { compositionId, stepIndex: 0 } },
    });

    // Ack side: pending recorded, no delta applied yet.
    expect(getOrInitReputation("op-local").score).toBe(500);

    const res = await svc.submitJob({
      jobId: "job-001",
      stepId: "step-local",
      deviceId: "dev-test-machine",
      assuranceTier: 0,
    });
    expect(res.status).toBe("accepted");

    // Wait for the fire-and-forget completion to run the settle.
    await waitForScore("op-local", 515);

    // The precondition really held: no in-memory bundle was ever captured, so
    // the pre-fix code would have skipped the settle and left the step pending.
    expect(io.completedBundles.has("job-001")).toBe(false);

    // 1-step all-success composition credited at completion = +10 step
    // + 5 composition bonus → 515 across two positive deltas. That the bonus
    // paid at all proves the pending outcome flipped to success (finalize only
    // pays the bonus when every outcome is `success`).
    const rep = getOrInitReputation("op-local");
    expect(rep.score).toBe(515);
    expect(rep.positiveContributions).toBe(2);
  });
});
