/**
 * Wave 4.4 — tests for the event-bus → OTel bridge. The OTel SDK itself
 * runs in NOOP mode in tests (no exporter wired), so we mock the tracer
 * factory and assert on span lifecycle semantics rather than on exporter
 * output. What the exporter sends is pinned in observability/otlp-sink.test.ts:
 * since N107b (#538 round 3) the bridge declares every field, so an emitter's
 * values reach the span keyed.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { emit, _resetSubscribersForTests } from "@pcc/orchestrator-sdk";
import { keyedHash } from "../observability/closed-schema.js";

const startSpan = vi.fn();
const setStatus = vi.fn();
const recordException = vi.fn();
const end = vi.fn();
const setAttribute = vi.fn();
const addEvent = vi.fn();

const mockSpan = { setStatus, recordException, end, setAttribute, addEvent };

vi.mock("../otel.js", () => ({
  getTracer: () => ({
    startSpan: (name: string, opts: unknown) => {
      startSpan(name, opts);
      return mockSpan;
    },
  }),
}));

const { startEventBusOtelBridge } = await import("../services/event-bus-otel-bridge.js");

beforeEach(() => {
  _resetSubscribersForTests();
  startSpan.mockClear();
  setStatus.mockClear();
  recordException.mockClear();
  end.mockClear();
  addEvent.mockClear();
});

describe("event-bus → OTel bridge", () => {
  it("emits one span per event under its declared name (the sponsor and kind are attributes, keyed)", () => {
    startEventBusOtelBridge();
    emit({ kind: "discover.start", sponsor: "pcc", text: "scanning" });
    expect(startSpan).toHaveBeenCalledOnce();
    expect(startSpan.mock.calls[0]?.[0]).toBe("event-bus.event");
    expect(end).toHaveBeenCalledOnce();
  });

  it("attaches event metadata as span attributes, each as the closed schema declares it", () => {
    startEventBusOtelBridge();
    emit({
      kind: "build.done",
      sponsor: "navi",
      text: "ok",
      session_id: "sess-abc",
      level: "ok",
      duration_ms: 145,
    });
    const opts = startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> };
    // An emitter's values leave keyed; the level is the bus's vocabulary; t is the bus's clock.
    expect(opts.attributes["event.kind"]).toBe(keyedHash("build.done"));
    expect(opts.attributes["event.sponsor"]).toBe(keyedHash("navi"));
    expect(opts.attributes["event.session_id"]).toBe(keyedHash("sess-abc"));
    expect(opts.attributes["event.level"]).toBe("ok");
    expect(opts.attributes["event.duration_ms"]).toBe(keyedHash(145));
    expect(opts.attributes["event.text"]).toBe(keyedHash("ok"));
    expect(opts.attributes["event.t"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it("flags level=err events with ERROR status and a declared exception event", () => {
    startEventBusOtelBridge();
    emit({ kind: "scrape.fail", sponsor: "navi", text: "timeout reached", level: "err" });
    expect(setStatus).toHaveBeenCalledOnce();
    // The status is its code alone; the exception event carries the text keyed.
    expect(setStatus.mock.calls[0]?.[0]).toEqual({ code: 2 });
    expect(addEvent).toHaveBeenCalledOnce();
    expect(addEvent.mock.calls[0]).toEqual([
      "exception",
      { "exception.type": "EventBusError", "exception.message": keyedHash("timeout reached") },
    ]);
    expect(recordException).not.toHaveBeenCalled();
  });

  it("non-err levels do NOT call setStatus", () => {
    startEventBusOtelBridge();
    emit({ kind: "x", sponsor: "navi", text: "fine", level: "ok" });
    emit({ kind: "y", sponsor: "navi", text: "fine", level: "info" });
    emit({ kind: "z", sponsor: "navi", text: "warn but not err", level: "warn" });
    expect(setStatus).not.toHaveBeenCalled();
    expect(recordException).not.toHaveBeenCalled();
    expect(addEvent).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further span creation", () => {
    const off = startEventBusOtelBridge();
    emit({ kind: "before", sponsor: "navi", text: "x" });
    off();
    emit({ kind: "after", sponsor: "navi", text: "y" });
    expect(startSpan).toHaveBeenCalledOnce();
    const opts = startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> };
    expect(opts.attributes["event.kind"]).toBe(keyedHash("before"));
  });

  it("passes no time to the span: the tracing SDK's clock times it (N107b round 4, C11)", () => {
    startEventBusOtelBridge();
    emit({ kind: "build.done", sponsor: "navi", text: "ok", level: "ok", duration_ms: 8675309 });
    const opts = startSpan.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty("startTime");
    expect(end).toHaveBeenCalledWith();
  });

  it("a long text leaves as its keyed hash, of fixed length", () => {
    startEventBusOtelBridge();
    const longText = "a".repeat(2000);
    emit({ kind: "x", sponsor: "navi", text: longText });
    const opts = startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> };
    const attr = opts.attributes["event.text"] as string;
    expect(attr).toBe(keyedHash(longText));
    expect(attr.length).toBeLessThanOrEqual(1024);
  });
});
