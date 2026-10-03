/**
 * F3 round 2 (cross-family review r1 of #403, 3 CRITICAL + 1 MEDIUM): every job-keyed read the
 * reviewer named takes the ONE job-read gate. Beyond the eight /api/jobs-family routes, that is:
 * - the job list;
 * - batches by job;
 * - telemetry (a job's pipeline, the job-id and active-job enumerations, logs);
 * - sensor readings filtered by job;
 * - print-and-mail evidence;
 * - the compliance bundle reads;
 * - /api/query's job intents;
 * - the live per-job SSE stream.
 *
 * The rule is #353's: an admin (X-Admin-Key) reads everything. Otherwise identity comes first:
 * no credential is 401, a credential without a PROVEN wallet is 403. A proven wallet reads only
 * jobs whose kernel it operates or whose recorded buyer it is. Anyone else gets the answer a
 * missing job gets, and a list shows only what the caller may read.
 *
 * A stand-in gate plays WP-A's: x-test-principal is the claimed operatorId, and
 * x-test-proven-wallet is req.provenWallet.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const STRANGER = "0x9999999999999999999999999999999999999999";
const ADMIN = "f3-r2-admin-key";

const ANON = {};
const UNPROVEN = { "x-test-principal": OPERATOR_NYC };
const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const PARTY = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const ADMIN_H = { "x-admin-key": ADMIN };

let app: FastifyInstance;
let getStore: typeof import("../../db.js").getStore;
let channel = "";
let bundleId = "";

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.SSE_AUTH_REQUIRED;
  delete process.env.SSE_JOB_OWNERSHIP_CHECK;
  const db = await import("../../db.js");
  getStore = db.getStore;
  db.initStore({ seed: true });

  // Records keyed by job-001 (kernel-nyc) on each surface.
  const { pipelineTelemetry, PIPELINE_PHASES } = await import("../../telemetry.js");
  pipelineTelemetry.emit("job-001", PIPELINE_PHASES[0]!, "started");
  const { logger } = await import("../../structured-logger.js");
  logger.log("info", "f3 r2 job-001 line", { source: "f3-test", jobId: "job-001" } as never);
  const { batchTracker, sensorPipeline } = await import("../../services.js");
  const batch = batchTracker.createBatch("kernel-nyc", "dev-f3", "cap-nyc-fdm", {});
  batchTracker.addSample(batch.id, { position: "A1", jobId: "job-001", stepId: "step-001", userId: OPERATOR_NYC as never, sampleLabel: "f3" } as never);
  channel = sensorPipeline.getDescriptors()[0]!.channel;
  sensorPipeline.ingest({ timestamp: new Date().toISOString(), kernelId: "kernel-nyc", deviceId: "dev-f3", channel, dataType: "scalar", unit: "degC", value: 21, jobId: "job-001" } as never);
  const { getPrintAndMailHandoffStore } = await import("../../services/print-and-mail-handoff-store.js");
  getPrintAndMailHandoffStore().create({ jobId: "job-001", kernelId: "kernel-nyc", driverAgent: "a", commitmentHash: "h", trackingCode: "t", printJobId: "p", commitmentVerified: false, events: [] });
  const ev = getStore().repos.evidence.findAll().find((b: { jobId?: string }) => b.jobId === "job-001") as { id: string } | undefined;
  if (ev) bundleId = ev.id;

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as any).operatorId = principal;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as any).provenWallet = proven;
  });
  const { jobRoutes } = await import("../../routes/jobs.js");
  const { batchRoutes } = await import("../../routes/batches.js");
  const { telemetryRoutes } = await import("../../routes/telemetry.js");
  const { sensorRoutes } = await import("../../routes/sensors.js");
  const { printAndMailRoutes } = await import("../../routes/print-and-mail.js");
  const { complianceRoutes } = await import("../../routes/compliance.js");
  const { nlQueryRoutes } = await import("../../routes/nl-query.js");
  const { topicSSE } = await import("../../sse/topic-sse.js");
  for (const r of [jobRoutes, batchRoutes, telemetryRoutes, sensorRoutes, printAndMailRoutes, complianceRoutes, nlQueryRoutes, topicSSE]) {
    await app.register(r);
  }
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

describe("identity first on every surface: 401 without a credential, 403 without a proven wallet", () => {
  const urls = [
    "/api/jobs",
    "/api/batches/by-job/job-001",
    "/api/telemetry/pipeline/job-001",
    "/api/telemetry/jobs",
    "/api/telemetry/active",
    "/api/telemetry/logs?jobId=job-001",
    `/api/sensors/readings/CH?jobId=job-001`,
    "/api/print-and-mail/job-001",
  ];
  for (const u of urls) {
    it(`${u}: anonymous 401, unproven 403`, async () => {
      const url = u.replace("CH", channel);
      expect((await get(url, ANON)).statusCode, url).toBe(401);
      expect((await get(url, UNPROVEN)).statusCode, url).toBe(403);
    });
  }
});

describe("a stranger's proven wallet gets what a missing job gets; the party and the admin read", () => {
  it("GET /api/jobs lists only the caller's jobs", async () => {
    const ids = async (h: Record<string, string>) => ((await get("/api/jobs?limit=500", h)).json().jobs as Array<{ id: string; kernelId: string }>);
    expect(await ids(STRANGER_H)).toEqual([]);
    const mine = await ids(PARTY);
    expect(mine.map((j) => j.id)).toContain("job-001");
    expect(mine.every((j) => j.kernelId === "kernel-nyc")).toBe(true);
    expect((await ids(ADMIN_H)).length).toBeGreaterThan(mine.length);
  });

  it("GET /api/batches/by-job/:jobId", async () => {
    const stranger = await get("/api/batches/by-job/job-001", STRANGER_H);
    const missing = await get("/api/batches/by-job/no-such-job", STRANGER_H);
    expect([stranger.statusCode, stranger.body]).toEqual([missing.statusCode, missing.body]);
    expect((await get("/api/batches/by-job/job-001", PARTY)).json().batches.length).toBe(1);
  });

  it("GET /api/telemetry/pipeline/:jobId", async () => {
    const stranger = await get("/api/telemetry/pipeline/job-001", STRANGER_H);
    const missing = await get("/api/telemetry/pipeline/no-such-job", STRANGER_H);
    expect([stranger.statusCode, stranger.json().timeline]).toEqual([missing.statusCode, missing.json().timeline]);
    expect((await get("/api/telemetry/pipeline/job-001", PARTY)).json().timeline.length).toBeGreaterThan(0);
  });

  it("the telemetry enumerations and logs show only the caller's jobs", async () => {
    expect((await get("/api/telemetry/jobs", STRANGER_H)).json().jobIds).not.toContain("job-001");
    expect((await get("/api/telemetry/jobs", PARTY)).json().jobIds).toContain("job-001");
    const activeIds = async (h: Record<string, string>) => JSON.stringify((await get("/api/telemetry/active", h)).json().active);
    expect(await activeIds(STRANGER_H)).not.toContain("job-001");
    expect(await activeIds(PARTY)).toContain("job-001");
    expect((await get("/api/telemetry/logs?jobId=job-001", STRANGER_H)).json().entries).toEqual([]);
    expect(JSON.stringify((await get("/api/telemetry/logs", STRANGER_H)).json().entries)).not.toContain("job-001");
    expect(JSON.stringify((await get("/api/telemetry/logs?jobId=job-001", PARTY)).json().entries)).toContain("f3 r2 job-001 line");
  });

  it("GET /api/sensors/readings/:channel?jobId=", async () => {
    expect((await get(`/api/sensors/readings/${channel}?jobId=job-001`, STRANGER_H)).json().readings).toEqual([]);
    expect((await get(`/api/sensors/readings/${channel}?jobId=job-001`, PARTY)).json().readings.length).toBe(1);
  });

  it("GET /api/print-and-mail/:jobId: a courier job's evidence, which only an admin reads", async () => {
    // Its :jobId names a courier job whose poster and driver are self-declared ids, so no
    // wallet can be proven to be its party: every non-admin gets the no-evidence 404.
    for (const h of [STRANGER_H, PARTY]) {
      const refused = await get("/api/print-and-mail/job-001", h);
      const missing = await get("/api/print-and-mail/no-such-job", h);
      expect(refused.statusCode).toBe(404);
      expect(refused.body.replace("job-001", "X")).toBe(missing.body.replace("no-such-job", "X"));
    }
    expect((await get("/api/print-and-mail/job-001", ADMIN_H)).statusCode).toBe(200);
  });

  it("GET /api/compliance/evidence/:bundleId (and /tier-compliance): the bundle's job is gated", async () => {
    expect(bundleId, "a seeded bundle for job-001").not.toBe("");
    for (const suffix of ["", "/tier-compliance"]) {
      const stranger = await get(`/api/compliance/evidence/${bundleId}${suffix}`, STRANGER_H);
      const missing = await get(`/api/compliance/evidence/no-such-bundle${suffix}`, STRANGER_H);
      expect(stranger.statusCode, suffix).toBe(missing.statusCode);
      expect(stranger.body.replace(bundleId, "X"), suffix).toBe(missing.body.replace("no-such-bundle", "X"));
      expect((await get(`/api/compliance/evidence/${bundleId}${suffix}`, PARTY)).statusCode, suffix).toBe(200);
    }
    expect((await get(`/api/compliance/evidence/${bundleId}`, ANON)).statusCode).toBe(401);
  });

  it("POST /api/query: the job intents answer only the caller's jobs", async () => {
    const q = (query: string, h: Record<string, string>) => app.inject({ method: "POST", url: "/api/query", headers: h, payload: { query } });
    for (const query of ["status of job job-001", "my recent jobs"]) {
      expect(JSON.stringify((await q(query, STRANGER_H)).json().data), query).not.toContain("job-001");
      expect(JSON.stringify((await q(query, PARTY)).json().data), query).toContain("job-001");
      expect((await q(query, UNPROVEN)).statusCode, query).toBe(403);
    }
  });

  it("GET /sse/stream/job/:jobId: refused before any event is streamed (anonymous 401, stranger 404)", async () => {
    expect((await get("/sse/stream/job/job-001", ANON)).statusCode).toBe(401);
    const stranger = await get("/sse/stream/job/job-001", STRANGER_H);
    const missing = await get("/sse/stream/job/no-such-job", STRANGER_H);
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body.replace("job-001", "X")).toBe(missing.body.replace("no-such-job", "X"));
  });
});

describe("TENANT_ENFORCE: a caller with no tenant lists only tenant-less jobs (review r1: a null tenant was dropped)", () => {
  it("GET /api/jobs hides the party's own job once that job belongs to a tenant", async () => {
    const { schema, eq } = await import("@pcc/store");
    const setTenant = (tenantId: string | null) =>
      getStore().db.update(schema.jobs).set({ tenantId }).where(eq(schema.jobs.id, "job-001")).run();
    const ids = async () => ((await get("/api/jobs?limit=500", PARTY)).json().jobs as Array<{ id: string }>).map((j) => j.id);
    setTenant("tenant-other");
    process.env.TENANT_ENFORCE = "true";
    try {
      expect(await ids()).not.toContain("job-001");
      expect((await get("/api/jobs/job-001/execution", PARTY)).statusCode).toBe(404);
    } finally {
      delete process.env.TENANT_ENFORCE;
      setTenant(null);
    }
    expect(await ids()).toContain("job-001");
  });
});

describe("the live streams: a stranger receives no line or event of a job it may not read", () => {
  let port = 0;
  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  /** Opens a stream, runs `during` once it has started, and returns what arrived. */
  const stream = (path: string, headers: Record<string, string>, during: () => void) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        if (res.statusCode !== 200) return;
        setTimeout(() => {
          during();
          setTimeout(() => {
            req.destroy();
            resolve({ status: 200, body });
          }, 150);
        }, 50);
      });
      req.on("error", (error) => {
        if (!req.destroyed) reject(error);
      });
    });

  const emitJob001 = async () => {
    const { pipelineTelemetry, PIPELINE_PHASES } = await import("../../telemetry.js");
    return () => pipelineTelemetry.emit("job-001", PIPELINE_PHASES[1]!, "started");
  };

  it("GET /api/telemetry/logs/stream: the history and the live events leave out job-001 for a stranger only", async () => {
    const emit = await emitJob001();
    const stranger = await stream("/api/telemetry/logs/stream", STRANGER_H, emit);
    expect(stranger.status).toBe(200);
    expect(stranger.body).toContain("connected");
    expect(stranger.body).not.toContain("job-001");
    const party = await stream("/api/telemetry/logs/stream", PARTY, emit);
    expect(party.body).toContain("f3 r2 job-001 line");
    expect(party.body.match(/event: telemetry_event/g)?.length ?? 0).toBeGreaterThan(0);
    // Identity first (F3 round 3): a line naming no job is an admin's, so no credential is 401.
    const anonymous = await stream("/api/telemetry/logs/stream", ANON, emit);
    expect([anonymous.status, anonymous.body.includes("job-001")]).toEqual([401, false]);
  });

  it("GET /sse/stream/job/:jobId opens for the job's party and streams its events", async () => {
    const party = await stream("/sse/stream/job/job-001", PARTY, await emitJob001());
    expect(party.status).toBe(200);
    expect(party.body).toContain("telemetry_event");
    expect(party.body).toContain("job-001");
  });
});

describe("MEDIUM (timing): a missing job and a stranger's job do the same authorization reads", () => {
  it("gateJobRead reads the kernel and the sessions for a missing job too", async () => {
    const { gateJobRead } = await import("../../readmodels/job-read-gate.js");
    const store = getStore();
    const kernels = vi.spyOn(store.repos.kernels, "findById");
    const select = vi.spyOn(store.db, "select");
    const req = (jobId: string) => ({ headers: {}, provenWallet: STRANGER, operatorId: STRANGER, log: { error: () => {}, warn: () => {} }, params: { jobId } }) as never;
    const counts = (jobId: string) => {
      kernels.mockClear();
      select.mockClear();
      const gate = gateJobRead(req(jobId), jobId);
      return { gate: gate.ok ? "ok" : gate.kind, kernels: kernels.mock.calls.length, selects: select.mock.calls.length };
    };
    const existing = counts("job-001");
    const missing = counts("no-such-job");
    expect(existing.gate).toBe("not_found");
    expect(missing).toEqual(existing);
    kernels.mockRestore();
    select.mockRestore();
  });
});
