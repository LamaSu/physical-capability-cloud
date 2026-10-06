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
import { addClosedEvent } from "../observability/closed-otel.js";
import { auditService, isStoredId, storedIdKey } from "./audit-service.js";
import { identifyAgent, trackServerEvent } from "./posthog-service.js";
import { declare, declaredRoute, isDeclared, lit, routeTemplates, type Declared } from "../observability/closed-schema.js";

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

const asStage = (value: unknown): OnboardingStage | undefined =>
  typeof value === "string" && (ONBOARDING_STAGES as string[]).includes(value) ? (value as OnboardingStage) : undefined;

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

/**
 * Emit one funnel stage to all three sinks. Safe — never throws. Every field is declared (the closed
 * observability schema, N107b round 2): the stage a code of ONBOARDING_STAGES, the route the matched
 * template, the status and time the server's own, the trace id an identifier (stored hashed).
 */
export function recordStage(
  traceId: string,
  stage: OnboardingStage,
  route: string | Declared,
  status: number,
): void {
  const at = new Date();
  const routeField = isDeclared(route) ? route : declare.code(route, routeTemplates());
  const stageField = declare.code(stage, ONBOARDING_STAGES);

  // 1. Durable audit row (system of record). resourceId = trace_id, action = stage.
  auditService.log({
    eventType: lit(FUNNEL_AUDIT_EVENT),
    actor: traceId,
    resourceType: lit("agent_journey"),
    resourceId: traceId,
    action: stageField,
    metadata: { stage: stageField, route: routeField, status: declare.metric(status), ts: declare.serverTime(at) },
  });

  // 2. PostHog — identify on provision so funnel conversion counts, then capture.
  try {
    if (stage === "provision") {
      identifyAgent(traceId, { first_stage: lit("provision"), first_route: routeField });
    }
    trackServerEvent(lit(`onboarding_${stage}`), { trace_id: declare.id(traceId), route: routeField, status: declare.metric(status) }, traceId);
  } catch {
    /* analytics must never break request flow */
  }

  // 3. OTel span event on the active span (no new span).
  try {
    trace.getActiveSpan()?.addEvent(`pcc.funnel.${stage}`, {
      "pcc.trace_id": traceId,
      "pcc.funnel.stage": stage,
      "pcc.funnel.route": String(routeField),
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
  // The closed audit log keeps the trace id as its keyed hash (N107b); a row written before it
  // keeps the id itself (round 2, MEDIUM 4). Either is this trace's.
  for (const r of rows) {
    if (!isStoredId(r.resourceId, traceId)) continue;
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const stage = asStage(r.action) ?? asStage(meta.stage);
    if (!stage) continue;
    out.push({
      stage,
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
    const stage = asStage(r.action) ?? asStage(meta.stage);
    // One key per trace, whichever schema wrote its rows (round 2, MEDIUM 4).
    const traceKey = storedIdKey(r.resourceId);
    if (!stage || !traceKey) continue;
    perStage.get(stage)!.add(traceKey);
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
    app.log?.info?.(lit("[funnel] disabled (set PCC_FUNNEL_ENABLED=true to enable)"));
    return;
  }

  app.addHook("onResponse", async (req: FastifyRequest, reply) => {
    try {
      const traceId = (req as FastifyRequest & { traceId?: string }).traceId;
      if (!traceId) return;
      // The matched route's pattern, never the caller's path (an unmatched request is no stage).
      const routePattern = req.routeOptions?.url;
      if (!routePattern) return;
      const stage = detectStage(req.method, routePattern, reply.statusCode);
      if (!stage) return;
      if (!recordOnce(traceId, stage)) return;
      recordStage(traceId, stage, declaredRoute(req), reply.statusCode);
    } catch {
      /* funnel tracking must never affect request handling */
    }
  });
};

(funnelTrackerPluginImpl as unknown as Record<symbol, unknown>)[Symbol.for("skip-override")] = true;
(funnelTrackerPluginImpl as unknown as Record<symbol, unknown>)[Symbol.for("fastify.display-name")] = "funnelTrackerPlugin";

export const funnelTrackerPlugin = funnelTrackerPluginImpl;

// ── Operator-onboarding funnel (ADK track item 4) ───────────────────────────
//
// A second funnel, parallel to the BUYER (agent-onboarding) funnel above and
// sharing its flag + sink style, but for OPERATORS bringing physical
// capability online:
//
//     kernel_created → device_registered → adapter_ready →
//     capability_published → test_job_passed → verified_run
//
// Unlike the buyer funnel, this one is NOT detected via a generic onResponse
// hook + route/status classifier. Per the stage inventory
// (pcc-painpoints-work/item4-stage-inventory.md), most of these checkpoints
// can't be classified from method+route+statusCode alone:
//   - device_registered / capability_published are 2xx-detectable, but
//   - adapter_ready isn't a route at all (it lives inside a health-check
//     facade method, gated on a body field plus a side lookup), and
//   - test_job_passed returns HTTP 200 in BOTH the honest and the
//     self-attested (fabricated) paths — status code alone would silently
//     count the self-attest trap. Recording has to happen from explicit call
//     sites, each gated on the real success condition for that stage.
//
// Keyed on `kernelId`, not `trace_id`: operator-onboarding steps are
// separate CLI/daemon calls spread over minutes-to-days (register kernel,
// register a device later, publish a capability later still), so nothing
// guarantees a shared trace_id recurs across them. `kernelId` is present
// and verifiable at every stage (see the inventory's "Identifier
// recommendation" section).

export type OperatorStage =
  | "kernel_created"
  | "device_registered"
  | "adapter_ready"
  | "capability_published"
  | "test_job_passed"
  | "verified_run";

/** Funnel order — used for conversion math and display. */
export const OPERATOR_STAGES: OperatorStage[] = [
  "kernel_created",
  "device_registered",
  "adapter_ready",
  "capability_published",
  "test_job_passed",
  "verified_run",
];

/** The operator-funnel span event names, one per stage (a closed vocabulary for the exporter). */
const OPERATOR_FUNNEL_EVENT_NAMES: readonly string[] = OPERATOR_STAGES.map((stage) => `pcc.operator_funnel.${stage}`);

/** auditService eventType used for every operator-funnel stage row. */
export const OPERATOR_FUNNEL_AUDIT_EVENT = "operator.funnel";

/** Kernel ids are opaque but bounded — mirrors ids minted across kernel.facade.ts. */
const OPERATOR_KERNEL_ID_RE = /^[A-Za-z0-9:._-]{1,200}$/;

/**
 * The setup-wizard's hardcoded fallback kernel id (routes/setup.ts:714,
 * `kernelId ?? "kernel_dev_001"`). An operator who omits kernelId on a call
 * silently lands on this shared placeholder — recording it would attribute
 * one operator's progress to every operator who forgot the field, so it is
 * always rejected as "unattributable" rather than tracked.
 */
const DEV_PLACEHOLDER_KERNEL_ID = "kernel_dev_001";

// ── Dedup (bounded, in-memory) — same shape as the buyer funnel's `seen` ────

const MAX_TRACKED_KERNELS = 5000;
const operatorSeen = new Map<string, Set<OperatorStage>>();
const operatorKernelOrder: string[] = [];

/** Whether this process already recorded (kernelId, stage). */
function operatorSeenHas(kernelId: string, stage: OperatorStage): boolean {
  return operatorSeen.get(kernelId)?.has(stage) ?? false;
}

/** Remember (kernelId, stage) as recorded; the map stays bounded to MAX_TRACKED_KERNELS. */
function markOperatorSeen(kernelId: string, stage: OperatorStage): void {
  let stages = operatorSeen.get(kernelId);
  if (!stages) {
    if (operatorSeen.size >= MAX_TRACKED_KERNELS && operatorKernelOrder.length > 0) {
      const oldest = operatorKernelOrder.shift()!;
      operatorSeen.delete(oldest);
    }
    stages = new Set<OperatorStage>();
    operatorSeen.set(kernelId, stages);
    operatorKernelOrder.push(kernelId);
  }
  stages.add(stage);
}

/**
 * Whether the audit log already holds this (kernelId, stage) row. The in-memory
 * map is only a cache: eviction, a restart or a second gateway instance would
 * otherwise write the stage again (#469 round 1). Two instances racing past this
 * check can still both write; read-side counts are distinct per kernel, so a rare
 * duplicate never changes the funnel.
 */
function operatorStageDurable(kernelId: string, stage: OperatorStage): boolean {
  try {
    return auditService
      .query({ eventType: OPERATOR_FUNNEL_AUDIT_EVENT, resourceType: "kernel", resourceId: kernelId, limit: 50 })
      .some((r) => r.action === stage);
  } catch {
    return false;
  }
}

/** Reset operator-funnel dedup state. Test-only. */
export function __resetOperatorFunnelState(): void {
  operatorSeen.clear();
  operatorKernelOrder.length = 0;
}

export interface OperatorStageMeta {
  operatorId?: string | null;
  deviceId?: string | null;
  capabilityId?: string | null;
  jobId?: string | null;
}

/**
 * Record one operator-onboarding funnel stage for a kernel, from an explicit
 * call site (see call sites in routes/kernels.ts, routes/setup.ts,
 * routes/capabilities.ts, facades/job.facade.ts). No-op unless
 * `funnelEnabled()`. Never throws — every sink is best-effort internally,
 * but call sites should still wrap this call in try/catch per the "telemetry
 * must never break a request" rule, since this function's own guards
 * (kernelId validation, dedup) run before any try/catch below.
 *
 * Returns true iff this call actually recorded a new (kernelId, stage) row;
 * false for: flag off, invalid/missing kernelId, the "kernel_dev_001" dev
 * placeholder, or a (kernelId, stage) pair already recorded.
 *
 * `verified_run` is a real member of OperatorStage/OPERATOR_STAGES, but
 * NOTHING on master calls `recordOperatorStage(_, "verified_run", _)` today.
 * Per the stage inventory: the D4a readiness check (unmerged PR #428,
 * branch feat/d4a-operator-readiness) is intended to be its recorder once it
 * lands — it verifies a completed job's evidence bundle against the
 * kernel's own registered Ed25519 signer. The setup test-job path
 * (POST /api/setup/test-job) must NEVER record verified_run: it either
 * self-attests (`algorithm: "none"`) or, for a real device run, has no
 * signature-verification step against the kernel's registered key — neither
 * constitutes a verified run.
 */
export function recordOperatorStage(
  kernelId: unknown,
  stage: OperatorStage,
  meta?: OperatorStageMeta,
): boolean {
  if (!funnelEnabled()) return false;
  if (typeof kernelId !== "string" || !OPERATOR_KERNEL_ID_RE.test(kernelId)) return false;
  if (kernelId === DEV_PLACEHOLDER_KERNEL_ID) return false;
  if (operatorSeenHas(kernelId, stage)) return false;
  if (operatorStageDurable(kernelId, stage)) {
    markOperatorSeen(kernelId, stage);
    return false;
  }

  const operatorId = meta?.operatorId ?? null;
  const deviceId = meta?.deviceId ?? null;
  const capabilityId = meta?.capabilityId ?? null;
  const jobId = meta?.jobId ?? null;

  // 1. Durable audit row (system of record) — mirrors recordStage's shape. The
  // stage counts as recorded only once this row is written, so a failed write
  // leaves it free to record on the next success (#469 round 1).
  let written = false;
  try {
    written = auditService.log({
      eventType: OPERATOR_FUNNEL_AUDIT_EVENT,
      actor: operatorId ?? "unknown",
      resourceType: "kernel",
      resourceId: kernelId,
      action: stage,
      metadata: {
        stage,
        kernel_id: kernelId,
        device_id: deviceId,
        capability_id: capabilityId,
        job_id: jobId,
      },
    }) === true;
  } catch {
    /* funnel tracking must never affect request handling */
  }
  if (!written) return false;
  markOperatorSeen(kernelId, stage);

  // 2. PostHog — capture per stage, distinctId = kernelId so PostHog funnels
  // reconstruct the operator-onboarding chart natively.
  try {
    trackServerEvent(
      `operator_${stage}`,
      {
        kernel_id: kernelId,
        device_id: deviceId,
        capability_id: capabilityId,
        job_id: jobId,
      },
      kernelId,
    );
  } catch {
    /* analytics must never break request flow */
  }

  // 3. OTel span event on the active span (no new span), declared for the closed exporter
  // (N107b): the stage from OPERATOR_STAGES, the ids as producer-supplied ids.
  try {
    const span = trace.getActiveSpan();
    if (span) {
      const fields: Record<string, Declared> = {
        "pcc.kernel_id": declare.id(kernelId),
        "pcc.operator_funnel.stage": declare.code(stage, OPERATOR_STAGES),
      };
      if (deviceId) fields["pcc.device_id"] = declare.id(deviceId);
      if (capabilityId) fields["pcc.capability_id"] = declare.id(capabilityId);
      if (jobId) fields["pcc.job_id"] = declare.id(jobId);
      addClosedEvent(span, declare.code(`pcc.operator_funnel.${stage}`, OPERATOR_FUNNEL_EVENT_NAMES), fields);
    }
  } catch {
    /* OTel may be uninitialised in tests */
  }

  return true;
}

// ── Read API (audit-log backed) ─────────────────────────────────────────────

export interface OperatorFunnelRow {
  stage: OperatorStage;
  kernels: number;
  /** Conversion from kernel_created, 0..1, or null when no kernel_created rows exist. */
  conversion: number | null;
}

/**
 * Cohort funnel: distinct kernelIds that reached each stage since `since`.
 * Conversion is relative to the `kernel_created` (entry) count; mirrors
 * getCohortFunnel's shape.
 */
export function getOperatorFunnel(opts: { since?: string } = {}): OperatorFunnelRow[] {
  const rows = auditService.query({
    eventType: OPERATOR_FUNNEL_AUDIT_EVENT,
    since: opts.since,
    limit: 100000,
  });

  const perStage = new Map<OperatorStage, Set<string>>();
  for (const s of OPERATOR_STAGES) perStage.set(s, new Set());
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const stage = (r.action as OperatorStage) ?? (meta.stage as OperatorStage);
    const kernelId = r.resourceId;
    if (!stage || !kernelId || !perStage.has(stage)) continue;
    perStage.get(stage)!.add(kernelId);
  }

  const entry = perStage.get("kernel_created")!.size;
  return OPERATOR_STAGES.map((stage) => {
    const kernels = perStage.get(stage)!.size;
    return { stage, kernels, conversion: entry > 0 ? kernels / entry : null };
  });
}

/**
 * Ordered list of operator-funnel stages a single kernelId reached. The audit
 * query can't filter by resource id, so this scans at most 10,000 operator-funnel
 * rows: for full history on a busy gateway, use the private observability store.
 */
export function getOperatorStagesForKernel(kernelId: string): OperatorStage[] {
  const rows = auditService.query({ eventType: OPERATOR_FUNNEL_AUDIT_EVENT, limit: 10000 });
  const found = new Set<OperatorStage>();
  for (const r of rows) {
    if (r.resourceId !== kernelId) continue;
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const stage = (r.action as OperatorStage) ?? (meta.stage as OperatorStage);
    if (stage) found.add(stage);
  }
  return OPERATOR_STAGES.filter((s) => found.has(s));
}
