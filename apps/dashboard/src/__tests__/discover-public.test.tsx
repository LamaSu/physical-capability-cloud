// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
  useConnect: () => ({ connectors: [], connect: vi.fn() }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useConnectionEffect: () => {},
}));
vi.mock("../providers/WalletProvider.js", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../lib/telemetry.js", () => ({
  Sentry: { ErrorBoundary: ({ children }: { children: ReactNode }) => children },
  trackPageView: vi.fn(),
}));
vi.mock("../components/PageTransition.js", () => ({ PageTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../SpatialApp.js", () => ({ SpatialApp: () => <div data-testid="spatial-app" /> }));
vi.mock("../pages/AgentChatPage.js", () => ({ AgentChatPage: () => <div data-testid="agent-chat" /> }));
vi.mock("../pages/LoginPage.js", () => ({ LoginPage: () => <div data-testid="login-page" /> }));
vi.mock("@pcc/ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("@pcc/ui")>(),
  ParticleBackground: () => null,
}));

import { App } from "../App.js";
import { adoptApiKey, useAuthStore } from "../stores/auth-store.js";
import { useUIStore, type InterfaceMode } from "../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KERNEL = {
  id: "k1", name: "North Shop", status: "online", isStale: false,
  operatorAddress: "0x" + "ab".repeat(20),
  location: { lat: 12.3456, lng: 65.4321 }, locationPrecision: "approximate",
  locationCell: "tdr1w", physicalAddress: "1 Sample Street",
};
const CAP = {
  id: "c1", kernelId: "k1", type: "fdm", name: "Bracket Printing",
  description: "Prints small brackets", queueDepth: 0,
  location: { lat: 12.3456, lng: 65.4321 }, locationPrecision: "approximate", locationCell: "tdr1w",
};
const modes: InterfaceMode[] = ["spatial", "agent", "dashboard"];
type RecordedRequest = { method: string; pathname: string; search: string; authorization: boolean };
let requests: RecordedRequest[];
let root: Root;
let container: HTMLDivElement;
let originalPath: string;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
let originalStorage: [string, string][];

