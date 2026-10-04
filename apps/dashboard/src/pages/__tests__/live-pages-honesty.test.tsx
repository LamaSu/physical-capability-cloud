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
import { KNOWN_ESCROW_STATUSES, KNOWN_JOB_STATUSES } from "../../api/wire-vocabulary.js";
import { EscrowAmount, formatEscrowAmount } from "../../components/EscrowAmount.js";

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
              locationPrecision: "approximate",
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
              locationPrecision: "approximate",
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
    expect(t).toContain("Approximate (within about 5 km): 37.7749, -122.4194");
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
            // Known but not in flight. An unknown status fails the read instead (R3a, R3b).
            { id: "j4", status: "evidence_submitted" },
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

// ── PX-3 round 3 (astra r2 follow-up): malformed rows, paging, and stale labels ──

describe("A. rows that can't be counted: a malformed row makes the whole read unavailable, never a shorter list", () => {
  it("Command Center: a job missing its status makes jobs unavailable, not a wrong count", async () => {
    stubFetch({
      ...EMPTY,
      "/api/jobs": { status: 200, body: { jobs: [{ id: "j1", status: "in_progress" }, { id: "j2" }] } },
      "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "online", isStale: false }] } },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).toContain("Some live data couldn't be loaded");
    expect(t).not.toMatch(/Active Jobs\s*1/);
    expect(t).not.toMatch(/Active Jobs\s*0/);
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

  it("Discover: an empty object from /api/capabilities is unavailable, not empty", async () => {
    stubFetch({ ...EMPTY, "/api/capabilities": { status: 200, body: {} } });
    const t = await renderPage(<DiscoverPage />);
    expect(t).toContain("Couldn't load capabilities");
    expect(t).not.toContain("No capabilities listed yet");
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
      "/api/capabilities": {
        status: 200,
        body: { items: [{ id: "c1", name: "Cap One", type: "hplc", kernelId: "k1" }], total: 1, offset: 0, limit: 200 },
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

// ── PX-3 round 4 (astra 18b review, eaedeb4c): reproduction tests, written
// before the fix. Spec: pcc-reconciliation/returns/pcc-shell-work/px3-352-r4-repro-spec.md.
// Verdict: pcc-reconciliation/review-packs-for-chatgpt-20260924/18b-px3-352-shelltruth-r3-eaedeb4c.astra.verdict.md.
// Every case here is expected to FAIL at eaedeb4c; that failure is the reproduction.
describe("R4: astra 18b findings (each failed at eaedeb4c)", () => {
  describe("F1: money — an escrow's real currency and amount reach the page", () => {
    const baseEscrow = {
      id: "e1",
      jobId: "j1",
      status: "active",
      totalAmount: "10",
      currency: "ETH",
      milestoneCount: 1,
      releasedCount: 0,
      disputedCount: 0,
    };

    it("R1a: Command Center shows an escrow in its own currency, never as USDC or dollars", async () => {
      stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [baseEscrow] } } });
      const t = await renderPage(<DashboardPage />);
      expect(t).toContain("ETH");
      expect(t).not.toContain("USDC");
      expect(t).not.toContain("$10.00");
    });

    it("R1b: the Escrow page shows an escrow in its own currency, never as USDC or dollars", async () => {
      stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [baseEscrow] } } });
      const t = await renderPage(<EscrowPage />);
      expect(t).toContain("ETH");
      expect(t).not.toContain("USDC");
      expect(t).not.toContain("$10.00");
    });

    it("R1c: Revenue's active-escrows panel shows an escrow in its own currency, never as USDC or dollars", async () => {
      stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [baseEscrow] } } });
      const t = await renderPage(<RevenueDashboardPage />);
      expect(t).toContain("ETH");
      expect(t).not.toContain("USDC");
      expect(t).not.toContain("$10.00");
    });

    it("R1d: a malformed amount is unavailable everywhere, never a fabricated $0.00", async () => {
      const escrow = { ...baseEscrow, totalAmount: "not-money", currency: "USDC" };
      stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [escrow] } } });
      const escrowPageText = await renderPage(<EscrowPage />);
      expect(escrowPageText).not.toContain("0.00");
      expect(escrowPageText).not.toContain("$0.00");
      expect(escrowPageText).toContain("Couldn't load escrows");

      act(() => root.unmount());
      root = createRoot(container);
      stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [escrow] } } });
      const dashboardText = await renderPage(<DashboardPage />);
      expect(dashboardText).toContain("Couldn't load escrows");
      expect(dashboardText).not.toContain("0.00");
    });

    it("R1e: a currency the escrows table doesn't allow fails the read, and is never relabeled USDC", async () => {
      const escrow = { ...baseEscrow, currency: "XYZ" };
      stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [escrow] } } });
      const t = await renderPage(<EscrowPage />);
      expect(t).toContain("Couldn't load escrows");
      expect(t).not.toContain("USDC");
    });
  });

  describe("F2: Discover presents live capabilities, never templates", () => {
    it("R2a: a template-only catalog isn't counted or shown as live capability supply", async () => {
      stubFetch({
        ...EMPTY,
        "/api/capabilities/templates": { status: 200, body: { templates: [{ name: "Template Only", capabilityType: "hplc" }] } },
        "/api/capabilities": { status: 200, body: { items: [], total: 0, offset: 0, limit: 200 } },
      });
      const t = await renderPage(<DiscoverPage />);
      expect(t).not.toMatch(/[1-9]\d* capabilit(y|ies) found/);
      const shownUnlabeled = t.includes("Template Only") && !/template/i.test(t);
      expect(shownUnlabeled).toBe(false);
    });

    it("R2b: an empty template row is never counted as a capability found", async () => {
      stubFetch({ ...EMPTY, "/api/capabilities/templates": { status: 200, body: { templates: [{}] } } });
      const t = await renderPage(<DiscoverPage />);
      expect(t).not.toContain("1 capability found");
    });
  });

  describe("F3: off-schema rows never reach displayed numbers", () => {
    it("R3a: a job whose status the gateway doesn't define makes jobs unavailable, not a counted job", async () => {
      stubFetch({ ...EMPTY, "/api/jobs": { status: 200, body: { jobs: [{ id: "j1", status: "bogus" }] } } });
      const t = await renderPage(<JobsPage />);
      expect(t).not.toMatch(/Total Jobs\s*1/);
      expect(t).toContain("Couldn't load jobs");
    });

    it("R3b: Command Center flags a job whose status the gateway doesn't define as a partial failure", async () => {
      stubFetch({ ...EMPTY, "/api/jobs": { status: 200, body: { jobs: [{ id: "j1", status: "bogus" }] } } });
      const t = await renderPage(<DashboardPage />);
      expect(t).toContain("Some live data couldn't be loaded");
    });

    it("R3c: Command Center flags a kernel whose status the gateway doesn't define as a partial failure, with no kernel ratio", async () => {
      stubFetch({ ...EMPTY, "/api/kernels": { status: 200, body: { kernels: [{ id: "k1", status: "bogus", isStale: false }] } } });
      const t = await renderPage(<DashboardPage />);
      expect(t).toContain("Some live data couldn't be loaded");
      expect(t).not.toMatch(/\b0\/1\b/);
      expect(t).not.toMatch(/\b1\/1\b/);
    });

    it("R3d: the Escrow page rejects an escrow whose status the gateway doesn't define", async () => {
      stubFetch({
        ...EMPTY,
        "/api/escrow": {
          status: 200,
          body: { escrows: [{ id: "e1", jobId: "j1", status: "bogus", totalAmount: "10", currency: "USDC", milestoneCount: 1, releasedCount: 0, disputedCount: 0 }] },
        },
      });
      const t = await renderPage(<EscrowPage />);
      expect(t).toContain("Couldn't load escrows");
    });

    it("R3e: a capability missing its type fails the leaderboard read", async () => {
      stubFetch({
        ...EMPTY,
        "/api/capabilities": { status: 200, body: { items: [{ id: "c1", kernelId: "k1", queueDepth: 0 }], total: 1, offset: 0, limit: 200 } },
      });
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toContain("Couldn't load the leaderboard");
    });

    it("R3f: a capability with a negative queue depth fails the leaderboard read", async () => {
      stubFetch({
        ...EMPTY,
        "/api/capabilities": { status: 200, body: { items: [{ id: "c1", kernelId: "k1", type: "hplc", queueDepth: -1 }], total: 1, offset: 0, limit: 200 } },
      });
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toContain("Couldn't load the leaderboard");
    });

    it("R3g: Settings shows a negative or fractional key count as unavailable", async () => {
      const identity = { operator: "operator@example.com", key_id: "key-12345678-abcd", key_name: "laptop", scopes: ["*"] };
      stubFetch({
        "/api/agent/me": {
          status: 200,
          body: { ok: true, as_of: "2026-09-24T12:00:00Z", identity, keys: { active: -1, wildcard_keys: 0 } },
        },
      });
      const t = await renderPage(<SettingsPage />);
      // The row, not the page: the key id shown beside it ("key-1234") contains "-1" itself.
      expect(t).toMatch(/Active keys\s*unavailable/);
      expect(t).not.toMatch(/Active keys\s*-1/);

      act(() => root.unmount());
      root = createRoot(container);
      stubFetch({
        "/api/agent/me": {
          status: 200,
          body: { ok: true, as_of: "2026-09-24T12:00:00Z", identity, keys: { active: 2.5, wildcard_keys: 0 } },
        },
      });
      const t2 = await renderPage(<SettingsPage />);
      expect(t2).toMatch(/Active keys\s*unavailable/);
      expect(t2).not.toContain("2.5");
    });
  });

  describe("F4: the pager never certifies an inconsistent multi-page read as complete", () => {
    /**
     * Like section F's stubPagedCapabilities, but each call to /api/capabilities
     * returns the next entry in `pages` (by call order, not by offset) — so a
     * later page's `total` can differ from an earlier page's, or repeat rows,
     * the way a mid-read total shift or a duplicated page would.
     */
    function stubPagedCapabilitiesVarying(pages: Array<{ items: unknown[]; total: number }>, kernels: unknown[]) {
      let call = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const [path, qs = ""] = url.replace(/^https?:\/\/[^/]+/, "").split("?");
        let status = 200;
        let body: unknown;
        if (path === "/api/capabilities") {
          const page = pages[Math.min(call, pages.length - 1)]!;
          call++;
          // Answers for the offset asked, so only the total or the rows are inconsistent.
          const offset = Number(new URLSearchParams(qs).get("offset") ?? "0");
          body = { items: page.items, total: page.total, offset, limit: 200 };
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
    }

    it("R4a: a total that changes between pages is never certified as a complete ranking", async () => {
      const page1Items = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, kernelId: "k1", type: "hplc", queueDepth: 0 }));
      stubPagedCapabilitiesVarying(
        [
          { items: page1Items, total: 250 },
          { items: [], total: 100 },
        ],
        [{ id: "k1", name: "Kernel One", status: "online", isStale: false }],
      );
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toMatch(/Ranked over the first|Couldn't load the leaderboard/);
    });

    it("R4b: rows repeated across pages are never certified as a complete ranking", async () => {
      const page1Items = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, kernelId: "k1", type: "hplc", queueDepth: 0 }));
      const page2Items = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, kernelId: "k1", type: "hplc", queueDepth: 0 }));
      stubPagedCapabilitiesVarying(
        [
          { items: page1Items, total: 250 },
          { items: page2Items, total: 250 },
        ],
        [{ id: "k1", name: "Kernel One", status: "online", isStale: false }],
      );
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toMatch(/Ranked over the first|Couldn't load the leaderboard/);
    });
  });

  describe("F5: no categorical claim over a partial read", () => {
    it("R5a: the leaderboard never says there are no kernels when registered kernels list no capabilities", async () => {
      stubFetch({
        ...EMPTY,
        "/api/kernels": {
          status: 200,
          body: {
            kernels: [
              { id: "k1", status: "online", isStale: false },
              { id: "k2", status: "online", isStale: false },
            ],
          },
        },
        "/api/capabilities": { status: 200, body: { items: [], total: 0, offset: 0, limit: 200 } },
      });
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).not.toContain("No kernels on the network yet");
    });

    it("R5b: after reading only the first 50 jobs, Revenue says none completed in the first 50, not none at all", async () => {
      const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: "in_progress" }));
      stubFetch({ ...EMPTY, "/api/jobs": { status: 200, body: { jobs } } });
      const t = await renderPage(<RevenueDashboardPage />);
      expect(t).not.toContain("No completed jobs yet");
      expect(t).toContain("in the first 50");
    });
  });
});

