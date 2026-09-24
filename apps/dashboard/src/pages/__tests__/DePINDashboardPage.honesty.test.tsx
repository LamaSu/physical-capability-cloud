/**
 * DePIN Economics: no sample treasury, certificates, epochs or claims shown
 * as the network's.
 *
 * Before this change the page loaded a hard-coded treasury (12,450 USDC,
 * 84.25 SOL, $24,780.50), three certificates, two reward epochs and three
 * claims into its store on every visit and showed them as live. No gateway
 * route serves real DePIN state: GET /api/treasury/summary, /api/certificates
 * and /api/rewards/epochs return literal records from routes/rewards.ts, and
 * no route lists claims. Outside demo mode the page must say so and request
 * nothing; in demo mode it may show the prototype under a DemoBanner.
 *
 * The real page renders with only `fetch` replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DePINDashboardPage } from "../DePINDashboardPage.js";

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

async function settle(client: QueryClient) {
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
          <DePINDashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

// Values the old page rendered as live, as they appear on screen.
const SAMPLE_VALUES = /12450\.00|24780\.50|84\.25|cnft_cert00\d|kernel-sovereign-001|Epoch #4[23]|520\.12|5VERy/;

// The gateway's own literal records (routes/rewards.ts), as a fabricated route would answer.
const GATEWAY_LITERALS: Routes = {
  "/api/treasury/summary": {
    status: 200,
    body: {
      treasury: {
        agentId: "broker-agent",
        chain: "base",
        balances: [
          { currency: "USDC", amount: "50000.00" },
          { currency: "ETH", amount: "10.5" },
        ],
        totalUsdValue: "85000.00",
        lastUpdated: "2026-09-24T12:00:00Z",
      },
      proposals: [],
      proposalCount: 0,
      approvedTotal: "0.00",
    },
  },
  "/api/certificates": {
    status: 200,
    body: { certificates: [{ id: "cnft_biolab_fdm_001", kernelDid: "did:pcc:kernel:biolab-01" }], total: 1 },
  },
  "/api/rewards/epochs": {
    status: 200,
    body: { epochs: [{ id: "epoch_completed_001", epochNumber: 1, totalRewards: "10000.000000" }], total: 1 },
  },
};

// ── production (demo mode off) ───────────────────────────────────────────────

describe("outside demo mode", () => {
  it("with the gateway unreachable: says DePIN economics isn't live, shows no sample values, requests nothing", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("DePIN economics isn't connected to live data yet");
    expect(t).toContain("no route lists reward claims");
    expect(t).not.toMatch(SAMPLE_VALUES);
    expect(container.querySelector('[data-live-state="not-live"]')).not.toBeNull();
    expect(stub).not.toHaveBeenCalled();
  });

  it("with the gateway answering its literal DePIN records: still not live, and none of them is shown", async () => {
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("DePIN economics isn't connected to live data yet");
    expect(t).not.toMatch(/50000\.00|85000\.00|cnft_biolab|epoch_completed_001|10000\.00/);
    expect(t).not.toMatch(SAMPLE_VALUES);
    expect(stub).not.toHaveBeenCalled();
  });

  it("offers the labelled demo instead of sample values, and no claim or mint action", async () => {
    stubFetch({});
    await renderPage();
    const demoLink = [...container.querySelectorAll("a")].find((a) => /demo version/i.test(a.textContent ?? ""));
    expect(demoLink?.getAttribute("href")).toContain("demo=1");
    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.filter((b) => /claim|mint|withdraw/i.test(b))).toEqual([]);
    expect(container.querySelector('[data-live-state="demo"]')).toBeNull();
  });
});

// ── demo mode ────────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/depin?demo=1");
  });

  it("shows the prototype's sample values under a DemoBanner, and requests nothing", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(container.querySelector('[data-live-state="demo"]')).not.toBeNull();
    expect(t).toContain("DePIN Economics: sample values, not live PCC state.");
    expect(t).toContain("12450.00");
    expect(t).toContain("cnft_cert001");
    expect(t).toContain("Epoch #42");
    expect(t).toContain("claim_c002");
    expect(t).not.toContain("isn't connected to live data yet");
    expect(stub).not.toHaveBeenCalled();
  });

  it("the prototype still works: selecting an epoch shows its sample kernel scores", async () => {
    stubFetch({});
    await renderPage();
    expect(container.textContent).not.toContain("Kernel Scores");
    const epoch = [...container.querySelectorAll("span")].find((s) => s.textContent === "Epoch #42");
    await act(async () => {
      (epoch as HTMLElement).click();
    });
    expect(container.textContent).toContain("Epoch #42 — Kernel Scores");
    expect(container.textContent).toContain("0.8515");
    // Leave the shared store as it was for the next test.
    await act(async () => {
      (epoch as HTMLElement).click();
    });
  });
});
