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
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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
    // As apiGate does for an API key: the key's record id and its (claimed) operator id.
    if (typeof principal === "string") {
      (req as any).operatorId = principal;
      (req as any).apiKeyId = `key-${principal}`;
    }
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

describe("N122 POST /api/telemetry/emit: only the admin or a PROVEN party of the job (#6488)", () => {
  const emit = (headers: Record<string, string>, jobId = "job-001") =>
    app.inject({ method: "POST", url: "/api/telemetry/emit", headers, payload: { jobId, phase: "discovery", status: "started" } });
  const events = async () => (await import("../../telemetry.js")).pipelineTelemetry.getTimeline("job-001").length;

  it("anonymous is 401 and nothing is written", async () => {
    const before = await events();
    expect((await emit(ANON)).statusCode).toBe(401);
    expect(await events()).toBe(before);
  });

  it("a claimed (unproven) key is 403, even the kernel operator's own claim", async () => {
    const before = await events();
    expect((await emit(UNPROVEN)).statusCode).toBe(403);
    expect(await events()).toBe(before);
  });

  it("a proven stranger is refused as if the job did not exist, and nothing is written", async () => {
    const before = await events();
    const res = await emit(STRANGER_H);
    expect(res.statusCode).toBe(404);
    expect(await events()).toBe(before);
  });

  it("the job's kernel operator (proven) and the admin emit", async () => {
    const before = await events();
    expect((await emit(NYC)).statusCode).toBe(200);
    expect((await emit(ADMIN_H)).statusCode).toBe(200);
    expect(await events()).toBe(before + 2);
  });
});

describe("N122 r1 CRITICAL: another party's emission cannot change a caller's scoped stats", () => {
  // astra's trace (rm-n122-580-r1, N122-1): the scoped events-per-minute window was anchored to
  // the newest bucket of ANY job, so an emission on a job the caller cannot read moved the
  // caller's window and changed its rate. The window is now anchored to the clock.
  // Below the buffer's job capacity (MAX_JOBS): past it, a new job evicts the oldest, whoever's.
  // The suite's own events were emitted at real time, a day before T0, outside every window here.
  const T0 = (Math.floor(Date.now() / 60_000) + 24 * 60) * 60_000 + 5_000;
  afterEach(() => vi.useRealTimers());

  it("astra's trace: 11 quiet minutes after the caller's event, a stranger's emission changes nothing", async () => {
    const { pipelineTelemetry, PIPELINE_PHASES } = await import("../../telemetry.js");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    pipelineTelemetry.emit("job-003", PIPELINE_PHASES[0]!, "started"); // kernel-nyc's job
    vi.setSystemTime(T0 + 5 * 60_000);
    expect((await stats(NYC)).json().stats.eventsPerMinute).toBe(1);
    vi.setSystemTime(T0 + 11 * 60_000);
    const before = (await stats(NYC)).json().stats;
    expect(before.eventsPerMinute).toBe(0); // aged out by the clock, not by anyone's emission
    pipelineTelemetry.emit("job-002", PIPELINE_PHASES[0]!, "started"); // kernel-sf's: NYC cannot read it
    expect((await stats(NYC)).json().stats).toEqual(before);
  });

  it("at every minute of the window and past its edge, a stranger's emission leaves every scoped statistic unchanged", async () => {
    const { pipelineTelemetry, PIPELINE_PHASES } = await import("../../telemetry.js");
    vi.useFakeTimers({ toFake: ["Date"] });
    const t1 = T0 + 60 * 60_000;
    vi.setSystemTime(t1);
    pipelineTelemetry.emit("job-004", PIPELINE_PHASES[0]!, "started"); // kernel-nyc's job
    for (const minutes of [0, 1, 5, 9, 10, 11, 12, 30]) {
      vi.setSystemTime(t1 + minutes * 60_000 + 30_000);
      const before = (await stats(NYC)).json().stats;
      pipelineTelemetry.emit("job-002", PIPELINE_PHASES[1]!, "started"); // kernel-sf's
      pipelineTelemetry.emit(`job-n122-other-${minutes}`, PIPELINE_PHASES[0]!, "started"); // nobody's job row
      expect((await stats(NYC)).json().stats, `${minutes} min after NYC's event`).toEqual(before);
    }
  });
});

describe("N122 a pipeline timeline read cannot change the stored timeline (#538 r3 class)", () => {
  it("mutating a returned timeline, event or metadata leaves the next read unchanged", async () => {
    const { pipelineTelemetry } = await import("../../telemetry.js");
    pipelineTelemetry.emit("job-n122-immutable", "discovery", "started", { metadata: { note: "original" } });
    const first = pipelineTelemetry.getTimeline("job-n122-immutable") as unknown as Array<Record<string, any>>;
    try { first.push({ forged: true }); } catch { /* frozen is fine too */ }
    try { first[0]!.status = "failed"; } catch { /* frozen is fine too */ }
    try { first[0]!.metadata.note = "forged"; } catch { /* frozen is fine too */ }
    const again = pipelineTelemetry.getTimeline("job-n122-immutable");
    expect(again.length).toBe(1);
    expect(again[0]!.status).toBe("started");
    expect(again[0]!.metadata).toEqual({ note: "original" });
  });
});
