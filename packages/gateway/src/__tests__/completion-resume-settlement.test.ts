/**
 * Controlled recovery of a trapped completion (finding #2 / A-2).
 *
 * P1 widened the /complete claim guard to reject 'evidence_submitted', which
 * closed the double-settle hole but created a trap: a failure AFTER the evidence
 * bundle is written (oracle throw / verified:false / crash) leaves the job at
 * 'evidence_submitted', and every /complete retry then 409s forever — funds
 * app-layer stuck with no recovery.
 *
 * POST /api/jobs/:jobId/resume-settlement is the controlled recovery: it RESUMES
 * settlement (oracle gate + settle) reusing the EXISTING evidence bundle, never
 * rebuilding evidence and never creating a second bundle. Single-winner is kept
 * by the same atomic CAS pattern.
 *
 * The trapped state is reconstructed directly (a fast-track job + one evidence
 * bundle + status forced to 'evidence_submitted') — the exact durable state a
 * mid-completion failure leaves behind.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { initStore, closeStore, getRepos } from "../db.js";

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
  submitEvidenceV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_evidence_v2" }),
  submitAttestationV2: vi.fn().mockResolvedValue({ transactionHash: "0xtest_attest_v2" }),
  getMilestoneV2: vi.fn().mockResolvedValue({ stepId: "0xstep" }),
  resolveMockUSDCAddress: vi.fn().mockReturnValue("0x6c7ce5d5decee9983feaa3e637ea3fe3e6945cdb"),
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

const KERNEL = "kernel-biolab-01";
const CAP = "liquid-handler";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.ready();
  return app;
}

describe("resume-settlement recovers a trapped completion (finding #2 / A-2)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  /**
   * Reconstruct the exact durable state a mid-completion failure leaves: a job +
   * escrow (fast-track), one evidence bundle, and status forced to
   * 'evidence_submitted' (as /complete writes right before the oracle step).
   */
  async function makeTrappedJob(agent: string): Promise<{ jobId: string; escrowId: string; bundleId: string }> {
    const ft = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: KERNEL, capabilityType: CAP, userAgentId: agent },
    });
    expect(ft.statusCode).toBe(201);
    const jobId = ft.json().jobId as string;
    const escrowId = ft.json().escrowId as string;

    const repos = getRepos();
    const job = repos.jobs.findById(jobId)!;
    const bundleId = `bundle-trap-${agent}`;
    repos.evidence.insert({
      id: bundleId,
      jobId,
      stepId: job.stepId,
      kernelId: job.kernelId,
      assuranceTier: 0,
      bundleHash: "sha256:trapped-evidence",
      kernelSignature: { signer: "0x0000000000000000000000000000000000000000", algorithm: "ed25519", value: "test" },
      createdAt: new Date().toISOString(),
    } as any);
    repos.jobs.update(jobId, { evidenceBundleId: bundleId, status: "evidence_submitted" });
    return { jobId, escrowId, bundleId };
  }

  function complete(jobId: string) {
    return app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
  }
  function resume(jobId: string) {
    return app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement`, payload: {} });
  }

  it("plain /complete on a trapped evidence_submitted job still 409s (confirms the trap)", async () => {
    const { jobId } = await makeTrappedJob("a2-trap-confirm");
    const res = await complete(jobId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already completed|in progress/i);
  });

  it("resume-settlement recovers the trapped job WITHOUT creating a second bundle", async () => {
    const { jobId } = await makeTrappedJob("a2-recover");
    const repos = getRepos();
    expect(repos.evidence.findByJob(jobId).length).toBe(1);

    const res = await resume(jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("settled");
    expect(res.json().resumed).toBe(true);
    expect(res.json().evidenceBundleId).toBe(`bundle-trap-a2-recover`);

    // The existing bundle was reused — no second bundle, no re-built evidence.
    expect(repos.evidence.findByJob(jobId).length).toBe(1);
    expect(repos.jobs.findById(jobId)!.status).toBe("settled");
  });

  it("is single-winner under concurrency (two resumes collapse to [200, 409])", async () => {
    const { jobId } = await makeTrappedJob("a2-race");
    const repos = getRepos();

    const [a, b] = await Promise.all([resume(jobId), resume(jobId)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    // Still exactly one bundle; the loser did not settle a second time.
    expect(repos.evidence.findByJob(jobId).length).toBe(1);
    expect(repos.jobs.findById(jobId)!.status).toBe("settled");
  });

  it("rejects resume on a job that is not evidence_submitted (409)", async () => {
    // A fresh fast-track job is 'active', not resumable.
    const ft = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: KERNEL, capabilityType: CAP, userAgentId: "a2-notrap" },
    });
    const jobId = ft.json().jobId as string;
    const res = await resume(jobId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/resumable/i);
  });

  it("404s resume on an unknown job", async () => {
    const res = await resume("job-does-not-exist");
    expect(res.statusCode).toBe(404);
  });

  it("reconciles to settled without re-settling when the escrow is already completed", async () => {
    const { jobId, escrowId } = await makeTrappedJob("a2-already");
    // Simulate an on-chain release that happened elsewhere (challenge window).
    getRepos().escrows.updateStatus(escrowId, "completed");

    const res = await resume(jobId);
    expect(res.statusCode).toBe(200);
    expect(res.json().alreadySettled).toBe(true);
    expect(res.json().status).toBe("settled");
    expect(getRepos().jobs.findById(jobId)!.status).toBe("settled");
  });

  it("a recovered job cannot be recovered again (second resume 409s)", async () => {
    const { jobId } = await makeTrappedJob("a2-twice");
    expect((await resume(jobId)).statusCode).toBe(200);
    // Now settled — a second resume must reject (not re-settle).
    const second = await resume(jobId);
    expect(second.statusCode).toBe(409);
    expect(getRepos().evidence.findByJob(jobId).length).toBe(1);
  });
});
