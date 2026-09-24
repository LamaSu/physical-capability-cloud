/**
 * Sovereign Wealth Fund: the fund's real records, and an honest state for
 * everything else; never a sample fund.
 *
 * Before this change the page always rendered one hard-coded fund: a $48,250
 * balance, $124,780.50 distributed, 47 participants, Base and Solana balances,
 * two epochs, three accruals, two "your" dividend claims and one proposal.
 *
 * The gateway's fund service (routes/swf.ts) holds participants, proposals and
 * the allocation strategy as real (in-memory) records, and the page shows
 * those. Its money is not real: every milestone release is booked as a fixed
 * 1,000 USDC gross, distributions are scored with Math.random(), and its
 * chain balances read no chain. The page must never show those figures, and
 * must say so instead.
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

import { SWFDashboardPage } from "../SWFDashboardPage.js";

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

// Condition-based: wait until nothing is fetching on two consecutive ticks. react-query
// notifies components on a setTimeout(0), so one idle reading can come before the last
// result has rendered, or before a query that depends on it has started.
async function settle(client: QueryClient) {
  let idleTicks = 0;
  for (let i = 0; i < 200 && idleTicks < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    idleTicks = client.isFetching() === 0 ? idleTicks + 1 : 0;
  }
}

async function renderPage(client: QueryClient = newClient()): Promise<string> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SWFDashboardPage />
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

function buttonLabels(): string[] {
  return [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
}

async function openTab(label: string): Promise<string> {
  const tab = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);
  if (!tab) throw new Error(`tab ${label} was not rendered`);
  await act(async () => {
    tab.click();
  });
  return text();
}

// The old page's sample fund, as it rendered it.
const SAMPLE_VALUES =
  /48250\.00|124780\.50|38250\.00|10000\.00|swf_epoch_001[012]|#1[12]|2500\.00|1200\.00|5000\.00|68\.25|52\.10|Increase dividend allocation to 70%|Escrow Release/;

// The ledger money GET /api/swf/summary returns; the page must never show it.
const LEDGER_MONEY = /\$40\.00|\$12\.00|\$28\.00|\$52\.00|Fund Balance|Total Distributed|Chain Balances/;

const PROPOSAL = {
  id: "swf_prop_0001",
  proposer: "swf_part_0100",
  title: "Fund more capability grants",
  description: "Move five points from reserve to grants.",
  proposedStrategy: { dividendPercent: 55, infrastructurePercent: 30, grantsPercent: 15, reservePercent: 0 },
  votingStart: "2026-09-20T00:00:00Z",
  votingEnd: "2026-09-27T12:00:00Z",
  status: "active",
  yesVotes: 3,
  noVotes: 1,
  totalVoters: 2,
  quorumRequired: 0.3,
  createdAt: "2026-09-20T00:00:00Z",
};

function summary(overrides: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      summary: {
        totalBalance: "40",
        totalDistributedAllTime: "12",
        totalAccruedAllTime: "52",
        currentEpochId: "swf_epoch_0001",
        currentAllocationStrategy: { dividendPercent: 55, infrastructurePercent: 30, grantsPercent: 10, reservePercent: 5 },
        participantCount: 5,
        activeProposals: 1,
        lastDistributionAt: "2026-09-24T12:00:00Z",
        chainBalances: [{ chain: "base", currency: "USDC", amount: "28" }],
        ...overrides,
      },
    },
  };
}

const LIVE: Routes = {
  "/api/swf/summary": summary(),
  "/api/swf/proposals": { status: 200, body: { proposals: [PROPOSAL], total: 1 } },
};

// ── outage ───────────────────────────────────────────────────────────────────

describe("gateway unreachable", () => {
  it("every section says what it couldn't load or that it isn't live, with no sample fund", async () => {
    stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Couldn't load the fund summary");
    expect(t).toContain("The fund ledger isn't connected to live data yet");
    expect(t).not.toMatch(SAMPLE_VALUES);
    expect(t).not.toMatch(/Fund Balance|Participants\s*\d/);

    const accruals = await openTab("Accruals");
    expect(accruals).toContain("The accrual ledger isn't connected to live data yet");
    expect(accruals).not.toMatch(SAMPLE_VALUES);

    const claims = await openTab("Claims");
    expect(claims).toContain("Your dividend history isn't connected to live data yet");
    expect(claims).not.toMatch(SAMPLE_VALUES);

    const governance = await openTab("Governance");
    expect(governance).toContain("Couldn't load proposals");
    expect(governance).not.toMatch(SAMPLE_VALUES);
  });
});

// ── live data ────────────────────────────────────────────────────────────────

describe("live data", () => {
  it("shows the fund's real records and none of its ledger money", async () => {
    const stub = stubFetch(LIVE);
    const t = await renderPage();
    expect(t).toMatch(/Active Participants\s*5/);
    expect(t).toMatch(/Active Proposals\s*1/);
    expect(t).toMatch(/55%\s*dividend\s*30%\s*infrastructure\s*10%\s*grants\s*5%\s*reserve/);
    expect(t).toContain("cleared when it restarts");
    expect(t).toContain("The fund ledger isn't connected to live data yet");
    expect(t).not.toMatch(LEDGER_MONEY);
    expect(t).not.toMatch(SAMPLE_VALUES);

    const governance = await openTab("Governance");
    expect(governance).toContain("Fund more capability grants");
    expect(governance).toContain("2 voters (40% turnout)");
    expect(governance).toContain("Voting ends Sep 27");
    expect(governance).not.toMatch(LEDGER_MONEY);

    // Only the fund's real records are read: never its epochs, accruals or distribution.
    expect(new Set(requests(stub))).toEqual(new Set(["GET /api/swf/summary", "GET /api/swf/proposals"]));
  });

  it("offers no claim, withdraw or distribute action on any tab", async () => {
    stubFetch(LIVE);
    await renderPage();
    for (const tab of ["Overview", "Accruals", "Claims", "Governance"]) {
      await openTab(tab);
      expect(buttonLabels()).toEqual(["Overview", "Accruals", "Claims", "Governance"]);
    }
  });

  it("an empty fund shows its counts as read and a real empty proposal list", async () => {
    stubFetch({
      "/api/swf/summary": summary({ participantCount: 0, activeProposals: 0 }),
      "/api/swf/proposals": { status: 200, body: { proposals: [], total: 0 } },
    });
    const t = await renderPage();
    expect(t).toMatch(/Active Participants\s*0/);
    expect(t).not.toContain("Couldn't load");
    const governance = await openTab("Governance");
    expect(governance).toContain("No active proposals");
    expect(governance).not.toMatch(SAMPLE_VALUES);
  });

  it("an unexpected summary shape is unavailable, not zeros", async () => {
    stubFetch({
      "/api/swf/summary": { status: 200, body: { summary: { totalBalance: "5" } } },
      "/api/swf/proposals": { status: 200, body: { proposals: [], total: 0 } },
    });
    const t = await renderPage();
    expect(t).toContain("Couldn't load the fund summary");
    expect(t).not.toMatch(/Active Participants\s*0|\$5\.00/);
  });

  it("after a failed refresh the fund summary is marked stale, with its last read", async () => {
    stubFetch(LIVE);
    const client = newClient();
    await renderPage(client);
    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = text();
    expect(t).toContain("Couldn't refresh the fund summary");
    expect(t).toMatch(/Active Participants\s*5/);
  });
});

// ── demo mode ────────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  it("shows the prototype's sample fund under a DemoBanner and requests nothing", async () => {
    window.history.replaceState(null, "", "/swf?demo=1");
    const stub = stubFetch({});
    const t = await renderPage();
    expect(container.querySelector('[data-live-state="demo"]')).not.toBeNull();
    expect(t).toContain("Sovereign Wealth Fund: sample values, not live PCC state.");
    expect(t).toContain("48250.00");
    expect(t).toContain("38250.00");
    expect(t).toContain("#12");
    expect(await openTab("Accruals")).toContain("2500.00");
    expect(await openTab("Claims")).toContain("68.25");
    const governance = await openTab("Governance");
    expect(governance).toContain("Increase dividend allocation to 70%");
    expect(governance).toContain("18 voters (38% turnout)");
    expect(t).not.toContain("isn't connected to live data yet");
    expect(stub).not.toHaveBeenCalled();
  });
});
