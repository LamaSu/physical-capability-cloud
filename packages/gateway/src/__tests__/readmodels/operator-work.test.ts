/**
 * OperatorWorkDTO and OperatorIncomeDTO (PX-7 for operator-ux).
 *
 * The negative tests pin what an operator surface must never do:
 *   - show a declared price as money that backs the work
 *   - show a mock escrow as escrowed, or any gateway record as paid
 *   - list another operator's work
 *   - turn a failed or unattributable source into an empty "no work" list
 *   - infer an action the caller cannot take
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { SettlementAxis } from "@pcc/spec";
import {
  buildOperatorIncomeDTO,
  buildOperatorWorkDTO,
  INCOME_HISTORY_REASON,
  type ApprovalRow,
  type CapabilityLite,
  type KernelJobSource,
  type OperatorWorkSources,
} from "../../readmodels/operator-work.js";
import { buildSettlementAxis, type JobRow, type SettlementSource } from "../../readmodels/job-execution.js";
import type { JobOffer } from "../../services/job-offers-store.js";

const AS_OF = "2026-09-24T12:00:00.000Z";
const NOW = Date.parse(AS_OF);
const K1 = { id: "k-1", name: "Shop One", operatorAddress: "0xAbC", location: { lat: 40.7128, lng: -74.006 } };

function job(over: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-x", stepId: "step-x", cwmId: "cwm-x", capabilityId: "cap-fdm", kernelId: "k-1", status: "queued",
    startedAt: "2026-09-20T10:00:00.000Z", completedAt: null, progress: 0, assuranceTier: 1, ...over,
  };
}
const escrow = (over: Record<string, unknown> = {}) => ({
  id: "esc-x", cwmId: "cwm-x", contractAddress: "0x3333333333333333333333333333333333333333", totalAmount: "30.00",
  currency: "USDC", status: "funded", createdAt: AS_OF, deadline: AS_OF, version: "v3", ...over,
});
const milestone = (over: Record<string, unknown> = {}) => ({ id: "ms-x", stepId: "step-x", amount: "12.50", status: "funded", ...over });
const linked = (e = escrow(), ms: unknown[] = [milestone()]): SettlementSource => ({
  link: "linked", basis: "negotiation_session_escrow_address", matches: ["negotiation_session_escrow_address"], escrow: e as any, milestones: ms as any,
});
const kj = (j: JobRow, s: SettlementSource | null = { link: "not_linked" }): KernelJobSource => ({
  job: j,
  settlement: buildSettlementAxis(j, s ? { ok: true, value: s } : { ok: false }),
});
function offer(over: Partial<JobOffer> = {}): JobOffer {
  return {
    id: "offer-1", capabilityType: "fdm", requirements: { title: "Print a bracket", pickup: { lat: 40.71234, lng: -74.00567 } },
    requirementsValidated: false, serviceAreaGeofence: null, pricing: { amount: 25, currency: "USDC", model: "fixed" },
    deadlineIso: "2026-09-30T00:00:00.000Z", assuranceTier: 1,
    evidenceRequirements: { events_required: ["intake", "completion"], photos_required: true, tier_required: 1 },
    sourceVerifyUrl: null, requireHeartbeat: false, posterDid: "did:web:buyer", posterKernelId: null, idempotencyKey: null,
    status: "open", postedAt: "2026-09-24T08:00:00.000Z", validUntil: "2026-09-25T08:00:00.000Z",
    claimedByKernelId: null, claimedAt: null, claimSignature: null, verified: false, lastVerifyAt: null,
    lastHeartbeatAt: null, deliveredAt: null, cancelledAt: null, expiredAt: null, ...over,
  };
}
const CAPS: CapabilityLite[] = [{ id: "cap-fdm", kernelId: "k-1", type: "fdm", name: "FDM printing" }];

function sources(over: Partial<OperatorWorkSources> = {}): OperatorWorkSources {
  return {
    kernels: [K1],
    capabilities: { ok: true, value: CAPS },
    kernelJobs: { ok: true, value: [] },
    approvals: { ok: true, value: [] },
    claimedOffers: { ok: true, value: [] },
    openOffers: { ok: true, value: [] },
    ...over,
  };
}
const work = (over: Partial<OperatorWorkSources> = {}, limit = 200) => buildOperatorWorkDTO(sources(over), AS_OF, { limit, nowMs: NOW });
const approval = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: "appr-1", kernelId: "k-1", jobId: "job-x", status: "pending", createdAt: "2026-09-24T09:00:00.000Z",
  expiresAt: "2026-09-25T09:00:00.000Z", jobSummary: { capabilityType: "fdm" }, ...over,
});

// ── Kernel jobs ─────────────────────────────────────────────────────────────

describe("kernel jobs", () => {
  it("maps the job's execution phase and names who asserted it", () => {
    const dto = work({
      kernelJobs: {
        ok: true,
        value: [kj(job({ id: "a", status: "queued" })), kj(job({ id: "b", status: "executing" })), kj(job({ id: "c", status: "completed" }))],
      },
    });
    const byId = new Map(dto.items.map((i) => [i.refs.jobId, i]));
    expect(byId.get("a")).toMatchObject({ phase: "accepted", phaseSource: "server", source: "kernel_job", mine: true });
    expect(byId.get("b")).toMatchObject({ phase: "in_progress", phaseSource: "operator_reported" });
    expect(byId.get("c")).toMatchObject({ phase: "reported_done", phaseSource: "operator_reported" });
    expect(byId.get("a")?.title).toBe("FDM printing");
    expect(byId.get("a")?.location).toMatchObject({ kind: "operator_site", kernelId: "k-1", approximate: false });
  });

  it("NEGATIVE: an undocumented status is unknown, never progress", () => {
    const [item] = work({ kernelJobs: { ok: true, value: [kj(job({ status: "done" }))] } }).items;
    expect(item!.phase).toBe("unknown");
  });

  it("pay comes only from this job's milestone in a real escrow record", () => {
    const [item] = work({ kernelJobs: { ok: true, value: [kj(job(), linked())] } }).items;
    expect(item!.pay).toMatchObject({
      amount: "12.50", amountBaseUnits: "12500000", currency: "USDC", decimals: 6, model: "escrow_milestone",
      funding: "escrowed", fundingRef: "esc-x", basis: "escrow_milestone_record",
    });
    expect(item!.payout).toBe("not_paid");
    expect(item!.refs.escrowRef).toBe("esc-x");
  });

  it("NEGATIVE: a mock escrow is simulated, never escrowed; a recorded release is never paid", () => {
    const mockEscrow = escrow({ contractAddress: "mock-escrow-1", status: "completed" });
    const [sim] = work({ kernelJobs: { ok: true, value: [kj(job(), linked(mockEscrow, [milestone({ status: "released" })]))] } }).items;
    expect(sim!.pay.funding).toBe("simulated");
    expect(sim!.payout).toBe("simulated");
    const [rel] = work({ kernelJobs: { ok: true, value: [kj(job({ status: "completed" }), linked(escrow({ status: "active" }), [milestone({ status: "released" })]))] } }).items;
    expect(rel!.payout).toBe("reported_released");
    expect(rel!.payout).not.toBe("paid");
  });

  it("NEGATIVE: no link, an ambiguous link, an unreadable link or no milestone for the job is unknown funding with no amount", () => {
    for (const s of [
      { link: "not_linked" } as SettlementSource,
      { link: "ambiguous", basis: "job_cwm", candidates: 2 } as SettlementSource,
      null,
      linked(escrow(), [milestone({ stepId: "another-step" })]),
    ]) {
      const [item] = work({ kernelJobs: { ok: true, value: [kj(job(), s)] } }).items;
      expect(item!.pay.funding).toBe("unknown");
      expect(item!.pay.amount).toBeNull();
      expect(item!.pay.amountBaseUnits).toBeNull();
    }
  });

  it("folds a pending approval into its job: awaiting_me with approve and reject, listed once", () => {
    const dto = work({ kernelJobs: { ok: true, value: [kj(job())] }, approvals: { ok: true, value: [approval()] } });
    expect(dto.items).toHaveLength(1);
    const item = dto.items[0]!;
    expect(item).toMatchObject({ phase: "awaiting_me", phaseSource: "server", acceptBy: "2026-09-25T09:00:00.000Z" });
    expect(item.refs.approvalId).toBe("appr-1");
    expect(item.actions.map((a) => [a.op, a.allowed, a.route.path])).toEqual([
      ["approve", true, "/api/operator/approvals/appr-1/approve"],
      ["reject", true, "/api/operator/approvals/appr-1/reject"],
      ["update_status", true, "/api/jobs/job-x/status"],
    ]);
  });

  it("lists an approval without a job row as its own item, with no invented pay", () => {
    const dto = work({ approvals: { ok: true, value: [approval({ jobId: "job-without-row" })] } });
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0]).toMatchObject({ source: "approval", phase: "awaiting_me", capabilityType: "fdm", payout: null });
    expect(dto.items[0]!.pay.funding).toBe("unknown");
    expect(dto.items[0]!.refs).toEqual({ approvalId: "appr-1" });
  });

  it("NEGATIVE: a finished job offers no status update, and says why", () => {
    const [item] = work({ kernelJobs: { ok: true, value: [kj(job({ status: "completed", completedAt: "2026-09-23T00:00:00.000Z" }))] } }).items;
    expect(item!.actions).toEqual([
      { op: "update_status", allowed: false, reasonIfNot: "The job is finished.", route: { method: "PATCH", path: "/api/jobs/job-x/status" } },
    ]);
    expect(item!.changedAt).toBe("2026-09-23T00:00:00.000Z");
  });
});

// ── Job offers ──────────────────────────────────────────────────────────────

describe("job offers", () => {
  it("lists an open offer for the caller's capability type, with a claim naming the caller's kernels", () => {
    const dto = work({ openOffers: { ok: true, value: [offer()] } });
    const item = dto.items[0]!;
    expect(item).toMatchObject({ source: "job_offer", phase: "offered", phaseSource: "server", mine: false, title: "Print a bracket" });
    expect(item.actions).toEqual([
      { op: "claim", allowed: true, reasonIfNot: null, route: { method: "POST", path: "/api/job-offers/offer-1/claim" }, kernelIds: ["k-1"] },
    ]);
    expect(item.acceptBy).toBe("2026-09-25T08:00:00.000Z");
    expect(item.evidence).toEqual({
      assuranceTier: 1,
      requirements: { eventsRequired: ["intake", "completion"], photosRequired: true, rawDataRequired: null, chainOfCustody: null, tierRequired: 1 },
      source: "job_offer",
    });
  });

  it("NEGATIVE: a declared price is declared_unfunded, never escrowed", () => {
    const [item] = work({ openOffers: { ok: true, value: [offer()] } }).items;
    expect(item!.pay).toMatchObject({
      amount: "25", amountBaseUnits: "25000000", currency: "USDC", decimals: 6, model: "fixed",
      funding: "declared_unfunded", basis: "job_offer_pricing",
    });
    expect(item!.payout).toBeNull();
    const [quote] = work({ openOffers: { ok: true, value: [offer({ pricing: { amount: 0.1 + 0.2, currency: "USDC", model: "quote-required" } })] } }).items;
    expect(quote!.pay.model).toBe("quote_required");
    expect(quote!.pay.amountBaseUnits).toBeNull();
    const [odd] = work({ openOffers: { ok: true, value: [offer({ pricing: { amount: 5, currency: "DOGE", model: "per-unit", unit: "mile" } })] } }).items;
    expect(odd!.pay).toMatchObject({ amount: "5", decimals: null, amountBaseUnits: null, model: "per_unit", unit: "mile" });
  });

  it("NEGATIVE: an offer for a capability the caller does not offer is not listed", () => {
    expect(work({ openOffers: { ok: true, value: [offer({ capabilityType: "cnc" })] } }).items).toEqual([]);
  });

  it("NEGATIVE: a lapsed offer cannot be claimed, and says why", () => {
    const [item] = work({ openOffers: { ok: true, value: [offer({ validUntil: "2026-09-24T11:00:00.000Z" })] } }).items;
    expect(item!.actions[0]).toMatchObject({ op: "claim", allowed: false, reasonIfNot: "The time to accept this offer has passed." });
  });

  it("an offer not yet the caller's shows an approximate location; a claimed one shows it exactly", () => {
    const [open] = work({ openOffers: { ok: true, value: [offer()] } }).items;
    expect(open!.location).toEqual({ kind: "point", approximate: true, lat: 40.71, lng: -74.01, kernelId: null });
    const claimed = offer({ status: "claimed", claimedByKernelId: "k-1", claimedAt: "2026-09-24T10:00:00.000Z" });
    const [mine] = work({ claimedOffers: { ok: true, value: [{ offer: claimed, events: [{ at: "2026-09-24T10:30:00.000Z", event: "acknowledged" }] }] } }).items;
    expect(mine).toMatchObject({ phase: "accepted", phaseSource: "operator_reported", mine: true, kernelId: "k-1", changedAt: "2026-09-24T10:30:00.000Z" });
    expect(mine!.location).toEqual({ kind: "point", approximate: false, lat: 40.71234, lng: -74.00567, kernelId: null });
    expect(mine!.actions.map((a) => a.op)).toEqual(["report_progress"]);
  });

  it("NEGATIVE: an offer with no location is unknown, not remote", () => {
    const [item] = work({ openOffers: { ok: true, value: [offer({ requirements: {} })] } }).items;
    expect(item!.location.kind).toBe("unknown");
    const [remote] = work({ openOffers: { ok: true, value: [offer({ requirements: { remote: true } })] } }).items;
    expect(remote!.location.kind).toBe("remote");
  });

  it("NEGATIVE: a failed offers read lists no offer at all and says the source is unavailable", () => {
    const claimed = offer({ id: "offer-2", status: "claimed", claimedByKernelId: "k-1" });
    const dto = work({ claimedOffers: { ok: true, value: [{ offer: claimed, events: [] }] }, openOffers: { ok: false } });
    expect(dto.items.filter((i) => i.source === "job_offer")).toEqual([]);
    expect(dto.sources.job_offer).toMatchObject({ state: "unavailable", count: 0, durability: "memory" });
  });
});

// ── Whole DTO ───────────────────────────────────────────────────────────────

describe("OperatorWorkDTO", () => {
  it("describes every source; skill jobs are not attributable, not empty", () => {
    const dto = work();
    expect(dto.schemaId).toBe("pcc.operator-work/v1");
    expect(dto.asOf).toBe(AS_OF);
    expect(dto.kernels).toEqual([{ kernelId: "k-1", name: "Shop One" }]);
    expect(dto.sources.skill_job.state).toBe("not_attributable");
    expect(dto.sources.skill_job.reason).toMatch(/humanDid/);
    expect(dto.sources.kernel_job).toEqual({ state: "read", durability: "durable", count: 0, reason: null });
    expect(dto.sources.job_offer.durability).toBe("memory");
  });

  it("NEGATIVE: a failed job read is unavailable, not an empty list", () => {
    const dto = work({ kernelJobs: { ok: false }, approvals: { ok: false } });
    expect(dto.sources.kernel_job.state).toBe("unavailable");
    expect(dto.sources.approval.state).toBe("unavailable");
  });

  it("puts work awaiting the caller first, then newest first", () => {
    const dto = work({
      kernelJobs: {
        ok: true,
        value: [
          kj(job({ id: "old", status: "executing", startedAt: "2026-09-20T00:00:00.000Z" })),
          kj(job({ id: "new", status: "executing", startedAt: "2026-09-22T00:00:00.000Z" })),
          kj(job({ id: "ask", status: "pending" })),
        ],
      },
      approvals: { ok: true, value: [approval({ jobId: "ask" })] },
    });
    expect(dto.items.map((i) => i.refs.jobId)).toEqual(["ask", "new", "old"]);
  });

  it("says when it cut the list, and counts everything", () => {
    const dto = work({ kernelJobs: { ok: true, value: [kj(job({ id: "a" })), kj(job({ id: "b" })), kj(job({ id: "c" }))] } }, 2);
    expect(dto.items).toHaveLength(2);
    expect(dto.total).toBe(3);
    expect(dto.truncated).toBe(true);
  });
});

// ── Income ──────────────────────────────────────────────────────────────────

describe("OperatorIncomeDTO", () => {
  it("rows are the linked jobs; totals are sums of rows per status and currency", () => {
    const released = linked(escrow({ id: "e1", status: "active" }), [milestone({ status: "released", amount: "12.50" })]);
    const held = linked(escrow({ id: "e2" }), [milestone({ amount: "7.25" })]);
    const held2 = linked(escrow({ id: "e3" }), [milestone({ amount: "0.75" })]);
    const dto = buildOperatorIncomeDTO(
      sources({
        kernelJobs: {
          ok: true,
          value: [kj(job({ id: "r" }), released), kj(job({ id: "h1" }), held), kj(job({ id: "h2" }), held2), kj(job({ id: "none" }))],
        },
      }),
      AS_OF,
    );
    expect(dto.schemaId).toBe("pcc.operator-income/v1");
    expect(dto.rows.map((r) => r.jobId)).toEqual(["r", "h1", "h2"]);
    expect(dto.rows[0]).toMatchObject({ workRef: "kernel_job:r", payout: "reported_released", amountBaseUnits: "12500000", settledAt: null });
    expect(dto.rows[0]!.moneyStatus?.sourceStatus).toBe("released");
    expect(dto.totalsByStatus).toEqual([
      { status: "not_paid", currency: "USDC", decimals: 6, amountBaseUnits: "8000000", rows: 2 },
      { status: "reported_released", currency: "USDC", decimals: 6, amountBaseUnits: "12500000", rows: 1 },
    ]);
    expect(dto.uncountedRows).toBe(0);
  });

  it("NEGATIVE: no history is claimed, and nothing is ever paid", () => {
    const dto = buildOperatorIncomeDTO(sources({ kernelJobs: { ok: true, value: [kj(job(), linked(escrow(), [milestone({ status: "released" })]))] } }), AS_OF);
    expect(dto.historyAvailable).toBe(false);
    expect(dto.reasonIfNot).toBe(INCOME_HISTORY_REASON);
    expect(dto.rows.every((r) => r.payout !== "paid")).toBe(true);
  });

  it("NEGATIVE: rows without a known amount or decimals are counted apart, never summed as zero", () => {
    const dto = buildOperatorIncomeDTO(
      sources({
        kernelJobs: {
          ok: true,
          value: [
            kj(job({ id: "doge" }), linked(escrow({ currency: "DOGE" }))),
            kj(job({ id: "amb" }), { link: "ambiguous", basis: "job_cwm", candidates: 2 }),
            kj(job({ id: "down" }), null),
            // A known currency with an amount that does not convert exactly (7 decimals for USDC).
            kj(job({ id: "inexact" }), linked(escrow(), [milestone({ amount: "1.1234567" })])),
          ],
        },
      }),
      AS_OF,
    );
    expect(dto.rows).toHaveLength(4);
    expect(dto.rows[3]).toMatchObject({ jobId: "inexact", currency: "USDC", decimals: 6, amount: "1.1234567", amountBaseUnits: null });
    expect(dto.totalsByStatus).toEqual([]);
    expect(dto.uncountedRows).toBe(4);
    expect(dto.sources.settlement).toEqual({ state: "partial", unreadableJobs: 1 });
  });

  it("NEGATIVE: an unreadable job store is unavailable, not zero income", () => {
    const dto = buildOperatorIncomeDTO(sources({ kernelJobs: { ok: false } }), AS_OF);
    expect(dto.sources.kernel_jobs.state).toBe("unavailable");
    expect(dto.sources.settlement.state).toBe("unavailable");
  });
});

// ── Routes on a real (in-memory) store ──────────────────────────────────────

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operatorAddress

describe("GET /api/operator/work and /api/operator/income", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const db = await import("../../db.js");
    db.initStore({ seed: true });
    const offers = await import("../../services/job-offers-store.js");
    offers._resetJobOffersStoreForTests();
    const store = offers.initJobOffersStore({});
    await store.create({ capabilityType: "fdm", requirements: { title: "Print a hinge" }, pricing: { amount: 10, currency: "USDC", model: "fixed" } } as any);
    await store.create({ capabilityType: "cnc", requirements: {}, pricing: { amount: 99, currency: "USDC", model: "fixed" } } as any);
    const { operatorWorkRoutes } = await import("../../routes/operator-work.js");
    app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      const p = req.headers["x-test-principal"];
      if (typeof p === "string") (req as any).operatorId = p;
    });
    await app.register(operatorWorkRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    (await import("../../db.js")).closeStore();
    (await import("../../services/job-offers-store.js"))._resetJobOffersStoreForTests();
  });

  const get = (url: string, principal: string | null = OPERATOR_NYC) =>
    app.inject({ method: "GET", url, headers: principal ? { "x-test-principal": principal } : {} });

  it("NEGATIVE: anonymous callers get 401 on both routes", async () => {
    expect((await get("/api/operator/work", null)).statusCode).toBe(401);
    expect((await get("/api/operator/income", null)).statusCode).toBe(401);
  });

  it("lists the operator's own kernel jobs and matching offers, and nothing of another operator's", async () => {
    const res = await get("/api/operator/work");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const dto = res.json();
    expect(dto.kernels.map((k: any) => k.kernelId)).toEqual(["kernel-nyc"]);
    const jobs = dto.items.filter((i: any) => i.source === "kernel_job").map((i: any) => i.refs.jobId).sort();
    expect(jobs).toEqual(expect.arrayContaining(["job-001", "job-003", "job-004"]));
    expect(jobs).not.toContain("job-002"); // kernel-sf's job
    const offersListed = dto.items.filter((i: any) => i.source === "job_offer");
    expect(offersListed.map((i: any) => i.capabilityType)).toEqual(["fdm"]); // not the cnc offer
    expect(dto.sources.skill_job.state).toBe("not_attributable");
  });

  it("matches the principal case-insensitively", async () => {
    const dto = (await get("/api/operator/work", OPERATOR_NYC.toUpperCase().replace("0X", "0x"))).json();
    expect(dto.kernels.map((k: any) => k.kernelId)).toEqual(["kernel-nyc"]);
  });

  it("a caller with no kernels gets an empty, fully described read", async () => {
    const dto = (await get("/api/operator/work", "someone-else@example.invalid")).json();
    expect(dto.kernels).toEqual([]);
    expect(dto.items).toEqual([]);
    expect(dto.sources.kernel_job.state).toBe("read");
  });

  it("validates limit", async () => {
    expect((await get("/api/operator/work?limit=0")).statusCode).toBe(400);
    expect((await get("/api/operator/work?limit=abc")).statusCode).toBe(400);
    const two = (await get("/api/operator/work?limit=2")).json();
    expect(two.items).toHaveLength(2);
    expect(two.truncated).toBe(true);
  });

  it("income lists the operator's linked jobs only, with no history claimed", async () => {
    const res = await get("/api/operator/income");
    expect(res.statusCode).toBe(200);
    const dto = res.json();
    expect(dto.historyAvailable).toBe(false);
    for (const r of dto.rows) {
      expect(r.kernelId).toBe("kernel-nyc");
      expect(r.payout).not.toBe("paid");
    }
  });
});
