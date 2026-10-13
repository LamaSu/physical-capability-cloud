// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));

// Keep App's actual BrowserRouter, Shell, auth store and lazy wallet page;
// isolate providers and unrelated shells so no wallet or telemetry SDK runs.
vi.mock("@pcc/ui", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-dashboard-chrome>{children}</div>,
  Sidebar: () => <aside data-dashboard-chrome />,
  TopBar: () => <header data-dashboard-chrome />,
  StatusBar: () => null,
  ParticleBackground: () => null,
}));
vi.mock("../components/nav-config.js", () => ({ navGroups: [] }));
vi.mock("../providers/WalletProvider.js", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../lib/telemetry.js", () => ({
  Sentry: { ErrorBoundary: ({ children }: { children: ReactNode }) => children },
  trackPageView: vi.fn(),
}));
vi.mock("../SpatialApp.js", () => ({ SpatialApp: () => <div data-dashboard-chrome>Spatial shell</div> }));
vi.mock("../pages/LoginPage.js", () => ({ LoginPage: () => <div data-login-page>Sign in</div> }));
vi.mock("../components/PageTransition.js", () => ({ PageTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/NotificationToasts.js", () => ({ NotificationToasts: () => null }));
vi.mock("../components/OnboardingTour.js", () => ({ OnboardingTour: () => null, TourRestartButton: () => null }));
vi.mock("../components/ConnectWallet.js", () => ({ ConnectWallet: () => null }));
vi.mock("../components/ModeToggle.js", () => ({ ModeToggle: () => null }));
vi.mock("../components/AgentLandingHero.js", () => ({ AgentLandingHero: () => null }));

import { App } from "../App.js";
import { WalletLinkPage } from "../pages/WalletLinkPage.js";
import { useAuthStore } from "../stores/auth-store.js";
import { useUIStore } from "../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HASH = "Ab".repeat(32);
const CONSENT = "SENTINEL_W4: terms supplied only by the gateway.\nA line stays inside this paragraph.\n\nSENTINEL_W4: the second paragraph, with its own terms.";
const TITLE = "Link a wallet to your PCC account";
const APPROVED = "Linked. Go back to your terminal; it continues on its own.";
const DENIED = "Denied. Nothing was linked.";

function request(text = CONSENT, role: "agent" | "device" = "agent") {
  return {
    requestId: "req_w4_private",
    role,
    keyType: role === "agent" ? "secp256k1" : "ed25519",
    address: role === "agent" ? "0x0123456789012345678901234567890123456789" : undefined,
    publicKey: role === "device" ? "device-public-key" : undefined,
    label: "terminal-wallet",
    clientInfo: { name: "pcc-cli", version: "test" },
    chainId: 84532,
    network: "Base Sepolia",
    requestedAt: "2026-10-13T00:00:00Z",
    requesterIpClass: "203.0.113.x",
    kernelId: role === "device" ? "kernel_test" : undefined,
    consent: { version: "wallet-link-v1", sha256: HASH, text },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let container: HTMLDivElement;
let root: Root;
let originalPath: string;
let originalAuth: boolean;
let originalMode: ReturnType<typeof useUIStore.getState>["interfaceMode"];

beforeEach(() => {
  authorizedFetch.mockReset();
  authorizedFetch.mockResolvedValue(json(request()));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected unmocked request"))));
  originalPath = window.location.pathname + window.location.search + window.location.hash;
  originalAuth = useAuthStore.getState().isAuthenticated;
  originalMode = useUIStore.getState().interfaceMode;
  window.history.replaceState({}, "", "/link");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAuthStore.setState({ isAuthenticated: originalAuth });
  useUIStore.setState({ interfaceMode: originalMode });
  window.history.replaceState({}, "", originalPath);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => root.render(<WalletLinkPage />));
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

async function typeCode(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function loadConsent() {
  await renderPage();
  await typeCode("wdjb mjht");
  await click("Continue");
}

async function confirmCode() {
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox).not.toBeNull();
  await act(async () => checkbox.click());
}

function lastDecision() {
  const [url, init] = authorizedFetch.mock.calls.at(-1)! as [string, RequestInit];
  expect(url).toMatch(/\/api\/wallets\/link-requests\/req_w4_private\/approve$/);
  expect(init.method).toBe("POST");
  expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  return JSON.parse(init.body as string);
}

describe("wallet link ceremony", () => {
  it.each(["wdjb mjht", "WDJB-MJHT"])("normalizes %s for the lookup", async (code) => {
    await renderPage();
    expect(button("Continue").disabled).toBe(true);
    expect(container.querySelector("input")!.getAttribute("autocomplete")).toBe("off");
    await typeCode(code);
    expect(button("Continue").disabled).toBe(false);
    await click("Continue");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch.mock.calls[0]![0]).toMatch(/\/api\/wallets\/link-requests\/by-code\/WDJBMJHT$/);
    expect(container.textContent).toContain("Code WDJB-MJHT");
  });

  it("requires exactly eight letters from the code alphabet", async () => {
    await renderPage();
    for (const value of ["WDJBMJH", "WDJBMJHTB", "ADJBMJHT", "WDJB0JHT", "WDJB!MJHT"]) {
      await typeCode(value);
      expect(button("Continue").disabled, value).toBe(true);
    }
    expect(authorizedFetch).not.toHaveBeenCalled();
  });

  it("renders exactly the server consent as two verbatim text paragraphs", async () => {
    await loadConsent();
    const consent = container.querySelector('[aria-label="Wallet link consent"]')!;
    expect(consent).not.toBeNull();
    expect([...consent.querySelectorAll("p")].map((p) => p.textContent)).toEqual(CONSENT.split("\n\n"));
    expect(consent.textContent).toBe(CONSENT.split("\n\n").join(""));
  });

  it.each(["agent", "device"] as const)("renders the %s variant only from server text", async (role) => {
    const text = `SERVER_${role}: variant terms.\n\nSERVER_${role}: its own permission line.`;
    authorizedFetch.mockResolvedValueOnce(json(request(text, role)));
    await loadConsent();
    expect([...container.querySelectorAll('[aria-label="Wallet link consent"] p')].map((p) => p.textContent)).toEqual(text.split("\n\n"));
    expect(container.textContent).not.toContain(`SERVER_${role === "agent" ? "device" : "agent"}`);
  });

  it("gates approval on the checkbox and posts exactly the typed code and server hash", async () => {
    await loadConsent();
    expect(button("Approve and link").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(false);
    expect(container.querySelector("label")!.textContent).toBe("My terminal shows this same code: WDJB-MJHT");
    await click("Approve and link");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    await confirmCode();
    expect(button("Approve and link").disabled).toBe(false);
    authorizedFetch.mockResolvedValueOnce(json({ status: "approved", linkId: "link_w4", accountId: "account_w4" }));
    await click("Approve and link");
    expect(lastDecision()).toEqual({ userCode: "WDJBMJHT", decision: "approve", consentSha256: HASH });
    expect(container.textContent).toContain(APPROVED);
    expect(container.textContent).toContain("link_w4");
    expect(container.textContent).not.toContain("account_w4");
    expect(container.textContent).not.toContain("WDJB");
    expect(container.textContent).not.toContain("SENTINEL_W4");
    expect(container.querySelector("input")).toBeNull();
  });

  it("denies without the checkbox, posts the server hash and clears the ceremony", async () => {
    await loadConsent();
    authorizedFetch.mockResolvedValueOnce(json({ status: "denied" }));
    await click("Deny");
    expect(lastDecision()).toEqual({ userCode: "WDJBMJHT", decision: "deny", consentSha256: HASH });
    expect(container.textContent).toContain(DENIED);
    expect(container.textContent).not.toContain("WDJB");
    expect(container.textContent).not.toContain("SENTINEL_W4");
    expect(container.querySelector("input")).toBeNull();
  });

  it("cannot approve before consent loads", async () => {
    let resolve!: (response: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await renderPage();
    await typeCode("WDJB-MJHT");
    await click("Continue");
    expect([...container.querySelectorAll("button")].some((b) => b.textContent === "Approve and link" && !b.disabled)).toBe(false);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    await act(async () => resolve(json(request())));
    expect(button("Approve and link").disabled).toBe(true);
  });

  it("renders markup in consent as text, creating no image element", async () => {
    const text = '<img src=x onerror=alert(1)>\n\nSERVER_MARKUP stays text.';
    authorizedFetch.mockResolvedValueOnce(json(request(text)));
    await loadConsent();
    expect(container.querySelector("img")).toBeNull();
    expect([...container.querySelectorAll('[aria-label="Wallet link consent"] p')].map((p) => p.textContent)).toEqual(text.split("\n\n"));
  });

  it.each([
    [404, "not_found", "No pending request with this code", "check the code and try again"],
    [429, "too_many_attempts", "Too many attempts", "wait 10 minutes"],
  ])("explains lookup error %s without creating a link", async (status, error, message, guidance) => {
    authorizedFetch.mockResolvedValueOnce(json({ error }, status as number));
    await loadConsent();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(guidance);
    expect(container.textContent).not.toContain(APPROVED);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it.each([
    [410, "expired", "expired", "start again in the terminal"],
    [409, "consent_changed", "terms changed", "reload the request"],
    [409, "already_decided", "already handled", ""],
    [409, "already_linked", "already handled", ""],
    [403, "code_mismatch", "code does not match", ""],
    [429, "too_many_attempts", "Too many attempts", "wait 10 minutes"],
    [500, "internal_private_details", "Could not reach PCC", "Nothing was linked"],
  ])("explains decision error %s %s without claiming success", async (status, error, message, guidance) => {
    await loadConsent();
    await confirmCode();
    authorizedFetch.mockResolvedValueOnce(json({ error }, status as number));
    await click("Approve and link");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(guidance);
    expect(container.textContent).not.toContain(APPROVED);
    expect(container.querySelector('[role="alert"]')!.textContent).not.toBe(error);
    if (String(error).includes("_")) expect(container.textContent).not.toContain(error);
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("reloads changed consent and requires a fresh confirmation", async () => {
    await loadConsent();
    await confirmCode();
    authorizedFetch.mockResolvedValueOnce(json({ error: "consent_changed" }, 409));
    await click("Approve and link");
    authorizedFetch.mockResolvedValueOnce(json({ ...request("RELOADED terms"), consent: { version: "wallet-link-v1", sha256: "c".repeat(64), text: "RELOADED terms" } }));
    await typeCode("WDJB-MJHT");
    await click("Continue");
    expect(container.textContent).toContain("RELOADED terms");
    expect(button("Approve and link").disabled).toBe(true);
  });

  it("explains a fetch rejection without logging private details", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    authorizedFetch.mockRejectedValueOnce(new Error("WDJBMJHT req_w4_private"));
    await loadConsent();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Could not reach PCC. Nothing was linked.");
    expect(container.textContent).not.toContain("req_w4_private");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("does not persist ceremony details or add them to the browser URL", async () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    await loadConsent();
    expect(window.location.pathname + window.location.search + window.location.hash).toBe("/link");
    expect(write).not.toHaveBeenCalled();
    expect(container.querySelector("main")!.classList.contains("ph-no-capture")).toBe(true);
    expect(container.querySelector("main")!.classList.contains("sentry-block")).toBe(true);
  });
});

describe("App /link auth and routing (actual private Shell through App)", () => {
  it("shows the existing login gate at /link until signed in, then the wallet page", async () => {
    useAuthStore.setState({ isAuthenticated: false });
    await act(async () => root.render(<App />));
    expect(container.querySelector("[data-login-page]")).not.toBeNull();
    expect(container.textContent).not.toContain(TITLE);
    await act(async () => useAuthStore.setState({ isAuthenticated: true }));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain(TITLE);
    });
    expect(container.querySelector("[data-login-page]")).toBeNull();
    expect(window.location.pathname).toBe("/link");
    expect(authorizedFetch).not.toHaveBeenCalled();
  });

  it.each(["agent", "dashboard", "spatial"] as const)("renders /link standalone in %s mode", async (interfaceMode) => {
    useAuthStore.setState({ isAuthenticated: true });
    useUIStore.setState({ interfaceMode });
    await act(async () => root.render(<App />));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain(TITLE);
    });
    expect(container.querySelector("[data-dashboard-chrome]")).toBeNull();
    expect(authorizedFetch).not.toHaveBeenCalled();
  });
});
