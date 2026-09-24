/**
 * The operator pages show what the gateway returned, and nothing else.
 *
 * Before this change, on master:
 * - OperatorMobilePage invented an evidence CID and a 94% anti-spoof score, a
 *   91% "match", an "issue filed" receipt and three sample jobs, and showed a
 *   hard-coded evidence timeline, kernel, operator and network.
 * - OperatorDashboardPage showed hard-coded machines, KPIs and IP revenue,
 *   aimed its E-STOP at "kernel-nanoclaw" for everyone and showed STOPPED even
 *   when the request failed, and crashed on the first real approval row.
 * - OperatorMachineDetailPage showed two hard-coded machines and nothing else.
 *
 * These tests render the real pages with the real hooks; only `fetch` (and
 * `window.confirm`) are replaced.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { OperatorMobilePage } from "../OperatorMobilePage.js";
import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { OperatorMachineDetailPage } from "../OperatorMachineDetailPage.js";
import { useAuthStore } from "../../stores/auth-store.js";
import { useOperatorStore } from "../../stores/operator-store.js";

// ── fetch stub ───────────────────────────────────────────────────────────────

type Reply = { status: number; body: unknown } | "network-error";
type Handler = Reply | ((body: Record<string, unknown> | undefined) => Reply);
type Routes = Record<string, Handler>;

let routes: Routes = {};
const posted: Array<{ key: string; body: Record<string, unknown> | undefined }> = [];

/** Matches "METHOD path?query", then "METHOD path"; unknown routes are unreachable. */
function stubFetch(r: Routes) {
  routes = r;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const withQuery = url.replace(/^https?:\/\/[^/]+/, "");
    const path = withQuery.split("?")[0]!;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (method !== "GET") posted.push({ key: `${method} ${path}`, body });
    const handler = routes[`${method} ${withQuery}`] ?? routes[`${method} ${path}`] ?? "network-error";
    const reply = typeof handler === "function" ? handler(body) : handler;
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

const NOW = new Date().toISOString();

const ME = {
  ok: true,
  as_of: NOW,
  identity: { operator: "op@example.com", key_id: "key-1", key_name: "bench key", scopes: ["operator"] },
  kernels: {
    count: 2,
    items: [
      { id: "k1", name: "Bench printer", status: "online", last_heartbeat: NOW },
      { id: "k2", name: "Laser cutter", status: "offline", last_heartbeat: null },
    ],
  },
  devices: { count: 2 },
  work: { in_flight: 1, items: [{ id: "job-real-1", kernel_id: "k1", status: "in_progress", progress: 40 }] },
  keys: { active: 1, wildcard_keys: 0 },
  next: [],
};

const SIGNED_IN: Routes = {
  "GET /api/agent/me": { status: 200, body: ME },
  "GET /api/operator/policy/k1": { status: 200, body: { policy: { emergencyStop: false }, source: "default" } },
  "GET /api/operator/policy/k2": { status: 200, body: { policy: { emergencyStop: false }, source: "default" } },
  "GET /api/jobs?kernelId=k1": {
    status: 200,
    body: { jobs: [{ id: "job-real-1", kernelId: "k1", capabilityId: "cap-1", capabilityType: "fdm-printing", status: "in_progress", progress: 40, createdAt: NOW }] },
  },
  "GET /api/jobs?kernelId=k2": { status: 200, body: { jobs: [] } },
  "GET /api/operator/approvals?kernelId=k1&status=pending": { status: 200, body: { approvals: [] } },
  "GET /api/operator/approvals?kernelId=k2&status=pending": { status: 200, body: { approvals: [] } },
};

/** Fabrications that used to appear on these pages. None may ever render. */
const INVENTED = /kernel-nanoclaw|kern-alpha-01|op-9f3a2b|Base Sepolia|Prusa MK4 Workshop|Epilog Fusion|FDM Print — Bracket|CNC Mill — Plate|Laser Engrave — Logo|Layer 42 snapshot|Material loaded|6,119\.50|\$429\.50|43 derivatives|bafybei|Matches Reference|Issue Reported/;

// ── render harness ───────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  posted.length = 0;
  useAuthStore.setState({ apiKey: "pcc_test_key", isAuthenticated: true });
  useOperatorStore.setState({ activeTab: "overview" });
  vi.stubGlobal("confirm", vi.fn(() => true));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 200; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    if (client.isFetching() === 0) break;
  }
}

async function render(page: React.ReactElement, path = "/"): Promise<string> {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0, gcTime: 0, refetchInterval: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
  return container.textContent ?? "";
}

