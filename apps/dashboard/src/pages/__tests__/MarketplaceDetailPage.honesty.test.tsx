/**
 * Equipment class detail: says it isn't live instead of "not found".
 *
 * Before this change the page looked every class up in
 * api/mock-onboarding-data.ts, which is empty, so any class read "Equipment
 * class not found". GET /api/marketplace/classes/:id answers with literal
 * classes and a Math.sin price history (routes/marketplace.ts), so the page
 * must not show those either.
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

import { MarketplaceDetailPage } from "../MarketplaceDetailPage.js";

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

async function renderPage(path = "/marketplace/ec-fdm"): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/marketplace/:classId" element={<MarketplaceDetailPage />} />
            <Route path="/marketplace" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

// ── what the old page claimed, and what the fabricated route answers ────────

const OLD_NOT_FOUND = "Equipment class not found";

/** GET /api/marketplace/classes/ec-fdm as routes/marketplace.ts builds it. */
const GATEWAY_LITERALS: RouteReplies = {
  "/api/marketplace/classes/ec-fdm": {
    status: 200,
    body: {
      class: {
        id: "ec-fdm",
        name: "FDM 3D Printer",
        category: "additive-manufacturing",
        description: "Desktop and industrial FDM printers",
        commonMaterials: ["PLA", "PETG", "ABS"],
        typicalTolerances: ["±0.2mm"],
      },
      snapshot: { equipmentClassId: "ec-fdm", networkMachineCount: 47, averageUtilization: 72, averageJobValue: "28.50", queueDepthAverage: 2.3, trendDirection: "up", trendPercent: 12 },
      priceHistory: [{ date: "2026-03-01", price: 28.5 }],
    },
  },
};
const GATEWAY_LITERAL_VALUES = /FDM 3D Printer|28\.50|\b47\b|PETG|±0\.2mm|\+12%/;

// ── (a) not live ─────────────────────────────────────────────────────────────

describe("outside demo mode", () => {
  it("with the gateway unreachable: says the detail isn't live, not that the class doesn't exist, and requests nothing", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("Equipment class detail isn't connected to live data yet");
    expect(t).toContain("GET /api/marketplace/classes/:id returns fixed sample classes");
    expect(container.querySelector('[data-live-state="not-live"]')).not.toBeNull();
    expect(t).not.toContain(OLD_NOT_FOUND);
    expect(stub).not.toHaveBeenCalled();
  });

  it("with the gateway answering its literal class: none of it is shown", async () => {
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("Equipment class detail isn't connected to live data yet");
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(t).not.toContain(OLD_NOT_FOUND);
    expect(stub).not.toHaveBeenCalled();
  });

  it("offers no demo version and no action but the way back", async () => {
    stubFetch({});
    await renderPage();
    expect([...container.querySelectorAll("a")].find((a) => /demo version/i.test(a.textContent ?? ""))).toBeUndefined();
    const buttons = [...container.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
    expect(buttons).toEqual(["← Back to Marketplace"]);
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe("/marketplace");
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  it("still says it isn't live: there are no sample values to label", async () => {
    window.history.replaceState(null, "", "/marketplace/ec-fdm?demo=1");
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("Equipment class detail isn't connected to live data yet");
    expect(container.querySelector('[data-live-state="demo"]')).toBeNull();
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(t).not.toContain(OLD_NOT_FOUND);
    expect(stub).not.toHaveBeenCalled();
  });
});
