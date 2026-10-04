/**
 * TraceCollector — lightweight in-memory Sentry-style trace collector.
 *
 * Captures spans as they happen and builds a nested span tree per trace.
 * Provides real-time local traces without Sentry cloud latency.
 *
 * Designed to run alongside Sentry: both can receive the same spans.
 *
 * A sink under the closed observability schema (N107b round 5; observability/closed-schema.ts):
 * GET /api/traces, /api/traces/:traceId and the trace stream return what it holds to any key holder,
 * so the collector closes everything it stores, whatever a producer passes:
 *   - a trace or span id (a parent's included) is one this collector issued (newTraceId/newSpanId, a
 *     bounded registry), or its keyed hash; one producer id always maps to one stored id within a
 *     trace, so the tree still links up;
 *   - an operation, description or service is declared (lit, or a member of a closed vocabulary
 *     with declare.code), or its keyed hash;
 *   - the attributes go through closeValue: a declared attribute keeps its key, anything else leaves
 *     keyed, key and value, at any depth;
 *   - a span's status is "ok", "error" or "in_progress", or its keyed hash;
 *   - every time is the server's clock, read here: a producer never sets a start or end time;
 *   - every read (getRecentTraces, getTrace, and the subscribers the trace stream fans out from)
 *     gets a tree built fresh and frozen, over attributes stored frozen (#538 round 3): no reader
 *     can change what another reader, or the stream, gets.
 */

import { randomBytes } from "node:crypto";
import { closedText, closeValue, frozen, keyedHash, type Declared } from "./observability/closed-schema.js";

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
  attributes: Record<string, unknown>;
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
  /** Declared (lit, or declare.code from a closed vocabulary); anything else is stored keyed. */
  operation: Declared;
  description?: Declared;
  service: Declared;
  /** Closed by closeValue: declare what may stay readable (declare.id, declare.metric, declare.flag, declare.code). */
  attributes?: Record<string, unknown>;
}

export interface EndSpanOpts {
  traceId: string;
  spanId: string;
  status: "ok" | "error";
}

// ---------------------------------------------------------------------------
// The ids this process issued
// ---------------------------------------------------------------------------

/** How many of the most recently issued trace and span ids stay readable as themselves. */
export const ISSUED_ID_WINDOW = 10_000;
const ISSUED = new Set<string>();
const ISSUED_RING: Array<string | undefined> = new Array<string | undefined>(ISSUED_ID_WINDOW);
let issuedCount = 0;

function issue(id: string): string {
  const slot = issuedCount % ISSUED_ID_WINDOW;
  issuedCount += 1;
  const evicted = ISSUED_RING[slot];
  if (evicted !== undefined) ISSUED.delete(evicted);
  ISSUED_RING[slot] = id;
  ISSUED.add(id);
  return id;
}

/** An id as the collector stores it: one it issued as itself (by registry membership, never by its shape), anything else keyed. */
function closedId(raw: unknown): string {
  return typeof raw === "string" && ISSUED.has(raw) ? raw : keyedHash(raw);
}

const SPAN_STATUSES: ReadonlySet<string> = new Set(["ok", "error", "in_progress"]);

/** A span's status from its vocabulary, else keyed. */
function closedStatus(status: unknown): TraceSpan["status"] {
  return (typeof status === "string" && SPAN_STATUSES.has(status) ? status : keyedHash(status)) as TraceSpan["status"];
}

/** The attributes as stored: closeValue's closed object (a value that is not an object is kept, closed, under a keyed key). */
function closedAttributes(attributes: unknown): Record<string, unknown> {
  if (attributes === undefined || attributes === null) return {};
  const isObject = typeof attributes === "object" && !Array.isArray(attributes);
  const closed = closeValue(isObject ? attributes : { attributes }, 1);
  return closed && typeof closed === "object" && !Array.isArray(closed) ? (closed as Record<string, unknown>) : {};
}

/** One trace as the collector holds it. */
interface StoredTrace {
  /** The trace's id as it leaves. */
  id: string;
  spans: TraceSpan[];
  /** Each span id a producer passed for this trace, as it leaves. */
  ids: Map<unknown, string>;
  /** The trace ids producers passed for this trace (removed with it). */
  raws: unknown[];
}

/** A producer's span id as this trace stores it (the same producer id always gives the same stored id). */
function idIn(trace: StoredTrace, raw: unknown): string {
  const known = trace.ids.get(raw);
  if (known !== undefined) return known;
  const id = closedId(raw);
  trace.ids.set(raw, id);
  return id;
}

// ---------------------------------------------------------------------------
// TraceCollector
// ---------------------------------------------------------------------------

