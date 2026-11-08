// @vitest-environment jsdom
import React, { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifySettlementRead, statusPillText,
  HELD_MILESTONE_STATUSES, RELEASE_DECIDED_MILESTONE_STATUSES, HELD_ESCROW_STATUSES,
  type ProductHomeDTO, type ProductHomeEscrowHeld,
} from "@pcc/spec";

// jsdom has neither an injected wallet nor a canvas drawing context. Keep the
// rendered pages, query hooks, gateway client, shell, and panels real.
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: undefined, isConnected: false, chain: undefined, chainId: undefined }),
  useConnect: () => ({ connectors: [], connect: vi.fn() }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
  useConnectionEffect: vi.fn(),
}));
vi.mock("../../providers/WalletProvider.js", () => ({
  WalletProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@pcc/ui", async (original) => ({
  ...await original<typeof import("@pcc/ui")>(),
  ParticleBackground: () => null,
}));

import { DashboardPage } from "../DashboardPage.js";
import { JobsPage } from "../JobsPage.js";
import { EscrowPage } from "../EscrowPage.js";
import { RevenueDashboardPage } from "../RevenueDashboardPage.js";
import { SettingsPage } from "../SettingsPage.js";
import { EscrowAmount, formatEscrowAmount } from "../../components/EscrowAmount.js";
import { KNOWN_ESCROW_STATUSES, KNOWN_JOB_STATUSES } from "../../api/wire-vocabulary.js";
import { moneyToneColor } from "../../lib/money-badge.js";
import { App } from "../../App.js";
import { useUIStore } from "../../stores/ui-store.js";
import { useAuthStore } from "../../stores/auth-store.js";
import { PanelManager } from "../../features/spatial/PanelManager.js";
import { usePanelStore } from "../../features/spatial/PanelStore.js";
import { panelRegistry } from "../../features/spatial/PanelRegistry.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { status: number; body: unknown } | "network-error";
type Routes = Record<string, Reply>;
const ok = (body: unknown): Reply => ({ status: 200, body });
const errorReply: Reply = { status: 500, body: { error: "unavailable" } };
const escrow = (changes: Record<string, unknown> = {}) => ({
  id: "escrow-a", jobId: "job-a", status: "active", totalAmount: "10", currency: "USDC",
  milestoneCount: 1, releasedCount: 0, disputedCount: 0, ...changes,
});
const identity = { operator: "operator@example.com", key_id: "key-12345678-abcd", key_name: "laptop", scopes: ["*"] };
const account = (changes: Record<string, unknown> = {}) => ({
  ok: true, as_of: "2026-09-24T12:00:00Z", identity, keys: { active: 3, wildcard_keys: 2 }, ...changes,
});
const held = (changes: Partial<ProductHomeEscrowHeld> = {}): ProductHomeEscrowHeld => ({
  state: "read", byCurrency: [], releaseDecided: { byCurrency: [], bound: "at_most" },
  uncountedMilestones: 0, unclassifiedMilestones: 0, excludedSimulatedEscrows: 0,
  heldStatuses: HELD_MILESTONE_STATUSES, releaseDecidedStatuses: RELEASE_DECIDED_MILESTONE_STATUSES, heldEscrowStatuses: HELD_ESCROW_STATUSES,
  source: "gateway_escrow_record", confirmation: "record_only", ...changes,
});
const home = (escrowHeld: ProductHomeDTO["escrowHeld"] = held()): ProductHomeDTO => ({
  schemaId: "pcc.product-home/v1", asOf: "2026-09-24T12:00:00Z",
  kernels: { state: "read", total: 0, online: 0, stale: 0, other: 0, rule: "heartbeat", source: "gateway_kernel_rows" },
  capabilities: { state: "read", total: 0, onOnlineKernels: 0, byType: [], source: "gateway_capability_rows" },
  jobs: { state: "read", total: 0, active: 0, byPhase: { pending: 0, queued: 0, dispatched: 0, running: 0, awaiting_handoff: 0, paused: 0, completed: 0, failed: 0, timed_out: 0, cancelled: 0, unknown: 0 }, source: "gateway_job_rows" },
  settlementNetwork: { name: null, chainId: null, basis: "gateway_config" }, escrowHeld,
});
const emptyRoutes = (): Routes => ({
  "/api/health": ok({ status: "ok" }), "/api/jobs": ok({ jobs: [] }),
  "/api/kernels": ok({ kernels: [] }), "/api/escrow": ok({ escrows: [] }),
  "/api/product/home": ok(home()),
});
function fetchRoutes(routes: Routes = {}, fallback: Reply = "network-error") {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "https://example.invalid").pathname;
    const reply = routes[path] ?? fallback;
    if (reply === "network-error") throw new TypeError("Failed to fetch");
    return { ok: reply.status < 300 && reply.status >= 200, status: reply.status,
      statusText: reply.status === 200 ? "OK" : "Error", headers: { get: () => null },
      json: async () => reply.body } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
function liveRoutes(changes: Routes = {}) { return fetchRoutes({ ...emptyRoutes(), ...changes }); }
function jobRows(jobs: unknown[]) { return { "/api/jobs": ok({ jobs }) }; }
function escrowRows(escrows: unknown[]) { return { "/api/escrow": ok({ escrows }) }; }
function kernelRows(kernels: unknown[]) { return { "/api/kernels": ok({ kernels }) }; }

