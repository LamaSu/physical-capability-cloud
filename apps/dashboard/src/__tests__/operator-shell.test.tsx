// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { shellProps } = vi.hoisted(() => ({ shellProps: vi.fn() }));

vi.mock("@pcc/ui", () => ({
  AppShell: (props: { children: ReactNode; statusBar: ReactNode }) => {
    shellProps(props);
    return <div data-testid="dashboard-shell">{props.children}{props.statusBar}</div>;
  },
  Sidebar: () => null,
  TopBar: () => null,
  StatusBar: () => <footer data-testid="status-bar">kernels online active jobs</footer>,
  ParticleBackground: () => null,
}));
vi.mock("../components/nav-config.js", () => ({ navGroups: [] }));
vi.mock("../providers/WalletProvider.js", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../lib/telemetry.js", () => ({
  Sentry: { ErrorBoundary: ({ children }: { children: ReactNode }) => children },
}));
vi.mock("../components/ErrorBoundary.js", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../hooks/use-page-tracking.js", () => ({ usePageTracking: vi.fn() }));
vi.mock("../components/PageTransition.js", () => ({ PageTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/NotificationToasts.js", () => ({ NotificationToasts: () => null }));
vi.mock("../components/OnboardingTour.js", () => ({ OnboardingTour: () => null, TourRestartButton: () => null }));
vi.mock("../components/ModeToggle.js", () => ({ ModeToggle: () => null }));
vi.mock("../components/ConnectWallet.js", () => ({ ConnectWallet: () => null }));
vi.mock("../components/AgentLandingHero.js", () => ({ AgentLandingHero: () => null }));
vi.mock("../SpatialApp.js", () => ({ SpatialApp: () => <div data-testid="spatial-app" /> }));
vi.mock("../pages/AgentChatPage.js", () => ({ AgentChatPage: () => <div data-testid="agent-chat" /> }));
vi.mock("../pages/LoginPage.js", () => ({ LoginPage: () => <div data-testid="login-page" /> }));
vi.mock("../pages/OperatorDashboardPage.js", () => ({ OperatorDashboardPage: () => <div data-testid="operator-dashboard" /> }));
vi.mock("../pages/OperatorMachineDetailPage.js", () => ({ OperatorMachineDetailPage: () => <div data-testid="operator-machine-detail" /> }));
vi.mock("../pages/OperatorMobilePage.js", () => ({ OperatorMobilePage: () => <div data-testid="operator-mobile" /> }));
vi.mock("../pages/OnboardChatPage.js", () => ({ OnboardChatPage: () => <div data-testid="onboard-chat" /> }));
vi.mock("../pages/JobsPage.js", () => ({ JobsPage: () => <div data-testid="jobs-page" /> }));
vi.mock("../pages/RevenueDashboardPage.js", () => ({ RevenueDashboardPage: () => <div data-testid="revenue-dashboard" /> }));

import { App } from "../App.js";
import { useAuthStore } from "../stores/auth-store.js";
import { useUIStore, type InterfaceMode } from "../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let originalPath: string;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
const modes: InterfaceMode[] = ["spatial", "agent", "dashboard"];

beforeEach(() => {
  originalPath = window.location.pathname + window.location.search + window.location.hash;
  originalAuth = useAuthStore.getState();
  originalUI = useUIStore.getState();
  useAuthStore.setState({ isAuthenticated: true, sessionToken: null });
  useUIStore.setState({ interfaceMode: useUIStore.getInitialState().interfaceMode });
  shellProps.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useAuthStore.setState(originalAuth);
  useUIStore.setState(originalUI);
  window.history.replaceState({}, "", originalPath);
});

async function renderAt(path: string, mode: InterfaceMode) {
  useUIStore.getState().setMode(mode);
  window.history.replaceState({}, "", path);
  await act(async () => root.render(<App />));
}

function marker(name: string) {
  return container.querySelector(`[data-testid="${name}"]`);
}

async function expectPage(name: string, dashboard: boolean) {
  await vi.waitFor(() => expect(marker(name)).not.toBeNull());
  expect(Boolean(marker("dashboard-shell"))).toBe(dashboard);
  expect(marker("spatial-app")).toBeNull();
  expect(marker("agent-chat")).toBeNull();
}

describe("operator routes in the shell", () => {
  it("T1: retains spatial as the default interface mode", () => {
    expect(useUIStore.getInitialState().interfaceMode).toBe("spatial");
    expect(useUIStore.getState().interfaceMode).toBe("spatial");
  });

  it.each(modes)("T1: /operator renders the dashboard in %s mode", async (mode) => {
    await renderAt("/operator", mode);
    await expectPage("operator-dashboard", true);
    expect(useUIStore.getState().interfaceMode).toBe(mode);
  });

  it.each(modes)("T2: /operator/k1 renders the machine detail in %s mode", async (mode) => {
    await renderAt("/operator/k1", mode);
    await expectPage("operator-machine-detail", true);
    expect(useUIStore.getState().interfaceMode).toBe(mode);
  });

  it.each(modes)("T3: /operator/mobile stays standalone in %s mode", async (mode) => {
    await renderAt("/operator/mobile", mode);
    await expectPage("operator-mobile", false);
  });

  it.each(modes)("T3: /onboard/chat stays standalone and public in %s mode", async (mode) => {
    useAuthStore.setState({ isAuthenticated: false, sessionToken: null });
    await renderAt("/onboard/chat", mode);
    await expectPage("onboard-chat", false);
  });

  it("T4: /jobs follows spatial mode and an explicit dashboard mode change", async () => {
    await renderAt("/jobs", "spatial");
    expect(marker("spatial-app")).not.toBeNull();
    expect(marker("dashboard-shell")).toBeNull();
    await act(async () => useUIStore.getState().setMode("dashboard"));
    await expectPage("jobs-page", true);
  });

  it.each(modes)("T4b: /operator/revenue follows %s mode", async (mode) => {
    await renderAt("/operator/revenue", mode);
    if (mode === "dashboard") {
      await expectPage("revenue-dashboard", true);
    } else {
      await vi.waitFor(() => expect(marker(mode === "spatial" ? "spatial-app" : "agent-chat")).not.toBeNull());
      expect(marker("dashboard-shell")).toBeNull();
      expect(marker("revenue-dashboard")).toBeNull();
    }
  });

  it.each(modes)("T4b: /operator/revenue/ follows %s mode", async (mode) => {
    await renderAt("/operator/revenue/", mode);
    if (mode === "dashboard") {
      await expectPage("revenue-dashboard", true);
    } else {
      await vi.waitFor(() => expect(marker(mode === "spatial" ? "spatial-app" : "agent-chat")).not.toBeNull());
      expect(marker("dashboard-shell")).toBeNull();
      expect(marker("revenue-dashboard")).toBeNull();
    }
  });

  it.each(modes)("T5: /operator without access renders login in %s mode", async (mode) => {
    useAuthStore.setState({ isAuthenticated: false, sessionToken: null });
    await renderAt("/operator", mode);
    await expectPage("login-page", false);
    expect(marker("operator-dashboard")).toBeNull();
  });

  it("T1: a restored wallet session can reach /operator in default spatial mode", async () => {
    useAuthStore.setState({ isAuthenticated: false, sessionToken: "cookie" });
    await renderAt("/operator", "spatial");
    await expectPage("operator-dashboard", true);
  });

  it("T16: DashboardShell passes null and renders no constant status bar", async () => {
    await renderAt("/operator", "spatial");
    await expectPage("operator-dashboard", true);
    expect(shellProps).toHaveBeenCalled();
    expect(shellProps.mock.calls.every(([props]) => props.statusBar === null)).toBe(true);
    expect(marker("status-bar")).toBeNull();
    expect(container.textContent).not.toMatch(/kernels online|active jobs/i);
  });
});