async function waitForText(re: RegExp): Promise<string> {
  for (let i = 0; i < 300; i++) {
    const t = container.textContent ?? "";
    if (re.test(t)) return t;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return container.textContent ?? "";
}

function button(label: string | RegExp, within: ParentNode = container): HTMLButtonElement {
  const all = Array.from(within.querySelectorAll("button"));
  const b = all.find((el) => (typeof label === "string" ? el.textContent?.trim() === label : label.test(el.textContent ?? "")));
  if (!b) throw new Error(`no button ${String(label)} in: ${all.map((x) => x.textContent).join(" | ")}`);
  return b;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function pickPhoto(input: HTMLInputElement) {
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "photo.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // FileReader is asynchronous: wait for the preview to render.
  for (let i = 0; i < 300 && !container.querySelector('img[alt="Your photo"]'); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

const machineDetail = (
  <Routes>
    <Route path="/operator/:machineId" element={<OperatorMachineDetailPage />} />
  </Routes>
);

// ── outage ───────────────────────────────────────────────────────────────────

describe("gateway unreachable: the pages say so, and show nothing invented", () => {
  beforeEach(() => {
    stubFetch({});
  });

  it("dashboard", async () => {
    const t = await render(<OperatorDashboardPage />);
    expect(t).toContain("Couldn't load your machines");
    expect(t).not.toMatch(INVENTED);
    expect(t).not.toMatch(/Active Machines|Jobs Completed\s*142|Reputation\s*950|EMERGENCY STOP ACTIVE/);
  });

  it("mobile", async () => {
    const t = await render(<OperatorMobilePage />);
    expect(t).toContain("Couldn't load your machines");
    expect(container.querySelector('[data-testid="connection-badge"]')?.textContent).toContain("Can't reach PCC");
    expect(t).not.toMatch(INVENTED);
    expect(t).not.toMatch(/No active jobs/);
  });

  it("machine detail", async () => {
    const t = await render(machineDetail, "/operator/reg-001");
    expect(t).toContain("Couldn't load this machine");
    expect(t).not.toMatch(INVENTED);
    expect(t).not.toMatch(/99\.2|Utilization\s*72/);
  });

  it("earnings, certifications and maintenance are 'not recorded', never sample rows", async () => {
    for (const tab of ["earnings", "certifications", "maintenance"] as const) {
      act(() => useOperatorStore.setState({ activeTab: tab }));
      const t = await render(<OperatorDashboardPage />);
      expect(t).toContain("Not recorded yet");
      expect(t).not.toMatch(/OSHA|Replace nozzle|Firmware update|\$\d/);
    }
  });
});

describe("an account answer without a machines section", () => {
  const PARTIAL: Routes = {
    "GET /api/agent/me": { status: 200, body: { ok: true, as_of: NOW, identity: ME.identity, kernels: { count: null, items: [], unavailable: "db timeout" } } },
  };

  it("dashboard says the machines are unavailable, not that there are none", async () => {
    stubFetch(PARTIAL);
    const t = await render(<OperatorDashboardPage />);
    expect(t).toContain("Couldn't load your machines");
    expect(t).not.toMatch(/No machines are registered|EMERGENCY STOP/);
  });

  it("mobile says the same, and the account tab does not crash on missing sections", async () => {
    stubFetch({ "GET /api/agent/me": { status: 200, body: { ok: true, as_of: NOW, identity: ME.identity } } });
    let t = await render(<OperatorMobilePage />);
    expect(t).toContain("Couldn't load your machines");
    expect(t).not.toContain("No machines are registered");
    await click(button("Account"));
    t = await waitForText(/op@example\.com/);
    expect(t).toMatch(/Unavailable: unexpected response/);
  });
});

// ── signed in, gateway answering ─────────────────────────────────────────────

describe("dashboard with a real account", () => {
  it("lists the operator's own machines and in-flight work", async () => {
    stubFetch(SIGNED_IN);
    const t = await render(<OperatorDashboardPage />);
    expect(t).toContain("Bench printer");
    expect(t).toContain("Laser cutter");
    expect(t).toMatch(/Jobs in flight\s*1/);
    expect(t).toMatch(/Earnings\s*Not recorded yet/);
    expect(t).not.toMatch(INVENTED);
  });

  it("E-STOP shows a machine stopped only when the gateway confirms it and the recorded state reads back stopped", async () => {
    let stoppedK1 = false;
    stubFetch({
      ...SIGNED_IN,
      "GET /api/operator/policy/k1": () => ({
        status: 200,
        body: stoppedK1 ? { policy: { emergencyStop: true }, updatedAt: NOW } : { policy: { emergencyStop: false }, source: "default" },
      }),
      "POST /api/operator/emergency-stop": (b) => {
        if (b?.kernelId === "k1") stoppedK1 = true;
        return { status: 200, body: { stopped: true, kernelId: b?.kernelId, timestamp: NOW } };
      },
    });
    await render(<OperatorDashboardPage />);
    const panel = container.querySelector('[data-testid="estop-panel"]')!;
    await click(button("Stop", panel));
    const t = await waitForText(/confirmed by PCC/);
    expect(t).toContain("Stopped for new work (confirmed by PCC)");
    expect(t).not.toContain("NOT STOPPED");
    expect(posted.filter((p) => p.key === "POST /api/operator/emergency-stop").map((p) => p.body?.kernelId)).toEqual(["k1"]);
  });

  it("a stop the gateway answered but whose recorded state does not read back stopped is NOT STOPPED", async () => {
    stubFetch({
      ...SIGNED_IN,
      "POST /api/operator/emergency-stop": (b) => ({ status: 200, body: { stopped: true, kernelId: b?.kernelId, timestamp: NOW } }),
    });
    await render(<OperatorDashboardPage />);
    await click(button("Stop", container.querySelector('[data-testid="estop-panel"]')!));
    const t = await waitForText(/NOT STOPPED/);
    expect(t).toContain("its recorded state does not show this machine stopped");
    expect(t).not.toContain("confirmed by PCC");
  });

  it("a rejected E-STOP is NOT STOPPED, loudly, with the physical-stop instruction", async () => {
    stubFetch({
      ...SIGNED_IN,
      "POST /api/operator/emergency-stop": { status: 403, body: { error: "not_kernel_operator", message: "You can only act for a kernel you operate" } },
    });
    await render(<OperatorDashboardPage />);
    await click(button(/EMERGENCY STOP: all 2/));
    const t = await waitForText(/NOT STOPPED/);
    expect(container.querySelector('[data-testid="estop-failed"]')?.textContent).toMatch(/Bench printer.*You can only act for a kernel you operate/);
    expect(t).toContain("Use the machine's physical emergency stop now.");
    expect(t).not.toContain("confirmed by PCC");
  });

  it("an E-STOP answer for a different kernel does not count", async () => {
    stubFetch({ ...SIGNED_IN, "POST /api/operator/emergency-stop": { status: 200, body: { stopped: true, kernelId: "kernel-nanoclaw" } } });
    await render(<OperatorDashboardPage />);
    await click(button("Stop", container.querySelector('[data-testid="estop-panel"]')!));
    const t = await waitForText(/NOT STOPPED/);
    expect(t).not.toContain("confirmed by PCC");
  });

  it("approvals render the real row shape, and a failed approve keeps the row with the reason", async () => {
    const row = {
      id: "approval-1",
      kernelId: "k1",
      jobId: "job-9",
      submittedBy: "agent-7",
      jobSummary: { capabilityType: "liquid-handler", parameters: {} },
      status: "pending",
      createdAt: NOW,
      expiresAt: NOW,
    };
    let decided = false;
    stubFetch({
      ...SIGNED_IN,
      "GET /api/operator/approvals?kernelId=k1&status=pending": () => ({ status: 200, body: { approvals: decided ? [] : [row] } }),
      "POST /api/operator/approvals/approval-1/approve": { status: 404, body: { error: "Approval not found or already decided" } },
      "POST /api/operator/approvals/approval-1/reject": () => {
        decided = true;
        return { status: 200, body: { approval: { ...row, status: "rejected" }, rejected: true } };
      },
    });
    useOperatorStore.setState({ activeTab: "approvals" });
    let t = await render(<OperatorDashboardPage />);
    expect(t).toContain("liquid-handler");
    expect(t).toContain("agent-7");
    expect(t).toContain("Bench printer");

    await click(button("Approve"));
    t = await waitForText(/Not done:/);
    expect(t).toContain("Approval not found or already decided");
    expect(t).toContain("liquid-handler");

    await click(button("Reject"));
    t = await waitForText(/No approvals are waiting/);
    expect(t).not.toContain("liquid-handler");
  });
});

describe("mobile with a real account", () => {
  beforeEach(() => {
    stubFetch(SIGNED_IN);
  });

  it("lists the jobs on the operator's own machines, with no invented timeline", async () => {
    const t = await render(<OperatorMobilePage />);
    expect(container.querySelector('[data-testid="connection-badge"]')?.textContent).toContain("Connected");
    expect(t).toContain("job-real-1");
    expect(t).toContain("fdm-printing");
    expect(t).toMatch(/Reported progress\s*40%/);
    expect(t).not.toMatch(/Evidence Timeline/);
    expect(t).not.toMatch(INVENTED);
  });

  it("photo check shows the gateway's hash and says a hash-only reference is not stored", async () => {
    stubFetch({ ...SIGNED_IN, "POST /api/photo/upload": { status: 200, body: { imageHash: "sha256:abc123", cid: "photo:sha256:abc123", antiSpoofScore: 0.42 } } });
    await render(<OperatorMobilePage />);
    await click(button("Photo"));
    await pickPhoto(container.querySelector('input[type="file"][capture]') as HTMLInputElement);
    await click(button("Send for photo check"));
    const t = await waitForText(/Received by PCC/);
    expect(t).toContain("sha256:abc123");
    expect(t).toContain("Not stored: PCC kept a hash reference only.");
    expect(t).toMatch(/Anti-spoof heuristic \(advisory\)\s*42%/);
    expect(posted.find((p) => p.key === "POST /api/photo/upload")?.body).toHaveProperty("imageBase64");
    expect(t).not.toMatch(INVENTED);
  });

  it("a rejected photo check says it was not sent", async () => {
    stubFetch({ ...SIGNED_IN, "POST /api/photo/upload": { status: 400, body: { error: "missing_image", message: "Request body must include imageBase64" } } });
    await render(<OperatorMobilePage />);
    await click(button("Photo"));
    await pickPhoto(container.querySelector('input[type="file"][capture]') as HTMLInputElement);
    await click(button("Send for photo check"));
    const t = await waitForText(/Not sent/);
    expect(t).toContain("Request body must include imageBase64");
    expect(t).not.toMatch(/Received by PCC|94%|bafybei/);
  });

  it("an issue report is sent to support and shows the thread, or says it was not sent", async () => {
    stubFetch({ ...SIGNED_IN, "POST /api/operator/support": { status: 200, body: { threadId: "thread-9", messageId: "m", isNewThread: true } } });
    await render(<OperatorMobilePage />);
    await click(button("Photo"));
    await click(button("Report issue"));
    await waitForText(/Machine/);
    await choose(container.querySelector("select") as HTMLSelectElement, "k2");
    await type(container.querySelector("textarea") as HTMLTextAreaElement, "Door interlock tripped");
    await click(button("Send to support"));
    let t = await waitForText(/Sent to PCC support/);
    expect(t).toContain("thread-9");
    expect(posted.find((p) => p.key === "POST /api/operator/support")?.body).toMatchObject({ kernelId: "k2", message: "Door interlock tripped" });

    act(() => root.unmount());
    root = createRoot(container);
    stubFetch({ ...SIGNED_IN, "POST /api/operator/support": { status: 500, body: { error: "boom" } } });
    await render(<OperatorMobilePage />);
    await click(button("Photo"));
    await click(button("Report issue"));
    await waitForText(/Machine/);
    await choose(container.querySelector("select") as HTMLSelectElement, "k1");
    await type(container.querySelector("textarea") as HTMLTextAreaElement, "Smoke");
    await click(button("Send to support"));
    t = await waitForText(/Not sent/);
    expect(t).toContain("Your report did not reach PCC");
    expect(t).not.toContain("Sent to PCC support");
  });

  it("the account tab shows the key's identity and machines, not a hard-coded kernel or network", async () => {
    await render(<OperatorMobilePage />);
    await click(button("Account"));
    const t = await waitForText(/op@example\.com/);
    expect(t).toContain("Bench printer");
    expect(t).not.toMatch(INVENTED);
  });
});

describe("machine detail with a real registration", () => {
  it("shows the registration and says what is not recorded", async () => {
    stubFetch({
      "GET /api/onboard/registrations/reg-1": {
        status: 200,
        body: { registration: { id: "reg-1", name: "Bench printer MK4", manufacturer: "Prusa", model: "MK4", category: "fdm", status: "approved" } },
      },
    });
    const t = await render(machineDetail, "/operator/reg-1");
    expect(t).toContain("Bench printer MK4");
    expect(t).toContain("Prusa MK4");
    expect(t).toContain("Not recorded yet");
    expect(t).not.toMatch(INVENTED);
  });

  it("the route's 200 { error: not_found } is 'no registration'", async () => {
    stubFetch({ "GET /api/onboard/registrations/reg-404": { status: 200, body: { error: "not_found" } } });
    const t = await render(machineDetail, "/operator/reg-404");
    expect(t).toContain("No machine registration with id reg-404");
  });
});
