/**
 * WP-A fold F7: the X-Admin-Token admin exports compare in CONSTANT TIME.
 *
 * routes/waitlist.ts and routes/feedback.ts gated GET /api/admin/waitlist,
 * /api/admin/beta-apply and /api/admin/feedback on
 * `provided !== process.env.WAITLIST_ADMIN_TOKEN` — a short-circuiting compare
 * whose timing leaks the length of a matching prefix (and the token length).
 * Both now call auth/admin-key.ts adminTokenMatches: same header, same env var,
 * same 403 body, fail-closed on unset/blank — but the comparison runs through
 * crypto.timingSafeEqual over fixed-length digests.
 *
 * The load-bearing assertion is that every decision (match AND mismatch, of
 * equal AND different length) goes through timingSafeEqual; the pre-change
 * `!==` never called it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { timingSafeEqualSpy } = vi.hoisted(() => ({ timingSafeEqualSpy: { fn: undefined as unknown as ReturnType<typeof vi.fn> } }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  timingSafeEqualSpy.fn = vi.fn(actual.timingSafeEqual);
  return { ...actual, default: { ...actual, timingSafeEqual: timingSafeEqualSpy.fn }, timingSafeEqual: timingSafeEqualSpy.fn };
});
vi.mock("../services/posthog-service.js", () => ({ trackServerEvent: vi.fn() }));
vi.mock("../services/audit-service.js", () => ({ auditService: { log: vi.fn() } }));

const TOKEN = "test-admin-token-7f3a9c";
const saved = { db: process.env.PCC_DB_PATH, token: process.env.WAITLIST_ADMIN_TOKEN };
let tmpDir: string;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-admin-token-test-"));
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite"); // DATA_DIR = tmpDir
  delete process.env.DISCORD_WEBHOOK_URL;
  const { waitlistRoutes } = await import("../routes/waitlist.js");
  const { feedbackRoutes } = await import("../routes/feedback.js");
  app = Fastify({ logger: false });
  await app.register(waitlistRoutes);
  await app.register(feedbackRoutes);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
  if (saved.db === undefined) delete process.env.PCC_DB_PATH;
  else process.env.PCC_DB_PATH = saved.db;
  if (saved.token === undefined) delete process.env.WAITLIST_ADMIN_TOKEN;
  else process.env.WAITLIST_ADMIN_TOKEN = saved.token;
});

beforeEach(() => {
  process.env.WAITLIST_ADMIN_TOKEN = TOKEN;
  timingSafeEqualSpy.fn.mockClear();
});

const ADMIN_ROUTES = ["/api/admin/waitlist", "/api/admin/beta-apply", "/api/admin/feedback"];

describe("F7 — X-Admin-Token is compared in constant time", () => {
  it.each(ADMIN_ROUTES)("GET %s with the right token: 200, decided by timingSafeEqual", async (url) => {
    const res = await app.inject({ method: "GET", url, headers: { "x-admin-token": TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(timingSafeEqualSpy.fn).toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)("GET %s with a wrong token of the SAME length: 403, decided by timingSafeEqual", async (url) => {
    const wrong = TOKEN.slice(0, -1) + (TOKEN.endsWith("c") ? "d" : "c");
    const res = await app.inject({ method: "GET", url, headers: { "x-admin-token": wrong } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect(timingSafeEqualSpy.fn).toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)("GET %s with a wrong token of a DIFFERENT length: 403, still via timingSafeEqual (no length short-circuit)", async (url) => {
    const res = await app.inject({ method: "GET", url, headers: { "x-admin-token": "x" } });
    expect(res.statusCode).toBe(403);
    expect(timingSafeEqualSpy.fn).toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)("GET %s without the header: 403", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(403);
  });

  it.each(ADMIN_ROUTES)("GET %s fails CLOSED when WAITLIST_ADMIN_TOKEN is unset or blank", async (url) => {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.WAITLIST_ADMIN_TOKEN;
      else process.env.WAITLIST_ADMIN_TOKEN = value;
      const res = await app.inject({ method: "GET", url, headers: { "x-admin-token": TOKEN } });
      expect(res.statusCode, JSON.stringify(value)).toBe(403);
    }
  });

  it("the refusal body is unchanged and never echoes the token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/feedback", headers: { "x-admin-token": "nope" } });
    expect(res.json()).toEqual({ error: "forbidden", message: "Admin token required (X-Admin-Token)." });
    expect(res.body).not.toContain(TOKEN);
  });
});

describe("adminTokenMatches (auth/admin-key.ts)", () => {
  const req = (headers: Record<string, unknown>) => ({ headers }) as unknown as FastifyRequest;

  it("matches only the exact configured token", async () => {
    const { adminTokenMatches } = await import("../auth/admin-key.js");
    expect(adminTokenMatches(req({ "x-admin-token": TOKEN }))).toBe(true);
    expect(adminTokenMatches(req({ "x-admin-token": TOKEN + " " }))).toBe(false);
    expect(adminTokenMatches(req({ "x-admin-token": TOKEN.toUpperCase() }))).toBe(false);
  });

  it("denies a repeated (array) header, an empty header, and a blank configured token", async () => {
    const { adminTokenMatches } = await import("../auth/admin-key.js");
    expect(adminTokenMatches(req({ "x-admin-token": [TOKEN, TOKEN] }))).toBe(false);
    expect(adminTokenMatches(req({ "x-admin-token": "" }))).toBe(false);
    process.env.WAITLIST_ADMIN_TOKEN = "   ";
    expect(adminTokenMatches(req({ "x-admin-token": "   " }))).toBe(false);
  });

  it("reads the env var it is told to (same semantics for any token env)", async () => {
    const { adminTokenMatches } = await import("../auth/admin-key.js");
    process.env.PCC_TEST_OTHER_ADMIN_TOKEN = "other-token";
    try {
      expect(adminTokenMatches(req({ "x-admin-token": "other-token" }), "PCC_TEST_OTHER_ADMIN_TOKEN")).toBe(true);
      expect(adminTokenMatches(req({ "x-admin-token": TOKEN }), "PCC_TEST_OTHER_ADMIN_TOKEN")).toBe(false);
    } finally {
      delete process.env.PCC_TEST_OTHER_ADMIN_TOKEN;
    }
  });
});
