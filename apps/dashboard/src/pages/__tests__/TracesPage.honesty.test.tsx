/**
 * The Trace Explorer shows the gateway's traces or says it couldn't; never samples.
 *
 * Renders the real page with real react-query; only `fetch` and `EventSource`
 * are replaced. Before this change the page read only the SSE stream
 * /api/traces/stream and, whenever the stream errored, replaced the list with
 * three sample traces labelled "mock data (gateway offline)". EventSource
 * cannot send the Authorization header, so for a viewer signed in with an API
 * key the stream always errored and the page showed sample traces while the
 * gateway was up. It never read GET /api/traces.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { TracesPage } from "../TracesPage.js";

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

function traceStream(): FakeEventSource {
  const open = FakeEventSource.instances.filter((i) => i.url.includes("/api/traces/stream") && i.readyState !== 2);
  const es = open[open.length - 1];
  if (!es) throw new Error("the page has no open trace stream");
  return es;
}

// ── fixtures the page used to show, and gateway answers ─────────────────────

/** Distinctive values from the old in-page sample traces (now src/demo/TracesPage.fixtures.ts). */
const OLD_FIXTURE_VALUES = ["trace-ab", "trace-de", "trace-gh", "job.load_gcode", "mock data"];

function expectNoFixtures(text: string) {
  for (const value of OLD_FIXTURE_VALUES) expect(text).not.toContain(value);
}

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  service: string;
  status: "ok" | "error" | "in_progress";
  startTime: number;
  endTime?: number;
  duration_ms?: number;
  attributes: Record<string, string | number | boolean>;
  children: Span[];
};

function span(traceId: string, spanId: string, operation: string, service: string, start: number, dur: number | undefined, parentSpanId?: string, attributes: Span["attributes"] = {}): Span {
  return {
    traceId, spanId, parentSpanId, operation, service,
    status: dur === undefined ? "in_progress" : "ok",
    startTime: start,
    endTime: dur === undefined ? undefined : start + dur,
    duration_ms: dur,
    attributes,
    children: [],
  };
}

/** The shape trace-collector.ts buildTree() serves: children linked, spans flat. */
function trace(root: Span, children: Span[] = []) {
  root.children = children;
  const spans = [root, ...children];
  const done = spans.every((s) => s.endTime !== undefined);
  const endTime = done ? Math.max(...spans.map((s) => s.endTime!)) : undefined;
  return {
    traceId: root.traceId,
    rootSpan: root,
    spans,
    startTime: root.startTime,
    endTime,
    duration_ms: endTime === undefined ? undefined : endTime - root.startTime,
    status: done ? "ok" : "in_progress",
  };
}

const T_SETTLE = Date.now() - 20_000;
const SETTLE_ID = "4f1c9a2be0d34c7a9b8e112233445566";
/** A settlement pipeline, as settlement-service.ts records it. */
const SETTLEMENT_TRACE = trace(
  span(SETTLE_ID, "a1b2c3d4e5f60718", "settlement.pipeline", "settlement", T_SETTLE, 1310, undefined, {
    "job.id": "job-7f3e", "bundle.id": "bundle-91ac", "bundle.assurance_tier": 1,
  }),
  [
    span(SETTLE_ID, "b1b2c3d4e5f60718", "settlement.ipfs_archive", "storage", T_SETTLE + 5, 640, "a1b2c3d4e5f60718"),
    span(SETTLE_ID, "c1b2c3d4e5f60718", "settlement.db_persist", "db", T_SETTLE + 650, 62, "a1b2c3d4e5f60718"),
    span(SETTLE_ID, "d1b2c3d4e5f60718", "settlement.onchain_submit", "blockchain", T_SETTLE + 715, 585, "a1b2c3d4e5f60718"),
  ],
);

const KERNEL_ID = "9d8c7b6a5f4e3d2c1b0a998877665544";
/** A kernel job still running, as kernel-service.ts records it (a root span only). */
const KERNEL_TRACE = trace(
  span(KERNEL_ID, "c0ffee0011223344", "job.lifecycle", "kernel", Date.now() - 60_000, undefined, undefined, {
    "job.id": "job-81d2", "job.type": "fdm-print", "job.assurance_tier": 1,
  }),
);

const LIVE: Routes = {
  "/api/traces": { status: 200, body: { traces: [SETTLEMENT_TRACE, KERNEL_TRACE], total: 2 } },
};

const EMPTY: Routes = {
  "/api/traces": { status: 200, body: { traces: [], total: 0 } },
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

/** An element whose whole text is `label` (the stream status). */
function hasIndicator(label: string): boolean {
  return [...container.querySelectorAll("span")].some((el) => el.textContent === label);
}

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
          <TracesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return { client, text: () => container.textContent ?? "" };
}

// ── (a) gateway unreachable ──────────────────────────────────────────────────

