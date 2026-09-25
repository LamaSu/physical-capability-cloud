/**
 * Pipeline Telemetry: pipeline events, stats and logs, read live from the gateway.
 *
 * Reads GET /api/telemetry/stats, /api/telemetry/active,
 * /api/telemetry/pipeline/:jobId and /api/telemetry/logs, plus the SSE stream
 * /api/telemetry/logs/stream when it connects. The gateway serves these from
 * its in-memory telemetry buffer (packages/gateway/src/telemetry.ts).
 *
 * A failed read shows as unavailable, or as stale over earlier data. It is
 * never replaced by sample values. The sample timeline and logs render only in
 * demo mode (lib/demo-mode.ts), under a DemoBanner.
 */

import React from "react";
import { GlassPanel, GlowBadge, EmptyState } from "@pcc/ui";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useUIStore } from "../stores/ui-store.js";
import { apiGet } from "../lib/api.js";
import { isDemoMode } from "../lib/demo-mode.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { DemoBanner } from "../components/DemoState.js";
import {
  DEMO_TELEMETRY_LOGS,
  DEMO_TELEMETRY_SOURCES,
  demoTelemetryActive,
  demoTelemetryStats,
  demoTelemetryTimeline,
} from "../demo/TelemetryPage.fixtures.js";

// ---------------------------------------------------------------------------
// Types (mirror packages/gateway/src/telemetry.ts and structured-logger.ts)
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
export type LogLevel = "debug" | "info" | "warn" | "error";

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

export interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  source: string;
  jobId?: string;
  kernelId?: string;
  agentId?: string;
  traceId?: string;
  duration_ms?: number;
  metadata?: Record<string, unknown>;
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
// Phase metadata
// ---------------------------------------------------------------------------

const PIPELINE_PHASES: PipelinePhase[] = [
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

const PHASE_LABELS: Record<PipelinePhase, string> = {
  discovery: "Discover",
  quote_request: "Quote Req",
  quote_response: "Quote Resp",
  negotiation: "Negotiate",
  contract_build: "Contract",
  escrow_fund: "Escrow",
  job_submit: "Submit",
  job_accepted: "Accept",
  job_started: "Execute",
  evidence_capture: "Evidence",
  evidence_encrypt: "Encrypt",
  evidence_archive: "Archive",
  verification_request: "Verify Req",
  verification_result: "Verify Res",
  settlement_claim: "Settle",
  settlement_complete: "Settled",
  delivery_dispatch: "Dispatch",
  delivery_pickup: "Pickup",
  delivery_complete: "Delivered",
};

/** The gateway also emits phases the visualizer doesn't draw; show those by name. */
function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase as PipelinePhase] ?? phase;
}

// ---------------------------------------------------------------------------
// API helpers (apiGet throws on a non-2xx answer, with the server's message)
// ---------------------------------------------------------------------------

interface ActiveResponse {
  active: ActiveJobSummary[];
  count: number;
}

interface StatsResponse {
  stats: TelemetryStats;
}

interface TimelineResponse {
  jobId: string;
  timeline: TelemetryEvent[];
}

interface LogsResponse {
  entries: LogEntry[];
  total: number;
  sources: string[];
}

/** A 2xx answer without the expected shape is a failed read, not an empty one. */
function malformed(what: string): Error {
  return new Error(`The gateway's ${what} response was not in the expected format.`);
}

async function fetchTelemetryActive(): Promise<ActiveResponse> {
  const res = await apiGet<ActiveResponse>("/telemetry/active");
  if (!Array.isArray(res?.active)) throw malformed("active pipelines");
  return res;
}

const STATS_NUMBERS = ["totalJobs", "activeJobs", "avgDuration_ms", "successRate", "totalEvents", "eventsPerMinute"] as const;

