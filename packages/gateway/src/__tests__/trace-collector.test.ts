/**
 * Tests for the TraceCollector and tracing helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TraceCollector } from "../trace-collector.js";

// ---------------------------------------------------------------------------
// TraceCollector unit tests
// ---------------------------------------------------------------------------

describe("TraceCollector", () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector();
  });

  it("creates a trace when startSpan is called with a new traceId", () => {
    collector.startSpan({
      traceId: "trace-001",
      spanId: "span-001",
      operation: "test.op",
      service: "test",
    });

    const trace = collector.getTrace("trace-001");
    expect(trace).not.toBeNull();
    expect(trace!.traceId).toBe("trace-001");
    expect(trace!.spans).toHaveLength(1);
    expect(trace!.spans[0].operation).toBe("test.op");
  });

  it("trace status is 'in_progress' when root span has no endTime", () => {
    collector.startSpan({
      traceId: "trace-002",
      spanId: "span-002",
      operation: "test.op",
      service: "kernel",
    });

    const trace = collector.getTrace("trace-002");
    expect(trace!.status).toBe("in_progress");
  });

  it("endSpan updates span status and duration_ms", () => {
    const startTime = Date.now();
    collector.startSpan({
      traceId: "trace-003",
      spanId: "span-003",
      operation: "test.op",
      service: "kernel",
    });

    const endTime = startTime + 500;
    collector.endSpan({ traceId: "trace-003", spanId: "span-003", status: "ok", endTime });

    const trace = collector.getTrace("trace-003");
    const span = trace!.spans[0];
    expect(span.status).toBe("ok");
    expect(span.endTime).toBe(endTime);
    expect(span.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("trace status becomes 'ok' after all spans complete successfully", () => {
    collector.startSpan({ traceId: "trace-004", spanId: "span-004", operation: "op", service: "kernel" });
    collector.endSpan({ traceId: "trace-004", spanId: "span-004", status: "ok" });

    const trace = collector.getTrace("trace-004");
    expect(trace!.status).toBe("ok");
  });

  it("trace status becomes 'error' if any span errors", () => {
    collector.startSpan({ traceId: "trace-005", spanId: "span-005a", operation: "op.a", service: "kernel" });
    collector.startSpan({ traceId: "trace-005", spanId: "span-005b", operation: "op.b", service: "settlement" });
    collector.endSpan({ traceId: "trace-005", spanId: "span-005a", status: "ok" });
    collector.endSpan({ traceId: "trace-005", spanId: "span-005b", status: "error" });

    const trace = collector.getTrace("trace-005");
    expect(trace!.status).toBe("error");
  });

  it("builds parent-child tree from parentSpanId", () => {
    collector.startSpan({ traceId: "trace-006", spanId: "root", operation: "root.op", service: "kernel" });
    collector.startSpan({ traceId: "trace-006", spanId: "child-a", parentSpanId: "root", operation: "child.a", service: "storage" });
    collector.startSpan({ traceId: "trace-006", spanId: "child-b", parentSpanId: "root", operation: "child.b", service: "db" });

    const trace = collector.getTrace("trace-006");
    const root = trace!.rootSpan;
    expect(root.children).toHaveLength(2);
    expect(root.children![0].operation).toBe("child.a");
    expect(root.children![1].operation).toBe("child.b");
  });

  it("notifies subscribers on span start/end", () => {
    const calls: string[] = [];
    collector.subscribe((trace) => {
      calls.push(trace.status);
    });

    collector.startSpan({ traceId: "trace-007", spanId: "span-007", operation: "op", service: "kernel" });
    collector.endSpan({ traceId: "trace-007", spanId: "span-007", status: "ok" });

    expect(calls).toEqual(["in_progress", "ok"]);
  });

  it("subscribe returns an unsubscribe function", () => {
    const calls: number[] = [];
    const unsub = collector.subscribe(() => { calls.push(1); });

    collector.startSpan({ traceId: "trace-008", spanId: "span-008", operation: "op", service: "kernel" });
    unsub();
    collector.endSpan({ traceId: "trace-008", spanId: "span-008", status: "ok" });

    // Should only have been called once (on startSpan, not endSpan after unsub)
    expect(calls).toHaveLength(1);
  });

  it("getRecentTraces returns traces newest first", () => {
    for (let i = 1; i <= 3; i++) {
      const id = `trace-r${i}`;
      collector.startSpan({ traceId: id, spanId: `sp-${i}`, operation: `op-${i}`, service: "test" });
      collector.endSpan({ traceId: id, spanId: `sp-${i}`, status: "ok" });
    }

    const recent = collector.getRecentTraces(10);
    // newest first — trace-r3 was added last
    expect(recent[0].traceId).toBe("trace-r3");
    expect(recent[1].traceId).toBe("trace-r2");
    expect(recent[2].traceId).toBe("trace-r1");
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
    collector.startSpan({ traceId: "trace-noop", spanId: "real-span", operation: "op", service: "kernel" });
    expect(() => {
      collector.endSpan({ traceId: "trace-noop", spanId: "ghost-span", status: "ok" });
    }).not.toThrow();
  });

  it("evicts oldest trace when maxTraces is exceeded", () => {
    // Create a collector with a very small limit
    const small = new TraceCollector();
    // Hack: override maxTraces via the private field using a cast
    (small as unknown as { maxTraces: number }).maxTraces = 3;

    for (let i = 1; i <= 4; i++) {
      const id = `trace-ev${i}`;
      collector.startSpan({ traceId: id, spanId: `sp-${i}`, operation: `op-${i}`, service: "test" });
    }
    // Use our small collector for this test
    for (let i = 1; i <= 4; i++) {
      const id = `trace-ev${i}`;
      small.startSpan({ traceId: id, spanId: `sp-${i}`, operation: `op-${i}`, service: "test" });
    }

    // trace-ev1 should be evicted
    expect(small.getTrace("trace-ev1")).toBeNull();
    expect(small.getTrace("trace-ev2")).not.toBeNull();
    expect(small.getTrace("trace-ev4")).not.toBeNull();
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
    const now = Date.now();
    collector.startSpan({ traceId: "trace-dur", spanId: "sp-dur", operation: "op", service: "kernel" });
    collector.endSpan({ traceId: "trace-dur", spanId: "sp-dur", status: "ok", endTime: now + 1000 });

    const trace = collector.getTrace("trace-dur");
    expect(trace!.duration_ms).toBeGreaterThan(0);
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

    const { traceId, spanId } = startTrace("test.operation", "gateway");
    const trace = traceCollector.getTrace(traceId);
    expect(trace).not.toBeNull();
    expect(trace!.status).toBe("in_progress");

    endTrace(traceId, spanId, "ok");
    const finished = traceCollector.getTrace(traceId);
    expect(finished!.status).toBe("ok");
  });

  it("withSpan creates a child span and ends it on success", async () => {
    const { startTrace, withSpan } = await import("../tracing.js");
    const { traceCollector } = await import("../trace-collector.js");

    const { traceId, spanId } = startTrace("parent.op", "kernel");
    await withSpan(
      { traceId, parentSpanId: spanId, operation: "child.op", service: "storage" },
      async () => "result",
    );

    const trace = traceCollector.getTrace(traceId);
    expect(trace!.spans.length).toBeGreaterThanOrEqual(2);
    const childSpan = trace!.spans.find((s) => s.operation === "child.op");
    expect(childSpan).toBeDefined();
    expect(childSpan!.status).toBe("ok");
  });

  it("withSpan marks child span as error when fn throws", async () => {
    const { startTrace, withSpan } = await import("../tracing.js");
    const { traceCollector } = await import("../trace-collector.js");

    const { traceId, spanId } = startTrace("parent.err", "kernel");
    await expect(
      withSpan(
        { traceId, parentSpanId: spanId, operation: "failing.op", service: "blockchain" },
        async () => { throw new Error("test error"); },
      ),
    ).rejects.toThrow("test error");

    const trace = traceCollector.getTrace(traceId);
    const child = trace!.spans.find((s) => s.operation === "failing.op");
    expect(child!.status).toBe("error");
  });
});
