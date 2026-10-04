/**
 * N79 (G2 of dress rehearsal R0): a failed or cancelled job's escrow must not stay "funded".
 *
 * R0 ran a local master gateway with mock settlement. The operator node reported a job `failed`
 * (POST /api/operator/job-status), the settlement read then said "cancelled", but the escrow and its
 * milestone stayed "funded": nothing ever refunded it.
 *
 * The rule under test: when a job ends without completing (`failed` or `cancelled`; the spec's `timed_out` too),
 * and the write comes from a writer entitled to give the escrow back, its escrow
 *   - under MOCK settlement is refunded at once: every unreleased milestone and the escrow read "refunded";
 *   - on a CHAIN escrow is marked "refund_pending": the refund is decided, but executing it on-chain is a
 *     separate step, and the gateway never releases a refund-pending escrow.
 * The entitled writers are the gateway's own failure observations (the kernel service, the dispatch rollback) and
 * the job facade (the owner-checked MCP cancel; PATCH). NOT the operator relay: it has no owner check yet (N85), so
 * any key could post there. A relay report marks the job and gives nothing back (steward #4218; see
 * n79-refund-authority.test.ts, which runs through the real API gate).
 * The escrow rows are asserted directly: they are what this change writes. The settlement READ is readmodels'.
 * An escrow that already completed (released) or was refunded is never touched.
 *
 * These tests live in their own file because paid-job-flow.test.ts is excluded from the vitest run
 * (see vitest.config.ts), and this money-path rule must run in CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { jobRoutes } from "../routes/jobs.js";
import { operatorRelayRoutes } from "../routes/operator-relay.js";
import { initStore, closeStore, getRepos } from "../db.js";
import { escrowForJob, setJobStatusWithRefund, TERMINAL_FAILURE_JOB_STATUSES } from "../services/escrow-refund.js";

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

// A production control-plane gateway has no local kernel: jobs dispatch to a remote operator node.
vi.mock("../services/kernel-service.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/kernel-service.js")>();
  return {
    ...actual,
    getKernelService: vi.fn(() => {
      throw new Error("[kernel-service] Not initialised (test default: no local kernel)");
    }),
  };
});

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(jobRoutes);
  await app.register(operatorRelayRoutes);
  await app.ready();
  return app;
}

/** Submit a paid job (mock escrow) the way R0's buyer did, and return its id. */
async function submitPaidJob(app: FastifyInstance, userAgentId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().jobId as string;
}

function escrowOf(jobId: string) {
  const escrow = escrowForJob(jobId);
  expect(escrow).toBeDefined();
  return { escrow: escrow!, milestones: getRepos().escrows.findMilestonesByEscrow(escrow!.id) };
}

/** A failure the gateway observes itself (as the kernel service writes it): the refund's own trigger. */
function failJob(jobId: string) {
  return setJobStatusWithRefund(jobId, "failed");
}

