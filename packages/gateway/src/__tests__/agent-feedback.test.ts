/**
 * agent-feedback.test.ts — observability piece 3.
 *
 * Tests cover:
 *   • Happy-path: valid summary returns 201 + report_id + trace_id.
 *   • Validation: missing/short/long summary → 400 with helpful hint+docs.
 *   • trace_id from body wins over trace_id from middleware header.
 *   • trace_id from middleware is used when body omits it.
 *   • Malformed body trace_id → 400.
 *   • detail length cap enforced.
 *   • Optional string fields validated (200-char max).
 *   • Rate limiting kicks in after the configured number of reports.
 *   • PUBLIC: no auth required.
 *   • Audit log entry emitted on success.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { agentFeedbackRoutes, __resetAgentReportRateLimit } from "../routes/agent-feedback.js";
import { traceIdPlugin, TRACE_ID_HEADER } from "../middleware/trace-id.js";

// Mock side-effect deps — we want to test what the route MEANS, not whether
// PostHog/audit-log file IO works.
const auditLogSpy = vi.fn();
const trackEventSpy = vi.fn();

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: (...args: unknown[]) => auditLogSpy(...args),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../services/posthog-service.js", () => ({
  trackServerEvent: (...args: unknown[]) => trackEventSpy(...args),
}));

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(traceIdPlugin);
  await app.register(agentFeedbackRoutes);
  await app.ready();
  return app;
}

describe("POST /api/feedback/agent-report", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    auditLogSpy.mockClear();
    trackEventSpy.mockClear();
    __resetAgentReportRateLimit();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── Happy paths ─────────────────────────────────────────────────────────

  it("accepts a minimal valid report", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: "Build options endpoint returned 500 with no hint" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.report_id).toMatch(/^agr_[0-9a-f]{16}$/);
    // trace_id stamped by middleware even though body didn't supply one
    expect(body.trace_id).toMatch(/^tr_[0-9a-f]{16}$/);
  });

  it("accepts a full report with all optional fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {
        trace_id: "tr_1234567890abcdef",
        summary: "Could not progress past funding step",
        detail: "After successful provision and discover, the funding step kept returning 503 with no retry guidance.",
        last_endpoint: "/api/fiat-ramp/onramp/session",
        last_error_code: "SERVICE_UNAVAILABLE",
        agent_kind: "claude",
        confused_about: "fund",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.trace_id).toBe("tr_1234567890abcdef");
  });

  it("trims whitespace around summary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: "  whitespace padded summary text  " },
    });
    expect(res.statusCode).toBe(201);
  });

  // ── trace_id handling ───────────────────────────────────────────────────

  it("body trace_id wins over header trace_id", async () => {
    const headerTrace = "tr_aaaaaaaaaaaaaaaa";
    const bodyTrace = "tr_bbbbbbbbbbbbbbbb";
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      headers: { [TRACE_ID_HEADER]: headerTrace },
      payload: {
        trace_id: bodyTrace,
        summary: "test conflict resolution",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().trace_id).toBe(bodyTrace);
  });

  it("falls back to header trace_id when body omits it", async () => {
    const headerTrace = "tr_ccccccccccccdddd";
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      headers: { [TRACE_ID_HEADER]: headerTrace },
      payload: { summary: "no body trace_id case" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().trace_id).toBe(headerTrace);
  });

  // ── Validation: summary ─────────────────────────────────────────────────

  it("rejects missing summary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("invalid_body");
    expect(body.message).toContain("summary");
    expect(body.hint).toBeTruthy();
    expect(body.docs).toContain("AGENT_ONBOARDING_OBSERVABILITY");
  });

  it("rejects non-string summary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects too-short summary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: "no" }, // 2 chars, below min 4
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("4 characters");
  });

  it("rejects too-long summary", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: "x".repeat(281) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("280");
  });

  it("rejects null body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: null,
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Validation: trace_id ────────────────────────────────────────────────

  it("rejects malformed trace_id in body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {
        trace_id: "not-a-valid-trace-id",
        summary: "trace_id format check",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("trace_id");
  });

  it("rejects trace_id that is non-string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {
        trace_id: 12345,
        summary: "trace_id type check",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Validation: detail / optional fields ────────────────────────────────

  it("rejects detail over 4000 chars", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {
        summary: "detail length test",
        detail: "x".repeat(4001),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("4000");
  });

  it("rejects last_endpoint over 200 chars", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {
        summary: "string field length test",
        last_endpoint: "/" + "x".repeat(300),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects non-string optional fields", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {
        summary: "test optional field type",
        agent_kind: { evil: "object" },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  // ── Side effects ────────────────────────────────────────────────────────

  it("writes one audit-log entry on success", async () => {
    await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: {
        summary: "audit log entry check",
        agent_kind: "claude",
      },
    });
    expect(auditLogSpy).toHaveBeenCalledTimes(1);
    const call = auditLogSpy.mock.calls[0][0];
    expect(call.eventType).toBe("agent.report");
    expect(call.resourceType).toBe("agent_report");
    expect(call.action).toBe("create");
    expect(call.metadata.summary).toBe("audit log entry check");
    expect(call.metadata.agent_kind).toBe("claude");
  });

  it("emits one posthog event on success", async () => {
    await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: "posthog event check" },
    });
    expect(trackEventSpy).toHaveBeenCalledTimes(1);
    expect(trackEventSpy.mock.calls[0][0]).toBe("agent_report_filed");
  });

  it("does NOT write to the audit log on validation failure", async () => {
    await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: "no" }, // too short
    });
    expect(auditLogSpy).not.toHaveBeenCalled();
  });

  // ── Rate limiting ───────────────────────────────────────────────────────

  it("rate-limits after PCC_AGENT_REPORT_LIMIT reports from the same IP", async () => {
    // Default limit is 30/hour; send 30 successful + 1 over the limit.
    const payload = { summary: "rate limit smoke test" };

    for (let i = 0; i < 30; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/feedback/agent-report",
        payload,
      });
      expect(res.statusCode).toBe(201);
    }

    const over = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload,
    });
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toBe("rate_limited");
    expect(over.json().retry_after_seconds).toBeGreaterThan(0);
  });

  // ── Public access ───────────────────────────────────────────────────────

  it("works without any Authorization header (PUBLIC)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/feedback/agent-report",
      payload: { summary: "no auth header at all" },
    });
    expect(res.statusCode).toBe(201);
  });
});
