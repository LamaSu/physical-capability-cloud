/**
 * Onboarding funnel tracker — agent-onboarding observability piece 4.
 *
 * Records each agent's progression through the onboarding funnel
 *
 *     provision → discover → build → fund → submit → settle
 *
 * keyed on the `trace_id` minted by middleware/trace-id.ts (piece 1). A
 * Fastify `onResponse` hook classifies every 2xx response into a funnel
 * stage and records it ONCE per (trace_id, stage) to three sinks:
 *
 *   1. Durable  — auditService.log({ eventType: "agent.funnel" }). This is
 *                 the system-of-record funnel table (queryable via /audit
 *                 today; ETL'd to the private DB in piece 5).
 *   2. Analytics — PostHog. On the `provision` stage we `identifyAgent()`
 *                 to anchor the person profile (PostHog funnel conversion
 *                 needs identified events), then `trackServerEvent()` for
 *                 every stage with distinctId = trace_id so PostHog funnels
 *                 reconstruct the chart natively.
 *   3. Trace    — a `pcc.funnel.<stage>` event on the active OTel span so
 *                 the Tempo/Sentry waterfall shows funnel progress inline.
 *
 * HALT-safe: the whole plugin is a no-op unless `PCC_FUNNEL_ENABLED==="true"`.
 * server.ts gains exactly one register call; the plugin self-disables, so
 * merging this changes nothing until the flag is flipped on a deploy target.
 *
 * Backward-compat: adds an onResponse hook only; never mutates the reply.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from "fastify";
import { trace } from "@opentelemetry/api";
import { auditService } from "./audit-service.js";
import { identifyAgent, trackServerEvent } from "./posthog-service.js";

// ── Stages ───────────────────────────────────────────────────────────────────

export type OnboardingStage =
  | "provision"
  | "discover"
  | "build"
  | "fund"
  | "submit"
  | "settle";

/** Funnel order — used for conversion math and display. */
export const ONBOARDING_STAGES: OnboardingStage[] = [
  "provision",
  "discover",
  "build",
  "fund",
  "submit",
  "settle",
];

/** auditService eventType used for every funnel stage row. */
export const FUNNEL_AUDIT_EVENT = "agent.funnel";

/** Flag gate — funnel tracking is inert unless this is exactly "true". */
export function funnelEnabled(): boolean {
  return process.env.PCC_FUNNEL_ENABLED === "true";
}

// ── Stage detection ───────────────────────────────────────────────────────────

/**
 * Classify a completed request into an onboarding stage, or null if the
 * route is not a funnel checkpoint. Only 2xx responses count — a failed
 * call is not "reaching" the stage.
 *
 * `routePattern` is the matched route template (e.g. "/api/escrow/:id/release"),
 * read from `req.routeOptions.url` so query strings and ids don't matter.
 */
export function detectStage(
  method: string,
  routePattern: string,
  statusCode: number,
): OnboardingStage | null {
  if (statusCode < 200 || statusCode >= 300) return null;
  const m = method.toUpperCase();
  const p = routePattern;

  // provision — either onboarding entry route
  if (m === "POST" && (p === "/api/auth/provision" || p === "/api/onboard/redeem")) {
    return "provision";
  }
  // discover — any capability discovery read
  if (m === "GET" && p.startsWith("/api/capabilities")) {
    return "discover";
  }
  // build — a complete contract was built
  if (m === "POST" && p === "/api/build/contract") {
    return "build";
  }
  // fund — escrow funded OR fiat on-ramp session created
  if (m === "POST" && (p === "/api/escrow/fund" || p.startsWith("/api/fiat-ramp/onramp"))) {
    return "fund";
  }
  // submit — a job was submitted
  if (m === "POST" && p === "/api/jobs/submit") {
    return "submit";
  }
  // settle — a milestone was released
  if (m === "POST" && /^\/api\/escrow\/[^/]+\/release$/.test(p)) {
    return "settle";
  }
  return null;
}

// ── Dedup (bounded, in-memory) ─────────────────────────────────────────────────
//
// A stage is recorded ONCE per trace_id. The durable record is the audit log,
// so a restart only loses in-memory dedup (a stage may double-count once —
// acceptable; the private-DB version dedupes on the (trace_id, stage) PK).

const MAX_TRACKED_JOURNEYS = 5000;
const seen = new Map<string, Set<OnboardingStage>>();
const journeyOrder: string[] = [];

/** Returns true the FIRST time (traceId, stage) is seen; false afterwards. */
function recordOnce(traceId: string, stage: OnboardingStage): boolean {
  let stages = seen.get(traceId);
  if (!stages) {
    if (seen.size >= MAX_TRACKED_JOURNEYS && journeyOrder.length > 0) {
      const oldest = journeyOrder.shift()!;
      seen.delete(oldest);
    }
    stages = new Set<OnboardingStage>();
    seen.set(traceId, stages);
    journeyOrder.push(traceId);
  }
  if (stages.has(stage)) return false;
  stages.add(stage);
  return true;
}

/** Reset dedup state. Test-only. */
export function __resetFunnelState(): void {
  seen.clear();
  journeyOrder.length = 0;
}

