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
import { jobRoutes } from "../routes/jobs.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { settlementRoutes } from "../routes/settlement.js";
import { resetSettlementService } from "../services/settlement-service.js";
import { closeWorkflowStore } from "../workflow-store.js";
import { isWriteEnabled } from "../contracts/escrow-client.js";
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
  process.env.WORKFLOW_DB_PATH = ":memory:";
  closeWorkflowStore();
  initStore({ seed: true });
  resetSettlementService();
  app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  // The legacy OT-2 relay and scope routes are retired (N4b-gw, #400); no test here calls them.
  await app.register(jobRoutes);
  await app.register(operatorRelayRoutes);
  await app.register(settlementRoutes);
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
    const withProgress = await app.inject({ method: "PATCH", url: `/api/jobs/${jobId}/status`, payload: { status: "in_progress", progress: 37 } });
    expect(withProgress.statusCode).toBe(200);
    expect(getRepos().jobs.findById(jobId)!.progress).toBe(37);
  });

  it("an escrow for the job's workflow alone makes it paid (seeded job-001, no session)", async () => {
    const { db } = getStore();
    const job = getRepos().jobs.findById("job-001")!;
    expect(db.select().from(schema.escrows).all().some((e) => e.cwmId === job.cwmId)).toBe(true);
    expect(db.select().from(schema.negotiationSessions).all().some((x) => x.jobId === job.id)).toBe(false);
    // Seeded "executing", which no generic writer overwrites on any job; the link must decide.
    getRepos().jobs.updateStatus("job-001", "in_progress");
    expect((await relay("job-001", "completed")).statusCode).toBe(409);
    expect(statusOf("job-001")).toBe("in_progress");
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
    // Seeded "executing", as above; the link must decide.
    getRepos().jobs.updateStatus(job.id, "in_progress");
    expect((await relay(job.id, "completed")).statusCode).toBe(409);
    expect(statusOf(job.id)).toBe("in_progress");
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
      .find((j) => !escrowed.has(j.cwmId) && !withSession.has(j.id));
    expect(unpaid).toBeDefined();
    // A node's job is queued or in progress; "executing" is the local kernel's own status.
    getRepos().jobs.update(unpaid!.id, { status: "in_progress", completedAt: null });
    const res = await relay(unpaid!.id, "completed");
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(true);
    expect(statusOf(unpaid!.id)).toBe("completed");
    // The same write as the repository's: a completion is stamped.
    expect(getRepos().jobs.findById(unpaid!.id)!.completedAt).toEqual(expect.any(String));
  });
});