let root: Root;
let container: HTMLDivElement;
let clients: QueryClient[];
let originalPath: string;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
beforeEach(() => {
  originalPath = window.location.pathname + window.location.search;
  originalAuth = useAuthStore.getState();
  originalUI = useUIStore.getState();
  useAuthStore.setState({ isAuthenticated: true, sessionToken: null, keyEpoch: originalAuth.keyEpoch + 1 });
  usePanelStore.getState().closeAll();
  clients = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const client of clients) client.clear();
  container.remove();
  usePanelStore.getState().closeAll();
  useAuthStore.setState(originalAuth);
  useUIStore.setState(originalUI);
  window.history.replaceState({}, "", originalPath);
  vi.unstubAllGlobals();
});
function newClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } } });
  clients.push(client);
  return client;
}
async function settled(client: QueryClient) {
  let idle = 0;
  for (let tries = 0; tries < 250 && idle < 3; tries++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    idle = client.isFetching() === 0 ? idle + 1 : 0;
  }
  expect(client.isFetching(), "all page reads settled").toBe(0);
}
async function renderPage(page: ReactElement, client = newClient()) {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>{page}</MemoryRouter></QueryClientProvider>));
  await settled(client);
  return text();
}
async function remount(page: ReactElement) {
  await act(async () => root.unmount());
  root = createRoot(container);
  return renderPage(page);
}
function text() { return container.textContent ?? ""; }
function expectSkippedEscrowRow() {
  expect.soft(text()).toContain("1 listed escrow couldn't be read and isn't shown.");
  expect.soft(text()).not.toContain("Couldn't load escrows");
  expect.soft(text()).not.toContain("escrow-a");
  expect.soft(text()).not.toMatch(/No escrows yet|No escrows|Nothing running yet|No jobs or escrows yet|No active escrows/);
}
function expectEscrowNotice(notice: string) {
  expect(text().split(notice).length - 1).toBe(1);
  expect(elementWithText(notice, "p").getAttribute("role")).toBe("status");
}
async function refresh(client: QueryClient) {
  await act(async () => { await client.refetchQueries(); });
  await settled(client);
  return text();
}
function elementWithText(value: string, selector = "*"): HTMLElement {
  const node = Array.from(container.querySelectorAll<HTMLElement>(selector)).find((element) => element.textContent === value);
  expect(node, value).toBeDefined();
  return node!;
}
function heldTile() {
  const label = elementWithText("Held in escrow (all accounts)");
  const panel = label.closest<HTMLElement>(".rounded-xl");
  expect(panel).not.toBeNull();
  return panel!;
}

async function renderedWhen(assertion: () => void) {
  let lastError: unknown;
  for (let tries = 0; tries < 350; tries++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    try { assertion(); return; } catch (error) { lastError = error; }
  }
  throw lastError;
}

