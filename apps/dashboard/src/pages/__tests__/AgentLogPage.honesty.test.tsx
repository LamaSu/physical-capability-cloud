/**
 * Agent Log: no invented conversations presented as network traffic.
 *
 * Before this change the page always rendered three hard-coded conversations
 * (an FDM quote, a $63.50 escrowed workflow, a job completion with a $32.00
 * milestone release) as if they were agent-to-agent traffic on PCC. No gateway
 * route lists the network's conversations: /api/agents/conversations answers
 * from a literal array (packages/gateway/src/routes/agents.ts), and
 * /api/agents/live/conversations covers only the gateway's own in-process
 * agents. The page now says so, and shows its samples only in demo mode.
 *
 * The real page renders with the real providers; only `fetch` is replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { AgentLogPage } from "../AgentLogPage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
}

function stubFetch(routes: Routes, fallback: Reply = "network-error") {
  const stub = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const reply = routes[pathOf(input)] ?? fallback;
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: reply.status === 200 ? "OK" : "Error",
      headers: { get: () => null },
      json: async () => reply.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", stub);
  return stub;
}

/** Every request the page made, as "METHOD /path". */
function requests(stub: ReturnType<typeof stubFetch>): string[] {
  return stub.mock.calls.map(([input, init]) => `${(init?.method ?? "GET").toUpperCase()} ${pathOf(input)}`);
}

// ── render harness ───────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
}

async function settle(client: QueryClient): Promise<void> {
  // Condition-based: wait until no query is in flight (at least one tick).
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    if (client.isFetching() === 0) break;
  }
}

async function renderPage(): Promise<string> {
  const client = newClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AgentLogPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

function text(): string {
  return container.textContent ?? "";
}

async function clickText(label: string): Promise<void> {
  const el = [...container.querySelectorAll("div")].find((d) => (d.textContent ?? "").trim() === label);
  if (!el) throw new Error(`"${label}" was not rendered`);
  await act(async () => {
    el.click();
  });
}

// What the old page rendered as live traffic, and what the gateway's literal
// array at /api/agents/conversations contains.
const PAGE_SAMPLES = /FDM Capability Discovery|What FDM printers support PLA\?|NYC MakerSpace|\$63\.50|0xEscrow|job-004/;
const GATEWAY_SAMPLES = /FDM capability discovery|CNC quote request|kernel-nyc-agent|kernel-sf-agent|conv-00\d/i;

// ── production (demo mode off) ───────────────────────────────────────────────

describe("outside demo mode", () => {
  it("with the gateway unreachable: says the log isn't live and shows no sample conversation", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Not live");
    expect(t).toContain("The agent log isn't connected to live data yet");
    expect(t).toContain("No gateway route lists the network's agent conversations.");
    expect(t).not.toMatch(PAGE_SAMPLES);
    expect(t).not.toMatch(/\d+ msgs|\d+ messages/);
    // There is no live source, so nothing is requested.
    expect(requests(stub)).toEqual([]);
  });

  it("with a gateway that serves its sample conversations: still shows none of them", async () => {
    const stub = stubFetch({
      // The literal array packages/gateway/src/routes/agents.ts returns.
      "/api/agents/conversations": {
        status: 200,
        body: {
          conversations: [
            { id: "conv-001", topic: "FDM capability discovery", participants: ["user-agent", "broker-agent", "kernel-nyc-agent"], messageCount: 6, status: "completed", startedAt: "2026-03-03T14:32:00Z" },
            { id: "conv-002", topic: "CNC quote request", participants: ["user-agent", "broker-agent", "kernel-sf-agent"], messageCount: 4, status: "active", startedAt: "2026-03-03T14:35:00Z" },
          ],
        },
      },
      "/api/agents/live/conversations": { status: 200, body: { conversations: [], source: "mock" } },
    });
    const t = await renderPage();
    expect(t).toContain("The agent log isn't connected to live data yet");
    expect(t).not.toMatch(GATEWAY_SAMPLES);
    expect(t).not.toMatch(PAGE_SAMPLES);
    expect(requests(stub)).toEqual([]);
  });

  it("offers the labelled demo instead of sample values", async () => {
    stubFetch({});
    await renderPage();
    const link = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("View the demo version"));
    expect(link?.getAttribute("href")).toContain("demo=1");
    expect(text()).not.toContain("Demo data");
  });
});

// ── demo mode ────────────────────────────────────────────────────────────────

describe("demo mode (?demo=1)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/agents?demo=1");
  });

  it("renders the sample conversations under the demo banner", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Demo data");
    expect(t).toContain("Agent log: sample values, not live PCC state.");
    expect(t).toContain("FDM Capability Discovery + Quote");
    expect(t).toContain("What FDM printers support PLA?");
    expect(t).not.toContain("isn't connected to live data yet");
    expect(requests(stub)).toEqual([]);
  });

  it("selecting another sample conversation shows its messages, still under the banner", async () => {
    stubFetch({});
    await renderPage();
    await clickText("Workflow Submission + Escrow");
    expect(text()).toContain("Escrow funded with $63.50 USDC + bonds. Transaction confirmed.");
    expect(text()).not.toContain("What FDM printers support PLA?");
    expect(text()).toContain("Demo data");
  });
});
