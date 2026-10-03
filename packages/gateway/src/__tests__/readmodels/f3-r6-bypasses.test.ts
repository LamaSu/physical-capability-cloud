/**
 * Cross-family review r5 of #403 (rm-f3-403-r5-04cdf72d, DO-NOT-SHIP). These tests reproduce its
 * findings at 04cdf72d and pin the rule that replaces each: every batch-tied record is owned by
 * the job the LIVE batch says, never by the binding names its payload happens to carry.
 *   CRITICAL 1  a sensor reading naming only a batch and a sample (no jobId), and a batch-level
 *               event the classifier did not know (batch_failed), reached a caller who may not
 *               read that sample's job or the whole batch, live and by replay;
 *   CRITICAL 2  a tenant-B slot whose toJSON names tenant A's job was kept, and so was its
 *               completion event;
 *   HIGH 3      anyone could claim shared-batch slots for any claimant.
 * Found while fixing, the same class: anyone could open a shared batch on any kernel, or add a
 * slot to any batch.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const STRANGER = "0x9999999999999999999999999999999999999999";
const ADMIN = "f3-r6-admin-key";
const DEVICE = "dev-fdm-prusa-mk4"; // seeded on kernel-nyc
const ANON = {};
const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const OPERATOR_H = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const ADMIN_H = { "x-admin-key": ADMIN };
const TENANT_A_ADMIN = { ...ADMIN_H, "x-test-tenant": "tenant-a" };

let app: FastifyInstance;
let port = 0;
let batchId = "";
let bSlotId = "";
let firstEventId = "";
let channel = "";
let sensorPipeline: typeof import("../../services.js").sensorPipeline;
let streamHub: typeof import("../../sse/stream-hub.js").streamHub;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.SSE_AUTH_REQUIRED;
  delete process.env.TENANT_ENFORCE;
  const db = await import("../../db.js");
  db.initStore({ seed: true });
  const { schema, eq } = await import("@pcc/store");
  const store = db.getStore();
  store.db.update(schema.jobs).set({ tenantId: "tenant-a" } as never).where(eq(schema.jobs.id, "job-001")).run();
  store.db.update(schema.jobs).set({ tenantId: "tenant-b" } as never).where(eq(schema.jobs.id, "job-003")).run();

  const services = await import("../../services.js");
  sensorPipeline = services.sensorPipeline;
  streamHub = (await import("../../sse/stream-hub.js")).streamHub;
  channel = sensorPipeline.getDescriptors()[0]!.channel;
  // A mixed-tenant batch. Tenant B's slot serializes as tenant A's (CRITICAL 2), and completes.
  const batch = services.batchTracker.createBatch("kernel-nyc", DEVICE, "cap-nyc-fdm", {});
  services.batchTracker.addSample(batch.id, { position: "A1", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC as never, sampleLabel: "r6-tenant-a-sample" } as never);
  const bSlot = services.batchTracker.addSample(batch.id, {
    position: "A2", jobId: "job-003", stepId: "step-3", userId: OPERATOR_NYC as never, sampleLabel: "r6-tenant-b-sample",
    toJSON(this: { id: string }) {
      return { id: this.id, jobId: "job-001", sampleLabel: "r6-laundered-secret" };
    },
  } as never) as { id: string };
  services.batchTracker.completeSlot(batch.id, bSlot.id, "ab".repeat(32) as never, "r6-laundered-result");
  batchId = batch.id;
  bSlotId = bSlot.id;
  firstEventId = services.batchTracker.getEvents(batch.id)[0]!.id;
  // A reading of tenant B's sample that names no job, published before anyone connects (replay).
  sensorPipeline.ingest({
    timestamp: new Date().toISOString(), kernelId: "kernel-nyc", deviceId: DEVICE, channel, dataType: "scalar",
    unit: "degC", value: 987001, batchId, sampleId: bSlotId,
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
  const { topicSSE } = await import("../../sse/topic-sse.js");
  const { sensorRoutes } = await import("../../routes/sensors.js");
  for (const r of [batchRoutes, topicSSE, sensorRoutes]) await app.register(r);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.TENANT_ENFORCE;
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
const post = (url: string, headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url, headers, payload: payload as never });

/** Opens a stream, runs `during` once it has started, and returns what arrived (replay included). */
const stream = (path: string, headers: Record<string, string>, during: () => void = () => {}) =>
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

