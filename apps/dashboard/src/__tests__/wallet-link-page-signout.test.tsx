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
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
const TITLE = "Link a wallet to your PCC account";
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
  window.history.replaceState({}, "", "/link");
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

describe("wallet link sign-out", () => {
  it("ends the wallet cookie session and clears a pasted key without signing back in", async () => {
    let cookieSessionLive = true;
    const calls: { path: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
      calls.push({ path, init });
      const hasCookie = cookieSessionLive && init.credentials === "include";
      switch (path) {
        case "/api/auth/me":
          return hasCookie ? json({ address: COOKIE_ADDRESS }) : json({ error: "session_required" }, 401);
        case "/api/wallets/link-requests/lookup":
          return json({ error: "unauthorized" }, 401);
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
    expect(calls.map(({ path }) => path)).toEqual(["/api/auth/me"]);

    await act(async () => {
      await import("../pages/WalletLinkPage.js");
      root.render(<App />);
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain(TITLE);
    });
    const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "WDJB-MJHT");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;
    await act(async () => button("Continue").click());
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Your sign-in is no longer valid; sign in again.");
    const lookup = calls.find(({ path }) => path === "/api/wallets/link-requests/lookup")!;
    expect(lookup.init.credentials).toBe("omit");
    expect(new Headers(lookup.init.headers).get("Authorization")).toBe(`Bearer ${PASTED_KEY}`);

    await act(async () => button("Sign out").click());
    await act(async () => {});
    expect(calls.filter(({ path }) => path === "/api/auth/logout").map(({ init }) => ({ method: init.method, credentials: init.credentials })))
      .toEqual([{ method: "POST", credentials: "include" }]);
    expect(cookieSessionLive).toBe(false);
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, address: null, sessionToken: null, sessionKeyId: null });
    expect(container.querySelector("#api-key")).not.toBeNull();
    expect(container.textContent).not.toContain(TITLE);
    expect(calls.map(({ path }) => path)).toEqual([
      "/api/auth/me", "/api/wallets/link-requests/lookup", "/api/auth/logout", "/api/auth/me",
    ]);

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<App />));
    expect(calls.filter(({ path }) => path === "/api/auth/me")).toHaveLength(3);
    expect(calls.filter(({ path }) => path === "/api/auth/session-key")).toHaveLength(0);
    expect(hasStoredApiKey()).toBe(false);
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: false, address: null, sessionToken: null, sessionKeyId: null });
    expect(container.querySelector("#api-key")).not.toBeNull();
    expect(container.textContent).not.toContain(TITLE);
    expect(window.location.pathname).toBe("/link");
  });
});
