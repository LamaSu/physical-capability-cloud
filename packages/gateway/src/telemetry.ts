/**
 * PipelineTelemetryService — tracks pipeline execution lifecycle events.
 *
 * Every stage of a physical capability job (discovery → quote → negotiation →
 * contract → escrow → execution → evidence → verification → settlement → delivery)
 * emits a structured TelemetryEvent. Events are stored in a per-job ring buffer
 * and published to StreamHub for live SSE streaming.
 */

import { randomBytes } from "node:crypto";
import { streamHub } from "./sse/stream-hub.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PipelinePhase =
  | "discovery"
  | "quote_request"
  | "quote_response"
  | "negotiation"
  | "contract_build"
  | "escrow_fund"
  | "job_submit"
  | "job_accepted"
  | "job_started"
  | "evidence_capture"
  | "evidence_encrypt"
  | "evidence_archive"
  | "verification_request"
  | "verification_result"
  | "settlement_claim"
  | "settlement_complete"
  | "delivery_dispatch"
  | "delivery_pickup"
  | "delivery_complete";

export type TelemetryStatus = "started" | "completed" | "failed" | "skipped";

export interface TelemetryEvent {
  id: string;
  jobId: string;
  timestamp: string;
  phase: PipelinePhase;
  status: TelemetryStatus;
  duration_ms?: number;
  metadata: Record<string, unknown>;
  level: "info" | "warn" | "error" | "debug";
  source: string;
}

export interface ActiveJobSummary {
  jobId: string;
  currentPhase: PipelinePhase;
  startedAt: string;
  eventCount: number;
  lastUpdated: string;
}

export interface TelemetryStats {
  totalJobs: number;
  activeJobs: number;
  avgDuration_ms: number;
  successRate: number;
  totalEvents: number;
  byPhase: Record<PipelinePhase, { total: number; failed: number }>;
  eventsPerMinute: number;
}

// ---------------------------------------------------------------------------
// Phase ordering for pipeline visualizer
// ---------------------------------------------------------------------------

export const PIPELINE_PHASES: PipelinePhase[] = [
  "discovery",
  "quote_request",
  "quote_response",
  "negotiation",
  "contract_build",
  "escrow_fund",
  "job_submit",
  "job_accepted",
  "job_started",
  "evidence_capture",
  "evidence_encrypt",
  "evidence_archive",
  "verification_request",
  "verification_result",
  "settlement_claim",
  "settlement_complete",
  "delivery_dispatch",
  "delivery_pickup",
  "delivery_complete",
];

// ---------------------------------------------------------------------------
// Ring buffer helper
// ---------------------------------------------------------------------------

const MAX_EVENTS_PER_JOB = 500;
const MAX_JOBS = 200;

