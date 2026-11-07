// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));

import { OperatorMachineDetailPage } from "../OperatorMachineDetailPage.js";
import { useAuthStore } from "../../stores/auth-store.js";
import { useUIStore } from "../../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOADING = "Loading your machines.";
const UNAVAILABLE = "Your machines can't be read right now.";
const TRY_AGAIN = "Try again";
const WITHHELD = "Your machines aren't shown for this sign-in: PCC needs proof that you own them. Sign in with your wallet (or use a linked wallet) to see them here.";
const NO_MACHINE = "This sign-in has no machine with this ID.";
const BACK = "← Back to Operator Dashboard";
const CHECK_IN = "2026-10-16T10:00:00.000Z";
const MACHINE = { id: "k1", name: "North lathe", status: "online", last_heartbeat: CHECK_IN };
const OTHER = { id: "k2", name: "West printer", status: "offline", last_heartbeat: "2026-10-15T09:00:00.000Z" };
const OWNER_PROOF_REQUIRED = "requires owner proof (SIWE sign-in, a session key, or a linked wallet)";
const WITHHELD_BODY = { ok: true, kernels: { count: null, items: [], unavailable: OWNER_PROOF_REQUIRED } };
const globalFetch = vi.fn();
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let navigate: ReturnType<typeof useNavigate>;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  authorizedFetch.mockReset();
  globalFetch.mockReset().mockRejectedValue(new Error("Unexpected request"));
  vi.stubGlobal("fetch", globalFetch);
  originalAuth = useAuthStore.getState();
  originalUI = useUIStore.getState();
  useAuthStore.setState({ isAuthenticated: true, keyEpoch: 42, sessionEpoch: 7, address: null });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  useAuthStore.setState(originalAuth);
  useUIStore.setState(originalUI);
  vi.unstubAllGlobals();
});

