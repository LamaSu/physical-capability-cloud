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

/** A ProductHomeDTO body (readmodels #409); sections default to read and empty. */
function home(sections: Record<string, unknown> = {}) {
  return {
    schemaId: "pcc.product-home/v1",
    asOf: "2026-09-24T12:00:00.000Z",
    kernels: { state: "read", total: 0, online: 0, stale: 0, other: 0, rule: "heartbeat within 5 min", source: "gateway_kernel_rows" },
    capabilities: { state: "read", total: 0, onOnlineKernels: 0, byType: [], source: "gateway_capability_rows" },
    jobs: { state: "read", total: 0, active: 0, byPhase: {}, source: "gateway_job_rows" },
    settlementNetwork: { name: "base-sepolia", chainId: 84532, basis: "gateway_config" },
    escrowHeld: {
      state: "read",
      byCurrency: [],
      uncountedMilestones: 0,
      unclassifiedMilestones: 0,
      excludedSimulatedEscrows: 0,
      heldStatuses: [],
      source: "gateway_escrow_record",
      confirmation: "record_only",
    },
    ...sections,
  };
}

const EMPTY: Routes = {
  "/api/health": { status: 200, body: { status: "ok" } },
  "/api/product/home": { status: 200, body: home() },
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
  // Two idle ticks in a row: a query can read as idle for one tick between retries.
  let idleTicks = 0;
  for (let i = 0; i < 200 && idleTicks < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    idleTicks = client.isFetching() === 0 ? idleTicks + 1 : 0;
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
      "/api/product/home": {
        status: 200,
        body: home({
          jobs: { state: "read", total: 2, active: 2, byPhase: {}, source: "gateway_job_rows" },
          kernels: { state: "read", total: 1, online: 1, stale: 0, other: 0, rule: "r", source: "gateway_kernel_rows" },
        }),
      },
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
      // The KPIs come from ProductHome; fail it too so the only job figures left are the list's.
      "/api/product/home": "network-error",
      "/api/jobs": { status: 200, body: { items: [{ id: "job-a", status: "queued" }] } },
      "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online", isStale: false }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toMatch(/Active Jobs\s*0/);
    expect(t).toContain("unexpected response shape from /api/jobs");
  });

  it("an unexpected /api/agent/me shape is a failed read in Settings, not a crash", async () => {
    stubFetch({ "/api/agent/me": { status: 200, body: { ok: true } } });
    const t = await renderPage(<SettingsPage />);
    expect(t).toContain("Couldn't load your account");
  });

  it("an unexpected /api/kernels shape is unavailable, not 0 kernels", async () => {
    stubFetch({
      ...EMPTY,
      "/api/product/home": "network-error",
      "/api/jobs": { status: 200, body: { jobs: [{ id: "job-a", status: "queued" }] } },
      // collection-v1 shape instead of the { kernels } envelope this client reads
      "/api/kernels": { status: 200, body: { items: [{ id: "k1", status: "online", isStale: false }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toMatch(/\b0\/0\b|0\/1|none registered/);
  });

  it("the KPI is the gateway's exact count; only the list of one page is a lower bound", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: i < 10 ? "in_progress" : "completed" }));
    stubFetch({
      ...EMPTY,
      "/api/product/home": { status: 200, body: home({ jobs: { state: "read", total: 212, active: 37, byPhase: {}, source: "gateway_job_rows" } }) },
      "/api/jobs": { status: 200, body: { jobs } },
    });

    const dash = await renderPage(<DashboardPage />);
    expect(dash).toMatch(/Active Jobs\s*37of 212 in all/);
    expect(dash).not.toMatch(/Active Jobs\s*10\+/);
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

  it("Command Center shows the gateway's own counts (ProductHomeDTO), not a count over one page", async () => {
    stubFetch({
      ...EMPTY,
      "/api/product/home": {
        status: 200,
        body: home({
          kernels: { state: "read", total: 3, online: 1, stale: 1, other: 1, rule: "r", source: "gateway_kernel_rows" },
          jobs: { state: "read", total: 4, active: 2, byPhase: {}, source: "gateway_job_rows" },
          capabilities: { state: "read", total: 5, onOnlineKernels: 3, byType: [], source: "gateway_capability_rows" },
        }),
      },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("1/3");
    expect(t).toContain("1 with a stale heartbeat, 1 not online");
    expect(t).toMatch(/Active Jobs\s*2of 4 in all/);
    expect(t).toMatch(/Capabilities Listed\s*53 on an online kernel/);
  });

  it("a ProductHome section the gateway couldn't read shows its reason, not 0", async () => {
    stubFetch({
      ...EMPTY,
      "/api/product/home": { status: 200, body: home({ jobs: { state: "unavailable", reason: "job rows could not be read" } }) },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toMatch(/Active Jobs\s*—job rows could not be read/);
    expect(t).not.toMatch(/Active Jobs\s*0/);
  });

  it("an answer that isn't a ProductHomeDTO is a failed read, not a page of zeros", async () => {
    stubFetch({ ...EMPTY, "/api/product/home": { status: 200, body: { ...home(), schemaId: "something/else" } } });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toMatch(/Active Jobs\s*0/);
    expect(t).not.toContain("0/0");
  });

  it("escrow held is the exact base-unit amount per currency, labelled as a record", async () => {
    stubFetch({
      ...EMPTY,
      "/api/product/home": {
        status: 200,
        body: home({
          escrowHeld: {
            state: "read",
            byCurrency: [{ currency: "USDC", decimals: 6, amountBaseUnits: "1234567004", milestones: 3 }],
            uncountedMilestones: 0,
            unclassifiedMilestones: 2,
            excludedSimulatedEscrows: 1,
            heldStatuses: ["FUNDED"],
            source: "gateway_escrow_record",
            confirmation: "record_only",
          },
        }),
      },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("1,234.567004");
    expect(t).toContain("From escrow records; no chain read confirms it.");
    expect(t).toContain("2 milestone(s) have a status this total doesn't recognise.");
    expect(t).toContain("1 simulated escrow(s) left out.");
  });

  it("the Command Center's job list shows only in-flight jobs", async () => {
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
    expect(t).toContain("j1");
    expect(t).toContain("j2");
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

// ── PX-3 round 3 (astra r2 follow-up): malformed rows, paging, and stale labels ──

describe("A. rows that can't be counted: a malformed row makes the whole read unavailable, never a shorter list", () => {
  it("Command Center: a job missing its status makes the job list unavailable, not a shorter list", async () => {
    // #419: the Active Jobs KPI is ProductHomeDTO's exact count (7 here), a separate read. The
    // malformed /api/jobs list must not be shown in part: the list panel is unavailable.
    stubFetch({
      ...EMPTY,
      "/api/product/home": { status: 200, body: home({ jobs: { state: "read", total: 9, active: 7, byPhase: {}, source: "gateway_job_rows" } }) },
      "/api/jobs": { status: 200, body: { jobs: [{ id: "j1", status: "in_progress" }, { id: "j2" }] } },
      "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online", isStale: false }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).toMatch(/Active Jobs\s*7/);
    expect(t).toContain("Couldn't load jobs");
    expect(t).not.toContain("j1");
  });

  it("Command Center: a kernel missing isStale makes kernels unavailable, not 1/1 or 0/1", async () => {
    stubFetch({
      ...EMPTY,
      "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online" }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toContain("1/1");
    expect(t).not.toContain("0/1");
  });

  it("Command Center: an escrow missing status is unavailable, not silently rendered", async () => {
    stubFetch({
      ...EMPTY,
      "/api/escrow": { status: 200, body: { escrows: [{ id: "e1" }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Couldn't load escrows");
  });

  it("Discover: an empty object from /api/capabilities/templates is unavailable, not empty", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities/templates": { status: 200, body: {} } });
    const t = await renderPage(<DiscoverPage />);
    expect(t).toContain("Couldn't load capabilities");
    expect(t).not.toContain("No capabilities available");
  });

  it("Kernel leaderboard: /api/capabilities without a total is unavailable, not empty", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: { items: [] } } });
    const t = await renderPage(<KernelLeaderboardPage />);
    expect(t).toContain("Couldn't load the leaderboard");
  });
});

describe("B. data kept after a failed refresh is labelled, not shown as current without a notice", () => {
  it("Discover: a failed refresh keeps the capabilities on screen and says it couldn't refresh", async () => {
    stubFetch(EMPTY);
    const client = newClient();
    await renderPage(<DiscoverPage />, client);

    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = container.textContent ?? "";
    expect(t).toContain("Couldn't refresh capabilities");
  });

  it("Kernel leaderboard: a failed refresh keeps the ranking on screen and says it couldn't refresh", async () => {
    stubFetch(EMPTY);
    const client = newClient();
    await renderPage(<KernelLeaderboardPage />, client);

    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = container.textContent ?? "";
    expect(t).toContain("Couldn't refresh the leaderboard");
  });

  it("Revenue: a failed refresh of both jobs and escrows is labelled together", async () => {
    stubFetch(EMPTY);
    const client = newClient();
    await renderPage(<RevenueDashboardPage />, client);

    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = container.textContent ?? "";
    expect(t).toContain("Couldn't refresh jobs and escrows");
  });
});

describe("C. Discover says when site names are missing", () => {
  it("shows the capability but says site names couldn't be loaded when /api/kernels 503s", async () => {
    stubFetch({
      ...EMPTY,
      "/api/capabilities/templates": {
        status: 200,
        body: { templates: [{ id: "c1", name: "Cap One", type: "hplc", kernelId: "k1" }] },
      },
      "/api/kernels": { status: 503, body: { error: "unavailable" } },
    });
    const t = await renderPage(<DiscoverPage />);
    expect(t).toContain("Cap One");
    expect(t).toContain("Site names couldn't be loaded");
  });
});

describe("D. one page read is not the whole list", () => {
  it("Command Center: 50 completed jobs says none active in the first 50, not none at all", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: "completed" }));
    stubFetch({ ...EMPTY, "/api/jobs": { status: 200, body: { jobs } } });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("No active jobs in the first 50");
    expect(t).toContain("there may be active jobs beyond them");
  });

  it("Jobs page: the same 50, filtered to active, says only the first 50 were read", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: "completed" }));
    stubFetch({ ...EMPTY, "/api/jobs": { status: 200, body: { jobs } } });
    const client = newClient();
    await renderPage(<JobsPage />, client);

    const activeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "active",
    );
    if (!activeBtn) throw new Error("active filter button not found");
    await act(async () => {
      activeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(client);

    const t = container.textContent ?? "";
    expect(t).toContain("No active jobs in the first 50");
    expect(t).toContain("Only the first 50 jobs were read");
  });
});

describe("E. a kernel's capability total is unknown, not zero-filled", () => {
  it("one kernel missing capabilityCount makes the network total unavailable; all reporting sums it", async () => {
    stubFetch({
      ...EMPTY,
      "/api/kernels": {
        status: 200,
        body: {
          kernels: [
            { id: "k1", status: "online", isStale: false, capabilityCount: 2 },
            { id: "k2", status: "online", isStale: false },
          ],
        },
      },
    });
    const t = await renderPage(<KernelsPage />);
    expect(t).toContain("unavailable: a kernel didn't report its count");
    expect(t).toMatch(/Capabilities\s*—/);

    act(() => root.unmount());
    root = createRoot(container);
    stubFetch({
      ...EMPTY,
      "/api/kernels": {
        status: 200,
        body: {
          kernels: [
            { id: "k1", status: "online", isStale: false, capabilityCount: 2 },
            { id: "k2", status: "online", isStale: false, capabilityCount: 1 },
          ],
        },
      },
    });
    const t2 = await renderPage(<KernelsPage />);
    expect(t2).toMatch(/Capabilities\s*3/);
  });
});

describe("F. the leaderboard reads every page of /api/capabilities", () => {
  /** Honours ?offset=&limit= and caps every response at 200 rows, like the real gateway. */
  function stubPagedCapabilities(allCaps: unknown[], total: number, kernels: unknown[]) {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const [path, qs = ""] = url.replace(/^https?:\/\/[^/]+/, "").split("?");
      let status = 200;
      let body: unknown;
      if (path === "/api/capabilities") {
        const params = new URLSearchParams(qs);
        const requestedLimit = Number(params.get("limit") ?? "200");
        const offset = Number(params.get("offset") ?? "0");
        const servedLimit = Math.min(requestedLimit, 200); // the gateway never serves more than 200 rows
        calls.push(`offset=${offset}&limit=${requestedLimit}`);
        body = { items: allCaps.slice(offset, offset + servedLimit), total, offset, limit: servedLimit };
      } else if (path === "/api/health") {
        body = { status: "ok" };
      } else if (path === "/api/kernels") {
        body = { kernels };
      } else if (path === "/api/jobs") {
        body = { jobs: [] };
      } else if (path === "/api/escrow") {
        body = { escrows: [] };
      } else {
        status = 404;
        body = { error: `not stubbed: ${path}` };
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        headers: { get: () => null },
        json: async () => body,
      } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return { calls };
  }

  it("250 rows over 2 pages: fetches offset=0 then offset=200, ranks all 5 kernels, no truncation notice", async () => {
    const kernelIds = ["k1", "k2", "k3", "k4", "k5"];
    const kernels = kernelIds.map((id) => ({ id, name: id, status: "online", isStale: false }));
    const caps: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      caps.push({ id: `c${i}`, kernelId: kernelIds[Math.floor(i / 50)], type: "hplc", queueDepth: 0 });
    }
    for (let i = 200; i < 250; i++) {
      caps.push({ id: `c${i}`, kernelId: "k5", type: "hplc", queueDepth: 0 });
    }
    const { calls } = stubPagedCapabilities(caps, 250, kernels);

    const t = await renderPage(<KernelLeaderboardPage />);

    expect(calls).toEqual(["offset=0&limit=200", "offset=200&limit=200"]);
    expect(t).not.toContain("Ranked over the first");
    expect(t).toMatch(/Kernels\s*5/);
    expect(t).not.toMatch(/Kernels\s*5\+/);
  });

  it("total 300 but the second page comes back empty: paging stops and the ranking is marked partial", async () => {
    const kernels = [{ id: "k1", name: "Kernel One", status: "online", isStale: false }];
    const caps = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, kernelId: "k1", type: "hplc", queueDepth: 0 }));
    const { calls } = stubPagedCapabilities(caps, 300, kernels);

    const t = await renderPage(<KernelLeaderboardPage />);

    expect(calls).toEqual(["offset=0&limit=200", "offset=200&limit=200"]);
    expect(t).toContain("Ranked over the first 200 of the 300 capabilities");
    // One kernel read so far: the KPI is a lower bound, not the network's kernel count.
    expect(t).toMatch(/Kernels\s*1\+/);
  });
});

describe("G. Settings: each account section reports its own failure", () => {
  it("an identity missing key_id is a failed read, not a crash", async () => {
    stubFetch({
      "/api/agent/me": {
        status: 200,
        body: {
          ok: true,
          as_of: "2026-09-24T12:00:00Z",
          identity: { operator: "operator@example.com", key_name: "laptop", scopes: ["*"] },
          keys: { active: 1, wildcard_keys: 0 },
        },
      },
    });
    const t = await renderPage(<SettingsPage />);
    expect(t).toContain("Couldn't load your account");
    expect(t).toContain("No wallet connected");
  });

  it("keys.unavailable shows the reason, and hides the wildcard-keys notice", async () => {
    stubFetch({
      "/api/agent/me": {
        status: 200,
        body: {
          ok: true,
          as_of: "2026-09-24T12:00:00Z",
          identity: { operator: "operator@example.com", key_id: "key-12345678-abcd", key_name: "laptop", scopes: ["*"] },
          keys: { active: null, wildcard_keys: 0, unavailable: "db down" },
        },
      },
    });
    const t = await renderPage(<SettingsPage />);
    expect(t).toContain("unavailable (db down)");
    expect(t).not.toContain("of your keys can use every scope");
  });

  it("no keys section at all reads as unavailable, not a crash", async () => {
    stubFetch({
      "/api/agent/me": {
        status: 200,
        body: {
          ok: true,
          as_of: "2026-09-24T12:00:00Z",
          identity: { operator: "operator@example.com", key_id: "key-12345678-abcd", key_name: "laptop", scopes: ["*"] },
        },
      },
    });
    const t = await renderPage(<SettingsPage />);
    expect(t).toContain("unavailable");
    expect(t).not.toMatch(/unavailable \(/);
  });
});
