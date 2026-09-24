/**
 * The System Dashboard shows what /api/telemetry/system reports, or says it couldn't.
 *
 * Renders the real page with real react-query; only `fetch` is replaced.
 * Before this change the page expected a shape the route has never sent
 * (protocol fees, chain deployments, route and test counts, sponsor statuses):
 *   - with the gateway down it showed built-in defaults as the platform's
 *     state: 347 routes, 3300 tests, a 1.50% fee, 154 agent tools, a Base
 *     Sepolia contract, under "showing static defaults";
 *   - with the gateway up it crashed on the real answer (`protocol` of undefined).
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

// ── what the page used to show, and what the gateway sends ──────────────────

/** Values the old page showed from its built-in defaults (now src/demo/SystemDashboardPage.fixtures.ts), as displayed. */
const OLD_FIXTURE_VALUES = [
  "347", // gateway.routeCount
  "3300", // gateway.testCount
  "1.50%", // protocol fee
  "150 bps",
  "154", // agentPackage.toolCount
  "0x9e81...6454", // the Base Sepolia contract address
  "1Click (chaindefuser)",
  "showing static defaults",
];

function expectNoFixtures(text: string) {
  for (const value of OLD_FIXTURE_VALUES) expect(text).not.toContain(value);
}

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

/** A report shaped the way packages/gateway/src/routes/status.ts builds it. */
const REPORT = {
  timestamp: iso(0),
  uptime_seconds: 93_784, // 1d 2h
  response_ms: 3.4,
  db: {
    // KernelDTOs from the kernel facade (facades/populators/kernel.populator.ts)
    kernels: [
      { id: "kernel-a", name: "Shop A", operatorAddress: "op-a@example.test", status: "online", isStale: false, capabilityCount: 2, capabilityTypes: ["3d-printing", "cnc"] },
      { id: "kernel-b", name: "Shop B", operatorAddress: "op-a@example.test", status: "online", isStale: true, capabilityCount: 0, capabilityTypes: [] },
      { id: "kernel-c", name: "Lab C", operatorAddress: "0x5eed00000000000000000000000000000000c0de", status: "offline", isStale: false, capabilityCount: 2, capabilityTypes: ["3d-printing", "hplc"] },
    ],
    // Always empty: kernel list entries carry no devices.
    devices: [],
    jobs: [
      { id: "job-1", capabilityId: "cap-1", kernelId: "kernel-a", status: "in_progress", assuranceTier: 1 },
      { id: "job-2", capabilityId: "cap-1", kernelId: "kernel-a", status: "queued", assuranceTier: 1 },
      { id: "job-3", capabilityId: "cap-2", kernelId: "kernel-a", status: "completed", assuranceTier: 2 },
      { id: "job-4", capabilityId: "cap-3", kernelId: "kernel-c", status: "failed", assuranceTier: 0 },
      { id: "job-5", capabilityId: "cap-3", kernelId: "kernel-c", status: "completed", assuranceTier: 1 },
    ],
    // evidence_bundles rows
    evidence: [
      { id: "eb-1", jobId: "job-3", stepId: "s1", kernelId: "kernel-a", assuranceTier: 1, bundleHash: "sha256:aa", kernelSignature: { signer: "k", algorithm: "ed25519", value: "sig" }, createdAt: iso(90_000) },
      { id: "eb-2", jobId: "job-3", stepId: "s2", kernelId: "kernel-a", assuranceTier: 2, bundleHash: "sha256:bb", kernelSignature: { signer: "k", algorithm: "ed25519", value: "sig" }, createdAt: iso(30_000) },
      { id: "eb-3", jobId: "job-5", stepId: "s1", kernelId: "kernel-c", assuranceTier: 1, bundleHash: "sha256:cc", kernelSignature: { signer: "k", algorithm: "ed25519", value: "sig" }, createdAt: iso(60_000) },
    ],
    // machine_registrations rows
    registrations: [
      { id: "reg-1", name: "Prusa MK4", category: "3d-printing", manufacturer: "Prusa", model: "MK4", status: "active", createdAt: iso(500_000) },
      { id: "reg-2", name: "Agilent 1260", category: "hplc", manufacturer: "Agilent", model: "1260", status: "submitted", createdAt: iso(400_000) },
    ],
    // capabilities rows
    capabilities: [
      { id: "cap-1", kernelId: "kernel-a", type: "3d-printing", name: "FDM" },
      { id: "cap-2", kernelId: "kernel-a", type: "cnc", name: "Mill" },
      { id: "cap-3", kernelId: "kernel-c", type: "3d-printing", name: "FDM" },
      { id: "cap-4", kernelId: "kernel-c", type: "hplc", name: "HPLC" },
    ],
  },
  agents: {
    conversations: [
      { id: "conv-1", participants: ["agent-user", "agent-broker"], messages: [], status: "active", topic: "quote", createdAt: iso(120_000), updatedAt: iso(10_000) },
      { id: "conv-2", participants: ["agent-broker", "agent-kernel"], messages: [], status: "completed", topic: "job", createdAt: iso(300_000), updatedAt: iso(200_000) },
    ],
    recentMessages: [
      { id: "m1", conversationId: "conv-1", from: "agent-user", to: "agent-broker", intent: { type: "quote_request" }, timestamp: iso(10_000) },
      { id: "m2", conversationId: "conv-1", from: "agent-broker", to: "agent-user", intent: { type: "quote_response" }, timestamp: iso(20_000) },
      { id: "m3", conversationId: "conv-2", from: "agent-broker", to: "agent-kernel", intent: { type: "job_assign" }, timestamp: iso(200_000) },
    ],
  },
  audit: [
    { eventType: "job.submitted", actor: "op-a@example.test", action: "POST /api/jobs/submit", ip: "203.0.113.9", userAgent: "curl/8.5" },
  ],
  env: {
    PCC_NETWORK: "base-sepolia",
    EVIDENCE_STORAGE: null,
    STORACHA_SPACE_DID: null,
    STARKNET_ACCOUNT_ADDRESS: "set",
    LIT_PROTOCOL_REAL: null,
    ESCROW_CONTRACT_ADDRESS: "0x7e57000000000000000000000000000000c0ffee",
    NODE_ENV: "production",
  },
};

