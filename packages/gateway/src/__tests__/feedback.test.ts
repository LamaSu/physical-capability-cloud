/**
 * feedback.test.ts — durable agent + human feedback sink.
 *
 * Acceptance: a cold (unauthenticated) agent can POST /api/feedback and it lands
 * in storage readable via GET /api/admin/feedback (X-Admin-Token gated).
 *
 * Covers:
 *   • Cold POST with the canonical agent shape → 201, lands in admin export.
 *   • Legacy dashboard shape ({type, message, page}) still accepted (back-compat).
 *   • Honeypot (website/hp) → accepted silently, NOT stored.
 *   • Missing summary/message → 400.
 *   • Invalid email → 400.
 *   • Unknown type coerced; canonical types preserved.
 *   • Per-IP rate limit → 429.
 *   • GET /api/admin/feedback: 403 without token, 200 + items with token.
 *
 * Env (PCC_DB_PATH, PCC_FEEDBACK_RATE_MAX) is read at module-load time, so the
 * route is dynamically imported AFTER the env is set.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ADMIN_TOKEN = "test-admin-token-123";
const RATE_MAX = 5;

let tmpDir: string;
let feedbackFile: string;
let feedbackRoutes: typeof import("../routes/feedback.js").feedbackRoutes;
let resetRateLimit: typeof import("../routes/feedback.js").__resetFeedbackRateLimit;
let resetDedup: typeof import("../routes/feedback.js").__resetFeedbackDedup;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-feedback-test-"));
  feedbackFile = join(tmpDir, "feedback.jsonl");
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite"); // DATA_DIR = dirname() = tmpDir
  process.env.PCC_FEEDBACK_RATE_MAX = String(RATE_MAX);
  process.env.WAITLIST_ADMIN_TOKEN = ADMIN_TOKEN;
  delete process.env.DISCORD_WEBHOOK_URL; // keep the test offline

  const mod = await import("../routes/feedback.js");
  feedbackRoutes = mod.feedbackRoutes;
  resetRateLimit = mod.__resetFeedbackRateLimit;
  resetDedup = mod.__resetFeedbackDedup;
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(feedbackRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  rmSync(feedbackFile, { force: true }); // fresh storage per test
  resetRateLimit();
  resetDedup();
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

async function adminItems(): Promise<{ total: number; items: any[] }> {
  const res = await app.inject({
    method: "GET",
    url: "/api/admin/feedback",
    headers: { "x-admin-token": ADMIN_TOKEN },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("POST /api/feedback (public)", () => {
  it("accepts a cold, unauthenticated agent report and stores it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: {
        type: "bug",
        summary: "build/options returned 500 with no hint about the missing field",
        detail: "Called POST /api/build/options with {type:'3d-printing'} and got a bare 500.",
        endpoint: "/api/build/options",
        traceId: "tr_1234567890abcdef",
        severity: "high",
        agentId: "claude",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.submitted).toBe(true);
    expect(body.id).toMatch(/^fb-/);

    const { total, items } = await adminItems();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      type: "bug",
      summary: "build/options returned 500 with no hint about the missing field",
      endpoint: "/api/build/options",
      traceId: "tr_1234567890abcdef",
      severity: "high",
      agentId: "claude",
      status: "new",
    });
    expect(items[0].id).toBe(body.id);
    expect(items[0].createdAt).toBeTruthy();
  });

  it("persists the report_hint send{} fields — method + httpStatus (auto-feedback)", async () => {
    // Exactly what an agent copies from a 5xx `report_hint.send` block + a summary.
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: {
        type: "bug",
        summary: "500 on the contract build step",
        endpoint: "/api/build/contract",
        method: "POST",
        status: 500,
        errorCode: "TIER_MISMATCH",
        traceId: "tr_deadbeef",
      },
    });
    expect(res.statusCode).toBe(201);
    const { items } = await adminItems();
    expect(items[0]).toMatchObject({
      endpoint: "/api/build/contract",
      method: "POST",
      httpStatus: 500, // send.status → httpStatus (never collides with the workflow `status`)
      errorCode: "TIER_MISMATCH",
    });
    expect(items[0].status).toBe("new"); // workflow status is unaffected by the HTTP status
  });

  it("coerces a string HTTP status, nulls out-of-range and fractional ones", async () => {
    await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "string status here", status: "503" } });
    await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "bogus status here", status: 99999 } });
    await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "fractional status here", status: 503.9 } });
    const { items } = await adminItems();
    const byStatus = Object.fromEntries(items.map((i) => [i.summary, i.httpStatus]));
    expect(byStatus["string status here"]).toBe(503);
    expect(byStatus["bogus status here"]).toBeNull();
    expect(byStatus["fractional status here"]).toBeNull(); // not silently truncated to 503
  });

  it("persists a bounded, secret-redacted logs array (Phase 2)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: {
        summary: "failed at the contract step",
        logs: [
          { step: 1, method: "POST", path: "/api/build/options", status: 200 },
          { step: 2, method: "POST", path: "/api/build/contract", status: 500, note: "leaked pcc_live_ABCDEFGH123 here" },
          "junk-not-an-object",
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const { items } = await adminItems();
    expect(items[0].logs).toHaveLength(2); // the junk entry is dropped
    expect(items[0].logs[1]).toMatchObject({ step: 2, method: "POST", path: "/api/build/contract", status: 500 });
    expect(items[0].logs[1].note).not.toContain("pcc_live_ABCDEFGH123"); // note is redacted
    expect(items[0].logs[1].note).toContain("redacted");
  });

  it("caps the logs array at 20 entries", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ step: i, note: `step ${i}` }));
    await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "many steps", logs: many } });
    const { items } = await adminItems();
    expect(items[0].logs).toHaveLength(20);
  });

  it("redacts secrets from summary + detail before persisting (Phase 2)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { summary: "my key pcc_live_SUPERSECRET1 failed", detail: "sent Authorization: Bearer eyabc.DEF.ghijklmnop123456" },
    });
    const { items } = await adminItems();
    expect(items[0].summary).not.toContain("pcc_live_SUPERSECRET1");
    expect(items[0].summary).toContain("pcc_live_redacted");
    expect(items[0].detail).toContain("Bearer [redacted]");
  });

  it("dedups a retry-looping agent's identical reports within the window (Phase 2)", async () => {
    const payload = { summary: "same failure", endpoint: "/api/build/contract", errorCode: "TIER_MISMATCH", traceId: "tr_loop" };
    const first = await app.inject({ method: "POST", url: "/api/feedback", payload });
    const second = await app.inject({ method: "POST", url: "/api/feedback", payload });
    expect(first.statusCode).toBe(201);
    expect(first.json().submitted).toBe(true);
    expect(second.statusCode).toBe(200); // not an error → the agent won't retry
    expect(second.json().deduped).toBe(true);
    expect((await adminItems()).total).toBe(1); // only one persisted

    // a genuinely different report is NOT deduped
    const third = await app.inject({ method: "POST", url: "/api/feedback", payload: { ...payload, summary: "a different failure" } });
    expect(third.statusCode).toBe(201);
    expect((await adminItems()).total).toBe(2);
  });

  it("accepts the legacy dashboard shape ({type, message, page})", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { type: "suggestion", message: "the build wizard is confusing", page: "/build" },
    });
    expect(res.statusCode).toBe(201);

    const { items } = await adminItems();
    expect(items).toHaveLength(1);
    // message → summary, page → endpoint (back-compat mapping)
    expect(items[0].summary).toBe("the build wizard is confusing");
    expect(items[0].type).toBe("suggestion");
    expect(items[0].endpoint).toBe("/build");
  });

  it("preserves canonical agent types and coerces unknown types to bug", async () => {
    await app.inject({ method: "POST", url: "/api/feedback", payload: { type: "friction", summary: "stuck on funding step" } });
    await app.inject({ method: "POST", url: "/api/feedback", payload: { type: "wat", summary: "weird type value here" } });
    const { items } = await adminItems();
    const byType = items.map((i) => i.type).sort();
    expect(byType).toEqual(["bug", "friction"]);
  });

  it("drops honeypot submissions silently and does not store them", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { summary: "i am a spam bot", website: "http://spam.example" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");

    const { total } = await adminItems();
    expect(total).toBe(0);
  });

  it("rejects a submission with neither summary nor message", async () => {
    const res = await app.inject({ method: "POST", url: "/api/feedback", payload: { type: "bug" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("bad_request");
  });

  it("rejects an invalid email", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      payload: { summary: "valid summary text", email: "not-an-email" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rate-limits after PCC_FEEDBACK_RATE_MAX submissions from one IP", async () => {
    for (let i = 0; i < RATE_MAX; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/feedback",
        payload: { summary: `report number ${i}` },
      });
      expect(res.statusCode).toBe(201);
    }
    const over = await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "one too many reports" } });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("rate_limited");
  });

  it("works with no Authorization header at all (PUBLIC)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/feedback", payload: { summary: "no auth header here" } });
    expect(res.statusCode).toBe(201);
  });
});

describe("GET /api/admin/feedback (X-Admin-Token gated)", () => {
  it("403s without the admin token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/feedback" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
  });

  it("403s with the wrong admin token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/feedback",
      headers: { "x-admin-token": "wrong-token" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns stored items with the correct admin token", async () => {
    await app.inject({ method: "POST", url: "/api/feedback", payload: { type: "idea", summary: "add a dark mode toggle" } });
    const { total, items } = await adminItems();
    expect(total).toBe(1);
    expect(items[0].type).toBe("idea");
    expect(items[0].summary).toBe("add a dark mode toggle");
  });
});
