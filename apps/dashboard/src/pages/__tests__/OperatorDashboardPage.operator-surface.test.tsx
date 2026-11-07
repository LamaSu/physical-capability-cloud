// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));
vi.mock("@pcc/ui", () => ({
  GlassPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  GlowBadge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  UtilizationGauge: () => null,
  EarningsChart: () => null,
  CertificationBadge: () => null,
  MaintenanceTimelineItem: () => null,
  AmountDisplay: ({ amount }: { amount: string }) => <span>{amount}</span>,
}));
vi.mock("../../components/inbox/InboxPanel.js", () => ({ InboxPanel: () => <div data-testid="inbox" /> }));

import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { useAuthStore } from "../../stores/auth-store.js";
import { useOperatorStore } from "../../stores/operator-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LATHE = { id: "k1", name: "North lathe", status: "online", last_heartbeat: null };
const UNNAMED = { id: "k2", name: " ", last_heartbeat: null };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const me = (items: unknown[]) => ({ ok: true, kernels: { count: items.length, items } });
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalOperator: ReturnType<typeof useOperatorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  authorizedFetch.mockReset();
  originalAuth = useAuthStore.getState();
  originalOperator = useOperatorStore.getState();
  originalUI = useUIStore.getState();
  useAuthStore.setState({ isAuthenticated: true, keyEpoch: 42 });
  useOperatorStore.setState({ activeTab: "overview" });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  useAuthStore.setState(originalAuth);
  useOperatorStore.setState(originalOperator);
  useUIStore.setState(originalUI);
  vi.restoreAllMocks();
});

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderPage() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
  await settle();
}

function expectNoInventedValues() {
  for (const text of [
    "Active Machines", "Total Earnings", "Jobs Completed", "Reputation", "2", "142", "950", "$0",
    "Prusa MK4 Workshop", "Epilog Fusion Pro", "Story Protocol IP Revenue", "IP Revenue Dashboard",
    "6,119.50", "$429.50", "3 IP assets", "43 derivatives",
  ]) {
    expect([...container.querySelectorAll("*")].some((node) => node.textContent === text), text).toBe(false);
  }
  expect(container.querySelector('a[href="/ip"]')).toBeNull();
  expect(container.querySelector('a[href="/operator/reg-001"]')).toBeNull();
  expect(container.querySelector('a[href="/operator/reg-002"]')).toBeNull();
}

describe("operator overview from the caller's machines", () => {
  it("T13 links every caller machine under Your Machines and removes invented overview values", async () => {
    authorizedFetch.mockResolvedValueOnce(json(me([LATHE, UNNAMED])));
    await renderPage();
    expect(container.querySelector("h2")?.textContent).toBe("Your Machines");
    expect([...container.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["North lathe", "/operator/k1"],
      ["k2", "/operator/k2"],
    ]);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).toHaveBeenCalledWith("/api/agent/me", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
    expectNoInventedValues();
  });

  it.each([
    ["an empty list", me([])],
    ["withheld machines", { ok: true, kernels: { count: null, items: [], unavailable: "requires owner proof (SIWE sign-in, a session key, or a linked wallet)" } }],
    ["unavailable machines", { ok: true, kernels: { count: null, items: [], unavailable: "Section unavailable" } }],
    ["a malformed reply", me([{ ...LATHE, last_heartbeat: 42 }])],
  ])("T13 omits Your Machines for %s", async (_state, answer) => {
    authorizedFetch.mockResolvedValueOnce(json(answer));
    await renderPage();
    expect(container.querySelector("h2")).toBeNull();
    expect(container.textContent).not.toContain("Your Machines");
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expectNoInventedValues();
  });

  it("T13 omits Your Machines while the read is pending", async () => {
    authorizedFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    await renderPage();
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expectNoInventedValues();
  });

  it("T13 removes previous machine links when an identity changes", async () => {
    authorizedFetch.mockResolvedValueOnce(json(me([LATHE])));
    await renderPage();
    expect(container.querySelector('a[href="/operator/k1"]')).not.toBeNull();
    authorizedFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    await act(async () => useAuthStore.setState({ keyEpoch: 43 }));
    await settle();
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("T14 keeps exactly inbox, overview and approvals with no subtitle", async () => {
    authorizedFetch.mockImplementation(async (path: string) => path === "/api/agent/me" ? json(me([])) : json({ approvals: [] }));
    useUIStore.setState({ currentPageSubtitle: "Previous page" });
    await renderPage();
    const tabBar = container.firstElementChild!.firstElementChild!;
    expect([...tabBar.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["inbox", "overview", "approvals"]);
    expect(useUIStore.getState().currentPageTitle).toBe("Operator Dashboard");
    expect(useUIStore.getState().currentPageSubtitle).toBe("");
    await act(async () => (tabBar.querySelector("button") as HTMLButtonElement).click());
    await settle();
    expect(container.querySelector('[data-testid="inbox"]')).not.toBeNull();
    const approvals = [...tabBar.querySelectorAll("button")].find((button) => button.textContent === "approvals")!;
    await act(async () => approvals.click());
    await settle();
    expect(container.textContent).toContain("Pending Approvals");
    expect(authorizedFetch).toHaveBeenCalledWith("/api/operator/approvals?status=pending");
  });
});
