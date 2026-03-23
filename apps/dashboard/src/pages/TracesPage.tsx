/**
 * TracesPage — real-time trace waterfall viewer.
 *
 * Shows backend Sentry-style traces as a nested span waterfall, similar to Jaeger or Sentry's trace explorer.
 * Connects to /api/traces/stream via SSE for live updates.
 */

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { GlassPanel, GlowBadge } from "@pcc/ui";
import { useUIStore } from "../stores/ui-store.js";

// ---------------------------------------------------------------------------
// Types (mirror gateway trace-collector.ts)
// ---------------------------------------------------------------------------

interface TraceSpan {
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

interface Trace {
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
// Mock data for when gateway is offline
// ---------------------------------------------------------------------------

function makeMockTraces(): Trace[] {
  const now = Date.now();

  const makeTrace = (
    traceId: string,
    rootOp: string,
    service: string,
    status: Trace["status"],
    spans: { op: string; svc: string; start: number; dur?: number; parent?: string; status: TraceSpan["status"] }[],
  ): Trace => {
    const rootId = "root-" + traceId;
    const rootSpan: TraceSpan = {
      traceId,
      spanId: rootId,
      operation: rootOp,
      service,
      status: status === "in_progress" ? "in_progress" : status,
      startTime: now - spans[0].start,
      endTime: status !== "in_progress" ? now - spans[0].start + (spans[0].dur ?? 4200) : undefined,
      duration_ms: status !== "in_progress" ? (spans[0].dur ?? 4200) : undefined,
      attributes: { "job.id": traceId },
      children: [],
    };

    const allSpans: TraceSpan[] = [rootSpan];
    const idMap: Record<string, string> = { root: rootId };

    for (const s of spans.slice(1)) {
      const spanId = `span-${traceId}-${s.op}`;
      idMap[s.op] = spanId;
      allSpans.push({
        traceId,
        spanId,
        parentSpanId: s.parent ? (idMap[s.parent] ?? rootId) : rootId,
        operation: s.op,
        service: s.svc,
        status: s.status,
        startTime: now - s.start,
        endTime: s.dur !== undefined ? now - s.start + s.dur : undefined,
        duration_ms: s.dur,
        attributes: {},
        children: [],
      });
    }

    return {
      traceId,
      rootSpan,
      spans: allSpans,
      startTime: rootSpan.startTime,
      endTime: rootSpan.endTime,
      duration_ms: rootSpan.duration_ms,
      status,
    };
  };

  return [
    makeTrace("trace-abc123", "job.lifecycle", "kernel", "ok", [
      { op: "job.lifecycle", svc: "kernel", start: 5000, dur: 4200, status: "ok" },
      { op: "job.load_gcode", svc: "kernel", start: 4900, dur: 320, status: "ok" },
      { op: "job.start_sensors", svc: "kernel", start: 4580, dur: 180, status: "ok" },
      { op: "job.start_execution", svc: "kernel", start: 4400, dur: 1200, status: "ok" },
      { op: "job.wait_for_completion", svc: "kernel", start: 3200, dur: 2100, status: "ok" },
      { op: "evidence.finalize_bundle", svc: "kernel", start: 1100, dur: 850, status: "ok" },
      { op: "settlement.ipfs_archive", svc: "storage", start: 950, dur: 620, parent: "evidence.finalize_bundle", status: "ok" },
      { op: "settlement.pipeline", svc: "settlement", start: 500, dur: 1100, status: "ok" },
      { op: "settlement.db_persist", svc: "db", start: 450, dur: 120, parent: "settlement.pipeline", status: "ok" },
      { op: "settlement.onchain_submit", svc: "blockchain", start: 330, dur: 350, parent: "settlement.pipeline", status: "ok" },
      { op: "settlement.onchain_release", svc: "blockchain", start: 100, dur: 150, parent: "settlement.pipeline", status: "ok" },
    ]),
    makeTrace("trace-def456", "job.lifecycle", "kernel", "in_progress", [
      { op: "job.lifecycle", svc: "kernel", start: 2100, status: "in_progress" },
      { op: "job.load_gcode", svc: "kernel", start: 2000, dur: 200, status: "ok" },
      { op: "job.start_sensors", svc: "kernel", start: 1800, dur: 150, status: "ok" },
      { op: "job.start_execution", svc: "kernel", start: 1650, status: "in_progress" },
    ]),
    makeTrace("trace-ghi789", "settlement.pipeline", "settlement", "error", [
      { op: "settlement.pipeline", svc: "settlement", start: 1500, dur: 800, status: "error" },
      { op: "settlement.ipfs_archive", svc: "storage", start: 1400, dur: 350, status: "ok" },
      { op: "settlement.db_persist", svc: "db", start: 1050, dur: 100, status: "ok" },
      { op: "settlement.onchain_submit", svc: "blockchain", start: 950, dur: 400, status: "error" },
    ]),
  ];
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
              `${duration >= 1000 ? (duration / 1000).toFixed(1) + "s" : duration + "ms"}`
            ) : ""}
          </span>
        </div>
      </div>

