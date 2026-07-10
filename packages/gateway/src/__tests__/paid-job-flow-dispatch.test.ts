/**
 * SEAM-1 regression: remote-kernel job dispatch routing.
 *
 * createJobFromSession() picks a job's initial status from `isExternal`:
 *   external -> "queued"   (a remote operator node polls
 *                           GET /api/operator/jobs?status=queued and runs it)
 *   local    -> mock ? "active" : "pending"   (gateway's own in-process kernel)
 *
 * The bug (SEAM-1): a production control-plane gateway has NO local kernel, so
 * getKernelService() throws -> localKernelId === undefined. The old expression
 * `!!localKernelId && session.kernelId !== localKernelId` then evaluated to
 * `false` (treated as LOCAL), stamping every remote job "pending" — a status no
 * operator daemon polls. A stranger's paid job was escrowed and then stranded,
 * never dispatched.
 *
 * The fix treats "not our own kernel" as external:
 *   isExternal = !(localKernelId && session.kernelId === localKernelId)
 *
 * NOTE: these tests live in their OWN file (not paid-job-flow.test.ts) on
 * purpose — that file is currently excluded from the vitest run (a pending
 * facade-rewrite reconciliation, see vitest.config.ts). This money-path gate
 * must actually run in CI, so it goes in a non-excluded file.
 *
 * ALL external calls (IPFS, blockchain) are mocked. No real network traffic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { ot2RelayRoutes } from "../routes/ot2-relay.js";
import { ot2ScopeRoutes } from "../routes/ot2-scope.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { getKernelService } from "../services/kernel-service.js";

// ---------------------------------------------------------------------------
// Mocks — mirror paid-job-flow.test.ts so the fast-track route runs hermetically.
// ---------------------------------------------------------------------------

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

// getKernelService() is the ONLY thing createJobFromSession consults to decide
// local vs remote. Keep every other real export intact; only override this one
// so each test controls whether the gateway "owns" the target kernel.
vi.mock("../services/kernel-service.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/kernel-service.js")>();
  return {
    ...actual,
    getKernelService: vi.fn(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    }),
  };
});

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });

  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(ot2RelayRoutes);
  await app.register(ot2ScopeRoutes);
  await app.register(jobRoutes);
  await app.ready();
  return app;
}

/** Submit a fast-track job for `kernelId` and return the created DB job row. */
async function submitJob(app: FastifyInstance, kernelId: string, userAgentId: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId, capabilityType: "liquid-handler", userAgentId },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  const job = getRepos().jobs.findById(body.jobId);
  expect(job).toBeDefined();
  return job!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SEAM-1: remote-kernel job dispatch routing", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default: no initialised local kernel (a production control-plane gateway).
    // getKernelService() throws, so createJobFromSession sees localKernelId
    // undefined and must treat the job as bound for a REMOTE operator node.
    vi.mocked(getKernelService).mockImplementation(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("dispatches a job as 'queued' when the gateway has NO local kernel (remote node picks it up)", async () => {
    // This is the SEAM-1 money-path bug: pre-fix this job was "pending",
    // invisible to the operator daemon that polls ?status=queued.
    const job = await submitJob(app, "kernel-nyc", "user-seam1-nolocal");
    expect(job.status).toBe("queued");
    expect(job.status).not.toBe("pending");
  });

  it("dispatches a job as 'queued' when kernelId differs from the gateway's own kernel", async () => {
    // Gateway owns "kernel-home" in-process; the job targets a different kernel.
    vi.mocked(getKernelService).mockReturnValue({ config: { kernelId: "kernel-home" } } as any);

    const job = await submitJob(app, "kernel-nyc", "user-seam1-different");
    expect(job.status).toBe("queued");
  });

  it("keeps a gateway-local job 'active' in mock settlement (gateway owns the kernel — OT-2/pizza in-process demo)", async () => {
    // Gateway owns kernel-nyc in-process AND the job targets it -> local path.
    // This must NOT regress: the in-process demos rely on immediate "active".
    vi.mocked(getKernelService).mockReturnValue({ config: { kernelId: "kernel-nyc" } } as any);

    const job = await submitJob(app, "kernel-nyc", "user-seam1-local");
    expect(job.status).toBe("active");
  });
});
