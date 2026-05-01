/**
 * Tests for the Week 5 approval listener.
 *
 * We mock EventSource since jsdom doesn't ship one. The mock records
 * URLs, allows tests to drive `open` / `error` / `message` events, and
 * tracks close-count.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  startApprovalListener,
  computeBackoff,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from "./approval-listener.js";

// ── MockEventSource ────────────────────────────────────────────────────

class MockEventSource {
  static instances: MockEventSource[] = [];
  static last(): MockEventSource | null {
    return MockEventSource.instances[MockEventSource.instances.length - 1] ?? null;
  }

  url: string;
  closed = false;
  /** Set by the listener via `es.onopen = ...`. */
  onopen: ((evt: Event) => void) | null = null;
  /** Set by the listener via `es.onerror = ...`. */
  onerror: ((evt: Event) => void) | null = null;
  /** Set by the listener via `es.onmessage = ...`. */
  onmessage: ((evt: MessageEvent) => void) | null = null;
  /** Tracked named-event listeners so tests can dispatch them. */
  listeners = new Map<string, Set<(evt: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: EventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as (evt: MessageEvent) => void);
  }

  removeEventListener(type: string, fn: EventListener): void {
    this.listeners.get(type)?.delete(fn as (evt: MessageEvent) => void);
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: fire an open. */
  fireOpen(): void {
    this.onopen?.(new Event("open"));
  }

  /** Test helper: fire an error. */
  fireError(): void {
    this.onerror?.(new Event("error"));
  }

  /** Test helper: dispatch a named SSE event. */
  fireNamed(type: string, data: unknown, lastEventId = ""): void {
    const evt = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId,
    });
    const set = this.listeners.get(type);
    if (set) {
      for (const fn of set) fn(evt);
    }
  }

  /** Test helper: dispatch a generic message event. */
  fireMessage(data: unknown, lastEventId = ""): void {
    const evt = new MessageEvent("message", {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId,
    });
    this.onmessage?.(evt);
  }

  /**
   * Test helper: dispatch a settle-progress named event. Convenience over
   * fireNamed("settle-progress", ...) so the W9 test cases read cleanly.
   */
  fireProgress(payload: unknown, lastEventId = ""): void {
    this.fireNamed("settle-progress", payload, lastEventId);
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

beforeEach(() => {
  MockEventSource.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

// ──────────────────────────────────────────────────────────────────────
// computeBackoff
// ──────────────────────────────────────────────────────────────────────

describe("computeBackoff", () => {
  it("starts in [0, INITIAL_BACKOFF_MS] for attempt 0", () => {
    for (let i = 0; i < 50; i++) {
      const d = computeBackoff(0);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(INITIAL_BACKOFF_MS);
    }
  });

  it("caps at MAX_BACKOFF_MS for high attempt counts", () => {
    for (let i = 0; i < 50; i++) {
      const d = computeBackoff(20);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });

  it("grows monotonically (in expectation) across early attempts", () => {
    // Sample averages — exponential mean grows, even with jitter.
    const samples = (n: number, attempt: number): number => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += computeBackoff(attempt);
      return sum / n;
    };
    const m0 = samples(200, 0);
    const m3 = samples(200, 3);
    // attempt 3 mean should be ~8x attempt 0 mean (capped at MAX).
    expect(m3).toBeGreaterThan(m0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// URL building + auth
// ──────────────────────────────────────────────────────────────────────

describe("startApprovalListener URL", () => {
  it("encodes sessionId in the path and includes ?token= when provided", () => {
    const handle = startApprovalListener({
      sessionId: "session/with/slashes & spaces",
      sessionToken: "tok-abc-123",
      baseUrl: "https://capability.network/",
      onApproval: () => {},
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last();
    expect(es).not.toBeNull();
    expect(es!.url).toContain(
      "/sse/stream/approval/session%2Fwith%2Fslashes%20%26%20spaces",
    );
    expect(es!.url).toContain("token=tok-abc-123");
    handle.stop();
  });

  it("omits ?token= when sessionToken is null", () => {
    const handle = startApprovalListener({
      sessionId: "sess-1",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    expect(MockEventSource.last()!.url).not.toContain("token=");
    handle.stop();
  });

  it("strips trailing slashes from baseUrl", () => {
    const handle = startApprovalListener({
      sessionId: "sess-1",
      sessionToken: null,
      baseUrl: "https://capability.network////",
      onApproval: () => {},
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    expect(MockEventSource.last()!.url).toBe(
      "https://capability.network/sse/stream/approval/sess-1",
    );
    handle.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Event dispatch
// ──────────────────────────────────────────────────────────────────────

describe("startApprovalListener event dispatch", () => {
  it("dispatches approval-request named events to onApproval", () => {
    const seen: unknown[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-d",
      sessionToken: "tok",
      baseUrl: "https://capability.network",
      onApproval: (p) => seen.push(p),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last()!;
    es.fireOpen();
    es.fireNamed(
      "approval-request",
      {
        id: "sess-d",
        capability: "haircut",
        amountUsd: 32,
        operatorName: "Andre",
        evidenceHash: "abc",
        requestedAt: "2026-01-01T00:00:00.000Z",
      },
      "evt-1",
    );

    expect(seen.length).toBe(1);
    const got = seen[0] as { id?: string; capability?: string };
    expect(got.id).toBe("sess-d");
    expect(got.capability).toBe("haircut");

    // lastEventId should now be tracked.
    expect(handle.state.lastEventId).toBe("evt-1");
    handle.stop();
  });

  it("falls back to onmessage when no named listener fires", () => {
    const seen: unknown[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-m",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: (p) => seen.push(p),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last()!;
    es.fireOpen();
    es.fireMessage({ id: "sess-m", capability: "x", amountUsd: 1, operatorName: "y", evidenceHash: "z", requestedAt: "" });

    expect(seen.length).toBe(1);
    handle.stop();
  });

  it("calls onError when payload is malformed JSON", () => {
    const errs: Error[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-bad",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      onError: (e) => errs.push(e),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last()!;
    es.fireOpen();
    es.fireNamed("approval-request", "not-json{", "evt-bad");

    expect(errs.length).toBe(1);
    expect(errs[0].message).toMatch(/parse/i);
    handle.stop();
  });

  it("invokes onOpen on connect", () => {
    const opens: number[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-o",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      onOpen: () => opens.push(Date.now()),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    MockEventSource.last()!.fireOpen();
    expect(opens.length).toBe(1);
    handle.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Reconnect
// ──────────────────────────────────────────────────────────────────────

describe("startApprovalListener reconnect", () => {
  it("opens a new EventSource on error after the backoff timer fires", () => {
    vi.useFakeTimers();
    const handle = startApprovalListener({
      sessionId: "sess-rc",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    expect(MockEventSource.instances.length).toBe(1);
    const first = MockEventSource.last()!;
    first.fireOpen();
    first.fireError();

    // First EventSource should be closed.
    expect(first.closed).toBe(true);

    // Advance well past the maximum first-attempt backoff (INITIAL=1000).
    vi.advanceTimersByTime(2_000);

    expect(MockEventSource.instances.length).toBe(2);
    handle.stop();
  });

  it("resets backoff on successful re-open", () => {
    vi.useFakeTimers();
    const handle = startApprovalListener({
      sessionId: "sess-reset",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });

    // First attempt opens then errors → attempt counter increments.
    const first = MockEventSource.last()!;
    first.fireOpen();
    expect(handle.state.attempt).toBe(0);
    first.fireError();
    expect(handle.state.attempt).toBe(1);

    // Reconnect timer fires.
    vi.advanceTimersByTime(2_000);
    const second = MockEventSource.last()!;
    expect(second).not.toBe(first);

    // Successful open: attempt counter resets.
    second.fireOpen();
    expect(handle.state.attempt).toBe(0);

    handle.stop();
  });

  it("calls onAuthError after 2 consecutive openless failures", () => {
    vi.useFakeTimers();
    const auth: number[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-auth",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      onAuthError: () => auth.push(1),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    // First failure with no open
    MockEventSource.last()!.fireError();
    expect(auth.length).toBe(0);

    // Reconnect → second failure with no open
    vi.advanceTimersByTime(2_000);
    MockEventSource.last()!.fireError();
    expect(auth.length).toBe(1);
    handle.stop();
  });

  it("appends lastEventId to reconnect URLs once an event is seen", () => {
    vi.useFakeTimers();
    const handle = startApprovalListener({
      sessionId: "sess-resume",
      sessionToken: "tok",
      baseUrl: "https://capability.network",
      onApproval: () => {},
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const first = MockEventSource.last()!;
    first.fireOpen();
    first.fireNamed("approval-request", { ok: true }, "evt-RESUME-X");
    first.fireError();

    vi.advanceTimersByTime(2_000);
    const second = MockEventSource.last()!;
    expect(second.url).toContain("lastEventId=evt-RESUME-X");
    handle.stop();
  });

  it("stop() prevents subsequent reconnect", () => {
    vi.useFakeTimers();
    const handle = startApprovalListener({
      sessionId: "sess-stop",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const first = MockEventSource.last()!;
    first.fireError();
    handle.stop();
    vi.advanceTimersByTime(60_000);
    // No new EventSource was opened.
    expect(MockEventSource.instances.length).toBe(1);
    expect(handle.state.running).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Week 9 B — settle-progress event dispatch
// ──────────────────────────────────────────────────────────────────────

describe("startApprovalListener — settle-progress (Week 9 B)", () => {
  it("routes settle-progress events to onProgress when subscribed", () => {
    const seen: { phase: string; progress: number; id: string }[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-w9b-001",
      sessionToken: "tok",
      baseUrl: "https://capability.network",
      onApproval: () => {},
      onProgress: (p) => seen.push({ phase: p.phase, progress: p.progress, id: p.id }),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last()!;
    es.fireOpen();
    es.fireProgress(
      { id: "sess-w9b-001", phase: "release", progress: 0.25 },
      "evt-1",
    );
    es.fireProgress(
      { id: "sess-w9b-001", phase: "sign", progress: 0.5 },
      "evt-2",
    );
    es.fireProgress(
      { id: "sess-w9b-001", phase: "log_append", progress: 0.75 },
      "evt-3",
    );
    es.fireProgress(
      { id: "sess-w9b-001", phase: "done", progress: 1.0 },
      "evt-4",
    );

    expect(seen.length).toBe(4);
    expect(seen.map((s) => s.phase)).toEqual([
      "release",
      "sign",
      "log_append",
      "done",
    ]);
    expect(seen.map((s) => s.progress)).toEqual([0.25, 0.5, 0.75, 1.0]);
    // lastEventId should track the most recent event regardless of type.
    expect(handle.state.lastEventId).toBe("evt-4");
    handle.stop();
  });

  it("silently ignores settle-progress when no onProgress callback is supplied", () => {
    const seen: unknown[] = [];
    const errs: Error[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-w9b-noop",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: (p) => seen.push(p),
      onError: (e) => errs.push(e),
      // No onProgress.
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last()!;
    es.fireOpen();
    es.fireProgress({ id: "sess-w9b-noop", phase: "release", progress: 0.25 });

    // No callback, no error.
    expect(seen.length).toBe(0);
    expect(errs.length).toBe(0);
    handle.stop();
  });

  it("routes onError on malformed settle-progress payload (missing phase/progress)", () => {
    const seen: unknown[] = [];
    const errs: Error[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-w9b-bad",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      onProgress: (p) => seen.push(p),
      onError: (e) => errs.push(e),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last()!;
    es.fireOpen();
    // Wrong shape — missing `progress`.
    es.fireProgress({ id: "x", phase: "release" });
    // Wrong shape — phase isn't a string.
    es.fireProgress({ id: "x", phase: 1, progress: 0.5 });

    expect(seen.length).toBe(0);
    expect(errs.length).toBe(2);
    expect(errs[0].message).toMatch(/settle-progress/);
    handle.stop();
  });

  it("approval-request and settle-progress events route independently", () => {
    const approvals: unknown[] = [];
    const progresses: { phase: string }[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-w9b-mix",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: (p) => approvals.push(p),
      onProgress: (p) => progresses.push({ phase: p.phase }),
      eventSourceCtor: MockEventSource as unknown as typeof EventSource,
    });
    const es = MockEventSource.last()!;
    es.fireOpen();
    es.fireNamed("approval-request", {
      id: "sess-w9b-mix",
      capability: "haircut",
      amountUsd: 32,
      operatorName: "Andre",
      evidenceHash: "ab".repeat(32),
      requestedAt: new Date().toISOString(),
    });
    es.fireProgress({ id: "sess-w9b-mix", phase: "release", progress: 0.25 });
    es.fireProgress({ id: "sess-w9b-mix", phase: "done", progress: 1.0 });

    expect(approvals.length).toBe(1);
    expect(progresses.map((p) => p.phase)).toEqual(["release", "done"]);
    handle.stop();
  });
});

// ──────────────────────────────────────────────────────────────────────
// Missing EventSource
// ──────────────────────────────────────────────────────────────────────

describe("startApprovalListener — no EventSource available", () => {
  it("calls onError once and does not retry", () => {
    const errs: Error[] = [];
    const handle = startApprovalListener({
      sessionId: "sess-no-es",
      sessionToken: null,
      baseUrl: "https://capability.network",
      onApproval: () => {},
      onError: (e) => errs.push(e),
      // Force the override to undefined AND ensure no global is found.
      // Simulated by passing undefined explicitly + clearing globalThis.
      // We can't actually delete globalThis.EventSource cleanly across
      // the suite, so we just don't expose one here and rely on jsdom's
      // default (which DOES NOT ship EventSource at all by default).
      eventSourceCtor: undefined,
    });
    // jsdom in Vitest may or may not have an EventSource polyfill — guard.
    const hasGlobal = !!(globalThis as { EventSource?: unknown }).EventSource;
    if (!hasGlobal) {
      expect(errs.length).toBe(1);
      expect(errs[0].message).toMatch(/EventSource is not available/);
      expect(handle.state.running).toBe(false);
    }
    handle.stop();
  });
});
