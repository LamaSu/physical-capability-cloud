// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep App, LoginPage, ConnectWallet, useAuth and the credential owner real.
vi.mock("wagmi", () => ({
  useAccount: () => ({ isConnected: false }),
  useSignMessage: () => ({ signMessageAsync: vi.fn() }),
  useConnect: () => ({ connectors: [], connect: vi.fn() }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useConnectionEffect: () => {},
}));
vi.mock("@pcc/ui", () => ({
  AppShell: ({ children, sidebar }: { children: ReactNode; sidebar: ReactNode }) => <div>{sidebar}{children}</div>,
  GlassPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Sidebar: () => null,
  TopBar: () => null,
  StatusBar: () => null,
  ParticleBackground: () => null,
}));
vi.mock("../components/nav-config.js", () => ({ navGroups: [] }));
vi.mock("../providers/WalletProvider.js", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../lib/telemetry.js", () => ({
  Sentry: { ErrorBoundary: ({ children }: { children: ReactNode }) => children },
  trackPageView: vi.fn(),
}));
vi.mock("../SpatialApp.js", () => ({ SpatialApp: () => null }));
vi.mock("../components/PageTransition.js", () => ({ PageTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/NotificationToasts.js", () => ({ NotificationToasts: () => null }));
vi.mock("../components/OnboardingTour.js", () => ({ OnboardingTour: () => null, TourRestartButton: () => null }));
vi.mock("../components/ModeToggle.js", () => ({ ModeToggle: () => null }));
vi.mock("../components/AgentLandingHero.js", () => ({ AgentLandingHero: () => null }));

import { App } from "../App.js";
import { ConnectWallet } from "../components/ConnectWallet.js";
import { hasStoredApiKey } from "../lib/authorized-fetch.js";
import { adoptApiKey, useAuthStore } from "../stores/auth-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PASTED_KEY = ["pcc", "test", "pasted0123456789abcdef"].join("_");
const COOKIE_ADDRESS = "0xAbCd12345678901234567890123456789012345678";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let container: HTMLDivElement;
let root: Root;
let originalPath: string;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalStorage: [string, string][];

beforeEach(() => {
  originalPath = window.location.pathname + window.location.search + window.location.hash;
  originalAuth = useAuthStore.getState();
  originalStorage = Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!;
    return [key, localStorage.getItem(key)!];
  });
  adoptApiKey(null);
  window.history.replaceState({}, "", "/legacy/x");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  adoptApiKey(null);
  useAuthStore.setState(originalAuth);
  localStorage.clear();
  for (const [key, value] of originalStorage) localStorage.setItem(key, value);
  window.history.replaceState({}, "", originalPath);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sidebar sign-out", () => {
  it("disconnects without passing the click event and clears the persisted key", async () => {
    let cookieSessionLive = true;
    const calls: { path: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
      calls.push({ path, init });
      const hasCookie = cookieSessionLive && init.credentials === "include";
      switch (path) {
        case "/api/auth/me":
          return hasCookie ? json({ address: COOKIE_ADDRESS }) : json({ error: "session_required" }, 401);
        case "/api/auth/logout":
          if (hasCookie && init.method === "POST") cookieSessionLive = false;
          return json({ ok: true });
        case "/api/auth/session-key":
          return hasCookie ? json({
            api_key: ["pcc", "test", "session0123456789abcdef"].join("_"),
            key_id: "wallet-session-key",
            operator_id: COOKIE_ADDRESS,
            expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }, 201) : json({ error: "session_required" }, 401);
        default:
          throw new Error(`Unexpected request: ${path}`);
      }
    }));

    adoptApiKey(PASTED_KEY);
    await act(async () => root.render(<ConnectWallet />));
    expect(useAuthStore.getState()).toMatchObject({ address: COOKIE_ADDRESS, sessionToken: "cookie", sessionKeyId: null });
    expect(hasStoredApiKey()).toBe(true);
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED_KEY);

    const signOutWallet = vi.spyOn(useAuthStore.getState(), "signOutWallet");
    await act(async () => root.render(<App />));
    const disconnect = [...container.querySelectorAll("button")].find((button) => button.textContent === "Disconnect")!;
    expect(disconnect).toBeDefined();
    await act(async () => disconnect.click());
    await act(async () => {});

    expect(signOutWallet.mock.calls).toEqual([[]]);
    expect(calls.filter(({ path }) => path === "/api/auth/logout").map(({ init }) => ({ method: init.method, credentials: init.credentials })))
      .toEqual([{ method: "POST", credentials: "include" }]);
    expect(cookieSessionLive).toBe(false);
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, address: null, sessionToken: null, sessionKeyId: null });
    expect(container.querySelector("#api-key")).not.toBeNull();
    expect(calls.filter(({ path }) => path === "/api/auth/session-key")).toHaveLength(0);
    expect(window.location.pathname).toBe("/legacy/x");
  });
});
