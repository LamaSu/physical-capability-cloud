/**
 * Dual-write tracing helpers — record spans to BOTH Sentry and the local TraceCollector.
 *
 * Usage:
 *
 *   const { traceId, spanId } = startTrace(lit("job.lifecycle"), lit("kernel"));
 *   // ... do work ...
 *   await withSpan({ traceId, parentSpanId: spanId, operation: lit("job.load_gcode"), service: lit("kernel") }, async () => {
 *     // ... child work ...
 *   });
 *   endTrace(traceId, spanId, "ok");
 *
 * The local collector is a sink under the closed observability schema (N107b round 5,
 * trace-collector.ts): every id comes from the collector (so it stays readable), an operation,
 * service or description is declared (lit, or declare.code from a closed vocabulary), every
 * attribute a producer wants readable is declared (declare.id, declare.metric, declare.flag,
 * declare.code), and the collector reads every time from the server's clock itself.
 */

import { Sentry } from "./sentry.js";
import { traceCollector, TraceCollector } from "./trace-collector.js";
import { closedText, type Declared } from "./observability/closed-schema.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new top-level trace (root span). Returns traceId + spanId.
 * Call endTrace() when the root operation is complete.
 */
export function startTrace(
  operation: Declared,
  service: Declared,
  attributes?: Record<string, unknown>,
): { traceId: string; spanId: string } {
  const traceId = TraceCollector.newTraceId();
  const spanId = TraceCollector.newSpanId();
  traceCollector.startSpan({ traceId, spanId, operation, service, attributes: attributes ?? {} });
  return { traceId, spanId };
}

/**
 * End a span that was started with startTrace() or withSpan(). The collector takes its end time
 * from the server's clock.
 */
export function endTrace(
  traceId: string,
  spanId: string,
  status: "ok" | "error",
): void {
  traceCollector.endSpan({ traceId, spanId, status });
}

/**
 * Wrap an async function with a child span recorded to both Sentry and the local collector.
 *
 * The Sentry span is created with startSpan (auto-ended), named by the declared operation and
 * service (an undeclared one by its keyed hash); its attributes stay in the local span (Sentry's
 * own chokepoint keeps no span data outside its vocabulary).
 * The local span is created with traceCollector.startSpan / endSpan.
 */
export async function withSpan<T>(
  opts: {
    traceId: string;
    parentSpanId?: string;
    operation: Declared;
    service: Declared;
    description?: Declared;
    attributes?: Record<string, unknown>;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const spanId = TraceCollector.newSpanId();

  traceCollector.startSpan({
    traceId: opts.traceId,
    spanId,
    parentSpanId: opts.parentSpanId,
    operation: opts.operation,
    description: opts.description,
    service: opts.service,
    attributes: opts.attributes ?? {},
  });

  try {
    const result = await Sentry.startSpan(
      {
        name: closedText(opts.operation),
        op: closedText(opts.service),
      },
      fn,
    );
    traceCollector.endSpan({ traceId: opts.traceId, spanId, status: "ok" });
    return result;
  } catch (err) {
    traceCollector.endSpan({ traceId: opts.traceId, spanId, status: "error" });
    throw err;
  }
}

/**
 * Synchronous variant: wrap a synchronous function with a child span.
 */
export function withSpanSync<T>(
  opts: {
    traceId: string;
    parentSpanId?: string;
    operation: Declared;
    service: Declared;
    description?: Declared;
    attributes?: Record<string, unknown>;
  },
  fn: () => T,
): T {
  const spanId = TraceCollector.newSpanId();

  traceCollector.startSpan({
    traceId: opts.traceId,
    spanId,
    parentSpanId: opts.parentSpanId,
    operation: opts.operation,
    description: opts.description,
    service: opts.service,
    attributes: opts.attributes ?? {},
  });

  try {
    const result = fn();
    traceCollector.endSpan({ traceId: opts.traceId, spanId, status: "ok" });
    return result;
  } catch (err) {
    traceCollector.endSpan({ traceId: opts.traceId, spanId, status: "error" });
    throw err;
  }
}
