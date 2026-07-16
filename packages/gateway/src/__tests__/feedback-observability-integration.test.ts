import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 3 reconciliation — end-to-end: a report POSTed to /api/feedback must show up
 * in the admin-observability troubleshooting views (which read the `agent.report`
 * audit event). This is the "local smoke" as a CI test: it uses a real store so the
 * audit event actually persists and the observability handlers query it back.
 */
let tmpDir: string;
let app: FastifyInstance;
let closeStore: () => void;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-fb-obs-"));
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite");
  process.env.WAITLIST_ADMIN_TOKEN = "t";
  delete process.env.PCC_FUNNEL_ENABLED; // OFF — the feedback/errors views must work anyway
  delete process.env.PCC_OBSERVABILITY_ADMINS; // → allowed outside production
  delete process.env.NODE_ENV; // ensure not "production" so the admin guard permits
  delete process.env.DISCORD_WEBHOOK_URL;

  const db = await import("../db.js");
  db.initStore({ seed: false });
  closeStore = db.closeStore;

  const { feedbackRoutes } = await import("../routes/feedback.js");
  const { adminObservabilityRoutes } = await import("../routes/admin-observability.js");
  app = Fastify({ logger: false });
  await app.register(feedbackRoutes);
  await app.register(adminObservabilityRoutes);
  await app.ready();
}, 60000); // initStore + the observability dep chain is heavy — allow time

afterAll(async () => {
  await app?.close();
  closeStore?.();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { __resetFeedbackRateLimit, __resetFeedbackDedup } = await import("../routes/feedback.js");
  __resetFeedbackRateLimit();
  __resetFeedbackDedup();
});

describe("feedback → observability view (Phase 3 reconciliation)", () => {
  it("a /api/feedback report appears in the observability feedback stream + error histogram", async () => {
    const post = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: {
        type: "bug",
        summary: "contract build blew up",
        endpoint: "/api/build/contract",
        method: "POST",
        status: 500,
        errorCode: "TIER_MISMATCH",
        traceId: "tr_abc0000000000001",
        agentId: "claude",
      },
    });
    expect(post.statusCode).toBe(201);

    // 1) the feedback stream view (reads agent.report audit events) shows it
    const stream = await app.inject({
      method: "GET",
      url: "/api/admin/observability/feedback",
      headers: { "x-admin-token": "t" },
    });
    expect(stream.statusCode).toBe(200);
    const reports = stream.json().reports as Array<Record<string, unknown>>;
    const mine = reports.find((r) => r.trace_id === "tr_abc0000000000001");
    expect(mine, "the new report must appear in the observability feedback stream").toBeTruthy();
    expect(mine).toMatchObject({
      summary: "contract build blew up",
      agent_kind: "claude",
      last_endpoint: "/api/build/contract",
      last_error_code: "TIER_MISMATCH",
    });

    // 2) the error histogram view counts its errorCode
    const errors = await app.inject({
      method: "GET",
      url: "/api/admin/observability/errors",
      headers: { "x-admin-token": "t" },
    });
    expect(errors.statusCode).toBe(200);
    const hist = errors.json().by_error_code as Array<{ error_code: string; count: number }>;
    expect(hist.find((h) => h.error_code === "TIER_MISMATCH")?.count).toBeGreaterThanOrEqual(1);
  });

  it("funnel/journey views stay gated on PCC_FUNNEL_ENABLED (journey recording is opt-in)", async () => {
    // The feedback + errors views worked above with the flag OFF; the funnel view needs
    // per-request journey recording, so it must still 404 until PCC_FUNNEL_ENABLED=true.
    const funnel = await app.inject({ method: "GET", url: "/api/admin/observability/funnel", headers: { "x-admin-token": "t" } });
    expect(funnel.statusCode).toBe(404);
    expect(funnel.json().error).toBe("not_enabled");
  });

  it("also still lands in the durable admin feedback export", async () => {
    await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "durable + observable", endpoint: "/api/x" } });
    const admin = await app.inject({ method: "GET", url: "/api/admin/feedback", headers: { "x-admin-token": "t" } });
    expect(admin.statusCode).toBe(200);
    expect((admin.json().items as unknown[]).some((i) => (i as { summary?: string }).summary === "durable + observable")).toBe(true);
  });
});
