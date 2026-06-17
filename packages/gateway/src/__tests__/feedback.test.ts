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
