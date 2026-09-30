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

async function buildProductionApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576, trustProxy: true });
  app.decorateRequest("userId", null);
  app.decorateRequest("apiKeyId", null);
  app.decorateRequest("operatorId", null);
  app.addHook("onResponse", writeAuditHook);
  await app.register(mod.feedbackRoutes);
  app.post("/api/other-write", async () => ({ ok: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance;

beforeEach(async () => {
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
});
