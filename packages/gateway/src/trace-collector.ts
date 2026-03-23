/**
 * TraceCollector — lightweight in-memory Sentry-style trace collector.
 *
 * Captures spans as they happen and builds a nested span tree per trace.
 * Provides real-time local traces without Sentry cloud latency.
 *
 * Designed to run alongside Sentry: both can receive the same spans.
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
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

export interface StartSpanOpts {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  description?: string;
  service: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface EndSpanOpts {
  traceId: string;
  spanId: string;
  status: "ok" | "error";
  endTime?: number;
}

// ---------------------------------------------------------------------------
// TraceCollector
// ---------------------------------------------------------------------------

export class TraceCollector {
  private traces: Map<string, TraceSpan[]> = new Map();
  private traceOrder: string[] = [];
  private maxTraces = 50;
  private listeners: Set<(trace: Trace) => void> = new Set();

  startSpan(opts: StartSpanOpts): void {
    const span: TraceSpan = {
      traceId: opts.traceId,
      spanId: opts.spanId,
      parentSpanId: opts.parentSpanId,
      operation: opts.operation,
      description: opts.description,
      service: opts.service,
      status: "in_progress",
      startTime: Date.now(),
      attributes: opts.attributes ?? {},
    };

    if (!this.traces.has(opts.traceId)) {
      this.traces.set(opts.traceId, []);
      this.traceOrder.push(opts.traceId);
      // Evict oldest trace if over limit
      if (this.traceOrder.length > this.maxTraces) {
        const oldest = this.traceOrder.shift()!;
        this.traces.delete(oldest);
      }
    }

    this.traces.get(opts.traceId)!.push(span);
    const trace = this.buildTree(this.traces.get(opts.traceId)!);
    this.notifyListeners(trace);
  }

  endSpan(opts: EndSpanOpts): void {
    const spans = this.traces.get(opts.traceId);
    if (!spans) return;

    const span = spans.find((s) => s.spanId === opts.spanId);
    if (!span) return;

    const endTime = opts.endTime ?? Date.now();
    span.endTime = endTime;
    span.duration_ms = endTime - span.startTime;
    span.status = opts.status;

    const trace = this.buildTree(spans);
    this.notifyListeners(trace);
  }

  getRecentTraces(limit = 20): Trace[] {
    const ids = this.traceOrder.slice(-limit).reverse();
    return ids
      .map((id) => {
        const spans = this.traces.get(id);
        return spans ? this.buildTree(spans) : null;
      })
      .filter((t): t is Trace => t !== null);
  }

  getTrace(traceId: string): Trace | null {
    const spans = this.traces.get(traceId);
    if (!spans) return null;
    return this.buildTree(spans);
  }

  subscribe(cb: (trace: Trace) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Generate a new traceId */
  static newTraceId(): string {
    return randomBytes(16).toString("hex");
  }

  /** Generate a new spanId */
  static newSpanId(): string {
    return randomBytes(8).toString("hex");
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private notifyListeners(trace: Trace): void {
    for (const cb of this.listeners) {
      try {
        cb(trace);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private buildTree(spans: TraceSpan[]): Trace {
    if (spans.length === 0) {
      throw new Error("Cannot build tree from empty span list");
    }

    // Deep-clone spans (without children) so we don't mutate originals
    const cloned: TraceSpan[] = spans.map((s) => ({ ...s, children: [] }));
    const byId = new Map<string, TraceSpan>(cloned.map((s) => [s.spanId, s]));

    let rootSpan: TraceSpan | undefined;

    for (const span of cloned) {
      if (span.parentSpanId) {
        const parent = byId.get(span.parentSpanId);
        if (parent) {
          parent.children = parent.children ?? [];
          parent.children.push(span);
        } else {
          // Parent not yet recorded — treat as root candidate
          if (!rootSpan) rootSpan = span;
        }
      } else {
        rootSpan = span;
      }
    }

    // Fallback: use first span as root
    if (!rootSpan) rootSpan = cloned[0];

    // Compute overall trace status
    const hasError = cloned.some((s) => s.status === "error");
    const hasInProgress = cloned.some((s) => s.status === "in_progress");
    const status: Trace["status"] = hasError ? "error" : hasInProgress ? "in_progress" : "ok";

    const startTime = Math.min(...cloned.map((s) => s.startTime));
    const completedSpans = cloned.filter((s) => s.endTime !== undefined);
    const endTime =
      completedSpans.length === cloned.length
        ? Math.max(...completedSpans.map((s) => s.endTime!))
        : undefined;

    return {
      traceId: spans[0].traceId,
      rootSpan,
      spans: cloned,
      startTime,
      endTime,
      duration_ms: endTime !== undefined ? endTime - startTime : undefined,
      status,
    };
  }
}

/** Singleton collector shared across the gateway */
export const traceCollector = new TraceCollector();
