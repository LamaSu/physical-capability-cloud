/**
 * Admin observability read API — agent-onboarding observability piece 5
 * (the in-gateway "troubleshooting view" bridge).
 *
 * Surfaces the funnel / journey / error-rate / feedback-stream reads that the
 * private-DB troubleshooting view (ops/observability/schema.sql) will serve in
 * production. Until that private DB exists, these handlers read from the
 * gateway audit log (auditService) so the view is usable day one.
 *
 *   GET /api/admin/observability/funnel?since=ISO        — cohort funnel
 *   GET /api/admin/observability/journey/:traceId         — one agent's journey
 *   GET /api/admin/observability/errors?since=ISO          — error-class histogram
 *   GET /api/admin/observability/feedback?since=ISO&limit= — pcc_report stream
 *
 * Gating (HALT-safe + least-privilege):
 *   • Inert unless PCC_FUNNEL_ENABLED==="true"  → 404 not_enabled.
 *   • Registered AFTER apiGate, so the caller is authenticated.
 *   • Admin-only: operatorId must be in PCC_OBSERVABILITY_ADMINS (comma-sep).
 *     When that var is unset, access is allowed ONLY in non-production
 *     (NODE_ENV !== "production") to keep local dev frictionless.
 *
 * NOTE: for interactive, span-level trace replay use Sentry's Trace Explorer
 * (already wired) — paste the trace_id. These endpoints give the aggregate /
 * relational views Sentry's person-less model reconstructs awkwardly.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditService } from "../services/audit-service.js";
import {
  funnelEnabled,
  getCohortFunnel,
  getFunnelForTraceId,
  FUNNEL_AUDIT_EVENT,
} from "../services/funnel-tracker.js";

const REPORT_EVENT = "agent.report";
const TRACE_ID_RE = /^tr_[0-9a-f]{16,32}$/;

function isObservabilityAdmin(req: FastifyRequest): boolean {
  const operatorId = (req as unknown as { operatorId?: string | null }).operatorId ?? undefined;
  const allow = (process.env.PCC_OBSERVABILITY_ADMINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length === 0) {
    // No allowlist configured → permit only outside production.
    return process.env.NODE_ENV !== "production";
  }
  return !!operatorId && allow.includes(operatorId);
}

/**
 * Common guard. Returns true if the request may proceed; else sends the error.
 *
 * `requireFunnel` — the FUNNEL + JOURNEY views need per-request journey recording
 * (the PCC_FUNNEL_ENABLED onResponse hook), so they stay gated on it. The FEEDBACK +
 * ERRORS views read the `agent.report` audit event that POST /api/feedback emits
 * regardless of that flag, so they are enabled by DEFAULT (requireFunnel=false) and
 * protected by the admin gate alone — no need to turn on journey recording just to
 * read agent feedback. SECURITY: the admin gate fails closed in production (no
 * PCC_OBSERVABILITY_ADMINS ⇒ 403); ensure NODE_ENV=production in prod so the
 * no-allowlist path denies. Set PCC_OBSERVABILITY_ADMINS to grant specific operators.
 */
function guard(
  req: FastifyRequest,
  reply: import("fastify").FastifyReply,
  requireFunnel = true,
): boolean {
  if (requireFunnel && !funnelEnabled()) {
    reply.status(404).send({
      error: "not_enabled",
      message: "This view needs journey recording. Set PCC_FUNNEL_ENABLED=true.",
    });
    return false;
  }
  if (!isObservabilityAdmin(req)) {
    reply.status(403).send({
      error: "forbidden",
      message: "Observability views require an operator listed in PCC_OBSERVABILITY_ADMINS.",
    });
    return false;
  }
  return true;
}

export async function adminObservabilityRoutes(app: FastifyInstance) {
  // ── Cohort funnel ────────────────────────────────────────────────────────
  app.get<{ Querystring: { since?: string } }>(
    "/api/admin/observability/funnel",
    async (req, reply) => {
      if (!guard(req, reply)) return;
      const funnel = getCohortFunnel({ since: req.query.since });
      return {
        since: req.query.since ?? null,
        funnel,
        generated_at: new Date().toISOString(),
        source: "audit_log",
      };
    },
  );

  // ── One agent's journey by trace_id ──────────────────────────────────────
  app.get<{ Params: { traceId: string } }>(
    "/api/admin/observability/journey/:traceId",
    async (req, reply) => {
      if (!guard(req, reply)) return;
      const traceId = req.params.traceId;
      if (!TRACE_ID_RE.test(traceId)) {
        return reply.status(400).send({
          error: "invalid_trace_id",
          message: "trace_id must match tr_<16-32 hex>.",
        });
      }
      const stages = getFunnelForTraceId(traceId);
      const reports = auditService
        .query({ eventType: REPORT_EVENT, limit: 1000 })
        .filter((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          return meta.trace_id === traceId;
        })
        .map((r) => ({ report_id: r.resourceId, ...(r.metadata ?? {}) }));
      return {
        trace_id: traceId,
        funnel_stages: stages,
        reports,
        note: "Span-level HTTP replay is in Sentry Trace Explorer / Tempo; this is the funnel + feedback slice.",
        generated_at: new Date().toISOString(),
      };
    },
  );

  // ── Error-class histogram ────────────────────────────────────────────────
  app.get<{ Querystring: { since?: string } }>(
    "/api/admin/observability/errors",
    async (req, reply) => {
      if (!guard(req, reply, false)) return; // reads agent.report → no funnel flag needed
      // Histogram of last_error_code surfaced in agent reports (what actually
      // tripped agents up). Complement with auditService.stats() (24h event mix).
      const reports = auditService.query({
        eventType: REPORT_EVENT,
        since: req.query.since,
        limit: 100000,
      });
      const histogram: Record<string, number> = {};
      for (const r of reports) {
        const meta = (r.metadata ?? {}) as Record<string, unknown>;
        const code = (meta.last_error_code as string) ?? "(none)";
        histogram[code] = (histogram[code] ?? 0) + 1;
      }
      const by_error_code = Object.entries(histogram)
        .map(([error_code, count]) => ({ error_code, count }))
        .sort((a, b) => b.count - a.count);
      return {
        since: req.query.since ?? null,
        by_error_code,
        event_mix_24h: auditService.stats(),
        generated_at: new Date().toISOString(),
      };
    },
  );

  // ── Feedback (pcc_report) stream ─────────────────────────────────────────
  app.get<{ Querystring: { since?: string; limit?: string } }>(
    "/api/admin/observability/feedback",
    async (req, reply) => {
      if (!guard(req, reply, false)) return; // reads agent.report → no funnel flag needed
      const limit = Math.min(Number.parseInt(req.query.limit ?? "100", 10) || 100, 1000);
      const rows = auditService
        .query({ eventType: REPORT_EVENT, since: req.query.since, limit })
        .map((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          return {
            report_id: r.resourceId,
            actor: r.actor,
            trace_id: meta.trace_id,
            summary: meta.summary,
            agent_kind: meta.agent_kind,
            last_endpoint: meta.last_endpoint,
            last_error_code: meta.last_error_code,
            confused_about: meta.confused_about,
          };
        });
      return {
        since: req.query.since ?? null,
        count: rows.length,
        reports: rows,
        note: "Time-ordering + full detail come from the private-DB sink (piece 5); audit-log mapping omits row timestamp.",
        generated_at: new Date().toISOString(),
      };
    },
  );
}
