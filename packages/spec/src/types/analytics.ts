/**
 * Analytics types — structured event stream, materialized views,
 * and unified query interface for PCC's fragmented data sources.
 *
 * Modeled after the Venkiteela paper's Enterprise Data Platform (EDP)
 * pattern, adapted for PCC's multi-source architecture.
 */

import type { Id, Timestamp, SHA256 } from "./common.js";

// ── Structured Events ────────────────────────────────────────────

/** Event categories in the PCC lifecycle */
export type AnalyticsEventCategory =
  | "job"           // job.created, job.completed, job.failed
  | "capability"    // capability.registered, capability.updated
  | "kernel"        // kernel.registered, kernel.heartbeat, kernel.offline
  | "evidence"      // evidence.submitted, evidence.verified, evidence.rejected
  | "settlement"    // escrow.created, escrow.funded, milestone.released
  | "operator"      // operator.registered, operator.suspended
  | "template"      // template.published, template.forked, template.deprecated
  | "compliance"    // compliance.check, compliance.alert, compliance.report
  | "governance"    // ratelimit.exceeded, dlp.redaction, scope.denied
  | (string & {});

/** A structured analytics event */
export interface AnalyticsEvent {
  id: Id;
  /** Event type (e.g., "job.completed", "escrow.funded") */
  eventType: string;
  /** Event category */
  category: AnalyticsEventCategory;
  /** ISO timestamp */
  timestamp: Timestamp;
  /** Actor who caused the event */
  actorId: string;
  /** Actor type */
  actorType: "operator" | "requestor" | "verifier" | "agent" | "system";
  /** Resource affected */
  resourceType: string;
  resourceId: Id;
  /** Event-specific payload */
  payload: Record<string, unknown>;
  /** SHA-256 hash for integrity verification */
  hash: SHA256;
  /** Hash of the previous event (for hash chain) */
  previousHash?: SHA256;
}

// ── Materialized Views ───────────────────────────────────────────

/** Types of pre-computed analytics views */
export type MaterializedViewType =
  | "operator_dashboard"    // total jobs, success rate, earnings, reputation
  | "requestor_dashboard"   // total spend, active jobs, favorite operators
  | "network_dashboard"     // total kernels, capabilities, jobs, settlement volume
  | "capability_analytics"  // per-capability-type usage, pricing, success rates
  | "compliance_summary"    // evidence completeness, tier distribution
  | "settlement_analytics"  // escrow volume, settlement velocity, dispute rate
  | (string & {});

/** A materialized analytics view */
export interface MaterializedView {
  id: Id;
  viewType: MaterializedViewType;
  /** Scope key (e.g., operator ID, capability type, or "network" for global) */
  scopeKey: string;
  /** Pre-computed aggregation data */
  data: Record<string, unknown>;
  /** When this view was last recomputed */
  computedAt: Timestamp;
  /** Number of source events included */
  eventCount: number;
  /** Time range covered */
  periodStart: Timestamp;
  periodEnd: Timestamp;
}

// ── Analytics Query Interface ────────────────────────────────────

/** An analytics query */
export interface AnalyticsQuery {
  /** View type to query */
  viewType: MaterializedViewType;
  /** Scope (e.g., specific operator ID, or "network") */
  scopeKey?: string;
  /** Time range */
  periodStart?: Timestamp;
  periodEnd?: Timestamp;
  /** Grouping (e.g., "day", "week", "month") */
  groupBy?: "hour" | "day" | "week" | "month";
  /** Limit */
  limit?: number;
}

/** Analytics query result */
export interface AnalyticsResult {
  viewType: MaterializedViewType;
  scopeKey: string;
  data: Record<string, unknown>[];
  computedAt: Timestamp;
  /** Data freshness — how old the view is */
  staleness: "fresh" | "stale" | "expired";
  /** Staleness threshold in ms */
  maxAge: number;
}
