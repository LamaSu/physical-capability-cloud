/**
 * Cross-family review r3 of #403 (rm-f3-403-r3-f004b709, DO-NOT-SHIP). These tests reproduce its
 * findings at f004b709 and pin the rule that replaces each:
 *   CRITICAL 1  kernel records (batch slots, kernel/device/batch stream events) ignored
 *               TENANT_ENFORCE: their job-bound parts now follow the tenant-aware job scope;
 *   CRITICAL 2  the shared-batch routes returned every claim publicly: anyone gets the public
 *               opportunity, and only an admin or the kernel's operator the claims;
 *   HIGH 3      ?jobId= telemetry reads skipped the nested-binding filter;
 *   HIGH 4      the filter inspected the live object while another form was sent (toJSON);
 *   MEDIUM 5    a record-by-id refusal read the job row only when the record existed;
 *   MEDIUM 6    an unmatched /sse/stream/ path took a connection slot it never gave back.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const STRANGER = "0x9999999999999999999999999999999999999999";
const BUYER_003 = "0x3333333333333333333333333333333333333333"; // job-003's only recorded buyer
const ADMIN = "f3-r4-admin-key";
const DEVICE = "dev-fdm-prusa-mk4"; // seeded on kernel-nyc
const ANON = {};
const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const OPERATOR_H = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const BUYER_H = { "x-test-principal": BUYER_003, "x-test-proven-wallet": BUYER_003 };
const ADMIN_H = { "x-admin-key": ADMIN };

let app: FastifyInstance;
let port = 0;
let batchId = "";
/** Each job's slot in the batch: a reading names its sample (review r5 of #403: one naming none is the batch's). */
const slotOfJob: Record<string, string> = {};
let sharedId = "";
let channel = "";
let getStore: typeof import("../../db.js").getStore;
let sensorPipeline: typeof import("../../services.js").sensorPipeline;
let streamHub: typeof import("../../sse/stream-hub.js").streamHub;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.SSE_AUTH_REQUIRED;
  delete process.env.TENANT_ENFORCE;
  const db = await import("../../db.js");
  getStore = db.getStore;
  db.initStore({ seed: true });
  const { schema, eq } = await import("@pcc/store");
  const store = getStore();
  const now = new Date().toISOString();
  // job-003 (kernel-nyc) has exactly one negotiation session, and it names BUYER_003.
  store.db.insert(schema.negotiationSessions).values({
    id: "neg-r4-003", status: "committed", userAgentId: BUYER_003, kernelId: "kernel-nyc", capabilityType: "fdm",
    operatorConstraints: {}, jobId: "job-003", createdAt: now, expiresAt: now,
  } as never).run();
  // Two tenants share kernel-nyc: job-001 is tenant A's, job-003 tenant B's.
  store.db.update(schema.jobs).set({ tenantId: "tenant-a" } as never).where(eq(schema.jobs.id, "job-001")).run();
  store.db.update(schema.jobs).set({ tenantId: "tenant-b" } as never).where(eq(schema.jobs.id, "job-003")).run();
  // job-001's evidence bundle, for the record-by-id gate.
  (store.repos as any).evidence.insert({
    id: "bun-r4-001", jobId: "job-001", stepId: "step-1", kernelId: "kernel-nyc", assuranceTier: 1,
    bundleHash: "ab".repeat(32), kernelSignature: { signer: OPERATOR_NYC, algorithm: "secp256k1", value: "sig" }, createdAt: now,
  });

  const services = await import("../../services.js");
  sensorPipeline = services.sensorPipeline;
  streamHub = (await import("../../sse/stream-hub.js")).streamHub;
  // One kernel-nyc batch holding a tenant-A slot (job-001) and a tenant-B slot (job-003).
  const batch = services.batchTracker.createBatch("kernel-nyc", DEVICE, "cap-nyc-fdm", {});
  slotOfJob["job-001"] = services.batchTracker.addSample(batch.id, { position: "A1", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC as never, sampleLabel: "r4-tenant-a-sample" } as never).id;
  slotOfJob["job-003"] = services.batchTracker.addSample(batch.id, { position: "A2", jobId: "job-003", stepId: "step-3", userId: BUYER_003 as never, sampleLabel: "r4-tenant-b-sample" } as never).id;
  batchId = batch.id;
  channel = sensorPipeline.getDescriptors()[0]!.channel;

  const { logger } = await import("../../structured-logger.js");
  // A line bound to the buyer's job at the top and to another job inside (HIGH 3).
  logger.log("info", "r4 mixed binding", { source: "f3-r4", jobId: "job-003", metadata: { jobId: "job-001", secret: "r4-mixed-secret" } } as never);
  // A line whose sent form (toJSON) names another job than its fields do (HIGH 4).
  logger.log("info", "r4 tojson rest", {
    source: "f3-r4", jobId: "job-003",
    metadata: { toJSON: () => ({ jobId: "job-001", secret: "r4-tojson-rest-secret" }) },
  } as never);

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as any).operatorId = principal;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as any).provenWallet = proven;
    const tenant = req.headers["x-test-tenant"];
    if (typeof tenant === "string") (req as any).tenantId = tenant;
  });
  const { batchRoutes } = await import("../../routes/batches.js");
  const { telemetryRoutes } = await import("../../routes/telemetry.js");
  const { topicSSE } = await import("../../sse/topic-sse.js");
  const { complianceRoutes } = await import("../../routes/compliance.js");
  for (const r of [batchRoutes, telemetryRoutes, topicSSE, complianceRoutes]) await app.register(r);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;

  // A shared batch on kernel-nyc with two claimants' claims (CRITICAL 2).
  const created = await app.inject({
    method: "POST", url: "/api/batches/shared", headers: ADMIN_H,
    payload: { kernelId: "kernel-nyc", capabilityType: "hplc", totalSlots: 8, protocolType: "hplc-standard", pricePerSlot: "10" },
  });
  sharedId = created.json().batch.id;
  for (const [agentId, label] of [["agent-r4-alice", "r4-alice-sample"], ["agent-r4-bob", "r4-bob-sample"]]) {
    await app.inject({ method: "POST", url: `/api/batches/shared/${sharedId}/claim`, headers: ADMIN_H, payload: { agentId, slotCount: 2, sampleLabels: [label, label] } });
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.TENANT_ENFORCE;
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

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

const emit = (jobId: string, value: number) =>
  sensorPipeline.ingest({
    timestamp: new Date().toISOString(), kernelId: "kernel-nyc", deviceId: DEVICE, channel, dataType: "scalar",
    unit: "degC", value, jobId, batchId, sampleId: slotOfJob[jobId],
  } as never);

const withTenantEnforce = async (fn: () => Promise<void>) => {
  process.env.TENANT_ENFORCE = "true";
  try {
    await fn();
  } finally {
    delete process.env.TENANT_ENFORCE;
  }
};

describe("CRITICAL 1: a kernel record's job-bound parts follow TENANT_ENFORCE", () => {
  it("a tenant-A admin and a tenant-A operator see only tenant A's slots in the batch list and detail", async () => {
    await withTenantEnforce(async () => {
      for (const headers of [{ ...ADMIN_H, "x-test-tenant": "tenant-a" }, { ...OPERATOR_H, "x-test-tenant": "tenant-a" }]) {
        const detail = await get(`/api/batches/${batchId}`, headers);
        const list = await get("/api/batches", headers);
        for (const res of [detail, list]) {
          expect(res.statusCode).toBe(200);
          expect(res.body).toContain("r4-tenant-a-sample");
          expect(res.body).not.toContain("r4-tenant-b-sample");
          expect(res.body).not.toContain("job-003");
        }
      }
    });
  });

  it("a tenant-A admin on the kernel, device and batch streams receives tenant A's readings and not tenant B's", async () => {
    await withTenantEnforce(async () => {
      for (const path of ["/sse/stream/kernel/kernel-nyc", `/sse/stream/device/${DEVICE}`, `/sse/stream/batch/${batchId}`]) {
        const res = await stream(path, { ...ADMIN_H, "x-test-tenant": "tenant-a" }, () => {
          emit("job-003", 803);
          emit("job-001", 801);
        });
        expect(res.status, path).toBe(200);
        expect(res.body, path).toContain("801");
        expect(res.body, path).not.toContain("job-003");
      }
    });
  });

  it("without TENANT_ENFORCE the kernel's operator still receives both of its kernel's jobs", async () => {
    const res = await stream("/sse/stream/kernel/kernel-nyc", OPERATOR_H, () => {
      emit("job-003", 703);
      emit("job-001", 701);
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("job-001");
    expect(res.body).toContain("job-003");
  });
});

describe("CRITICAL 2: a shared batch's claims are its kernel operator's, and the public sees the opportunity", () => {
  it("anonymous and stranger callers get no claim: no agent id, sample label, amount or escrow address", async () => {
    for (const headers of [ANON, STRANGER_H]) {
      for (const url of ["/api/batches/shared/open", `/api/batches/shared/${sharedId}`, `/api/batches/shared/${sharedId}/availability`]) {
        const res = await get(url, headers);
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).not.toContain("agent-r4-alice");
        expect(res.body, url).not.toContain("r4-bob-sample");
        expect(res.body, url).not.toContain("claimedSlots\":[{");
      }
    }
    // The opportunity itself stays public: the batch, its price, and how many slots are left.
    const open = (await get("/api/batches/shared/open", ANON)).json();
    const listed = open.batches.find((b: { id: string }) => b.id === sharedId);
    expect(listed).toMatchObject({ id: sharedId, kernelId: "kernel-nyc", totalSlots: 8, pricePerSlot: "10", claimedSlotCount: 4 });
    expect((await get(`/api/batches/shared/${sharedId}/availability`, ANON)).json()).toMatchObject({ total: 8, claimed: 4, available: 4 });
  });

  it("the kernel's operator and an admin read every claim", async () => {
    for (const headers of [OPERATOR_H, ADMIN_H]) {
      const res = await get(`/api/batches/shared/${sharedId}`, headers);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("agent-r4-alice");
      expect(res.body).toContain("r4-bob-sample");
    }
  });
});

describe("HIGH 3: a ?jobId= telemetry read still applies the nested-binding filter", () => {
  it("the buyer asking for its own job's lines does not get a line that also names another job", async () => {
    const res = await get("/api/telemetry/logs?jobId=job-003", BUYER_H);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("r4-mixed-secret");
  });

  it("the same for its job's pipeline timeline: no event that also names another job", async () => {
    const { pipelineTelemetry, PIPELINE_PHASES } = await import("../../telemetry.js");
    pipelineTelemetry.emit("job-003", PIPELINE_PHASES[0] as never, "started" as never, {
      metadata: { jobId: "job-001", secret: "r4-pipeline-secret" },
    });
    const res = await get("/api/telemetry/pipeline/job-003", BUYER_H);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("r4-pipeline-secret");
  });
});

describe("HIGH 4: the filter judges the record as it is sent", () => {
  it("a log line whose toJSON names another job is not sent to the buyer, by the REST read", async () => {
    const res = await get("/api/telemetry/logs", BUYER_H);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("r4-tojson-rest-secret");
  });

  it("nor by the live log stream", async () => {
    const res = await stream("/api/telemetry/logs/stream", BUYER_H, () => {
      streamHub.publish([{ type: "global", id: "*" }], {
        type: "log_entry",
        payload: { jobId: "job-003", message: "r4 tojson live", toJSON: () => ({ jobId: "job-001", secret: "r4-tojson-live-secret" }) },
      } as never);
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("r4-tojson-live-secret");
  });
});

describe("MEDIUM 5: a stranger's record-by-id refusal reads no job row, whether or not the record exists", () => {
  it("GET /api/compliance/evidence/:bundleId: the same job reads for an existing and a missing bundle", async () => {
    const spy = vi.spyOn(getStore().repos.jobs as any, "findById");
    try {
      spy.mockClear();
      const existing = await get("/api/compliance/evidence/bun-r4-001", STRANGER_H);
      const existingCalls = spy.mock.calls.map((c) => c[0]);
      spy.mockClear();
      const missing = await get("/api/compliance/evidence/bun-r4-none", STRANGER_H);
      const missingCalls = spy.mock.calls.map((c) => c[0]);
      expect([existing.statusCode, missing.statusCode]).toEqual([404, 404]);
      expect(existingCalls).toEqual(missingCalls);
    } finally {
      spy.mockRestore();
    }
  });
});

// Last: at f004b709 this test leaks 20 slots for 127.0.0.1, which would break any stream test after it.
describe("MEDIUM 6: an unmatched /sse/stream/ path takes no connection slot", () => {
  it("twenty unmatched requests, then a valid stream from the same address still opens", async () => {
    for (let i = 0; i < 20; i++) expect((await get(`/sse/stream/not-a-route/${i}`, ANON)).statusCode).toBe(404);
    const res = await stream("/sse/stream/kernel/kernel-nyc", ADMIN_H, () => {});
    expect(res.status).toBe(200);
  });
});

describe("#538 merge-up (astra, CRITICAL): a line whose job binding was not declared is no tenant-scoped admin's", () => {
  // #538's closed log keys an undeclared field's NAME and value, so the filter cannot see that the
  // line is bound to tenant B's job-003. Such a line's owners are unknown: an unscoped admin's only.
  it("a tenant-A admin does not get tenant B's undeclared-binding line by the REST read; an unscoped admin does", async () => {
    const { logger } = await import("../../structured-logger.js");
    const closed = await import("../../observability/closed-schema.js");
    logger.log("info", closed.lit("mu2 tenant-B undeclared line"), { jobId: "job-003" } as never);
    await withTenantEnforce(async () => {
      const a = await get("/api/telemetry/logs", { ...ADMIN_H, "x-test-tenant": "tenant-a" });
      expect(a.statusCode).toBe(200);
      expect(a.body).not.toContain("mu2 tenant-B undeclared line");
    });
    expect((await get("/api/telemetry/logs", ADMIN_H)).body).toContain("mu2 tenant-B undeclared line");
  });

  it("nor by the live log stream", async () => {
    const closed = await import("../../observability/closed-schema.js");
    await withTenantEnforce(async () => {
      const res = await stream("/api/telemetry/logs/stream", { ...ADMIN_H, "x-test-tenant": "tenant-a" }, () => {
        streamHub.publish([{ type: "global", id: "*" }], {
          type: "log_entry",
          payload: { [closed.keyedHash("jobId")]: closed.keyedHash("job-003"), message: "mu2 tenant-B undeclared live", level: "info", source: "gateway" },
        } as never);
      });
      expect(res.status).toBe(200);
      expect(res.body).not.toContain("mu2 tenant-B undeclared live");
    });
  });
});
