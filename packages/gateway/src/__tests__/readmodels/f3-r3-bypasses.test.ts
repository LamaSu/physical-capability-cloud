/**
 * F3 round 3 (cross-family review r2 of #403: DO-NOT-SHIP, 2 CRITICAL, 1 HIGH, 1 MEDIUM). Each test
 * here was written first, and failed at 4988a191, the reviewed head.
 *
 * - CRITICAL: the kernel, device and batch SSE streams published job-bound sensor readings to any
 *   subscriber, an anonymous one included. They now follow the kernel's read rule: an admin or the
 *   kernel's operator (a proven wallet) subscribes. No credential is 401, an unproven one 403, and
 *   anyone else gets the 404 an unknown kernel, device or batch gets.
 * - CRITICAL: the batch list and detail returned every slot's job, buyer and sample. They are the
 *   kernel operator's (and an admin's). A stranger's list leaves the batch out, and its detail is a
 *   missing batch's answer. A job's buyer reads by job, and sees only that job's slots.
 * - HIGH: the record filter looked only at a top-level jobId. It now reads every job binding at any
 *   depth and fails closed on a malformed one. A record naming no job is an admin's or, when it
 *   names a kernel, that kernel operator's: free text can name any job.
 * - MEDIUM: the gate's authorization reads depended on the requested job (its kernel, its
 *   sessions). They are now keyed by the caller only.
 *
 * A stand-in gate plays WP-A's: x-test-principal is the claimed operatorId, and
 * x-test-proven-wallet is req.provenWallet.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { recordBindingsOf } from "../../readmodels/job-read-gate.js";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const STRANGER = "0x9999999999999999999999999999999999999999";
const BUYER_003 = "0x3333333333333333333333333333333333333333"; // job-003's only recorded buyer
const ADMIN = "f3-r3-admin-key";
const DEVICE = "dev-fdm-prusa-mk4"; // seeded on kernel-nyc
const ANON = {};
const UNPROVEN = { "x-test-principal": OPERATOR_NYC };
const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const OPERATOR_H = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const BUYER_H = { "x-test-principal": BUYER_003, "x-test-proven-wallet": BUYER_003 };
const ADMIN_H = { "x-admin-key": ADMIN };

let app: FastifyInstance;
let port = 0;
let batchId = "";
let channel = "";
let getStore: typeof import("../../db.js").getStore;
let sensorPipeline: typeof import("../../services.js").sensorPipeline;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  delete process.env.SSE_AUTH_REQUIRED;
  const db = await import("../../db.js");
  getStore = db.getStore;
  db.initStore({ seed: true });
  const { schema } = await import("@pcc/store");
  const now = new Date().toISOString();
  // job-003 (kernel-nyc) has exactly one negotiation session, and it names BUYER_003.
  getStore().db.insert(schema.negotiationSessions).values({
    id: "neg-r3-003", status: "committed", userAgentId: BUYER_003, kernelId: "kernel-nyc", capabilityType: "fdm",
    operatorConstraints: {}, jobId: "job-003", createdAt: now, expiresAt: now,
  } as never).run();

  const services = await import("../../services.js");
  sensorPipeline = services.sensorPipeline;
  // One shared batch on kernel-nyc: a slot for job-001 and a slot for job-003.
  const batch = services.batchTracker.createBatch("kernel-nyc", DEVICE, "cap-nyc-fdm", {});
  services.batchTracker.addSample(batch.id, { position: "A1", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC as never, sampleLabel: "r3-job-001-sample" } as never);
  services.batchTracker.addSample(batch.id, { position: "A2", jobId: "job-003", stepId: "step-3", userId: BUYER_003 as never, sampleLabel: "r3-job-003-sample" } as never);
  batchId = batch.id;
  channel = sensorPipeline.getDescriptors()[0]!.channel;

  const { logger } = await import("../../structured-logger.js");
  // job-001's line, with its binding nested; and a line that names job-001 only in its text.
  logger.log("info", "r3 nested binding line", { source: "f3-r3", metadata: { jobId: "job-001" } } as never);
  logger.log("info", "r3 free text names job-001", { source: "f3-r3" } as never);

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as any).operatorId = principal;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as any).provenWallet = proven;
  });
  const { batchRoutes } = await import("../../routes/batches.js");
  const { telemetryRoutes } = await import("../../routes/telemetry.js");
  const { jobRoutes } = await import("../../routes/jobs.js");
  const { topicSSE } = await import("../../sse/topic-sse.js");
  const { kernelRoutes } = await import("../../routes/kernels.js");
  for (const r of [batchRoutes, telemetryRoutes, jobRoutes, topicSSE, kernelRoutes]) await app.register(r);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
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

/** A job-001 sensor reading on kernel-nyc's device, in the shared batch: it reaches every topic. */
const emitReading = () =>
  sensorPipeline.ingest({
    timestamp: new Date().toISOString(), kernelId: "kernel-nyc", deviceId: DEVICE, channel, dataType: "scalar",
    unit: "degC", value: 37, jobId: "job-001", batchId,
  } as never);