async function fetchTelemetryStats(): Promise<StatsResponse> {
  const res = await apiGet<StatsResponse>("/telemetry/stats");
  const stats = res?.stats;
  // A missing figure is not a zero: treat the whole read as failed.
  if (!stats || typeof stats !== "object" || STATS_NUMBERS.some((k) => typeof stats[k] !== "number")) {
    throw malformed("stats");
  }
  return res;
}

async function fetchTelemetryTimeline(jobId: string): Promise<TimelineResponse> {
  const res = await apiGet<TimelineResponse>(`/telemetry/pipeline/${encodeURIComponent(jobId)}`);
  if (!Array.isArray(res?.timeline)) throw malformed("pipeline timeline");
  return res;
}

async function fetchLogs(params: { level?: string; source?: string; search?: string; limit?: number }): Promise<LogsResponse> {
  const qs = new URLSearchParams();
  if (params.level && params.level !== "all") qs.set("level", params.level);
  if (params.source && params.source !== "all") qs.set("source", params.source);
  if (params.search) qs.set("search", params.search);
  if (params.limit) qs.set("limit", String(params.limit));
  const res = await apiGet<LogsResponse>(`/telemetry/logs?${qs}`);
  if (!Array.isArray(res?.entries)) throw malformed("logs");
  return { ...res, sources: Array.isArray(res.sources) ? res.sources : [] };
}

/** The log filters, applied to entries the server didn't filter (live stream, demo). */
function passesLogFilters(e: LogEntry, level: string, source: string, search: string): boolean {
  if (level !== "all" && e.level !== level) return false;
  if (source !== "all" && e.source !== source) return false;
  if (search && !`${e.message} ${e.source}`.toLowerCase().includes(search.toLowerCase())) return false;
  return true;
}

