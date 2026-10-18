// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wallet = vi.hoisted(() => ({
  address: "0xAbCd12345678901234567890123456789012345678" as `0x${string}`,
  isConnected: true,
  signMessageAsync: vi.fn(async () => "signed"),
  onDisconnect: undefined as (() => void) | undefined,
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet.address, isConnected: wallet.isConnected, chainId: 1 }),
  useSignMessage: () => ({ signMessageAsync: wallet.signMessageAsync }),
  useConnect: () => ({ connectors: [], connect: vi.fn() }),
  useDisconnect: () => ({ disconnect: vi.fn() }),
  useConnectionEffect: ({ onDisconnect }: { onDisconnect: () => void }) => { wallet.onDisconnect = onDisconnect; },
}));

vi.mock("@pcc/ui", () => ({
  AppShell: ({ children, topBar }: { children: ReactNode; topBar?: ReactNode }) => <div>{topBar}{children}</div>,
  GlassPanel: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => <div onClick={onClick}>{children}</div>,
  Sidebar: () => null,
  TopBar: ({ actions }: { actions: ReactNode }) => <header>{actions}</header>,
  StatusBar: () => null,
  ParticleBackground: () => null,
  GlowBadge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  UtilizationGauge: () => null,
  EarningsChart: () => null,
  CertificationBadge: () => null,
  MaintenanceTimelineItem: () => null,
  AmountDisplay: () => null,
}));
vi.mock("../components/nav-config.js", () => ({ navGroups: [] }));
vi.mock("../providers/WalletProvider.js", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../lib/telemetry.js", () => ({
  Sentry: { ErrorBoundary: ({ children }: { children: ReactNode }) => children },
  trackPageView: vi.fn(),
}));
vi.mock("../components/ErrorBoundary.js", () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => children }));
vi.mock("../hooks/use-page-tracking.js", () => ({ usePageTracking: vi.fn() }));
vi.mock("../SpatialApp.js", () => ({ SpatialApp: () => null }));
vi.mock("../components/PageTransition.js", () => ({ PageTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/NotificationToasts.js", () => ({ NotificationToasts: () => null }));
vi.mock("../components/OnboardingTour.js", () => ({ OnboardingTour: () => null, TourRestartButton: () => null }));
vi.mock("../components/ModeToggle.js", () => ({ ModeToggle: () => null }));
vi.mock("../components/AgentLandingHero.js", () => ({ AgentLandingHero: () => null }));
vi.mock("../components/inbox/InboxPanel.js", () => ({ InboxPanel: () => null }));
vi.mock("../pages/LandingPage.js", () => ({ LandingPage: () => <div>Landing content</div> }));

import { App } from "../App.js";
import { adoptApiKey, useAuthStore } from "../stores/auth-store.js";
import { hasStoredApiKey } from "../lib/authorized-fetch.js";
import { useUIStore } from "../stores/ui-store.js";
import { useOperatorStore } from "../stores/operator-store.js";
import { OPERATOR_SIGN_IN_NOTICE } from "../lib/auth-notices.js";
import * as recovery from "../lib/session-key-recovery.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = ["pcc", "test", "session0123456789abcdef"].join("_");
const PASTED = ["pcc", "test", "pasted0123456789abcdef"].join("_");
const MACHINE = { id: "north-lathe", name: "North lathe", status: "online", last_heartbeat: null };
const notice = `Your wallet is signed in. ${OPERATOR_SIGN_IN_NOTICE}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
type Call = { path: string; init: RequestInit };
let calls: Call[];
let cookieLive: boolean;
let quickstartError: string;
let root: Root;
let container: HTMLDivElement;
let originalPath: string;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
let originalOperator: ReturnType<typeof useOperatorStore.getState>;

const seen = (path: string) => calls.filter((call) => call.path === path);
function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
}

beforeEach(() => {
  originalPath = window.location.pathname + window.location.search + window.location.hash;
  originalAuth = useAuthStore.getState();
  originalUI = useUIStore.getState();
  originalOperator = useOperatorStore.getState();
  adoptApiKey(null);
  useAuthStore.getState().setAddress(null);
  useAuthStore.getState().setSession(null);
  useAuthStore.setState({ authNotice: null });
  localStorage.clear();
  cookieLive = false;
  quickstartError = "api_key_required";
  calls = [];
  wallet.isConnected = true;
  wallet.signMessageAsync.mockClear();
  useUIStore.setState({ interfaceMode: "dashboard" as ReturnType<typeof useUIStore.getState>["interfaceMode"] });
  useOperatorStore.setState({ activeTab: "overview" });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const parsed = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const path = parsed.pathname + parsed.search;
    calls.push({ path, init });
    switch (path) {
      case "/api/auth/me":
        return cookieLive ? json({ address: wallet.address }) : json({ error: "session_required" }, 401);
      case "/api/auth/nonce": return json({ nonce: "nonce" });
      case "/api/auth/verify": cookieLive = true; return json({ token: "session-token", address: wallet.address });
      case "/api/auth/session-key": return json({ api_key: KEY, key_id: "session-key-1", operator_id: wallet.address, expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString() }, 201);
      case "/api/agent/me": return json({ ok: true, kernels: { count: 1, items: [MACHINE] } });
      case "/api/operator/emergency-stop": return json({ stopped: true, kernelId: MACHINE.id });
      case "/api/operator/approvals?status=pending": return json({ approvals: [{ id: "approval-1", agentId: "agent-1", capabilityType: "fdm", estimatedCost: 2, submittedAt: new Date().toISOString(), status: "pending" }] });
      case "/api/operator/approvals/approval-1/approve": return json({ ok: true });
      case "/api/contributors/quickstart": return json({ error: quickstartError }, 401);
      default: throw new Error(`Unexpected request: ${path}`);
    }
  }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  adoptApiKey(null);
  useAuthStore.setState(originalAuth);
  useUIStore.setState(originalUI);
  useOperatorStore.setState(originalOperator);
  localStorage.clear();
  window.history.replaceState({}, "", originalPath);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderAt(path: string) {
  window.history.replaceState({}, "", path);
  await act(async () => root.render(<App />));
}

async function submitQuickstart() {
  await vi.waitFor(() => expect(container.querySelector<HTMLInputElement>("#email")).not.toBeNull());
  const email = container.querySelector<HTMLInputElement>("#email")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(email, "contributor@example.com");
    email.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await vi.waitFor(() => expect(seen("/api/contributors/quickstart")).toHaveLength(1));
  return seen("/api/contributors/quickstart")[0];
}

describe("cookie-restored wallet in the rendered shell", () => {
  it("opens /operator, sends the emergency stop with cookies, and re-signs for decisions", async () => {
    cookieLive = true;
    await renderAt("/operator");
    await vi.waitFor(() => expect(button(`EMERGENCY STOP: ${MACHINE.name}`)).toBeDefined());
    expect(container.querySelector("#api-key")).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: "cookie", sessionKeyId: null, authNotice: notice });
    expect(hasStoredApiKey()).toBe(false);
    expect(button("Sign in again")).toBeDefined();
    expect(seen("/api/auth/session-key")).toHaveLength(0);

    await act(async () => button(`EMERGENCY STOP: ${MACHINE.name}`)!.click());
    await vi.waitFor(() => expect(seen("/api/operator/emergency-stop")).toHaveLength(1));
    const stop = seen("/api/operator/emergency-stop")[0];
    expect(stop.init.method).toBe("POST");
    expect(stop.init.credentials ?? "same-origin").toBe("same-origin");
    expect(new Headers(stop.init.headers).has("Authorization")).toBe(false);

    await act(async () => button("Sign in again")!.click());
    await vi.waitFor(() => expect(seen("/api/auth/session-key")).toHaveLength(1));
    const paths = calls.map((call) => call.path);
    expect(paths.indexOf("/api/auth/nonce")).toBeLessThan(paths.indexOf("/api/auth/verify"));
    expect(paths.indexOf("/api/auth/verify")).toBeLessThan(paths.indexOf("/api/auth/session-key"));
    const mint = seen("/api/auth/session-key")[0];
    expect({ ...mint.init, headers: Object.fromEntries(new Headers(mint.init.headers)) }).toEqual({
      method: "POST", credentials: "omit", redirect: "error", headers: { authorization: "Bearer session-token" },
    });
    expect(useAuthStore.getState().authNotice).toBeNull();
    expect(hasStoredApiKey()).toBe(true);
    expect(button("Sign in again")).toBeUndefined();

    await act(async () => button("approvals")!.click());
    await vi.waitFor(() => expect(button("Approve")).toBeDefined());
    await act(async () => button("Approve")!.click());
    await vi.waitFor(() => expect(seen("/api/operator/approvals/approval-1/approve")).toHaveLength(1));
    const approve = seen("/api/operator/approvals/approval-1/approve")[0];
    expect(approve.init.method).toBe("POST");
    expect(approve.init.credentials).toBe("omit");
    expect(new Headers(approve.init.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
  });

  it("hides re-sign when a pasted key is held alongside a cookie-restored session", async () => {
    cookieLive = true;
    await renderAt("/operator");
    await vi.waitFor(() => expect(button("Sign in again")).toBeDefined());
    await act(async () => adoptApiKey(PASTED, false));
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: "cookie", isAuthenticated: true });
    expect(button("Sign in again")).toBeUndefined();
  });

  it("keeps the login gate closed for a connected wallet that has not signed in", async () => {
    await renderAt("/operator");
    await vi.waitFor(() => expect(button("Sign In")).toBeDefined());
    expect(container.querySelector("#api-key")).not.toBeNull();
    expect(container.textContent).not.toContain("EMERGENCY STOP:");
    expect(button("Sign in again")).toBeUndefined();
    expect(seen("/api/auth/session-key")).toHaveLength(0);
  });

  it("uses a cookie-held session to leave /login while preserving the pasted-key preference", async () => {
    cookieLive = true;
    await renderAt("/login");
    await vi.waitFor(() => expect(container.textContent).toContain("Landing content"));
    expect(container.querySelector("#api-key")).toBeNull();
    expect(useAuthStore.getState().sessionToken).toBe("cookie");
    expect(button("Sign in again")).toBeUndefined();
    await act(async () => adoptApiKey(PASTED, false));
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().authNotice).toBeNull();
    expect(seen("/api/auth/session-key")).toHaveLength(0);
  });

  it("keeps one shared notice constant and no deprecated recovery notice export", async () => {
    expect(OPERATOR_SIGN_IN_NOTICE).toBe("Sign in again to enable operator actions.");
    expect(Object.keys(recovery)).not.toContain("SESSION_KEY_SIGN_IN_NOTICE");
    cookieLive = true;
    await renderAt("/operator");
    await vi.waitFor(() => expect(useAuthStore.getState().sessionToken).toBe("cookie"));
    expect(useAuthStore.getState().authNotice).toBe(notice);
    expect(container.textContent).toContain(notice);
  });
});

describe("contributor quickstart explicit credentials", () => {
  it.each(["anonymous", "key", "bearer", "cookie"] as const)(
    "sends the exact quickstart request in %s state", async (state) => {
      if (state === "key") adoptApiKey(PASTED, false);
      if (state === "bearer" || state === "cookie") {
        useAuthStore.getState().setAddress(wallet.address);
        useAuthStore.getState().setSession(state === "bearer" ? "session-token" : "cookie");
      }
      await renderAt("/earn");
      const call = await submitQuickstart();
      expect(call.init.method).toBe("POST");
      expect(new Headers(call.init.headers).get("Content-Type")).toBe("application/json");
      expect(JSON.parse(String(call.init.body))).toEqual({ email: "contributor@example.com", role: "operator", ratePercent: 1.5 });
      expect(new Headers(call.init.headers).get("Authorization")).toBe(state === "key" ? `Bearer ${PASTED}` : state === "bearer" ? "Bearer session-token" : null);
      expect(call.init.credentials).toBe(state === "bearer" ? "omit" : undefined);
      expect(call.init.redirect).toBe(state === "key" || state === "bearer" ? "error" : undefined);
    },
  );

  it("prefers a held key when a real sign-in bearer is also present", async () => {
    adoptApiKey(PASTED, false);
    useAuthStore.getState().setAddress(wallet.address);
    useAuthStore.getState().setSession("session-token");
    await renderAt("/earn");
    const call = await submitQuickstart();
    expect(new Headers(call.init.headers).get("Authorization")).toBe(`Bearer ${PASTED}`);
    expect(call.init.credentials).toBeUndefined();
    expect(call.init.redirect).toBe("error");
  });

  it("shows the shared re-sign control only after a 401 session_required response", async () => {
    quickstartError = "session_required";
    useAuthStore.getState().setAddress(wallet.address);
    useAuthStore.getState().setSession("cookie");
    await renderAt("/earn");
    const call = await submitQuickstart();
    expect(new Headers(call.init.headers).has("Authorization")).toBe(false);
    await vi.waitFor(() => expect(button("Sign in again")).toBeDefined());
    expect(container.textContent).toContain("Signup failed (401)");
    await act(async () => button("Sign in again")!.click());
    await vi.waitFor(() => expect(seen("/api/auth/session-key")).toHaveLength(1));
  });

  it("leaves a 401 api_key_required on the existing anonymous error path", async () => {
    await renderAt("/earn");
    await submitQuickstart();
    await vi.waitFor(() => expect(container.textContent).toContain("Signup failed (401)"));
    expect(button("Try again")).toBeDefined();
    expect(button("Sign in again")).toBeUndefined();
  });
});

describe("re-sign control edges", () => {
  it("lets a sign-in that reached the key limit through, with its notice and no Sign in again", async () => {
    const network = fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (new URL(target, window.location.origin).pathname !== "/api/auth/session-key") return network(input, init);
      calls.push({ path: "/api/auth/session-key", init });
      return json({ error: "too_many_keys" }, 429);
    }));
    await renderAt("/operator");
    await vi.waitFor(() => expect(button("Sign In")).toBeDefined());
    await act(async () => button("Sign In")!.click());
    await vi.waitFor(() => expect(button(`EMERGENCY STOP: ${MACHINE.name}`)).toBeDefined());
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: "session-token", isAuthenticated: false, sessionKeyId: null });
    expect(container.textContent).toContain("You have reached the active-key limit");
    expect(button("Sign in again")).toBeUndefined();
    expect(seen("/api/auth/session-key")).toHaveLength(1);
  });

  it("drops the quickstart re-sign control when a later attempt fails for another reason", async () => {
    quickstartError = "session_required";
    useAuthStore.getState().setAddress(wallet.address);
    useAuthStore.getState().setSession("cookie");
    await renderAt("/earn");
    await submitQuickstart();
    await vi.waitFor(() => expect(button("Sign in again")).toBeDefined());
    await act(async () => button("Try again")!.click());
    quickstartError = "api_key_required";
    calls = [];
    await submitQuickstart();
    await vi.waitFor(() => expect(button("Try again")).toBeDefined());
    expect(container.textContent).toContain("Signup failed (401)");
    expect(button("Sign in again")).toBeUndefined();
  });
});

describe("re-sign while a machine is stopped", () => {
  it("keeps a confirmed stop and its Resume control across Sign in again", async () => {
    cookieLive = true;
    await renderAt("/operator");
    await vi.waitFor(() => expect(button(`EMERGENCY STOP: ${MACHINE.name}`)).toBeDefined());
    await act(async () => button(`EMERGENCY STOP: ${MACHINE.name}`)!.click());
    await vi.waitFor(() => expect(button(`Resume Operations: ${MACHINE.name}`)).toBeDefined());
    await act(async () => button("Sign in again")!.click());
    await vi.waitFor(() => expect(hasStoredApiKey()).toBe(true));
    await vi.waitFor(() => expect(button(`Resume Operations: ${MACHINE.name}`)).toBeDefined());
    expect(container.textContent).toContain(`EMERGENCY STOP ACTIVE for ${MACHINE.name}`);
    expect(seen("/api/operator/emergency-stop")).toHaveLength(1);
  });

  it("disables Sign in again while the wallet signs", async () => {
    cookieLive = true;
    let release!: (signature: string) => void;
    wallet.signMessageAsync.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    await renderAt("/operator");
    await vi.waitFor(() => expect(button("Sign in again")).toBeDefined());
    await act(async () => button("Sign in again")!.click());
    await vi.waitFor(() => expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1));
    expect(button("Sign in again")!.disabled).toBe(true);
    await act(async () => button("Sign in again")!.click());
    expect(seen("/api/auth/nonce")).toHaveLength(1);
    await act(async () => release("signed"));
    await vi.waitFor(() => expect(seen("/api/auth/session-key")).toHaveLength(1));
    expect(seen("/api/auth/nonce")).toHaveLength(1);
  });
});

describe("re-sign after a failed attempt", () => {
  it("re-enables Sign in again after a refused signature, and the next click signs in", async () => {
    cookieLive = true;
    wallet.signMessageAsync.mockImplementationOnce(async () => { throw new Error("User rejected the request."); });
    await renderAt("/operator");
    await vi.waitFor(() => expect(button("Sign in again")).toBeDefined());
    await act(async () => button("Sign in again")!.click());
    await vi.waitFor(() => expect(useAuthStore.getState().error).toBe("User rejected the request."));
    await vi.waitFor(() => expect(button("Sign in again")!.disabled).toBe(false));
    expect(seen("/api/auth/session-key")).toHaveLength(0);
    await act(async () => button("Sign in again")!.click());
    await vi.waitFor(() => expect(seen("/api/auth/session-key")).toHaveLength(1));
    expect(seen("/api/auth/nonce")).toHaveLength(2);
    expect(hasStoredApiKey()).toBe(true);
  });
});