// ── Recording ──────────────────────────────────────────────────────────────────

const tracer = trace.getTracer("pcc-gateway-funnel", "1.0.0");

/** Emit one funnel stage to all three sinks. Safe — never throws. */
export function recordStage(
  traceId: string,
  stage: OnboardingStage,
  route: string,
  status: number,
): void {
  const ts = new Date().toISOString();

  // 1. Durable audit row (system of record). resourceId = trace_id, action = stage.
  auditService.log({
    eventType: FUNNEL_AUDIT_EVENT,
    actor: traceId,
    resourceType: "agent_journey",
    resourceId: traceId,
    action: stage,
    metadata: { stage, route, status, ts },
  });

  // 2. PostHog — identify on provision so funnel conversion counts, then capture.
  try {
    if (stage === "provision") {
      identifyAgent(traceId, { first_stage: "provision", first_route: route });
    }
    trackServerEvent(`onboarding_${stage}`, { trace_id: traceId, route, status }, traceId);
  } catch {
    /* analytics must never break request flow */
  }

  // 3. OTel span event on the active span (no new span).
  try {
    trace.getActiveSpan()?.addEvent(`pcc.funnel.${stage}`, {
      "pcc.trace_id": traceId,
      "pcc.funnel.stage": stage,
      "pcc.funnel.route": route,
      "pcc.funnel.status": status,
    });
  } catch {
    /* OTel may be uninitialised in tests */
  }
}

// ── Read API (audit-log backed; private-DB in production — see piece 5) ─────────

export interface FunnelStageRow {
  stage: OnboardingStage;
  route?: string;
  status?: number;
  ts?: string;
}

/** Ordered list of funnel stages a single trace_id reached. */
export function getFunnelForTraceId(traceId: string): FunnelStageRow[] {
  const rows = auditService.query({ eventType: FUNNEL_AUDIT_EVENT, limit: 10000 });
  const out: FunnelStageRow[] = [];
  for (const r of rows) {
    if (r.resourceId !== traceId) continue;
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    out.push({
      stage: (r.action as OnboardingStage) ?? (meta.stage as OnboardingStage),
      route: meta.route as string | undefined,
      status: meta.status as number | undefined,
      ts: meta.ts as string | undefined,
    });
  }
  // Stable order: by funnel position, then ts.
  return out.sort((a, b) => {
    const d = ONBOARDING_STAGES.indexOf(a.stage) - ONBOARDING_STAGES.indexOf(b.stage);
    return d !== 0 ? d : (a.ts ?? "").localeCompare(b.ts ?? "");
  });
}

export interface FunnelCohortRow {
  stage: OnboardingStage;
  count: number;
  /** Conversion from the entry (provision) stage, 0..1. */
  conversion: number;
}

/**
 * Cohort funnel: distinct trace_ids that reached each stage since `since`.
 * Conversion is relative to the `provision` (entry) count.
 */
export function getCohortFunnel(opts: { since?: string } = {}): FunnelCohortRow[] {
  const rows = auditService.query({
    eventType: FUNNEL_AUDIT_EVENT,
    since: opts.since,
    limit: 100000,
  });

  // distinct trace_ids per stage
  const perStage = new Map<OnboardingStage, Set<string>>();
  for (const s of ONBOARDING_STAGES) perStage.set(s, new Set());
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const stage = (r.action as OnboardingStage) ?? (meta.stage as OnboardingStage);
    const traceId = r.resourceId;
    if (!stage || !traceId || !perStage.has(stage)) continue;
    perStage.get(stage)!.add(traceId);
  }

  const entry = perStage.get("provision")!.size;
  return ONBOARDING_STAGES.map((stage) => {
    const count = perStage.get(stage)!.size;
    return { stage, count, conversion: entry > 0 ? count / entry : 0 };
  });
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/**
 * Register the funnel tracker. MUST be registered after traceIdPlugin so
 * `req.traceId` is populated. Non-encapsulated (skip-override) so the
 * onResponse hook fires for every sibling route, mirroring trace-id.ts.
 */
const funnelTrackerPluginImpl: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (!funnelEnabled()) {
    // Inert: register nothing. Flag is read at boot.
    app.log?.info?.("[funnel] disabled (set PCC_FUNNEL_ENABLED=true to enable)");
    return;
  }

  app.addHook("onResponse", async (req: FastifyRequest, reply) => {
    try {
      const traceId = (req as FastifyRequest & { traceId?: string }).traceId;
      if (!traceId) return;
      const routePattern = req.routeOptions?.url ?? req.url;
      if (!routePattern) return;
      const stage = detectStage(req.method, routePattern, reply.statusCode);
      if (!stage) return;
      if (!recordOnce(traceId, stage)) return;
      recordStage(traceId, stage, routePattern, reply.statusCode);
    } catch {
      /* funnel tracking must never affect request handling */
    }
  });
};

(funnelTrackerPluginImpl as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(funnelTrackerPluginImpl as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] = "funnelTrackerPlugin";

export const funnelTrackerPlugin = funnelTrackerPluginImpl;
