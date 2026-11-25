// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pcc/ui", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Sidebar: () => null, TopBar: () => null, StatusBar: () => null, ParticleBackground: () => null,
}));
vi.mock("../components/nav-config.js", () => ({ navGroups: [] }));
vi.mock("../providers/WalletProvider.js", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../lib/telemetry.js", () => ({ Sentry: { ErrorBoundary: ({ children }: { children: ReactNode }) => children }, trackPageView: vi.fn() }));
vi.mock("../SpatialApp.js", () => ({ SpatialApp: () => <div>Spatial shell</div> }));
vi.mock("../pages/LoginPage.js", () => ({ LoginPage: () => <div data-login>Sign in</div> }));
vi.mock("../pages/FundPage.js", () => ({ FundPage: ({ jobId }: { jobId: string | null }) => <div data-fund>{JSON.stringify(jobId)}</div> }));
vi.mock("../pages/WalletsPage.js", () => ({ WalletsPage: () => <div data-wallets /> }));
vi.mock("../pages/WalletLinkPage.js", () => ({ WalletLinkPage: () => <div data-link /> }));
vi.mock("../pages/JobDetailPage.js", () => ({ JobDetailPage: () => <div data-job /> }));
vi.mock("../components/PageTransition.js", () => ({ PageTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/NotificationToasts.js", () => ({ NotificationToasts: () => null }));
vi.mock("../components/OnboardingTour.js", () => ({ OnboardingTour: () => null, TourRestartButton: () => null }));
vi.mock("../components/ConnectWallet.js", () => ({ ConnectWallet: () => null }));
vi.mock("../components/ModeToggle.js", () => ({ ModeToggle: () => null }));
vi.mock("../components/AgentLandingHero.js", () => ({ AgentLandingHero: () => null }));

import { App } from "../App.js";
import { fundJobIdOf } from "../lib/fund-route.js";
import { useAuthStore } from "../stores/auth-store.js";
import { useUIStore } from "../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
let originalPath: string;
beforeEach(() => {
  originalAuth = useAuthStore.getState(); originalUI = useUIStore.getState();
  originalPath = location.pathname + location.search + location.hash;
  useAuthStore.setState({ isAuthenticated: true, sessionToken: null });
  useUIStore.setState({ interfaceMode: "dashboard" });
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unmocked request"))));
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  useAuthStore.setState(originalAuth); useUIStore.setState(originalUI);
  history.replaceState({}, "", originalPath); vi.unstubAllGlobals();
});
async function renderAt(path: string) {
  history.replaceState({}, "", path);
  await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); root.render(<App />); });
}
describe("fund route", () => {
  it.each([
    ["/fund/abc", "abc"], ["/fund/abc/", "abc"], ["/fund/a%2Fb", "a/b"], ["/fund/%E0%A4%A", null],
    ["/fund", undefined], ["/fund/", undefined], ["/Fund/abc", undefined], ["/fund/abc/x", undefined], ["/funds/abc", undefined],
  ])("C1: %s", (path, expected) => expect(fundJobIdOf(path!)).toBe(expected));
  it.each((["dashboard", "spatial", "agent"] as const).flatMap((mode) => ["/fund/abc", "/fund/abc/"].map((path) => ({ mode, path }))))(
    "C2: $path bypasses the $mode shell", async ({ mode, path }) => {
      useUIStore.setState({ interfaceMode: mode }); await renderAt(path);
      expect(container.querySelector("[data-fund]")?.textContent).toBe('"abc"');
      expect(container.textContent).not.toContain("Spatial shell");
    },
  );
  it.each(["/fund/abc", "/fund/abc/"])("C2: signed out at %s", async (path) => {
    useAuthStore.setState({ isAuthenticated: false, sessionToken: null }); await renderAt(path);
    expect(container.querySelector("[data-login]")).not.toBeNull(); expect(location.pathname).toBe(path);
  });
  it("C2: ignores query and fragment and passes a bad encoding as null", async () => {
    await renderAt("/fund/abc?jobId=other#other"); expect(container.querySelector("[data-fund]")?.textContent).toBe('"abc"');
    await renderAt("/fund/%E0%A4%A"); expect(container.querySelector("[data-fund]")?.textContent).toBe("null");
  });
  it.each([["/wallets", "data-wallets"], ["/link", "data-link"], ["/jobs/x", "data-job"]])("C2: preserves %s", async (path, marker) => {
    await renderAt(path); expect(container.querySelector(`[${marker}]`)).not.toBeNull();
  });
});
