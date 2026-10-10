/**
 * Find a Space: says the directory isn't live instead of "no spaces".
 *
 * Before this change the page listed hosting spaces from
 * api/mock-onboarding-data.ts, which is empty, so it always said "No spaces
 * match your filters" under search, size, access and sort controls that
 * filtered nothing. GET /api/spaces and POST /api/spaces/match answer with two
 * literal spaces and a random match score (routes/spaces.ts), so the page
 * must not show those either.
 *
 * implementer-foxtrot. The real page renders with only `fetch` replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SpaceFinderPage } from "../SpaceFinderPage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type RouteReplies = Record<string, Reply>;

function pathOf(input: RequestInfo | URL): string {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
}

function stubFetch(routes: RouteReplies, fallback: Reply = "network-error") {
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

// Two idle ticks in a row within 2 s: a query can read as idle for one tick between retries.
async function settle(client: QueryClient) {
  let idleTicks = 0;
  for (let i = 0; i < 200 && idleTicks < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    idleTicks = client.isFetching() === 0 ? idleTicks + 1 : 0;
  }
}

async function renderPage(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/spaces"]}>
          <SpaceFinderPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

// ── what the old page claimed, and what the fabricated routes answer ────────

const OLD_NO_SPACES = "No spaces match your filters";

const SPACE_BK = {
  id: "space-bk",
  name: "Brooklyn Maker Hub",
  address: "45 Industrial Rd, Brooklyn, NY 11222",
  access: { schedule: "24/7", loadingDock: true, forklift: true },
  pricingPhase: "free",
  monthlyPrice: "0",
  sqft: 1200,
  availableSlots: 3,
  totalSlots: 8,
  rating: 4.7,
};
const SPACE_SF = {
  ...SPACE_BK,
  id: "space-sf",
  name: "SF Fabrication Center",
  address: "120 Townsend St, San Francisco, CA 94107",
  sqft: 875,
  availableSlots: 1,
  totalSlots: 6,
  rating: 4.5,
};

/** GET /api/spaces and POST /api/spaces/match as routes/spaces.ts builds them. */
const GATEWAY_LITERALS: RouteReplies = {
  "/api/spaces": { status: 200, body: { spaces: [SPACE_BK, SPACE_SF] } },
  "/api/spaces/match": { status: 200, body: { matches: [{ ...SPACE_BK, matchScore: 88 }] } },
};
const GATEWAY_LITERAL_VALUES = /Brooklyn Maker Hub|SF Fabrication Center|Industrial Rd|Townsend St|4\.7|1200/;

// ── (a) not live ─────────────────────────────────────────────────────────────

describe("outside demo mode", () => {
  it("with the gateway unreachable: says the directory isn't live, not that there are no spaces, and requests nothing", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("The hosting-space directory isn't connected to live data yet");
    expect(t).toContain("GET /api/spaces and POST /api/spaces/match return fixed sample spaces");
    expect(container.querySelector('[data-live-state="not-live"]')).not.toBeNull();
    expect(t).not.toContain(OLD_NO_SPACES);
    expect(stub).not.toHaveBeenCalled();
  });

  it("with the gateway answering its literal spaces: none of them is shown", async () => {
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("The hosting-space directory isn't connected to live data yet");
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(t).not.toMatch(/match \d+%|\b88\b/);
    expect(stub).not.toHaveBeenCalled();
  });

  it("offers no search, filters or sorting over data it doesn't have, and no demo version", async () => {
    stubFetch({});
    await renderPage();
    expect(container.querySelectorAll("input")).toHaveLength(0);
    const buttons = [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(buttons.filter((b) => /^(all|24\/7|business-hours|scheduled|match|sqft|rating|slots)$/.test(b))).toEqual([]);
    expect([...container.querySelectorAll("a")].find((a) => /demo version/i.test(a.textContent ?? ""))).toBeUndefined();
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  it("still says it isn't live: there are no sample spaces to label", async () => {
    window.history.replaceState(null, "", "/spaces?demo=1");
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("The hosting-space directory isn't connected to live data yet");
    expect(container.querySelector('[data-live-state="demo"]')).toBeNull();
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(t).not.toContain(OLD_NO_SPACES);
    expect(stub).not.toHaveBeenCalled();
  });
});