// These cases cover the original page contracts once, including the two cases
// that each exercise both Command Center and Jobs or Escrow.
describe("Command Center reads", () => {
  it("reports an unreachable gateway without invented empty data", async () => {
    fetchRoutes();
    expect(await renderPage(<DashboardPage />)).toContain("Couldn't load the Command Center");
    expect(text()).not.toMatch(/Nothing running yet|Welcome to PCC|0\/0|\$0\.00|Total Value Locked|Total Locked/);
  });
  it("keeps readable jobs visible during a kernel outage", async () => {
    liveRoutes({ ...jobRows([{ id: "job-live", status: "in_progress" }]), "/api/kernels": errorReply });
    expect(await renderPage(<DashboardPage />)).toContain("job-live");
    expect(text()).toContain("Some live data couldn't be loaded");
    expect(text()).not.toMatch(/0\/0|none registered/);
  });
  it("removes counts after their refresh fails", async () => {
    liveRoutes({ ...jobRows([{ id: "job-a", status: "in_progress" }, { id: "job-b", status: "queued" }]), ...kernelRows([{ id: "kernel-a", status: "online", isStale: false }]) });
    const client = newClient();
    expect(await renderPage(<DashboardPage />, client)).toMatch(/Active Jobs\s*2/);
    expect(text()).toContain("1/1");
    fetchRoutes();
    expect(await refresh(client)).not.toMatch(/Active Jobs\s*2|1\/1/);
  });
  it("rejects the wrong jobs envelope", async () => {
    liveRoutes({ "/api/jobs": ok({ items: [{ id: "job-a", status: "queued" }] }) });
    expect(await renderPage(<DashboardPage />)).toContain("Some live data couldn't be loaded");
    expect(text()).not.toMatch(/Active Jobs\s*0/);
  });
  it("rejects the wrong kernels envelope", async () => {
    liveRoutes({ "/api/kernels": ok({ items: [{ id: "kernel-a", status: "online", isStale: false }] }) });
    expect(await renderPage(<DashboardPage />)).toContain("Some live data couldn't be loaded");
    expect(text()).not.toMatch(/0\/0|0\/1|none registered/);
  });
  it("marks a full jobs page as a lower bound on both pages", async () => {
    liveRoutes(jobRows(Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: i < 10 ? "in_progress" : "completed" }))));
    expect(await renderPage(<DashboardPage />)).toMatch(/Active Jobs\s*10\+/);
    expect(text()).toContain("40+ completed");
    expect(text()).toContain("there may be more");
    expect(await remount(<JobsPage />)).toMatch(/Total Jobs\s*50\+/);
    expect(text()).toContain("Showing the first 50 jobs");
  });
  it("shows a successful empty read", async () => {
    liveRoutes();
    expect(await renderPage(<DashboardPage />)).toContain("Nothing running yet");
    expect(text()).not.toContain("Couldn't load");
  });
  it("counts in-flight jobs and fresh online kernels", async () => {
    liveRoutes({ ...jobRows(["in_progress", "queued", "completed", "evidence_submitted"].map((status, i) => ({ id: `job-${i}`, status }))), ...kernelRows([{ id: "kernel-a", status: "online", isStale: false }, { id: "kernel-b", status: "online", isStale: true }, { id: "kernel-c", status: "offline", isStale: false }]) });
    expect(await renderPage(<DashboardPage />)).toMatch(/Active Jobs\s*2/);
    expect(text()).toContain("1/3");
    expect(text()).not.toMatch(/job-2|job-3|\$0\.00|Evidence Events|Recent Activity|Total Value Locked|Total Locked/);
  });
  it("counts an executing job on Command Center, Revenue and the Jobs active filter", async () => {
    liveRoutes(jobRows([{ id: "job-executing", status: "executing" }]));
    expect(await renderPage(<DashboardPage />)).toMatch(/Active Jobs\s*1/);
    expect(text()).toContain("job-executing");
    expect(text()).not.toContain("Submit a job or discover capabilities to get started.");
    await remount(<RevenueDashboardPage />);
    const activeCount = elementWithText("Active Jobs").nextElementSibling!.cloneNode(true) as HTMLElement;
    activeCount.querySelectorAll("style").forEach((style) => style.remove());
    expect(activeCount.textContent).toBe("1");
    await remount(<JobsPage />);
    await act(async () => elementWithText("active", "button").click());
    expect(text()).toContain("job-executing");
    expect(text()).not.toContain("No active jobs");
  });
  it.each(["preparing", "collecting_evidence", "awaiting_pickup"])("counts %s as active on Command Center", async (status) => {
    liveRoutes(jobRows([{ id: `job-${status}`, status }]));
    expect(await renderPage(<DashboardPage />)).toMatch(/Active Jobs\s*1/);
    expect(text()).toContain(`job-${status}`);
  });
  it.each(["completed", "failed", "cancelled", "evidence_submitted", "settled"])("excludes %s from active jobs on Command Center", async (status) => {
    liveRoutes(jobRows([{ id: `job-${status}`, status }]));
    expect(await renderPage(<DashboardPage />)).toMatch(/Active Jobs\s*0/);
    expect(text()).toContain("No active jobs");
    expect(text()).not.toContain(`job-${status}`);
  });
  it("rejects the entire jobs read when one status is missing", async () => {
    liveRoutes(jobRows([{ id: "job-a", status: "in_progress" }, { id: "job-b" }]));
    expect(await renderPage(<DashboardPage />)).toContain("Some live data couldn't be loaded");
    expect(text()).not.toMatch(/Active Jobs\s*[01]/);
  });
  it("rejects a kernel that omits staleness", async () => {
    liveRoutes(kernelRows([{ id: "kernel-a", status: "online" }]));
    expect(await renderPage(<DashboardPage />)).toContain("Some live data couldn't be loaded");
    expect(text()).not.toMatch(/1\/1|0\/1/);
  });
  it("leaves out an escrow that omits status and says so", async () => {
    liveRoutes(escrowRows([{ id: "escrow-a" }]));
    await renderPage(<DashboardPage />);
    expectSkippedEscrowRow();
  });
  it("qualifies an empty active list after only one jobs page", async () => {
    liveRoutes(jobRows(Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: "completed" }))));
    expect(await renderPage(<DashboardPage />)).toContain("No active jobs in the first 50");
    expect(text()).toContain("there may be active jobs beyond them");
  });
  it("uses the escrow row currency", async () => {
    liveRoutes(escrowRows([escrow({ currency: "ETH" })]));
    expect(await renderPage(<DashboardPage />)).toContain("ETH");
    expect(text()).not.toMatch(/USDC|\$10\.00/);
  });
  it("leaves out a malformed escrow amount on both pages and says so", async () => {
    liveRoutes(escrowRows([escrow({ totalAmount: "not-money" })]));
    await renderPage(<DashboardPage />);
    expectSkippedEscrowRow();
    expect(text()).not.toContain("0.00");
    await remount(<EscrowPage />);
    expectSkippedEscrowRow();
    expect(text()).not.toContain("0.00");
  });
  it("rejects an unknown job status", async () => {
    liveRoutes(jobRows([{ id: "job-a", status: "unexpected" }]));
    expect(await renderPage(<DashboardPage />)).toContain("Some live data couldn't be loaded");
  });
  it("rejects an unknown kernel status without a ratio", async () => {
    liveRoutes(kernelRows([{ id: "kernel-a", status: "unexpected", isStale: false }]));
    expect(await renderPage(<DashboardPage />)).toContain("Some live data couldn't be loaded");
    expect(text()).not.toMatch(/0\/1|1\/1/);
  });
  it("accepts an expired kernel without counting it online", async () => {
    liveRoutes(kernelRows([{ id: "kernel-a", status: "expired", isStale: false }, { id: "kernel-b", status: "online", isStale: false }]));
    expect(await renderPage(<DashboardPage />)).toContain("1/2");
    expect(text()).not.toContain("Some live data couldn't be loaded");
  });
  it("counts exactly the known statuses whose execution phase is not terminal", async () => {
    const active = new Set(["pending", "queued", "in_progress", "paused", "executing", "active", "preparing", "collecting_evidence", "awaiting_pickup"]);
    const jobs = [...KNOWN_JOB_STATUSES].map((status) => ({ id: `job-${status}`, status }));
    liveRoutes(jobRows(jobs));
    await renderPage(<DashboardPage />);
    expect(elementWithText("Active Jobs").nextElementSibling?.textContent).toBe(String(active.size));
    for (const { id, status } of jobs) expect(text().includes(id), status).toBe(active.has(status));
  });
});

