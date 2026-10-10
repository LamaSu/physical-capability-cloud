/**
 * SystemDashboard's status badges: each one must come from what was actually
 * read, never from a hardcoded claim (product review #3985, PR #408).
 *
 *   - GatewayCard's "Online": green only when this session's own gateway
 *     health read (useGatewayHealth, GET /api/health) succeeded with
 *     status "ok". A neutral "Unreachable" when it failed, "Checking"
 *     while it's in flight.
 *   - EscrowActivityCard's "Base Sepolia": a neutral configuration label,
 *     never green — it isn't a live status.
 *   - AgentPackageCard's "Published": shown only when the agent package was
 *     actually fetched. No route on this page serves it (see
 *     NotLiveSections's "isn't connected to live data yet"), so the one
 *     real caller always passes `fetched={false}` and the badge never
 *     renders.
 *
 * These badges render only in the demo view (?demo=1) — see
 * SystemDashboardPage.honesty.test.tsx for the live view, which has no
 * equivalents of them.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SystemDashboardPage } from "../SystemDashboardPage.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;

function stubFetch(routes: Routes, fallback: Reply = "network-error") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
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

async function settle(client: QueryClient): Promise<void> {
  // Two idle ticks in a row: a query can read as idle for one tick between retries.
  let idleTicks = 0;
  for (let i = 0; i < 200 && idleTicks < 2; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    idleTicks = client.isFetching() === 0 ? idleTicks + 1 : 0;
  }
}

async function renderDemoPage(): Promise<void> {
  window.history.replaceState(null, "", "/system?demo=1");
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <SystemDashboardPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle(client);
}

/**
 * The Badge whose visible text is exactly `label`. Badge (SystemDashboardPage.tsx)
 * is a <span> wrapping one status-dot <span> plus its text child, so exactly one
 * element child picks out a Badge instead of some other span with that text.
 */
function badge(label: string): HTMLElement | undefined {
  return [...container.querySelectorAll("span")].find(
    (el) => el.children.length === 1 && el.textContent?.trim() === label,
  ) as HTMLElement | undefined;
}

function isGreen(el: HTMLElement | undefined): boolean {
  return !!el && /emerald/.test(el.className);
}

// ── GatewayCard: "Online" ────────────────────────────────────────────────────

describe("GatewayCard's Online badge", () => {
  it("is green, and reads 'Online', only when the health check succeeds with status ok", async () => {
    stubFetch({ "/api/health": { status: 200, body: { status: "ok" } } });
    await renderDemoPage();
    const online = badge("Online");
    expect(online).toBeDefined();
    expect(isGreen(online)).toBe(true);
    expect(badge("Unreachable")).toBeUndefined();
    expect(badge("Checking")).toBeUndefined();
  });

  it("is a neutral 'Unreachable', never green, when the health read fails", async () => {
    stubFetch({}); // /api/health has no route here, so the one call the page makes fails
    await renderDemoPage();
    expect(badge("Online")).toBeUndefined();
    const unreachable = badge("Unreachable");
    expect(unreachable).toBeDefined();
    expect(isGreen(unreachable)).toBe(false);
  });
});

// ── EscrowActivityCard: "Base Sepolia" ───────────────────────────────────────

describe("EscrowActivityCard's Base Sepolia badge", () => {
  it("is a neutral configuration label, never green, regardless of gateway health", async () => {
    stubFetch({ "/api/health": { status: 200, body: { status: "ok" } } });
    await renderDemoPage();
    const sepolia = badge("Base Sepolia");
    expect(sepolia).toBeDefined();
    expect(isGreen(sepolia)).toBe(false);
  });
});

// ── AgentPackageCard: "Published" ────────────────────────────────────────────

describe("AgentPackageCard's Published badge", () => {
  it("never renders: no route on this page ever actually fetches the agent package", async () => {
    stubFetch({ "/api/health": { status: 200, body: { status: "ok" } } });
    await renderDemoPage();
    expect(container.textContent ?? "").not.toContain("Published");
    expect(badge("Published")).toBeUndefined();
  });
});
