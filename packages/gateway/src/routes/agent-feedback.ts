/**
 * Agent friction reports — agent-onboarding observability piece 3.
 *
 * POST /api/feedback/agent-report
 *
 * The `pcc_report` tool entry in agent-package.json points here. When an
 * agent (LLM-driven) hits an error it cannot recover from, gets confused
 * by a route, or thinks a tool description is misleading, it calls this
 * route with a brief summary + (ideally) its `trace_id`.
 *
 * PUBLIC route. Stuck agents may not have provisioned a key yet.
 * Rate-limited by IP (default 30/hour, configurable) to limit spam.
 *
 * Storage in this PR: existing `auditService.log()` with
 * `eventType: "agent.report"`. A dedicated `agent_reports` table on the
 * private DB lands in a follow-on PR (piece 5).
 *
 * Telemetry: emits an OTel event `pcc.feedback.agent_report` so the
 * future private-DB sink can subscribe.
 */

import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { auditService } from "../services/audit-service.js";
import { trackServerEvent } from "../services/posthog-service.js";

// ── Rate limiting (per-IP, in-memory) ─────────────────────────────────────
//
// Mirrors the `canProvision` pattern in middleware/security-hardening.ts but
// uses its own counter so the public feedback surface does not share budget
// with the public provision surface.

const REPORT_LIMIT = Number.parseInt(process.env.PCC_AGENT_REPORT_LIMIT ?? "30", 10);
const REPORT_WINDOW_MS = Number.parseInt(process.env.PCC_AGENT_REPORT_WINDOW_MS ?? "3600000", 10);

const reportCounts = new Map<string, { count: number; resetAt: number }>();

function canReport(ip: string): boolean {
  const now = Date.now();
  const entry = reportCounts.get(ip);
  if (!entry || entry.resetAt < now) {
    reportCounts.set(ip, { count: 1, resetAt: now + REPORT_WINDOW_MS });
    return true;
  }
  if (entry.count >= REPORT_LIMIT) return false;
  entry.count++;
  return true;
}

/** Reset the in-memory rate-limit counter. Test-only export. */
export function __resetAgentReportRateLimit(): void {
  reportCounts.clear();
}

// ── Request body shape ────────────────────────────────────────────────────

export interface AgentReportBody {
  /** Trace correlation ID the agent received from /api/auth/provision or echoed from x-pcc-trace-id */
  trace_id?: string;
  /** 1-line summary (REQUIRED). 4..280 chars after trim. */
  summary: string;
  /** Multi-line context (OPTIONAL, ≤4000 chars after trim). */
  detail?: string;
  /** Which route the agent was on when it got stuck. */
  last_endpoint?: string;
  /** Last error code surfaced by a Result<T>.error.code. */
  last_error_code?: string;
  /** "claude" | "gpt-4o" | "gemini" | "canary" | etc. */
  agent_kind?: string;
  /** Free-form category — "auth", "discovery", "build", "fund", "submit", etc. */
  confused_about?: string;
}

// ── Validation ────────────────────────────────────────────────────────────

const TRACE_ID_RE = /^tr_[0-9a-f]{16,32}$/;
const SUMMARY_MIN = 4;
const SUMMARY_MAX = 280;
const DETAIL_MAX = 4000;
const STRING_FIELD_MAX = 200;

function validate(body: unknown): { ok: true; data: AgentReportBody } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "Request body must be a JSON object." };
  }
  const b = body as Record<string, unknown>;

  // summary — REQUIRED
  if (typeof b.summary !== "string") {
    return { ok: false, error: "`summary` is required (string)." };
  }
  const summary = b.summary.trim();
  if (summary.length < SUMMARY_MIN) {
    return { ok: false, error: `\`summary\` must be at least ${SUMMARY_MIN} characters.` };
  }
  if (summary.length > SUMMARY_MAX) {
    return { ok: false, error: `\`summary\` must be at most ${SUMMARY_MAX} characters.` };
  }

  const result: AgentReportBody = { summary };

  if (b.trace_id !== undefined) {
    if (typeof b.trace_id !== "string") {
      return { ok: false, error: "`trace_id` must be a string." };
    }
    if (!TRACE_ID_RE.test(b.trace_id)) {
      return { ok: false, error: "`trace_id` must match `tr_<16-32 hex>`." };
    }
    result.trace_id = b.trace_id;
  }

  if (b.detail !== undefined) {
    if (typeof b.detail !== "string") {
      return { ok: false, error: "`detail` must be a string." };
    }
    const detail = b.detail.trim();
    if (detail.length > DETAIL_MAX) {
      return { ok: false, error: `\`detail\` must be at most ${DETAIL_MAX} characters.` };
    }
    if (detail.length > 0) result.detail = detail;
  }

  for (const field of ["last_endpoint", "last_error_code", "agent_kind", "confused_about"] as const) {
    if (b[field] !== undefined) {
      if (typeof b[field] !== "string") {
        return { ok: false, error: `\`${field}\` must be a string.` };
      }
      const v = (b[field] as string).trim();
      if (v.length > STRING_FIELD_MAX) {
        return {
          ok: false,
          error: `\`${field}\` must be at most ${STRING_FIELD_MAX} characters.`,
        };
      }
      if (v.length > 0) result[field] = v;
    }
  }

  return { ok: true, data: result };
}

