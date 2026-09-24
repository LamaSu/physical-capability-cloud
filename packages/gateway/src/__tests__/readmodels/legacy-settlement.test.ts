/**
 * The legacy settlement reads (readmodels finding F1): GET /api/settlement/:jobId and
 * GET /api/jobs/:jobId/settlement, now projections of the execution read model's
 * settlement axis.
 *
 * Each negative test pins a claim the routes used to make:
 *   - "settled" from the job row alone (completed or settled)
 *   - a mock-settlement escrow reported as settled and funded
 *   - `paidAmount` = the escrow total or the quote
 *   - a "USDC" currency when nothing recorded one
 *   - `settledAt` = the job's completion time
 *   - the escrow read through the first negotiation session only
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  buildJobExecutionDTO,
  type JobExecutionSources,
  type JobRow,
  type SettlementSource,
} from "../../readmodels/job-execution.js";
import {
  buildJobSettlementRead,
  buildSettlementStatusRead,
  legacySettlementStatus,
  type SessionRead,
} from "../../readmodels/legacy-settlement.js";

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

vi.mock("../../contracts/escrow-client.js", () => ({
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

vi.mock("../../contracts/batch-settlement.js", () => ({
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

const AS_OF = "2026-09-24T12:00:00.000Z";
const REAL_ADDRESS = "0x3333333333333333333333333333333333333333";

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-x",
    stepId: "step-x",
    cwmId: "cwm-x",
    capabilityId: "cap-x",
    kernelId: "kernel-x",
    status: "queued",
    startedAt: "2026-09-20T10:00:00.000Z",
    completedAt: null,
    progress: 0,
    assuranceTier: 1,
    ...over,
  };
}

function sources(over: Partial<JobExecutionSources> = {}): JobExecutionSources {
  return {
    job: job(),
    capability: { ok: true, value: null },
    kernel: { ok: true, value: null },
    evidence: { ok: true, value: [] },
    captureVerdicts: { ok: true, value: [] },
    settlement: { ok: true, value: { link: "not_linked" } },
    ...over,
  };
}

const escrow = (over: Record<string, unknown> = {}) => ({
  id: "esc-x",
  cwmId: "cwm-x",
  contractAddress: REAL_ADDRESS,
  totalAmount: "30.00",
  currency: "USDC",
  status: "funded",
  createdAt: "2026-09-20T09:00:00.000Z",
  deadline: "2026-09-27T09:00:00.000Z",
  version: "v3",
  ...over,
});

const milestone = (over: Record<string, unknown> = {}) => ({
  id: "ms-x",
  stepId: "step-x",
  amount: "12.00",
  status: "funded",
  bondAmount: "0",
  challengeWindowEnd: null,
  ...over,
});

function linked(e = escrow(), ms: unknown[] = [milestone()]): SettlementSource {
  return {
    link: "linked",
    basis: "negotiation_session_escrow_address",
    matches: ["negotiation_session_escrow_address", "negotiation_session_cwm"],
    escrow: e as any,
    milestones: ms as any,
  };
}

const mock = () => escrow({ contractAddress: "mock-escrow-abc", status: "completed" });
const ok = (value: SettlementSource) => ({ ok: true as const, value });

function read(over: Partial<JobExecutionSources>) {
  const src = sources(over);
  return { src, dto: buildJobExecutionDTO(src, AS_OF) };
}
const statusOf = (over: Partial<JobExecutionSources>) => legacySettlementStatus(read(over).dto);

// ── Status vocabulary ────────────────────────────────────────────────────────

describe("legacySettlementStatus: money states come only from the settlement records", () => {
  it("NEGATIVE: a completed or settled job row is never 'settled' by itself", () => {
    expect(statusOf({ job: job({ status: "completed" }) })).toBe("no_settlement_record");
    expect(statusOf({ job: job({ status: "settled" }) })).toBe("no_settlement_record");
    expect(statusOf({ job: job({ status: "completed" }), settlement: ok(linked()) })).toBe("awaiting_settlement");
    // The row says settled, the milestone record says not released: the records disagree.
    expect(statusOf({ job: job({ status: "settled" }), settlement: ok(linked()) })).toBe("unknown");
  });

  it("settled only when this job's own milestone record says released", () => {
    const s = ok(linked(escrow({ status: "active" }), [milestone({ status: "released" })]));
    expect(statusOf({ job: job({ status: "completed" }), settlement: s })).toBe("settled");
    expect(statusOf({ job: job({ status: "settled" }), settlement: s })).toBe("settled");
  });

  it("NEGATIVE: a mock-settlement escrow is simulated at every stage, never funded or settled", () => {
    for (const status of ["pending", "queued", "executing", "completed", "settled"]) {
      const s = ok(linked(mock(), [milestone({ status: "released" })]));
      expect(statusOf({ job: job({ status }), settlement: s }), status).toBe("simulated");
    }
  });

  it("refunded when this job's milestone record says refunded", () => {
    const s = ok(linked(escrow({ status: "refunded" }), [milestone({ status: "refunded" })]));
    expect(statusOf({ job: job({ status: "completed" }), settlement: s })).toBe("refunded");
  });

  it("NEGATIVE: records that cannot say give unknown, whatever the job row says", () => {
    const completed = job({ status: "completed" });
    expect(statusOf({ job: completed, settlement: ok({ link: "ambiguous", basis: "job_cwm", candidates: 2 }) })).toBe("unknown");
    expect(statusOf({ job: completed, settlement: ok({ link: "conflicting", reason: "x" }) })).toBe("unknown");
    // The escrow has no milestone for this job's step.
    expect(statusOf({ job: completed, settlement: ok(linked(escrow(), [milestone({ stepId: "other" })])) })).toBe("unknown");
    // A released milestone in an escrow that says refunded.
    expect(
      statusOf({ job: completed, settlement: ok(linked(escrow({ status: "refunded" }), [milestone({ status: "released" })])) }),
    ).toBe("unknown");
  });

  it("NEGATIVE: an unreadable settlement store is unavailable, never a stage", () => {
    expect(statusOf({ job: job({ status: "completed" }), settlement: { ok: false } })).toBe("unavailable");
  });

  it("places a job whose money is held or unrecorded in its stage", () => {
    expect(statusOf({ job: job({ status: "pending" }) })).toBe("pending");
    expect(statusOf({ job: job({ status: "pending" }), settlement: ok(linked()) })).toBe("funded");
    expect(statusOf({ job: job({ status: "pending" }), settlement: ok(linked(escrow({ status: "created" }), [milestone({ status: "created" })])) })).toBe("pending");
    for (const status of ["queued", "active", "preparing", "executing"]) {
      expect(statusOf({ job: job({ status }) }), status).toBe("executing");
    }
    expect(statusOf({ job: job({ status: "evidence_submitted" }) })).toBe("evidence_submitted");
    expect(statusOf({ job: job({ status: "failed" }) })).toBe("cancelled");
    expect(statusOf({ job: job({ status: "disputed" }) })).toBe("disputed");
  });
});

// ── GET /api/jobs/:jobId/settlement projection ────────────────────────────────

const ONE_SESSION: SessionRead = {
  ok: true,
  sessions: [{ id: "neg-x", capabilityType: "fdm", committedAt: AS_OF, escrowAddress: REAL_ADDRESS, quote: { totalPrice: 99, currency: "USDC" } }],
};
const jobRead = (over: Partial<JobExecutionSources>, sessions: SessionRead = ONE_SESSION) => {
  const { src, dto } = read(over);
  return buildJobSettlementRead({ ...src.job, evidenceBundleId: null }, src, dto, sessions);
};

describe("GET /api/jobs/:jobId/settlement projection", () => {
  it("NEGATIVE: paidAmount is only this job's released milestone amount, never the escrow total or the quote", () => {
    const paid = jobRead({ job: job({ status: "completed" }), settlement: ok(linked(escrow({ status: "active" }), [milestone({ status: "released" })])) });
    expect(paid.settled).toBe(true);
    expect(paid.paidAmount).toBe("12.00");
    expect(paid.payoutConfirmation).toBe("record_only");
    expect(paid.quotedAmount).toBe("99");

    const held = jobRead({ job: job({ status: "completed" }), settlement: ok(linked()) });
    expect(held.settled).toBe(false);
    expect(held.paidAmount).toBeNull();
    expect(held.quotedAmount).toBe("99");
    expect(held.escrow?.totalAmount).toBe("30.00");

    const simulated = jobRead({ job: job({ status: "settled" }), settlement: ok(linked(mock(), [milestone({ status: "released" })])) });
    expect(simulated.status).toBe("simulated");
    expect(simulated.settled).toBe(false);
    expect(simulated.paidAmount).toBeNull();
    expect(simulated.simulated).toBe(true);
    expect(simulated.escrow?.simulated).toBe(true);
    expect(simulated.notices).toEqual(expect.arrayContaining(["simulated_settlement", "job_row_reports_settled"]));
  });

  it("NEGATIVE: the currency is recorded or null, never a USDC default", () => {
    expect(jobRead({}, { ok: true, sessions: [] }).currency).toBeNull();
    const eur = jobRead({}, { ok: true, sessions: [{ id: "n", quote: { totalPrice: "5", currency: "EUR" } }] });
    expect(eur.currency).toBe("EUR");
    expect(jobRead({ settlement: ok(linked(escrow({ currency: "USDT" }))) }).currency).toBe("USDT");
  });

  it("NEGATIVE: with two sessions naming the job, no session's fields are shown and the link is unknown", () => {
    const two: SessionRead = { ok: true, sessions: [ONE_SESSION.ok ? ONE_SESSION.sessions[0]! : ({} as any), { id: "neg-y", escrowAddress: "0x4" }] };
    const r = jobRead({ job: job({ status: "completed" }), settlement: ok({ link: "ambiguous", basis: "negotiation_session", candidates: 2 }) }, two);
    expect(r.session).toBeNull();
    expect(r.escrowAddress).toBeNull();
    expect(r.quotedAmount).toBeNull();
    expect(r.status).toBe("unknown");
    expect(r.escrow).toBeNull();
    expect(r.milestones).toEqual([]);
  });

  it("a failed session or settlement read is listed as unavailable, with its fields null", () => {
    const r = jobRead({ settlement: { ok: false } }, { ok: false });
    expect(r.unavailable).toEqual(["settlement", "negotiation_session"]);
    expect(r.status).toBe("unavailable");
    expect(r.session).toBeNull();
    expect(r.currency).toBeNull();
  });

  it("marks which milestones of the escrow are this job's", () => {
    const r = jobRead({ settlement: ok(linked(escrow(), [milestone(), milestone({ id: "ms-y", stepId: "other" })])) });
    expect(r.milestones.map((m) => [m.id, m.forThisJob])).toEqual([["ms-x", true], ["ms-y", false]]);
  });

  it("NEGATIVE: settledAt is never the job's completion time", () => {
    const r = jobRead({ job: job({ status: "completed", completedAt: "2026-09-21T10:00:00.000Z" }), settlement: ok(linked(escrow(), [milestone({ status: "released" })])) });
    expect(r.settled).toBe(true);
    expect(r.settledAt).toBeNull();
    expect(r.asOf).toBe(AS_OF);
  });
});

// ── GET /api/settlement/:jobId projection ─────────────────────────────────────

describe("GET /api/settlement/:jobId projection", () => {
  const statusRead = (over: Partial<JobExecutionSources>) => {
    const { src, dto } = read(over);
    return buildSettlementStatusRead({ ...src.job, evidenceBundleId: "bun-row" }, src, dto);
  };

  it("NEGATIVE: settled is true only for a released milestone record", () => {
    expect(statusRead({ job: job({ status: "completed" }) }).settled).toBe(false);
    expect(statusRead({ job: job({ status: "settled" }) }).settled).toBe(false);
    expect(statusRead({ job: job({ status: "settled" }), settlement: ok(linked(mock(), [milestone({ status: "released" })])) }).settled).toBe(false);
    expect(statusRead({ job: job({ status: "completed" }), settlement: ok(linked(escrow(), [milestone({ status: "released" })])) }).settled).toBe(true);
  });

  it("reports the job row's status separately as jobStatus", () => {
    const r = statusRead({ job: job({ status: "settled" }) });
    expect(r.jobStatus).toBe("settled");
    expect(r.status).toBe("no_settlement_record");
    expect(r.payout).toBe("unknown");
  });

  it("NEGATIVE: an unreadable evidence store is listed; its fields are null, the row's own bundle id stays", () => {
    const r = statusRead({ evidence: { ok: false } });
    expect(r.unavailable).toEqual(["evidence"]);
    expect(r.evidenceHash).toBeNull();
    expect(r.assuranceTier).toBeNull();
    expect(r.evidenceBundleId).toBe("bun-row");
  });
});

// ── Both routes against a real (in-memory) store ──────────────────────────────

describe("the legacy settlement routes on a real store", () => {
  let app: FastifyInstance;
  let getStore: typeof import("../../db.js").getStore;
  let closeStore: typeof import("../../db.js").closeStore;
  const now = "2026-09-24T10:00:00.000Z";

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true";
    const db = await import("../../db.js");
    getStore = db.getStore;
    closeStore = db.closeStore;
    db.initStore({ seed: true });
    const { paidJobFlowRoutes } = await import("../../routes/paid-job-flow.js");
    const { negotiationRoutes } = await import("../../routes/negotiation.js");
    const { settlementRoutes } = await import("../../routes/settlement.js");
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const t = req.headers["x-test-tenant"];
      if (typeof t === "string") (req as any).tenantId = t;
    });
    await app.register(paidJobFlowRoutes);
    await app.register(negotiationRoutes);
    await app.register(settlementRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    delete process.env.MOCK_SETTLEMENT;
    delete process.env.TENANT_ENFORCE;
  });

  const both = async (jobId: string, headers: Record<string, string> = {}) => ({
    jobs: await app.inject({ method: "GET", url: `/api/jobs/${jobId}/settlement`, headers }),
    settlement: await app.inject({ method: "GET", url: `/api/settlement/${jobId}`, headers }),
  });

  it("NEGATIVE (F1, the reproduced lie): a mock-settled job is simulated on both routes, never settled or paid", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/jobs/submit-from-discovery",
      payload: { kernelId: "kernel-nyc", capabilityType: "liquid-handler", userAgentId: "user-agent-f1" },
    });
    expect(created.statusCode).toBe(201);
    const { jobId } = created.json();
    expect((await app.inject({ method: "PUT", url: `/api/jobs/${jobId}/complete`, payload: {} })).statusCode).toBe(200);

    const { jobs, settlement } = await both(jobId);
    expect(jobs.statusCode).toBe(200);
    expect(jobs.headers["cache-control"]).toBe("no-store");
    const j = jobs.json();
    expect(j.status).toBe("simulated");
    expect(j.settled).toBe(false);
    expect(j.paidAmount).toBeNull();
    expect(j.simulated).toBe(true);
    expect(j.escrow.simulated).toBe(true);
    expect(j.payout).toBe("simulated");
    expect(j.jobStatus).toBe("settled");
    expect(j.notices).toEqual(expect.arrayContaining(["simulated_settlement", "job_row_reports_settled"]));

    expect(settlement.statusCode).toBe(200);
    const s = settlement.json();
    expect(s.status).toBe("simulated");
    expect(s.settled).toBe(false);
    expect(s.settledAt).toBeNull();
    expect(s.payout).toBe("simulated");
  });

  it("a real escrow record with this job's milestone released reads settled on both routes, with the milestone amount", async () => {
    const { schema } = await import("@pcc/store");
    const store = getStore();
    store.repos.escrows.insert({
      id: "esc-f1", cwmId: "cwm-f1", contractAddress: REAL_ADDRESS, payer: "0xpayer", totalAmount: "30.00",
      currency: "USDC", status: "active", createdAt: now, deadline: now, version: "v3",
    } as any);
    store.repos.escrows.insertMilestone({ id: "ms-f1", escrowId: "esc-f1", stepId: "step-f1", amount: "12.50", status: "released", bondAmount: "0" } as any);
    store.repos.jobs.insert({
      id: "job-f1", stepId: "step-f1", cwmId: "cwm-f1", capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc",
      status: "completed", assignedDevices: [], startedAt: now, progress: 100,
    } as any);
    store.db.insert(schema.negotiationSessions).values({
      id: "neg-f1", status: "committed", userAgentId: "agent-buyer-f1", kernelId: "kernel-nyc", capabilityType: "fdm",
      operatorConstraints: {}, jobId: "job-f1", createdAt: now, expiresAt: now,
      escrowAddress: REAL_ADDRESS, cwmId: "cwm-f1", quote: { totalPrice: 31, currency: "USDC" },
    } as any).run();

    const { jobs, settlement } = await both("job-f1");
    const j = jobs.json();
    expect(j.status).toBe("settled");
    expect(j.settled).toBe(true);
    expect(j.paidAmount).toBe("12.50");
    expect(j.quotedAmount).toBe("31");
    expect(j.payoutConfirmation).toBe("record_only");
    expect(j.settlementLink).toBe("linked");
    expect(j.session.id).toBe("neg-f1");
    const s = settlement.json();
    expect(s.status).toBe("settled");
    expect(s.settled).toBe(true);
  });

  it("NEGATIVE: seeded job-004 (completed; its escrow has no milestone for its step) is unknown, not settled", async () => {
    const { jobs, settlement } = await both("job-004");
    expect(jobs.json()).toMatchObject({ status: "unknown", settled: false, paidAmount: null, jobStatus: "completed" });
    expect(settlement.json()).toMatchObject({ status: "unknown", settled: false, settledAt: null });
  });

  it("404s an unknown job on both routes with each route's own error body", async () => {
    const { jobs, settlement } = await both("no-such-job");
    expect(jobs.statusCode).toBe(404);
    expect(jobs.json().error).toBe("Job not found");
    expect(settlement.statusCode).toBe(404);
    expect(settlement.json().error).toBe("SETTLEMENT_NOT_FOUND");
  });

  it("under TENANT_ENFORCE a job of another tenant is a 404 on both routes", async () => {
    getStore().repos.jobs.insert({
      id: "job-f1-tenant", stepId: "s", cwmId: "cwm-f1-tenant", capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc",
      status: "queued", assignedDevices: [], startedAt: now, progress: 0, tenantId: "tenant-a",
    } as any);
    process.env.TENANT_ENFORCE = "true";
    try {
      const other = await both("job-f1-tenant", { "x-test-tenant": "tenant-b" });
      expect(other.jobs.statusCode).toBe(404);
      expect(other.settlement.statusCode).toBe(404);
      const own = await both("job-f1-tenant", { "x-test-tenant": "tenant-a" });
      expect(own.jobs.statusCode).toBe(200);
      expect(own.settlement.statusCode).toBe(200);
    } finally {
      delete process.env.TENANT_ENFORCE;
    }
  });

  it("NEGATIVE: a failed job row read is 503 on both routes, never a fallback", async () => {
    const spy = vi.spyOn(getStore().repos.jobs, "findById").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    try {
      const { jobs, settlement } = await both("job-004");
      expect(jobs.statusCode).toBe(503);
      expect(settlement.statusCode).toBe(503);
      expect(jobs.body).not.toContain("disk I/O");
    } finally {
      spy.mockRestore();
    }
  });
});
