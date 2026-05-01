/**
 * Wave 4.4 — tests for the event-bus → OTel bridge. The OTel SDK itself
 * runs in NOOP mode in tests (no exporter wired), so we mock the tracer
 * factory and assert on span lifecycle semantics rather than on exporter
 * output.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { emit, _resetSubscribersForTests } from "@pcc/orchestrator-sdk";

const startSpan = vi.fn();
const setStatus = vi.fn();
const recordException = vi.fn();
const end = vi.fn();
const setAttribute = vi.fn();

const mockSpan = { setStatus, recordException, end, setAttribute };

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
});

describe("event-bus → OTel bridge", () => {
  it("emits one span per event with sponsor.kind name", () => {
    startEventBusOtelBridge();
    emit({ kind: "discover.start", sponsor: "pcc", text: "scanning" });
    expect(startSpan).toHaveBeenCalledOnce();
    expect(startSpan.mock.calls[0]?.[0]).toBe("pcc.discover.start");
    expect(end).toHaveBeenCalledOnce();
  });

  it("attaches event metadata as span attributes", () => {
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
    expect(opts.attributes["event.kind"]).toBe("build.done");
    expect(opts.attributes["event.sponsor"]).toBe("navi");
    expect(opts.attributes["event.session_id"]).toBe("sess-abc");
    expect(opts.attributes["event.level"]).toBe("ok");
    expect(opts.attributes["event.duration_ms"]).toBe(145);
    expect(opts.attributes["event.text"]).toBe("ok");
  });

  it("flags level=err events with ERROR status + recordException", () => {
    startEventBusOtelBridge();
    emit({ kind: "scrape.fail", sponsor: "navi", text: "timeout reached", level: "err" });
    expect(setStatus).toHaveBeenCalledOnce();
    const status = setStatus.mock.calls[0]?.[0] as { code: number; message: string };
    expect(status.code).toBe(2);
    expect(status.message).toBe("timeout reached");
    expect(recordException).toHaveBeenCalledOnce();
  });

  it("non-err levels do NOT call setStatus", () => {
    startEventBusOtelBridge();
    emit({ kind: "x", sponsor: "navi", text: "fine", level: "ok" });
    emit({ kind: "y", sponsor: "navi", text: "fine", level: "info" });
    emit({ kind: "z", sponsor: "navi", text: "warn but not err", level: "warn" });
    expect(setStatus).not.toHaveBeenCalled();
    expect(recordException).not.toHaveBeenCalled();
  });

  it("unsubscribe stops further span creation", () => {
    const off = startEventBusOtelBridge();
    emit({ kind: "before", sponsor: "navi", text: "x" });
    off();
    emit({ kind: "after", sponsor: "navi", text: "y" });
    expect(startSpan).toHaveBeenCalledOnce();
    expect(startSpan.mock.calls[0]?.[0]).toBe("navi.before");
  });

  it("truncates long text attributes at 1024 chars", () => {
    startEventBusOtelBridge();
    const longText = "a".repeat(2000);
    emit({ kind: "x", sponsor: "navi", text: longText });
    const opts = startSpan.mock.calls[0]?.[1] as { attributes: Record<string, unknown> };
    const attr = opts.attributes["event.text"] as string;
    expect(attr.length).toBeLessThanOrEqual(1024);
    expect(attr.endsWith("...")).toBe(true);
  });
});
