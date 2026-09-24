/**
 * Fund governance: the proposal in the URL, read from the gateway, or an
 * honest state; never a sample proposal.
 *
 * Before this change the page showed one hard-coded proposal ("Increase
 * dividend allocation to 70%") and five hard-coded votes for every proposal
 * id, with 47 eligible participants ("In production: fetch by proposalId").
 * GET /api/swf/proposals/:proposalId serves the gateway's recorded proposal
 * and votes, and GET /api/swf/summary its current strategy and active
 * participant count.
 *
 * The real page renders with only `fetch` replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SWFGovernancePage } from "../SWFGovernancePage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Routes_ = Record<string, Reply>;

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
}

function stubFetch(routes: Routes_, fallback: Reply = "network-error") {
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

async function renderPage(proposalId = "swf_prop_0001", client: QueryClient = newClient()): Promise<string> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/swf/governance/${proposalId}`]}>
          <Routes>
            <Route path="/swf/governance/:proposalId" element={<SWFGovernancePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

// The old page's sample proposal and votes, as it rendered them.
const SAMPLE_VALUES = /Increase dividend allocation to 70%|healthy at \$48K|swf_part_000[1237]|12\.5 weight|4\.2 weight|of 47/;

const PROPOSAL = {
  id: "swf_prop_0001",
  proposer: "swf_part_0100",
  title: "Fund more capability grants",
  description: "Move five points from reserve to grants for unserved capability types.",
  proposedStrategy: { dividendPercent: 55, infrastructurePercent: 30, grantsPercent: 15, reservePercent: 0 },
  votingStart: "2026-09-20T00:00:00Z",
  votingEnd: "2026-09-27T00:00:00Z",
  status: "active",
  yesVotes: 3,
  noVotes: 1,
  totalVoters: 2,
  quorumRequired: 0.3,
  createdAt: "2026-09-20T00:00:00Z",
};

const VOTES = [
  { id: "swf_vote_0101", proposalId: "swf_prop_0001", participantId: "swf_part_0101", vote: "yes", weight: 3, votedAt: "2026-09-21T10:00:00Z" },
  { id: "swf_vote_0102", proposalId: "swf_prop_0001", participantId: "swf_part_0102", vote: "no", weight: 1, votedAt: "2026-09-22T10:00:00Z" },
];

// What GET /api/swf/summary returns, money fields included: the page must not show those.
const SUMMARY: Reply = {
  status: 200,
  body: {
    summary: {
      totalBalance: "40",
      totalDistributedAllTime: "0",
      totalAccruedAllTime: "40",
      currentEpochId: "swf_epoch_0001",
      currentAllocationStrategy: { dividendPercent: 60, infrastructurePercent: 25, grantsPercent: 10, reservePercent: 5 },
      participantCount: 5,
      activeProposals: 1,
      lastDistributionAt: "2026-09-24T12:00:00Z",
      chainBalances: [{ chain: "base", currency: "USDC", amount: "40" }],
    },
  },
};

// ── outage ───────────────────────────────────────────────────────────────────

describe("gateway unreachable", () => {
  it("says the proposal couldn't be loaded and shows no sample proposal", async () => {
    stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Couldn't load this proposal");
    expect(container.querySelector('[data-live-state="unavailable"]')).not.toBeNull();
    expect(t).not.toMatch(SAMPLE_VALUES);
    expect(t).not.toContain("Strategy Comparison");
  });
});

// ── not found ────────────────────────────────────────────────────────────────

describe("an id the gateway doesn't have", () => {
  it("the route's 404 is 'Proposal not found', not an outage", async () => {
    stubFetch({
      "/api/swf/proposals/swf_prop_0099": {
        status: 404,
        body: { error: "not_found", message: "Proposal swf_prop_0099 not found" },
      },
      "/api/swf/summary": SUMMARY,
    });
    const t = await renderPage("swf_prop_0099");
    expect(t).toContain("Proposal not found");
    expect(t).toContain("The gateway has no proposal swf_prop_0099");
    expect(t).toContain("cleared when it restarts");
    expect(t).not.toContain("Couldn't load");
    expect(t).not.toMatch(SAMPLE_VALUES);
  });

  it("a 404 for a missing route is a failed read, not 'Proposal not found'", async () => {
    stubFetch({
      "/api/swf/proposals/swf_prop_0001": {
        status: 404,
        body: { message: "Route GET:/api/swf/proposals/swf_prop_0001 not found", error: "Not Found", statusCode: 404 },
      },
    });
    const t = await renderPage();
    expect(t).toContain("Couldn't load this proposal");
    expect(t).not.toContain("Proposal not found");
  });
});

// ── live data ────────────────────────────────────────────────────────────────

describe("live data", () => {
  it("renders the proposal, its votes, and the comparison with the fund's current strategy", async () => {
    const stub = stubFetch({
      "/api/swf/proposals/swf_prop_0001": { status: 200, body: { proposal: PROPOSAL, votes: VOTES, voteCount: 2 } },
      "/api/swf/summary": SUMMARY,
    });
    const t = await renderPage();
    expect(t).toContain("Fund more capability grants");
    expect(t).toContain("Move five points from reserve to grants");
    // Current 60/25/10/5 against proposed 55/30/15/0.
    expect(t).toMatch(/dividend\s*60%\s*55%\s*-5%/);
    expect(t).toMatch(/infrastructure\s*25%\s*30%\s*\+5%/);
    expect(t).toMatch(/reserve\s*5%\s*0%\s*-5%/);
    expect(t).toContain("Yes: 3.0 weight");
    expect(t).toContain("No: 1.0 weight");
    // 2 voters of 5 active participants: 40% against a 30% quorum.
    expect(t).toContain("40% turnout (2 of 5)");
    expect(t).toMatch(/Quorum 30%:\s*Met/);
    expect(t).toContain("Votes (2)");
    expect(t).toContain("swf_part_0101");
    expect(t).toContain("swf_part_0102");
    expect(t).toContain("cleared when it restarts");
    expect(t).not.toMatch(SAMPLE_VALUES);
    // The summary's ledger money is never shown.
    expect(t).not.toMatch(/\$40\.00|USDC/);
    // Reading only: no vote, execute or distribute request.
    expect(requests(stub).every((r) => r.startsWith("GET "))).toBe(true);
  });

  it("a closed proposal shows no Met/Not met from today's participant count", async () => {
    stubFetch({
      "/api/swf/proposals/swf_prop_0001": { status: 200, body: { proposal: { ...PROPOSAL, status: "rejected" }, votes: VOTES, voteCount: 2 } },
      "/api/swf/summary": SUMMARY,
    });
    const t = await renderPage();
    expect(t).toContain("rejected");
    expect(t).toContain("Quorum 30%");
    expect(t).not.toMatch(/Quorum 30%:\s*(Met|Not met)/);
  });

  it("a proposal with no votes shows an empty vote list and an empty bar", async () => {
    stubFetch({
      "/api/swf/proposals/swf_prop_0001": {
        status: 200,
        body: { proposal: { ...PROPOSAL, yesVotes: 0, noVotes: 0, totalVoters: 0 }, votes: [], voteCount: 0 },
      },
      "/api/swf/summary": SUMMARY,
    });
    const t = await renderPage();
    expect(t).toContain("No votes yet");
    expect(t).toContain("Votes (0)");
    expect(t).toMatch(/Quorum 30%:\s*Not met/);
    const bars = [...container.querySelectorAll<HTMLElement>(".bg-red-500")];
    expect(bars.map((b) => b.style.width)).toEqual(["0%"]);
  });

  it("with the fund summary unavailable, it shows the proposal and says what it couldn't read", async () => {
    stubFetch({
      "/api/swf/proposals/swf_prop_0001": { status: 200, body: { proposal: PROPOSAL, votes: VOTES, voteCount: 2 } },
      "/api/swf/summary": { status: 503, body: { error: "unavailable" } },
    });
    const t = await renderPage();
    expect(t).toContain("Fund more capability grants");
    expect(t).toContain("Couldn't load the fund's current strategy and participant count");
    expect(t).toContain("2 voters (turnout unavailable)");
    expect(t).toMatch(/Quorum 30%:\s*unknown/);
    expect(t).toMatch(/dividend\s*—\s*55%\s*—/);
    expect(t).not.toMatch(SAMPLE_VALUES);
  });

  it("a proposal body the page can't read is unavailable, not a blank proposal", async () => {
    stubFetch({
      "/api/swf/proposals/swf_prop_0001": { status: 200, body: { proposal: { id: "swf_prop_0001" }, votes: [] } },
      "/api/swf/summary": SUMMARY,
    });
    const t = await renderPage();
    expect(t).toContain("Couldn't load this proposal");
    expect(t).not.toContain("Votes (0)");
  });
});

// ── demo mode ────────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  it("shows the prototype's sample proposal under a DemoBanner and requests nothing", async () => {
    window.history.replaceState(null, "", "/swf/governance/swf_prop_0003?demo=1");
    const stub = stubFetch({});
    const t = await renderPage("swf_prop_0003");
    expect(container.querySelector('[data-live-state="demo"]')).not.toBeNull();
    expect(t).toContain("Fund governance: sample values, not live PCC state.");
    expect(t).toContain("Increase dividend allocation to 70%");
    expect(t).toContain("38% turnout (18 of 47)");
    expect(t).toContain("swf_part_0001");
    expect(stub).not.toHaveBeenCalled();
  });
});