const EMPTY_REPORT = {
  timestamp: iso(0),
  uptime_seconds: 42,
  response_ms: 0.8,
  db: { kernels: [], devices: [], jobs: [], evidence: [], registrations: [], capabilities: [] },
  agents: { conversations: [], recentMessages: [] },
  audit: [],
  env: {
    PCC_NETWORK: null,
    EVIDENCE_STORAGE: null,
    STORACHA_SPACE_DID: null,
    STARKNET_ACCOUNT_ADDRESS: null,
    LIT_PROTOCOL_REAL: null,
    ESCROW_CONTRACT_ADDRESS: null,
    NODE_ENV: null,
  },
};

const ROUTE = "/api/telemetry/system";

const DENIED: Reply = {
  status: 401,
  body: { error: "api_key_required", message: "This endpoint requires authentication." },
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
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

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

async function renderPage(): Promise<{ client: QueryClient; text: () => string }> {
  const client = new QueryClient({
    // Retry immediately so a failure settles fast.
    defaultOptions: { queries: { retryDelay: 0, gcTime: 0 } },
  });
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
  return { client, text: () => container.textContent ?? "" };
}

/**
 * The value shown for `label` inside the card titled `title`: a MetricRow's
 * value, a BigNumber's figure or a job badge's count.
 */
function valueIn(title: string, label: string): string | null {
  const heading = [...container.querySelectorAll("h3")].find((h) => h.textContent === title);
  const card = heading?.closest(".space-y-4");
  if (!card) return null;
  for (const el of card.querySelectorAll("span, div")) {
    if (el.children.length > 0 || el.textContent !== label) continue;
    if (el.tagName === "SPAN" && el.nextElementSibling) return el.nextElementSibling.textContent; // MetricRow
    if (el.previousElementSibling) return el.previousElementSibling.textContent; // BigNumber, job badge
  }
  return null;
}

// ── (a) gateway unreachable ──────────────────────────────────────────────────

describe("gateway unreachable", () => {
  it("says the report is unavailable and shows none of the old defaults", async () => {
    stubFetch({});
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load the system report");
    expect(t).toContain("Protocol economics isn't connected to live data yet");
    expectNoFixtures(t);
    expect(t).not.toContain("The report lists no");
    expect(t).not.toMatch(/Registered|Records|Bundles/);
  });

  it("an HTTP error (401) is unavailable with the server's reason", async () => {
    stubFetch({ [ROUTE]: DENIED });
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load the system report");
    expect(t).toContain("This endpoint requires authentication.");
    expectNoFixtures(t);
  });

  it("a 2xx answer that isn't a system report is unavailable, not a page of zeros", async () => {
    stubFetch({ [ROUTE]: { status: 200, body: { ok: true } } });
    const t = (await renderPage()).text();
    expect(t).toContain("Couldn't load the system report");
    expect(t).toContain("The gateway's answer wasn't a system report.");
    expect(t).not.toContain("The report lists no");
    expectNoFixtures(t);
  });
});

// ── (b) demo mode ────────────────────────────────────────────────────────────

describe("demo mode (?demo=1)", () => {
  it("shows the prototype's sample values under the demo banner and calls no gateway route", async () => {
    window.history.replaceState(null, "", "/system?demo=1");
    const fetchMock = stubFetch({});
    const t = (await renderPage()).text();
    expect(t).toContain("Demo data");
    expect(t).toContain("System dashboard: sample values, not live PCC state.");
    expect(t).toContain("347");
    expect(t).toContain("3300");
    expect(t).toContain("1.50%");
    expect(t).toContain("0x9e81...6454");
    expect(t).toContain("1Click (chaindefuser)");
    expect(t).not.toContain("Couldn't load");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── (c) live data ────────────────────────────────────────────────────────────

describe("gateway answering", () => {
  it("renders counts over the lists the report returns", async () => {
    const fetchMock = stubFetch({ [ROUTE]: { status: 200, body: REPORT } });
    const t = (await renderPage()).text();

    expect(valueIn("Kernels", "Registered")).toBe("3");
    expect(valueIn("Kernels", "Online")).toBe("1"); // kernel-b is online with a stale heartbeat
    expect(valueIn("Kernels", "Operators")).toBe("2");
    expect(valueIn("Kernels", "Online, Stale Heartbeat")).toBe("1");
    expect(valueIn("Kernels", "Other Statuses")).toBe("offline 1");

    expect(valueIn("Jobs", "Jobs")).toBe("5");
    expect(valueIn("Jobs", "Active")).toBe("2");
    expect(valueIn("Jobs", "Done")).toBe("2");
    expect(valueIn("Jobs", "Failed")).toBe("1");
    expect(valueIn("Jobs", "Cancelled")).toBe("0");

    expect(valueIn("Gateway", "Uptime")).toBe("1d 2h");
    expect(valueIn("Gateway", "Report Took")).toBe("3.4 ms");
    expect(valueIn("Gateway", "Reported At")).toBe(new Date(REPORT.timestamp).toLocaleTimeString());

    expect(valueIn("Capabilities", "Records")).toBe("4");
    expect(valueIn("Capabilities", "Types")).toBe("3");
    expect(valueIn("Capabilities", "Kernels")).toBe("2");

    expect(valueIn("Machine Registrations", "Registrations")).toBe("2");
    expect(valueIn("Machine Registrations", "active")).toBe("1");
    expect(valueIn("Machine Registrations", "submitted")).toBe("1");

    expect(valueIn("Evidence", "Bundles")).toBe("3");
    expect(valueIn("Evidence", "Tier 1")).toBe("2");
    expect(valueIn("Evidence", "Tier 2")).toBe("1");
    expect(valueIn("Evidence", "Latest")).toBe(new Date(iso(30_000)).toLocaleString());

    expect(valueIn("Agent Bus", "Conversations")).toBe("2");
    expect(valueIn("Agent Bus", "Active")).toBe("1");
    expect(valueIn("Agent Bus", "Recent Messages")).toBe("3");
    expect(valueIn("Agent Bus", "Latest Message")).toBe(new Date(iso(10_000)).toLocaleString());

    expect(valueIn("Configuration", "PCC_NETWORK")).toBe("base-sepolia");
    expect(valueIn("Configuration", "NODE_ENV")).toBe("production");
    expect(valueIn("Configuration", "EVIDENCE_STORAGE")).toBe("Not set");
    expect(valueIn("Configuration", "STARKNET_ACCOUNT_ADDRESS")).toBe("Set");
    expect(valueIn("Configuration", "ESCROW_CONTRACT_ADDRESS")).toBe("0x7e57...ffee");

    // What the route doesn't report stays marked, and nothing invented fills it.
    expect(t).toContain("Protocol economics isn't connected to live data yet");
    expect(t).toContain("The chain and data-stack overview isn't connected to live data yet");
    expectNoFixtures(t);
    // Audit entries carry client IPs; the page doesn't show them.
    expect(t).not.toContain("203.0.113.9");
    expect(t).not.toContain("Couldn't load");
    // The page only reads.
    for (const [, init] of fetchMock.mock.calls) expect(init?.method ?? "GET").toBe("GET");
  });

  it("an empty report shows what the report lists, not zeros or the old defaults", async () => {
    stubFetch({ [ROUTE]: { status: 200, body: EMPTY_REPORT } });
    const t = (await renderPage()).text();
    for (const what of ["kernels", "jobs", "capabilities", "machine registrations", "evidence bundles", "agent conversations"]) {
      expect(t).toContain(`The report lists no ${what}.`);
    }
    expect(valueIn("Kernels", "Registered")).toBeNull();
    expect(valueIn("Jobs", "Active")).toBeNull();
    expect(valueIn("Configuration", "PCC_NETWORK")).toBe("Not set");
    expect(valueIn("Gateway", "Uptime")).toBe("42s");
    expectNoFixtures(t);
    expect(t).not.toContain("Couldn't load");
  });

  it("a full page of jobs is counted as a lower bound", async () => {
    const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: i < 10 ? "in_progress" : "completed" }));
    stubFetch({ [ROUTE]: { status: 200, body: { ...REPORT, db: { ...REPORT.db, jobs } } } });
    const t = (await renderPage()).text();
    expect(valueIn("Jobs", "Jobs")).toBe("50+");
    expect(valueIn("Jobs", "Active")).toBe("10+");
    expect(valueIn("Jobs", "Done")).toBe("40+");
    expect(t).toContain("first 50 jobs, so these counts are lower bounds");
  });

  it("a list the report left out is 'not included', not zero", async () => {
    const { kernels: _omitted, ...dbWithoutKernels } = REPORT.db;
    stubFetch({ [ROUTE]: { status: 200, body: { ...REPORT, db: dbWithoutKernels, env: undefined } } });
    const t = (await renderPage()).text();
    expect(t).toContain("The report didn't include the kernel list.");
    expect(t).toContain("The report didn't include the environment settings.");
    expect(valueIn("Kernels", "Registered")).toBeNull();
    expect(valueIn("Jobs", "Jobs")).toBe("5");
  });

  it("agent conversations the report left out are not 'none', even when its message list is empty", async () => {
    stubFetch({ [ROUTE]: { status: 200, body: { ...REPORT, agents: { recentMessages: [] } } } });
    const t = (await renderPage()).text();
    expect(t).not.toContain("The report lists no agent conversations.");
    expect(valueIn("Agent Bus", "Conversations")).toBe("—");
    expect(valueIn("Agent Bus", "Recent Messages")).toBe("0");
  });

  it("a failed refresh keeps the earlier report and marks it stale", async () => {
    stubFetch({ [ROUTE]: { status: 200, body: REPORT } });
    const { client, text } = await renderPage();
    expect(valueIn("Kernels", "Registered")).toBe("3");

    stubFetch({});
    await act(async () => {
      await client.refetchQueries();
    });
    await settle(client);
    const t = text();
    expect(t).toContain("Couldn't refresh the system report");
    expect(valueIn("Kernels", "Registered")).toBe("3");
    expect(valueIn("Gateway", "Uptime")).toBe("1d 2h");
    expectNoFixtures(t);
  });
});
