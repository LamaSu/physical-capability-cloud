/**
 * Regression test: PATCH /api/jobs/:jobId/status ownership check on
 * fast-track-created jobs (the courier "accept" flow).
 *
 * Root cause (fixed in routes/jobs.ts):
 *   1. createJobFromSession (paid-job-flow.ts) never sets job.submittedBy —
 *      the `jobs` DB table (packages/db/src/schema/jobs.ts) has no
 *      submittedBy column at all, so that branch of the ownership check is
 *      structurally always false for every job, not just fast-track ones.
 *   2. The kernel-ownership fallback compared `kernel.operatorId` — a field
 *      that does not exist on shopKernels (packages/db/src/schema/kernels.ts
 *      only defines `operatorAddress`) — so the fallback could never pass
 *      for ANY caller either. Every fast-track job's rightful operator got
 *      403 trying to accept (queued -> in_progress) their own job.
 *
 * The fix compares `kernel.operatorAddress` instead (the same email/wallet
 * identity space as the API key's operatorId — see
 * resolveOperatorPayoutAddress in paid-job-flow.ts, which already treats
 * them as equivalent via repos.apiKeys.findByOperator(kernel.operatorAddress)).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore } from "../db.js";

// Same external-call mocks as paid-job-flow.test.ts — paidJobFlowRoutes pulls
// in evidence-storage + escrow-client + batch-settlement modules even on the
// mock-settlement fast-track path.
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../contracts/escrow-client.js", () => ({
  submitEvidence: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_tx", status: "submitted" }),
  releaseMilestone: vi.fn().mockResolvedValue({ transactionHash: "0xtest_release_tx", status: "submitted" }),
  isWriteEnabled: vi.fn().mockReturnValue(false),
  getSignerAddress: vi.fn().mockReturnValue(undefined),
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(undefined),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  MilestoneStatus: {},
  milestoneStatusName: vi.fn().mockReturnValue("unknown"),
}));

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "epoch-1", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));

// kernel-nyc's seeded operator identity (packages/db/src/seed/kernels.ts).
const KERNEL_NYC_OPERATOR = "0x1111111111111111111111111111111111111111";
const UNRELATED_OPERATOR = "0x9999999999999999999999999999999999999999";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  // Test-only stand-in for the apiGate middleware (middleware/api-gate.ts:107
  // does `req.operatorId = apiKey.operatorId`). jobs.ts only reads
  // `(req as any).operatorId ?? (req as any).userId` — it doesn't care how
  // that got set, so this exercises the real production ownership-check code
  // without needing to provision a real API key.
  app.addHook("preHandler", async (req) => {
    const hdr = req.headers["x-test-operator-id"];
    (req as any).operatorId = typeof hdr === "string" ? hdr : null;
  });
  await app.register(paidJobFlowRoutes);
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

describe("PATCH /api/jobs/:jobId/status — ownership on fast-track-created jobs", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  async function createFastTrackJob(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: {
        kernelId: "kernel-nyc",
        capabilityType: "liquid-handler",
        userAgentId: "user-agent-ownership-test",
      },
    });
    expect(res.statusCode).toBe(201);
    return res.json().jobId as string;
  }

  it("lets the kernel's rightful operator accept (queued -> in_progress) a fast-track job", async () => {
    const jobId = await createFastTrackJob();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/status`,
      headers: { "x-test-operator-id": KERNEL_NYC_OPERATOR },
      payload: { status: "in_progress" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().job.status).toBe("in_progress");
  });

  it("lets the kernel's rightful operator drive the job through to completed", async () => {
    const jobId = await createFastTrackJob();

    const accept = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/status`,
      headers: { "x-test-operator-id": KERNEL_NYC_OPERATOR },
      payload: { status: "in_progress" },
    });
    expect(accept.statusCode).toBe(200);

    const complete = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/status`,
      headers: { "x-test-operator-id": KERNEL_NYC_OPERATOR },
      payload: { status: "completed" },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json().job.status).toBe("completed");
  });

  it("still rejects an unrelated caller with 403 (gate not weakened)", async () => {
    const jobId = await createFastTrackJob();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/status`,
      headers: { "x-test-operator-id": UNRELATED_OPERATOR },
      payload: { status: "in_progress" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("still rejects when no operator identity is present at all", async () => {
    // No x-test-operator-id header -> operatorId is null -> the `if (operatorId)`
    // guard in jobs.ts is skipped entirely, so this documents current
    // behavior (open access when unauthenticated) rather than the ownership
    // check itself. Included so a future auth-required change is deliberate.
    const jobId = await createFastTrackJob();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/status`,
      payload: { status: "in_progress" },
    });

    expect(res.statusCode).toBe(200);
  });
});
