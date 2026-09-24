/**
 * TracesPage — trace waterfall viewer.
 *
 * Shows backend Sentry-style traces as a nested span waterfall, similar to Jaeger or Sentry's trace explorer.
 * Reads GET /api/traces every 5s: the gateway's in-memory trace collector
 * (packages/gateway/src/trace-collector.ts), fed by kernel job lifecycles and
 * settlement pipelines. When the SSE stream /api/traces/stream connects, its
 * updates patch the list between reads.
 *
 * A failed read shows as unavailable, or as stale over earlier data. It is
 * never replaced by sample traces. Sample traces render only in demo mode
 * (lib/demo-mode.ts), under a DemoBanner.
 */

import React, { useEffect, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { GlassPanel, GlowBadge, EmptyState, LoadingShell } from "@pcc/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useUIStore } from "../stores/ui-store.js";
import { apiGet } from "../lib/api.js";
import { isDemoMode } from "../lib/demo-mode.js";
import { UnavailableState, StaleNotice } from "../components/LiveState.js";
import { DemoBanner } from "../components/DemoState.js";
import { demoTraces } from "../demo/TracesPage.fixtures.js";

// ---------------------------------------------------------------------------
// Types (mirror gateway trace-collector.ts)
// ---------------------------------------------------------------------------

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  description?: string;
  service: string;
  status: "ok" | "error" | "in_progress";
  startTime: number;
  endTime?: number;
  duration_ms?: number;
  attributes: Record<string, string | number | boolean>;
  children?: TraceSpan[];
}

export interface Trace {
  traceId: string;
  rootSpan: TraceSpan;
  spans: TraceSpan[];
  startTime: number;
  endTime?: number;
  duration_ms?: number;
  status: "ok" | "error" | "in_progress";
}

// ---------------------------------------------------------------------------
// Service color mapping
// ---------------------------------------------------------------------------

const SERVICE_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  gateway:    { bg: "bg-emerald-500/20",  border: "border-emerald-500/40",  text: "text-emerald-300",  dot: "bg-emerald-400" },
  kernel:     { bg: "bg-teal-500/20",     border: "border-teal-500/40",     text: "text-teal-300",     dot: "bg-teal-400" },
  a2a:        { bg: "bg-cyan-500/20",     border: "border-cyan-500/40",     text: "text-cyan-300",     dot: "bg-cyan-400" },
  settlement: { bg: "bg-amber-500/20",    border: "border-amber-500/40",    text: "text-amber-300",    dot: "bg-amber-400" },
  storage:    { bg: "bg-purple-500/20",   border: "border-purple-500/40",   text: "text-purple-300",   dot: "bg-purple-400" },
  blockchain: { bg: "bg-orange-500/20",   border: "border-orange-500/40",   text: "text-orange-300",   dot: "bg-orange-400" },
  db:         { bg: "bg-blue-500/20",     border: "border-blue-500/40",     text: "text-blue-300",     dot: "bg-blue-400" },
};

const DEFAULT_COLOR = { bg: "bg-slate-500/20", border: "border-slate-500/40", text: "text-slate-300", dot: "bg-slate-400" };

function serviceColor(service: string) {
  return SERVICE_COLORS[service] ?? DEFAULT_COLOR;
}

// ---------------------------------------------------------------------------
// Reading traces
// ---------------------------------------------------------------------------

/** The gateway's collector keeps the latest 50 traces. */
const TRACE_LIMIT = 50;
const REFRESH_MS = 5_000;
const TRACES_QUERY_KEY = ["traces", "recent"] as const;

async function fetchRecentTraces(): Promise<Trace[]> {
  const res = await apiGet<{ traces?: unknown; total?: number }>(`/traces?limit=${TRACE_LIMIT}`);
  // A 2xx answer without a trace list is a failed read, not an empty one.
  if (!Array.isArray(res?.traces)) {
    throw new Error("The gateway's traces response was not in the expected format.");
  }
  return res.traces as Trace[];
}

