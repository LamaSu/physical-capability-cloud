/**
 * The job read family is object-authorized (readmodels F3; gateway #2831): every route that
 * returns a job, its status, evidence, drift alerts or money runs gateJobRead first, the same
 * predicate as GET /api/jobs/:jobId/execution (#353). Only an admin, the job's kernel
 * operator or its recorded buyer reads it. Anonymous callers get 401. Anyone else gets exactly
 * the route's answer for a job that does not exist, so the refusal reveals nothing.
 *
 * Before: any API key read any job's record, status, evidence, drift alerts and settlement.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

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
  submitEvidence: vi.fn(),
  releaseMilestone: vi.fn(),
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
  flushSettlements: vi.fn(),
  getQueueStatus: vi.fn().mockReturnValue({ pending: 0, totalValue: 0n, oldestIntentAge: 0 }),
  getEpochHistory: vi.fn().mockReturnValue([]),
  initBatchSettlement: vi.fn().mockResolvedValue(undefined),
  stopBatchSettlement: vi.fn(),
}));
vi.setConfig({ testTimeout: 20000 });

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const STRANGER = "0x9999999999999999999999999999999999999999";
const BUYER = "agent-buyer-f3";
const ADMIN = "test-admin-key-f3";
const JOB = "job-f3";
const now = "2026-09-24T10:00:00.000Z";

/** Every read in the family: [label, url for a job id]. */
const FAMILY: Array<[string, (id: string) => string]> = [
  ["GET /api/jobs/:jobId", (id) => `/api/jobs/${id}`],
  ["GET /api/jobs/:jobId/execution", (id) => `/api/jobs/${id}/execution`],
  ["GET /api/jobs/:jobId/status", (id) => `/api/jobs/${id}/status`],
  ["GET /api/jobs/:jobId/settlement", (id) => `/api/jobs/${id}/settlement`],
  ["GET /api/jobs/:jobId/evidence", (id) => `/api/jobs/${id}/evidence`],
  ["GET /api/jobs/:jobId/drift-alerts", (id) => `/api/jobs/${id}/drift-alerts`],
  ["GET /api/settlement/:jobId", (id) => `/api/settlement/${id}`],
  ["GET /api/evidence/:jobId", (id) => `/api/evidence/${id}`],
];

