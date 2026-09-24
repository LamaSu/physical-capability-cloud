/**
 * Verification Oracles: live oracle status or an honest state, never sample
 * metrics.
 *
 * Before this change the page loaded fixed metrics (1,247 verifications, an
 * average score of 0.873, two active oracles, five recent results) on every
 * visit and fell back to a fixed oracle list, so it read "Online" whatever the
 * gateway said. The gateway's GET /api/verification/subnet-status is real only
 * when the oracle cascade runs live; in the default simulation mode it reports
 * UMA and Chainlink as available with no chain connection. GET /api/status/live
 * says which mode the gateway runs in.
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

import { SubnetStatusPage } from "../SubnetStatusPage.js";

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

function requested(stub: ReturnType<typeof stubFetch>): string[] {
  return stub.mock.calls.map(([input]) => pathOf(input));
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

async function renderPage(client: QueryClient = newClient()): Promise<string> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SubnetStatusPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

// The old page's sample values, as it rendered them.
const SAMPLE_VALUES = /1,?247|0\.873|0\.940|1,?100|0\.872|0\.881|2hr liveness|fun-base-sepolia-1/;

function statusLive(mode: "real" | "mock"): Reply {
  return {
    status: 200,
    body: {
      timestamp: "2026-09-24T12:00:00Z",
      network: "base-sepolia",
      services: {
        uma_oracle: { mode, details: mode === "mock" ? "ORACLE_MOCK not set to false" : "Live on Base Sepolia" },
        chainlink_oracle: { mode: "mock" },
        eigenlayer_avs: { mode: "stub" },
      },
    },
  };
}

// What the gateway's bridge reports after three real verifications.
const CASCADE_WITH_RESULTS: Reply = {
  status: 200,
  body: {
    available: true,
    metrics: {
      totalVerifications: 3,
      averageScore: 0.7123,
      activeOracles: 1,
      primaryOracle: "uma",
      fallbackOracles: ["chainlink", "eigenlayer"],
      recentResults: [
        { oracle: "uma", passed: true, score: 0.8321, timestamp: "2026-09-24T11:59:00Z" },
        { oracle: "uma", passed: false, score: 0.4561, timestamp: "2026-09-24T11:58:00Z" },
        { oracle: "uma", passed: true, score: 0.8493, timestamp: "2026-09-24T11:57:00Z" },
      ],
    },
    oracles: [
      { name: "uma", available: true, totalVerifications: 3, averageScore: 0.7123, isPrimary: true },
      { name: "chainlink", available: false, totalVerifications: 0, averageScore: 0, isPrimary: false },
      { name: "eigenlayer", available: false, totalVerifications: 0, averageScore: 0, isPrimary: false },
    ],
    minerCount: 3,
    subnetId: 42,
    network: "oracle-cascade",
  },
};

const CASCADE_EMPTY: Reply = {
  status: 200,
  body: {
    available: true,
    metrics: { totalVerifications: 0, averageScore: 0, activeOracles: 1, primaryOracle: "uma", fallbackOracles: [], recentResults: [] },
    oracles: [
      { name: "uma", available: true, totalVerifications: 0, averageScore: 0, isPrimary: true },
      { name: "chainlink", available: false, totalVerifications: 0, averageScore: 0, isPrimary: false },
      { name: "eigenlayer", available: false, totalVerifications: 0, averageScore: 0, isPrimary: false },
    ],
  },
};

// ── outage ───────────────────────────────────────────────────────────────────

describe("gateway unreachable", () => {
  it("says oracle status couldn't be loaded and shows no sample metrics", async () => {
    stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Couldn't load oracle status");
    expect(container.querySelector('[data-live-state="unavailable"]')).not.toBeNull();
    expect(t).not.toMatch(SAMPLE_VALUES);
    expect(t).not.toMatch(/Available|Online|PASS/);
  });
});

// ── simulation mode ──────────────────────────────────────────────────────────

describe("gateway running the oracle cascade in simulation mode", () => {
  it("says oracle verification isn't live, and never shows the simulated status", async () => {
    const stub = stubFetch({
      "/api/status/live": statusLive("mock"),
      "/api/verification/subnet-status": CASCADE_WITH_RESULTS,
    });
    const t = await renderPage();
    expect(t).toContain("Oracle verification isn't connected to live data yet");
    expect(t).toContain("simulation mode");
    expect(container.querySelector('[data-live-state="not-live"]')).not.toBeNull();
    expect(t).not.toMatch(SAMPLE_VALUES);
    expect(t).not.toMatch(/0\.712|0\.832|PASS|Available/);
    expect(requested(stub)).toEqual(["/api/status/live"]);
  });
});

// ── live mode ────────────────────────────────────────────────────────────────

describe("gateway running the oracle cascade live", () => {
  it("renders what GET /api/verification/subnet-status returned", async () => {
    stubFetch({
      "/api/status/live": statusLive("real"),
      "/api/verification/subnet-status": CASCADE_WITH_RESULTS,
    });
    const t = await renderPage();
    expect(t).toMatch(/Oracle Cascade\s*Available/);
    expect(t).toMatch(/Verifications\s*3\s*since the gateway started/);
    expect(t).toContain("0.712");
    expect(t).toContain("1 / 3");
    expect(t).toContain("UMA Optimistic Oracle");
    expect(t).toContain("0.832");
    expect(t).toContain("0.456");
    expect(t).toContain("FAIL");
    expect(t).not.toMatch(SAMPLE_VALUES);
    // The prototype's static notes are not live facts.
    expect(t).not.toMatch(/500 USDC bond|mock mode|Stub/);
    expect(t).not.toContain("Couldn't load");
  });

  it("an empty cascade shows its real empty state, not a 0.000 average", async () => {
    stubFetch({
      "/api/status/live": statusLive("real"),
      "/api/verification/subnet-status": CASCADE_EMPTY,
    });
    const t = await renderPage();
    expect(t).toContain("No verifications yet");
    expect(t).toMatch(/Average Score\s*—/);
    expect(t).not.toContain("0.000");
    expect(t).not.toMatch(SAMPLE_VALUES);
  });

  it("a failed status read is unavailable, not the sample oracles", async () => {
    stubFetch({
      "/api/status/live": statusLive("real"),
      "/api/verification/subnet-status": { status: 503, body: { error: "unavailable", message: "bridge offline" } },
    });
    const t = await renderPage();
    expect(t).toContain("Couldn't load oracle status");
    expect(t).toContain("bridge offline");
    expect(t).not.toMatch(SAMPLE_VALUES);
    expect(t).not.toMatch(/Available|Active/);
  });

  it("an unexpected status shape is unavailable, not zeros", async () => {
    stubFetch({
      "/api/status/live": statusLive("real"),
      "/api/verification/subnet-status": { status: 200, body: { available: true, metrics: {}, oracles: [] } },
    });
    const t = await renderPage();
    expect(t).toContain("Couldn't load oracle status");
    expect(t).not.toMatch(/Verifications\s*0|0 \/ 0/);
  });

  it("after a failed refresh it keeps the last read and says it is stale", async () => {
    stubFetch({
      "/api/status/live": statusLive("real"),
      "/api/verification/subnet-status": CASCADE_WITH_RESULTS,
    });
    const client = newClient();
    await renderPage(client);
    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = container.textContent ?? "";
    expect(t).toContain("Couldn't refresh oracle status");
    expect(t).toContain("0.712");
  });
});

// ── demo mode ────────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  it("shows the prototype's sample values under a DemoBanner and requests nothing", async () => {
    window.history.replaceState(null, "", "/subnet?demo=1");
    const stub = stubFetch({});
    const t = await renderPage();
    expect(container.querySelector('[data-live-state="demo"]')).not.toBeNull();
    expect(t).toContain("Verification Oracles: sample values, not live PCC state.");
    expect(t).toMatch(/1,?247/);
    expect(t).toContain("0.873");
    expect(t).toContain("2hr liveness");
    expect(stub).not.toHaveBeenCalled();
  });
});