describe("Jobs reads", () => {
  it("reports an unreachable gateway", async () => {
    fetchRoutes();
    expect(await renderPage(<JobsPage />)).toContain("Couldn't load jobs");
    expect(text()).not.toContain("No jobs yet");
  });
  it("shows a successful empty list", async () => {
    liveRoutes();
    expect(await renderPage(<JobsPage />)).toContain("No jobs yet");
  });
  it("qualifies a filtered empty result after one page", async () => {
    liveRoutes(jobRows(Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: "completed" }))));
    await renderPage(<JobsPage />);
    await act(async () => elementWithText("active", "button").click());
    expect(text()).toContain("No active jobs in the first 50");
    expect(text()).toContain("Only the first 50 jobs were read");
  });
  it("rejects an unknown status instead of counting it", async () => {
    liveRoutes(jobRows([{ id: "job-a", status: "unexpected" }]));
    expect(await renderPage(<JobsPage />)).toContain("Couldn't load jobs");
    expect(text()).not.toMatch(/Total Jobs\s*1/);
  });
  it("accepts and counts all known job statuses without adding money", async () => {
    const jobs = [...KNOWN_JOB_STATUSES].map((status, i) => ({ id: `job-${i}`, status }));
    liveRoutes(jobRows(jobs));
    expect(await renderPage(<JobsPage />)).toMatch(new RegExp(`Total Jobs\\s*${jobs.length}(?!\\d|\\+)`));
    expect(text()).not.toMatch(/Couldn't load jobs|\$0\.00|USDC/);
  });
});

describe("Escrow reads", () => {
  it("reports an unreachable gateway", async () => {
    fetchRoutes();
    expect(await renderPage(<EscrowPage />)).toContain("Couldn't load escrows");
    expect(text()).not.toMatch(/No escrows yet|Total Locked|Challenge Windows/);
  });
  it("shows a successful empty list", async () => {
    liveRoutes();
    expect(await renderPage(<EscrowPage />)).toContain("No escrows yet");
  });
  it("uses the row currency", async () => {
    liveRoutes(escrowRows([escrow({ currency: "ETH" })]));
    expect(await renderPage(<EscrowPage />)).toContain("ETH");
    expect(text()).not.toMatch(/USDC|\$10\.00/);
  });
  it("leaves out a currency outside the escrow vocabulary and says so", async () => {
    liveRoutes(escrowRows([escrow({ currency: "XYZ" })]));
    await renderPage(<EscrowPage />);
    expectSkippedEscrowRow();
    expect(text()).not.toContain("USDC");
  });
  it("leaves out an unknown status and says so", async () => {
    liveRoutes(escrowRows([escrow({ status: "unexpected" })]));
    await renderPage(<EscrowPage />);
    expectSkippedEscrowRow();
  });
  it("accepts every known escrow status", async () => {
    const escrows = [...KNOWN_ESCROW_STATUSES].map((status, i) => escrow({ id: `escrow-${i}`, status }));
    liveRoutes(escrowRows(escrows));
    expect(await renderPage(<EscrowPage />)).toMatch(new RegExp(`Escrows\\s*${escrows.length}\\s*all states`));
    expect(text()).not.toContain("Couldn't load escrows");
  });
  it("preserves a large USDC amount digit for digit", async () => {
    liveRoutes(escrowRows([escrow({ totalAmount: "12345678901234567.89" })]));
    expect(await renderPage(<EscrowPage />)).toContain("$12,345,678,901,234,567.89");
    expect(text()).toContain("USDC");
  });
  it("keeps DAI amounts free of a dollar sign", async () => {
    liveRoutes(escrowRows([escrow({ totalAmount: "10.5", currency: "DAI" })]));
    expect(await renderPage(<EscrowPage />)).toContain("10.50");
    expect(text()).toContain("DAI");
    expect(text()).not.toMatch(/\$|USDC/);
  });
  it("leaves out inconsistent milestone counts and says so", async () => {
    liveRoutes(escrowRows([escrow({ releasedCount: 1, disputedCount: 1 })]));
    await renderPage(<EscrowPage />);
    expectSkippedEscrowRow();
  });
  it("leaves out signed, exponent, grouped, and noncanonical amounts and says so", async () => {
    for (const totalAmount of ["-10", "1e3", "1,000", "010", " 10", "10.", ".5"]) {
      liveRoutes(escrowRows([escrow({ totalAmount })]));
      await remount(<EscrowPage />);
      expectSkippedEscrowRow();
    }
  });
});

describe("Revenue reads", () => {
  it("shows the active job count without a phase list", async () => {
    liveRoutes(jobRows([{ id: "job-a", status: "awaiting_pickup" }]));
    await renderPage(<RevenueDashboardPage />);
    expect(text()).not.toContain("pending, queued, running or paused");
    expect(elementWithText("Active Jobs").parentElement?.children).toHaveLength(2);
  });
  it("reports an unreachable gateway without claiming revenue", async () => {
    fetchRoutes();
    expect(await renderPage(<RevenueDashboardPage />)).toMatch(/Couldn't load (jobs|escrows)/);
    expect(text()).not.toMatch(/No jobs or escrows yet|Total Revenue|\$0\.00/);
  });
  it("labels a failed refresh of both lists", async () => {
    liveRoutes();
    const client = newClient();
    await renderPage(<RevenueDashboardPage />, client);
    fetchRoutes();
    expect(await refresh(client)).toContain("Couldn't refresh jobs and escrows");
  });
  it("hides the empty state after a failed refresh of an empty successful read", async () => {
    liveRoutes();
    const client = newClient();
    expect(await renderPage(<RevenueDashboardPage />, client)).toContain("No jobs or escrows yet");
    fetchRoutes();
    expect(await refresh(client)).toContain("Couldn't refresh jobs and escrows");
    expect(text()).not.toContain("No jobs or escrows yet");
  });
  it("uses the active escrow currency", async () => {
    liveRoutes(escrowRows([escrow({ currency: "ETH" })]));
    expect(await renderPage(<RevenueDashboardPage />)).toContain("ETH");
    expect(text()).not.toMatch(/USDC|\$10\.00/);
  });
  it("qualifies the absence of completed jobs after a full page", async () => {
    liveRoutes(jobRows(Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: "in_progress" }))));
    expect(await renderPage(<RevenueDashboardPage />)).toContain("in the first 50");
    expect(text()).not.toContain("No completed jobs yet");
  });
});

