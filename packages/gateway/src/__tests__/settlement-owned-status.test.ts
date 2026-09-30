/**
 * N85(a): a paid job's terminal status belongs to its settlement path.
 *
 * A paid job has a settlement record (its negotiation session, and an escrow).
 * Only PUT /api/jobs/:jobId/complete finishes it: evidence, then settlement.
 * The relay's POST /api/operator/job-status and PATCH /api/jobs/:jobId/status
 * may report progress on it, but may not set a terminal status (completed,
 * failed, cancelled), and may not write at all once it is terminal or inside
 * the settlement pipeline. Otherwise its settlement is stranded or re-run.
 * A job without a settlement record is unchanged: its node finishes it (adk #452).
 *
 * Who may write a job's status (owner checks) is gateway's N85(b), in WP-C.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { ot2RelayRoutes } from "../routes/ot2-relay.js";
import { ot2ScopeRoutes } from "../routes/ot2-scope.js";
import { jobRoutes } from "../routes/jobs.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema } from "@pcc/store";

// The same I/O mocks as paid-job-flow.test.ts: evidence storage (IPFS), the
// escrow client and batch settlement. None of them decides a job's status.
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

vi.setConfig({ testTimeout: 20000 });

let app: FastifyInstance;

beforeEach(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });
  app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(ot2RelayRoutes);
  await app.register(ot2ScopeRoutes);
  await app.register(jobRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeStore();
});

async function paidJob(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: {
      kernelId: "kernel-nyc",
      capabilityType: "liquid-handler",
      parameters: { volume: 100, tipType: "p300" },
      paymentMethod: "testnet-mock",
      userAgentId: "user-agent-001",
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().jobId as string;
}

const relay = (jobId: string, status: string) =>
  app.inject({ method: "POST", url: "/api/operator/job-status", payload: { jobId, status } });
const patch = (jobId: string, status: string) =>
  app.inject({ method: "PATCH", url: `/api/jobs/${jobId}/status`, payload: { status } });
const complete = (jobId: string) =>
  app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: { evidenceHash: `sha256:${"ab".repeat(32)}` } });
const statusOf = (jobId: string) => getRepos().jobs.findById(jobId)!.status;

describe("N85(a): a paid job is finished only by its settlement path", () => {
  it("the relay cannot complete a paid job, so its settlement still runs", async () => {
    const jobId = await paidJob();
    const before = statusOf(jobId);
    const res = await relay(jobId, "completed");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("settlement_owned_status");
    expect(statusOf(jobId)).toBe(before);
    expect((await complete(jobId)).statusCode).not.toBe(409);
  });

  it("PATCH cannot complete a paid job", async () => {
    const jobId = await paidJob();
    const res = await patch(jobId, "completed");
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("settlement_owned_status");
    expect(statusOf(jobId)).not.toBe("completed");
  });

  it.each(["failed", "cancelled"])("neither route can mark a paid job %s", async (status) => {
    const jobId = await paidJob();
    expect((await relay(jobId, status)).statusCode).toBe(409);
    expect((await patch(jobId, status)).statusCode).toBe(409);
    expect(statusOf(jobId)).not.toBe(status);
  });

  it("a settled paid job cannot be re-opened, so its settlement cannot run twice", async () => {
    const jobId = await paidJob();
    expect((await complete(jobId)).statusCode).toBe(200);
    const settled = statusOf(jobId);
    expect((await relay(jobId, "in_progress")).statusCode).toBe(409);
    expect((await patch(jobId, "queued")).statusCode).toBe(409);
    expect(statusOf(jobId)).toBe(settled);
    expect((await complete(jobId)).statusCode).toBe(409);
  });

  it("progress on a paid job is still reported", async () => {
    const jobId = await paidJob();
    const res = await relay(jobId, "in_progress");
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(true);
    expect(statusOf(jobId)).toBe("in_progress");
    expect((await patch(jobId, "paused")).statusCode).toBe(200);
  });

  it("an escrow for the job's workflow alone makes it paid (seeded job-001, no session)", async () => {
    const { db } = getStore();
    const job = getRepos().jobs.findById("job-001")!;
    expect(db.select().from(schema.escrows).all().some((e) => e.cwmId === job.cwmId)).toBe(true);
    expect((await relay("job-001", "completed")).statusCode).toBe(409);
  });

  it("a negotiation session bound to the job alone makes it paid", async () => {
    const { db } = getStore();
    const job = getRepos().jobs.findById("job-bio-42")!;
    db.insert(schema.negotiationSessions)
      .values({
        id: "sess-n85",
        status: "committed",
        userAgentId: "user-agent-001",
        kernelId: job.kernelId,
        capabilityType: "liquid-handler",
        operatorConstraints: {},
        jobId: job.id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      .run();
    expect((await relay(job.id, "completed")).statusCode).toBe(409);
  });

  it("the MCP cancel operation's path (JobFacade.updateStatus) refuses to cancel a paid job", async () => {
    const { getJobFacade } = await import("../facades/index.js");
    const jobId = await paidJob();
    const result = await getJobFacade().updateStatus(jobId, "cancelled");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.httpStatus).toBe(409);
      expect(result.error.code).toBe("settlement_owned_status");
    }
    expect(statusOf(jobId)).not.toBe("cancelled");
  });

  it("a job without a settlement record is still finished by its node (adk #452)", async () => {
    // The test's own oracle for "no settlement record": no session bound to the
    // job, and no escrow for its workflow.
    const { db } = getStore();
    const escrowed = new Set(db.select().from(schema.escrows).all().map((e) => e.cwmId));
    const withSession = new Set(db.select().from(schema.negotiationSessions).all().map((x) => x.jobId));
    const unpaid = getRepos()
      .jobs.findAll()
      .find((j) => !escrowed.has(j.cwmId) && !withSession.has(j.id) && !["completed", "failed", "cancelled"].includes(j.status));
    expect(unpaid).toBeDefined();
    const res = await relay(unpaid!.id, "completed");
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(true);
    expect(statusOf(unpaid!.id)).toBe("completed");
  });
});
