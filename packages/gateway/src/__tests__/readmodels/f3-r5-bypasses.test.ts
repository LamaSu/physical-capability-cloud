/**
 * Cross-family review r4 of #403 (rm-f3-403-r4-aa7b009a, DO-NOT-SHIP). These tests reproduce its
 * findings at aa7b009a and pin the rule that replaces each:
 *   CRITICAL 1  a batch's job-bound data outside `slots` (runConfig, sample events that name only a
 *               slot) reached a caller who may not read the slot's job, also by stream replay;
 *   HIGH 2      batch slots were filtered as live objects and sent in another form (toJSON, nesting);
 *   HIGH 3      anyone could release a shared-batch claim and receive the whole removed claim;
 *   MEDIUM 4    a tenant-scoped admin's refusal read the job row only when the record existed;
 *   MEDIUM 5    the logs response listed the sources of lines the caller may not read.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc operator
const STRANGER = "0x9999999999999999999999999999999999999999";
const ADMIN = "f3-r5-admin-key";
const DEVICE = "dev-fdm-prusa-mk4"; // seeded on kernel-nyc
const ANON = {};
const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const OPERATOR_H = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const ADMIN_H = { "x-admin-key": ADMIN };
const TENANT_A_ADMIN = { ...ADMIN_H, "x-test-tenant": "tenant-a" };
const TENANT_A_OPERATOR = { ...OPERATOR_H, "x-test-tenant": "tenant-a" };

let app: FastifyInstance;
let port = 0;
let batchId = "";
let firstEventId = "";
let sharedId = "";
let victimClaimId = "";
let getStore: typeof import("../../db.js").getStore;

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
  // Two tenants share kernel-nyc: job-001 is tenant A's, job-003 tenant B's.
  store.db.update(schema.jobs).set({ tenantId: "tenant-a" } as never).where(eq(schema.jobs.id, "job-001")).run();
  store.db.update(schema.jobs).set({ tenantId: "tenant-b" } as never).where(eq(schema.jobs.id, "job-003")).run();
  // Tenant B's evidence bundle (MEDIUM 4).
  (store.repos as any).evidence.insert({
    id: "bun-r5-003", jobId: "job-003", stepId: "step-3", kernelId: "kernel-nyc", assuranceTier: 1, tenantId: "tenant-b",
    bundleHash: "cd".repeat(32), kernelSignature: { signer: OPERATOR_NYC, algorithm: "secp256k1", value: "sig" }, createdAt: now,
  });

  const services = await import("../../services.js");
  // A mixed-tenant batch: its runConfig names tenant B's job, and tenant B's slot completes with a result.
  const batch = services.batchTracker.createBatch("kernel-nyc", DEVICE, "cap-nyc-fdm", { jobId: "job-003", secret: "r5-tenant-b-config" });
  services.batchTracker.addSample(batch.id, { position: "A1", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC as never, sampleLabel: "r5-tenant-a-sample" } as never);
  const bSlot = services.batchTracker.addSample(batch.id, { position: "A2", jobId: "job-003", stepId: "step-3", userId: OPERATOR_NYC as never, sampleLabel: "r5-tenant-b-sample" } as never);
  // A tenant-A slot whose sent form (toJSON) is tenant B's, and one with tenant B's job nested inside (HIGH 2).
  services.batchTracker.addSample(batch.id, {
    position: "A3", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC as never, sampleLabel: "r5-live-label",
    toJSON: () => ({ jobId: "job-003", sampleLabel: "r5-tojson-slot-secret" }),
  } as never);
  services.batchTracker.addSample(batch.id, {
    position: "A4", jobId: "job-001", stepId: "step-1", userId: OPERATOR_NYC as never, sampleLabel: "r5-nested-label",
    metadata: { jobId: "job-003", secret: "r5-nested-slot-secret" },
  } as never);
  services.batchTracker.completeSlot(batch.id, (bSlot as { id: string }).id, "ef".repeat(32) as never, "r5-tenant-b-result");
  batchId = batch.id;
  firstEventId = services.batchTracker.getEvents(batch.id)[0]!.id;

  const { logger } = await import("../../structured-logger.js");
  logger.log("info", "r5 private line", { source: "r5-tenant-b-private-source", jobId: "job-003" } as never);

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

  // A shared batch with a victim's claim (HIGH 3).
  const created = await app.inject({
    method: "POST", url: "/api/batches/shared",
    payload: { kernelId: "kernel-nyc", capabilityType: "hplc", totalSlots: 8, protocolType: "hplc-standard", pricePerSlot: "10" },
  });
  sharedId = created.json().batch.id;
  const claim = await app.inject({
    method: "POST", url: `/api/batches/shared/${sharedId}/claim`,
    payload: { agentId: "agent-r5-victim", slotCount: 2, sampleLabels: ["r5-victim-sample", "r5-victim-sample"] },
  });
  victimClaimId = claim.json().claim.id;
}, 60_000);

afterAll(async () => {
  await app?.close();
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.TENANT_ENFORCE;
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });

/** Opens a stream for a moment and returns what arrived (replayed events included). */
const stream = (path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      if (res.statusCode !== 200) return;
      setTimeout(() => {
        req.destroy();
        resolve({ status: 200, body });
      }, 200);
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

const LEAKS = ["r5-tenant-b-config", "r5-tenant-b-result", "r5-tenant-b-sample", "r5-tojson-slot-secret", "r5-nested-slot-secret"];
const SLOT_FORM_LEAKS = ["r5-tojson-slot-secret", "r5-nested-slot-secret"];

describe("CRITICAL 1 and HIGH 2: a batch's job-bound parts reach only callers who may read their job, as sent", () => {
  it("under TENANT_ENFORCE, tenant A's admin and operator get none of tenant B's batch data from the list, detail or by-job", async () => {
    await withTenantEnforce(async () => {
      for (const headers of [TENANT_A_ADMIN, TENANT_A_OPERATOR]) {
        for (const url of ["/api/batches", `/api/batches/${batchId}`, "/api/batches/by-job/job-001"]) {
          const res = await get(url, headers);
          expect(res.statusCode, url).toBe(200);
          expect(res.body, url).toContain("r5-tenant-a-sample");
          for (const leak of LEAKS) expect(res.body, `${url} ${leak}`).not.toContain(leak);
        }
      }
    });
  });

  it("HIGH 2: a slot is judged as sent: a toJSON form or a nested binding naming tenant B's job withholds it", async () => {
    await withTenantEnforce(async () => {
      for (const url of ["/api/batches", `/api/batches/${batchId}`, "/api/batches/by-job/job-001"]) {
        const res = await get(url, TENANT_A_OPERATOR);
        expect(res.statusCode, url).toBe(200);
        for (const leak of SLOT_FORM_LEAKS) expect(res.body, `${url} ${leak}`).not.toContain(leak);
      }
    });
  });

  it("the batch stream, replayed from its first event, carries none of tenant B's batch data to tenant A's admin", async () => {
    await withTenantEnforce(async () => {
      const res = await stream(`/sse/stream/batch/${batchId}`, { ...TENANT_A_ADMIN, "last-event-id": firstEventId });
      expect(res.status).toBe(200);
      for (const leak of LEAKS) expect(res.body, leak).not.toContain(leak);
    });
  });

  it("an admin without a tenant still reads the whole batch, its runConfig and its events", async () => {
    const res = await get(`/api/batches/${batchId}`, ADMIN_H);
    expect(res.statusCode).toBe(200);
    for (const seen of ["r5-tenant-b-config", "r5-tenant-b-result", "r5-tenant-b-sample"]) expect(res.body).toContain(seen);
  });
});

describe("HIGH 3: releasing a shared-batch claim is the kernel operator's, an admin's, or its named claimant's", () => {
  it("anonymous and stranger callers neither release the claim nor receive it", async () => {
    const anon = await app.inject({ method: "DELETE", url: `/api/batches/shared/${sharedId}/claim/${victimClaimId}`, headers: ANON });
    expect(anon.statusCode).toBe(401);
    const stranger = await app.inject({ method: "DELETE", url: `/api/batches/shared/${sharedId}/claim/${victimClaimId}`, headers: STRANGER_H });
    expect(stranger.statusCode).toBe(404);
    expect(stranger.body).not.toContain("agent-r5-victim");
    // The claim is still there: the kernel's operator sees it.
    const detail = await get(`/api/batches/shared/${sharedId}`, OPERATOR_H);
    expect(detail.body).toContain("agent-r5-victim");
  });
});

describe("MEDIUM 4: a tenant-scoped admin's record-by-id refusal reads no job row, whether or not the record exists", () => {
  it("tenant A's admin asking for tenant B's bundle and for a missing bundle makes the same job reads", async () => {
    await withTenantEnforce(async () => {
      const spy = vi.spyOn(getStore().repos.jobs as any, "findById");
      try {
        spy.mockClear();
        const existing = await get("/api/compliance/evidence/bun-r5-003", TENANT_A_ADMIN);
        const existingCalls = spy.mock.calls.map((c) => c[0]);
        spy.mockClear();
        const missing = await get("/api/compliance/evidence/bun-r5-none", TENANT_A_ADMIN);
        const missingCalls = spy.mock.calls.map((c) => c[0]);
        expect([existing.statusCode, missing.statusCode]).toEqual([404, 404]);
        expect(existingCalls).toEqual(missingCalls);
      } finally {
        spy.mockRestore();
      }
    });
  });
});

describe("MEDIUM 5: the logs response lists only the sources of lines the caller receives", () => {
  it("a stranger is not told the source of a line it may not read", async () => {
    const res = await get("/api/telemetry/logs", STRANGER_H);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("r5-tenant-b-private-source");
  });
});
