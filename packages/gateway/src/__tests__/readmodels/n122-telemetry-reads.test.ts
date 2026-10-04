/**
 * Board N122 (bus #6347 and #6351; the read family, F3's pattern): pipeline telemetry and the
 * gateway's audit log went to any authenticated caller.
 *   - GET /api/telemetry/stats counted every job's pipeline (jobs, active jobs, success rate,
 *     per-phase totals, events per minute) for anyone. It now counts only the jobs the caller may
 *     read, the same scope as /api/telemetry/jobs and /active (jobReadScopeOf).
 *   - GET /api/telemetry/audit returned the gateway-wide audit log (actors and write metadata)
 *     to anyone. Its records name actors, not jobs, so under F3's mixed-record rule they are the
 *     admin's: it is now admin-only.
 *
 * Same stand-in gate as the F3 tests: x-test-principal is the claimed operatorId and
 * x-test-proven-wallet is req.provenWallet (WP-A's field).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../services/posthog-service.js", () => ({ trackServerEvent: vi.fn(), shutdownPostHog: vi.fn() }));

const OPERATOR_NYC = "0x1111111111111111111111111111111111111111"; // seeded kernel-nyc: job-001, job-003, job-004
const OPERATOR_SF = "0x2222222222222222222222222222222222222222"; // seeded kernel-sf: job-002
const STRANGER = "0x9999999999999999999999999999999999999999";
const ADMIN = "n122-admin-key";

const ANON = {};
const UNPROVEN = { "x-test-principal": OPERATOR_NYC };
const STRANGER_H = { "x-test-principal": STRANGER, "x-test-proven-wallet": STRANGER };
const NYC = { "x-test-principal": OPERATOR_NYC, "x-test-proven-wallet": OPERATOR_NYC };
const SF = { "x-test-principal": OPERATOR_SF, "x-test-proven-wallet": OPERATOR_SF };
const ADMIN_H = { "x-admin-key": ADMIN };

const PREV_DB = process.env.PCC_DB_PATH;
const PREV_ADMIN = process.env.PCC_ADMIN_KEY;
let app: FastifyInstance;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ADMIN;
  const db = await import("../../db.js");
  db.closeStore();
  db.initStore({ seed: true });

  const { pipelineTelemetry, PIPELINE_PHASES } = await import("../../telemetry.js");
  // kernel-nyc's job-001: two events, the last one failed. kernel-sf's job-002: three events,
  // completed. A job with no row at all (only an admin's): one event.
  pipelineTelemetry.emit("job-001", PIPELINE_PHASES[0]!, "started");
  pipelineTelemetry.emit("job-001", PIPELINE_PHASES[1]!, "failed", { duration_ms: 10 });
  pipelineTelemetry.emit("job-002", PIPELINE_PHASES[0]!, "started");
  pipelineTelemetry.emit("job-002", PIPELINE_PHASES[1]!, "started", { duration_ms: 1000 });
  pipelineTelemetry.emit("job-002", PIPELINE_PHASES[2]!, "completed", { duration_ms: 3000 });
  pipelineTelemetry.emit("job-n122-orphan", PIPELINE_PHASES[0]!, "started");

  const { auditService } = await import("../../services/audit-service.js");
  expect(auditService.log({ eventType: "http.write", actor: OPERATOR_SF, resourceType: "kernel", resourceId: "kernel-sf", action: "POST", metadata: { method: "POST" } })).toBe(true);

  app = Fastify({ logger: false });
  app.addHook("onRequest", async (req) => {
    const principal = req.headers["x-test-principal"];
    if (typeof principal === "string") (req as any).operatorId = principal;
    const proven = req.headers["x-test-proven-wallet"];
    if (typeof proven === "string") (req as any).provenWallet = proven;
  });
  const { telemetryRoutes } = await import("../../routes/telemetry.js");
  await app.register(telemetryRoutes);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close();
  (await import("../../db.js")).closeStore();
  if (PREV_DB === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = PREV_DB;
  if (PREV_ADMIN === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = PREV_ADMIN;
});

const stats = async (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/telemetry/stats", headers });

describe("N122 GET /api/telemetry/stats counts only the caller's jobs", () => {
  it("anonymous is 401 and a claimed (unproven) identity is 403, before anything is counted", async () => {
    expect((await stats(ANON)).statusCode).toBe(401);
    const res = await stats(UNPROVEN);
    expect(res.statusCode).toBe(403);
    expect(res.json()).not.toHaveProperty("stats");
  });

  it("kernel-nyc's proven operator sees only job-001's pipeline", async () => {
    const res = await stats(NYC);
    expect(res.statusCode).toBe(200);
    const s = res.json().stats;
    expect(s.totalJobs).toBe(1);
    expect(s.totalEvents).toBe(2);
    expect(s.activeJobs).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.avgDuration_ms).toBe(10);
    expect(s.eventsPerMinute).toBeGreaterThan(0);
    expect(s.eventsPerMinute).toBeLessThanOrEqual(2);
  });

  it("kernel-sf's proven operator sees only job-002's pipeline", async () => {
    const s = (await stats(SF)).json().stats;
    expect(s.totalJobs).toBe(1);
    expect(s.totalEvents).toBe(3);
    expect(s.successRate).toBe(1);
    expect(s.avgDuration_ms).toBe(2000);
  });

  it("a proven stranger counts nothing: every total is zero", async () => {
    const res = await stats(STRANGER_H);
    expect(res.statusCode).toBe(200);
    const s = res.json().stats;
    expect(s).toMatchObject({ totalJobs: 0, activeJobs: 0, totalEvents: 0, successRate: 0, avgDuration_ms: 0, eventsPerMinute: 0 });
    for (const phase of Object.values(s.byPhase) as Array<{ total: number; failed: number }>) {
      expect(phase).toEqual({ total: 0, failed: 0 });
    }
  });

  it("the admin counts every job, including one with no job row", async () => {
    const s = (await stats(ADMIN_H)).json().stats;
    expect(s.totalJobs).toBeGreaterThanOrEqual(3);
    expect(s.totalEvents).toBeGreaterThanOrEqual(6);
  });
});

describe("N122 GET /api/telemetry/audit is the admin's", () => {
  const audit = async (headers: Record<string, string>) => app.inject({ method: "GET", url: "/api/telemetry/audit?limit=500", headers });

  it("anonymous is 401, and every non-admin caller is refused without entries", async () => {
    expect((await audit(ANON)).statusCode).toBe(401);
    for (const headers of [UNPROVEN, STRANGER_H, NYC, SF]) {
      const res = await audit(headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json()).not.toHaveProperty("entries");
    }
  });

  it("the admin reads the audit log", async () => {
    const res = await audit(ADMIN_H);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().entries)).toBe(true);
    expect(res.json().entries.length).toBeGreaterThan(0);
  });
});
