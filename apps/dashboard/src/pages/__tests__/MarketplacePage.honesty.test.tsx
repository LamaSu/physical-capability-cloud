/**
 * Equipment Marketplace: the market overview says it isn't live instead of
 * showing an empty market, and the live template matcher shows only what the
 * gateway answers.
 *
 * Before this change the page charted equipment classes, demand and supply,
 * a demand map, trends and price history from api/mock-onboarding-data.ts,
 * whose exports are empty. It rendered "Equipment Classes (0)" under filter
 * buttons, which reads as "nothing is on the market". No gateway route serves
 * real market data: GET /api/marketplace/classes and /demand-supply answer
 * with literal classes and a generated curve (routes/marketplace.ts), so the
 * page must not show those either.
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

import { MarketplacePage } from "../MarketplacePage.js";

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

/** The matcher's search is a plain fetch, not a query: wait for what it renders. */
async function waitFor(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function renderPage(): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <MarketplacePage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
  return container.textContent ?? "";
}

function typeInto(input: Element | null | undefined, value: string): void {
  if (!(input instanceof HTMLInputElement)) throw new Error("input was not rendered");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label);
}

/** Types a description into the template matcher and presses Match. */
async function match(description: string) {
  typeInto(container.querySelector('input[placeholder^="What do you need?"]'), description);
  await act(async () => {
    button("Match")!.click();
  });
  await waitFor(() => !(container.textContent ?? "").includes("Matching…"));
  return container.textContent ?? "";
}

// ── what the page used to show, and what the fabricated routes answer ──────

/** The old page's empty market, as rendered: a count of zero under filters over nothing. */
const OLD_EMPTY_MARKET = /Equipment Classes \(\d+\)/;

/** The literal records GET /api/marketplace/classes and /demand-supply return (routes/marketplace.ts). */
const GATEWAY_LITERALS: Routes = {
  "/api/marketplace/classes": {
    status: 200,
    body: {
      classes: [
        {
          id: "ec-fdm",
          name: "FDM 3D Printer",
          category: "additive-manufacturing",
          description: "Desktop and industrial FDM printers",
          snapshot: { equipmentClassId: "ec-fdm", networkMachineCount: 47, averageUtilization: 72, averageJobValue: "28.50", demandLevel: "high" },
        },
        {
          id: "ec-cnc",
          name: "CNC Mill",
          category: "subtractive-manufacturing",
          description: "3-axis to 5-axis CNC milling centers",
          snapshot: { equipmentClassId: "ec-cnc", networkMachineCount: 18, averageUtilization: 85, averageJobValue: "187.00", demandLevel: "high" },
        },
      ],
    },
  },
  "/api/marketplace/demand-supply": {
    status: 200,
    body: { timeline: [{ month: 1, demand: 100, supply: 80 }] },
  },
};
const GATEWAY_LITERAL_VALUES = /FDM 3D Printer|CNC Mill|28\.50|187\.00|\b47\b|additive-manufacturing/;

const MATCH_ROUTE = "/api/capabilities/templates/match";

/** What POST /api/capabilities/templates/match returns: every template, ranked (routes/orchestrator-templates.ts). */
const MATCHES = {
  matches: [
    { slug: "physical-operator", score: 0.125, reason: "Matched physical-operator keywords: printing, shop" },
    { slug: "data-product", score: 0, reason: "Default — no data-product keywords matched" },
  ],
};

// ── (a) the market overview isn't live ───────────────────────────────────────

describe("market overview", () => {
  it("with the gateway unreachable: says it isn't live, shows no empty market, requests nothing", async () => {
    const stub = stubFetch({});
    const t = await renderPage();
    expect(t).toContain("The equipment market overview isn't connected to live data yet");
    expect(t).toContain("GET /api/marketplace/classes and /api/marketplace/demand-supply return fixed sample records");
    expect(container.querySelector('[data-live-state="not-live"]')).not.toBeNull();
    expect(t).not.toMatch(OLD_EMPTY_MARKET);
    // No demand filters over data the page doesn't have.
    for (const label of ["All", "high", "medium", "low"]) expect(button(label)).toBeUndefined();
    expect(stub).not.toHaveBeenCalled();
  });

  it("with the gateway answering its literal classes: still not live, and none of them is shown", async () => {
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("The equipment market overview isn't connected to live data yet");
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(t).not.toMatch(OLD_EMPTY_MARKET);
    expect(stub).not.toHaveBeenCalled();
  });

  it("offers no demo version (there are no sample values) and still links the ROI planner", async () => {
    stubFetch({});
    await renderPage();
    const demoLink = [...container.querySelectorAll("a")].find((a) => /demo version/i.test(a.textContent ?? ""));
    expect(demoLink).toBeUndefined();
    expect(button("ROI Calculator →")).toBeDefined();
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("in demo mode", () => {
  it("still says the market overview isn't live: there are no sample values to label", async () => {
    window.history.replaceState(null, "", "/marketplace?demo=1");
    const stub = stubFetch(GATEWAY_LITERALS);
    const t = await renderPage();
    expect(t).toContain("The equipment market overview isn't connected to live data yet");
    expect(container.querySelector('[data-live-state="demo"]')).toBeNull();
    expect(t).not.toMatch(GATEWAY_LITERAL_VALUES);
    expect(t).not.toMatch(OLD_EMPTY_MARKET);
    expect(stub).not.toHaveBeenCalled();
  });
});

// ── (c) the live template matcher ────────────────────────────────────────────

describe("template matcher (live)", () => {
  it("shows the gateway's ranked answer: its reasons and scores", async () => {
    const stub = stubFetch({ [MATCH_ROUTE]: { status: 200, body: MATCHES } });
    await renderPage();
    const t = await match("I run a 3D printing shop");
    expect(t).toContain("Matched physical-operator keywords: printing, shop");
    expect(t).toContain("match 13%");
    expect(t).toContain("Default — no data-product keywords matched");
    expect(stub).toHaveBeenCalledTimes(1);
    const [input, init] = stub.mock.calls[0]!;
    expect(pathOf(input)).toBe(MATCH_ROUTE);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ input: "I run a 3D printing shop" });
    // The matcher is public: no key is attached to it.
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/authorization|x-api-key/i);
  });

  it("an empty answer says there are no matches", async () => {
    stubFetch({ [MATCH_ROUTE]: { status: 200, body: { matches: [] } } });
    await renderPage();
    const t = await match("something unusual");
    expect(t).toContain("No matches");
  });

  it("with the gateway unreachable: shows the failure, not invented matches", async () => {
    stubFetch({});
    await renderPage();
    const t = await match("I run a 3D printing shop");
    expect(t).toContain("Failed to fetch");
    expect(t).not.toContain("Matched physical-operator keywords");
    expect(t).not.toMatch(/match \d+%/);
  });

  it("an HTTP error is shown as an error, not as an empty result", async () => {
    stubFetch({ [MATCH_ROUTE]: { status: 500, body: { error: "internal" } } });
    await renderPage();
    const t = await match("I run a 3D printing shop");
    expect(t).toContain("HTTP 500");
    expect(t).not.toContain("No matches");
  });
});

// ── (d) no action over data the page doesn't have ────────────────────────────

describe("actions", () => {
  it("offers no negotiate or purchase action for equipment classes it can't show", async () => {
    stubFetch(GATEWAY_LITERALS);
    await renderPage();
    const labels = [...container.querySelectorAll("button, a")].map((b) => (b.textContent ?? "").trim());
    expect(labels.filter((l) => /negotiate|buy|purchase|order|register a/i.test(l))).toEqual([]);
    expect(container.textContent).not.toContain("pcc negotiate");
  });
});