// ── Route plugin ──────────────────────────────────────────────────────────

const tracer = trace.getTracer("pcc-gateway-agent-feedback", "1.0.0");

export async function agentFeedbackRoutes(app: FastifyInstance) {
  app.post("/api/feedback/agent-report", async (req, reply) => {
    // Rate-limit by IP — protect from a stuck agent in a loop.
    if (!canReport(req.ip)) {
      return reply.status(429).send({
        error: "rate_limited",
        message: `Too many agent reports from this IP. Limit ${REPORT_LIMIT}/hour.`,
        retry_after_seconds: Math.ceil(REPORT_WINDOW_MS / 1000),
      });
    }

    const v = validate(req.body);
    if (!v.ok) {
      return reply.status(400).send({
        error: "invalid_body",
        message: v.error,
        hint: "Provide at minimum `{summary: \"...\"}`. trace_id, detail, last_endpoint, last_error_code, agent_kind, and confused_about are optional.",
        docs: "/docs/AGENT_ONBOARDING_OBSERVABILITY.md#3-pcc_report-feedback-tool",
      });
    }

    const body = v.data;
    const report_id = `agr_${randomBytes(8).toString("hex")}`;

    // Prefer the trace_id surfaced by the trace-id middleware on the
    // request. The body's trace_id takes precedence when present (the
    // agent may know its own journey better than the request itself).
    const reqTraceId = (req as unknown as { traceId?: string }).traceId;
    const trace_id = body.trace_id ?? reqTraceId;

    return tracer.startActiveSpan(
      "pcc.feedback.agent_report",
      async (span) => {
        try {
          span.setAttribute("pcc.report_id", report_id);
          if (trace_id) span.setAttribute("pcc.trace_id", trace_id);
          if (body.agent_kind) span.setAttribute("pcc.agent_kind", body.agent_kind);
          if (body.last_endpoint) span.setAttribute("pcc.last_endpoint", body.last_endpoint);
          if (body.last_error_code) span.setAttribute("pcc.last_error_code", body.last_error_code);
          if (body.confused_about) span.setAttribute("pcc.confused_about", body.confused_about);

          // Persist to the audit log (temporary sink until piece 5 lands).
          auditService.log({
            eventType: "agent.report",
            actor: (req as unknown as { operatorId?: string; apiKeyId?: string }).operatorId
              ?? (req as unknown as { apiKeyId?: string }).apiKeyId
              ?? `anonymous:${req.ip}`,
            resourceType: "agent_report",
            resourceId: report_id,
            action: "create",
            metadata: {
              trace_id,
              summary: body.summary,
              detail: body.detail,
              last_endpoint: body.last_endpoint,
              last_error_code: body.last_error_code,
              agent_kind: body.agent_kind,
              confused_about: body.confused_about,
            },
            ip: req.ip,
            userAgent: req.headers["user-agent"],
          });

          // PostHog event for the live dashboard.
          trackServerEvent("agent_report_filed", {
            report_id,
            trace_id,
            agent_kind: body.agent_kind,
            last_error_code: body.last_error_code,
            confused_about: body.confused_about,
          });

          // Add a span event so any OTel collector subscribed to the
          // pcc.feedback.* namespace can stream it into the centralized
          // sink (piece 5).
          span.addEvent("agent_report_received", {
            "pcc.report_id": report_id,
            "pcc.trace_id": trace_id ?? "",
            "pcc.summary_length": body.summary.length,
          });

          return reply.status(201).send({
            ok: true,
            report_id,
            trace_id,
            message:
              "Thanks — your friction report has been recorded. Quote `trace_id` and `report_id` if you need to follow up.",
          });
        } finally {
          span.end();
        }
      },
    );
  });
}
