/**
 * WP-A fold F7, then round 7 (admingates AG-9): the admin exports compare in
 * CONSTANT TIME, and since round 7 they use the admin SECRET, X-Admin-Key =
 * PCC_ADMIN_KEY (requireAdminSecretStrict), with no development bypass. The
 * separate X-Admin-Token = WAITLIST_ADMIN_TOKEN no longer opens them. The history
 * below is kept: adminTokenMatches still exists and its unit tests stay.
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
const ADMIN_KEY = "test-admin-secret-4e1b8d";
const saved = { db: process.env.PCC_DB_PATH, token: process.env.WAITLIST_ADMIN_TOKEN, key: process.env.PCC_ADMIN_KEY };
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
  if (saved.key === undefined) delete process.env.PCC_ADMIN_KEY;
  else process.env.PCC_ADMIN_KEY = saved.key;
});

beforeEach(() => {
  process.env.WAITLIST_ADMIN_TOKEN = TOKEN;
  process.env.PCC_ADMIN_KEY = ADMIN_KEY;
  timingSafeEqualSpy.fn.mockClear();
});

const ADMIN_ROUTES = ["/api/admin/waitlist", "/api/admin/beta-apply", "/api/admin/feedback"];

describe("AG-9 — the admin exports need X-Admin-Key = PCC_ADMIN_KEY, compared in constant time", () => {
  it.each(ADMIN_ROUTES)("GET %s with the right key: 200, decided by timingSafeEqual", async (url) => {
    const res = await app.inject({ method: "GET", url, headers: { "x-admin-key": ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    expect(timingSafeEqualSpy.fn).toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)("[neg] GET %s with the OLD credential (X-Admin-Token = WAITLIST_ADMIN_TOKEN): refused", async (url) => {
    const res = await app.inject({ method: "GET", url, headers: { "x-admin-token": TOKEN } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("admin_key_required");
  });

  it.each(ADMIN_ROUTES)("[neg] GET %s with a wrong key of the SAME length: 403, decided by timingSafeEqual", async (url) => {
    const wrong = ADMIN_KEY.slice(0, -1) + (ADMIN_KEY.endsWith("d") ? "e" : "d");
    const res = await app.inject({ method: "GET", url, headers: { "x-admin-key": wrong } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_key_invalid");
    expect(timingSafeEqualSpy.fn).toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)("[neg] GET %s with a wrong key of a DIFFERENT length: 403, still via timingSafeEqual", async (url) => {
    const res = await app.inject({ method: "GET", url, headers: { "x-admin-key": "x" } });
    expect(res.statusCode).toBe(403);
    expect(timingSafeEqualSpy.fn).toHaveBeenCalled();
  });

  it.each(ADMIN_ROUTES)("[neg] GET %s without the header: 401", async (url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });

  it.each(ADMIN_ROUTES)("[neg] GET %s fails CLOSED (503) when PCC_ADMIN_KEY is unset or blank, even under NODE_ENV=test", async (url) => {
    expect(process.env.NODE_ENV).toBe("test"); // where checkAdminKey alone would be dev-open
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.PCC_ADMIN_KEY;
      else process.env.PCC_ADMIN_KEY = value;
      const res = await app.inject({ method: "GET", url, headers: { "x-admin-key": ADMIN_KEY } });
      expect(res.statusCode, JSON.stringify(value)).toBe(503);
      expect(res.json().error).toBe("admin_key_not_configured");
    }
  });

  it("the refusal body never echoes the key", async () => {
    const res = await app.inject({ method: "GET", url: "/api/admin/feedback", headers: { "x-admin-key": "nope" } });
    expect(res.body).not.toContain(ADMIN_KEY);
    expect(res.body).not.toContain("nope");
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