describe("CRITICAL: the kernel, device and batch streams follow the kernel's read rule", () => {
  const paths = () => [`/sse/stream/kernel/kernel-nyc`, `/sse/stream/device/${DEVICE}`, `/sse/stream/batch/${batchId}`];

  it("no credential is 401, an unproven one 403, and a stranger 404, before any event", async () => {
    for (const path of paths()) {
      expect((await stream(path, ANON, emitReading)).status, path).toBe(401);
      expect((await stream(path, UNPROVEN, emitReading)).status, path).toBe(403);
      const stranger = await stream(path, STRANGER_H, emitReading);
      expect(stranger.status, path).toBe(404);
      expect(stranger.body, path).not.toContain("job-001");
    }
  });

  it("a stranger cannot tell an existing kernel, device or batch from a missing one", async () => {
    const pairs = [
      ["/sse/stream/kernel/kernel-nyc", "/sse/stream/kernel/kernel-none", "kernel-nyc", "kernel-none"],
      [`/sse/stream/device/${DEVICE}`, "/sse/stream/device/dev-none", DEVICE, "dev-none"],
      [`/sse/stream/batch/${batchId}`, "/sse/stream/batch/batch-none", batchId, "batch-none"],
    ] as const;
    for (const [real, missing, realId, missingId] of pairs) {
      const a = await stream(real, STRANGER_H, emitReading);
      const b = await stream(missing, STRANGER_H, emitReading);
      expect([a.status, a.body.replace(realId, "X")], real).toEqual([b.status, b.body.replace(missingId, "X")]);
    }
  });

  it("a job's buyer who does not operate the kernel is refused too: it reads its job's own stream", async () => {
    expect((await stream("/sse/stream/kernel/kernel-nyc", BUYER_H, emitReading)).status).toBe(404);
  });

  it("the kernel's operator and an admin subscribe, and receive the reading", async () => {
    for (const path of paths()) {
      for (const headers of [OPERATOR_H, ADMIN_H]) {
        const res = await stream(path, headers, emitReading);
        expect(res.status, path).toBe(200);
        expect(res.body, path).toContain("sensor_reading");
      }
    }
  });
});