function logKey(e: LogEntry): string {
  return `${e.id}|${e.timestamp}|${e.message}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

// Status → color
const STATUS_DOT: Record<TelemetryStatus, string> = {
  started: "bg-teal-400 animate-pulse",
  completed: "bg-emerald-400",
  failed: "bg-red-400",
  skipped: "bg-white/20",
};

const STATUS_TEXT: Record<TelemetryStatus, string> = {
  started: "text-teal-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  skipped: "text-white/30",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "text-white/30",
  info: "text-teal-400",
  warn: "text-amber-400",
  error: "text-red-400",
};

const LEVEL_BG: Record<LogLevel, string> = {
  debug: "bg-white/[0.03]",
  info: "bg-white/[0.02]",
  warn: "bg-amber-400/[0.04]",
  error: "bg-red-400/[0.06]",
};

// ── Section frame ────────────────────────────────────────────────────────

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <GlassPanel padding="lg">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">{title}</h2>
          {right}
        </div>
        {children}
      </div>
    </GlassPanel>
  );
}

function SectionLoading({ what }: { what: string }) {
  return (
    <div role="status" aria-busy="true" className="text-center py-6 text-white/25 text-xs">
      Loading {what}…
    </div>
  );
}

function ClearPhaseFilter({ selectedPhase, onClear }: { selectedPhase: PipelinePhase | null; onClear: () => void }) {
  if (!selectedPhase) return null;
  return (
    <button onClick={onClear} className="text-xs text-white/30 hover:text-white/60 transition-colors">
      Clear filter
    </button>
  );
}

// ── Pipeline Visualizer ──────────────────────────────────────────────────

interface PipelineVisualizerProps {
  timeline: TelemetryEvent[];
  onPhaseClick: (phase: PipelinePhase) => void;
  selectedPhase: PipelinePhase | null;
}

function PipelineVisualizer({ timeline, onPhaseClick, selectedPhase }: PipelineVisualizerProps) {
  // Build a map of phase → latest status
  const phaseStatus = new Map<PipelinePhase, TelemetryStatus>();
  for (const evt of timeline) {
    phaseStatus.set(evt.phase, evt.status);
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex items-center gap-0 min-w-max">
        {PIPELINE_PHASES.map((phase, i) => {
          const status = phaseStatus.get(phase);
          const isSelected = selectedPhase === phase;

          let nodeClass = "border-white/[0.12] bg-white/[0.03] text-white/25";
          let dotClass = "bg-white/10";
          if (status === "completed") {
            nodeClass = "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-400";
            dotClass = "bg-emerald-400";
          } else if (status === "started") {
            nodeClass = "border-teal-400/60 bg-teal-500/[0.12] text-teal-300 shadow-[0_0_12px_rgba(20,184,166,0.3)]";
            dotClass = "bg-teal-400 animate-pulse";
          } else if (status === "failed") {
            nodeClass = "border-red-500/40 bg-red-500/[0.08] text-red-400";
            dotClass = "bg-red-400";
          } else if (status === "skipped") {
            nodeClass = "border-white/[0.06] bg-white/[0.01] text-white/15";
            dotClass = "bg-white/10";
          }

          if (isSelected) nodeClass += " ring-1 ring-cyan-400/60";

          return (
            <React.Fragment key={phase}>
              <button
                onClick={() => onPhaseClick(phase)}
                className={`flex flex-col items-center gap-1.5 px-2.5 py-2 rounded-lg border transition-all cursor-pointer min-w-[72px] ${nodeClass}`}
              >
                <div className={`w-2 h-2 rounded-full ${dotClass}`} />
                <span className="text-[10px] font-medium leading-tight text-center whitespace-nowrap">
                  {PHASE_LABELS[phase]}
                </span>
              </button>
              {i < PIPELINE_PHASES.length - 1 && (
                <div className="w-3 h-px bg-white/[0.08] flex-shrink-0" />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

// ── Stats Cards ──────────────────────────────────────────────────────────

function StatsCards({ stats }: { stats: TelemetryStats }) {
  // successRate is 0 both when nothing has finished and when everything failed;
  // show 0% only when a failure was recorded.
  const hasFailures = Object.values(stats.byPhase ?? {}).some((p) => (p?.failed ?? 0) > 0);
  const cards = [
    {
      label: "Total Events",
      value: stats.totalEvents,
      sub: `avg ${stats.eventsPerMinute.toFixed(1)} per minute with events`,
      glow: stats.totalEvents > 0,
    },
    {
      label: "Active Pipelines",
      value: stats.activeJobs,
      sub: `${stats.totalJobs} tracked`,
      glow: stats.activeJobs > 0,
    },
    {
      label: "Avg Duration",
      value: stats.avgDuration_ms > 0 ? `${(stats.avgDuration_ms / 1000).toFixed(1)}s` : "—",
      sub: "per timed phase event",
      glow: false,
    },
    {
      label: "Success Rate",
      value: stats.successRate > 0 || hasFailures ? `${(stats.successRate * 100).toFixed(0)}%` : "—",
      sub: "last event completed, not failed",
      glow: stats.successRate > 0.8,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {cards.map((c) => (
        <GlassPanel key={c.label} glow={c.glow ? "green" : undefined} padding="md">
          <div className="space-y-1">
            <div className="text-xs text-white/40 uppercase tracking-wider">{c.label}</div>
            <div className="text-xl font-bold font-mono text-white/90">{c.value}</div>
            <div className="text-xs text-white/30">{c.sub}</div>
          </div>
        </GlassPanel>
      ))}
    </div>
  );
}

function StatsLoading() {
  return (
    <div role="status" aria-busy="true" className="grid grid-cols-2 md:grid-cols-4 gap-3 animate-pulse">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="h-[88px] rounded-xl bg-white/[0.03] border border-white/[0.04]" />
      ))}
    </div>
  );
}

// ── Event Timeline ────────────────────────────────────────────────────────

interface EventTimelineProps {
  events: TelemetryEvent[];
  selectedPhase: PipelinePhase | null;
}

function EventTimeline({ events, selectedPhase }: EventTimelineProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const filtered = selectedPhase ? events.filter((e) => e.phase === selectedPhase) : events;
  const display = [...filtered].reverse().slice(0, 60);

  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = 0;
    }
  }, [selectedPhase]);

  if (display.length === 0) {
    return (
      <div className="text-center py-8 text-white/20 text-sm">
        {selectedPhase ? `No events for phase: ${PHASE_LABELS[selectedPhase]}` : "No events recorded for this pipeline yet."}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-1.5 max-h-64 overflow-y-auto">
      {display.map((evt) => (
        <div
          key={evt.id}
          className={`flex items-start gap-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04] text-xs`}
        >
          {/* Status dot */}
          <div className="mt-0.5 flex-shrink-0">
            <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[evt.status]}`} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 space-y-0.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-white/50">
                {new Date(evt.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className="text-white/30 bg-white/[0.04] px-1.5 py-0.5 rounded text-[10px]">
                {phaseLabel(evt.phase)}
              </span>
              <span className={`font-medium ${STATUS_TEXT[evt.status]}`}>{evt.status}</span>
              {evt.duration_ms !== undefined && (
                <span className="text-white/20">{evt.duration_ms}ms</span>
              )}
              <span className="text-white/20 text-[10px]">{evt.source}</span>
            </div>
            {Object.keys(evt.metadata ?? {}).length > 0 && (
              <div className="text-white/20 text-[10px] font-mono truncate">
                {JSON.stringify(evt.metadata)}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Log Viewer ────────────────────────────────────────────────────────────

interface LogViewerProps {
  /** Entries to list, or null while they can't be listed (see `placeholder`). */
  entries: LogEntry[] | null;
  /** Shown in place of the list when `entries` is null: loading or unavailable. */
  placeholder?: React.ReactNode;
  sources: string[];
  levelFilter: string;
  sourceFilter: string;
  search: string;
  onLevelChange: (v: string) => void;
  onSourceChange: (v: string) => void;
  onSearchChange: (v: string) => void;
}

function LogViewer({
  entries,
  placeholder,
  sources,
  levelFilter,
  sourceFilter,
  search,
  onLevelChange,
  onSourceChange,
  onSearchChange,
}: LogViewerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const display = entries ? entries.slice(-200) : null;

  // Auto-scroll when new entries arrive
  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [display?.length]);

  const allLevels: LogLevel[] = ["debug", "info", "warn", "error"];
  // Keep the chosen source selectable while its results load.
  const sourceOptions = sourceFilter !== "all" && !sources.includes(sourceFilter) ? [...sources, sourceFilter] : sources;
  const filtersActive = levelFilter !== "all" || sourceFilter !== "all" || search !== "";

  return (
    <div className="space-y-3">
      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Level filter chips */}
        <div className="flex gap-1">
          {(["all", ...allLevels] as const).map((l) => (
            <button
              key={l}
              onClick={() => onLevelChange(l)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                levelFilter === l
                  ? "border-teal-400/60 bg-teal-400/10 text-teal-300"
                  : "border-white/[0.08] bg-white/[0.02] text-white/30 hover:text-white/50"
              }`}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Source filter */}
        <select
          value={sourceFilter}
          onChange={(e) => onSourceChange(e.target.value)}
          className="px-2 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 focus:outline-none focus:border-teal-400/40"
        >
          <option value="all">All sources</option>
          {sourceOptions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        {/* Search box */}
        <input
          type="text"
          placeholder="Search logs..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className="flex-1 min-w-[160px] px-3 py-1 rounded bg-white/[0.04] border border-white/[0.08] text-xs text-white/70 placeholder-white/20 focus:outline-none focus:border-teal-400/40"
        />

        {display && <span className="text-xs text-white/20 ml-auto">{display.length} entries</span>}
      </div>

      {/* Log table */}
      <div ref={containerRef} className="max-h-72 overflow-y-auto space-y-px">
        {display === null ? (
          placeholder
        ) : display.length === 0 ? (
          <div className="text-center py-6 text-white/20 text-sm">
            {filtersActive ? "No log entries match your filters" : "No log entries recorded yet."}
          </div>
        ) : (
          display.map((entry, i) => (
            <div
              key={`${entry.id}-${i}`}
              className={`flex items-start gap-2 px-2 py-1.5 rounded text-xs ${LEVEL_BG[entry.level] ?? ""}`}
            >
              <span className="font-mono text-white/30 flex-shrink-0 w-20 text-[10px]">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className={`flex-shrink-0 w-10 font-medium ${LEVEL_COLORS[entry.level] ?? "text-white/40"} text-[10px] uppercase`}>
                {entry.level}
              </span>
              <span className="flex-shrink-0 w-20 text-white/30 text-[10px] truncate">
                {entry.source}
              </span>
              <span className="flex-1 text-white/70 truncate">{entry.message}</span>
              {entry.jobId && (
                <span className="flex-shrink-0 text-white/20 text-[10px] font-mono truncate max-w-[80px]">
                  {entry.jobId}
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Active Job Selector ───────────────────────────────────────────────────

interface ActiveJobSelectorProps {
  jobs: ActiveJobSummary[];
  selectedJobId: string | null;
  onSelect: (jobId: string) => void;
}

function ActiveJobSelector({ jobs, selectedJobId, onSelect }: ActiveJobSelectorProps) {
  if (jobs.length === 0) {
    return (
      <div className="text-xs text-white/25 italic">No pipeline activity in the last hour.</div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {jobs.map((j) => (
        <button
          key={j.jobId}
          onClick={() => onSelect(j.jobId)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-all ${
            selectedJobId === j.jobId
              ? "border-teal-400/50 bg-teal-500/10 text-teal-300"
              : "border-white/[0.08] bg-white/[0.02] text-white/40 hover:text-white/60"
          }`}
        >
          {/* A summary carries no run state, so the dot doesn't pulse. */}
          <div className="w-1.5 h-1.5 rounded-full bg-teal-400/60" />
          <span className="font-mono">{j.jobId}</span>
          <span className="text-white/30">{phaseLabel(j.currentPhase)}</span>
          <GlowBadge color="teal">{j.eventCount} events</GlowBadge>
        </button>
      ))}
    </div>
  );
}

function StreamIndicator({ label, dotClass }: { label: string; dotClass: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass} animate-pulse`} />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function TelemetryPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  React.useEffect(() => {
    setPageMeta("Pipeline Telemetry", "Full pipeline visibility — events, logs, and phase tracking");
  }, [setPageMeta]);

  // Sample values render only when the viewer asked for a demo (lib/demo-mode.ts).
  return isDemoMode() ? <TelemetryDemo /> : <TelemetryLive />;
}

// ── Live: the gateway's telemetry reads ───────────────────────────────────

function TelemetryLive() {
  // ── State ────────────────────────────────────────────────────────────────
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [selectedPhase, setSelectedPhase] = React.useState<PipelinePhase | null>(null);
  const [levelFilter, setLevelFilter] = React.useState("all");
  const [sourceFilter, setSourceFilter] = React.useState("all");
  const [logSearch, setLogSearch] = React.useState("");
  const [liveLogEntries, setLiveLogEntries] = React.useState<LogEntry[]>([]);
  const [liveTelemetryEvents, setLiveTelemetryEvents] = React.useState<TelemetryEvent[]>([]);
  // True only while the SSE stream is connected; "Live" is never claimed otherwise.
  const [streamOpen, setStreamOpen] = React.useState(false);

  // ── Queries ──────────────────────────────────────────────────────────────

  const activeQuery = useQuery({
    queryKey: ["telemetry", "active"],
    queryFn: fetchTelemetryActive,
    refetchInterval: 5_000,
    staleTime: 3_000,
  });

  const statsQuery = useQuery({
    queryKey: ["telemetry", "stats"],
    queryFn: fetchTelemetryStats,
    refetchInterval: 10_000,
    staleTime: 5_000,
  });

  const timelineQuery = useQuery({
    queryKey: ["telemetry", "timeline", selectedJobId],
    queryFn: () => fetchTelemetryTimeline(selectedJobId!),
    enabled: !!selectedJobId,
    refetchInterval: 3_000,
    staleTime: 2_000,
  });

  const logsQuery = useQuery({
    queryKey: ["telemetry", "logs", levelFilter, sourceFilter, logSearch],
    queryFn: () =>
      fetchLogs({ level: levelFilter, source: sourceFilter, search: logSearch, limit: 150 }),
    // While a new filter loads, keep the last answer's source list for the filter
    // controls. Its entries are not listed as the new filter's (see logEntries).
    placeholderData: keepPreviousData,
    refetchInterval: 5_000,
    staleTime: 3_000,
  });

  // ── SSE stream for live updates ──────────────────────────────────────────

  React.useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const es = new EventSource("/api/telemetry/logs/stream");

    es.onopen = () => setStreamOpen(true);
    es.addEventListener("connected", () => setStreamOpen(true));

    es.addEventListener("log_entry", (e: MessageEvent) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        if (typeof entry?.message !== "string") return;
        setLiveLogEntries((prev) => [...prev.slice(-500), entry]);
      } catch { /* malformed event: skip it */ }
    });

    es.addEventListener("telemetry_event", (e: MessageEvent) => {
      try {
        const evt = JSON.parse(e.data) as TelemetryEvent;
        if (typeof evt?.jobId !== "string" || typeof evt.phase !== "string") return;
        setLiveTelemetryEvents((prev) => [...prev.slice(-500), evt]);
        // Auto-select new job if none selected
        setSelectedJobId((cur) => cur ?? evt.jobId);
      } catch { /* malformed event: skip it */ }
    });

    // The stream is an addition to the polled reads; when it fails, the page
    // keeps polling and stops saying "Live".
    es.onerror = () => {
      setStreamOpen(false);
      es.close();
    };

    return () => es.close();
  }, []);

  // ── Derived data ─────────────────────────────────────────────────────────

  const activeJobs = activeQuery.data?.active;

  // If no job selected but active jobs exist, select first
  React.useEffect(() => {
    if (!selectedJobId && activeJobs && activeJobs.length > 0) {
      setSelectedJobId(activeJobs[0]!.jobId);
    }
  }, [activeJobs, selectedJobId]);

  // The selected pipeline's events: the server's timeline plus newer streamed events.
  // Null until the timeline has been read; a failed read never becomes an empty list.
  const mergedTimeline = React.useMemo(() => {
    const server = timelineQuery.data?.timeline;
    if (!server || !selectedJobId) return null;
    const seen = new Set(server.map((e) => e.id));
    const extras = liveTelemetryEvents.filter((e) => e.jobId === selectedJobId && !seen.has(e.id));
    return [...server, ...extras];
  }, [timelineQuery.data, liveTelemetryEvents, selectedJobId]);

  // The logs read, plus streamed entries it doesn't already include. While a
  // new filter loads, keepPreviousData still holds the previous filter's
  // entries; they are not shown as this filter's (only its sources are kept).
  const logsForAnotherFilter = logsQuery.isPlaceholderData;
  const logEntries = React.useMemo(() => {
    const server = logsForAnotherFilter ? undefined : logsQuery.data?.entries;
    if (!server) return null;
    const seen = new Set(server.map(logKey));
    const live = liveLogEntries.filter(
      (e) => passesLogFilters(e, levelFilter, sourceFilter, logSearch) && !seen.has(logKey(e)),
    );
    return [...server, ...live];
  }, [logsQuery.data, logsForAnotherFilter, liveLogEntries, levelFilter, sourceFilter, logSearch]);

  // ── Sections ─────────────────────────────────────────────────────────────

  const retryStats = () => void statsQuery.refetch();
  const retryActive = () => void activeQuery.refetch();
  const retryTimeline = () => void timelineQuery.refetch();
  const retryLogs = () => void logsQuery.refetch();

  const statsSection = statsQuery.data ? (
    <div className="space-y-2">
      {statsQuery.isError && (
        <StaleNotice what="pipeline stats" updatedAt={statsQuery.dataUpdatedAt} onRetry={retryStats} />
      )}
      <StatsCards stats={statsQuery.data.stats} />
      <p className="text-[11px] text-white/25">
        Counts cover what this gateway process holds in memory and reset when it restarts.
      </p>
    </div>
  ) : statsQuery.isError ? (
    <GlassPanel padding="md">
      <UnavailableState what="pipeline stats" error={statsQuery.error} onRetry={retryStats} />
    </GlassPanel>
  ) : (
    <StatsLoading />
  );

  const timelineUnavailable = !!selectedJobId && !timelineQuery.data && timelineQuery.isError;

  let phasesContent: React.ReactNode;
  if (timelineUnavailable) {
    phasesContent = <UnavailableState what="this pipeline's phases" error={timelineQuery.error} onRetry={retryTimeline} />;
  } else {
    phasesContent = (
      <>
        <PipelineVisualizer
          timeline={mergedTimeline ?? []}
          onPhaseClick={(phase) =>
            setSelectedPhase((cur) => (cur === phase ? null : phase))
          }
          selectedPhase={selectedPhase}
        />
        {!selectedJobId && <p className="text-xs text-white/25">No pipeline selected.</p>}
        {selectedJobId && !mergedTimeline && <SectionLoading what="phases" />}
      </>
    );
  }

  let jobsContent: React.ReactNode;
  if (activeJobs) {
    jobsContent = (
      <>
        {activeQuery.isError && (
          <StaleNotice what="recent pipelines" updatedAt={activeQuery.dataUpdatedAt} onRetry={retryActive} />
        )}
        {activeJobs.length > 0 ? (
          <>
            <p className="text-[11px] text-white/25">Pipelines with a phase running or an event in the last hour.</p>
            <ActiveJobSelector jobs={activeJobs} selectedJobId={selectedJobId} onSelect={setSelectedJobId} />
          </>
        ) : (
          <EmptyState
            title="No pipeline activity in the last hour"
            description="A pipeline appears here when the gateway records telemetry for it: a negotiation, a job submission, or an escrow or settlement step."
          />
        )}
      </>
    );
  } else if (activeQuery.isError) {
    jobsContent = <UnavailableState what="recent pipelines" error={activeQuery.error} onRetry={retryActive} />;
  } else {
    jobsContent = <SectionLoading what="recent pipelines" />;
  }

  let eventsContent: React.ReactNode = null;
  if (selectedJobId) {
    if (mergedTimeline) {
      eventsContent = (
        <>
          {timelineQuery.isError && (
            <StaleNotice what="this pipeline's events" updatedAt={timelineQuery.dataUpdatedAt} onRetry={retryTimeline} />
          )}
          <EventTimeline events={mergedTimeline} selectedPhase={selectedPhase} />
        </>
      );
    } else if (timelineUnavailable) {
      eventsContent = <UnavailableState what="this pipeline's events" error={timelineQuery.error} onRetry={retryTimeline} />;
    } else {
      eventsContent = <SectionLoading what="events" />;
    }
  }

  const logsPlaceholder = logsQuery.isError ? (
    <UnavailableState what={logsForAnotherFilter ? "logs for this filter" : "logs"} error={logsQuery.error} onRetry={retryLogs} />
  ) : (
    <SectionLoading what={logsForAnotherFilter ? "entries for this filter" : "logs"} />
  );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* ── Stats Row ── */}
      {statsSection}

      {/* ── Pipeline Visualizer ── */}
      <Section
        title="Pipeline Phases"
        right={<ClearPhaseFilter selectedPhase={selectedPhase} onClear={() => setSelectedPhase(null)} />}
      >
        {phasesContent}
      </Section>

      {/* ── Active Jobs + Timeline ── */}
      <Section
        title="Event Timeline"
        right={
          <div className="flex items-center gap-2 text-xs text-white/30">
            {streamOpen && <StreamIndicator label="Live" dotClass="bg-teal-400" />}
            {selectedJobId && (
              <span className="font-mono text-white/20">{selectedJobId}</span>
            )}
          </div>
        }
      >
        {jobsContent}
        {eventsContent}
      </Section>

      {/* ── Structured Log Viewer ── */}
      <Section
        title="Structured Logs"
        right={
          <div className="flex items-center gap-2 text-xs text-white/30">
            {streamOpen && <StreamIndicator label="Streaming" dotClass="bg-cyan-400" />}
          </div>
        }
      >
        {logsQuery.isError && logsQuery.data && !logsForAnotherFilter && (
          <StaleNotice what="logs" updatedAt={logsQuery.dataUpdatedAt} onRetry={retryLogs} />
        )}
        <LogViewer
          entries={logEntries}
          placeholder={logsPlaceholder}
          sources={logsQuery.data?.sources ?? []}
          levelFilter={levelFilter}
          sourceFilter={sourceFilter}
          search={logSearch}
          onLevelChange={setLevelFilter}
          onSourceChange={setSourceFilter}
          onSearchChange={setLogSearch}
        />
      </Section>
    </div>
  );
}

// ── Demo: the prototype with sample values, under a DemoBanner ────────────

function TelemetryDemo() {
  const [selectedPhase, setSelectedPhase] = React.useState<PipelinePhase | null>(null);
  const [levelFilter, setLevelFilter] = React.useState("all");
  const [sourceFilter, setSourceFilter] = React.useState("all");
  const [logSearch, setLogSearch] = React.useState("");

  const timeline = React.useMemo(() => demoTelemetryTimeline(), []);
  const jobs = React.useMemo(() => demoTelemetryActive(timeline), [timeline]);
  const stats = React.useMemo(() => demoTelemetryStats(timeline), [timeline]);
  const logs = DEMO_TELEMETRY_LOGS.filter((e) => passesLogFilters(e, levelFilter, sourceFilter, logSearch));
  const jobId = jobs[0]?.jobId ?? null;

  return (
    <div className="space-y-5">
      <DemoBanner what="Pipeline telemetry" />

      <StatsCards stats={stats} />

      <Section
        title="Pipeline Phases"
        right={<ClearPhaseFilter selectedPhase={selectedPhase} onClear={() => setSelectedPhase(null)} />}
      >
        <PipelineVisualizer
          timeline={timeline}
          onPhaseClick={(phase) => setSelectedPhase((cur) => (cur === phase ? null : phase))}
          selectedPhase={selectedPhase}
        />
      </Section>

      <Section
        title="Event Timeline"
        right={jobId && <span className="font-mono text-xs text-white/20">{jobId}</span>}
      >
        <ActiveJobSelector jobs={jobs} selectedJobId={jobId} onSelect={() => undefined} />
        <EventTimeline events={timeline} selectedPhase={selectedPhase} />
      </Section>

      <Section title="Structured Logs">
        <LogViewer
          entries={logs}
          sources={DEMO_TELEMETRY_SOURCES}
          levelFilter={levelFilter}
          sourceFilter={sourceFilter}
          search={logSearch}
          onLevelChange={setLevelFilter}
          onSourceChange={setSourceFilter}
          onSearchChange={setLogSearch}
        />
      </Section>
    </div>
  );
}
