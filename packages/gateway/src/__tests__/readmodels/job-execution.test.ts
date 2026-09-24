/**
 * JobExecutionDTO (PX-6): the pure builder, the loader, and GET /api/jobs/:jobId/execution.
 *
 * The negative tests are the point. Each one pins a lie the old surfaces told:
 *   - completed was rendered as settled (paid inferred from completion)
 *   - evidence existing was treated as verified
 *   - a refund could render as paid
 *   - an unknown status could inherit success
 *   - a failed read fell back to plausible data
 *   - a missing timestamp was filled with "now"
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { JOB_EXECUTION_SCHEMA_ID, type JobExecutionDTO } from "@pcc/spec";
import {
  authorizeJobRead,
  buildJobExecutionDTO,
  hasValidAdminKey,
  loadJobExecutionSources,
  reconcilePayout,
  type JobExecutionSources,
  type JobRow,
  type SettlementSource,
} from "../../readmodels/job-execution.js";
import { jobRoutes } from "../../routes/jobs.js";
import { initStore, closeStore, getStore } from "../../db.js";
import { JOB_STATUSES } from "../../config/job-status.js";
import { executionPhaseOf } from "@pcc/spec";

const AS_OF = "2026-09-24T12:00:00.000Z";

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
    capability: { ok: true, value: { type: "fdm", name: "FDM print" } },
    kernel: { ok: true, value: { name: "Kernel X" } },
    evidence: { ok: true, value: [] },
    captureVerdicts: { ok: true, value: [] },
    settlement: { ok: true, value: { link: "not_linked" } },
    ...over,
  };
}

const escrow = (over: Record<string, unknown> = {}) => ({
  id: "esc-x",
  contractAddress: "0x1111111111111111111111111111111111111111",
  totalAmount: "12.00",
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
  challengeWindowEnd: null,
  ...over,
});

function linked(e = escrow(), ms = [milestone()]): SettlementSource {
  return {
    link: "linked",
    basis: "negotiation_session_escrow_address",
    matches: ["negotiation_session_escrow_address", "negotiation_session_cwm"],
    escrow: e as any,
    milestones: ms as any,
  };
}

const build = (s: Partial<JobExecutionSources>) => buildJobExecutionDTO(sources(s), AS_OF);

// ── Pure builder ─────────────────────────────────────────────────────────────

describe("buildJobExecutionDTO: shape and provenance", () => {
  it("carries the schema id, the read time and the source of every axis", () => {
    const dto = build({});
    expect(dto.schemaId).toBe(JOB_EXECUTION_SCHEMA_ID);
    expect(dto.asOf).toBe(AS_OF);
    expect(dto.execution.source).toBe("gateway_job_row");
    expect(dto.evidence.source).toBe("gateway_evidence_store");
    expect(dto.verification.captureChecks.source).toBe("gateway_capture_verdicts");
    expect(dto.settlement.source).toBe("gateway_escrow_record");
    expect(dto.job).toMatchObject({ jobId: "job-x", capabilityType: "fdm", kernelName: "Kernel X", contractedTier: 1 });
  });

  it("never fabricates a timestamp: missing source times stay null", () => {
    const dto = build({ job: job({ startedAt: null, completedAt: null }) });
    expect(dto.job.createdAt).toBeNull();
    expect(dto.execution.completedAt).toBeNull();
    expect(dto.evidence.latestStoredAt).toBeNull();
    expect(dto.verification.captureChecks.latestAt).toBeNull();
  });

  it("reports a legacy row without a recorded tier as null, not tier 0", () => {
    expect(build({ job: job({ assuranceTier: null }) }).job.contractedTier).toBeNull();
  });
});

describe("execution axis", () => {
  it("reports progress only when the executor reported it while running", () => {
    expect(build({ job: job({ status: "executing", progress: 40 }) }).execution.progressPercent).toBe(40);
    // A queued row stores 0 by default: that is not a report.
    expect(build({ job: job({ status: "queued", progress: 0 }) }).execution.progressPercent).toBeNull();
    expect(build({ job: job({ status: "executing", progress: 0 }) }).execution.progressPercent).toBeNull();
    // Completion is the phase itself, not a progress number.
    expect(build({ job: job({ status: "completed", progress: 100 }) }).execution.progressPercent).toBeNull();
  });

  it("NEGATIVE: an undocumented status is unknown, not terminal, and raises a notice", () => {
    const dto = build({ job: job({ status: "done" }) });
    expect(dto.execution.phase).toBe("unknown");
    expect(dto.execution.terminal).toBe(false);
    expect(dto.execution.sourceStatus).toBe("done");
    expect(dto.notices).toContain("unknown_execution_status");
  });

  it("covers every canonical gateway job status", () => {
    for (const s of JOB_STATUSES) expect(executionPhaseOf(s), s).not.toBe("unknown");
  });
});

describe("NEGATIVE: completed is never paid", () => {
  it("a completed job with no linked settlement record has payout unknown, not paid", () => {
    const dto = build({ job: job({ status: "completed", completedAt: "2026-09-21T10:00:00.000Z" }) });
    expect(dto.execution.phase).toBe("completed");
    expect(dto.settlement.link).toBe("not_linked");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("a completed job whose milestone is still funded is not_paid", () => {
    const dto = build({ job: job({ status: "completed" }), settlement: { ok: true, value: linked() } });
    expect(dto.settlement.payout).toBe("not_paid");
    expect(dto.settlement.payoutBasis).toBe("milestone_record");
  });

  it("a job row that says `settled` does not make the payout paid", () => {
    const dto = build({ job: job({ status: "settled" }), settlement: { ok: true, value: { link: "not_linked" } } });
    expect(dto.execution.phase).toBe("completed");
    expect(dto.settlement.payout).toBe("unknown");
    expect(dto.notices).toContain("job_row_reports_settled");
  });

  it("NEGATIVE: a row saying `settled` over an unreleased or refunded milestone is unknown, never not_paid (records conflict)", () => {
    // SettlementService.releaseMilestone updates only the job row after an on-chain
    // release, so the milestone record can lag a real payment: "not paid" would be false.
    for (const status of ["funded", "refunded"]) {
      const dto = build({ job: job({ status: "settled" }), settlement: { ok: true, value: linked(escrow(), [milestone({ status })]) } });
      expect(dto.settlement.payout, status).toBe("unknown");
      expect(dto.notices).toEqual(expect.arrayContaining(["job_row_reports_settled", "settlement_row_conflict"]));
      expect(dto.notices).not.toContain("settlement_records_conflict");
    }
    // Agreement stays paid; the row alone never pays.
    const agree = build({ job: job({ status: "settled" }), settlement: { ok: true, value: linked(escrow(), [milestone({ status: "released" })]) } });
    expect(agree.settlement.payout).toBe("paid");
    expect(agree.notices).not.toContain("settlement_row_conflict");
  });
});

describe("settlement axis", () => {
  it("paid only when the job's own milestone says released and the escrow does not contradict it", () => {
    const dto = build({ settlement: { ok: true, value: linked(escrow({ status: "active" }), [milestone({ status: "released" })]) } });
    expect(dto.settlement.payout).toBe("paid");
    expect(dto.settlement.payoutBasis).toBe("milestone_record");
    // A record claim, qualified as such: no chain receipt confirms it, and no status time exists.
    expect(dto.settlement.payoutConfirmation).toBe("record_only");
    expect(dto.settlement.record?.statusObservedAt).toBeNull();
    expect(dto.settlement.record?.milestone?.status).toMatchObject({ sourceStatus: "released", tone: "settled", known: true });
    expect(dto.settlement.record?.kind).toBe("gateway_escrow_record");
    expect(dto.settlement.linkMatches).toEqual(["negotiation_session_escrow_address", "negotiation_session_cwm"]);
  });

  it("NEGATIVE (review P1-3): a released milestone never beats a refunded, disputed or unrecognized escrow", () => {
    for (const e of ["refunded", "disputed", "slashed", "expired", "mystery-state"]) {
      const dto = build({ settlement: { ok: true, value: linked(escrow({ status: e }), [milestone({ status: "released" })]) } });
      expect(dto.settlement.payout, e).toBe("unknown");
      expect(dto.settlement.payoutConfirmation, e).toBeNull();
    }
    const conflict = build({ settlement: { ok: true, value: linked(escrow({ status: "refunded" }), [milestone({ status: "released" })]) } });
    expect(conflict.notices).toContain("settlement_records_conflict");
  });

  it("NEGATIVE (review P1-3): an escrow saying everything was released never pays an unreleased milestone", () => {
    const dto = build({ settlement: { ok: true, value: linked(escrow({ status: "completed" }), [milestone({ status: "funded" })]) } });
    expect(dto.settlement.payout).toBe("unknown");
    expect(dto.notices).toContain("settlement_records_conflict");
  });

  it("reconcilePayout: the full milestone x escrow tone table", () => {
    const v = (s: string, vocabulary: "escrow_record" | "escrow_milestone") => {
      const dto = build({ settlement: { ok: true, value: linked(escrow({ status: vocabulary === "escrow_record" ? s : "active" }), [milestone({ status: vocabulary === "escrow_milestone" ? s : "funded" })]) } });
      return vocabulary === "escrow_record" ? dto.settlement.record!.escrow : dto.settlement.record!.milestone!.status;
    };
    const released = v("released", "escrow_milestone");
    const funded = v("funded", "escrow_milestone");
    const refundedM = v("refunded", "escrow_milestone");
    const active = v("active", "escrow_record");
    const completed = v("completed", "escrow_record");
    const refundedE = v("refunded", "escrow_record");
    const unknownE = v("??", "escrow_record");
    expect(reconcilePayout(released, active)).toEqual({ payout: "paid", conflict: false });
    expect(reconcilePayout(released, completed)).toEqual({ payout: "paid", conflict: false });
    expect(reconcilePayout(released, refundedE)).toEqual({ payout: "unknown", conflict: true });
    expect(reconcilePayout(refundedM, active)).toEqual({ payout: "refunded", conflict: false });
    expect(reconcilePayout(refundedM, completed)).toEqual({ payout: "unknown", conflict: true });
    expect(reconcilePayout(funded, active)).toEqual({ payout: "not_paid", conflict: false });
    expect(reconcilePayout(funded, refundedE)).toEqual({ payout: "not_paid", conflict: false });
    expect(reconcilePayout(funded, completed)).toEqual({ payout: "unknown", conflict: true });
    expect(reconcilePayout(released, unknownE)).toEqual({ payout: "unknown", conflict: false });
  });

  it("NEGATIVE: a refund is refunded (or unknown), never paid", () => {
    for (const [e, m, want] of [
      ["refunded", "refunded", "refunded"],
      ["refunded", "funded", "not_paid"],
      ["active", "refunded", "refunded"],
      ["refunded", "released", "unknown"],
    ] as const) {
      const dto = build({ settlement: { ok: true, value: linked(escrow({ status: e }), [milestone({ status: m })]) } });
      expect(dto.settlement.payout, `${e}/${m}`).toBe(want);
    }
  });

  it("NEGATIVE: an unknown money status is unknown, never paid", () => {
    const dto = build({ settlement: { ok: true, value: linked(escrow(), [milestone({ status: "success" })]) } });
    expect(dto.settlement.record?.milestone?.status.tone).toBe("unknown");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: a mock-settlement escrow is simulated, never paid, even when released", () => {
    const dto = build({
      settlement: {
        ok: true,
        value: linked(escrow({ contractAddress: "mock-escrow-lx9k2", status: "completed" }), [milestone({ status: "released" })]),
      },
    });
    expect(dto.settlement.record?.simulated).toBe(true);
    expect(dto.settlement.payout).toBe("simulated");
    expect(dto.notices).toContain("simulated_settlement");
  });

  it("NEGATIVE (review P1-2): an escrow with no milestone rows never pays this job, whatever its status", () => {
    for (const e of ["completed", "released", "refunded", "funded"]) {
      const dto = build({ settlement: { ok: true, value: linked(escrow({ status: e }), []) } });
      expect(dto.settlement.record?.milestoneMatch, e).toBe("no_milestones");
      expect(dto.settlement.payout, e).toBe("unknown");
      expect(dto.settlement.payoutBasis, e).toBeNull();
    }
  });

  it("NEGATIVE: other steps' releases never pay this job (step not in the escrow)", () => {
    const dto = build({
      settlement: { ok: true, value: linked(escrow({ status: "completed" }), [milestone({ stepId: "other-step", status: "released" })]) },
    });
    expect(dto.settlement.record?.milestoneMatch).toBe("step_not_in_escrow");
    expect(dto.settlement.payout).toBe("unknown");
    expect(dto.settlement.payoutBasis).toBeNull();
  });

  it("NEGATIVE: two milestones for the job's step is ambiguous: nothing is chosen", () => {
    const dto = build({
      settlement: { ok: true, value: linked(escrow({ status: "completed" }), [milestone({ id: "a", status: "released" }), milestone({ id: "b" })]) },
    });
    expect(dto.settlement.record?.milestoneMatch).toBe("ambiguous");
    expect(dto.settlement.record?.milestone).toBeNull();
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: more than one candidate escrow is ambiguous with no record", () => {
    const dto = build({ settlement: { ok: true, value: { link: "ambiguous", basis: "job_cwm", candidates: 2 } } });
    expect(dto.settlement.link).toBe("ambiguous");
    expect(dto.settlement.record).toBeNull();
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: conflicting identifiers carry no record, payout unknown, and a notice", () => {
    const dto = build({ settlement: { ok: true, value: { link: "conflicting", reason: "x" } } });
    expect(dto.settlement.link).toBe("conflicting");
    expect(dto.settlement.record).toBeNull();
    expect(dto.settlement.linkMatches).toEqual([]);
    expect(dto.settlement.payout).toBe("unknown");
    expect(dto.notices).toContain("settlement_link_conflict");
  });

  it("labels amounts as recorded amounts, not paid amounts", () => {
    const dto = build({ settlement: { ok: true, value: linked() } });
    expect(dto.settlement.record?.escrowTotal).toEqual({ amount: "12.00", currency: "USDC" });
    expect(Object.keys(dto.settlement)).not.toContain("paidAmount");
  });
});

describe("NEGATIVE: evidence is never verification", () => {
  const bundle = (id: string, createdAt: string, events: unknown[]) => ({
    id,
    jobId: "job-x",
    stepId: "step-x",
    assuranceTier: 2,
    bundleHash: `sha256:${id}`,
    kernelSignature: { signer: "0xabc", algorithm: "secp256k1", value: "sig" },
    createdAt,
    events: events as any,
  });

  it("received evidence leaves the outcome verification not_available", () => {
    const dto = build({
      evidence: { ok: true, value: [bundle("b1", "2026-09-21T10:00:00.000Z", [{ source: {}, payload: {} }])] },
    });
    expect(dto.evidence.state).toBe("received");
    expect(dto.evidence.bundles[0]?.claimedTier).toBe(2);
    expect(dto.verification.outcome.state).toBe("not_available");
    // No field anywhere asserts verification from evidence.
    expect(JSON.stringify(dto.evidence)).not.toMatch(/"verified"/);
  });

  it("counts fabricated-by-design events with the canonical predicate", () => {
    const dto = build({
      evidence: {
        ok: true,
        value: [
          bundle("b1", "2026-09-21T10:00:00.000Z", [
            { source: { simulated: true }, payload: {} },
            { source: {}, payload: { mock: true } },
            { source: {}, payload: {} },
          ]),
        ],
      },
    });
    expect(dto.evidence.eventCount).toBe(3);
    expect(dto.evidence.fabricatedEventCount).toBe(2);
    expect(dto.evidence.bundles[0]?.fabricatedEventCount).toBe(2);
    expect(dto.notices).toContain("fabricated_evidence");
  });

  it("lists bundles newest first, caps the list, and keeps totals over all bundles", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      bundle(`b${i}`, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(), [{ source: {}, payload: {} }]),
    );
    const dto = build({ evidence: { ok: true, value: many } });
    expect(dto.evidence.bundleCount).toBe(25);
    expect(dto.evidence.bundles).toHaveLength(20);
    expect(dto.evidence.truncated).toBe(true);
    expect(dto.evidence.eventCount).toBe(25);
    expect(dto.evidence.bundles[0]?.bundleId).toBe("b24");
    expect(dto.evidence.latestStoredAt).toBe(many[24]!.createdAt);
  });

  it("capture checks are counted as capture checks, and never verify the outcome", () => {
    const dto = build({
      captureVerdicts: {
        ok: true,
        value: [
          { id: "v1", verdict: "PASS", declaredClassStr: "CC2", verifiedClassStr: "CC2", createdAt: "2026-09-21T10:00:00.000Z" },
          { id: "v2", verdict: "FAIL", declaredClassStr: "CC3", verifiedClassStr: "CC1", createdAt: "2026-09-21T11:00:00.000Z" },
          { id: "v3", verdict: "MAYBE", declaredClassStr: "CC1", verifiedClassStr: "CC0", createdAt: "2026-09-21T09:00:00.000Z" },
        ],
      },
    });
    const cc = dto.verification.captureChecks;
    expect(cc.state).toBe("present");
    expect([cc.pass, cc.fail, cc.partial, cc.unrecognized]).toEqual([1, 1, 0, 1]);
    expect(cc.items[0]?.verdictId).toBe("v2");
    expect(cc.items.find((i) => i.verdictId === "v3")?.verdict).toBe("unknown");
    expect(dto.verification.outcome.state).toBe("not_available");
  });
});

describe("NEGATIVE: a failed read is unavailable, never a fallback", () => {
  it("evidence read failure: unavailable with null counts, not an empty 'none'", () => {
    const dto = build({ evidence: { ok: false } });
    expect(dto.evidence.state).toBe("unavailable");
    expect(dto.evidence.bundleCount).toBeNull();
    expect(dto.evidence.eventCount).toBeNull();
    expect(dto.evidence.error?.code).toBe("source_read_failed");
  });

  it("settlement read failure: unavailable, payout unknown, no record", () => {
    const dto = build({ job: job({ status: "settled" }), settlement: { ok: false } });
    expect(dto.settlement.link).toBe("unavailable");
    expect(dto.settlement.payout).toBe("unknown");
    expect(dto.settlement.record).toBeNull();
    expect(dto.settlement.error?.code).toBe("source_read_failed");
  });

  it("capture verdict read failure: unavailable with null counts", () => {
    const cc = build({ captureVerdicts: { ok: false } }).verification.captureChecks;
    expect(cc.state).toBe("unavailable");
    expect(cc.pass).toBeNull();
    expect(cc.error?.code).toBe("source_read_failed");
  });

  it("label read failure: null labels, the axes are unaffected", () => {
    const dto = build({ capability: { ok: false }, kernel: { ok: false } });
    expect(dto.job.capabilityType).toBeNull();
    expect(dto.job.kernelName).toBeNull();
    expect(dto.execution.phase).toBe("queued");
  });

  it("a read error message is generic: no internal detail leaks", () => {
    const dto = build({ evidence: { ok: false } });
    expect(dto.evidence.error?.message).toBe("The evidence store could not be read.");
  });
});

// ── Loader + route against a real (in-memory) store ─────────────────────────

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operatorAddress
const ADMIN_KEY = "test-admin-key-for-job-execution";

describe("GET /api/jobs/:jobId/execution", () => {
  let app: FastifyInstance;
  const now = "2026-09-24T10:00:00.000Z";

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    app = Fastify({ logger: false });
    // Stand-in for the API gate: it sets req.operatorId from the API key.
    app.addHook("onRequest", async (req) => {
      const p = req.headers["x-test-principal"];
      if (typeof p === "string") (req as any).operatorId = p;
    });
    await app.register(jobRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
    delete process.env.TENANT_ENFORCE;
    delete process.env.PCC_ADMIN_KEY;
  });

  const get = async (id: string, principal: string | null = OPERATOR_NYC, headers: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url: `/api/jobs/${id}/execution`,
      headers: { ...(principal ? { "x-test-principal": principal } : {}), ...headers },
    });

  const insertEscrow = (id: string, cwmId: string, contractAddress: string, status: string) =>
    getStore().repos.escrows.insert({
      id, cwmId, contractAddress, payer: "0xpayer", totalAmount: "30.00", currency: "USDC",
      status, createdAt: now, deadline: now, version: "v3",
    } as any);
  const insertMilestone = (id: string, escrowId: string, stepId: string, status: string) =>
    getStore().repos.escrows.insertMilestone({ id, escrowId, stepId, amount: "30.00", status, bondAmount: "0" } as any);
  const insertJob = (id: string, stepId: string, cwmId: string, extra: Record<string, unknown> = {}) =>
    getStore().repos.jobs.insert({
      id, stepId, cwmId, capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc", status: "completed",
      assignedDevices: [], startedAt: now, progress: 100, ...extra,
    } as any);
  const insertSession = async (id: string, jobId: string, fields: Record<string, unknown>) => {
    const { schema } = await import("@pcc/store");
    getStore().db.insert(schema.negotiationSessions).values({
      id, status: "committed", userAgentId: "agent-buyer-1", kernelId: "kernel-nyc", capabilityType: "fdm",
      operatorConstraints: {}, jobId, createdAt: now, expiresAt: now, ...fields,
    } as any).run();
  };

  it("GET /api/jobs keeps { jobs } and adds collection-v1 items, the true total and asOf", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs?limit=2" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.items).toEqual(body.jobs);
    expect(body.jobs).toHaveLength(2);
    expect(body.total).toBeGreaterThan(2);
    expect(body.hasMore).toBe(true);
    expect(Date.parse(body.asOf)).not.toBeNaN();
    for (const j of body.jobs) expect(typeof j.executionPhase).toBe("string");
  });

  it("404s an unknown job", async () => {
    const res = await get("no-such-job");
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("links a legacy (no-session) job by its CWM and refuses to pay it from sibling steps", async () => {
    // Seed: job-004 (cwm-001, step-4, completed); escrow esc-001 (cwm-001) has milestones for
    // other steps only (one released): the record does not cover this job.
    const res = await get("job-004");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const dto = res.json() as JobExecutionDTO;
    expect(dto.schemaId).toBe(JOB_EXECUTION_SCHEMA_ID);
    expect(Date.parse(dto.asOf)).not.toBeNaN();
    expect(dto.execution.phase).toBe("completed");
    expect(dto.settlement.link).toBe("linked");
    expect(dto.settlement.linkBasis).toBe("job_cwm");
    expect(dto.settlement.linkMatches).toEqual(["job_cwm"]);
    expect(dto.settlement.record?.escrowId).toBe("esc-001");
    expect(dto.settlement.record?.milestoneMatch).toBe("step_not_in_escrow");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("links a paid-job-flow job through its session; completed + funded is not_paid", async () => {
    insertEscrow("esc-rm-1", "cwm-rm-1", "0x2222222222222222222222222222222222222222", "funded");
    insertMilestone("ms-rm-1", "esc-rm-1", "step-rm-1", "funded");
    insertJob("job-rm-1", "step-rm-1", "cwm-rm-1", { assuranceTier: 2 });
    await insertSession("neg-rm-1", "job-rm-1", { escrowAddress: "0x2222222222222222222222222222222222222222", cwmId: "cwm-rm-1" });
    const dto = (await get("job-rm-1")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("linked");
    expect(dto.settlement.linkBasis).toBe("negotiation_session_escrow_address");
    expect(dto.settlement.linkMatches).toEqual(["negotiation_session_escrow_address", "negotiation_session_cwm", "job_cwm"]);
    expect(dto.settlement.record?.milestoneMatch).toBe("exact");
    expect(dto.settlement.payout).toBe("not_paid");
    expect(dto.job.contractedTier).toBe(2);
  });

  it("NEGATIVE (review P1-1 counterexample): an unrelated escrow matching the job's CWM is never picked", async () => {
    // The session's address names the REAL funded escrow; the session's CWM has no row; the
    // job row's CWM matches an unrelated COMPLETED escrow with a released milestone.
    insertEscrow("esc-ce-real", "cwm-ce-real", "0xaaaa000000000000000000000000000000000001", "funded");
    insertMilestone("ms-ce-real", "esc-ce-real", "s-ce", "funded");
    insertEscrow("esc-ce-unrelated", "cwm-ce-job", "0xbbbb000000000000000000000000000000000002", "completed");
    insertMilestone("ms-ce-unrelated", "esc-ce-unrelated", "s-ce", "released");
    insertJob("job-ce", "s-ce", "cwm-ce-job");
    await insertSession("neg-ce", "job-ce", { cwmId: "cwm-ce-sess", escrowAddress: "0xaaaa000000000000000000000000000000000001" });
    const dto = (await get("job-ce")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("conflicting");
    expect(dto.settlement.record).toBeNull();
    expect(dto.settlement.payout).toBe("unknown");
    expect(dto.notices).toContain("settlement_link_conflict");
  });

  it("NEGATIVE: the escrow at the session's address contradicting the session's CWM is conflicting", async () => {
    insertEscrow("esc-cc", "cwm-cc-other", "0xcccc000000000000000000000000000000000003", "active");
    insertMilestone("ms-cc", "esc-cc", "s-cc", "released");
    insertJob("job-cc", "s-cc", "cwm-cc-jobrandom");
    await insertSession("neg-cc", "job-cc", { cwmId: "cwm-cc-sess", escrowAddress: "0xcccc000000000000000000000000000000000003" });
    const dto = (await get("job-cc")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("conflicting");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: the session's address and the job's CWM naming different escrows is conflicting (no first-pick)", async () => {
    // The session records only an address; the job's CWM names a DIFFERENT escrow. Each
    // lookup alone is unique, and neither escrow contradicts the session's (absent) CWM.
    insertEscrow("esc-2w-a", "cwm-2w-a", "0xf0f0000000000000000000000000000000000006", "funded");
    insertMilestone("ms-2w-a", "esc-2w-a", "s-2w", "funded");
    insertEscrow("esc-2w-b", "cwm-2w-job", "0xf1f1000000000000000000000000000000000007", "completed");
    insertMilestone("ms-2w-b", "esc-2w-b", "s-2w", "released");
    insertJob("job-2w", "s-2w", "cwm-2w-job");
    await insertSession("neg-2w", "job-2w", { cwmId: null, escrowAddress: "0xf0f0000000000000000000000000000000000006" });
    const dto = (await get("job-2w")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("conflicting");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: an escrow found by the session's CWM but not at the session's recorded address is conflicting", async () => {
    // Nothing exists at the address the session recorded; the session's CWM finds an escrow
    // at another address. The session's own records disagree, so no link is proven.
    insertEscrow("esc-addr-miss", "cwm-addr-miss", "0xf2f2000000000000000000000000000000000008", "completed");
    insertMilestone("ms-addr-miss", "esc-addr-miss", "s-am", "released");
    insertJob("job-addr-miss", "s-am", "cwm-addr-miss");
    await insertSession("neg-addr-miss", "job-addr-miss", {
      cwmId: "cwm-addr-miss",
      escrowAddress: "0xf3f3000000000000000000000000000000000009",
    });
    const dto = (await get("job-addr-miss")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("conflicting");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: two escrow rows at the session's address are ambiguous (address cardinality is checked)", async () => {
    insertEscrow("esc-dup-1", "cwm-dup", "0xdddd000000000000000000000000000000000004", "completed");
    insertEscrow("esc-dup-2", "cwm-dup-2", "0xdddd000000000000000000000000000000000004", "completed");
    insertJob("job-dup-addr", "s-dup", "cwm-dup-jobrandom");
    await insertSession("neg-dup", "job-dup-addr", { cwmId: null, escrowAddress: "0xdddd000000000000000000000000000000000004" });
    const dto = (await get("job-dup-addr")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("ambiguous");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: a session recording no escrow does not let the job's CWM prove a link", async () => {
    insertEscrow("esc-nx", "cwm-nx", "0xeeee000000000000000000000000000000000005", "completed");
    insertMilestone("ms-nx", "esc-nx", "s-nx", "released");
    insertJob("job-nx", "s-nx", "cwm-nx");
    await insertSession("neg-nx", "job-nx", { cwmId: null, escrowAddress: null });
    const dto = (await get("job-nx")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("conflicting");
    expect(dto.settlement.payout).toBe("unknown");
  });

  it("NEGATIVE: two escrow records for the job's cwm are ambiguous: none is chosen", async () => {
    insertEscrow("esc-rm-dup-a", "cwm-rm-dup", "0x3000000000000000000000000000000000000000", "completed");
    insertEscrow("esc-rm-dup-b", "cwm-rm-dup", "0x4000000000000000000000000000000000000000", "completed");
    insertJob("job-rm-dup", "s-dup", "cwm-rm-dup");
    const dto = (await get("job-rm-dup")).json() as JobExecutionDTO;
    expect(dto.settlement.link).toBe("ambiguous");
    expect(dto.settlement.linkBasis).toBeNull();
    expect(dto.settlement.record).toBeNull();
    expect(dto.settlement.payout).toBe("unknown");
  });

  describe("NEGATIVE (review P1-5): object authorization, independent of the tenant flag", () => {
    for (const enforce of [false, true]) {
      describe(`TENANT_ENFORCE=${enforce}`, () => {
        beforeAll(() => {
          if (enforce) process.env.TENANT_ENFORCE = "true";
          else delete process.env.TENANT_ENFORCE;
        });
        afterAll(() => {
          delete process.env.TENANT_ENFORCE;
        });

        it("anonymous callers get 401", async () => {
          expect((await get("job-rm-1", null)).statusCode).toBe(401);
        });

        it("a stranger (neither operator nor buyer) gets 404, not the job", async () => {
          const res = await get("job-rm-1", "0x9999999999999999999999999999999999999999");
          expect(res.statusCode).toBe(404);
          expect(res.body).not.toContain("esc-rm-1");
        });

        it("the kernel operator reads it (case-insensitive principal)", async () => {
          expect((await get("job-rm-1", OPERATOR_NYC.toUpperCase().replace("0X", "0x"))).statusCode).toBe(200);
        });

        it("the recorded buyer reads it", async () => {
          expect((await get("job-rm-1", "agent-buyer-1")).statusCode).toBe(200);
        });

        it("an admin key reads it; a wrong admin key does not", async () => {
          process.env.PCC_ADMIN_KEY = ADMIN_KEY;
          try {
            expect((await get("job-rm-1", null, { "x-admin-key": ADMIN_KEY })).statusCode).toBe(200);
            expect((await get("job-rm-1", null, { "x-admin-key": ADMIN_KEY + "x" })).statusCode).toBe(401);
            expect((await get("job-rm-1", "0x9999999999999999999999999999999999999999", { "x-admin-key": "nope" })).statusCode).toBe(404);
          } finally {
            delete process.env.PCC_ADMIN_KEY;
          }
        });
      });
    }

    it("under TENANT_ENFORCE a job of another tenant is a 404 even for its operator", async () => {
      insertJob("job-rm-tenant", "s", "cwm-rm-tenant", { status: "queued", progress: 0, tenantId: "tenant-a" });
      process.env.TENANT_ENFORCE = "true";
      try {
        expect((await get("job-rm-tenant")).statusCode).toBe(404);
      } finally {
        delete process.env.TENANT_ENFORCE;
      }
      expect((await get("job-rm-tenant")).statusCode).toBe(200);
    });

    it("hasValidAdminKey: unset key grants nothing; comparison is exact", () => {
      expect(hasValidAdminKey("anything", undefined)).toBe(false);
      expect(hasValidAdminKey("anything", "")).toBe(false);
      expect(hasValidAdminKey(undefined, "k")).toBe(false);
      expect(hasValidAdminKey("k", "k")).toBe(true);
      expect(hasValidAdminKey("k ", "k")).toBe(false);
    });

    it("authorizeJobRead: a job with two sessions records no single buyer", async () => {
      insertJob("job-two-sess", "s-2", "cwm-two");
      await insertSession("neg-two-a", "job-two-sess", { userAgentId: "agent-x" });
      await insertSession("neg-two-b", "job-two-sess", { userAgentId: "agent-y" });
      const job = getStore().repos.jobs.findById("job-two-sess") as any;
      expect(authorizeJobRead(job, { principal: "agent-x" }, getStore().repos as any, getStore().db).allow).toBe(false);
    });
  });

  it("NEGATIVE: an evidence-store failure is reported, not hidden (loader)", () => {
    const { db, repos } = getStore();
    const broken = {
      ...(repos as any),
      evidence: {
        ...(repos as any).evidence,
        findByJob: () => {
          throw new Error("disk I/O error at /app/data/pcc.db");
        },
        findCaptureVerdictsByJob: (id: string) => (repos as any).evidence.findCaptureVerdictsByJob(id),
        findEventsByBundle: (id: string) => (repos as any).evidence.findEventsByBundle(id),
      },
    };
    const seen: string[] = [];
    const job = repos.jobs.findById("job-004") as any;
    const src = loadJobExecutionSources(job, broken, db, { onReadError: (s) => seen.push(s) });
    expect(src.evidence.ok).toBe(false);
    expect(seen).toEqual(["evidence"]);
    const dto = buildJobExecutionDTO(src, AS_OF);
    expect(dto.evidence.state).toBe("unavailable");
    expect(JSON.stringify(dto)).not.toContain("/app/data");
  });
});