/** Add or replace a trace by traceId, newest first. */
function upsertTrace(prev: Trace[], incoming: Trace): Trace[] {
  const idx = prev.findIndex((t) => t.traceId === incoming.traceId);
  if (idx >= 0) {
    const next = [...prev];
    next[idx] = incoming;
    return next;
  }
  return [incoming, ...prev].slice(0, TRACE_LIMIT);
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

// ---------------------------------------------------------------------------
// Helper: flatten tree into depth-first rows for waterfall rendering
// ---------------------------------------------------------------------------

interface SpanRow {
  span: TraceSpan;
  depth: number;
}

function flattenTree(span: TraceSpan, depth = 0): SpanRow[] {
  const rows: SpanRow[] = [{ span, depth }];
  if (span.children) {
    for (const child of span.children) {
      rows.push(...flattenTree(child, depth + 1));
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Status dot component
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: TraceSpan["status"] }) {
  if (status === "in_progress") {
    return (
      <span className="relative inline-flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-teal-500" />
      </span>
    );
  }
  if (status === "error") {
    return <span className="inline-flex h-2 w-2 rounded-full bg-red-500" />;
  }
  return <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />;
}

// ---------------------------------------------------------------------------
// Span bar in the waterfall
// ---------------------------------------------------------------------------

function SpanBar({
  row,
  traceDuration,
  traceStart,
  isSelected,
  onSelect,
}: {
  row: SpanRow;
  traceDuration: number;
  traceStart: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const { span, depth } = row;
  const colors = serviceColor(span.service);
  const duration = span.duration_ms;

  // Position bar relative to trace start
  const startOffset = span.startTime - traceStart;
  const leftPct = traceDuration > 0 ? (startOffset / traceDuration) * 100 : 0;
  const widthPct = traceDuration > 0 && duration ? Math.max((duration / traceDuration) * 100, 0.5) : 2;

  const indentPx = depth * 16;

  return (
    <motion.div
      layout
      className={`flex items-center gap-2 py-0.5 px-2 rounded cursor-pointer hover:bg-white/[0.04] transition-colors ${isSelected ? "bg-white/[0.06]" : ""}`}
      onClick={onSelect}
    >
      {/* Operation label column (fixed width) */}
      <div className="flex items-center gap-1.5 min-w-0 w-64 shrink-0" style={{ paddingLeft: indentPx }}>
        <StatusDot status={span.status} />
        <span className="font-mono text-xs text-white/70 truncate">{span.operation}</span>
      </div>

      {/* Waterfall bar column */}
      <div className="flex-1 relative h-5 min-w-0">
        <div
          className={`absolute top-0.5 h-4 rounded ${colors.bg} border ${colors.border} flex items-center px-1.5 overflow-hidden`}
          style={{ left: `${leftPct}%`, width: `${widthPct}%`, minWidth: "4px" }}
        >
          <span className={`font-mono text-[10px] ${colors.text} truncate whitespace-nowrap`}>
            {span.status === "in_progress" ? (
              <span className="animate-pulse">running…</span>
            ) : duration !== undefined ? (
              formatDuration(duration)
            ) : ""}
          </span>
        </div>
      </div>

      {/* Duration label */}
      <div className="w-16 text-right shrink-0">
        <span className="font-mono text-[11px] text-white/40">
          {span.status === "in_progress" ? "…" : duration !== undefined ? formatDuration(duration) : "-"}
        </span>
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Trace detail panel (waterfall)
// ---------------------------------------------------------------------------

function TraceWaterfall({ trace }: { trace: Trace }) {
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const rows = useMemo(() => flattenTree(trace.rootSpan), [trace.rootSpan]);
  const traceDuration = trace.duration_ms ?? (Date.now() - trace.startTime);
  const selectedSpan = rows.find((r) => r.span.spanId === selectedSpanId)?.span;

  return (
    <div className="space-y-1">
      {/* Ruler */}
      <div className="flex items-center gap-2 px-2 mb-2">
        <div className="w-64 shrink-0" />
        <div className="flex-1 flex justify-between text-[10px] font-mono text-white/20">
          <span>0</span>
          <span>{traceDuration >= 1000 ? (traceDuration / 2000).toFixed(1) + "s" : Math.round(traceDuration / 2) + "ms"}</span>
          <span>{traceDuration >= 1000 ? (traceDuration / 1000).toFixed(1) + "s" : traceDuration + "ms"}</span>
        </div>
        <div className="w-16 shrink-0" />
      </div>

      {/* Span rows */}
      {rows.map((row) => (
        <SpanBar
          key={row.span.spanId}
          row={row}
          traceDuration={traceDuration}
          traceStart={trace.startTime}
          isSelected={row.span.spanId === selectedSpanId}
          onSelect={() => setSelectedSpanId(row.span.spanId === selectedSpanId ? null : row.span.spanId)}
        />
      ))}

      {/* Attributes panel for selected span */}
      <AnimatePresence>
        {selectedSpan && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-2 rounded-lg bg-black/30 border border-white/[0.06] p-3"
          >
            <div className="text-xs font-mono text-white/50 mb-2">
              span: {selectedSpan.spanId} / service: {selectedSpan.service}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(selectedSpan.attributes ?? {}).map(([k, v]) => (
                <React.Fragment key={k}>
                  <span className="text-[11px] font-mono text-white/40 truncate">{k}</span>
                  <span className="text-[11px] font-mono text-white/70 truncate">{String(v)}</span>
                </React.Fragment>
              ))}
              {selectedSpan.duration_ms !== undefined && (
                <>
                  <span className="text-[11px] font-mono text-white/40">duration</span>
                  <span className="text-[11px] font-mono text-emerald-300">{selectedSpan.duration_ms}ms</span>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trace list row
// ---------------------------------------------------------------------------

function TraceListRow({
  trace,
  isSelected,
  onSelect,
}: {
  trace: Trace;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const shortId = trace.traceId.slice(0, 8);
  const spanCount = trace.spans.length;
  const duration = trace.duration_ms;

  return (
    <motion.div
      layout
      className={`flex items-center gap-4 px-4 py-2.5 rounded-lg cursor-pointer transition-all border ${
        isSelected
          ? "bg-emerald-500/10 border-emerald-500/30"
          : "bg-white/[0.02] border-white/[0.05] hover:bg-white/[0.05]"
      }`}
      onClick={onSelect}
    >
      {/* Trace ID */}
      <span className="font-mono text-xs text-white/50 w-24 shrink-0">{shortId}…</span>

      {/* Root operation */}
      <span className="font-mono text-xs text-white/80 flex-1 truncate">{trace.rootSpan.operation}</span>

      {/* Service badge */}
      <GlowBadge
        color={
          trace.rootSpan.service === "kernel" ? "teal" :
          trace.rootSpan.service === "settlement" ? "gold" :
          trace.rootSpan.service === "a2a" ? "cyan" :
          "green"
        }
      >
        {trace.rootSpan.service}
      </GlowBadge>

      {/* Duration */}
      <span className="font-mono text-xs text-white/50 w-16 text-right shrink-0">
        {duration !== undefined ? formatDuration(duration) : "…"}
      </span>

      {/* Span count */}
      <span className="font-mono text-xs text-white/30 w-12 text-right shrink-0">{spanCount} spans</span>

      {/* Status */}
      <div className="w-6 flex justify-center shrink-0">
        {trace.status === "ok" && <span className="text-emerald-400 text-sm">✓</span>}
        {trace.status === "error" && <span className="text-red-400 text-sm">✗</span>}
        {trace.status === "in_progress" && (
          <span className="relative inline-flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-teal-500" />
          </span>
        )}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Summary cards
// ---------------------------------------------------------------------------

function SummaryCards({ traces }: { traces: Trace[] }) {
  const active = traces.filter((t) => t.status === "in_progress").length;
  const completed = traces.filter((t) => t.status === "ok").length;
  const errors = traces.filter((t) => t.status === "error").length;
  const durations = traces.filter((t) => t.duration_ms !== undefined).map((t) => t.duration_ms!);
  // No finished trace means no average, not an average of 0ms.
  const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null;

  const cards = [
    { label: "Active", value: String(active), color: "text-teal-400", bg: "bg-teal-500/10 border-teal-500/20" },
    { label: "Completed", value: String(completed), color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
    { label: "Errors", value: String(errors), color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
    {
      label: "Avg Duration",
      value: avgDuration === null ? "—" : formatDuration(avgDuration),
      color: "text-amber-400",
      bg: "bg-amber-500/10 border-amber-500/20",
    },
  ];

  return (
    <div className="grid grid-cols-4 gap-3">
      {cards.map((c) => (
        <div key={c.label} className={`rounded-xl border p-4 ${c.bg}`}>
          <div className={`text-2xl font-bold font-mono ${c.color}`}>{c.value}</div>
          <div className="text-xs text-white/40 mt-1">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page frame: header, and the list + waterfall explorer
// ---------------------------------------------------------------------------

function TracesHeader({ status }: { status?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-semibold text-white/90">Trace Explorer</h1>
        <p className="text-xs text-white/40 mt-0.5">Sentry-style distributed trace waterfall</p>
      </div>
      <div className="flex items-center gap-2">{status}</div>
    </div>
  );
}

/** "live" only while the SSE stream is connected; otherwise the page is polling. */
function StreamStatus({ open }: { open: boolean }) {
  return (
    <span className={`flex items-center gap-1.5 text-xs ${open ? "text-emerald-400" : "text-white/30"}`}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${open ? "bg-emerald-400" : "bg-white/20"}`} />
      {open ? "live" : `refreshing every ${REFRESH_MS / 1000}s`}
    </span>
  );
}

function TraceExplorer({
  traces,
  selectedTraceId,
  onSelect,
  caption,
}: {
  traces: Trace[];
  selectedTraceId: string | null;
  onSelect: (traceId: string) => void;
  caption?: string;
}) {
  const selectedTrace = traces.find((t) => t.traceId === selectedTraceId);

  return (
    <>
      {/* Summary cards */}
      <SummaryCards traces={traces} />
      {caption && <p className="text-[11px] text-white/25 -mt-1">{caption}</p>}

      {/* Trace list + waterfall split */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
        {/* Trace list */}
        <GlassPanel>
          <div className="p-4 space-y-1">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-white/70">Recent Traces</span>
              <span className="text-xs font-mono text-white/30">{traces.length} traces</span>
            </div>

            {traces.length === 0 ? (
              <EmptyState
                title="No traces recorded yet"
                description="Traces appear here when a kernel runs a job or a settlement pipeline runs on this gateway. It keeps the latest 50 in memory until it restarts."
              />
            ) : (
              <>
                {/* Column headers */}
                <div className="flex items-center gap-4 px-4 py-1 text-[10px] font-mono text-white/25 uppercase tracking-wider">
                  <span className="w-24 shrink-0">Trace ID</span>
                  <span className="flex-1">Root Operation</span>
                  <span className="w-20 shrink-0">Service</span>
                  <span className="w-16 text-right shrink-0">Duration</span>
                  <span className="w-12 text-right shrink-0">Spans</span>
                  <span className="w-6 text-center shrink-0">OK</span>
                </div>

                <AnimatePresence initial={false}>
                  {traces.map((trace) => (
                    <TraceListRow
                      key={trace.traceId}
                      trace={trace}
                      isSelected={trace.traceId === selectedTraceId}
                      onSelect={() => onSelect(trace.traceId)}
                    />
                  ))}
                </AnimatePresence>
              </>
            )}
          </div>
        </GlassPanel>

        {/* Waterfall detail */}
        <GlassPanel>
          <div className="p-4">
            {selectedTrace ? (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div>
                    <span className="text-sm font-medium text-white/70">Waterfall</span>
                    <span className="ml-2 font-mono text-xs text-white/30">{selectedTrace.traceId.slice(0, 16)}…</span>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <span className="font-mono text-xs text-white/40">
                      {selectedTrace.spans.length} spans
                      {selectedTrace.duration_ms !== undefined && (
                        <> · {formatDuration(selectedTrace.duration_ms)} total</>
                      )}
                    </span>
                    <StatusDot status={selectedTrace.status} />
                  </div>
                </div>
                <TraceWaterfall trace={selectedTrace} />
              </>
            ) : (
              <div className="flex items-center justify-center h-48 text-white/20 text-sm">
                {traces.length > 0 ? "Select a trace to view its waterfall" : "No trace to show"}
              </div>
            )}
          </div>
        </GlassPanel>
      </div>

      {/* Service legend */}
      <div className="flex flex-wrap gap-3 pt-1">
        {Object.entries(SERVICE_COLORS).map(([svc, c]) => (
          <div key={svc} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${c.bg} border ${c.border}`} />
            <span className={`text-[11px] font-mono ${c.text}`}>{svc}</span>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function TracesPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);

  useEffect(() => {
    setPageMeta("Traces", "Real-time span waterfall viewer");
  }, [setPageMeta]);

  // Sample traces render only when the viewer asked for a demo (lib/demo-mode.ts).
  return isDemoMode() ? <TracesDemo /> : <TracesLive />;
}

// ── Live: the gateway's trace collector ───────────────────────────────────

function TracesLive() {
  const queryClient = useQueryClient();
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  // True only while the SSE stream is connected; "live" is never claimed otherwise.
  const [streamOpen, setStreamOpen] = useState(false);

  const tracesQuery = useQuery({
    queryKey: TRACES_QUERY_KEY,
    queryFn: fetchRecentTraces,
    refetchInterval: REFRESH_MS,
    staleTime: 2_000,
  });
  const traces = tracesQuery.data;

  // Auto-select first trace when list becomes non-empty
  useEffect(() => {
    if (traces && traces.length > 0 && selectedTraceId === null) {
      setSelectedTraceId(traces[0]!.traceId);
    }
  }, [traces, selectedTraceId]);

  // SSE: updates patch a list the page has already read. The stream never
  // stands in for a failed read, and a stream error never swaps in other data.
  // EventSource cannot send the Authorization header, so a viewer signed in
  // with an API key (not a wallet session) gets only the polled reads.
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (cancelled) return;
      const source = new EventSource("/api/traces/stream");
      es = source;

      source.onopen = () => {
        if (!cancelled) setStreamOpen(true);
      };
      source.addEventListener("connected", () => {
        if (!cancelled) setStreamOpen(true);
      });

      source.addEventListener("trace_update", (e: MessageEvent) => {
        if (cancelled) return;
        let trace: Trace;
        try {
          trace = JSON.parse(e.data) as Trace;
        } catch {
          return; // malformed event: skip it
        }
        if (!trace?.traceId || !trace.rootSpan) return;
        // Only while the last read succeeded, so a failing read keeps its stale notice.
        if (queryClient.getQueryState(TRACES_QUERY_KEY)?.status !== "success") return;
        queryClient.setQueryData<Trace[]>(TRACES_QUERY_KEY, (prev) => (prev ? upsertTrace(prev, trace) : prev));
      });

      source.onerror = () => {
        source.close();
        if (cancelled) return;
        setStreamOpen(false);
        // Retry after 5 seconds; the polled reads carry on meanwhile.
        reconnectTimer = setTimeout(connect, REFRESH_MS);
      };
    }

    connect();

    return () => {
      cancelled = true;
      es?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, [queryClient]);

  let body: React.ReactNode;
  if (traces) {
    body = (
      <>
        {tracesQuery.isError && (
          <StaleNotice what="traces" updatedAt={tracesQuery.dataUpdatedAt} onRetry={() => void tracesQuery.refetch()} />
        )}
        <TraceExplorer
          traces={traces}
          selectedTraceId={selectedTraceId}
          onSelect={setSelectedTraceId}
          caption={`Across the ${traces.length} most recent traces the gateway holds in memory.`}
        />
      </>
    );
  } else if (tracesQuery.isError) {
    body = (
      <GlassPanel>
        <UnavailableState what="traces" error={tracesQuery.error} onRetry={() => void tracesQuery.refetch()} />
      </GlassPanel>
    );
  } else {
    body = <LoadingShell rows={4} />;
  }

  return (
    <div className="space-y-4 p-4 max-w-full">
      <TracesHeader status={<StreamStatus open={streamOpen} />} />
      {body}
    </div>
  );
}

// ── Demo: the prototype with sample traces, under a DemoBanner ────────────

function TracesDemo() {
  const traces = useMemo(() => demoTraces(), []);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(() => traces[0]?.traceId ?? null);

  return (
    <div className="space-y-4 p-4 max-w-full">
      <DemoBanner what="Trace explorer" />
      <TracesHeader />
      <TraceExplorer traces={traces} selectedTraceId={selectedTraceId} onSelect={setSelectedTraceId} />
    </div>
  );
}
