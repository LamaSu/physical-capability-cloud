// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));
vi.mock("../../components/inbox/InboxPanel.js", () => ({ InboxPanel: () => null }));

import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { useAuthStore } from "../../stores/auth-store.js";
import { useOperatorStore } from "../../stores/operator-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { kernelsOf } from "../../lib/operator-api.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UNAVAILABLE = "Your machines can't be read right now. Use each machine's physical emergency stop.";
const UNTRUSTED = "<b>Private server diagnostics</b>";
const LATHE = { id: "owned-lathe-72", name: "North lathe", status: "online", last_heartbeat: null };
const PRINTER = { id: "owned-printer-41", name: "West printer", status: "online", last_heartbeat: "2026-10-16T10:00:00.000Z" };
const ROUTER = { id: "owned-router-86", name: "South router", last_heartbeat: null };
const OWNER_PROOF_COPY = "Your machines aren't shown for this sign-in: PCC needs proof that you own them. Sign in with your wallet (or use a linked wallet) to see and stop them here. Until then, use each machine's physical emergency stop.";
const OWNER_PROOF_KERNELS = {
  count: null,
  items: [],
  unavailable: "requires owner proof (SIWE sign-in, a session key, or a linked wallet)",
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalOperator: ReturnType<typeof useOperatorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  authorizedFetch.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
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
  vi.unstubAllGlobals();
});

