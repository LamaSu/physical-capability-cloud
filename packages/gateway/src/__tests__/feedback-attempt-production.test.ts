/**
 * feedback-attempt-production.test.ts — #458 round 1: attempt reports through
 * the PRODUCTION wiring, not only the bare route plugin. The app is built the way
 * server.ts builds it (trustProxy: true, the 1 MB body limit, the gateway-wide
 * write-audit hook from services/write-audit-hook.ts).
 *
 * Covers: no raw User-Agent, email, bearer token or client IP in the sink, the
 * attempt audit event or the gateway write audit; other routes' write audit is
 * unchanged; rotating X-Forwarded-For sidesteps the per-IP limit but not the
 * global attempt cap; an Authorization header can't forge the stored principal.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { auditService } from "../services/audit-service.js";
import { writeAuditHook } from "../services/write-audit-hook.js";
import { GATEWAY_LOGGER_OPTIONS, canonicalRequestPath, isTelemetrySinkRequest, telemetryLookalikeHook } from "../services/telemetry-privacy.js";
import { Writable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SID = "6f1c2a4e-8b7d-4c3f-9a21-0d5e6b7c8f90";
const UA = `PCC-Agent Bearer ${"A".repeat(20)} alice@example.com`;
const GLOBAL_CAP = 10;

let tmpDir: string;
let file: string;
let mod: typeof import("../routes/feedback.js");

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pcc-attempt-prod-"));
  file = join(tmpDir, "feedback.jsonl");
  process.env.PCC_DB_PATH = join(tmpDir, "pcc.sqlite");
  process.env.PCC_FEEDBACK_RATE_MAX = "5";
  process.env.PCC_ATTEMPT_RATE_MAX = "5";
  process.env.PCC_ATTEMPT_GLOBAL_RATE_MAX = String(GLOBAL_CAP);
  delete process.env.DISCORD_WEBHOOK_URL;
  mod = await import("../routes/feedback.js");
});

let logLines: string[] = [];
const logStream = new Writable({
  write(chunk, _enc, cb) {
    logLines.push(String(chunk));
    cb();
  },
});

async function buildProductionApp(): Promise<FastifyInstance> {
  // The production logger configuration (server.ts), writing to a capture stream.
  const app = Fastify({ logger: { ...GATEWAY_LOGGER_OPTIONS, level: "info", stream: logStream }, bodyLimit: 1_048_576, trustProxy: true });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  app.addHook("onResponse", writeAuditHook);
  app.addHook("onRequest", telemetryLookalikeHook);
  await app.register(mod.feedbackRoutes);
  app.post("/api/other-write", async () => ({ ok: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
  logLines = [];
  rmSync(file, { force: true });
  mod.__resetFeedbackRateLimit();
  mod.__resetFeedbackDedup();
  app = await buildProductionApp();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
});

const attempt = (extra: Record<string, unknown> = {}) => ({ kind: "attempt", sessionId: SID, seq: 1, phase: "register", outcome: "failed", ...extra });
const lines = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
const settle = () => new Promise((r) => setTimeout(r, 30)); // onResponse hooks finish after inject resolves

type Audit = { eventType: string; ip?: string; userAgent?: string; metadata?: Record<string, unknown> };

describe("attempt reports through the production wiring", () => {
  it("keep no raw User-Agent, email, bearer token or client IP in the sink or any audit row", async () => {
    const spy = vi.spyOn(auditService, "log").mockImplementation((() => undefined) as never);
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback",
      headers: { "user-agent": UA, "x-forwarded-for": "203.0.113.9" },
      payload: attempt(),
    });
    expect(res.statusCode).toBe(201);
    await settle();

    const line = lines()[0]!;
    for (const leak of ["alice@example.com", "A".repeat(20), "203.0.113.9"]) expect(line).not.toContain(leak);

    const audits = spy.mock.calls.map((c) => c[0] as Audit);
    const attemptAudit = audits.find((a) => a.eventType === "agent.attempt");
    const writeAudit = audits.find((a) => a.eventType === "http.write" && a.metadata?.url === "/api/feedback");
    expect(attemptAudit).toBeDefined();
    expect(writeAudit).toBeDefined();
    expect(attemptAudit!.ip).toBeUndefined();
    expect(attemptAudit!.userAgent).toBe("PCC-Agent Bearer [redacted] [redacted-email]");
    expect(writeAudit!.ip).toBeUndefined();
    expect(writeAudit!.userAgent).toBeUndefined();
    expect(JSON.stringify(audits)).not.toContain("alice@example.com");
    expect(JSON.stringify(audits)).not.toContain("203.0.113.9");
  });

  it("leave the write audit of other routes unchanged (IP and User-Agent kept)", async () => {
    const spy = vi.spyOn(auditService, "log").mockImplementation((() => undefined) as never);
    await app.inject({ method: "POST", url: "/api/other-write", headers: { "user-agent": "curl/8", "x-forwarded-for": "198.51.100.4" }, payload: {} });
    await settle();
    const writeAudit = spy.mock.calls.map((c) => c[0] as Audit).find((a) => a.eventType === "http.write" && a.metadata?.url === "/api/other-write");
    expect(writeAudit).toMatchObject({ ip: "198.51.100.4", userAgent: "curl/8" });
  });

  it("hold the global attempt cap even when rotating X-Forwarded-For sidesteps the per-IP limit", async () => {
    const codes: number[] = [];
    for (let i = 0; i < GLOBAL_CAP + 5; i++) {
      const res = await app.inject({ method: "POST", url: "/api/feedback", headers: { "x-forwarded-for": `203.0.113.${i + 1}` }, payload: attempt({ seq: i }) });
      codes.push(res.statusCode);
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(GLOBAL_CAP);
    expect(codes.slice(GLOBAL_CAP).every((c) => c === 429)).toBe(true);
    expect(lines()).toHaveLength(GLOBAL_CAP);
    const classic = await app.inject({ method: "POST", url: "/api/feedback", headers: { "x-forwarded-for": "203.0.113.200" }, payload: { type: "bug", summary: "classic still accepted" } });
    expect(classic.statusCode).toBe(201);
  });

  it("store the principal as anonymous whatever Authorization header the caller sends", async () => {
    await app.inject({ method: "POST", url: "/api/feedback", headers: { authorization: "Bearer made-up-token-123" }, payload: attempt() });
    const rec = JSON.parse(lines()[0]!);
    expect(rec.principal).toBe("anonymous");
    expect("principalHash" in rec).toBe(false);
    expect(lines()[0]).not.toContain("made-up-token-123");
  });

  it("record only the route path, never the raw query string, in the sink's write audit (round 2)", async () => {
    const spy = vi.spyOn(auditService, "log").mockImplementation((() => true) as never);
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback?token=abc123456789&email=alice@example.com",
      payload: attempt(),
    });
    expect(res.statusCode).toBe(201);
    await settle();
    const audits = spy.mock.calls.map((c) => c[0] as Audit);
    const writeAudit = audits.find((a) => a.eventType === "http.write" && String(a.metadata?.url).startsWith("/api/feedback"));
    expect(writeAudit?.metadata?.url).toBe("/api/feedback");
    expect(JSON.stringify(audits)).not.toContain("abc123456789");
    expect(JSON.stringify(audits)).not.toContain("alice@example.com");
  });

  it("keep the raw URL in other routes' write audit", async () => {
    const spy = vi.spyOn(auditService, "log").mockImplementation((() => true) as never);
    await app.inject({ method: "POST", url: "/api/other-write?page=2", payload: {} });
    await settle();
    const writeAudit = spy.mock.calls.map((c) => c[0] as Audit).find((a) => a.eventType === "http.write" && String(a.metadata?.url).startsWith("/api/other-write"));
    expect(writeAudit?.metadata?.url).toBe("/api/other-write?page=2");
  });

  it("treat malformed and encoded lookalikes of the sink as the sink (round 3)", async () => {
    const spy = vi.spyOn(auditService, "log").mockImplementation((() => true) as never);
    for (const url of ["/api/feedback//token-abc", "/api/%66eedback/token-def?x=1", "/API/Feedback/token-ghi"]) {
      await app.inject({ method: "POST", url, headers: { "user-agent": UA, "x-forwarded-for": "203.0.113.9" }, payload: attempt() });
    }
    await settle();
    const writes = spy.mock.calls.map((c) => c[0] as Audit).filter((a) => a.eventType === "http.write");
    expect(writes).toHaveLength(3);
    for (const w of writes) {
      expect(w.metadata).toMatchObject({ url: "/api/feedback", route_matched: false });
      expect(w.ip).toBeUndefined();
      expect(w.userAgent).toBeUndefined();
    }
    const everything = JSON.stringify(spy.mock.calls) + logLines.join("");
    for (const leak of ["token-abc", "token-def", "token-ghi", "203.0.113.9", "alice@example.com"]) expect(everything).not.toContain(leak);
  });

  it("keep the sink's raw URL, IP and host out of the production request log, and leave other routes' log lines as they were (round 3)", async () => {
    await app.inject({ method: "POST", url: "/api/feedback?token=abc123456789&email=alice@example.com", headers: { "x-forwarded-for": "203.0.113.9" }, payload: attempt() });
    await app.inject({ method: "POST", url: "/api/other-write?page=2", headers: { "x-forwarded-for": "198.51.100.4" }, payload: {} });
    const all = logLines.join("");
    expect(all).toContain("incoming request");
    for (const leak of ["abc123456789", "alice@example.com", "203.0.113.9"]) expect(all).not.toContain(leak);
    const sinkLine = logLines.map((l) => JSON.parse(l)).find((l) => l.msg === "incoming request" && l.req?.url === "/api/feedback");
    expect(sinkLine?.req).toEqual({ method: "POST", url: "/api/feedback" });
    const otherLine = logLines.map((l) => JSON.parse(l)).find((l) => l.msg === "incoming request" && String(l.req?.url).startsWith("/api/other-write"));
    expect(otherLine?.req).toMatchObject({ method: "POST", url: "/api/other-write?page=2", remoteAddress: "198.51.100.4" });
  });
});

describe("telemetry-privacy path rules", () => {
  it("canonicalises the path: no query or fragment, decoded, lower-cased, single slashes", () => {
    expect(canonicalRequestPath("/API//Feedback/%61bc?x=1#frag")).toBe("/api/feedback/abc");
    expect(canonicalRequestPath("/api/feedback/%E0%A4%A")).toBe("/api/feedback/%e0%a4%a");
  });

  it("treats the sink and anything imitating it as the sink, and nothing else", () => {
    for (const u of ["/api/feedback", "/api/feedback?t=1", "/api/feedback//x", "/api/%66eedback", "/API/FEEDBACK/agent-report"]) {
      expect(isTelemetrySinkRequest(u)).toBe(true);
    }
    for (const u of ["/api/other-write", "/api/feeds", "/feedback", "/api/admin/feedback"]) {
      expect(isTelemetrySinkRequest(u)).toBe(false);
    }
  });
});