describe("Settings account sections", () => {
  it("reports an account outage and a disconnected wallet independently", async () => {
    fetchRoutes();
    expect(await renderPage(<SettingsPage />)).toContain("Couldn't load your account");
    expect(text()).toContain("No wallet connected");
    expect(text()).not.toMatch(/0x1234|1,000\.00|USDC|Base Sepolia|Tier 1|Auto-fund/);
  });
  it("rejects an unexpected account shape", async () => {
    fetchRoutes({ "/api/agent/me": ok({ ok: true }) });
    expect(await renderPage(<SettingsPage />)).toContain("Couldn't load your account");
  });
  it("shows the operator, key and scopes returned by the gateway", async () => {
    fetchRoutes({ "/api/agent/me": ok(account()) });
    expect(await renderPage(<SettingsPage />)).toContain("operator@example.com");
    expect(text()).toContain("laptop");
    expect(text()).toContain("All scopes (*)");
    expect(text()).toContain("2 of your keys can use every scope");
    expect(text()).not.toMatch(/1,000\.00|USDC/);
  });
  it("rejects an identity without a key identifier", async () => {
    fetchRoutes({ "/api/agent/me": ok(account({ identity: { operator: identity.operator, key_name: "laptop", scopes: ["*"] } })) });
    expect(await renderPage(<SettingsPage />)).toContain("Couldn't load your account");
    expect(text()).toContain("No wallet connected");
  });
  it("shows the reason key counts are unavailable", async () => {
    fetchRoutes({ "/api/agent/me": ok(account({ keys: { active: null, wildcard_keys: 0, unavailable: "db down" } })) });
    expect(await renderPage(<SettingsPage />)).toContain("unavailable (db down)");
    expect(text()).not.toContain("of your keys can use every scope");
  });
  it("treats an omitted keys section as unavailable", async () => {
    fetchRoutes({ "/api/agent/me": ok(account({ keys: undefined })) });
    expect(await renderPage(<SettingsPage />)).toContain("unavailable");
    expect(text()).not.toContain("unavailable (");
  });
  it("rejects negative and fractional key counts", async () => {
    for (const active of [-1, 2.5]) {
      fetchRoutes({ "/api/agent/me": ok(account({ keys: { active, wildcard_keys: 0 } })) });
      expect(await remount(<SettingsPage />)).toMatch(/Active keys\s*unavailable/);
      expect(text()).not.toMatch(/Active keys\s*-1|2\.5/);
    }
  });
  it("rejects wildcard key counts greater than active key counts", async () => {
    fetchRoutes({ "/api/agent/me": ok(account({ keys: { active: 1, wildcard_keys: 2 } })) });
    expect(await renderPage(<SettingsPage />)).toMatch(/Active keys\s*unavailable/);
    expect(text()).not.toContain("2 of your keys");
  });
});

describe("EscrowAmount", () => {
  it("formats canonical decimals without rounding or losing digits", () => {
    for (const [input, output] of [["0", "0.00"], ["10", "10.00"], ["1234.5", "1,234.50"], ["0.004", "0.004"], ["1000000.000100", "1,000,000.0001"], ["123456789012345678901234567890.123456789012345678", "123,456,789,012,345,678,901,234,567,890.123456789012345678"]]) {
      expect(formatEscrowAmount(input)).toBe(output);
    }
  });
  it("shows an unavailable amount without digits for invalid direct inputs", async () => {
    for (const [amount, currency] of [["not-money", "USDC"], [undefined, "USDC"], ["10", "XYZ"], ["10", undefined], [10, "USDC"]]) {
      expect(await remount(<EscrowAmount amount={amount} currency={currency} />)).toContain("—");
      expect(text()).toContain("amount unavailable");
      expect(text()).not.toMatch(/\d/);
    }
  });
});

const moneyPages = [
  { name: "Command Center", page: () => <DashboardPage /> },
  { name: "Escrow", page: () => <EscrowPage /> },
  { name: "Revenue", page: () => <RevenueDashboardPage /> },
];
describe.each(moneyPages)("$name escrow failures", ({ name, page }) => {
  it("rejects the wrong escrows envelope", async () => {
    liveRoutes({ "/api/escrow": ok({ items: [escrow()] }) });
    expect(await renderPage(page())).toContain("Couldn't load escrows");
    expect(text()).not.toMatch(/No escrows yet|No escrows|Nothing running yet|No jobs or escrows yet|No active escrows|Escrows\s*0/);
    if (name === "Command Center") expect(text()).toMatch(/Escrows\s*—/);
  });
  it.each([{ name: "HTTP failure", reply: errorReply }, { name: "network error", reply: "network-error" as Reply }])("shows an unavailable read for $name", async ({ reply }) => {
    liveRoutes({ "/api/escrow": reply });
    expect(await renderPage(page())).toContain("Couldn't load escrows");
    expect(text()).not.toMatch(/No escrows yet|No escrows|Nothing running yet|No jobs or escrows yet|No active escrows|Active Escrows\s*0/);
    if (name === "Command Center") expect(text()).toMatch(/Escrows\s*—/);
    else if (name === "Escrow") expect(text()).not.toMatch(/Escrows\s*0/);
  });
  it.each([
    { name: "missing amount", changes: { totalAmount: undefined } },
    { name: "malformed amount", changes: { totalAmount: "unreadable" } },
    { name: "unknown currency", changes: { currency: "XYZ" } },
    { name: "missing currency", changes: { currency: undefined } },
  ])("leaves out a row with $name and says so, without manufacturing money", async ({ changes }) => {
    liveRoutes(escrowRows([escrow(changes)]));
    await renderPage(page());
    expectSkippedEscrowRow();
    expect(text()).not.toMatch(/0\.00|USDC/);
  });
});