function me(items: unknown[]) {
  return {
    ok: true,
    as_of: "2026-10-16T10:00:00.000Z",
    identity: { operator: "operator-owned", key_id: "key-owned", key_name: null, scopes: ["*"] },
    kernels: { count: items.length, items },
    devices: { count: 0 },
    work: { in_flight: 0, items: [] },
    keys: { active: 1, wildcard_keys: 1 },
    next: [],
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function ownerProofAnswer(kernels: unknown = OWNER_PROOF_KERNELS) {
  const unavailable = OWNER_PROOF_KERNELS.unavailable;
  return {
    ...me([]),
    kernels,
    devices: { count: null, unavailable },
    work: { in_flight: null, items: [], unavailable },
    keys: { active: null, wildcard_keys: null, unavailable },
    next: [unavailable],
  };
}

function stopReply(id: string, status = 200) {
  return json({ stopped: true, kernelId: id, reason: UNTRUSTED }, status);
}

function load(items: unknown[]) {
  authorizedFetch.mockResolvedValueOnce(json(me(items)));
}

async function settle() {
  // TanStack Query batches notifications in a timer after the fetch resolves.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderPage() {
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
  await settle();
}

function button(label: string): HTMLButtonElement {
  const result = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(result, `button ${label}`).toBeDefined();
  return result!;
}

async function click(label: string) {
  expect(button(label).disabled).toBe(false);
  await act(async () => button(label).click());
  await settle();
}

function machine(label: string): HTMLElement {
  const result = container.querySelector<HTMLElement>(`[aria-label="Emergency controls for ${label}"]`);
  expect(result, `outcome for ${label}`).not.toBeNull();
  return result!;
}

function stopButtons() {
  return [...container.querySelectorAll("button")].filter((element) => element.textContent?.startsWith("EMERGENCY STOP"));
}

function postedIds(path: string) {
  return authorizedFetch.mock.calls.filter(([url]) => url === path).map(([, init]) => JSON.parse(init.body as string).kernelId);
}

function expectUnavailable() {
  expect(stopButtons(), "unreadable machines must never expose a stop target").toHaveLength(0);
  expect(container.textContent).toContain(UNAVAILABLE);
  expect(container.textContent).not.toContain(UNTRUSTED);
  expect(authorizedFetch.mock.calls.every(([url]) => url === "/api/agent/me")).toBe(true);
}

describe("a withheld agent/me answer and owner proof", () => {
  it("a withheld agent/me answer shows fixed owner proof copy", async () => {
    const answer = ownerProofAnswer();
    authorizedFetch.mockResolvedValueOnce(json(answer));
    await renderPage();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(OWNER_PROOF_COPY);
    expect(alert?.childElementCount).toBe(0);
    expect(container.textContent).not.toContain(OWNER_PROOF_KERNELS.unavailable);
    expect(container.textContent).not.toContain(UNAVAILABLE);
    expect(kernelsOf(answer)).toBe("withheld");
  });

  it("a withheld agent/me answer has no stop button or stop request", async () => {
    const answer = ownerProofAnswer();
    authorizedFetch.mockResolvedValueOnce(json(answer));
    await renderPage();
    expect(stopButtons()).toHaveLength(0);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).toHaveBeenCalledWith("/api/agent/me", expect.objectContaining({ cache: "no-store" }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(kernelsOf(answer)).toBe("withheld");
  });

  it.each([
    ["a different owner proof reason", { ...OWNER_PROOF_KERNELS, unavailable: "<b>owner proof details</b>" }],
    ["owner proof count zero", { ...OWNER_PROOF_KERNELS, count: 0 }],
    ["owner proof items non-empty", { ...OWNER_PROOF_KERNELS, items: [LATHE] }],
    ["owner proof count non-null", { ...OWNER_PROOF_KERNELS, count: 1 }],
    ["owner proof count text", { ...OWNER_PROOF_KERNELS, count: "null" }],
    ["owner proof count absent", { items: [], unavailable: OWNER_PROOF_KERNELS.unavailable }],
    ["owner proof items absent", { count: null, unavailable: OWNER_PROOF_KERNELS.unavailable }],
    ["owner proof reason empty", { ...OWNER_PROOF_KERNELS, unavailable: "" }],
    ["owner proof additional field", { ...OWNER_PROOF_KERNELS, ownerProof: true }],
  ] as const)("a withheld agent/me answer with %s stays unavailable", async (_ownerProofCase, kernels) => {
    const answer = ownerProofAnswer(kernels);
    authorizedFetch.mockResolvedValueOnce(json(answer));
    await renderPage();
    expectUnavailable();
    expect(container.textContent).not.toContain(OWNER_PROOF_COPY);
    expect(container.textContent).not.toContain(OWNER_PROOF_KERNELS.unavailable);
    if (kernels.unavailable) expect(container.textContent).not.toContain(kernels.unavailable);
    expect(kernelsOf(answer)).toBe("unavailable");
  });
});

describe("OperatorDashboardPage signed-in operator's machines", () => {
  it("loads /api/agent/me and targets only its owned ids for stop and resume (hard-coded-id mutant)", async () => {
    load([LATHE, PRINTER]);
    await renderPage();
    expect(authorizedFetch).toHaveBeenCalledWith("/api/agent/me", expect.objectContaining({ cache: "no-store" }));
    authorizedFetch.mockResolvedValueOnce(stopReply(LATHE.id));
    await click(`EMERGENCY STOP: ${LATHE.name}`);
    expect(postedIds("/api/operator/emergency-stop")).toEqual([LATHE.id]);
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    expect(machine(PRINTER.name).textContent).not.toContain("EMERGENCY STOP ACTIVE");
    authorizedFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await click(`Resume Operations: ${LATHE.name}`);
    expect(postedIds("/api/operator/emergency-resume")).toEqual([LATHE.id]);
    expect(machine(LATHE.name).textContent).not.toContain("EMERGENCY STOP ACTIVE");
    expect(authorizedFetch.mock.calls.filter(([url]) => url !== "/api/agent/me")).toEqual([
      ["/api/operator/emergency-stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kernelId: LATHE.id }) }],
      ["/api/operator/emergency-resume", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kernelId: LATHE.id }) }],
    ]);
  });

  it("two machines: stop all sends exactly one request for each owned id", async () => {
    load([LATHE, PRINTER]);
    await renderPage();
    authorizedFetch.mockImplementation(async (_path: string, init: RequestInit) => stopReply(JSON.parse(init.body as string).kernelId));
    await click("EMERGENCY STOP: all of your machines");
    expect(postedIds("/api/operator/emergency-stop")).toEqual([LATHE.id, PRINTER.id]);
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    expect(machine(PRINTER.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${PRINTER.name}`);
  });

  it("stop all keeps each confirmed, refused and unconfirmed result separate (blanket-stopped mutant)", async () => {
    load([LATHE, PRINTER, ROUTER]);
    await renderPage();
    authorizedFetch.mockImplementation(async (_path: string, init: RequestInit) => {
      const id = JSON.parse(init.body as string).kernelId;
      return id === LATHE.id ? stopReply(id) : id === PRINTER.id ? json({ error: UNTRUSTED }, 403) : json({ stopped: false, kernelId: id });
    });
    await click("EMERGENCY STOP: all of your machines");
    expect(postedIds("/api/operator/emergency-stop")).toEqual([LATHE.id, PRINTER.id, ROUTER.id]);
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    expect(machine(PRINTER.name).textContent).not.toContain("EMERGENCY STOP ACTIVE");
    expect(machine(ROUTER.name).textContent).not.toContain("EMERGENCY STOP ACTIVE");
    expect(machine(PRINTER.name).textContent).toContain(`The stop was refused for this key. ${PRINTER.name} may still be running: use the machine's physical emergency stop.`);
    expect(machine(ROUTER.name).textContent).toContain(`The server didn't confirm the stop for ${ROUTER.name}. The machine may still be running: use its physical emergency stop.`);
    expect(container.querySelectorAll('[aria-label^="Emergency controls for "]')).toHaveLength(3);
    expect(container.textContent).not.toContain(UNTRUSTED);
  });

  it("each machine requires its own matching kernelId confirmation (kernelId-check mutant)", async () => {
    load([LATHE, PRINTER]);
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(stopReply(PRINTER.id));
    await click(`EMERGENCY STOP: ${LATHE.name}`);
    expect(machine(LATHE.name).textContent).not.toContain("EMERGENCY STOP ACTIVE");
    expect(machine(LATHE.name).textContent).toContain(`The server didn't confirm the stop for ${LATHE.name}. The machine may still be running: use its physical emergency stop.`);
    expect(button(`EMERGENCY STOP: ${LATHE.name}`).disabled).toBe(false);
  });

  it("shows no stop button while the owned machines are loading", async () => {
    authorizedFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    await renderPage();
    expect(stopButtons()).toHaveLength(0);
  });

  it("no machines shows honest empty copy and no stop button", async () => {
    load([]);
    await renderPage();
    expect(stopButtons()).toHaveLength(0);
    expect(container.textContent).toContain("No machines are registered to this key yet.");
    expect(container.textContent).not.toContain(UNAVAILABLE);
  });

  it.each([401, 403, 500])("unavailable HTTP %s shows no stop button (unavailable-controls mutant)", async (status) => {
    authorizedFetch.mockResolvedValueOnce(json({ error: UNTRUSTED }, status));
    await renderPage();
    expectUnavailable();
  });

  it("unavailable network failure shows no stop button and fixed physical-stop copy", async () => {
    authorizedFetch.mockRejectedValueOnce(new Error(UNTRUSTED));
    await renderPage();
    expectUnavailable();
  });

  it.each([
    ["non-JSON", () => new Response(UNTRUSTED, { status: 200 })],
    ["ok false", () => json({ ...me([LATHE]), ok: false })],
    ["kernels missing", () => { const body: Record<string, unknown> = me([LATHE]); delete body.kernels; return json(body); }],
    ["kernels null", () => json({ ...me([LATHE]), kernels: null })],
    ["route unavailable section", () => json({ ...me([]), kernels: { count: null, items: [], unavailable: UNTRUSTED } })],
    ["empty unavailable reason", () => json({ ...me([LATHE]), kernels: { count: 1, items: [LATHE], unavailable: "" } })],
    ["items missing", () => json({ ...me([LATHE]), kernels: { count: 1 } })],
    ["count missing", () => json({ ...me([LATHE]), kernels: { items: [LATHE] } })],
    ["count mismatch", () => json({ ...me([LATHE]), kernels: { count: 2, items: [LATHE] } })],
    ["count string", () => json({ ...me([LATHE]), kernels: { count: "1", items: [LATHE] } })],
    ["items object", () => json({ ...me([LATHE]), kernels: { count: 1, items: LATHE } })],
    ["blank id", () => json(me([{ ...LATHE, id: "  " }]))],
    ["duplicate ids", () => json(me([LATHE, { ...PRINTER, id: LATHE.id }]))],
    ["partial malformed array", () => json(me([LATHE, null]))],
    ["missing heartbeat", () => json(me([{ id: LATHE.id, name: LATHE.name }]))],
    ["invalid heartbeat", () => json(me([{ ...LATHE, last_heartbeat: 42 }]))],
    ["invalid name", () => json(me([{ ...LATHE, name: { text: UNTRUSTED } }]))],
    ["invalid status", () => json(me([{ ...LATHE, status: 1 }]))],
    ["unknown kernels field", () => json({ ...me([LATHE]), kernels: { count: 1, items: [LATHE], injected: UNTRUSTED } })],
    ["unknown machine field", () => json(me([{ ...LATHE, injected: UNTRUSTED }]))],
  ] as const)("wrong /api/agent/me shape: %s fails closed", async (_label, reply) => {
    authorizedFetch.mockResolvedValueOnce(reply());
    await renderPage();
    expectUnavailable();
  });

  it("an optional machine name falls back to its id and accepts the route's string status", async () => {
    const unnamed = { id: "owned-unnamed-98", status: "maintenance_future_status", last_heartbeat: null };
    load([unnamed]);
    await renderPage();
    expect(stopButtons()).toHaveLength(1);
    authorizedFetch.mockResolvedValueOnce(stopReply(unnamed.id));
    await click(`EMERGENCY STOP: ${unnamed.id}`);
    expect(postedIds("/api/operator/emergency-stop")).toEqual([unnamed.id]);
    expect(machine(unnamed.id).textContent).toContain(`EMERGENCY STOP ACTIVE for ${unnamed.id}`);
  });

  it("clears the old operator's machines immediately when the signed-in key changes", async () => {
    load([LATHE]);
    await renderPage();
    expect(button(`EMERGENCY STOP: ${LATHE.name}`)).toBeDefined();
    let finish!: (response: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    await act(async () => useAuthStore.setState({ keyEpoch: 43 }));
    await settle();
    expect(stopButtons()).toHaveLength(0);
    await act(async () => finish(json(me([PRINTER]))));
    await settle();
    expect(button(`EMERGENCY STOP: ${PRINTER.name}`)).toBeDefined();
    expect(container.querySelector(`[aria-label="Emergency controls for ${LATHE.name}"]`)).toBeNull();
  });

  it("PR-1 continuity: a confirmed stop survives leaving and returning to overview", async () => {
    authorizedFetch.mockImplementation(async (path: string) => {
      if (path === "/api/agent/me") return json(me([LATHE]));
      throw new Error("Unexpected request");
    });
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(stopReply(LATHE.id));
    await click(`EMERGENCY STOP: ${LATHE.name}`);
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    await click("earnings");
    await click("overview");
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    expect(button(`Resume Operations: ${LATHE.name}`).disabled).toBe(false);
  });

  it("PR-1 continuity: a confirmed stop survives repeat stop-all pending and refused answers", async () => {
    load([LATHE, PRINTER]);
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(stopReply(LATHE.id));
    await click(`EMERGENCY STOP: ${LATHE.name}`);

    let finish!: (reply: Response) => void;
    authorizedFetch.mockImplementation(async (_path: string, init: RequestInit) => {
      const id = JSON.parse(init.body as string).kernelId;
      return id === LATHE.id ? new Promise<Response>((resolve) => { finish = resolve; }) : stopReply(id);
    });
    await click("EMERGENCY STOP: all of your machines");
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    await act(async () => finish(json({ error: UNTRUSTED }, 403)));
    await settle();
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    expect(machine(LATHE.name).textContent).toContain(`The stop was refused for this key. ${LATHE.name} may still be running: use the machine's physical emergency stop.`);
    expect(machine(PRINTER.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${PRINTER.name}`);
    expect(button(`Resume Operations: ${LATHE.name}`).disabled).toBe(false);
    expect(container.textContent).not.toContain(UNTRUSTED);
  });

  it("PR-1 continuity: resuming one machine preserves the other machine's confirmed stop", async () => {
    load([LATHE, PRINTER]);
    await renderPage();
    authorizedFetch.mockImplementation(async (_path: string, init: RequestInit) => stopReply(JSON.parse(init.body as string).kernelId));
    await click("EMERGENCY STOP: all of your machines");
    expect(machine(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    expect(machine(PRINTER.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${PRINTER.name}`);

    authorizedFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await click(`Resume Operations: ${LATHE.name}`);
    expect(postedIds("/api/operator/emergency-resume")).toEqual([LATHE.id]);
    expect(machine(LATHE.name).textContent).not.toContain("EMERGENCY STOP ACTIVE");
    expect(button(`EMERGENCY STOP: ${LATHE.name}`).disabled).toBe(false);
    expect(machine(PRINTER.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${PRINTER.name}`);
    expect(button(`Resume Operations: ${PRINTER.name}`).disabled).toBe(false);
  });
});
