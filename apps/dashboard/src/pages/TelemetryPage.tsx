import React from "react";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/gateway.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PipelinePhase =
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

type TelemetryStatus = "started" | "completed" | "failed" | "skipped";
type LogLevel = "debug" | "info" | "warn" | "error";

interface TelemetryEvent {
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

interface LogEntry {
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

interface ActiveJobSummary {
  jobId: string;
  currentPhase: PipelinePhase;
  startedAt: string;
  eventCount: number;
  lastUpdated: string;
}

interface TelemetryStats {
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

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchTelemetryActive(): Promise<{ active: ActiveJobSummary[]; count: number }> {
  const res = await fetch("/api/telemetry/active");
  if (!res.ok) return { active: [], count: 0 };
  return res.json();
}

async function fetchTelemetryStats(): Promise<{ stats: TelemetryStats }> {
  const res = await fetch("/api/telemetry/stats");
  if (!res.ok) return { stats: { totalJobs: 0, activeJobs: 0, avgDuration_ms: 0, successRate: 0, totalEvents: 0, byPhase: {} as TelemetryStats["byPhase"], eventsPerMinute: 0 } };
  return res.json();
}

async function fetchTelemetryTimeline(jobId: string): Promise<{ timeline: TelemetryEvent[] }> {
  const res = await fetch(`/api/telemetry/pipeline/${jobId}`);
  if (!res.ok) return { timeline: [] };
  return res.json();
}

async function fetchLogs(params: { level?: string; source?: string; search?: string; limit?: number }): Promise<{ entries: LogEntry[]; sources: string[] }> {
  const qs = new URLSearchParams();
  if (params.level && params.level !== "all") qs.set("level", params.level);
  if (params.source && params.source !== "all") qs.set("source", params.source);
  if (params.search) qs.set("search", params.search);
  if (params.limit) qs.set("limit", String(params.limit));
  const res = await fetch(`/api/telemetry/logs?${qs}`);
  if (!res.ok) return { entries: [], sources: [] };
  return res.json();
}

// ---------------------------------------------------------------------------
// Mock data (used when gateway is offline)
// ---------------------------------------------------------------------------

function makeMockTimeline(jobId: string): TelemetryEvent[] {
  const phases: PipelinePhase[] = ["discovery", "quote_request", "quote_response", "negotiation", "contract_build", "escrow_fund", "job_submit", "job_accepted", "job_started"];
  const statuses: TelemetryStatus[] = ["completed", "completed", "completed", "completed", "completed", "completed", "completed", "completed", "started"];
  const now = Date.now();
  return phases.map((phase, i) => ({
    id: `evt-${i}`,
    jobId,
    timestamp: new Date(now - (phases.length - i) * 45_000).toISOString(),
    phase,
    status: statuses[i],
    duration_ms: i < statuses.length - 1 ? Math.floor(Math.random() * 3000 + 500) : undefined,
    metadata: {},
    level: "info" as const,
    source: "mock",
  }));
}

const MOCK_LOGS: LogEntry[] = Array.from({ length: 20 }, (_, i) => {
  const levels: LogLevel[] = ["info", "info", "info", "debug", "warn", "info", "error", "info"];
  const sources = ["gateway", "kernel", "agent-broker", "verifier", "agent-user"];
  const messages = [
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
  const now = Date.now();
  return {
    id: `log-${i}`,
    timestamp: new Date(now - (20 - i) * 8_000).toISOString(),
    level: levels[i % levels.length],
    message: messages[i % messages.length],
    source: sources[i % sources.length],
    jobId: i % 2 === 0 ? "job-001" : "job-002",
    metadata: {},
  };
});

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

interface StatsCardsProps {
  stats: TelemetryStats | null;
}

function StatsCards({ stats }: StatsCardsProps) {
  const cards = [
    {
      label: "Total Events",
      value: stats?.totalEvents ?? 0,
      sub: `${(stats?.eventsPerMinute ?? 0).toFixed(1)}/min`,
      glow: (stats?.totalEvents ?? 0) > 0,
    },
    {
      label: "Active Pipelines",
      value: stats?.activeJobs ?? 0,
      sub: `${stats?.totalJobs ?? 0} total jobs`,
      glow: (stats?.activeJobs ?? 0) > 0,
    },
    {
      label: "Avg Duration",
      value: stats?.avgDuration_ms ? `${(stats.avgDuration_ms / 1000).toFixed(1)}s` : "—",
      sub: "per phase",
      glow: false,
    },
    {
      label: "Success Rate",
      value: stats?.successRate ? `${(stats.successRate * 100).toFixed(0)}%` : "—",
      sub: "completed jobs",
      glow: (stats?.successRate ?? 0) > 0.8,
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
        {selectedPhase ? `No events for phase: ${PHASE_LABELS[selectedPhase]}` : "No events yet — start a job to see pipeline telemetry"}
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
                {PHASE_LABELS[evt.phase]}
              </span>
              <span className={`font-medium ${STATUS_TEXT[evt.status]}`}>{evt.status}</span>
              {evt.duration_ms !== undefined && (
                <span className="text-white/20">{evt.duration_ms}ms</span>
              )}
              <span className="text-white/20 text-[10px]">{evt.source}</span>
            </div>
            {Object.keys(evt.metadata).length > 0 && (
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
  logs: LogEntry[];
  sources: string[];
  levelFilter: string;
  sourceFilter: string;
  search: string;
  onLevelChange: (v: string) => void;
  onSourceChange: (v: string) => void;
  onSearchChange: (v: string) => void;
  liveEntries: LogEntry[];
}

function LogViewer({
  logs,
  sources,
  levelFilter,
  sourceFilter,
  search,
  onLevelChange,
  onSourceChange,
  onSearchChange,
  liveEntries,
}: LogViewerProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll on new live entries
  React.useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [liveEntries.length]);

  const allLevels: LogLevel[] = ["debug", "info", "warn", "error"];
  const display = [...logs, ...liveEntries].slice(-200);

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
          {sources.map((s) => (
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

        <span className="text-xs text-white/20 ml-auto">{display.length} entries</span>
      </div>

      {/* Log table */}
      <div ref={containerRef} className="max-h-72 overflow-y-auto space-y-px">
        {display.length === 0 ? (
          <div className="text-center py-6 text-white/20 text-sm">No log entries match your filters</div>
        ) : (
          display.map((entry) => (
            <div
              key={entry.id}
              className={`flex items-start gap-2 px-2 py-1.5 rounded text-xs ${LEVEL_BG[entry.level]}`}
            >
              <span className="font-mono text-white/30 flex-shrink-0 w-20 text-[10px]">
                {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </span>
              <span className={`flex-shrink-0 w-10 font-medium ${LEVEL_COLORS[entry.level]} text-[10px] uppercase`}>
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
      <div className="text-xs text-white/25 italic">No active jobs — emit a telemetry event to see pipeline flow</div>
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
          <div className={`w-1.5 h-1.5 rounded-full ${j.currentPhase ? "bg-teal-400 animate-pulse" : "bg-white/20"}`} />
          <span className="font-mono">{j.jobId}</span>
          <span className="text-white/30">{PHASE_LABELS[j.currentPhase as PipelinePhase] ?? j.currentPhase}</span>
          <GlowBadge color="teal">{j.eventCount} events</GlowBadge>
        </button>
      ))}
    </div>
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

  // ── State ────────────────────────────────────────────────────────────────
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [selectedPhase, setSelectedPhase] = React.useState<PipelinePhase | null>(null);
  const [levelFilter, setLevelFilter] = React.useState("all");
  const [sourceFilter, setSourceFilter] = React.useState("all");
  const [logSearch, setLogSearch] = React.useState("");
  const [liveLogEntries, setLiveLogEntries] = React.useState<LogEntry[]>([]);
  const [liveTelemetryEvents, setLiveTelemetryEvents] = React.useState<TelemetryEvent[]>([]);

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
    refetchInterval: 5_000,
    staleTime: 3_000,
  });

  // ── SSE stream for live updates ──────────────────────────────────────────

  React.useEffect(() => {
    const es = new EventSource("/api/telemetry/logs/stream");

    es.addEventListener("log_entry", (e: MessageEvent) => {
      try {
        const entry = JSON.parse(e.data) as LogEntry;
        setLiveLogEntries((prev) => [...prev.slice(-500), entry]);
      } catch { /* ignore */ }
    });

    es.addEventListener("telemetry_event", (e: MessageEvent) => {
      try {
        const evt = JSON.parse(e.data) as TelemetryEvent;
        setLiveTelemetryEvents((prev) => [...prev.slice(-500), evt]);
        // Auto-select new job if none selected
        setSelectedJobId((cur) => cur ?? evt.jobId);
      } catch { /* ignore */ }
    });

    es.onerror = () => {
      es.close();
    };

    return () => es.close();
  }, []);

  // ── Derived data ─────────────────────────────────────────────────────────

  const activeJobs = activeQuery.data?.active ?? [];
  const stats = statsQuery.data?.stats ?? null;

  // If no job selected but active jobs exist, select first
  React.useEffect(() => {
    if (!selectedJobId && activeJobs.length > 0) {
      setSelectedJobId(activeJobs[0].jobId);
    }
  }, [activeJobs, selectedJobId]);

  // Merge server timeline with live SSE events
  const serverTimeline = timelineQuery.data?.timeline ?? [];
  const liveForJob = selectedJobId
    ? liveTelemetryEvents.filter((e) => e.jobId === selectedJobId)
    : [];
  const mergedTimeline = React.useMemo(() => {
    const seen = new Set(serverTimeline.map((e) => e.id));
    const extras = liveForJob.filter((e) => !seen.has(e.id));
    return [...serverTimeline, ...extras];
  }, [serverTimeline, liveForJob]);

  // Merge server logs with live SSE log entries
  const serverLogs = logsQuery.data?.entries ?? MOCK_LOGS;
  const sources = logsQuery.data?.sources ?? ["gateway", "kernel", "agent-broker"];

  // Live log entries that pass current filters
  const filteredLive = liveLogEntries.filter((e) => {
    if (levelFilter !== "all" && e.level !== levelFilter) return false;
    if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
    if (logSearch && !(`${e.message} ${e.source}`).toLowerCase().includes(logSearch.toLowerCase())) return false;
    return true;
  });

  // ── Render ───────────────────────────────────────────────────────────────

  const gatewayOffline = activeQuery.isError && statsQuery.isError;

  return (
    <div className="space-y-5">
      {gatewayOffline && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white/[0.03] border border-white/[0.06] text-xs text-white/30">
          <span className="inline-block w-2 h-2 rounded-full bg-white/20" />
          Gateway offline — showing mock telemetry data
        </div>
      )}

      {/* ── Stats Row ── */}
      <StatsCards stats={stats} />

      {/* ── Pipeline Visualizer ── */}
      <GlassPanel padding="lg">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
              Pipeline Phases
            </h2>
            {selectedPhase && (
              <button
                onClick={() => setSelectedPhase(null)}
                className="text-xs text-white/30 hover:text-white/60 transition-colors"
              >
                Clear filter
              </button>
            )}
          </div>

          <PipelineVisualizer
            timeline={mergedTimeline}
            onPhaseClick={(phase) =>
              setSelectedPhase((cur) => (cur === phase ? null : phase))
            }
            selectedPhase={selectedPhase}
          />
        </div>
      </GlassPanel>

      {/* ── Active Jobs + Timeline ── */}
      <GlassPanel padding="lg">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
              Event Timeline
            </h2>
            <div className="flex items-center gap-2 text-xs text-white/30">
              {liveTelemetryEvents.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
                  Live
                </span>
              )}
              {selectedJobId && (
                <span className="font-mono text-white/20">{selectedJobId}</span>
              )}
            </div>
          </div>

          {/* Job selector */}
          <ActiveJobSelector
            jobs={activeJobs}
            selectedJobId={selectedJobId}
            onSelect={setSelectedJobId}
          />

          {/* Timeline events */}
          <EventTimeline
            events={mergedTimeline.length > 0 ? mergedTimeline : makeMockTimeline("job-demo")}
            selectedPhase={selectedPhase}
          />
        </div>
      </GlassPanel>

      {/* ── Structured Log Viewer ── */}
      <GlassPanel padding="lg">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
              Structured Logs
            </h2>
            <div className="flex items-center gap-2 text-xs text-white/30">
              {liveLogEntries.length > 0 && (
                <span className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  Streaming
                </span>
              )}
            </div>
          </div>

          <LogViewer
            logs={serverLogs}
            sources={sources}
            levelFilter={levelFilter}
            sourceFilter={sourceFilter}
            search={logSearch}
            onLevelChange={setLevelFilter}
            onSourceChange={setSourceFilter}
            onSearchChange={setLogSearch}
            liveEntries={filteredLive}
          />
        </div>
      </GlassPanel>
    </div>
  );
}
