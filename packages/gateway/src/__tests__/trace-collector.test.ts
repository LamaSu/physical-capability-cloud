/**
 * Tests for the TraceCollector and tracing helpers.
 *
 * N107b round 5: the collector is a sink under the closed observability schema (GET /api/traces
 * returns what it holds to any key holder). Producers use the collector's own ids
 * (TraceCollector.newTraceId/newSpanId) and declared names (lit); the closed contract itself is
 * pinned in the last describe.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TraceCollector } from "../trace-collector.js";
import { declare, keyedHash, lit } from "../observability/closed-schema.js";

const ids = () => ({ traceId: TraceCollector.newTraceId(), spanId: TraceCollector.newSpanId() });

// ---------------------------------------------------------------------------
// TraceCollector unit tests
// ---------------------------------------------------------------------------

describe("TraceCollector", () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector();
  });

  it("creates a trace when startSpan is called with a new traceId", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("test.op"), service: lit("test") });

    const trace = collector.getTrace(traceId);
    expect(trace).not.toBeNull();
    expect(trace!.traceId).toBe(traceId);
    expect(trace!.spans).toHaveLength(1);
    expect(trace!.spans[0].operation).toBe("test.op");
  });

  it("trace status is 'in_progress' when root span has no endTime", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("test.op"), service: lit("kernel") });

    const trace = collector.getTrace(traceId);
    expect(trace!.status).toBe("in_progress");
  });

  it("endSpan updates span status, and its end time and duration_ms come from the server's clock", () => {
    const { traceId, spanId } = ids();
    const before = Date.now();
    collector.startSpan({ traceId, spanId, operation: lit("test.op"), service: lit("kernel") });
    // A producer's end time is never stored (N107b round 5): this one is ignored.
    collector.endSpan({ traceId, spanId, status: "ok", endTime: before + 8_675_309 } as never);
    const after = Date.now();

    const span = collector.getTrace(traceId)!.spans[0];
    expect(span.status).toBe("ok");
    expect(span.endTime).toBeGreaterThanOrEqual(before);
    expect(span.endTime).toBeLessThanOrEqual(after);
    expect(span.duration_ms).toBe(span.endTime! - span.startTime);
  });

  it("trace status becomes 'ok' after all spans complete successfully", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("op"), service: lit("kernel") });
    collector.endSpan({ traceId, spanId, status: "ok" });

    expect(collector.getTrace(traceId)!.status).toBe("ok");
  });

  it("trace status becomes 'error' if any span errors", () => {
    const traceId = TraceCollector.newTraceId();
    const a = TraceCollector.newSpanId();
    const b = TraceCollector.newSpanId();
    collector.startSpan({ traceId, spanId: a, operation: lit("op.a"), service: lit("kernel") });
    collector.startSpan({ traceId, spanId: b, operation: lit("op.b"), service: lit("settlement") });
    collector.endSpan({ traceId, spanId: a, status: "ok" });
    collector.endSpan({ traceId, spanId: b, status: "error" });

    expect(collector.getTrace(traceId)!.status).toBe("error");
  });

  it("builds parent-child tree from parentSpanId", () => {
    const traceId = TraceCollector.newTraceId();
    const root = TraceCollector.newSpanId();
    collector.startSpan({ traceId, spanId: root, operation: lit("root.op"), service: lit("kernel") });
    collector.startSpan({ traceId, spanId: TraceCollector.newSpanId(), parentSpanId: root, operation: lit("child.a"), service: lit("storage") });
    collector.startSpan({ traceId, spanId: TraceCollector.newSpanId(), parentSpanId: root, operation: lit("child.b"), service: lit("db") });

    const rootSpan = collector.getTrace(traceId)!.rootSpan;
    expect(rootSpan.children).toHaveLength(2);
    expect(rootSpan.children![0].operation).toBe("child.a");
    expect(rootSpan.children![1].operation).toBe("child.b");
  });

  it("notifies subscribers on span start/end", () => {
    const calls: string[] = [];
    collector.subscribe((trace) => {
      calls.push(trace.status);
    });

    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("op"), service: lit("kernel") });
    collector.endSpan({ traceId, spanId, status: "ok" });

    expect(calls).toEqual(["in_progress", "ok"]);
  });

  it("subscribe returns an unsubscribe function", () => {
    const calls: number[] = [];
    const unsub = collector.subscribe(() => { calls.push(1); });

    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("op"), service: lit("kernel") });
    unsub();
    collector.endSpan({ traceId, spanId, status: "ok" });

    // Should only have been called once (on startSpan, not endSpan after unsub)
    expect(calls).toHaveLength(1);
  });

  it("getRecentTraces returns traces newest first", () => {
    const traceIds: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const { traceId, spanId } = ids();
      traceIds.push(traceId);
      collector.startSpan({ traceId, spanId, operation: lit("op"), service: lit("test") });
      collector.endSpan({ traceId, spanId, status: "ok" });
    }

    const recent = collector.getRecentTraces(10);
    // newest first — the third trace was added last
    expect(recent.map((t) => t.traceId)).toEqual([traceIds[2], traceIds[1], traceIds[0]]);
  });

  it("returns null for unknown traceId", () => {
    expect(collector.getTrace("does-not-exist")).toBeNull();
  });

  it("endSpan on unknown traceId is a no-op", () => {
    // Should not throw
    expect(() => {
      collector.endSpan({ traceId: "ghost-trace", spanId: "ghost-span", status: "ok" });
    }).not.toThrow();
  });

  it("endSpan on unknown spanId is a no-op", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("op"), service: lit("kernel") });
    expect(() => {
      collector.endSpan({ traceId, spanId: "ghost-span", status: "ok" });
    }).not.toThrow();
    expect(collector.getTrace(traceId)!.spans[0].status).toBe("in_progress");
  });

  it("evicts oldest trace when maxTraces is exceeded", () => {
    // Create a collector with a very small limit
    const small = new TraceCollector();
    // Hack: override maxTraces via the private field using a cast
    (small as unknown as { maxTraces: number }).maxTraces = 3;

    const traceIds: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const { traceId, spanId } = ids();
      traceIds.push(traceId);
      small.startSpan({ traceId, spanId, operation: lit("op"), service: lit("test") });
    }

    // The first trace should be evicted
    expect(small.getTrace(traceIds[0]!)).toBeNull();
    expect(small.getTrace(traceIds[1]!)).not.toBeNull();
    expect(small.getTrace(traceIds[3]!)).not.toBeNull();
  });

  it("newTraceId generates a 32-char hex string", () => {
    const id = TraceCollector.newTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("newSpanId generates a 16-char hex string", () => {
    const id = TraceCollector.newSpanId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("trace duration_ms is set when all spans complete", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("op"), service: lit("kernel") });
    collector.endSpan({ traceId, spanId, status: "ok" });

    const trace = collector.getTrace(traceId)!;
    expect(trace.duration_ms).toBeGreaterThanOrEqual(0);
    expect(trace.duration_ms).toBe(trace.endTime! - trace.startTime);
  });
});

// ---------------------------------------------------------------------------
// The closed contract (N107b round 5)
// ---------------------------------------------------------------------------

describe("TraceCollector under the closed observability schema (N107b round 5)", () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector();
  });

  it("an id the collector did not issue is stored keyed, and one producer id keeps one stored id, so the tree still links", () => {
    collector.startSpan({ traceId: "caller-trace", spanId: "caller-root", operation: lit("root"), service: lit("kernel") });
    collector.startSpan({ traceId: "caller-trace", spanId: "caller-child", parentSpanId: "caller-root", operation: lit("child"), service: lit("kernel") });
    collector.endSpan({ traceId: "caller-trace", spanId: "caller-child", status: "ok" });

    expect(collector.getTrace("caller-trace")).toBeNull();
    const trace = collector.getTrace(keyedHash("caller-trace"))!;
    expect(trace.traceId).toBe(keyedHash("caller-trace"));
    expect(trace.rootSpan.spanId).toBe(keyedHash("caller-root"));
    expect(trace.rootSpan.children![0].spanId).toBe(keyedHash("caller-child"));
    expect(trace.rootSpan.children![0].parentSpanId).toBe(keyedHash("caller-root"));
    expect(trace.rootSpan.children![0].status).toBe("ok");
  });

  it("an undeclared operation, description or service is stored keyed; a declared one as itself", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: "caller.op" as never, description: "caller text" as never, service: "caller-svc" as never });
    const span = collector.getTrace(traceId)!.spans[0];
    expect(span.operation).toBe(keyedHash("caller.op"));
    expect(span.description).toBe(keyedHash("caller text"));
    expect(span.service).toBe(keyedHash("caller-svc"));

    const declared = ids();
    collector.startSpan({ ...declared, operation: lit("job.lifecycle"), service: declare.code("kernel", ["kernel"]) });
    expect(collector.getTrace(declared.traceId)!.spans[0]).toMatchObject({ operation: "job.lifecycle", service: "kernel" });
  });

  it("attributes are closed: a declared attribute keeps its key; anything else is keyed, key and value", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({
      traceId,
      spanId,
      operation: lit("op"),
      service: lit("kernel"),
      attributes: { "job.id": "job-raw", count: declare.metric(3), "bundle.id": declare.id("bundle-raw"), nested: { "inner.id": "inner-raw" } },
    });
    const attributes = collector.getTrace(traceId)!.spans[0].attributes;
    expect(attributes).toMatchObject({ count: 3, "bundle.id": keyedHash("bundle-raw") });
    expect(attributes).not.toHaveProperty("job.id");
    expect(attributes[keyedHash("job.id")]).toBe(keyedHash("job-raw"));
    expect(attributes).not.toHaveProperty("nested");
    expect(JSON.stringify(attributes)).not.toContain("raw");
  });

  it("a status outside the span vocabulary is stored keyed", () => {
    const { traceId, spanId } = ids();
    collector.startSpan({ traceId, spanId, operation: lit("op"), service: lit("kernel") });
    collector.endSpan({ traceId, spanId, status: "caller-status" as never });
    expect(collector.getTrace(traceId)!.spans[0].status).toBe(keyedHash("caller-status"));
  });
});

// ---------------------------------------------------------------------------
// Tracing helpers
// ---------------------------------------------------------------------------

describe("tracing helpers", () => {
  // Mock the Sentry module before importing tracing.ts
  vi.mock("../sentry.js", () => ({
    initSentry: vi.fn(),
    isSentryEnabled: vi.fn().mockReturnValue(false),
    Sentry: {
      startSpan: vi.fn().mockImplementation(
        async (_options: unknown, callback: () => Promise<unknown>) => callback(),
      ),
    },
  }));

  it("startTrace creates a span in the global traceCollector", async () => {
    const { startTrace, endTrace } = await import("../tracing.js");
    const { traceCollector } = await import("../trace-collector.js");

    const { traceId, spanId } = startTrace(lit("test.operation"), lit("gateway"));
    const trace = traceCollector.getTrace(traceId);
    expect(trace).not.toBeNull();
    expect(trace!.status).toBe("in_progress");
    expect(trace!.spans[0]).toMatchObject({ spanId, operation: "test.operation", service: "gateway" });

    endTrace(traceId, spanId, "ok");
    const finished = traceCollector.getTrace(traceId);
    expect(finished!.status).toBe("ok");
  });

  it("withSpan creates a child span and ends it on success", async () => {
    const { startTrace, withSpan } = await import("../tracing.js");
    const { traceCollector } = await import("../trace-collector.js");

    const { traceId, spanId } = startTrace(lit("parent.op"), lit("kernel"));
    await withSpan(
      { traceId, parentSpanId: spanId, operation: lit("child.op"), service: lit("storage") },
      async () => "result",
    );

    const trace = traceCollector.getTrace(traceId);
    expect(trace!.spans.length).toBeGreaterThanOrEqual(2);
    const childSpan = trace!.spans.find((s) => s.operation === "child.op");
    expect(childSpan).toBeDefined();
    expect(childSpan!.status).toBe("ok");
    expect(childSpan!.parentSpanId).toBe(spanId);
  });

  it("withSpan marks child span as error when fn throws", async () => {
    const { startTrace, withSpan } = await import("../tracing.js");
    const { traceCollector } = await import("../trace-collector.js");

    const { traceId, spanId } = startTrace(lit("parent.err"), lit("kernel"));
    await expect(
      withSpan(
        { traceId, parentSpanId: spanId, operation: lit("failing.op"), service: lit("blockchain") },
        async () => { throw new Error("test error"); },
      ),
    ).rejects.toThrow("test error");

    const trace = traceCollector.getTrace(traceId);
    const child = trace!.spans.find((s) => s.operation === "failing.op");
    expect(child!.status).toBe("error");
  });

  it("startTrace closes its attributes: a declared flag stays readable, a declared id is keyed", async () => {
    const { traceCollector } = await import("../trace-collector.js");
    const { startTrace } = await import("../tracing.js");
    const { traceId } = startTrace(lit("job.lifecycle"), lit("kernel"), { "job.id": declare.id("job-raw-1"), "write.enabled": declare.flag(false) });
    const span = traceCollector.getTrace(traceId)!.spans[0];
    expect(span.attributes).toEqual({ "job.id": keyedHash("job-raw-1"), "write.enabled": false });
  });
});
