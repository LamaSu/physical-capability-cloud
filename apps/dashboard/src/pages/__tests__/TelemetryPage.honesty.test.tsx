/**
 * Pipeline Telemetry shows the gateway's telemetry or says it couldn't; never samples.
 *
 * Renders the real page with real react-query; only `fetch` and `EventSource`
 * are replaced. Before this change the page:
 *   - showed a generated nine-phase timeline for "job-demo" whenever the
 *     selected pipeline had no events, even with the gateway healthy;
 *   - showed twenty sample log lines while the log read was loading or had failed;
 *   - turned an HTTP error into zero counts and empty lists ("No active jobs",
 *     "0" events), under a "Gateway offline — showing mock telemetry data" banner
 *     that appeared only on network errors.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { TelemetryPage } from "../TelemetryPage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;

function stubFetch(routes: Routes, fallback: Reply = "network-error") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
    const reply = routes[path] ?? fallback;
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: reply.status === 200 ? "OK" : "Error",
      headers: { get: () => null },
      json: async () => reply.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── EventSource stub (jsdom has none) ───────────────────────────────────────

type StreamMode = "fail" | "open" | "silent";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static mode: StreamMode = "fail";

  readonly url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  private listeners = new Map<string, Array<(ev: MessageEvent) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
    if (FakeEventSource.mode === "fail") setTimeout(() => this.fail(), 0);
    if (FakeEventSource.mode === "open") setTimeout(() => this.open(), 0);
  }

  addEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }

  removeEventListener(type: string, cb: (ev: MessageEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== cb));
  }

  close() {
    this.readyState = 2;
  }

  open() {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.onopen?.(new Event("open"));
    this.emit("connected", { type: "connected" });
  }

  fail() {
    if (this.readyState === 2) return;
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }

  emit(type: string, data: unknown) {
    if (this.readyState === 2) return;
    for (const cb of this.listeners.get(type) ?? []) cb(new MessageEvent(type, { data: JSON.stringify(data) }));
  }
}

/** An element whose whole text is `label`: the stream indicators ("Live", "Streaming"). */
function hasIndicator(label: string): boolean {
  return [...container.querySelectorAll("span")].some((el) => el.textContent === label);
}

function telemetryStream(): FakeEventSource {
  const es = FakeEventSource.instances.find((i) => i.url.includes("/api/telemetry/logs/stream"));
  if (!es) throw new Error("the page opened no telemetry stream");
  return es;
}

// ── fixtures the page used to show, and gateway answers ─────────────────────

/** Distinctive values from the old in-page fixtures (now src/demo/TelemetryPage.fixtures.ts). */
const OLD_FIXTURE_VALUES = [
  "Quote request dispatched to 3 kernels",
  "Bittensor verification result received",
  "job-demo",
  "job-001",
  // The old generated timeline's rows carried the source label "mock" (they never showed
  // their job id), and the old banner read "showing mock telemetry data".
  "mock",
];

function expectNoFixtures(text: string) {
  for (const value of OLD_FIXTURE_VALUES) expect(text).not.toContain(value);
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** What the gateway serves after a negotiation, a job submit and an escrow fund (routes/telemetry.ts). */
const LIVE: Routes = {
  "/api/telemetry/active": {
    status: 200,
    body: {
      active: [{ jobId: "job-live-7", currentPhase: "escrow_fund", startedAt: iso(90_000), eventCount: 3, lastUpdated: iso(10_000) }],
      count: 1,
    },
  },
  "/api/telemetry/stats": {
    status: 200,
    body: {
      stats: {
        totalJobs: 4,
        activeJobs: 1,
        avgDuration_ms: 2400,
        successRate: 0.5,
        totalEvents: 42,
        byPhase: { escrow_fund: { total: 2, failed: 1 } },
        eventsPerMinute: 3.5,
      },
      phases: [],
    },
  },
  "/api/telemetry/pipeline/job-live-7": {
    status: 200,
    body: {
      jobId: "job-live-7",
      timeline: [
        { id: "e1", jobId: "job-live-7", timestamp: iso(90_000), phase: "negotiation", status: "started", metadata: { kernelId: "kernel-a" }, level: "info", source: "gateway" },
        { id: "e2", jobId: "job-live-7", timestamp: iso(60_000), phase: "job_submit", status: "completed", duration_ms: 118, metadata: {}, level: "info", source: "gateway" },
        { id: "e3", jobId: "job-live-7", timestamp: iso(10_000), phase: "escrow_fund", status: "completed", metadata: { escrow: "0xE5C0" }, level: "info", source: "gateway" },
      ],
      phases: [],
    },
  },
  "/api/telemetry/logs": {
    status: 200,
    body: {
      entries: [
        { id: "log_a1", timestamp: iso(10_000), level: "info", message: "Telemetry event emitted: escrow_fund → completed", source: "api", jobId: "job-live-7" },
      ],
      total: 1,
      sources: ["api"],
    },
  },
};

const EMPTY: Routes = {
  "/api/telemetry/active": { status: 200, body: { active: [], count: 0 } },
  "/api/telemetry/stats": {
    status: 200,
    body: {
      stats: { totalJobs: 0, activeJobs: 0, avgDuration_ms: 0, successRate: 0, totalEvents: 0, byPhase: {}, eventsPerMinute: 0 },
      phases: [],
    },
  },
  "/api/telemetry/logs": { status: 200, body: { entries: [], total: 0, sources: [] } },
};

const DENIED: Reply = {
  status: 401,
  body: { error: "api_key_required", message: "This endpoint requires authentication." },
};

// ── render harness ───────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  FakeEventSource.instances = [];
  FakeEventSource.mode = "fail";
  vi.stubGlobal("EventSource", FakeEventSource);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

async function settle(client: QueryClient) {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    if (i >= 2 && client.isFetching() === 0) break;
  }
}

