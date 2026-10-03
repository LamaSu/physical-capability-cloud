/**
 * Space detail: says it isn't live instead of "not found", and offers no
 * request it can't send.
 *
 * Before this change the page looked every space up in
 * api/mock-onboarding-data.ts, which is empty, so any space read "Space not
 * found". Its "Request This Space" button had no handler. GET /api/spaces/:id
 * answers with two literal spaces (routes/spaces.ts) and no gateway route
 * accepts a request for a space, so the page must show neither.
 *
 * implementer-foxtrot. The real page renders with only `fetch` replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SpaceDetailPage } from "../SpaceDetailPage.js";

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

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

async function renderPage(path = "/spaces/space-bk"): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/spaces/:spaceId" element={<SpaceDetailPage />} />
            <Route path="/spaces" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

// ── what the old page claimed, and what the fabricated route answers ────────

const OLD_NOT_FOUND = "Space not found";

/** GET /api/spaces/space-bk as routes/spaces.ts builds it. */
const GATEWAY_LITERALS: RouteReplies = {
  "/api/spaces/space-bk": {
    status: 200,
    body: {
      space: {
        id: "space-bk",
        name: "Brooklyn Maker Hub",
        address: "45 Industrial Rd, Brooklyn, NY 11222",
        dimensions: { width: 30, depth: 40, height: 14, unit: "ft" },
        power: { voltage: 208, amperage: 200, phase: 3, circuitCount: 8 },
        amenities: ["WiFi", "Loading dock", "Break room", "Parking"],
        environmentalSystems: ["HVAC", "Dust extraction", "Fume hood"],
        safetyFeatures: ["Fire suppression", "Eye wash", "First aid"],
        access: { schedule: "24/7", loadingDock: true, forklift: true },
        pricingPhase: "free",
        monthlyPrice: "0",
        sqft: 1200,
        availableSlots: 3,
        totalSlots: 8,
        rating: 4.7,
      },
    },
  },
};
const GATEWAY_LITERAL_VALUES = /Brooklyn Maker Hub|Industrial Rd|208V|Dust extraction|Fume hood|3\/8|4\.7/;

// ── (a) not live ─────────────────────────────────────────────────────────────

describe("outside demo mode", () => {
  it("with the gateway unreachable: says the detail isn't live, not that the space doesn't exist, and requests nothing", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Hosting-space detail isn't connected to live data yet");
    expect(container.querySelector('[data-live-state="not-live"]')).not.toBeNull();
    expect(t).not.toContain(OLD_NOT_FOUND);
    expect(stub).not.toHaveBeenCalled();
  });

  it("with the gateway answering its literal space: none of it is shown", async () => {
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("Hosting-space detail isn't connected to live data yet");
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(stub).not.toHaveBeenCalled();
  });
});

// ── (d) no request that can't be sent ────────────────────────────────────────

describe("requesting a space", () => {
  it("is not offered: no route accepts it, and the page says so", async () => {
    stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    const buttons = [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(buttons.filter((b) => /request|book|reserve|rent/i.test(b))).toEqual([]);
    expect(buttons).toEqual(["← Back to Spaces"]);
    expect(t).toContain("no route accepts a request for a space");
    expect(t).toContain("no request can be sent from this page");
  });

  it("the way back still works", async () => {
    stubFetch({});
    await renderPage();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe("/spaces");
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  it("still says it isn't live, with no demo banner or demo link: there are no sample spaces", async () => {
    window.history.replaceState(null, "", "/spaces/space-bk?demo=1");
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("Hosting-space detail isn't connected to live data yet");
    expect(container.querySelector('[data-live-state="demo"]')).toBeNull();
    expect([...container.querySelectorAll("a")].find((a) => /demo version/i.test(a.textContent ?? ""))).toBeUndefined();
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(stub).not.toHaveBeenCalled();
  });
});
