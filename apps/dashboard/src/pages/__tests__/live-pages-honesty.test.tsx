/**
 * An outage must never render as "nothing here" or as zeros.
 *
 * These tests render the real pages with the real react-query hooks and the
 * real gateway client; only `fetch` is replaced. Each page is rendered three
 * ways: gateway unreachable, gateway answering with empty lists, and gateway
 * answering with data. Before this change every page below defaulted a failed
 * read to [] and showed "No jobs yet", "0/0 kernels", "$0.00 locked" or
 * "Welcome to PCC" during an outage, and Settings showed a hard-coded wallet
 * address, network and balance.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Settings reads the connected wallet from wagmi; no wallet is connected here.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chain: undefined, chainId: undefined }),
}));

import { DashboardPage } from "../DashboardPage.js";
import { JobsPage } from "../JobsPage.js";
import { EscrowPage } from "../EscrowPage.js";
import { KernelsPage } from "../KernelsPage.js";
import { DiscoverPage } from "../DiscoverPage.js";
import { KernelLeaderboardPage } from "../KernelLeaderboardPage.js";
import { RevenueDashboardPage } from "../RevenueDashboardPage.js";
import { SettingsPage } from "../SettingsPage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;

function stubFetch(routes: Routes, fallback: Reply = "network-error") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
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

const EMPTY: Routes = {
  "/api/health": { status: 200, body: { status: "ok" } },
  "/api/jobs": { status: 200, body: { jobs: [] } },
  "/api/kernels": { status: 200, body: { kernels: [] } },
  "/api/escrow": { status: 200, body: { escrows: [] } },
  "/api/capabilities/templates": { status: 200, body: { templates: [] } },
  "/api/capabilities": { status: 200, body: { items: [], total: 0, offset: 0, limit: 500 } },
};

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
});

function newClient(): QueryClient {
  return new QueryClient({
    // The hooks retry once; retry immediately so a failure settles fast.
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  });
}

async function settle(client: QueryClient) {
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    if (client.isFetching() === 0) break;
  }
}

async function renderPage(page: React.ReactElement, client: QueryClient = newClient()): Promise<string> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>{page}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  // Let queries (including one retry) settle. Condition-based, so a loaded
  // machine or CI runner waits longer instead of asserting on a loading state.
  await settle(client);
  return container.textContent ?? "";
}

// ── outage ───────────────────────────────────────────────────────────────────

describe("gateway unreachable: pages say so instead of showing empty or zero", () => {
  beforeEach(() => {
    stubFetch({});
  });

  it("Command Center", async () => {
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Couldn't load the Command Center");
    expect(t).not.toMatch(/Nothing running yet|Welcome to PCC|0\/0|\$0\.00|Total Value Locked/);
  });

  it("Jobs", async () => {
    const t = await renderPage(<JobsPage />);
    expect(t).toContain("Couldn't load jobs");
    expect(t).not.toContain("No jobs yet");
  });

  it("Escrow", async () => {
    const t = await renderPage(<EscrowPage />);
    expect(t).toContain("Couldn't load escrows");
    expect(t).not.toMatch(/No escrows yet|Total Locked|Challenge Windows/);
  });

  it("Kernels", async () => {
    const t = await renderPage(<KernelsPage />);
    expect(t).toContain("Couldn't load kernels");
    expect(t).not.toContain("No kernels registered");
  });

  it("Discover", async () => {
    const t = await renderPage(<DiscoverPage />);
    expect(t).toContain("Couldn't load capabilities");
  });

  it("Kernel leaderboard", async () => {
    const t = await renderPage(<KernelLeaderboardPage />);
    expect(t).toContain("Couldn't load the leaderboard");
  });

  it("Revenue", async () => {
    const t = await renderPage(<RevenueDashboardPage />);
    expect(t).toMatch(/Couldn't load (jobs|escrows)/);
    expect(t).not.toMatch(/No jobs or escrows yet|Total Revenue|\$0\.00/);
  });

  it("Settings shows no invented wallet, network or balance", async () => {
    const t = await renderPage(<SettingsPage />);
    expect(t).toContain("Couldn't load your account");
    expect(t).toContain("No wallet connected");
    expect(t).not.toMatch(/0x1234|1,000\.00|USDC|Base Sepolia|Tier 1|Auto-fund/);
  });
});

// ── partial outage ───────────────────────────────────────────────────────────

describe("partial outage", () => {
  it("Command Center shows what it could read and marks the rest unavailable", async () => {
    stubFetch({
      "/api/health": { status: 200, body: { status: "ok" } },
      "/api/jobs": { status: 200, body: { jobs: [{ id: "job-live-1", status: "in_progress", capabilityId: "cap-1" }] } },
      "/api/kernels": { status: 503, body: { error: "unavailable" } },
      "/api/escrow": { status: 200, body: { escrows: [] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("job-live-1");
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toMatch(/0\/0|none registered/);
  });
});

describe("responses the pages cannot trust", () => {
  it("after a failed refresh the Command Center shows —, not the last-known figures", async () => {
    stubFetch({
      ...EMPTY,
      "/api/jobs": { status: 200, body: { jobs: [{ id: "job-x", status: "in_progress" }, { id: "job-y", status: "queued" }] } },
      "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online", isStale: false }] } },
    });
    const client = newClient();
    const before = await renderPage(<DashboardPage />, client);
    expect(before).toMatch(/Active Jobs\s*2/);
    expect(before).toContain("1/1");

    // The gateway goes away; the next refresh fails.
    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const after = container.textContent ?? "";
    expect(after).not.toMatch(/Active Jobs\s*2/);
    expect(after).not.toContain("1/1");
  });

  it("an unexpected /api/jobs shape is unavailable, not 0 active jobs", async () => {
    stubFetch({
      ...EMPTY,
      "/api/jobs": { status: 200, body: { items: [{ id: "job-a", status: "queued" }] } },
      "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online", isStale: false }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toMatch(/Active Jobs\s*0/);
  });

  it("an unexpected /api/agent/me shape is a failed read in Settings, not a crash", async () => {
    stubFetch({ "/api/agent/me": { status: 200, body: { ok: true } } });
    const t = await renderPage(<SettingsPage />);
    expect(t).toContain("Couldn't load your account");
  });

  it("an unexpected /api/kernels shape is unavailable, not 0 kernels", async () => {
    stubFetch({
      ...EMPTY,
      "/api/jobs": { status: 200, body: { jobs: [{ id: "job-a", status: "queued" }] } },
      // collection-v1 shape instead of the { kernels } envelope this client reads
      "/api/kernels": { status: 200, body: { items: [{ id: "k1", status: "online", isStale: false }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toMatch(/\b0\/0\b|0\/1|none registered/);
  });

  it("a full page of jobs is counted as a lower bound, not an exact total", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: i < 10 ? "in_progress" : "completed" }));
    stubFetch({ ...EMPTY, "/api/jobs": { status: 200, body: { jobs } } });

    const dash = await renderPage(<DashboardPage />);
    expect(dash).toMatch(/Active Jobs\s*10\+/);
    expect(dash).toContain("40+ completed");
    expect(dash).toContain("there may be more");

    act(() => root.unmount());
    root = createRoot(container);
    const list = await renderPage(<JobsPage />);
    expect(list).toMatch(/Total Jobs\s*50\+/);
    expect(list).toContain("Showing the first 50 jobs");
  });
});

// ── empty but healthy ────────────────────────────────────────────────────────

describe("gateway healthy and empty: pages show their real empty states", () => {
  beforeEach(() => {
    stubFetch(EMPTY);
  });

  it("Command Center", async () => {
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Nothing running yet");
    expect(t).not.toContain("Couldn't load");
  });

  it("Jobs", async () => {
    expect(await renderPage(<JobsPage />)).toContain("No jobs yet");
  });

  it("Escrow", async () => {
    expect(await renderPage(<EscrowPage />)).toContain("No escrows yet");
  });

  it("Kernels", async () => {
    expect(await renderPage(<KernelsPage />)).toContain("No kernels registered");
  });

  it("Discover renders after loading (hooks run in a stable order)", async () => {
    const t = await renderPage(<DiscoverPage />);
    expect(t).not.toContain("Couldn't load");
    expect(t).not.toMatch(/Rendered more hooks|Something went wrong/);
  });

  it("Kernel leaderboard renders after loading (hooks run in a stable order)", async () => {
    const t = await renderPage(<KernelLeaderboardPage />);
    expect(t).not.toContain("Couldn't load");
  });
});

// ── live data ────────────────────────────────────────────────────────────────

describe("live data", () => {
  it("Kernels renders a kernel whose location is a {lat, lng} object", async () => {
    stubFetch({
      ...EMPTY,
      "/api/kernels": {
        status: 200,
        body: {
          kernels: [
            {
              id: "kernel-a",
              name: "Shop A",
              status: "online",
              isStale: false,
              location: { lat: 37.7749, lng: -122.4194 },
              physicalAddress: "",
              capabilityCount: 2,
              capabilityTypes: ["3d-printing"],
            },
            {
              id: "kernel-b",
              name: "Shop B",
              status: "online",
              isStale: true,
              location: { lat: 1, lng: 2 },
              physicalAddress: "12 Maker St",
              capabilityCount: 1,
              capabilityTypes: [],
            },
          ],
        },
      },
    });
    const t = await renderPage(<KernelsPage />);
    expect(t).toContain("Shop A");
    expect(t).toContain("37.775, -122.419");
    expect(t).toContain("12 Maker St");
    expect(t).toContain("stale heartbeat");
  });

  it("Command Center counts only fresh online kernels and in-flight jobs", async () => {
    stubFetch({
      ...EMPTY,
      "/api/jobs": {
        status: 200,
        body: {
          jobs: [
            { id: "j1", status: "in_progress" },
            { id: "j2", status: "queued" },
            { id: "j3", status: "completed" },
            { id: "j4", status: "mystery" },
          ],
        },
      },
      "/api/kernels": {
        status: 200,
        body: {
          kernels: [
            { id: "k1", status: "online", isStale: false },
            { id: "k2", status: "online", isStale: true },
            { id: "k3", status: "offline", isStale: false },
          ],
        },
      },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("1/3");
    expect(t).toMatch(/Active Jobs\s*2/);
    expect(t).not.toContain("j3");
    expect(t).not.toContain("j4");
  });

  it("Settings shows the account the API key belongs to", async () => {
    stubFetch({
      "/api/agent/me": {
        status: 200,
        body: {
          ok: true,
          as_of: "2026-09-24T12:00:00Z",
          identity: { operator: "operator@example.com", key_id: "key-12345678-abcd", key_name: "laptop", scopes: ["*"] },
          kernels: { count: 0, items: [] },
          devices: { count: 0 },
          work: { in_flight: 0, items: [] },
          keys: { active: 3, wildcard_keys: 2 },
          next: [],
        },
      },
    });
    const t = await renderPage(<SettingsPage />);
    expect(t).toContain("operator@example.com");
    expect(t).toContain("laptop");
    expect(t).toContain("All scopes (*)");
    expect(t).toContain("2 of your keys can use every scope");
  });
});
