/**
 * Process Logs shows no generated log lines outside demo mode.
 *
 * Renders the real page; only `fetch` and `EventSource` are replaced. Before
 * this change the page generated forty log lines for kernel "kernel-nyc" on
 * every load and appended the gateway's /sse/stream/kernel/kernel-nyc
 * process_log events. No gateway route serves process logs, and the only
 * publisher of those events is the gateway's development log generator
 * (packages/gateway/src/sse/producers.ts, LogProducer). So the page showed
 * plausible logs that no machine wrote, with or without a gateway.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ProcessLogsPage } from "../ProcessLogsPage.js";

// ── fetch stub: the gateway is unreachable ──────────────────────────────────

function stubUnreachableGateway() {
  const fetchMock = vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── EventSource stub (jsdom has none) ───────────────────────────────────────

type StreamMode = "fail" | "open";

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

// ── what the page used to show ───────────────────────────────────────────────

/** Distinctive values from the old in-page generator (now src/demo/ProcessLogsPage.fixtures.ts). */
const OLD_FIXTURE_VALUES = [
  "Layer completed successfully",
  "Gradient step 3/10 — 45% B",
  "Retraction detected at Z=12.4mm",
  "job-001",
];

function expectNoFixtures(text: string) {
  for (const value of OLD_FIXTURE_VALUES) expect(text).not.toContain(value);
}

/** A process_log event as the gateway's development log generator publishes it. */
const GENERATED_EVENT = {
  id: "plog_gen_1",
  timestamp: new Date().toISOString(),
  kernelId: "kernel-nyc",
  deviceId: "dev-fdm-001",
  jobId: "job-002",
  stepId: "step-2",
  level: "info",
  phase: "extrusion",
  phaseProgress: 37,
  message: "Generated line from the gateway log producer",
  data: { tick: 1 },
  sequence: 1,
  hash: `sha256:${"a".repeat(64)}`,
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

async function renderPage(): Promise<() => string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProcessLogsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Let effects, timers and any stream callbacks run.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  return () => container.textContent ?? "";
}

// ── (a) production: no live source ───────────────────────────────────────────

describe("outside demo mode", () => {
  it("says the view isn't connected to live data and shows no generated lines", async () => {
    stubUnreachableGateway();
    const text = (await renderPage())();
    expect(text).toContain("Not live");
    expect(text).toContain("The process log stream isn't connected to live data yet");
    expect(text).toContain("No gateway route serves device process logs yet");
    expectNoFixtures(text);
    expect(text).not.toMatch(/\d+ entries/);
    expect(text).not.toContain("Demo data");
  });

  it("opens no kernel stream, so the gateway's generated process_log events never render", async () => {
    stubUnreachableGateway();
    FakeEventSource.mode = "open";
    const text = await renderPage();
    // Whatever the page subscribed to, publish a generated line on it.
    await act(async () => {
      for (const es of FakeEventSource.instances) es.emit("process_log", GENERATED_EVENT);
    });
    expect(FakeEventSource.instances.filter((es) => es.url.includes("/sse/stream/kernel/"))).toHaveLength(0);
    expect(text()).not.toContain("Generated line from the gateway log producer");
    expect(text()).not.toContain("job-002");
  });

  it("offers the labelled demo version instead", async () => {
    stubUnreachableGateway();
    await renderPage();
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("View the demo version"));
    expect(link).toBeDefined();
    expect(link!.getAttribute("href")).toContain("demo=1");
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("demo mode (?demo=1)", () => {
  it("shows the sample lines under the demo banner, and calls no gateway route or stream", async () => {
    window.history.replaceState(null, "", "/logs?demo=1");
    const fetchMock = stubUnreachableGateway();
    const text = (await renderPage())();
    expect(text).toContain("Demo data");
    expect(text).toContain("Process logs: sample values, not live PCC state.");
    expect(text).toContain("Layer completed successfully");
    expect(text).toContain("Retraction detected at Z=12.4mm");
    expect(text).toContain("job-001");
    expect(text).toContain("40 entries");
    expect(text).not.toContain("isn't connected to live data");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("the prototype's level filter still works on the sample lines", async () => {
    window.history.replaceState(null, "", "/logs?demo=1");
    stubUnreachableGateway();
    const text = await renderPage();
    const warn = [...container.querySelectorAll("button")].find((b) => b.textContent === "warn");
    expect(warn).toBeDefined();
    await act(async () => {
      warn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(text()).toContain("5 entries");
    expect(text()).toContain("Vibration level slightly elevated");
    expect(text()).not.toContain("Camera snapshot captured");
  });
});