function me(items: unknown[]) {
  return { ok: true, kernels: { count: items.length, items } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function RouteHarness() {
  navigate = useNavigate();
  return (
    <Routes>
      <Route path="/operator/:machineId" element={<OperatorMachineDetailPage />} />
      <Route path="/operator" element={<div data-testid="operator-dashboard" />} />
    </Routes>
  );
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function renderPage(id = MACHINE.id) {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/operator/${id}`]}><RouteHarness /></MemoryRouter>
    </QueryClientProvider>,
  ));
  await settle();
}

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

function fact(label: string) {
  const term = [...container.querySelectorAll("dt")].find((node) => node.textContent === label);
  expect(term, `fact ${label}`).toBeDefined();
  return term!.nextElementSibling!;
}

function expectOnlyOwnRead() {
  expect(authorizedFetch).toHaveBeenCalled();
  for (const call of authorizedFetch.mock.calls) {
    expect(call).toEqual(["/api/agent/me", { cache: "no-store", signal: expect.any(AbortSignal) }]);
  }
  expect(globalFetch).not.toHaveBeenCalled();
}

function expectMissing() {
  const message = container.querySelector("p");
  expect(message?.textContent).toBe(NO_MACHINE);
  expect(message?.childElementCount).toBe(0);
  expect(container.querySelector("h2")).toBeNull();
  expect(button(BACK)).toBeDefined();
  expectOnlyOwnRead();
  return message!;
}

describe("OperatorMachineDetailPage caller's own machines", () => {
  it("T6 renders the matching machine's label and three recorded facts from the same accepted reply", async () => {
    authorizedFetch.mockResolvedValueOnce(json(me([OTHER, MACHINE])));
    await renderPage();
    expect(container.querySelector("h2")?.textContent).toBe(MACHINE.name);
    expect(fact("Machine ID").textContent).toBe("k1");
    expect(fact("Recorded status").textContent).toBe("Online");
    expect(fact("Last check-in").textContent).toBe(new Date(CHECK_IN).toLocaleString());
    expect(fact("Last check-in").querySelector("time")?.getAttribute("datetime")).toBe(CHECK_IN);
    expect(container.textContent).not.toContain(OTHER.name);
    expect(useUIStore.getState()).toMatchObject({ currentPageTitle: MACHINE.name, currentPageSubtitle: "Machine management" });
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expectOnlyOwnRead();
    await act(async () => button(BACK).click());
    expect(container.querySelector('[data-testid="operator-dashboard"]')).not.toBeNull();
  });

  it("pins D1 while pending and E2 before any machine is known", async () => {
    authorizedFetch.mockReturnValueOnce(new Promise<Response>(() => {}));
    await renderPage();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(LOADING);
    expect(container.textContent).toBe(LOADING);
    expect(useUIStore.getState()).toMatchObject({ currentPageTitle: "Machine Detail", currentPageSubtitle: "Machine management" });
    expectOnlyOwnRead();
  });

  it("T7 ids outside the caller's list and an empty list render the same text in the same element", async () => {
    authorizedFetch.mockResolvedValueOnce(json(me([MACHINE])));
    await renderPage("k-other");
    const first = expectMissing();
    const markup = first.outerHTML;
    await act(async () => navigate("/operator/zzz"));
    await settle();
    expect(expectMissing()).toBe(first);
    expect(first.outerHTML).toBe(markup);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    authorizedFetch.mockResolvedValueOnce(json(me([])));
    await act(async () => { await client.refetchQueries(); });
    await settle();
    expect(expectMissing()).toBe(first);
    expect(first.outerHTML).toBe(markup);
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    expect(useUIStore.getState().currentPageTitle).toBe("Machine Detail");
  });

  it("T7 a matching machine still sends no request carrying its route id", async () => {
    authorizedFetch.mockResolvedValueOnce(json(me([MACHINE])));
    await renderPage();
    expect(container.querySelector("h2")?.textContent).toBe(MACHINE.name);
    expectOnlyOwnRead();
  });

  it.each(["reg-001", "reg-002"])("T9 %s has no mock lookup when absent from the caller's list", async (id) => {
    authorizedFetch.mockResolvedValueOnce(json(me([MACHINE])));
    await renderPage(id);
    expectMissing();
    expect(container.textContent).not.toContain("Prusa MK4 Workshop");
    expect(container.textContent).not.toContain("Epilog Fusion Pro");
  });

  it("T8 a withheld reply renders only the fixed D3 owner-proof copy", async () => {
    authorizedFetch.mockResolvedValueOnce(json(WITHHELD_BODY));
    await renderPage();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(WITHHELD);
    expect(alert?.childElementCount).toBe(0);
    expect(container.textContent).toBe(WITHHELD);
    expect(container.textContent).not.toContain(OWNER_PROOF_REQUIRED);
    expect(container.querySelector("button")).toBeNull();
    expect(useUIStore.getState().currentPageTitle).toBe("Machine Detail");
    expectOnlyOwnRead();
  });

  it.each([
    ["unavailable section", () => json({ ok: true, kernels: { count: null, items: [], unavailable: "Section unavailable" } })],
    ["malformed 2xx", () => json({ ok: true, kernels: { count: 2, items: [MACHINE] } })],
    ["non-JSON 2xx", () => new Response("Unreadable response", { status: 200 })],
    ["invalid status type", () => json(me([{ ...MACHINE, status: 42 }]))],
    ["invalid check-in type", () => json(me([{ ...MACHINE, last_heartbeat: 42 }]))],
    ["401 after renewal", () => json({ error: "Unreadable response" }, 401)],
    ["403", () => json({ error: "Unreadable response" }, 403)],
    ["500", () => json({ error: "Unreadable response" }, 500)],
    ["network error", () => Promise.reject(new Error("Unreadable response"))],
  ] as const)("T8 %s renders D2 and D2b and Try again refetches", async (_label, response) => {
    authorizedFetch.mockImplementationOnce(response);
    await renderPage();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(UNAVAILABLE);
    expect(container.querySelector('[role="alert"]')?.childElementCount).toBe(0);
    expect(button(TRY_AGAIN)).toBeDefined();
    expect(container.textContent).not.toContain(NO_MACHINE);
    expect(container.textContent).not.toContain("Unreadable response");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(useUIStore.getState().currentPageTitle).toBe("Machine Detail");
    authorizedFetch.mockResolvedValueOnce(json(me([MACHINE])));
    await act(async () => button(TRY_AGAIN).click());
    await settle();
    expect(container.querySelector("h2")?.textContent).toBe(MACHINE.name);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    expectOnlyOwnRead();
  });

  it.each([
    ["online", "Online"],
    ["offline", "Offline"],
    ["maintenance", "In maintenance"],
    ["suspended", "Suspended"],
    ["expired", "Listing expired"],
    ["verified", "Status unknown"],
    ["constructor", "Status unknown"],
    ["__proto__", "Status unknown"],
    ["", "Status unknown"],
  ])("T10 recorded status %s renders only %s", async (status, text) => {
    authorizedFetch.mockResolvedValueOnce(json(me([{ ...MACHINE, status }])));
    await renderPage();
    expect(fact("Recorded status").textContent).toBe(text);
    if (status) expect([...container.querySelectorAll("*")].filter((node) => node.textContent === status)).toHaveLength(0);
  });

  it("T10 an absent status renders Status unknown", async () => {
    const { status: _status, ...machine } = MACHINE;
    authorizedFetch.mockResolvedValueOnce(json(me([machine])));
    await renderPage();
    expect(fact("Recorded status").textContent).toBe("Status unknown");
  });

  it.each([
    [null, "No check-in yet"],
    ["not-a-date", "Not readable"],
  ])("T11 last check-in %s renders %s without a time element", async (last_heartbeat, text) => {
    authorizedFetch.mockResolvedValueOnce(json(me([{ ...MACHINE, last_heartbeat }])));
    await renderPage();
    expect(fact("Last check-in").textContent).toBe(text);
    expect(container.querySelector("time")).toBeNull();
  });

  it.each([undefined, "", "  "])("uses machineLabel's id fallback for name %s", async (name) => {
    authorizedFetch.mockResolvedValueOnce(json(me([{ ...MACHINE, name }])));
    await renderPage();
    expect(container.querySelector("h2")?.textContent).toBe(MACHINE.id);
    expect(useUIStore.getState().currentPageTitle).toBe(MACHINE.id);
  });

  it("T15 a registration record renders exactly four facts and makes no machine-liveness claim", async () => {
    const registeredAt = "2026-10-16T12:34:56.000Z";
    authorizedFetch.mockResolvedValueOnce(json(me([{ ...MACHINE, last_heartbeat: registeredAt }])));
    await renderPage();
    expect([...container.querySelectorAll("h2")].map((node) => node.textContent)).toEqual([MACHINE.name]);
    expect([...container.querySelectorAll("dt")].map((node) => node.textContent)).toEqual(["Machine ID", "Recorded status", "Last check-in"]);
    expect([...container.querySelectorAll("dd")].map((node) => node.textContent)).toEqual([MACHINE.id, "Online", new Date(registeredAt).toLocaleString()]);
    expect(container.querySelector("time")?.getAttribute("datetime")).toBe(registeredAt);
    expect(container.querySelectorAll("dl")).toHaveLength(1);
    expect(container.querySelector("p")).toBeNull();
    expect(container.textContent).toBe(`${BACK}${MACHINE.name}Machine ID${MACHINE.id}Recorded statusOnlineLast check-in${new Date(registeredAt).toLocaleString()}`);
    expect(container.textContent).not.toMatch(/heartbeat|connected|live|healthy|ready|accepting/i);
    expectOnlyOwnRead();
  });

  it("keeps a separate query shape from the dashboard's machines cache", async () => {
    client.setQueryDefaults(["operator-machines"], { gcTime: Infinity });
    client.setQueryData(["operator-machines", 42, 7, null], [OTHER]);
    authorizedFetch.mockResolvedValueOnce(json(me([MACHINE])));
    await renderPage();
    expect(container.querySelector("h2")?.textContent).toBe(MACHINE.name);
    expect(client.getQueryData(["operator-machines", 42, 7, null])).toEqual([OTHER]);
    expectOnlyOwnRead();
  });

  it.each([
    ["key", { keyEpoch: 43 }],
    ["session", { sessionEpoch: 8 }],
    ["wallet", { address: "next-operator" }],
  ])("clears previous details while a different %s identity's read is pending", async (_label, state) => {
    authorizedFetch.mockResolvedValueOnce(json(me([MACHINE])));
    await renderPage();
    expect(container.querySelector("h2")?.textContent).toBe(MACHINE.name);
    let finish!: (response: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    await act(async () => useAuthStore.setState(state));
    await settle();
    expect(container.textContent).toBe(LOADING);
    expect(useUIStore.getState().currentPageTitle).toBe("Machine Detail");
    await act(async () => finish(json(me([OTHER]))));
    await settle();
    expectMissing();
    expect(container.textContent).not.toContain(MACHINE.name);
  });
});