describe("astra, round 1 of #475: jobs settled without a session or escrow link, and every protected state", () => {
  const attestation = () => ({
    version: 1,
    escrowAddress: "0xDeAdBeEf00000000000000000000000000000001",
    jobId: "job-bio-42",
    evidenceHash: `0x${"aa".repeat(32)}`,
    tier: 0,
    verified: true,
    timestamp: 1700000000,
    nonce: `0x${"c".repeat(64)}`,
    extraData: "0x",
    signature: "0x",
  });

  it("F1: a job the release route settled (no session, no escrow link) cannot be re-opened", async () => {
    // N79 round 8 (P2; fixture only, no assertion changed): a job with no escrow row of its own settles only
    // through the CONFIGURED escrow contract (the module doc above: "through a configured escrow contract").
    // releaseMilestone now requires that configuration to be explicit: ESCROW_CONTRACT_ADDRESS plus
    // ESCROW_CONTRACT_VERSION="v1". This test releases against 0xDeAdBeEf...0001, so that is what it configures.
    const savedEscrowEnv = process.env.ESCROW_CONTRACT_ADDRESS;
    const savedEscrowVersionEnv = process.env.ESCROW_CONTRACT_VERSION;
    process.env.ESCROW_CONTRACT_ADDRESS = "0xDeAdBeEf00000000000000000000000000000001";
    process.env.ESCROW_CONTRACT_VERSION = "v1";
    try {
      const { db } = getStore();
      expect(db.select().from(schema.escrows).all().some((e) => e.cwmId === getRepos().jobs.findById("job-bio-42")!.cwmId)).toBe(false);
      vi.mocked(isWriteEnabled).mockReturnValue(true);
      const released = await app.inject({
        method: "POST",
        url: "/api/settlement/release",
        payload: { jobId: "job-bio-42", milestoneIndex: 0, contractAddress: "0xDeAdBeEf00000000000000000000000000000001", attestation: attestation() },
      });
      vi.mocked(isWriteEnabled).mockReturnValue(false);
      expect(released.statusCode).toBe(200);
      expect(statusOf("job-bio-42")).toBe("settled");
      expect((await patch("job-bio-42", "queued")).statusCode).toBe(409);
      expect((await relay("job-bio-42", "in_progress")).statusCode).toBe(409);
      expect(statusOf("job-bio-42")).toBe("settled");
    } finally {
      if (savedEscrowEnv === undefined) delete process.env.ESCROW_CONTRACT_ADDRESS;
      else process.env.ESCROW_CONTRACT_ADDRESS = savedEscrowEnv;
      if (savedEscrowVersionEnv === undefined) delete process.env.ESCROW_CONTRACT_VERSION;
      else process.env.ESCROW_CONTRACT_VERSION = savedEscrowVersionEnv;
    }
  });

  it.each(["executing", "completing", "evidence_submitted", "settled"])(
    "F1: an unlinked job in %s (a status only the system writes) takes no generic write",
    async (state) => {
      getRepos().jobs.updateStatus("job-bio-42", state);
      for (const [write, target] of [[relay, "in_progress"], [relay, "completed"], [patch, "queued"], [patch, "failed"]] as const) {
        const res = await write("job-bio-42", target);
        expect(res.statusCode, `${target} from ${state}`).toBe(409);
      }
      expect(statusOf("job-bio-42")).toBe(state);
    },
  );

  it.each([false, true])("F3 (round 2): a job in evidence_stored (paid: %s) takes no generic write", async (paid) => {
    const jobId = paid ? await paidJob() : "job-bio-42";
    // As the settlement pipeline's processEvidence does (settlement-service.ts).
    getRepos().jobs.updateStatus(jobId, "evidence_stored", 100);
    for (const [write, target] of [[relay, "in_progress"], [relay, "completed"], [patch, "queued"], [patch, "failed"]] as const) {
      expect((await write(jobId, target)).statusCode, `${target} from evidence_stored`).toBe(409);
    }
    const job = getRepos().jobs.findById(jobId)!;
    expect(job.status).toBe("evidence_stored");
    expect(job.progress).toBe(100);
  });

  it("F4 (round 2): an unlinked job the local kernel completed is not re-opened, and its completedAt is kept", async () => {
    // As the local kernel writes before its settlement pipeline runs (kernel-service.ts).
    getRepos().jobs.update("job-bio-42", { status: "completed", progress: 100, completedAt: "2026-09-29T00:00:00.000Z" });
    // A repeated completion would restamp completedAt, so it is refused as well.
    for (const [write, target] of [[patch, "queued"], [relay, "in_progress"], [patch, "failed"], [relay, "cancelled"], [patch, "completed"]] as const) {
      expect((await write("job-bio-42", target)).statusCode, `${target} from completed`).toBe(409);
    }
    const job = getRepos().jobs.findById("job-bio-42")!;
    expect(job.status).toBe("completed");
    expect(job.completedAt).toBe("2026-09-29T00:00:00.000Z");
  });

  it("F5 (round 3): an unlinked job in failed or cancelled is terminal: no generic write re-opens it", async () => {
    // A re-queued job is polled and run again by a remote node (paid-job-flow.ts), so re-opening a failed
    // or cancelled job is the same duplicate-execution class as F4. Both are terminal in the canonical lifecycle.
    for (const state of ["failed", "cancelled"]) {
      getRepos().jobs.update("job-bio-42", { status: state, progress: 40 });
      for (const [via, target] of [["patch", "queued"], ["relay", "in_progress"], ["patch", "completed"], ["relay", "failed"], ["patch", "cancelled"]] as const) {
        const res = via === "patch" ? await patch("job-bio-42", target) : await relay("job-bio-42", target);
        expect(res.statusCode, `${via} ${target} from ${state}`).toBe(409);
      }
      const job = getRepos().jobs.findById("job-bio-42")!;
      expect(job.status, `status stays ${state}`).toBe(state);
      expect(job.progress, `progress stays 40 in ${state}`).toBe(40);
    }
  });

  it.each(["completing", "evidence_submitted", "settled", "completed", "failed", "cancelled"])(
    "F2: a paid job in %s takes no progress write, and its status and progress are unchanged",
    async (state) => {
      const jobId = await paidJob();
      getRepos().jobs.updateStatus(jobId, state, 42);
      for (const [write, target] of [[relay, "in_progress"], [patch, "queued"]] as const) {
        const res = await write(jobId, target);
        expect(res.statusCode, `${target} from ${state}`).toBe(409);
      }
      const job = getRepos().jobs.findById(jobId)!;
      expect(job.status).toBe(state);
      expect(job.progress).toBe(42);
    },
  );
});