export class TraceCollector {
  /** The traces held, by their stored ids (what GET /api/traces/:traceId looks up). */
  private traces: Map<string, StoredTrace> = new Map();
  /** A producer's trace id → the stored id, for the traces held. */
  private byProducerId: Map<unknown, string> = new Map();
  private traceOrder: string[] = [];
  private maxTraces = 50;
  private listeners: Set<(trace: Trace) => void> = new Set();

  startSpan(opts: StartSpanOpts): void {
    const trace = this.traceFor(opts.traceId);
    const span: TraceSpan = {
      traceId: trace.id,
      spanId: idIn(trace, opts.spanId),
      parentSpanId: opts.parentSpanId === undefined ? undefined : idIn(trace, opts.parentSpanId),
      operation: closedText(opts.operation),
      description: opts.description === undefined ? undefined : closedText(opts.description),
      service: closedText(opts.service),
      status: "in_progress",
      startTime: Date.now(),
      attributes: frozen(closedAttributes(opts.attributes)),
    };

    trace.spans.push(span);
    this.notifyListeners(this.buildTree(trace));
  }

  endSpan(opts: EndSpanOpts): void {
    const stored = this.byProducerId.get(opts.traceId);
    const trace = stored === undefined ? undefined : this.traces.get(stored);
    if (!trace) return;

    const spanId = trace.ids.get(opts.spanId);
    const span = spanId === undefined ? undefined : trace.spans.find((s) => s.spanId === spanId);
    if (!span) return;

    // The server's clock: a producer never sets a span's end time.
    const endTime = Date.now();
    span.endTime = endTime;
    span.duration_ms = endTime - span.startTime;
    span.status = closedStatus(opts.status);

    this.notifyListeners(this.buildTree(trace));
  }

  getRecentTraces(limit = 20): Trace[] {
    const ids = this.traceOrder.slice(-limit).reverse();
    return ids
      .map((id) => {
        const trace = this.traces.get(id);
        return trace && trace.spans.length > 0 ? this.buildTree(trace) : null;
      })
      .filter((t): t is Trace => t !== null);
  }

  /** A trace by its stored id (the id GET /api/traces returns). */
  getTrace(traceId: string): Trace | null {
    const trace = this.traces.get(traceId);
    if (!trace || trace.spans.length === 0) return null;
    return this.buildTree(trace);
  }

  subscribe(cb: (trace: Trace) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Generate a new traceId (recorded as issued, so it stays readable) */
  static newTraceId(): string {
    return issue(randomBytes(16).toString("hex"));
  }

  /** Generate a new spanId (recorded as issued, so it stays readable) */
  static newSpanId(): string {
    return issue(randomBytes(8).toString("hex"));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** The trace a producer's trace id names: the one held for it, or a new one (the oldest evicted past maxTraces). */
  private traceFor(producerId: unknown): StoredTrace {
    const known = this.byProducerId.get(producerId);
    const held = known === undefined ? undefined : this.traces.get(known);
    if (held) return held;

    const id = closedId(producerId);
    let trace = this.traces.get(id);
    if (!trace) {
      trace = { id, spans: [], ids: new Map(), raws: [] };
      this.traces.set(id, trace);
      this.traceOrder.push(id);
      // Evict oldest trace if over limit
      if (this.traceOrder.length > this.maxTraces) {
        const oldest = this.traceOrder.shift()!;
        const evicted = this.traces.get(oldest);
        if (evicted) for (const raw of evicted.raws) this.byProducerId.delete(raw);
        this.traces.delete(oldest);
      }
    }
    this.byProducerId.set(producerId, id);
    trace.raws.push(producerId);
    return trace;
  }

  private notifyListeners(trace: Trace): void {
    for (const cb of this.listeners) {
      try {
        cb(trace);
      } catch {
        // Ignore callback errors
      }
    }
  }

  private buildTree(trace: StoredTrace): Trace {
    const spans = trace.spans;
    if (spans.length === 0) {
      throw new Error("Cannot build tree from empty span list");
    }

    // Copy each span (its attributes are stored frozen) with its own children list; the tree is
    // frozen below, so a reader cannot change the store or what another reader gets.
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

    for (const span of cloned) {
      Object.freeze(span.children);
      Object.freeze(span);
    }
    Object.freeze(cloned);
    return Object.freeze({
      traceId: trace.id,
      rootSpan,
      spans: cloned,
      startTime,
      endTime,
      duration_ms: endTime !== undefined ? endTime - startTime : undefined,
      status,
    });
  }
}

/** Singleton collector shared across the gateway */
export const traceCollector = new TraceCollector();