const withTenantEnforce = async (fn: () => Promise<void>) => {
  process.env.TENANT_ENFORCE = "true";
  try {
    await fn();
  } finally {
    delete process.env.TENANT_ENFORCE;
  }
};

const jobLessReading = (value: number) =>
  sensorPipeline.ingest({
    timestamp: new Date().toISOString(), kernelId: "kernel-nyc", deviceId: DEVICE, channel, dataType: "scalar",
    unit: "degC", value, batchId, sampleId: bSlotId,
  } as never);

describe("CRITICAL 1: a reading or event tied to a batch is owned by what the live batch says", () => {
  it("a reading of tenant B's sample that names no job reaches neither tenant A's batch stream (live and replayed) nor its kernel stream", async () => {
    await withTenantEnforce(async () => {
      const replayed = await stream(`/sse/stream/batch/${batchId}`, { ...TENANT_A_ADMIN, "last-event-id": firstEventId }, () => jobLessReading(987002));
      expect(replayed.status).toBe(200);
      expect(replayed.body).not.toContain("987001");
      expect(replayed.body).not.toContain("987002");
      const kernel = await stream("/sse/stream/kernel/kernel-nyc", TENANT_A_ADMIN, () => jobLessReading(987003));
      expect(kernel.status).toBe(200);
      expect(kernel.body).not.toContain("987003");
    });
  });

  it("what is derived from that reading (its anomalies, a channel aggregate) is that sample's job's too", async () => {
    // Found while fixing: the anomaly and the aggregate kept only the reading's jobId, and the REST
    // routes for them had no read gate.
    const aggregateUrl = `/api/sensors/aggregates/${channel}?windowMs=600000`;
    await withTenantEnforce(async () => {
      jobLessReading(987004); // outside the channel's range: a threshold anomaly names its value
      for (const url of ["/api/sensors/anomalies", aggregateUrl]) {
        const res = await get(url, TENANT_A_ADMIN);
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).not.toMatch(/98700\d/);
      }
    });
    // An admin without a tenant sees them: the readings and their anomalies are there to find.
    expect((await get("/api/sensors/anomalies", ADMIN_H)).body).toContain("987004");
    expect((await get(aggregateUrl, ADMIN_H)).json().aggregate.max).toBeGreaterThanOrEqual(987004);
    // And neither route answers a caller with no credential.
    for (const url of ["/api/sensors/anomalies", aggregateUrl]) expect((await get(url, ANON)).statusCode, url).toBe(401);
  });

  it("a reading that names a job and the batch but no sample is the batch's: a job's name adds an owner, never removes one", async () => {
    const labelled = (value: number) =>
      sensorPipeline.ingest({
        timestamp: new Date().toISOString(), kernelId: "kernel-nyc", deviceId: DEVICE, channel, dataType: "scalar",
        unit: "degC", value, jobId: "job-001", batchId,
      } as never);
    await withTenantEnforce(async () => {
      for (const path of [`/sse/stream/batch/${batchId}`, "/sse/stream/kernel/kernel-nyc", `/sse/stream/device/${DEVICE}`]) {
        const res = await stream(path, TENANT_A_ADMIN, () => labelled(987006));
        expect(res.status, path).toBe(200);
        expect(res.body, path).not.toContain("987006");
      }
    });
    // The kernel's operator may read every job of the batch, so it receives the reading.
    const operator = await stream(`/sse/stream/batch/${batchId}`, OPERATOR_H, () => labelled(987007));
    expect(operator.body).toContain("987007");
  });

  it("a batch-level event the tracker's list does not name (batch_failed) shows only to a caller who sees the whole batch", async () => {
    await withTenantEnforce(async () => {
      const publish = () =>
        streamHub.publish([{ type: "batch", id: batchId }], {
          type: "batch_failed",
          payload: { id: "evt-r6-failed", batchId, timestamp: new Date().toISOString(), type: "batch_failed", payload: { detail: "r6-batch-failed-secret" } },
        } as never);
      const res = await stream(`/sse/stream/batch/${batchId}`, TENANT_A_ADMIN, publish);
      expect(res.status).toBe(200);
      expect(res.body).not.toContain("r6-batch-failed-secret");
    });
  });
});

