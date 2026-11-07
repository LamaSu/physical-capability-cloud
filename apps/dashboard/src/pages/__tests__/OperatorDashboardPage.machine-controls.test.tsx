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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LATHE = { id: "owned-lathe-72", name: "North lathe", last_heartbeat: null };
const PRINTER = { id: "owned-printer-41", name: "West printer", last_heartbeat: null };
const ROUTER = { id: "owned-router-86", name: "South router", last_heartbeat: null };
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalOperator: ReturnType<typeof useOperatorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  authorizedFetch.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  originalAuth = useAuthStore.getState();
  originalOperator = useOperatorStore.getState();
  originalUI = useUIStore.getState();
  useAuthStore.setState({ isAuthenticated: true, keyEpoch: 92 });
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status }); }
function confirmed(id: string) { return json({ stopped: true, kernelId: id }); }
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
async function renderPage(items = [LATHE, PRINTER]) {
  authorizedFetch.mockResolvedValueOnce(json({ ok: true, kernels: { count: items.length, items } }));
  await act(async () => root.render(
    <QueryClientProvider client={client}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>,
  ));
  await settle();
}
function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
async function click(label: string) {
  expect(button(label).disabled).toBe(false);
  await act(async () => button(label).click());
}
function postedIds(path: string) {
  return authorizedFetch.mock.calls.filter(([url]) => url === path).map(([, init]) => JSON.parse(init.body as string).kernelId);
}
function row(label: string) { return container.querySelector<HTMLElement>(`[aria-label="Emergency controls for ${label}"]`)!; }