      {/* Duration label */}
      <div className="w-16 text-right shrink-0">
        <span className="font-mono text-[11px] text-white/40">
          {span.status === "in_progress" ? "…" : duration !== undefined ? `${duration >= 1000 ? (duration / 1000).toFixed(1) + "s" : duration + "ms"}` : "-"}
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
              {Object.entries(selectedSpan.attributes).map(([k, v]) => (
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
        {duration !== undefined ? (duration >= 1000 ? `${(duration / 1000).toFixed(1)}s` : `${duration}ms`) : "…"}
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
  const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const cards = [
    { label: "Active", value: String(active), color: "text-teal-400", bg: "bg-teal-500/10 border-teal-500/20" },
    { label: "Completed", value: String(completed), color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20" },
    { label: "Errors", value: String(errors), color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
    {
      label: "Avg Duration",
      value: avgDuration >= 1000 ? `${(avgDuration / 1000).toFixed(1)}s` : `${avgDuration}ms`,
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
// Main page
// ---------------------------------------------------------------------------

export function TracesPage() {
  const setPageMeta = useUIStore((s) => s.setPageMeta);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [usingMock, setUsingMock] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setPageMeta("Traces", "Real-time span waterfall viewer");
  }, [setPageMeta]);

  // Merge a trace update into state (add or replace by traceId)
  const mergeTrace = useCallback((incoming: Trace) => {
    setTraces((prev) => {
      const idx = prev.findIndex((t) => t.traceId === incoming.traceId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = incoming;
        return next;
      }
      // New trace — prepend (newest first)
      return [incoming, ...prev].slice(0, 50);
    });
  }, []);

  // Auto-select first trace when list becomes non-empty
  useEffect(() => {
    if (traces.length > 0 && selectedTraceId === null) {
      setSelectedTraceId(traces[0].traceId);
    }
  }, [traces, selectedTraceId]);

  // SSE connection
  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const es = new EventSource("/api/traces/stream");
      esRef.current = es;

      es.addEventListener("connected", () => {
        if (!cancelled) setConnected(true);
      });

      es.addEventListener("trace_update", (e: MessageEvent) => {
        if (cancelled) return;
        try {
          const trace = JSON.parse(e.data) as Trace;
          mergeTrace(trace);
          setUsingMock(false);
        } catch {
          // malformed JSON — ignore
        }
      });

      es.onerror = () => {
        es.close();
        if (!cancelled) {
          setConnected(false);
          // Fallback to mock data
          setTraces(makeMockTraces());
          setUsingMock(true);
          // Retry after 5 seconds
          reconnectTimer.current = setTimeout(connect, 5000);
        }
      };
    }

    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [mergeTrace]);

  const selectedTrace = traces.find((t) => t.traceId === selectedTraceId);

  return (
    <div className="space-y-4 p-4 max-w-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white/90">Trace Explorer</h1>
          <p className="text-xs text-white/40 mt-0.5">Sentry-style distributed trace waterfall</p>
        </div>
        <div className="flex items-center gap-2">
          {usingMock && (
            <span className="text-[11px] font-mono text-amber-400/70 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded">
              mock data (gateway offline)
            </span>
          )}
          <span className={`flex items-center gap-1.5 text-xs ${connected ? "text-emerald-400" : "text-white/30"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-white/20"}`} />
            {connected ? "live" : "connecting…"}
          </span>
        </div>
      </div>

      {/* Summary cards */}
      <SummaryCards traces={traces} />

      {/* Trace list + waterfall split */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
        {/* Trace list */}
        <GlassPanel>
          <div className="p-4 space-y-1">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium text-white/70">Recent Traces</span>
              <span className="text-xs font-mono text-white/30">{traces.length} traces</span>
            </div>

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
              {traces.length === 0 ? (
                <div className="text-center py-12 text-white/20 text-sm">
                  No traces yet. Submit a job to see traces.
                </div>
              ) : (
                traces.map((trace) => (
                  <TraceListRow
                    key={trace.traceId}
                    trace={trace}
                    isSelected={trace.traceId === selectedTraceId}
                    onSelect={() => setSelectedTraceId(trace.traceId)}
                  />
                ))
              )}
            </AnimatePresence>
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
                        <> · {selectedTrace.duration_ms >= 1000 ? `${(selectedTrace.duration_ms / 1000).toFixed(1)}s` : `${selectedTrace.duration_ms}ms`} total</>
                      )}
                    </span>
                    <StatusDot status={selectedTrace.status} />
                  </div>
                </div>
                <TraceWaterfall trace={selectedTrace} />
              </>
            ) : (
              <div className="flex items-center justify-center h-48 text-white/20 text-sm">
                Select a trace to view its waterfall
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
    </div>
  );
}