describe("CRITICAL 2: a slot's owner is its live job, whatever its serialized form says", () => {
  it("tenant B's slot that serializes as tenant A's is withheld from tenant A, with its completion event", async () => {
    await withTenantEnforce(async () => {
      for (const url of ["/api/batches", `/api/batches/${batchId}`, "/api/batches/by-job/job-001"]) {
        const res = await get(url, TENANT_A_ADMIN);
        expect(res.statusCode, url).toBe(200);
        expect(res.body, url).toContain("r6-tenant-a-sample");
        expect(res.body, url).not.toContain("r6-laundered-secret");
        expect(res.body, url).not.toContain("r6-laundered-result");
      }
      const replayed = await stream(`/sse/stream/batch/${batchId}`, { ...TENANT_A_ADMIN, "last-event-id": firstEventId });
      expect(replayed.body).not.toContain("r6-laundered-result");
    });
  });
});

describe("HIGH 3, and the same class found while fixing: batch writes need the right identity", () => {
  it("a shared-batch claim needs a proven wallet, and claims for that wallet only", async () => {
    const created = await post("/api/batches/shared", ADMIN_H, { kernelId: "kernel-nyc", capabilityType: "hplc", totalSlots: 4, protocolType: "hplc", pricePerSlot: "10" });
    expect(created.statusCode).toBe(200);
    const sharedId = created.json().batch.id as string;
    const url = `/api/batches/shared/${sharedId}/claim`;
    expect((await post(url, ANON, { agentId: STRANGER, slotCount: 1 })).statusCode).toBe(401);
    expect((await post(url, { "x-test-principal": STRANGER }, { agentId: STRANGER, slotCount: 1 })).statusCode).toBe(403);
    expect((await post(url, STRANGER_H, { agentId: OPERATOR_NYC, slotCount: 1 })).statusCode).toBe(403);
    const own = await post(url, STRANGER_H, { slotCount: 1 });
    expect(own.statusCode).toBe(200);
    expect(own.json().claim.agentId).toBe(STRANGER);
  });

  it("opening a shared batch on a kernel is its operator's or an admin's", async () => {
    const body = { kernelId: "kernel-nyc", capabilityType: "hplc", totalSlots: 2, protocolType: "hplc", pricePerSlot: "10" };
    expect((await post("/api/batches/shared", ANON, body)).statusCode).toBe(401);
    expect((await post("/api/batches/shared", STRANGER_H, body)).statusCode).toBe(403);
    expect((await post("/api/batches/shared", OPERATOR_H, body)).statusCode).toBe(200);
  });

  it("adding a slot to a batch is its kernel operator's or an admin's, for a job they may read", async () => {
    const slot = { position: "B1", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC, sampleLabel: "r6-added" };
    expect((await post(`/api/batches/${batchId}/slots`, ANON, slot)).statusCode).toBe(401);
    const stranger = await post(`/api/batches/${batchId}/slots`, STRANGER_H, slot);
    const missing = await post("/api/batches/batch-none/slots", STRANGER_H, slot);
    expect(stranger.statusCode).toBe(missing.statusCode);
    expect(stranger.body.replace(batchId, "X")).toBe(missing.body.replace("batch-none", "X"));
    expect((await post(`/api/batches/${batchId}/slots`, OPERATOR_H, slot)).statusCode).toBe(200);
  });
});