describe("CRITICAL: the batch list and detail are the kernel operator's", () => {
  it("identity first: no credential is 401, an unproven one 403", async () => {
    for (const url of ["/api/batches", `/api/batches/${batchId}`]) {
      expect((await get(url, ANON)).statusCode, url).toBe(401);
      expect((await get(url, UNPROVEN)).statusCode, url).toBe(403);
    }
  });

  it("a stranger's list leaves the batch out, and its detail is a missing batch's answer", async () => {
    const list = await get("/api/batches", STRANGER_H);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain("r3-job-001-sample");
    expect(list.body).not.toContain(batchId);
    const detail = await get(`/api/batches/${batchId}`, STRANGER_H);
    const missing = await get("/api/batches/batch-none", STRANGER_H);
    expect([detail.statusCode, detail.body.replace(batchId, "X")]).toEqual([missing.statusCode, missing.body.replace("batch-none", "X")]);
  });

  it("the kernel's operator and an admin read the whole batch", async () => {
    for (const headers of [OPERATOR_H, ADMIN_H]) {
      const list = await get("/api/batches", headers);
      expect(list.body).toContain("r3-job-001-sample");
      expect(list.body).toContain("r3-job-003-sample");
      const detail = (await get(`/api/batches/${batchId}`, headers)).json();
      expect(detail.batch.slots).toHaveLength(2);
    }
  });

  it("a job's buyer: not in the list, and by job it sees only its own slot of the shared batch", async () => {
    expect((await get("/api/batches", BUYER_H)).body).not.toContain(batchId);
    const byJob = await get("/api/batches/by-job/job-003", BUYER_H);
    expect(byJob.statusCode).toBe(200);
    const batches = byJob.json().batches as Array<{ id: string; slots: Array<{ jobId: string }> }>;
    const shared = batches.find((b) => b.id === batchId)!;
    expect(shared.slots.map((s) => s.jobId)).toEqual(["job-003"]);
    expect(byJob.body).not.toContain("r3-job-001-sample");
  });
});

describe("HIGH: the record filter reads bindings at any depth, and leaves a record naming no job to an admin", () => {
  it("a stranger gets neither job-001's nested-binding line nor the line naming job-001 in its text", async () => {
    const res = await get("/api/telemetry/logs", STRANGER_H);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("r3 nested binding line");
    expect(res.body).not.toContain("r3 free text names job-001");
  });

  it("job-001's operator reads the nested-binding line; the unbound free-text line is an admin's", async () => {
    const operator = await get("/api/telemetry/logs", OPERATOR_H);
    expect(operator.body).toContain("r3 nested binding line");
    expect(operator.body).not.toContain("r3 free text names job-001");
    const admin = await get("/api/telemetry/logs", ADMIN_H);
    expect(admin.body).toContain("r3 nested binding line");
    expect(admin.body).toContain("r3 free text names job-001");
  });

  it("identity first on the mixed-record log routes: no credential is 401, an unproven one 403", async () => {
    expect((await get("/api/telemetry/logs", ANON)).statusCode).toBe(401);
    expect((await get("/api/telemetry/logs", UNPROVEN)).statusCode).toBe(403);
  });

  it("the live log stream applies the same rule to a nested binding (a live event, not history)", async () => {
    const { streamHub } = await import("../../sse/stream-hub.js");
    // A producer that nests the job binding, published on the live global topic during the stream.
    const emit = (tag: string) => () =>
      streamHub.publish([{ type: "global", id: "*" }], {
        id: `r3-live-${tag}`, type: "log_entry", timestamp: new Date().toISOString(), topic: { type: "global", id: "*" },
        payload: { level: "info", message: `r3 live nested line ${tag}`, source: "f3-r3", metadata: { jobId: "job-001" } },
      } as never);
    const stranger = await stream("/api/telemetry/logs/stream", STRANGER_H, emit("s"));
    expect(stranger.status).toBe(200);
    expect(stranger.body).not.toContain("r3 live nested line s");
    const operator = await stream("/api/telemetry/logs/stream", OPERATOR_H, emit("o"));
    expect(operator.body).toContain("r3 live nested line o");
  });
});

describe("MEDIUM: the gate's authorization reads are keyed by the caller, not by the requested job", () => {
  it("a stranger's reads for an existing job and a missing job look up the same kernels", async () => {
    const repos = getStore().repos as unknown as { kernels: { findById: (id: string) => unknown } };
    const calls: string[][] = [];
    const spy = vi.spyOn(repos.kernels, "findById");
    try {
      for (const url of ["/api/batches/by-job/job-001", "/api/batches/by-job/job-none"]) {
        spy.mockClear();
        expect((await get(url, STRANGER_H)).statusCode, url).toBe(200);
        calls.push(spy.mock.calls.map((c) => String(c[0])));
      }
    } finally {
      spy.mockRestore();
    }
    expect(calls[0]).toEqual(calls[1]);
  });
});

