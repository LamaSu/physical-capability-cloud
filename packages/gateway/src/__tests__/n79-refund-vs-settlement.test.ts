/**
 * N79 round 2 (astra, pack 116b): a refund must never land underneath a settlement that is still in flight, and a
 * settlement that gives up must not strand a failed job's escrow.
 *
 *   F1: a REPEATED terminal write must not bypass the settlement-in-progress protection. /complete is suspended
 *       after the job reads `evidence_submitted` but before the milestone does; two entitled failure writes land.
 *   F2: cancelling ONE job must not give back an escrow another job also uses (a shared CWM).
 *   F3: a refund must not land while a job-level release (SettlementService.releaseMilestone) awaits the chain.
 *   F4: /complete fails after an entitled failure write replaced `completing`. Once the settlement lets go, the
 *       failed job's escrow must be given back, not left funded.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getAddress } from "viem";

// Test-controlled pauses inside /complete, so another write can land mid-flight.
const gates = vi.hoisted(() => ({
  archive: null as null | Promise<void>,
  onArchive: null as null | (() => void),
  evidence: null as null | Promise<void>,
  onEvidence: null as null | (() => void),
  oracle: null as null | Promise<void>,
  onOracle: null as null | (() => void),
  oracleThrows: false,
}));

vi.mock("../services/oracle-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/oracle-client.js")>();
  return {
    ...actual,
    verifyWithOracle: vi.fn(async (...args: Parameters<typeof actual.verifyWithOracle>) => {
      gates.onOracle?.();
      if (gates.oracle) await gates.oracle;
      if (gates.oracleThrows) throw new Error("oracle unreachable");
      return actual.verifyWithOracle(...args);
    }),
  };
});

vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn(async () => {
      gates.onArchive?.();
      if (gates.archive) await gates.archive;
      return { cid: "bafytest_n79_r2", metadataCid: "bafymeta_n79_r2" };
    }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc", metadataCid: "bafyencmeta" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../services/device-evidence-settlement.js", async (importActual) => {
  const actual = await importActual<typeof import("../services/device-evidence-settlement.js")>();
  return {
    ...actual,
    resolveSettlementEvidence: vi.fn(async (...args: Parameters<typeof actual.resolveSettlementEvidence>) => {
      gates.onEvidence?.();
      if (gates.evidence) await gates.evidence;
      return actual.resolveSettlementEvidence(...args);
    }),
  };
});

vi.mock("../contracts/escrow-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../contracts/escrow-client.js")>();
  return {
    ...actual,
    isWriteEnabled: vi.fn(() => false),
    releaseMilestone: vi.fn(),
    releaseMilestoneV2: vi.fn(),
  };
});

vi.mock("../contracts/batch-settlement.js", () => ({
  isBatchEnabled: vi.fn().mockReturnValue(false),
  getSmartAccountAddress: vi.fn().mockReturnValue(null),
  submitSettlement: vi.fn(),
  flushSettlements: vi.fn().mockResolvedValue({ epochId: "e", totalIntents: 0, batches: [], byAgent: {}, byOperation: {}, startedAt: 0, completedAt: 0 }),
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

import { paidJobFlowRoutes } from "../routes/paid-job-flow.js";
import { negotiationRoutes } from "../routes/negotiation.js";
import { jobRoutes } from "../routes/jobs.js";
import { escrowRoutes } from "../routes/escrow.js";
import { initStore, closeStore, getRepos, getStore } from "../db.js";
import { schema, eq } from "@pcc/store";
import { escrowForJob, setJobStatusWithRefund } from "../services/escrow-refund.js";
import { getSettlementService } from "../services/settlement-service.js";
import * as chain from "../contracts/escrow-client.js";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.MOCK_SETTLEMENT = "true";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(paidJobFlowRoutes);
  await app.register(negotiationRoutes);
  await app.register(jobRoutes);
  await app.register(escrowRoutes);
  await app.ready();
  return app;
}

async function submitPaidJob(app: FastifyInstance, userAgentId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/api/jobs/submit-from-discovery",
    payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId },
  });
  expect(res.statusCode).toBe(201);
  return res.json().jobId as string;
}

function escrowState(jobId: string) {
  const escrow = escrowForJob(jobId)!;
  return {
    escrow: getRepos().escrows.findById(escrow.id)!.status,
    milestones: getRepos().escrows.findMilestonesByEscrow(escrow.id).map((m) => m.status),
  };
}

describe("N79 round 2: a refund never lands underneath a settlement in flight", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    gates.archive = gates.evidence = gates.oracle = null;
    gates.onArchive = gates.onEvidence = gates.onOracle = null;
    gates.oracleThrows = false;
    vi.mocked(chain.isWriteEnabled).mockReset().mockReturnValue(false);
    vi.mocked(chain.releaseMilestone).mockReset();
    vi.mocked(chain.releaseMilestoneV2).mockReset();
    delete process.env.PCC_USE_EAS_V2;
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("F1: while /complete is in flight, a REPEATED failure write still gives nothing back", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-f1");
    const entered = deferred();
    const hold = deferred();
    gates.onArchive = () => entered.resolve();
    gates.archive = hold.promise;

    const completing = app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    await entered.promise; // suspended: the job reads evidence_submitted, the milestone still reads funded

    const first = setJobStatusWithRefund(jobId, "failed");
    const second = setJobStatusWithRefund(jobId, "failed");
    expect(first.escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }));
    expect(second.escrowRefund).toEqual(expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }));
    expect(escrowState(jobId).milestones.every((s) => s !== "refunded" && s !== "refund_pending")).toBe(true);

    hold.resolve();
    const res = await completing;
    expect(res.statusCode).toBe(200);
    // The settlement that owned the escrow finished it: one consistent outcome, no refund underneath it.
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("F4: when /complete fails after a failure write replaced `completing`, the failed job's escrow is given back", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-f4");
    const entered = deferred();
    const hold = deferred();
    gates.onEvidence = () => entered.resolve();
    gates.evidence = hold.promise;

    const completing = app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    await entered.promise; // suspended before any evidence is recorded: the job reads completing

    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund?.outcome).toBe("skipped");
    hold.reject(new Error("evidence resolver down"));
    const res = await completing;
    expect(res.statusCode).toBe(500);

    expect(getRepos().jobs.findById(jobId)?.status).toBe("failed");
    expect(escrowState(jobId)).toEqual({ escrow: "refunded", milestones: ["refunded"] });
  });

  it("a completion that fails AFTER recording evidence keeps the escrow: the settlement is not abandoned (resume continues it)", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-post-evidence");
    gates.oracleThrows = true;
    const res = await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} });
    expect(res.statusCode).toBe(500);
    expect(getRepos().jobs.findById(jobId)?.status).toBe("evidence_submitted");
    expect(escrowState(jobId).escrow).toBe("completing");
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
      expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
    );
  });

  it("resume-settlement takes the escrow itself when a row predates settlement ownership (a legacy row)", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-legacy");
    gates.oracleThrows = true;
    expect((await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} })).statusCode).toBe(500);
    gates.oracleThrows = false;
    // As a completion from before this change would have left it: evidence recorded, escrow and milestone funded.
    const escrow = escrowForJob(jobId)!;
    getRepos().escrows.updateStatus(escrow.id, "funded");
    for (const m of getRepos().escrows.findMilestonesByEscrow(escrow.id)) getRepos().escrows.updateMilestoneStatus(m.id, "funded");

    const entered = deferred();
    const hold = deferred();
    gates.onOracle = () => entered.resolve();
    gates.oracle = hold.promise;
    const resuming = app.inject({ method: "POST", url: `/api/jobs/${jobId}/resume-settlement` });
    await entered.promise;

    // Twice, as in F1: the second write sees `failed`, not `completing`, so only the escrow's owner mark stops it.
    for (let i = 0; i < 2; i++) {
      expect(setJobStatusWithRefund(jobId, "failed").escrowRefund).toEqual(
        expect.objectContaining({ outcome: "skipped", reason: "settlement_in_progress" }),
      );
    }
    hold.resolve();
    expect((await resuming).statusCode).toBe(200);
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("F3: a refund does not land while a job-level release awaits the chain", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-f3");
    const escrow = escrowForJob(jobId)!;
    const address = "0x00000000000000000000000000000000000e5c33";
    getStore()
      .db.update(schema.escrows)
      .set({ contractAddress: address })
      .where(eq(schema.escrows.id, escrow.id))
      .run();
    getRepos().jobs.updateStatus(jobId, "in_progress");

    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const released = deferred<{ transactionHash: string; status: "submitted" }>();
    vi.mocked(chain.releaseMilestone).mockReturnValue(released.promise as never);

    const attestation = { escrowAddress: address, evidenceHash: `0x${"cd".repeat(32)}` } as never;
    const releasing = getSettlementService().releaseMilestone(jobId, 0, attestation, address);
    await vi.waitFor(() => expect(chain.releaseMilestone).toHaveBeenCalled());

    const refund = setJobStatusWithRefund(jobId, "failed");
    expect(refund.escrowRefund?.outcome).toBe("skipped");
    expect(["refunded", "refund_pending"]).not.toContain(getRepos().escrows.findById(escrow.id)!.status);

    released.resolve({ transactionHash: "0xreleased", status: "submitted" });
    expect((await releasing).status).toBe("released");
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("F3, the raw route: a refund does not land while POST /api/escrow/chain/:address/release awaits the chain", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-f3raw");
    const escrow = escrowForJob(jobId)!;
    const address = getAddress("0x00000000000000000000000000000000000e5c34");
    getStore()
      .db.update(schema.escrows)
      .set({ contractAddress: address, version: "v2" })
      .where(eq(schema.escrows.id, escrow.id))
      .run();
    getRepos().jobs.updateStatus(jobId, "in_progress");

    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const released = deferred<{ transactionHash: string; status: "submitted" }>();
    vi.mocked(chain.releaseMilestoneV2).mockReturnValue(released.promise as never);

    const releasing = app.inject({ method: "POST", url: `/api/escrow/chain/${address}/release/0`, payload: {} });
    await vi.waitFor(() => expect(chain.releaseMilestoneV2).toHaveBeenCalled());

    const refund = setJobStatusWithRefund(jobId, "failed");
    expect(refund.escrowRefund?.outcome).toBe("skipped");

    released.resolve({ transactionHash: "0xrawreleased", status: "submitted" });
    expect((await releasing).statusCode).toBe(200);
    expect(escrowState(jobId)).toEqual({ escrow: "completed", milestones: ["released"] });
  });

  it("releasing ONE milestone of several records it and hands the escrow back; the rest stay funded", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-multi");
    const escrow = escrowForJob(jobId)!;
    const address = "0x00000000000000000000000000000000000e5c35";
    getStore()
      .db.update(schema.escrows)
      .set({ contractAddress: address })
      .where(eq(schema.escrows.id, escrow.id))
      .run();
    getRepos().escrows.insertMilestone({
      id: `${escrow.id}-ms-2`,
      escrowId: escrow.id,
      stepId: "step-2",
      amount: "5.00",
      status: "funded",
      bondAmount: "0",
    });
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestone).mockResolvedValue({ transactionHash: "0xone", status: "submitted" } as never);

    const out = await getSettlementService().releaseMilestone(jobId, 0, { escrowAddress: address } as never, address);
    expect(out.status).toBe("released");
    expect(escrowState(jobId)).toEqual({ escrow: "funded", milestones: ["released", "funded"] });
  });

  it("a job-level release that FAILS hands the escrow back, and gives it to the payer if the job ended meanwhile", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-svc-fail");
    const escrow = escrowForJob(jobId)!;
    const address = "0x00000000000000000000000000000000000e5c36";
    getStore()
      .db.update(schema.escrows)
      .set({ contractAddress: address })
      .where(eq(schema.escrows.id, escrow.id))
      .run();
    getRepos().jobs.updateStatus(jobId, "in_progress");
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    const attempt = deferred<never>();
    vi.mocked(chain.releaseMilestone).mockReturnValue(attempt.promise as never);

    const releasing = getSettlementService().releaseMilestone(jobId, 0, { escrowAddress: address } as never, address);
    await vi.waitFor(() => expect(chain.releaseMilestone).toHaveBeenCalled());
    expect(setJobStatusWithRefund(jobId, "failed").escrowRefund?.outcome).toBe("skipped");
    attempt.reject(new Error("execution reverted"));
    expect((await releasing).status).toBe("failed");
    // Chain escrow: the refund is decided (refund_pending), never left owned or funded.
    expect(escrowState(jobId)).toEqual({ escrow: "refund_pending", milestones: ["refund_pending"] });
  });

  it("a raw chain release that FAILS hands the escrow back", async () => {
    const jobId = await submitPaidJob(app, "user-n79r2-raw-fail");
    const escrow = escrowForJob(jobId)!;
    const address = getAddress("0x00000000000000000000000000000000000e5c37");
    getStore()
      .db.update(schema.escrows)
      .set({ contractAddress: address, version: "v2" })
      .where(eq(schema.escrows.id, escrow.id))
      .run();
    process.env.PCC_USE_EAS_V2 = "true";
    vi.mocked(chain.isWriteEnabled).mockReturnValue(true);
    vi.mocked(chain.releaseMilestoneV2).mockRejectedValue(new Error("execution reverted: window open"));

    const res = await app.inject({ method: "POST", url: `/api/escrow/chain/${address}/release/0`, payload: {} });
    expect(res.statusCode).toBe(502);
    expect(escrowState(jobId)).toEqual({ escrow: "funded", milestones: ["funded"] });
  });

  it("F2: cancelling one job never gives back an escrow another job shares", async () => {
    const a = await submitPaidJob(app, "user-n79r2-f2");
    const escrow = escrowForJob(a)!;
    const { db } = getStore();
    const sessionA = db.select().from(schema.negotiationSessions).where(eq(schema.negotiationSessions.jobId, a)).get()!;
    // Job B: a second step of the same CWM, with its own session and milestone on the SAME escrow.
    const jobA = getRepos().jobs.findById(a)!;
    const b = `${a}-step2`;
    getRepos().jobs.insert({ ...jobA, id: b, stepId: "step-2", status: "in_progress" });
    db.insert(schema.negotiationSessions).values({ ...sessionA, id: `${sessionA.id}-b`, jobId: b }).run();
    getRepos().escrows.insertMilestone({
      id: `${escrow.id}-ms-b`,
      escrowId: escrow.id,
      stepId: "step-2",
      amount: "5.00",
      status: "funded",
      bondAmount: "0",
    });

    const out = setJobStatusWithRefund(a, "cancelled").escrowRefund;
    expect(out).toEqual(expect.objectContaining({ outcome: "skipped", reason: "escrow_shared" }));
    expect(escrowState(a).escrow).toBe("funded");
    expect(escrowState(a).milestones.every((s) => s === "funded")).toBe(true);
  });
});