async function renderPage(): Promise<{ client: QueryClient; text: () => string }> {
  const client = new QueryClient({
    // Retry immediately so a failure settles fast.
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TelemetryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return { client, text: () => container.textContent ?? "" };
}

// ── (a) gateway unreachable ──────────────────────────────────────────────────

describe("gateway unreachable", () => {
  it("says each read is unavailable and shows no sample timeline, logs or zero counts", async () => {
    stubFetch({});
    const { text } = await renderPage();
    const t = text();
    expect(t).toContain("Couldn't load pipeline stats");
    expect(t).toContain("Couldn't load recent pipelines");
    expect(t).toContain("Couldn't load logs");
    expectNoFixtures(t);
    expect(t).not.toContain("Total Events");
    expect(t).not.toMatch(/No log entries|No pipeline activity|No active jobs/);
  });

  it("an HTTP error (401) is unavailable with the server's reason, not an empty result", async () => {
    stubFetch({
      "/api/telemetry/active": DENIED,
      "/api/telemetry/stats": DENIED,
      "/api/telemetry/logs": DENIED,
    });
    const { text } = await renderPage();
    const t = text();
    expect(t).toContain("Couldn't load pipeline stats");
    expect(t).toContain("This endpoint requires authentication.");
    expectNoFixtures(t);
    expect(t).not.toContain("Total Events");
    expect(t).not.toMatch(/No log entries|No pipeline activity|No active jobs/);
  });

  it("a 2xx answer without stats is unavailable, not a row of zeros", async () => {
    stubFetch({ ...EMPTY, "/api/telemetry/stats": { status: 200, body: { stats: { totalEvents: 3 } } } });
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load pipeline stats");
    expect(t).not.toContain("Total Events");
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("demo mode (?demo=1)", () => {
  it("shows the sample telemetry under the demo banner and calls no gateway route", async () => {
    window.history.replaceState(null, "", "/telemetry?demo=1");
    const fetchMock = stubFetch({});
    const t = (await renderPage()).text();
    expect(t).toContain("Demo data");
    expect(t).toContain("Pipeline telemetry: sample values, not live PCC state.");
    expect(t).toContain("job-demo");
    expect(t).toContain("Quote request dispatched to 3 kernels");
    expect(t).toContain("Bittensor verification result received: quality=0.92");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

// ── (c) live data ────────────────────────────────────────────────────────────

describe("gateway answering", () => {
  it("renders what the routes return", async () => {
    const fetchMock = stubFetch(LIVE);
    const t = (await renderPage()).text();
    // stats
    expect(t).toContain("42");
    expect(t).toContain("avg 3.5 per minute with events");
    expect(t).toContain("4 tracked");
    expect(t).toContain("2.4s");
    expect(t).toContain("50%");
    // recent pipelines, auto-selected, and its timeline
    expect(t).toContain("job-live-7");
    expect(t).toContain("3 events");
    expect(t).toContain("Negotiate");
    expect(t).toContain("118ms");
    expect(t).toContain('{"escrow":"0xE5C0"}');
    // logs
    expect(t).toContain("Telemetry event emitted: escrow_fund → completed");
    expect(t).toContain("1 entries");
    expect(t).not.toContain("Couldn't load");
    expectNoFixtures(t);
    // The page only reads.
    for (const [, init] of fetchMock.mock.calls) expect(init?.method ?? "GET").toBe("GET");
  });

  it("an empty gateway shows real empty states, not a sample timeline or an invented success rate", async () => {
    stubFetch(EMPTY);
    const t = (await renderPage()).text();
    // The old page drew the generated "job-demo" timeline whenever no pipeline had events.
    expectNoFixtures(t);
    expect(t).toContain("No pipeline activity in the last hour");
    expect(t).toContain("No pipeline selected.");
    expect(t).toContain("No log entries recorded yet.");
    expect(t).toMatch(/Success Rate—/);
    expect(t).not.toContain("0%");
    expect(t).not.toContain("Couldn't load");
  });

  it("a failed refresh keeps the earlier data and marks it stale", async () => {
    stubFetch(LIVE);
    const { client, text } = await renderPage();
    expect(text()).toContain("42");

    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = text();
    expect(t).toContain("Couldn't refresh pipeline stats");
    expect(t).toContain("Couldn't refresh logs");
    expect(t).toContain("42");
    expect(t).toContain("Telemetry event emitted: escrow_fund → completed");
    expectNoFixtures(t);
  });

  it("says Live and Streaming only while the stream is connected", async () => {
    FakeEventSource.mode = "open";
    stubFetch(LIVE);
    const { text } = await renderPage();

    const es = telemetryStream();
    await act(async () => {
      es.emit("telemetry_event", {
        id: "e4", jobId: "job-live-7", timestamp: iso(1_000), phase: "verification_request",
        status: "started", metadata: { round: 2 }, level: "info", source: "gateway",
      });
      es.emit("log_entry", {
        id: "log_a2", timestamp: iso(1_000), level: "warn", message: "Telemetry event emitted: verification_request → started", source: "api",
      });
    });
    expect(text()).toContain('{"round":2}');
    expect(text()).toContain("Telemetry event emitted: verification_request → started");
    expect(hasIndicator("Live")).toBe(true);
    expect(hasIndicator("Streaming")).toBe(true);

    // The stream drops: the polled data stays, the live claims go.
    await act(async () => {
      es.fail();
    });
    expect(hasIndicator("Live")).toBe(false);
    expect(hasIndicator("Streaming")).toBe(false);
    expect(text()).toContain("job-live-7");
  });
});
