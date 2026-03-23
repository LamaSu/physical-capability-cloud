/**
 * Dual-write tracing helpers — record spans to BOTH Sentry and the local TraceCollector.
 *
 * Usage:
 *
 *   const { traceId, spanId } = startTrace("job.lifecycle", "kernel");
 *   // ... do work ...
 *   await withSpan({ traceId, parentSpanId: spanId, operation: "job.load_gcode", service: "kernel" }, async () => {
 *     // ... child work ...
 *   });
 *   endTrace(traceId, spanId, "ok");
 */

import { randomBytes } from "node:crypto";
import { Sentry } from "./sentry.js";
import { traceCollector } from "./trace-collector.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a new top-level trace (root span). Returns traceId + spanId.
 * Call endTrace() when the root operation is complete.
 */
export function startTrace(
  operation: string,
  service: string,
  attributes?: Record<string, string | number | boolean>,
): { traceId: string; spanId: string } {
  const traceId = newId(16);
  const spanId = newId(8);
  traceCollector.startSpan({ traceId, spanId, operation, service, attributes: attributes ?? {} });
  return { traceId, spanId };
}

/**
 * End a span that was started with startTrace() or withSpan().
 */
export function endTrace(
  traceId: string,
  spanId: string,
  status: "ok" | "error",
  endTime?: number,
): void {
  traceCollector.endSpan({ traceId, spanId, status, endTime });
}

/**
 * Wrap an async function with a child span recorded to both Sentry and the local collector.
 *
 * The Sentry span is created with startSpan (auto-ended).
 * The local span is created with traceCollector.startSpan / endSpan.
 */
export async function withSpan<T>(
  opts: {
    traceId: string;
    parentSpanId?: string;
    operation: string;
    service: string;
    description?: string;
    attributes?: Record<string, string | number | boolean>;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const spanId = newId(8);

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
        name: opts.operation,
        op: opts.service,
        attributes: opts.attributes,
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
    operation: string;
    service: string;
    description?: string;
    attributes?: Record<string, string | number | boolean>;
  },
  fn: () => T,
): T {
  const spanId = newId(8);

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