describe("F3: the job read family is object-authorized", () => {
  let app: FastifyInstance;
  let getStore: typeof import("../../db.js").getStore;

  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    process.env.MOCK_SETTLEMENT = "true";
    process.env.PCC_ADMIN_KEY = ADMIN;
    const db = await import("../../db.js");
    getStore = db.getStore;
    db.initStore({ seed: true });
    const { schema } = await import("@pcc/store");
    const store = getStore();
    store.repos.jobs.insert({
      id: JOB, stepId: "step-f3", cwmId: "cwm-f3", capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc",
      status: "executing", assignedDevices: [], startedAt: now, progress: 10,
    } as any);
    store.db.insert(schema.negotiationSessions).values({
      id: "neg-f3", status: "committed", userAgentId: BUYER, kernelId: "kernel-nyc", capabilityType: "fdm",
      operatorConstraints: {}, jobId: JOB, createdAt: now, expiresAt: now,
    } as any).run();
    store.repos.jobs.insert({
      id: "job-f3-tenant", stepId: "s", cwmId: "cwm-f3-t", capabilityId: "cap-nyc-fdm", kernelId: "kernel-nyc",
      status: "queued", assignedDevices: [], startedAt: now, progress: 0, tenantId: "tenant-a",
    } as any);

    const { jobRoutes } = await import("../../routes/jobs.js");
    const { jobSubmitRoutes } = await import("../../routes/job-submit.js");
    const { complianceRoutes } = await import("../../routes/compliance.js");
    const { paidJobFlowRoutes } = await import("../../routes/paid-job-flow.js");
    const { settlementRoutes } = await import("../../routes/settlement.js");
    app = Fastify({ logger: false });
    // Stand-in for the API gate.
    app.addHook("onRequest", async (req) => {
      const p = req.headers["x-test-principal"];
      if (typeof p === "string") (req as any).operatorId = p;
      const t = req.headers["x-test-tenant"];
      if (typeof t === "string") (req as any).tenantId = t;
    });
    await app.register(jobRoutes);
    await app.register(jobSubmitRoutes);
    await app.register(complianceRoutes);
    await app.register(paidJobFlowRoutes);
    await app.register(settlementRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    (await import("../../db.js")).closeStore();
    delete process.env.PCC_ADMIN_KEY;
    delete process.env.MOCK_SETTLEMENT;
    delete process.env.TENANT_ENFORCE;
  });

  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

  for (const [label, url] of FAMILY) {
    describe(label, () => {
      it("NEGATIVE: anonymous is 401", async () => {
        const res = await get(url(JOB));
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("unauthenticated");
      });

      it("NEGATIVE: a stranger gets exactly the answer for a job that does not exist", async () => {
        const stranger = await get(url(JOB), { "x-test-principal": STRANGER });
        const missing = await get(url("job-f3-does-not-exist"), { "x-test-principal": STRANGER });
        expect(stranger.statusCode).toBe(404);
        expect(missing.statusCode).toBe(404);
        // Same body, byte for byte, once the job id is swapped in.
        expect(stranger.body).toBe(missing.body.split("job-f3-does-not-exist").join(JOB));
        expect(stranger.body).not.toMatch(/executing|kernel-nyc|step-f3/);
      });

      it("the kernel operator (case-insensitive), the recorded buyer and an admin read it", async () => {
        for (const headers of [
          { "x-test-principal": OPERATOR_NYC.toUpperCase().replace("0X", "0x") },
          { "x-test-principal": BUYER },
          { "x-test-principal": STRANGER, "x-admin-key": ADMIN },
        ]) {
          const res = await get(url(JOB), headers);
          // The evidence reads answer 404 when the job has no evidence yet: a real answer
          // about this job, not a refusal (it only happens after the gate let the caller in).
          if (label.includes("evidence") && res.statusCode === 404) {
            expect(res.json().message ?? "", JSON.stringify(headers)).toMatch(/evidence/);
            continue;
          }
          expect(res.statusCode, `${JSON.stringify(headers)} ${res.body.slice(0, 200)}`).toBe(200);
        }
      });

      it("NEGATIVE: a wrong admin key is a stranger", async () => {
        const res = await get(url(JOB), { "x-test-principal": STRANGER, "x-admin-key": ADMIN + "x" });
        expect(res.statusCode).toBe(404);
      });

      it("NEGATIVE: under TENANT_ENFORCE another tenant's job is 404, even for its operator", async () => {
        process.env.TENANT_ENFORCE = "true";
        try {
          const res = await get(url("job-f3-tenant"), { "x-test-principal": OPERATOR_NYC, "x-test-tenant": "tenant-b" });
          expect(res.statusCode).toBe(404);
        } finally {
          delete process.env.TENANT_ENFORCE;
        }
      });
    });
  }

  it("the evidence-by-HASH form stays content-addressed (the oracle is not a party)", async () => {
    // A 64-hex hash no bundle has: it falls through to the job-id lookup, which is gated,
    // so an unknown hash is the ordinary 404 for a stranger, never a 401 or an authorization leak.
    const hash = "sha256:" + "ab".repeat(32);
    const res = await get(`/api/evidence/${hash}`, { "x-test-principal": STRANGER });
    expect([404]).toContain(res.statusCode);
  });

  it("NEGATIVE: a failed job row read is 503 on the family, never a fallback", async () => {
    const spy = vi.spyOn(getStore().repos.jobs, "findById").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    try {
      for (const [, url] of FAMILY) {
        const res = await get(url(JOB), { "x-test-principal": OPERATOR_NYC });
        expect(res.statusCode, url(JOB)).toBe(503);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