describe.each(moneyPages)("$name escrow rows that can't be read", ({ name, page }) => {
  it("shows the readable row and says one listed row was left out", async () => {
    liveRoutes(escrowRows([escrow(), escrow({ id: "escrow-unreadable", status: "unexpected", totalAmount: "777", currency: "ETH" })]));
    await renderPage(page());
    expect(text()).toContain("escrow-a");
    expectEscrowNotice("1 listed escrow couldn't be read and isn't shown.");
    expect(text()).not.toMatch(/escrow-unreadable|777|ETH/);
    expect(text()).not.toContain("Couldn't load escrows");
    expect(text()).not.toMatch(/No escrows yet|No escrows|Nothing running yet|No jobs or escrows yet|No active escrows/);
    if (name === "Command Center") expect(text()).toMatch(/Escrows\s*1\+/);
    if (name === "Escrow") {
      expect(text()).toMatch(/Escrows\s*1\+\s*all states/);
      expect(text()).toMatch(/Active Escrows\s*1\+\s*of 1\+ total/);
      expect(text()).toMatch(/Milestones\s*1\+/);
    }
  });
  it("says how many listed rows were left out when none can be read", async () => {
    liveRoutes(escrowRows([
      escrow({ id: "escrow-unreadable", status: "unexpected", totalAmount: "777", currency: "ETH" }),
      escrow({ id: "escrow-unreadable-2", totalAmount: "888", currency: "XYZ" }),
    ]));
    await renderPage(page());
    expectEscrowNotice("2 listed escrows couldn't be read and aren't shown.");
    expect(text()).not.toMatch(/escrow-unreadable|777|888|ETH|XYZ/);
    expect(text()).not.toContain("Couldn't load escrows");
    expect(text()).not.toMatch(/No escrows yet|No escrows|Nothing running yet|No jobs or escrows yet|No active escrows/);
    if (name === "Command Center") expect(text()).toMatch(/Escrows\s*0\+/);
    if (name === "Escrow") {
      expect(text()).toMatch(/Escrows\s*0\+\s*all states/);
      expect(text()).toMatch(/Active Escrows\s*0\+\s*of 0\+ total/);
      expect(text()).toMatch(/Milestones\s*0\+/);
    }
  });
  it("shows exact counts and no notice when every listed row is readable", async () => {
    liveRoutes(escrowRows([escrow()]));
    await renderPage(page());
    expect(text()).toContain("escrow-a");
    expect(text()).not.toContain("couldn't be read");
    if (name === "Command Center") expect(text()).toMatch(/Escrows\s*1(?!\+)/);
    if (name === "Escrow") {
      expect(text()).toMatch(/Escrows\s*1\s*all states/);
      expect(text()).toMatch(/Active Escrows\s*1\s*of 1 total/);
      expect(text()).toMatch(/Milestones\s*1(?!\+)/);
    }
  });
});

const toneClass = { green: "text-green-400", gold: "text-gold-300", red: "text-red-400", gray: "text-white/60" };
function expectMoneyBadge(row: ReturnType<typeof escrow>) {
  const mapped = classifySettlementRead(row, { path: "/api/escrow", live: true });
  const expected = mapped.label ?? statusPillText(row.status, false, true);
  const rowElement = elementWithText(row.id, "span").parentElement!;
  const badges = rowElement.querySelectorAll<HTMLElement>("span.rounded-full");
  expect(badges).toHaveLength(1);
  const badge = badges[0]!;
  expect(badge.textContent).toBe(expected);
  expect(badge.classList.contains(toneClass[moneyToneColor(mapped.tone)])).toBe(true);
}
describe("settlement badges follow the canonical map", () => {
  for (const { name, page } of moneyPages.slice(0, 2)) {
    it.each([...KNOWN_ESCROW_STATUSES])(`${name} maps %s text and colour`, async (status) => {
      const row = escrow({ status });
      liveRoutes(escrowRows([row]));
      await renderPage(page());
      expectMoneyBadge(row);
    });
  }
  it("Revenue maps its active row and omits inactive rows", async () => {
    const row = escrow();
    liveRoutes(escrowRows([row, escrow({ id: "inactive-row", status: "released" })]));
    await renderPage(<RevenueDashboardPage />);
    expectMoneyBadge(row);
    expect(text()).not.toContain("inactive-row");
  });
});

