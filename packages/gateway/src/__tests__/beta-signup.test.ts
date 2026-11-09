import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditService } from "../services/audit-service.js";
import { writeAuditHook } from "../services/write-audit-hook.js";
import { GATEWAY_LOGGER_OPTIONS } from "../services/telemetry-privacy.js";
import { isPublicRoute } from "../middleware/api-gate.js";

const ADMIN_TOKEN = "beta-admin-token";
const D = { name: "Ann Example", email: "ann@example.com", role: "buyer" };
const KEYS = ["id", "kind", "email", "name", "role", "status", "createdAt"];
const OK = '{"status":"ok"}';
const BAD = '{"error":"bad_request"}';
const LIMITED = '{"error":"rate_limited"}';
const UNAVAILABLE = '{"error":"unavailable"}';
let tmpDir: string;
let betaFile: string;
let waitlistRoutes: typeof import("../routes/waitlist.js").waitlistRoutes;
let resetLimits: typeof import("../routes/waitlist.js").__resetBetaSignupLimits;
let app: FastifyInstance;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "beta-signup"));
  betaFile = join(tmpDir, "beta-applications.jsonl");
  vi.stubEnv("PCC_DB_PATH", join(tmpDir, "pcc.sqlite"));
  const mod = await import("../routes/waitlist.js");
  waitlistRoutes = mod.waitlistRoutes;
  resetLimits = mod.__resetBetaSignupLimits;
});