function makeId(): string {
  return randomBytes(6).toString("hex");
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PipelineTelemetryService {
  /** jobId → ordered list of events (newest last) */
  private events = new Map<string, TelemetryEvent[]>();
  /** Track insertion order for eviction */
  private jobOrder: string[] = [];
  /** Track per-minute event count buckets (unix minute → count) */
  private minuteBuckets = new Map<number, number>();

  // ── Public API ────────────────────────────────────────────────────────────

  emit(
    jobId: string,
    phase: PipelinePhase,
    status: TelemetryStatus,
    options: {
      duration_ms?: number;
      metadata?: Record<string, unknown>;
      level?: TelemetryEvent["level"];
      source?: string;
    } = {},
  ): TelemetryEvent {
    const event: TelemetryEvent = {
      id: makeId(),
      jobId,
      timestamp: new Date().toISOString(),
      phase,
      status,
      duration_ms: options.duration_ms,
      metadata: options.metadata ?? {},
      level: options.level ?? (status === "failed" ? "error" : "info"),
      source: options.source ?? "gateway",
    };

    // Store in per-job buffer
    this._addEvent(jobId, event);

    // Track event/minute rate
    const bucket = Math.floor(Date.now() / 60_000);
    this.minuteBuckets.set(bucket, (this.minuteBuckets.get(bucket) ?? 0) + 1);
    // Keep only last 10 minutes
    for (const k of this.minuteBuckets.keys()) {
      if (bucket - k > 10) this.minuteBuckets.delete(k);
    }

    // Publish to StreamHub so SSE clients receive it live
    streamHub.publish(
      [
        { type: "job", id: jobId },
        { type: "global", id: "*" },
      ],
      {
        id: event.id,
        type: "telemetry_event",
        timestamp: event.timestamp,
        topic: { type: "job", id: jobId },
        payload: event,
      },
    );

    return event;
  }

  getTimeline(jobId: string): TelemetryEvent[] {
    return this.events.get(jobId) ?? [];
  }

  getActiveJobs(): ActiveJobSummary[] {
    const summaries: ActiveJobSummary[] = [];

    for (const [jobId, evts] of this.events.entries()) {
      if (evts.length === 0) continue;
      const last = evts[evts.length - 1];
      // Consider "active" if the last event is started or was recent (within 1 hour)
      const lastMs = new Date(last.timestamp).getTime();
      const isRecent = Date.now() - lastMs < 60 * 60 * 1000;
      const isStarted = last.status === "started";
      if (isStarted || isRecent) {
        summaries.push({
          jobId,
          currentPhase: last.phase,
          startedAt: evts[0].timestamp,
          eventCount: evts.length,
          lastUpdated: last.timestamp,
        });
      }
    }

    return summaries.sort(
      (a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
    );
  }

  getAllJobIds(): string[] {
    return [...this.events.keys()];
  }

  getStats(): TelemetryStats {
    let totalJobs = 0;
    let activeJobs = 0;
    let totalDuration = 0;
    let durationCount = 0;
    let successCount = 0;
    let completedOrFailed = 0;
    let totalEvents = 0;

    const byPhase: TelemetryStats["byPhase"] = {} as TelemetryStats["byPhase"];
    for (const phase of PIPELINE_PHASES) {
      byPhase[phase] = { total: 0, failed: 0 };
    }

    for (const evts of this.events.values()) {
      if (evts.length === 0) continue;
      totalJobs++;
      totalEvents += evts.length;

      const last = evts[evts.length - 1];
      if (last.status === "started") activeJobs++;
      if (last.status === "completed") {
        successCount++;
        completedOrFailed++;
      }
      if (last.status === "failed") completedOrFailed++;

      for (const evt of evts) {
        if (byPhase[evt.phase]) {
          byPhase[evt.phase].total++;
          if (evt.status === "failed") byPhase[evt.phase].failed++;
        }
        if (evt.duration_ms !== undefined) {
          totalDuration += evt.duration_ms;
          durationCount++;
        }
      }
    }

    // Events/minute: average over last 5 filled buckets
    const bucketValues = [...this.minuteBuckets.values()];
    const eventsPerMinute =
      bucketValues.length > 0
        ? bucketValues.reduce((a, b) => a + b, 0) / bucketValues.length
        : 0;

    return {
      totalJobs,
      activeJobs,
      avgDuration_ms: durationCount > 0 ? totalDuration / durationCount : 0,
      successRate: completedOrFailed > 0 ? successCount / completedOrFailed : 0,
      totalEvents,
      byPhase,
      eventsPerMinute,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────

  private _addEvent(jobId: string, event: TelemetryEvent): void {
    let buf = this.events.get(jobId);
    if (!buf) {
      // Evict oldest job if at capacity
      if (this.events.size >= MAX_JOBS && this.jobOrder.length > 0) {
        const oldest = this.jobOrder.shift()!;
        this.events.delete(oldest);
      }
      buf = [];
      this.events.set(jobId, buf);
      this.jobOrder.push(jobId);
    }

    buf.push(event);
    if (buf.length > MAX_EVENTS_PER_JOB) {
      buf.shift();
    }
  }
}

/** Singleton shared across the gateway process */
export const pipelineTelemetry = new PipelineTelemetryService();