describe("independent machine emergency controls", () => {
  it("a pending stop leaves another machine's stop and single-flight resume available", async () => {
    await renderPage();
    let finishLathe!: (response: Response) => void;
    let finishResume!: (response: Response) => void;
    authorizedFetch.mockImplementation((path: string, init: RequestInit) => {
      const id = JSON.parse(init.body as string).kernelId;
      if (path.endsWith("emergency-resume")) return new Promise<Response>((resolve) => { finishResume = resolve; });
      return id === LATHE.id ? new Promise<Response>((resolve) => { finishLathe = resolve; }) : Promise.resolve(confirmed(id));
    });
    await click(`EMERGENCY STOP: ${LATHE.name}`);
    expect(button(`Stopping ${LATHE.name}...`).disabled).toBe(true);
    expect(button(`EMERGENCY STOP: ${PRINTER.name}`).disabled).toBe(false);
    await click(`EMERGENCY STOP: ${PRINTER.name}`);
    expect(postedIds("/api/operator/emergency-stop")).toEqual([LATHE.id, PRINTER.id]);
    await click(`Resume Operations: ${PRINTER.name}`);
    const pendingResume = button(`Resuming ${PRINTER.name}...`);
    expect(pendingResume.disabled).toBe(true);
    await act(async () => { pendingResume.click(); pendingResume.click(); });
    expect(postedIds("/api/operator/emergency-resume")).toEqual([PRINTER.id]);
    await act(async () => { finishResume(new Response(null, { status: 204 })); finishLathe(confirmed(LATHE.id)); });
    expect(row(LATHE.name).textContent).toContain(`EMERGENCY STOP ACTIVE for ${LATHE.name}`);
    expect(row(PRINTER.name).textContent).not.toContain("EMERGENCY STOP ACTIVE");
  });

  it("stop all sends to every machine that is not already pending", async () => {
    await renderPage([LATHE, PRINTER, ROUTER]);
    let finishLathe!: (response: Response) => void;
    authorizedFetch.mockImplementation((_path: string, init: RequestInit) => {
      const id = JSON.parse(init.body as string).kernelId;
      return id === LATHE.id ? new Promise<Response>((resolve) => { finishLathe = resolve; }) : Promise.resolve(confirmed(id));
    });
    await click(`EMERGENCY STOP: ${LATHE.name}`);
    expect(button("EMERGENCY STOP: all of your machines").disabled).toBe(false);
    await click("EMERGENCY STOP: all of your machines");
    expect(postedIds("/api/operator/emergency-stop")).toEqual([LATHE.id, PRINTER.id, ROUTER.id]);
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining(`2 machines (${PRINTER.name}, ${ROUTER.name})`));
    expect(row(PRINTER.name).textContent).toContain("EMERGENCY STOP ACTIVE");
    expect(row(ROUTER.name).textContent).toContain("EMERGENCY STOP ACTIVE");
    await act(async () => finishLathe(confirmed(LATHE.id)));
  });

  it.each(["stop", "resume"] as const)("a %s timeout aborts after 15 seconds and shows its fixed failure copy", async (action) => {
    await renderPage([LATHE]);
    if (action === "resume") {
      authorizedFetch.mockResolvedValueOnce(confirmed(LATHE.id));
      await click(`EMERGENCY STOP: ${LATHE.name}`);
    }
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    authorizedFetch.mockImplementation((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    await click(action === "stop" ? `EMERGENCY STOP: ${LATHE.name}` : `Resume Operations: ${LATHE.name}`);
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const expected = action === "stop"
      ? `The stop didn't go through. ${LATHE.name} may still be running: use the machine's physical emergency stop, then try again.`
      : `Resume wasn't confirmed. ${LATHE.name} may still be stopped, or the resume may have gone through: treat the machine as live, and press Resume Operations again to confirm.`;
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
    expect(signal?.aborted).toBe(true);
    expect(button(action === "stop" ? `EMERGENCY STOP: ${LATHE.name}` : `Resume Operations: ${LATHE.name}`).disabled).toBe(false);
    expect(row(LATHE.name).textContent?.includes("EMERGENCY STOP ACTIVE")).toBe(action === "resume");

    // Recovery or response parsing can remain pending even after transport aborts.
    let finishLate!: (response: Response) => void;
    authorizedFetch.mockImplementation(() => new Promise<Response>((resolve) => { finishLate = resolve; }));
    await click(action === "stop" ? `EMERGENCY STOP: ${LATHE.name}` : `Resume Operations: ${LATHE.name}`);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
    expect(button(action === "stop" ? `EMERGENCY STOP: ${LATHE.name}` : `Resume Operations: ${LATHE.name}`).disabled).toBe(false);
    await act(async () => finishLate(action === "stop" ? confirmed(LATHE.id) : new Response(null, { status: 204 })));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(expected);
    expect(row(LATHE.name).textContent?.includes("EMERGENCY STOP ACTIVE")).toBe(action === "resume");
  });

  it("same-named machines show separate ids and name each target in stop and resume dialogs", async () => {
    const first = { ...LATHE, name: "Prusa MK4" };
    const second = { ...PRINTER, name: "Prusa MK4" };
    await renderPage([first, second]);
    const sections = [...container.querySelectorAll<HTMLElement>('section[aria-label^="Emergency controls for "]')];
    expect(sections).toHaveLength(2);
    expect(sections[0].textContent).toContain(first.id);
    expect(sections[1].textContent).toContain(second.id);
    expect(sections[0].getAttribute("aria-label")).toContain(first.id);
    expect(sections[1].getAttribute("aria-label")).toContain(second.id);
    authorizedFetch.mockImplementation(async (path: string, init: RequestInit) => path.endsWith("emergency-stop")
      ? confirmed(JSON.parse(init.body as string).kernelId) : new Response(null, { status: 204 }));
    await act(async () => sections[1].querySelector("button")!.click());
    expect(postedIds("/api/operator/emergency-stop")).toEqual([second.id]);
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining(`Prusa MK4 (${second.id})`));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.not.stringContaining(first.id));
    await act(async () => sections[1].querySelector("button")!.click());
    expect(postedIds("/api/operator/emergency-resume")).toEqual([second.id]);
    expect(window.confirm).toHaveBeenLastCalledWith(`Resume operations on Prusa MK4 (${second.id})? Jobs PCC held during the stop can start on the machine.`);
    await click("EMERGENCY STOP: all of your machines");
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining(`Prusa MK4 (${first.id}), Prusa MK4 (${second.id})`));
  });
});