describe("N79: a failed or cancelled job's escrow is refunded, never left funded", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  // Merge-up with master's N85(a): the relay (routes/operator-relay.ts, untouched by this merge) now guards
  // EVERY write through writeJobStatusGuarded directly -- not just "marks but never refunds" (the ORIGINAL
  // premise this test pinned), but refused outright, before anything is marked at all.
  it("R0 G2's path, the operator relay, is refused entirely on a paid job: N85(a) guards it before N85's owner check ever gets a say", async () => {
    const jobId = await submitPaidJob(app, "user-n79-failed");
    const before = getRepos().jobs.findById(jobId)?.status;
    const res = await app.inject({
      method: "POST",
      url: "/api/operator/job-status",
      payload: { jobId, status: "failed", metadata: { reason: "wavelength out of range" } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("settlement_owned_status");
    expect(getRepos().jobs.findById(jobId)?.status).toBe(before);
    const after = escrowOf(jobId);
    expect(after.escrow.status).toBe("funded");
    expect(after.milestones.every((m) => m.status === "funded")).toBe(true);
  });

  it("a failure the gateway observes itself gives the mock escrow back: the escrow and every milestone read refunded", async () => {
    const jobId = await submitPaidJob(app, "user-n79-observed");
    const before = escrowOf(jobId);
    expect(before.escrow.status).toBe("funded");
    expect(before.milestones.every((m) => m.status === "funded")).toBe(true);

    expect(failJob(jobId).escrowRefund?.outcome).toBe("refunded");

    const after = escrowOf(jobId);
    expect(after.escrow.status).toBe("refunded");
    expect(after.milestones.map((m) => m.status)).toEqual(before.milestones.map(() => "refunded"));
    expect(getRepos().jobs.findById(jobId)?.status).toBe("failed");
  });

  // The facade path (this request carries no operatorId/userId, so jobs.ts's OWN owner check -- which in
  // production answers 403 to every authenticated caller, its check compares columns that don't exist -- never
  // runs; the request reaches JobFacade.updateStatus unauthenticated, same as the owner-checked MCP cancel would
  // once authenticated). Merge-up with master's N85(a): the facade now writes through
  // writeJobStatusGuardedWithRefund (escrow-refund.ts), which refuses a terminal write on a job with a
  // settlement record outright -- this job's refund-on-cancel property is therefore unreachable today (same
  // reasoning as escrow-refund.ts's module doc), consistent with n79-refund-authority.test.ts's "a buyer's
  // cancel after execution started never gives the escrow back" pinning the same outcome through the real gate.
  it("a job cancelled through PATCH /api/jobs/:id/status is refused outright (N85(a)), never reaches the refund", async () => {
    const jobId = await submitPaidJob(app, "user-n79-cancelled");
    const before = getRepos().jobs.findById(jobId)?.status;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/jobs/${jobId}/status`,
      payload: { status: "cancelled" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("settlement_owned_status");
    const after = escrowOf(jobId);
    expect(after.escrow.status).toBe("funded");
    expect(after.milestones.every((m) => m.status === "funded")).toBe(true);
    expect(getRepos().jobs.findById(jobId)?.status).toBe(before);
  });

  it("reporting the failure again changes nothing: the refund happens once", async () => {
    const jobId = await submitPaidJob(app, "user-n79-twice");
    expect(failJob(jobId).escrowRefund?.outcome).toBe("refunded");
    const again = failJob(jobId);
    expect(again.escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "escrow_not_refundable" }));
    expect(escrowOf(jobId).escrow.status).toBe("refunded");
  });

  it("a CHAIN escrow is marked refund_pending, never refunded here: the on-chain step is separate", async () => {
    const jobId = await submitPaidJob(app, "user-n79-chain");
    const { escrow } = escrowOf(jobId);
    getRepos().escrows.updateStatus(escrow.id, "funded");
    // Make it a chain escrow: a real contract address instead of the mock's.
    const { db } = (await import("../db.js")).getStore();
    const { schema, eq } = await import("@pcc/store");
    db.update(schema.escrows).set({ contractAddress: "0x00000000000000000000000000000000000e5c0f", version: "v3" }).where(eq(schema.escrows.id, escrow.id)).run();

    const res = failJob(jobId);
    expect(res.escrowRefund?.outcome).toBe("refund_pending");
    const after = escrowOf(jobId);
    expect(after.escrow.status).toBe("refund_pending");
    expect(after.milestones.every((m) => m.status === "refund_pending")).toBe(true);
  });

  it("a failure reported while settlement is in flight does not refund underneath it", async () => {
    const jobId = await submitPaidJob(app, "user-n79-inflight");
    getRepos().jobs.updateStatus(jobId, "completing");
    const res = failJob(jobId);
    expect(res.escrowRefund).toEqual({ outcome: "skipped", reason: "settlement_in_progress" });
    expect(escrowOf(jobId).escrow.status).toBe("funded");
  });

  it("a milestone already past funding (here: releasing) blocks the refund; the settlement path owns it", async () => {
    const jobId = await submitPaidJob(app, "user-n79-releasing");
    const { milestones } = escrowOf(jobId);
    getRepos().escrows.updateMilestoneStatus(milestones[0]!.id, "releasing");
    const res = failJob(jobId);
    expect(res.escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "milestone_past_funding" }));
    expect(escrowOf(jobId).escrow.status).toBe("funded");
  });

  it("an escrow that already completed is never touched", async () => {
    const jobId = await submitPaidJob(app, "user-n79-completed");
    const { escrow } = escrowOf(jobId);
    getRepos().escrows.updateStatus(escrow.id, "completed");
    const res = failJob(jobId);
    expect(res.escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "escrow_not_refundable", escrowStatus: "completed" }));
    expect(escrowOf(jobId).escrow.status).toBe("completed");
  });

  it("a refunded escrow can never be released: PUT /complete and resume-settlement both refuse it", async () => {
    const jobId = await submitPaidJob(app, "user-n79-resurrect");
    failJob(jobId);
    // Job statuses have no transition guard, so the job CAN be moved back to a runnable state...
    getRepos().jobs.updateStatus(jobId, "in_progress");
    // ...but its escrow was given back, so completing it must not release anything.
    const complete = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(complete.statusCode).toBe(409);
    expect(complete.json()).toEqual(expect.objectContaining({ error: "escrow_refunded", escrowStatus: "refunded" }));
    getRepos().jobs.updateStatus(jobId, "evidence_submitted");
    const resume = await app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });
    expect(resume.statusCode).toBe(409);
    expect(resume.json()).toEqual(expect.objectContaining({ error: "escrow_refunded" }));
    expect(escrowOf(jobId).escrow.status).toBe("refunded");
  });

  it("the status write and the refund are ONE transaction: a failed refund write rolls back the status too", async () => {
    const jobId = await submitPaidJob(app, "user-n79-atomic");
    const repos = getRepos();
    const spy = vi.spyOn(repos.escrows, "updateMilestoneStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => setJobStatusWithRefund(jobId, "failed")).toThrow("disk full");
    spy.mockRestore();
    expect(repos.jobs.findById(jobId)?.status).not.toBe("failed");
    expect(escrowOf(jobId).escrow.status).toBe("funded");
  });

  it("a failure on the LAST write (the escrow's, after every milestone changed) rolls back the milestones and the status", async () => {
    const jobId = await submitPaidJob(app, "user-n79-atomic-last");
    const repos = getRepos();
    const spy = vi.spyOn(repos.escrows, "updateStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => setJobStatusWithRefund(jobId, "failed")).toThrow("disk full");
    spy.mockRestore();
    expect(repos.jobs.findById(jobId)?.status).not.toBe("failed");
    const after = escrowOf(jobId);
    expect(after.escrow.status).toBe("funded");
    expect(after.milestones.length).toBeGreaterThan(0);
    expect(after.milestones.every((m) => m.status === "funded")).toBe(true);
  });

  it("a non-terminal status write never touches the escrow", async () => {
    const jobId = await submitPaidJob(app, "user-n79-progress");
    const { escrowRefund } = setJobStatusWithRefund(jobId, "in_progress");
    expect(escrowRefund).toBeUndefined();
    expect(escrowOf(jobId).escrow.status).toBe("funded");
  });

  it("every terminal status in the spec except completed refunds, including timed_out", async () => {
    expect([...TERMINAL_FAILURE_JOB_STATUSES].sort()).toEqual(["cancelled", "failed", "timed_out"]);
    const jobId = await submitPaidJob(app, "user-n79-timed-out");
    const { escrowRefund } = setJobStatusWithRefund(jobId, "timed_out");
    expect(escrowRefund).toEqual(expect.objectContaining({ outcome: "refunded" }));
    expect(escrowOf(jobId).escrow.status).toBe("refunded");
  });
});