function tileRoutes(section: ProductHomeDTO["escrowHeld"]) { liveRoutes({ "/api/product/home": ok(home(section)) }); }
const usdc = { currency: "USDC", decimals: 6, amountBaseUnits: "12000000", milestones: 1 };
const eth = { currency: "ETH", decimals: 18, amountBaseUnits: "3000000000000000000", milestones: 1 };
describe("held escrow records", () => {
  it("shows currencies separately without summing them or restoring old totals", async () => {
    tileRoutes(held({ byCurrency: [usdc, eth] }));
    await renderPage(<DashboardPage />);
    const amounts = Array.from(heldTile().querySelectorAll('[data-amount="value"]')).map((node) => node.textContent);
    expect(amounts).toEqual(["$12.00USDC", "3.00ETH"]);
    expect(text()).not.toMatch(/Total Value Locked|Total Locked/);
    expect(heldTile().textContent).toContain("From escrow records for every account; no chain read confirms it.");
  });
  it("shows None held only for a fully classified empty result", async () => {
    tileRoutes(held());
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("None held");
    expect(heldTile().querySelector('[data-amount="value"]')).toBeNull();
  });
  it("shows a dash instead of None held when only a decided release remains", async () => {
    tileRoutes(held({ byCurrency: [], uncountedMilestones: 0, unclassifiedMilestones: 0,
      releaseDecided: { bound: "at_most", byCurrency: [{ ...usdc, amountBaseUnits: "7000000" }] } }));
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("—");
    expect(heldTile().textContent).not.toContain("None held");
    expect(heldTile().textContent).toContain("at most $7.00USDC, release decided, payout not finished");
  });
  it("does not call an uncounted funded currency empty", async () => {
    tileRoutes(held({ uncountedMilestones: 1 }));
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("—");
    expect(heldTile().textContent).toContain("1 milestone(s) couldn't be added to these figures.");
    expect(heldTile().textContent).not.toContain("None held");
  });
  it.each([
    { record: "created escrow with evidence_submitted milestone", unclassifiedMilestones: 1 },
    { record: "unknown milestone word", unclassifiedMilestones: 1 },
  ])("does not call $record empty", async ({ unclassifiedMilestones }) => {
    // These are HTTP read-model outputs. Classification is the gateway's job.
    tileRoutes(held({ unclassifiedMilestones }));
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("—");
    expect(heldTile().textContent).toContain("1 milestone(s) couldn't be classified from the records, so they aren't counted.");
    expect(heldTile().textContent).not.toContain("None held");
  });
  it.each(["Escrow records could not be read.", "Escrow records carry no tenant, so a tenant-scoped held total cannot be computed."])("shows the unavailable section reason: %s", async (reason) => {
    tileRoutes({ state: "unavailable", reason });
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("Couldn't load escrows");
    expect(heldTile().textContent).toContain(reason);
    expect(heldTile().textContent).not.toMatch(/\d|None held/);
  });
  it("shows no digits after an HTTP failure", async () => {
    liveRoutes({ "/api/product/home": errorReply });
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("Couldn't load escrows");
    expect(heldTile().textContent).not.toMatch(/\d|None held/);
  });
  it("removes the last good figure after a failed refresh", async () => {
    tileRoutes(held({ byCurrency: [usdc] }));
    const client = newClient();
    await renderPage(<DashboardPage />, client);
    expect(heldTile().textContent).toContain("12.00");
    liveRoutes({ "/api/product/home": errorReply });
    await refresh(client);
    expect(heldTile().textContent).toContain("Couldn't load escrows");
    expect(heldTile().textContent).not.toMatch(/\d|None held/);
  });
  it("treats a malformed reply as unavailable without crashing", async () => {
    liveRoutes({ "/api/product/home": ok({ escrowHeld: held({ byCurrency: [usdc] }) }) });
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("Couldn't load escrows");
    expect(heldTile().textContent).not.toMatch(/\d|None held/);
  });
  it("rejects an escrow-held confirmation other than record_only", async () => {
    liveRoutes({ "/api/product/home": ok({ ...home(),
      escrowHeld: { ...held({ byCurrency: [usdc] }), confirmation: "chain_confirmed" } }) });
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("Couldn't load escrows");
    expect(heldTile().textContent).not.toMatch(/\d|None held/);
  });
  it("rejects a release-decided bound other than at_most", async () => {
    liveRoutes({ "/api/product/home": ok({ ...home(), escrowHeld: { ...held({ byCurrency: [usdc] }),
      releaseDecided: { bound: "exact", byCurrency: [{ ...usdc, amountBaseUnits: "7000000" }] } } }) });
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).toContain("Couldn't load escrows");
    expect(heldTile().textContent).not.toMatch(/\d|None held/);
  });
  it("keeps decided releases on their own line apart from held amounts", async () => {
    tileRoutes(held({ byCurrency: [usdc], releaseDecided: { bound: "at_most", byCurrency: [{ ...usdc, amountBaseUnits: "7000000" }, eth] } }));
    await renderPage(<DashboardPage />);
    const tile = heldTile();
    expect(tile.textContent).toContain("$12.00USDC");
    expect(tile.textContent).not.toContain("19.00");
    const lines = Array.from(tile.querySelectorAll("p, div")).filter((node) => /^at most/.test(node.textContent ?? "") && !Array.from(node.children).some((child) => /^at most/.test(child.textContent ?? "")));
    expect(lines.map((node) => node.textContent)).toEqual(["at most $7.00USDC, release decided, payout not finished", "at most 3.00ETH, release decided, payout not finished"]);
  });
  it.each([
    { field: "uncountedMilestones", sentence: "2 milestone(s) couldn't be added to these figures." },
    { field: "unclassifiedMilestones", sentence: "2 milestone(s) couldn't be classified from the records, so they aren't counted." },
    { field: "excludedSimulatedEscrows", sentence: "2 simulated escrow(s) left out." },
  ])("shows $field only when nonzero", async ({ field, sentence }) => {
    tileRoutes(held());
    await renderPage(<DashboardPage />);
    expect(heldTile().textContent).not.toMatch(/milestone\(s\)|simulated escrow\(s\)/);
    tileRoutes(held({ [field]: 2 }));
    await remount(<DashboardPage />);
    expect(heldTile().textContent).toContain(sentence);
    const otherSentences = ["couldn't be added", "couldn't be classified", "simulated escrow(s) left out"].filter((fragment) => !sentence.includes(fragment));
    for (const other of otherSentences) expect(heldTile().textContent).not.toContain(other);
  });
  it("has no inline glow", async () => {
    tileRoutes(held({ byCurrency: [usdc] }));
    await renderPage(<DashboardPage />);
    expect(heldTile().style.boxShadow).toBe("");
    for (const child of heldTile().querySelectorAll<HTMLElement>("[style]")) expect(child.style.boxShadow).toBe("");
  });
});