beforeEach(async () => {
  rmSync(betaFile, { recursive: true, force: true });
  resetLimits?.();
  vi.stubEnv("WAITLIST_ADMIN_TOKEN", ADMIN_TOKEN);
  app = Fastify({ logger: false });
  await app.register(waitlistRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function signup(payload: unknown = D, remoteAddress = "192.0.2.10", headers: Record<string, string> = {}) {
  return app.inject({ method: "POST", url: "/api/beta-apply", payload: JSON.stringify(payload),
    headers: { "content-type": "application/json", ...headers }, remoteAddress });
}

function remove(email: string, token: string | undefined = ADMIN_TOKEN) {
  return app.inject({ method: "POST", url: "/api/admin/beta-apply/remove", payload: { email },
    headers: !token ? {} : { "x-admin-token": token }, remoteAddress: "192.0.2.10" });
}

function adminRead(token: string | undefined = ADMIN_TOKEN) {
  return app.inject({ method: "GET", url: "/api/admin/beta-apply",
    headers: !token ? {} : { "x-admin-token": token }, remoteAddress: "192.0.2.10" });
}

function lines(): string[] {
  return readFileSync(betaFile, "utf8").trimEnd().split("\n");
}

describe("the beta signup", () => {
  it("a filled hp gets the success reply and stores nothing", async () => {
    const response = await signup({ ...D, hp: "x" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(OK);
    expect(existsSync(betaFile)).toBe(false);
    const invalid = await signup({ ...D, role: "admin", hp: "x" });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.body).toBe(OK);
    expect(existsSync(betaFile)).toBe(false);
  });

  it("a signup with no key or cookie stores one row of exactly the seven keys, and a repeat gets the same reply", async () => {
    const response = await signup({ name: " Ann Example ", email: " Ann@Example.COM ", role: "builder", company: "Acme", details: { a: 1 } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(OK);
    expect(lines()).toHaveLength(1);
    const row = JSON.parse(lines()[0]);
    expect(Object.keys(row)).toEqual(KEYS);
    expect(row).toEqual({ id: expect.stringMatching(/^beta-/), kind: "beta-application", email: "ann@example.com",
      name: "Ann Example", role: "builder", status: "new", createdAt: expect.any(String) });
    expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false);
    expect(readFileSync(betaFile, "utf8")).not.toContain("192.0.2.10");
    const repeat = await signup({ ...D, role: "operator" });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.body).toBe(response.body);
    expect(lines()).toHaveLength(2);
  });

  it("an 11th signup from one address, or a 31st overall, within a minute gets 429", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    for (let i = 0; i < 10; i++) expect((await signup()).statusCode).toBe(200);
    const eleventh = await signup();
    expect(eleventh.statusCode).toBe(429);
    expect(eleventh.body).toBe(LIMITED);
    for (let i = 1; i <= 20; i++) expect((await signup(D, `198.51.100.${i}`)).statusCode).toBe(200);
    expect(lines()).toHaveLength(30);
    const overall = await signup(D, "203.0.113.1");
    expect(overall.statusCode).toBe(429);
    expect(overall.body).toBe(LIMITED);
    expect(lines()).toHaveLength(30);
  });

  it("a filled hp never counts toward the limits", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    for (let i = 0; i < 31; i++) {
      const response = await signup({ ...D, hp: "x" });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(OK);
      expect(existsSync(betaFile)).toBe(false);
    }
    expect((await signup()).statusCode).toBe(200);
    expect(lines()).toHaveLength(1);
  });

  it("a body over 4 KB is refused and stores nothing", async () => {
    expect((await signup({ ...D, pad: "x".repeat(5000) })).statusCode).toBe(413);
    expect(existsSync(betaFile)).toBe(false);
  });

  it("a full file or a failed write gets 503 and appends nothing", async () => {
    const full = " ".repeat(10 * 1024 * 1024);
    writeFileSync(betaFile, full);
    const response = await signup();
    expect(response.statusCode).toBe(503);
    expect(response.body).toBe(UNAVAILABLE);
    expect(readFileSync(betaFile, "utf8")).toBe(full);
    rmSync(betaFile);
    mkdirSync(betaFile);
    const failed = await signup();
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toBe(UNAVAILABLE);
    expect(readdirSync(betaFile)).toEqual([]);
  });

  it.each([
    ["text/plain", D, "text/plain"],
    ["[]", [], "application/json"],
    ["email 123", { ...D, email: 123 }, "application/json"],
    ["a 255-char email", { ...D, email: "a".repeat(243) + "@example.com" }, "application/json"],
    ["no name", { email: D.email, role: D.role }, "application/json"],
    ['name "   "', { ...D, name: "   " }, "application/json"],
    ["a 101-char name", { ...D, name: "x".repeat(101) }, "application/json"],
    ["names with U+0000", { ...D, name: `Ann${String.fromCharCode(0)}` }, "application/json"],
    ["names with U+202E", { ...D, name: `Ann${String.fromCharCode(0x202e)}` }, "application/json"],
    ["an email with <", { ...D, email: "<ann@example.com" }, "application/json"],
    ["an email with U+0000", { ...D, email: `ann${String.fromCharCode(0)}@example.com` }, "application/json"],
    ["an email with U+202E", { ...D, email: `ann${String.fromCharCode(0x202e)}@example.com` }, "application/json"],
    ["a name with U+2066", { ...D, name: `Ann${String.fromCharCode(0x2066)}` }, "application/json"],
    ["a name with U+0085", { ...D, name: `Ann${String.fromCharCode(0x85)}` }, "application/json"],
    ["a name with U+200F", { ...D, name: `Ann${String.fromCharCode(0x200f)}` }, "application/json"],
    ['role "admin"', { ...D, role: "admin" }, "application/json"],
    ['role ["buyer"]', { ...D, role: ["buyer"] }, "application/json"],
    ["no role", { name: D.name, email: D.email }, "application/json"],
  ])("%s gets 400 and stores nothing", async (_label, payload, contentType) => {
    const response = await signup(payload, "192.0.2.10", { "content-type": contentType as string });
    expect(response.statusCode).toBe(400);
    expect(response.body).toBe(BAD);
    expect(existsSync(betaFile)).toBe(false);
  });

  it("the admin read gives one row per email with the latest values and only the seven keys, as text", async () => {
    writeFileSync(betaFile, '{"email":"ann@example.com","name":"Ann","company":"Acme","details":{"pitch":"x"},"ip":"203.0.113.9"}\n');
    const name = "<img src=x onerror=alert(1)>";
    expect((await signup({ ...D, name, role: "builder" })).statusCode).toBe(200);
    expect((await signup({ ...D, name: "Bob", email: "bob@example.com" })).statusCode).toBe(200);
    const response = await adminRead();
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json; charset=utf-8");
    const body = response.json();
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    const ann = body.items.find((row: Record<string, unknown>) => row.email === D.email);
    expect(ann.name).toBe(name);
    expect(ann.role).toBe("builder");
    for (const row of body.items) expect(Object.keys(row).sort()).toEqual([...KEYS].sort());
    for (const key of ["ip", "company", "details"]) expect(body.items.some((row: Record<string, unknown>) => key in row)).toBe(false);
    expect(response.body).not.toContain("203.0.113.9");
  });

  it("the admin read and remove refuse a missing or wrong token, and every token once WAITLIST_ADMIN_TOKEN is unset", async () => {
    const seeded = JSON.stringify(D) + "\n";
    writeFileSync(betaFile, seeded);
    const forbidden = { error: "forbidden", message: "Admin token required (X-Admin-Token)." };
    for (const token of ["", "x"]) {
      for (const response of [await adminRead(token), await remove(D.email, token)]) {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(forbidden);
      }
      expect(readFileSync(betaFile, "utf8")).toBe(seeded);
    }
    delete process.env.WAITLIST_ADMIN_TOKEN;
    for (const token of ["", "x", ADMIN_TOKEN]) {
      for (const response of [await adminRead(token), await remove(D.email, token)]) {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual(forbidden);
      }
      expect(readFileSync(betaFile, "utf8")).toBe(seeded);
    }
  });

  it("remove deletes every row for the email and leaves the other lines byte-identical", async () => {
    writeFileSync(betaFile, '{"email":"ann@example.com","name":"Ann","company":"Acme"}\n');
    expect((await signup()).statusCode).toBe(200);
    expect((await signup({ name: "Bob", email: "bob@example.com", role: "operator" })).statusCode).toBe(200);
    const original = readFileSync(betaFile, "utf8");
    const bob = lines().find(line => JSON.parse(line).email === "bob@example.com")! + "\n";
    const unknown = await remove("unknown@example.com");
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toBe(OK);
    expect(readFileSync(betaFile, "utf8")).toBe(original);
    const removed = await remove(" ANN@example.com ");
    expect(removed.statusCode).toBe(200);
    expect(removed.body).toBe(OK);
    expect(readFileSync(betaFile, "utf8")).toBe(bob);
  });

  it("only the signup is public, and the count stays numeric", async () => {
    expect(isPublicRoute("/api/beta-apply", "POST")).toBe(true);
    expect(isPublicRoute("/api/admin/beta-apply", "GET")).toBe(false);
    expect(isPublicRoute("/api/admin/beta-apply/remove", "POST")).toBe(false);
    const response = await app.inject({ method: "GET", url: "/api/waitlist/count", remoteAddress: "192.0.2.10" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ count: expect.any(Number), beta: expect.any(Number) });
  });

  it("a beta request writes no request-log line, while another route's line keeps its address", async () => {
    await app.close();
    const logged: string[] = [];
    const stream = { write: (line: string) => { logged.push(line); } };
    app = Fastify({ logger: { ...GATEWAY_LOGGER_OPTIONS, stream } });
    await app.register(waitlistRoutes);
    await app.ready();
    const headers = { "user-agent": "beta-ua-marker", "x-admin-token": ADMIN_TOKEN };
    for (const [method, url, payload] of [
      ["POST", "/api/beta-apply", D],
      ["POST", "/api/admin/beta-apply/remove", { email: D.email }],
      ["GET", "/api/admin/beta-apply", undefined],
    ] as const) {
      expect((await app.inject({ method, url, payload, headers, remoteAddress: "198.51.100.77" })).statusCode).toBe(200);
      expect(logged).toEqual([]);
    }
    expect(logged).toEqual([]);
    await app.inject({ method: "GET", url: "/api/waitlist/count", headers, remoteAddress: "198.51.100.77" });
    expect(logged.length).toBeGreaterThan(0);
    const output = logged.join("");
    expect(output).not.toContain(D.email);
    expect(output).not.toContain("beta-ua-marker");
    const addressed = logged.filter(line => line.includes("198.51.100.77"));
    expect(addressed.length).toBeGreaterThan(0);
    for (const line of addressed) expect(JSON.parse(line).req.url).toBe("/api/waitlist/count");
    for (const line of logged) {
      const entry = JSON.parse(line);
      if (entry.req) expect(entry.req.url).toBe("/api/waitlist/count");
    }
  });

  it("the write audit keeps no IP or user agent for a beta POST, while the waitlist signup keeps both", async () => {
    await app.close();
    const audit = vi.spyOn(auditService, "log").mockReturnValue(true);
    app = Fastify({ logger: false });
    app.addHook("onResponse", writeAuditHook);
    await app.register(waitlistRoutes);
    await app.ready();
    const headers = { "user-agent": "beta-ua-marker", "x-admin-token": ADMIN_TOKEN };
    for (const [url, payload] of [
      ["/api/beta-apply", D],
      ["/api/admin/beta-apply/remove", { email: D.email }],
      ["/api/waitlist", { email: D.email }],
    ] as const) {
      expect((await app.inject({ method: "POST", url, payload, headers, remoteAddress: "198.51.100.77" })).statusCode).toBe(200);
      if (url !== "/api/waitlist") {
        const entry = audit.mock.calls[audit.mock.calls.length - 1][0];
        expect(entry.ip).toBeUndefined();
        expect(entry.userAgent).toBeUndefined();
      }
    }
    expect(audit).toHaveBeenCalledTimes(3);
    const entries = audit.mock.calls.map(([entry]) => entry);
    for (const entry of entries.slice(0, 2)) {
      expect(entry.ip).toBeUndefined();
      expect(entry.userAgent).toBeUndefined();
      expect(JSON.stringify(entry)).not.toContain(D.email);
      expect(JSON.stringify(entry)).not.toContain("198.51.100.77");
      expect(JSON.stringify(entry)).not.toContain("beta-ua-marker");
    }
    expect(entries[0].metadata).toMatchObject({ method: "POST", url: "/api/beta-apply", statusCode: 200 });
    expect(entries[1].metadata).toMatchObject({ method: "POST", url: "/api/admin/beta-apply/remove", statusCode: 200 });
    expect(entries[2]).toMatchObject({ ip: "198.51.100.77", userAgent: "beta-ua-marker" });
  });
});
