/**
 * Demo fixtures for the Trace Explorer (pages/TracesPage.tsx).
 *
 * Sample traces, not PCC state. The page renders them only in demo mode
 * (lib/demo-mode.ts), under a DemoBanner. Before implementer-bravo moved them
 * here, the page swapped them in whenever its SSE stream errored, which is
 * every time for a viewer signed in with an API key (EventSource cannot send
 * the Authorization header).
 *
 * Spans are linked into their parent's `children`, the way the gateway's
 * trace collector builds its tree, so the demo waterfall shows every span.
 */

import type { Trace, TraceSpan } from "../pages/TracesPage.js";

interface DemoSpanSpec {
  op: string;
  svc: string;
  /** Start, in ms before `now`. */
  start: number;
  dur?: number;
  parent?: string;
  status: TraceSpan["status"];
}

function demoTrace(
  now: number,
  traceId: string,
  rootOp: string,
  service: string,
  status: Trace["status"],
  spans: DemoSpanSpec[],
): Trace {
  const rootId = "root-" + traceId;
  const root = spans[0]!;
  const rootSpan: TraceSpan = {
    traceId,
    spanId: rootId,
    operation: rootOp,
    service,
    status: status === "in_progress" ? "in_progress" : status,
    startTime: now - root.start,
    endTime: status !== "in_progress" ? now - root.start + (root.dur ?? 4200) : undefined,
    duration_ms: status !== "in_progress" ? (root.dur ?? 4200) : undefined,
    attributes: { "job.id": traceId },
    children: [],
  };

  const allSpans: TraceSpan[] = [rootSpan];
  const idMap: Record<string, string> = { root: rootId };
  const byId = new Map<string, TraceSpan>([[rootId, rootSpan]]);

  for (const s of spans.slice(1)) {
    const spanId = `span-${traceId}-${s.op}`;
    idMap[s.op] = spanId;
    const span: TraceSpan = {
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
    };
    allSpans.push(span);
    byId.set(spanId, span);
    byId.get(span.parentSpanId!)?.children?.push(span);
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
}

/** Three sample traces: a completed job lifecycle, one still running, and a failed settlement. */
export function demoTraces(now: number = Date.now()): Trace[] {
  return [
    demoTrace(now, "trace-abc123", "job.lifecycle", "kernel", "ok", [
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
    demoTrace(now, "trace-def456", "job.lifecycle", "kernel", "in_progress", [
      { op: "job.lifecycle", svc: "kernel", start: 2100, status: "in_progress" },
      { op: "job.load_gcode", svc: "kernel", start: 2000, dur: 200, status: "ok" },
      { op: "job.start_sensors", svc: "kernel", start: 1800, dur: 150, status: "ok" },
      { op: "job.start_execution", svc: "kernel", start: 1650, status: "in_progress" },
    ]),
    demoTrace(now, "trace-ghi789", "settlement.pipeline", "settlement", "error", [
      { op: "settlement.pipeline", svc: "settlement", start: 1500, dur: 800, status: "error" },
      { op: "settlement.ipfs_archive", svc: "storage", start: 1400, dur: 350, status: "ok" },
      { op: "settlement.db_persist", svc: "db", start: 1050, dur: 100, status: "ok" },
      { op: "settlement.onchain_submit", svc: "blockchain", start: 950, dur: 400, status: "error" },
    ]),
  ];
}
