/**
 * Demo fixtures for the Pipeline Telemetry page (pages/TelemetryPage.tsx).
 *
 * Sample values, not PCC state. The page renders them only in demo mode
 * (lib/demo-mode.ts), under a DemoBanner. Before implementer-bravo moved them
 * here, the page showed this timeline whenever no pipeline had events and
 * these logs whenever the log read failed or was still loading.
 */

import type {
  ActiveJobSummary,
  LogEntry,
  LogLevel,
  PipelinePhase,
  TelemetryEvent,
  TelemetryStats,
  TelemetryStatus,
} from "../pages/TelemetryPage.js";

export const DEMO_TELEMETRY_JOB_ID = "job-demo";

const TIMELINE_PHASES: PipelinePhase[] = [
  "discovery",
  "quote_request",
  "quote_response",
  "negotiation",
  "contract_build",
  "escrow_fund",
  "job_submit",
  "job_accepted",
  "job_started",
];

const TIMELINE_STATUSES: TelemetryStatus[] = [
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "started",
];

/** Fixed phase durations (ms) for the completed phases; the last phase is still running. */
const TIMELINE_DURATIONS_MS = [1840, 620, 2310, 3150, 940, 2780, 510, 1275];

/** A sample pipeline: eight completed phases, then execution under way. */
export function demoTelemetryTimeline(now: number = Date.now()): TelemetryEvent[] {
  return TIMELINE_PHASES.map((phase, i) => ({
    id: `evt-${i}`,
    jobId: DEMO_TELEMETRY_JOB_ID,
    timestamp: new Date(now - (TIMELINE_PHASES.length - i) * 45_000).toISOString(),
    phase,
    status: TIMELINE_STATUSES[i]!,
    duration_ms: TIMELINE_DURATIONS_MS[i],
    metadata: {},
    level: "info" as const,
    source: "demo",
  }));
}

/** The sample pipeline as the active-pipelines list would summarize it. */
export function demoTelemetryActive(timeline: TelemetryEvent[]): ActiveJobSummary[] {
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  if (!first || !last) return [];
  return [
    {
      jobId: last.jobId,
      currentPhase: last.phase,
      startedAt: first.timestamp,
      eventCount: timeline.length,
      lastUpdated: last.timestamp,
    },
  ];
}

/** Stats computed from the sample pipeline, the way the gateway computes them. */
export function demoTelemetryStats(timeline: TelemetryEvent[]): TelemetryStats {
  const durations = timeline.flatMap((e) => (e.duration_ms !== undefined ? [e.duration_ms] : []));
  const byPhase = {} as TelemetryStats["byPhase"];
  for (const e of timeline) {
    const entry = byPhase[e.phase] ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (e.status === "failed") entry.failed += 1;
    byPhase[e.phase] = entry;
  }
  const first = timeline[0];
  const last = timeline[timeline.length - 1];
  const spanMinutes =
    first && last ? (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 60_000 : 0;
  const lastStatus = last?.status;
  return {
    totalJobs: timeline.length > 0 ? 1 : 0,
    activeJobs: lastStatus === "started" ? 1 : 0,
    avgDuration_ms: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
    successRate: lastStatus === "completed" ? 1 : 0,
    totalEvents: timeline.length,
    byPhase,
    eventsPerMinute: timeline.length / Math.max(1, spanMinutes),
  };
}

const LOG_LEVELS: LogLevel[] = ["info", "info", "info", "debug", "warn", "info", "error", "info"];
const LOG_SOURCES = ["gateway", "kernel", "agent-broker", "verifier", "agent-user"];
const LOG_MESSAGES = [
  "Job submitted to kernel queue",
  "Quote request dispatched to 3 kernels",
  "Evidence bundle encrypted and archived to IPFS",
  "Merkle commitment computed for batch",
  "Settlement milestone release triggered on-chain",
  "Bittensor verification result received: quality=0.92",
  "Escrow fund confirmation timeout — retrying",
  "Agent negotiation completed in 2 rounds",
  "ZK proof generated for evidence bundle",
  "DePIN epoch reward distribution initiated",
];

const LOGS_CREATED_AT = Date.now();

/** Twenty sample log lines, eight seconds apart. */
export const DEMO_TELEMETRY_LOGS: LogEntry[] = Array.from({ length: 20 }, (_, i) => ({
  id: `log-${i}`,
  timestamp: new Date(LOGS_CREATED_AT - (20 - i) * 8_000).toISOString(),
  level: LOG_LEVELS[i % LOG_LEVELS.length]!,
  message: LOG_MESSAGES[i % LOG_MESSAGES.length]!,
  source: LOG_SOURCES[i % LOG_SOURCES.length]!,
  jobId: i % 2 === 0 ? "job-001" : "job-002",
  metadata: {},
}));

export const DEMO_TELEMETRY_SOURCES: string[] = [...new Set(DEMO_TELEMETRY_LOGS.map((e) => e.source))];