beforeEach(() => {
  originalPath = window.location.pathname + window.location.search + window.location.hash;
  originalAuth = useAuthStore.getState();
  originalUI = useUIStore.getState();
  originalStorage = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!;
    return [key, localStorage.getItem(key)!];
  });
  adoptApiKey(null);
  localStorage.clear();
  useAuthStore.setState({ isAuthenticated: false, sessionToken: null });
  useUIStore.setState(useUIStore.getInitialState());
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const method = init.method ?? request?.method ?? "GET";
    requests.push({ method, pathname: url.pathname, search: url.search, authorization: new Headers(init.headers ?? request?.headers).has("authorization") });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "GET") {
      if (url.pathname === "/api/capabilities") return json({ items: [CAP], total: 1, offset: 0, limit: 200, hasMore: false });
      if (url.pathname === "/api/kernels") return json({ kernels: [KERNEL] });
      if (url.pathname === "/api/auth/me") return json({ error: "session_required" }, 401);
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState({}, "", originalPath);
  adoptApiKey(null);
  useAuthStore.setState(originalAuth);
  useUIStore.setState(originalUI);
  localStorage.clear();
  for (const [key, value] of originalStorage) localStorage.setItem(key, value);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderAt(path: string, mode: InterfaceMode, signedIn = false) {
  useAuthStore.setState({ isAuthenticated: signedIn, sessionToken: null });
  useUIStore.getState().setMode(mode);
  window.history.replaceState({}, "", path);
  await act(async () => root.render(<App />));
}

function marker(name: string) {
  return container.querySelector(`[data-testid="${name}"]`);
}

async function expectDiscover() {
  await vi.waitFor(() => {
    expect(container.textContent).toContain("Bracket Printing");
    expect(container.textContent).toContain("at North Shop · online");
  });
  expect(container.querySelector("aside")).not.toBeNull();
  expect(container.querySelector("main")).not.toBeNull();
  expect(container.textContent).toContain("Discover Capabilities");
  expect(container.textContent).toContain("Search the capabilities operators list on the network");
  for (const name of ["login-page", "spatial-app", "agent-chat"]) expect(marker(name)).toBeNull();
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
}

describe("public Discover", () => {
  it.each(modes)("V1: a visitor can discover in %s mode without changing it", async (mode) => {
    await renderAt("/discover", mode);
    await expectDiscover();
    expect(useUIStore.getState().interfaceMode).toBe(mode);
  });

  it("V2: a visitor can discover with a trailing slash", async () => {
    await renderAt("/discover/", "spatial");
    await expectDiscover();
  });

  it.each(["/discover/x", "/discoverx", "/Discover", "/kernels/k1"])("V3: a visitor still needs access at %s", async (path) => {
    await renderAt(path, "spatial");
    expect(marker("login-page")).not.toBeNull();
    expect(requests.filter(({ pathname }) => pathname === "/api/capabilities" || pathname === "/api/kernels")).toEqual([]);
  });

  it("V4: a visitor makes only the public catalog and session reads without authorization", async () => {
    await renderAt("/discover", "spatial");
    await expectDiscover();
    expect(new Set(requests.map(({ method, pathname, search }) => `${method} ${pathname}${search}`))).toEqual(new Set([
      "GET /api/capabilities?offset=0&limit=200", "GET /api/kernels", "GET /api/auth/me",
    ]));
    expect(requests.every(({ authorization }) => !authorization)).toBe(true);
    console.info("V4 requests:", JSON.stringify(requests));
  });

  it("V5: a visitor following a capability card reaches the login gate", async () => {
    await renderAt("/discover", "spatial");
    await expectDiscover();
    const cardName = [...container.querySelectorAll("div")].find((node) => node.textContent === "Bracket Printing")!;
    await act(async () => cardName.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await vi.waitFor(() => expect(marker("login-page")).not.toBeNull());
    expect(window.location.pathname).toBe("/kernels/k1");
    expect(requests.some(({ pathname }) => pathname === "/api/kernels/k1")).toBe(false);
  });

  it("V6: visitor controls omit Disconnect and the tour, with a signed-in positive control", async () => {
    await renderAt("/discover", "spatial");
    await expectDiscover();
    expect(button("Disconnect")).toBeUndefined();
    expect(button("? Tour")).toBeUndefined();
    expect(container.textContent).not.toContain("Welcome to PCCP Command Center");
    expect(button("Connect Wallet")).toBeDefined();
    expect([...container.querySelectorAll("aside *")].some((node) => node.textContent === "Discover")).toBe(true);
    await act(async () => useAuthStore.setState({ isAuthenticated: true, sessionToken: null }));
    await expectDiscover();
    expect(button("Disconnect")).toBeDefined();
    expect(button("? Tour")).toBeDefined();
    expect(container.textContent).toContain("Welcome to PCCP Command Center");
  });

  it.each(modes)("S1: signed-in callers discover in %s mode without changing it", async (mode) => {
    await renderAt("/discover", mode, true);
    await expectDiscover();
    expect(useUIStore.getState().interfaceMode).toBe(mode);
  });

  it.each(["/discover/x", "/kernels/k1"])("S2: signed-in callers keep spatial routing at %s", async (path) => {
    await renderAt(path, "spatial", true);
    expect(marker("spatial-app")).not.toBeNull();
    expect(container.querySelector("main")).toBeNull();
  });

  it("P1: visitor cards omit site coordinates and operator details", async () => {
    await renderAt("/discover", "spatial");
    await expectDiscover();
    for (const value of ["12.3456", "65.4321", "tdr1w", "1 Sample Street", KERNEL.operatorAddress]) {
      expect(container.textContent).not.toContain(value);
    }
  });
});