function expectScope(label: string, count = 1) {
  expect(text().split(label).length - 1).toBe(count);
  const lines = Array.from(container.querySelectorAll<HTMLElement>("p")).filter((element) => element.textContent === label);
  const line = lines[lines.length - 1]!;
  expect(line.classList.contains("text-xs")).toBe(true);
  expect(line.classList.contains("text-white/30")).toBe(true);
  expect(line.parentElement?.firstElementChild).toBe(line);
}
it("Command Center shows the escrow account scope once when loaded and when the read fails", async () => {
  const label = "Every account's escrows, as the gateway records them.";
  liveRoutes(escrowRows([escrow()]));
  const client = newClient();
  expect(await renderPage(<DashboardPage />, client)).toContain("escrow-a");
  expectScope(label, 2);
  liveRoutes({ "/api/escrow": errorReply });
  expect(await refresh(client)).toContain("Couldn't load escrows");
  expectScope(label, 2);
  liveRoutes(jobRows([{ id: "job-a", status: "queued" }]));
  expect(await refresh(client)).toContain("No escrows");
  expectScope(label, 2);
});
it.each([
  { tile: "Active Jobs", label: "Your account's jobs, as the gateway records them.", route: "/api/jobs", rows: jobRows([{ id: "job-a", status: "queued" }]) },
  { tile: "Kernels Online", label: "Every account's kernels, as the gateway records them.", route: "/api/kernels", rows: kernelRows([{ id: "kernel-a", status: "online", isStale: false }]) },
  { tile: "Escrows", label: "Every account's escrows, as the gateway records them.", route: "/api/escrow", rows: escrowRows([escrow()]) },
])("Command Center $tile tile shows its scope line once when loaded and when its read fails", async ({ tile, label, route, rows }) => {
  function expectTileScope() {
    const panel = elementWithText(tile).closest(".rounded-xl")!;
    expect(panel.textContent!.split(label).length - 1).toBe(1);
    const line = panel.lastElementChild!;
    expect(line.tagName.toLowerCase()).toBe("p");
    expect(line.textContent).toBe(label);
    expect(line.classList.contains("text-xs")).toBe(true);
    expect(line.classList.contains("text-white/30")).toBe(true);
  }
  liveRoutes(rows);
  const client = newClient();
  await renderPage(<DashboardPage />, client);
  expectTileScope();
  liveRoutes({ ...rows, [route]: errorReply });
  await refresh(client);
  expect(elementWithText(tile).closest(".rounded-xl")!.textContent).toContain("unavailable");
  expectTileScope();
});
const scopePages = [
  { id: "escrow", path: "/escrow", label: "Every account's escrows, as the gateway records them." },
  { id: "revenue", path: "/operator/revenue", label: "Your jobs, and escrows across the network (earnings need settled income, not yet served)" },
];
describe.each(scopePages)("$id account scope in both shells", ({ id, path, label }) => {
  for (const failure of [false, true]) {
    it(`dashboard shell shows the scope once when ${failure ? "the read fails" : "loaded"}`, async () => {
      liveRoutes(failure ? { "/api/escrow": errorReply } : escrowRows([escrow()]));
      useUIStore.getState().setMode("dashboard");
      window.history.replaceState({}, "", path);
      await act(async () => root.render(<App />));
      await renderedWhen(() => {
        expect(text()).toContain(failure ? "Couldn't load escrows" : "escrow-a");
        expectScope(label);
      });
    });
    it(`spatial panel shows the scope once when ${failure ? "the read fails" : "loaded"}`, async () => {
      liveRoutes(failure ? { "/api/escrow": errorReply } : escrowRows([escrow()]));
      const entry = panelRegistry[id]!;
      usePanelStore.getState().openPanel(id, entry.title, entry.component);
      const client = newClient();
      await renderPage(<PanelManager />, client);
      await renderedWhen(() => {
        expect(text()).toContain(failure ? "Couldn't load escrows" : "escrow-a");
        expectScope(label);
      });
    });
  }
});


describe("money page details", () => {
  it("counts the summary milestones without inventing milestone rows", async () => {
    liveRoutes(escrowRows([escrow({ milestoneCount: 7 }), escrow({ id: "escrow-b", milestoneCount: 4, status: "released" })]));
    expect(await renderPage(<EscrowPage />)).toMatch(/Milestones\s*11/);
    expect(text()).not.toMatch(/Total Locked|Challenge Windows|Total Milestones/);
    await act(async () => elementWithText("escrow-a", "span").click());
    expect(text()).toContain("File a dispute");
  });
  it("labels retained escrow rows after their refresh fails", async () => {
    liveRoutes(escrowRows([escrow()]));
    const client = newClient();
    await renderPage(<EscrowPage />, client);
    liveRoutes({ "/api/escrow": errorReply });
    expect(await refresh(client)).toContain("Couldn't refresh escrows");
    expect(text()).toContain("escrow-a");
  });
  it("shows the revenue empty state only after both reads succeed empty", async () => {
    liveRoutes();
    expect(await renderPage(<RevenueDashboardPage />)).toContain("No jobs or escrows yet");
    expect(text()).not.toMatch(/Total Revenue|\$0\.00/);
  });
});