describe("HIGH: recordBindingsOf finds every job and kernel a record names, and a malformed binding fails closed", () => {
  it("reads bindings at any depth, in objects and arrays, under each key spelling", () => {
    expect(recordBindingsOf({ message: "x", metadata: { jobId: "job-001" } })).toEqual({ jobs: ["job-001"], kernels: [], slots: [], batches: [], malformed: false });
    expect(recordBindingsOf({ payload: { items: [{ job_id: "job-002" }, { JobId: "job-003" }] } }).jobs).toEqual(["job-002", "job-003"]);
    expect(recordBindingsOf({ jobIds: ["job-001", "job-003"], kernel_id: "kernel-nyc" })).toEqual({
      jobs: ["job-001", "job-003"],
      kernels: ["kernel-nyc"],
      slots: [],
      batches: [],
      malformed: false,
    });
    // An absent top-level binding does not hide a nested one (the r2 finding's third shape).
    expect(recordBindingsOf({ jobId: undefined, metadata: { jobId: "job-001" } }).jobs).toEqual(["job-001"]);
    expect(recordBindingsOf({ message: "names job-001 only in its text" })).toEqual({ jobs: [], kernels: [], slots: [], batches: [], malformed: false });
  });

  it("NEGATIVE: a binding that is not a nonempty string, or a record nested too deep, is malformed", () => {
    const bad: unknown[] = [
      { jobId: 7 },
      { jobId: "" },
      { jobId: "   " },
      { meta: { jobId: { id: "job-001" } } },
      { jobIds: "job-001" },
      { kernelIds: [1] },
      { payload: { kernelId: true } },
    ];
    for (const record of bad) expect(recordBindingsOf(record).malformed, JSON.stringify(record)).toBe(true);
    let deep: Record<string, unknown> = { jobId: "job-001" };
    for (let i = 0; i < 12; i++) deep = { child: deep };
    expect(recordBindingsOf(deep).malformed).toBe(true);
  });

  it("a record that refers to itself is read once", () => {
    const record: Record<string, unknown> = { jobId: "job-001" };
    record.self = record;
    expect(recordBindingsOf(record)).toEqual({ jobs: ["job-001"], kernels: [], slots: [], batches: [], malformed: false });
  });
});

describe("found while fixing r3: a kernel's job list and its recent jobs follow the job read rule", () => {
  const ids = (jobs: Array<{ id: string }>) => jobs.map((job) => job.id).sort();

  it("GET /api/kernels/:kernelId/jobs: identity first, then only the jobs the caller may read", async () => {
    expect((await get("/api/kernels/kernel-nyc/jobs", ANON)).statusCode).toBe(401);
    expect((await get("/api/kernels/kernel-nyc/jobs", UNPROVEN)).statusCode).toBe(403);
    expect((await get("/api/kernels/kernel-nyc/jobs", STRANGER_H)).json().jobs).toEqual([]);
    expect(ids((await get("/api/kernels/kernel-nyc/jobs", BUYER_H)).json().jobs)).toEqual(["job-003"]);
    const operator = ids((await get("/api/kernels/kernel-nyc/jobs", OPERATOR_H)).json().jobs);
    expect(operator).toContain("job-001");
    expect(operator).toEqual(ids((await get("/api/kernels/kernel-nyc/jobs", ADMIN_H)).json().jobs));
  });

  it("GET /api/kernels/:kernelId stays public, but its recentJobs hold only the jobs the caller may read", async () => {
    for (const headers of [ANON, UNPROVEN, STRANGER_H]) {
      const res = await get("/api/kernels/kernel-nyc", headers);
      expect(res.statusCode).toBe(200);
      expect(res.json().kernel.recentJobs).toEqual([]);
      expect(res.json().kernel.recentJobsScope).toBe("readable_by_caller");
      expect(res.body).not.toContain("job-001");
    }
    expect(ids((await get("/api/kernels/kernel-nyc", BUYER_H)).json().kernel.recentJobs)).toEqual(["job-003"]);
    const admin = (await get("/api/kernels/kernel-nyc", ADMIN_H)).json().kernel;
    expect(admin.recentJobsScope).toBe("all");
    expect(ids(admin.recentJobs)).toContain("job-001");
  });
});