describe("gateway unreachable", () => {
  it("says traces are unavailable and shows no sample traces", async () => {
    stubFetch({});
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load traces");
    expectNoFixtures(t);
    expect(t).not.toContain("No traces recorded yet");
    expect(hasIndicator("live")).toBe(false);
  });

  it("an HTTP error (401) is unavailable with the server's reason", async () => {
    stubFetch({
      "/api/traces": { status: 401, body: { error: "api_key_required", message: "This endpoint requires authentication." } },
    });
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load traces");
    expect(t).toContain("This endpoint requires authentication.");
    expectNoFixtures(t);
    expect(t).not.toContain("No traces recorded yet");
  });

  it("a 2xx answer without a trace list is unavailable, not empty", async () => {
    stubFetch({ "/api/traces": { status: 200, body: { total: 3 } } });
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load traces");
    expect(t).not.toContain("No traces recorded yet");
  });

  it("a list holding something that isn't a trace is unavailable, not a crash", async () => {
    stubFetch({ "/api/traces": { status: 200, body: { traces: [SETTLEMENT_TRACE, { traceId: "half-a-trace" }], total: 2 } } });
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load traces");
    expect(t).not.toContain("half-a-t");
  });

  it("a streamed trace does not stand in for a failed read", async () => {
    FakeEventSource.mode = "open";
    stubFetch({});
    const { client, text } = await renderPage();
    await act(async () => {
      traceStream().emit("trace_update", SETTLEMENT_TRACE);
    });
    await settle(client);
    const t = text();
    expect(t).toContain("Couldn't load traces");
    expect(t).not.toContain("settlement.pipeline");
    expectNoFixtures(t);
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("demo mode (?demo=1)", () => {
  it("shows the sample traces under the demo banner and calls no gateway route", async () => {
    window.history.replaceState(null, "", "/traces?demo=1");
    const fetchMock = stubFetch({});
    const t = (await renderPage()).text();
    expect(t).toContain("Demo data");
    expect(t).toContain("Trace explorer: sample values, not live PCC state.");
    expect(t).toContain("trace-ab");
    expect(t).toContain("job.lifecycle");
    // The sample trace's child spans draw in the waterfall.
    expect(t).toContain("job.load_gcode");
    expect(t).toContain("settlement.onchain_submit");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});

// ── (c) live data ────────────────────────────────────────────────────────────

describe("gateway answering", () => {
  it("renders the traces GET /api/traces returns", async () => {
    FakeEventSource.mode = "silent";
    const fetchMock = stubFetch(LIVE);
    const t = (await renderPage()).text();
    expect(t).toContain("4f1c9a2b…");
    expect(t).toContain("9d8c7b6a…");
    expect(t).toContain("settlement.pipeline");
    expect(t).toContain("job.lifecycle");
    // The most recent trace is selected and its child spans draw in the waterfall.
    expect(t).toContain("settlement.db_persist");
    expect(t).toContain("settlement.onchain_submit");
    expect(t).toContain("4 spans");
    expect(t).toContain("1.3s");
    expect(t).toContain("1Active");
    expect(t).toContain("1Completed");
    expect(t).toContain("0Errors");
    expect(t).toContain("Across the 2 most recent traces the gateway holds in memory.");
    expect(hasIndicator("refreshing every 5s")).toBe(true);
    expect(t).not.toContain("Couldn't load");
    expectNoFixtures(t);
    // The page reads the list with the viewer's credentials, and only reads.
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.some((u) => u.startsWith("/api/traces?limit=50"))).toBe(true);
    for (const [, init] of fetchMock.mock.calls) expect(init?.method ?? "GET").toBe("GET");
  });

  it("the stream failing while the list answers keeps the real list (the API-key case)", async () => {
    FakeEventSource.mode = "fail";
    stubFetch(LIVE);
    const t = (await renderPage()).text();
    expect(t).toContain("settlement.pipeline");
    expect(t).toContain("4f1c9a2b…");
    expectNoFixtures(t);
    expect(t).not.toContain("gateway offline");
    expect(hasIndicator("refreshing every 5s")).toBe(true);
  });

  it("an empty gateway shows a real empty state and no invented average", async () => {
    FakeEventSource.mode = "silent";
    stubFetch(EMPTY);
    const t = (await renderPage()).text();
    // No finished trace: no average, rather than "0ms".
    expect(t).not.toContain("0msAvg Duration");
    expect(t).toContain("—Avg Duration");
    expect(t).toContain("No traces recorded yet");
    expect(t).toContain("0 traces");
    expect(t).not.toContain("Couldn't load");
    expectNoFixtures(t);
  });

  it("a failed refresh keeps the earlier traces and marks them stale", async () => {
    FakeEventSource.mode = "silent";
    stubFetch(LIVE);
    const { client, text } = await renderPage();
    expect(text()).toContain("settlement.pipeline");

    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = text();
    expect(t).toContain("Couldn't refresh traces");
    expect(t).toContain("settlement.pipeline");
    expectNoFixtures(t);
  });

  it("while a refresh is failing, streamed traces don't clear the stale notice", async () => {
    FakeEventSource.mode = "open";
    stubFetch(LIVE);
    const { client, text } = await renderPage();

    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    await act(async () => {
      traceStream().emit(
        "trace_update",
        trace(span("55ee66ff77aa88bb99cc00dd11ee22ff", "f1b2c3d4e5f60718", "job.lifecycle", "kernel", Date.now() - 500, undefined)),
      );
    });
    await settle(client);
    const t = text();
    expect(t).toContain("Couldn't refresh traces");
    expect(t).not.toContain("55ee66ff…");
    expect(t).toContain("settlement.pipeline");
  });

  it("says live only while the stream is connected, and streamed traces join the list", async () => {
    FakeEventSource.mode = "open";
    stubFetch(LIVE);
    const { client, text } = await renderPage();
    expect(hasIndicator("live")).toBe(true);

    const NEW_ID = "77aa88bb99cc00dd11ee22ff33445566";
    await act(async () => {
      traceStream().emit(
        "trace_update",
        trace(span(NEW_ID, "e1b2c3d4e5f60718", "job.lifecycle", "kernel", Date.now() - 1_000, undefined, undefined, { "job.id": "job-99aa" })),
      );
    });
    // react-query delivers cache updates on the next tick.
    await settle(client);
    expect(text()).toContain("77aa88bb…");

    // The stream drops: the real list stays (the old page swapped in sample traces here).
    await act(async () => {
      traceStream().fail();
    });
    const t = text();
    expectNoFixtures(t);
    expect(t).toContain("settlement.pipeline");
    expect(hasIndicator("live")).toBe(false);
    expect(hasIndicator("refreshing every 5s")).toBe(true);
  });
});