// ── PX-3 round 4, after the fix: the stricter reads still accept everything the
// real gateway writes, and money shows digit for digit in its own currency.
describe("R4 fixes: what the stricter reads accept, and how an escrow amount shows", () => {
  const escrow = (over: Record<string, unknown> = {}) => ({
    id: "e1",
    jobId: "j1",
    status: "active",
    totalAmount: "10",
    currency: "USDC",
    milestoneCount: 1,
    releasedCount: 0,
    disputedCount: 0,
    ...over,
  });

  it("every job status the gateway writes is accepted, and each job is counted", async () => {
    const jobs = [...KNOWN_JOB_STATUSES].map((status, i) => ({ id: `job-${i}`, status }));
    stubFetch({ ...EMPTY, "/api/jobs": { status: 200, body: { jobs } } });
    const t = await renderPage(<JobsPage />);
    expect(t).not.toContain("Couldn't load jobs");
    expect(t).toMatch(new RegExp(`Total Jobs\\s*${jobs.length}(?!\\d|\\+)`));
  });

  it("every escrow status the gateway or the badges name is accepted", async () => {
    const escrows = [...KNOWN_ESCROW_STATUSES].map((status, i) => escrow({ id: `e${i}`, status }));
    stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows } } });
    const t = await renderPage(<EscrowPage />);
    expect(t).not.toContain("Couldn't load escrows");
    expect(t).toMatch(new RegExp(`Escrows\\s*${escrows.length}\\s*all states`));
  });

  it("a kernel the TTL sweeper expired is accepted and not counted online", async () => {
    stubFetch({
      ...EMPTY,
      "/api/kernels": {
        status: 200,
        body: { kernels: [{ id: "k1", status: "expired", isStale: false }, { id: "k2", status: "online", isStale: false }] },
      },
    });
    const t = await renderPage(<DashboardPage />);
    expect(t).not.toContain("Some live data couldn't be loaded");
    expect(t).toContain("1/2");
  });

  it("a USDC escrow keeps its dollar sign, and a large amount keeps every digit", async () => {
    stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [escrow({ totalAmount: "12345678901234567.89" })] } } });
    const t = await renderPage(<EscrowPage />);
    expect(t).toContain("$12,345,678,901,234,567.89");
    expect(t).toContain("USDC");
  });

  it("a DAI escrow shows its amount in DAI, with no dollar sign", async () => {
    stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [escrow({ totalAmount: "10.5", currency: "DAI" })] } } });
    const t = await renderPage(<EscrowPage />);
    expect(t).toContain("10.50");
    expect(t).toContain("DAI");
    expect(t).not.toContain("$");
    expect(t).not.toContain("USDC");
  });

  it("an escrow with more released and disputed milestones than milestones fails the read", async () => {
    stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [escrow({ milestoneCount: 1, releasedCount: 1, disputedCount: 1 })] } } });
    const t = await renderPage(<EscrowPage />);
    expect(t).toContain("Couldn't load escrows");
  });

  it("an escrow amount with a sign, an exponent or grouping fails the read", async () => {
    for (const totalAmount of ["-10", "1e3", "1,000", "010", " 10", "10.", ".5"]) {
      act(() => root.unmount());
      root = createRoot(container);
      stubFetch({ ...EMPTY, "/api/escrow": { status: 200, body: { escrows: [escrow({ totalAmount })] } } });
      const t = await renderPage(<EscrowPage />);
      expect(t, totalAmount).toContain("Couldn't load escrows");
    }
  });

  it("formatEscrowAmount groups the whole part and keeps every decimal, never rounding", () => {
    expect(formatEscrowAmount("0")).toBe("0.00");
    expect(formatEscrowAmount("10")).toBe("10.00");
    expect(formatEscrowAmount("1234.5")).toBe("1,234.50");
    expect(formatEscrowAmount("0.004")).toBe("0.004");
    expect(formatEscrowAmount("1000000.000100")).toBe("1,000,000.0001");
    expect(formatEscrowAmount("123456789012345678901234567890.123456789012345678")).toBe(
      "123,456,789,012,345,678,901,234,567,890.123456789012345678",
    );
  });

  it("EscrowAmount handed an unreadable amount or currency shows unavailable, never a value", async () => {
    for (const [amount, currency] of [["not-money", "USDC"], [undefined, "USDC"], ["10", "XYZ"], ["10", undefined], [10, "USDC"]] as const) {
      act(() => root.unmount());
      root = createRoot(container);
      const t = await renderPage(<EscrowAmount amount={amount} currency={currency} />);
      expect(t, `${String(amount)} ${String(currency)}`).toContain("amount unavailable");
      expect(t).not.toMatch(/\d/);
    }
  });

  describe("the capability pager", () => {
    function stubCapabilityPages(pageFor: (offset: number) => Record<string, unknown>) {
      stubFetch({ ...EMPTY }); // other routes
      const base = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).getMockImplementation()!;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const [path, qs = ""] = url.replace(/^https?:\/\/[^/]+/, "").split("?");
          if (path !== "/api/capabilities") return base(input);
          const body = pageFor(Number(new URLSearchParams(qs).get("offset") ?? "0"));
          return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, json: async () => body } as unknown as Response;
        }),
      );
    }
    const caps = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${from + i}`, kernelId: "k1", type: "hplc", queueDepth: 0 }));

    it("a total that changes between pages fails the read, even when the rows add up", async () => {
      // Without the total check this would read 250 rows, find no more, and rank them as "the first 250 of 251".
      stubCapabilityPages((offset) =>
        offset === 0
          ? { items: caps(0, 200), total: 250, offset, limit: 200 }
          : offset === 200
            ? { items: caps(200, 50), total: 251, offset, limit: 200 }
            : { items: [], total: 251, offset, limit: 200 },
      );
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toContain("Couldn't load the leaderboard");
      expect(t).not.toContain("Ranked over the first");
    });

    it("a page that answers for another offset fails the read", async () => {
      stubCapabilityPages((offset) => ({ items: offset === 0 ? caps(0, 200) : caps(200, 50), total: 250, offset: 0, limit: 200 }));
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toContain("Couldn't load the leaderboard");
    });

    it("a page whose hasMore disagrees with its offset, limit and total fails the read", async () => {
      stubCapabilityPages(() => ({ items: caps(0, 1), total: 1, offset: 0, limit: 200, hasMore: true }));
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toContain("Couldn't load the leaderboard");
    });

    it("more rows than the total fails the read", async () => {
      stubCapabilityPages(() => ({ items: caps(0, 2), total: 1, offset: 0, limit: 200 }));
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).toContain("Couldn't load the leaderboard");
    });

    it("a consistent two-page read, with hasMore as the gateway sets it, is complete", async () => {
      stubCapabilityPages((offset) => ({ items: offset === 0 ? caps(0, 200) : caps(200, 50), total: 250, offset, limit: 200, hasMore: offset + 200 < 250 }));
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t).not.toContain("Couldn't load the leaderboard");
      expect(t).not.toContain("Ranked over the first");
    });

    it("Discover counts a capped read as a lower bound and says only part was read", async () => {
      stubCapabilityPages((offset) => ({ items: offset === 0 ? caps(0, 1) : [], total: 3, offset, limit: 200 }));
      const t = await renderPage(<DiscoverPage />);
      expect(t).toContain("Showing the first 1 of the 3 capabilities");
      expect(t).toContain("1+ capability found");
    });
  });

  it("a capability score or reputation out of range fails the leaderboard read", async () => {
    for (const bad of [{ assuranceScore: 1.5 }, { assuranceScore: Number.NaN }, { reputation: 5000 }, { reputation: -1 }, { queueDepth: 2.5 }]) {
      act(() => root.unmount());
      root = createRoot(container);
      stubFetch({
        ...EMPTY,
        "/api/capabilities": { status: 200, body: { items: [{ id: "c1", kernelId: "k1", type: "hplc", queueDepth: 0, ...bad }], total: 1, offset: 0, limit: 200 } },
      });
      const t = await renderPage(<KernelLeaderboardPage />);
      expect(t, JSON.stringify(bad)).toContain("Couldn't load the leaderboard");
    }
  });

  it("Settings shows more wildcard keys than active keys as unavailable", async () => {
    const identity = { operator: "operator@example.com", key_id: "key-12345678-abcd", key_name: "laptop", scopes: ["*"] };
    stubFetch({ "/api/agent/me": { status: 200, body: { ok: true, as_of: "2026-09-24T12:00:00Z", identity, keys: { active: 1, wildcard_keys: 2 } } } });
    const t = await renderPage(<SettingsPage />);
    expect(t).toMatch(/Active keys\s*unavailable/);
    expect(t).not.toContain("2 of your keys");
  });
});
