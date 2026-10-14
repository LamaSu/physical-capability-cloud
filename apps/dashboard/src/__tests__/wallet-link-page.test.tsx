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
import { hasStoredApiKey } from "../lib/authorized-fetch.js";
import { adoptApiKey, useAuthStore } from "../stores/auth-store.js";
import { useUIStore } from "../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HASH = "Ab".repeat(32);
const USER_CODE = "WDJBMJHT";
const DISPLAY_CODE = "WDJB-MJHT";
const REQUEST_ID = "req_w4_private";
const ADDRESS = "0x0123456789012345678901234567890123456789";
const PUBLIC_KEY = "device-public-key";
const ACCOUNT_NAME = "SENTINEL_W4_ACCOUNT_OWNER";
const CONSENT = `SENTINEL_W4: Code ${DISPLAY_CODE}; link agent wallet ${ADDRESS} to account ${ACCOUNT_NAME}.\nA line stays inside this paragraph.\n\nSENTINEL_W4: the second paragraph, with its own terms.`;
const DEVICE_CONSENT = `SENTINEL_W4: Code ${DISPLAY_CODE}; link device public key ${PUBLIC_KEY} to account ${ACCOUNT_NAME}.\nA line stays inside this paragraph.\n\nSENTINEL_W4: the second paragraph, with device terms.`;
const SENSITIVE_VALUES = [USER_CODE, DISPLAY_CODE, REQUEST_ID, ADDRESS, PUBLIC_KEY, ACCOUNT_NAME, CONSENT, DEVICE_CONSENT];
const TITLE = "Link a wallet to your PCC account";
const APPROVED = "Linked. Go back to your terminal; it continues on its own.";
const DENIED = "Denied. Nothing was linked.";
const UNKNOWN_APPROVAL = "PCC did not confirm your decision. The link may have been made; check your terminal before trying again.";
const UNKNOWN_DENIAL = "PCC did not confirm your denial. The request expires on its own.";
const SIGN_IN_CHANGED = "Your sign-in changed; enter the code again.";
const REFUSED = "PCC refused this request, so nothing was linked. Reload the page and try again.";
const ALREADY_LINKED = "This wallet is already linked to a PCC account, so nothing was linked. Stop the command in your terminal, or start again there with a new key.";

const privateFailure = SENSITIVE_VALUES.join(" ");
const failures = [
  { name: "fetch rejection", reply: () => Promise.reject(new Error(privateFailure)) },
  { name: "timeout", reply: () => Promise.reject(new DOMException(privateFailure, "TimeoutError")) },
  ...[
    [404, "not_found"], [429, "too_many_attempts"], [410, "expired"],
    [409, "consent_changed"], [409, "already_decided"], [409, "already_linked"],
    [403, "code_mismatch"], [403, "insufficient_scope"], [401, "unauthorized"],
    [418, "unknown_error"], [500, "internal_error"], [502, "bad_gateway"],
  ].map(([status, error]) => ({
    name: `${status} ${error}`,
    reply: () => Promise.resolve(json({ error, detail: privateFailure }, status as number)),
  })),
  { name: "malformed JSON", reply: () => Promise.resolve(new Response(privateFailure, { status: 200 })) },
  { name: "invalid success body", reply: () => Promise.resolve(json({ detail: privateFailure })) },
];

function request(text: string | undefined = undefined, role: "agent" | "device" = "agent") {
  return {
    requestId: REQUEST_ID,
    role,
    keyType: role === "agent" ? "secp256k1" : "ed25519",
    address: role === "agent" ? ADDRESS : undefined,
    publicKey: role === "device" ? PUBLIC_KEY : undefined,
    label: "terminal-wallet",
    clientInfo: { name: "pcc-cli", version: "test" },
    chainId: 84532,
    network: "Base Sepolia",
    requestedAt: "2026-10-13T00:00:00Z",
    requesterIpClass: "203.0.113.x",
    kernelId: role === "device" ? "kernel_test" : undefined,
    consent: { version: "wallet-link-v1", sha256: HASH, text: text ?? (role === "agent" ? CONSENT : DEVICE_CONSENT) },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let container: HTMLDivElement;
let root: Root;
let originalPath: string;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalMode: ReturnType<typeof useUIStore.getState>["interfaceMode"];
let originalStorage: [Storage, [string, string][]][];

function storageContents(storage: Storage): [string, string][] {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)!;
    return [key, storage.getItem(key)!];
  });
}

function expectNoSensitive(value: unknown, context: string) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value, (_key, entry: unknown) => entry instanceof Error ? entry.message : entry) ?? "";
  const forms = [serialized];
  try { forms.push(decodeURIComponent(decodeURIComponent(serialized))); } catch { /* Keep checking malformed URLs verbatim. */ }
  for (const form of forms) {
    for (const sensitive of SENSITIVE_VALUES) {
      expect(form, context).not.toContain(sensitive);
      // Console argument serialization escapes the consent's paragraph breaks.
      expect(form, context).not.toContain(JSON.stringify(sensitive).slice(1, -1));
    }
    expect(form.toUpperCase().replace(/[\s-]/g, ""), context).not.toContain(USER_CODE);
  }
}

beforeEach(() => {
  authorizedFetch.mockReset();
  authorizedFetch.mockResolvedValue(json(request()));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected unmocked request"))));
  originalPath = window.location.pathname + window.location.search + window.location.hash;
  originalAuth = useAuthStore.getState();
  originalMode = useUIStore.getState().interfaceMode;
  originalStorage = [localStorage, sessionStorage].map((storage) => [storage, storageContents(storage)]);
  window.history.replaceState({}, "", "/link");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  adoptApiKey(null);
  useAuthStore.setState(originalAuth);
  useUIStore.setState({ interfaceMode: originalMode });
  for (const [storage, contents] of originalStorage) {
    storage.clear();
    for (const [key, value] of contents) storage.setItem(key, value);
  }
  window.history.replaceState({}, "", originalPath);
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
  expect(init.credentials).toBe("omit");
  expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  return JSON.parse(init.body as string);
}

describe("wallet link ceremony", () => {
  it.each(["wdjb mjht", "WDJB-MJHT"])("normalizes %s for POST lookup without a code in any request URL", async (code) => {
    await renderPage();
    expect(button("Continue").disabled).toBe(true);
    expect(container.querySelector("input")!.getAttribute("autocomplete")).toBe("off");
    await typeCode(code);
    expect(button("Continue").disabled).toBe(false);
    await click("Continue");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = authorizedFetch.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/wallets/link-requests/lookup");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({ userCode: "WDJBMJHT" });
    expect(container.textContent).toContain("Code WDJB-MJHT");
    await confirmCode();
    authorizedFetch.mockResolvedValueOnce(json({ status: "approved", linkId: "link_w4" }));
    await click("Approve and link");
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    for (const [calledUrl] of authorizedFetch.mock.calls) {
      expect(decodeURIComponent(String(calledUrl)).toUpperCase().replace(/[\s-]/g, "")).not.toContain("WDJBMJHT");
    }
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
    const text = role === "agent" ? CONSENT : DEVICE_CONSENT;
    authorizedFetch.mockResolvedValueOnce(json(request(undefined, role)));
    await loadConsent();
    expect([...container.querySelectorAll('[aria-label="Wallet link consent"] p')].map((p) => p.textContent)).toEqual(text.split("\n\n"));
    expect(container.textContent).not.toContain(role === "agent" ? PUBLIC_KEY : ADDRESS);
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

  it("disables Deny during pending approval and sends no second decision", async () => {
    await loadConsent();
    await confirmCode();
    let resolve!: (response: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await click("Approve and link");
    await click("Deny");
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    expect(lastDecision().decision).toBe("approve");
    expect(button("Deny").disabled).toBe(true);
    expect(button("Approve and link").disabled).toBe(true);
    await act(async () => resolve(json({ status: "approved", linkId: "link_w4" })));
    expect(container.textContent).toContain(APPROVED);
  });

  it("guards rapid decisions before the busy state renders", async () => {
    await loadConsent();
    await confirmCode();
    let resolve!: (response: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await act(async () => {
      button("Approve and link").click();
      button("Deny").click();
    });
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    await act(async () => resolve(json({ status: "approved", linkId: "link_w4" })));
  });

  it("guards rapid lookup submits before the busy state renders", async () => {
    let resolve!: (response: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await renderPage();
    await typeCode(DISPLAY_CODE);
    await act(async () => {
      const form = container.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    await act(async () => resolve(json(request())));
  });

  it.each(["approve", "deny"] as const)("drops consent if keyEpoch changes before %s and sends no decision", async (decision) => {
    await loadConsent();
    await confirmCode();
    await act(async () => useAuthStore.setState((state) => ({ keyEpoch: state.keyEpoch + 1 })));
    await click(decision === "approve" ? "Approve and link" : "Deny");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(SIGN_IN_CHANGED);
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("");
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain("SENTINEL_W4");
    expect(container.textContent).not.toContain("WDJB");
  });

  it("discards a lookup response if the sign-in changes while consent loads", async () => {
    let resolve!: (response: Response) => void;
    authorizedFetch.mockReturnValueOnce(new Promise<Response>((done) => { resolve = done; }));
    await renderPage();
    await typeCode("WDJB-MJHT");
    await click("Continue");
    await act(async () => useAuthStore.setState((state) => ({ keyEpoch: state.keyEpoch + 1 })));
    await act(async () => resolve(json(request())));
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(SIGN_IN_CHANGED);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
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
    [403, "insufficient_scope", "PCC refused this with your current sign-in.", ""],
    [401, "unauthorized", "Your sign-in is no longer valid; sign in again.", ""],
    [400, "invalid_request", REFUSED, ""],
  ])("explains lookup error %s without creating a link", async (status, error, message, guidance) => {
    authorizedFetch.mockResolvedValueOnce(json({ error }, status as number));
    await loadConsent();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(guidance);
    expect(container.textContent).not.toContain(APPROVED);
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  const decisionErrors = (["approve", "deny"] as const).flatMap((decision) => [
    { status: 404, error: "not_found", message: "No pending request with this code", guidance: "check the code and try again" },
    { status: 410, error: "expired", message: "expired", guidance: "start again in the terminal" },
    { status: 409, error: "consent_changed", message: "terms changed", guidance: "reload the request" },
    { status: 409, error: "already_decided", message: "already handled", guidance: "" },
    { status: 409, error: "already_linked", message: ALREADY_LINKED, guidance: "" },
    { status: 403, error: "code_mismatch", message: "code does not match", guidance: "" },
    { status: 403, error: "insufficient_scope", message: "PCC refused this with your current sign-in.", guidance: "" },
    { status: 401, error: "unauthorized", message: "Your sign-in is no longer valid; sign in again.", guidance: "" },
    { status: 429, error: "too_many_attempts", message: "Too many attempts", guidance: "wait 10 minutes" },
    { status: 500, error: "internal_private_details", message: decision === "approve" ? UNKNOWN_APPROVAL : UNKNOWN_DENIAL, guidance: "" },
    ...[
      [400, "invalid_request"], [400, "key_material_refused"], [405, "method_not_allowed"],
      [422, "unprocessable_content"], [409, "unknown_code"],
    ].map(([status, error]) => ({ status: status as number, error: error as string, message: REFUSED, guidance: "" })),
  ].map((row) => ({ ...row, decision })));

  it.each(decisionErrors)("explains $decision error $status $error without claiming success", async ({ status, error, message, guidance, decision }) => {
    await loadConsent();
    if (decision === "approve") await confirmCode();
    authorizedFetch.mockResolvedValueOnce(json({ error }, status));
    await click(decision === "approve" ? "Approve and link" : "Deny");
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(message);
    expect(container.querySelector('[role="alert"]')!.textContent).toContain(guidance);
    expect(container.textContent).not.toContain(APPROVED);
    expect(container.querySelector('[role="alert"]')!.textContent).not.toBe(error);
    if (message === REFUSED || message === ALREADY_LINKED) {
      expect(container.querySelector('[role="alert"]')!.textContent).toBe(message);
      expect(container.textContent).not.toContain("Could not reach");
    }
    if (error === "already_linked") expect(container.textContent).not.toContain("already handled");
    if (String(error).includes("_")) expect(container.textContent).not.toContain(error);
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it.each((["lookup", "approve", "deny"] as const).flatMap((stage) => [401, 403].map((status) => ({ stage, status }))))(
    "offers Sign out after $stage $status and clears the held key",
    async ({ stage, status }) => {
      adoptApiKey(["pcc", "test", "walletlinkowner0123456789"].join("_"));
      expect(hasStoredApiKey()).toBe(true);
      const failure = json({ error: status === 401 ? "unauthorized" : "insufficient_scope" }, status);
      if (stage === "lookup") {
        authorizedFetch.mockResolvedValueOnce(failure);
        await loadConsent();
      } else {
        await loadConsent();
        if (stage === "approve") await confirmCode();
        authorizedFetch.mockResolvedValueOnce(failure);
        await click(stage === "approve" ? "Approve and link" : "Deny");
      }
      expect(button("Sign out").disabled).toBe(false);
      await click("Sign out");
      expect(hasStoredApiKey()).toBe(false);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    },
  );

  it.each((["lookup", "approve", "deny"] as const).flatMap((stage) => [
    ...failures.filter(({ name }) => !["401 unauthorized", "403 insufficient_scope"].includes(name)),
    { name: "400 invalid_request", reply: () => Promise.resolve(json({ error: "invalid_request" }, 400)) },
  ].map((failure) => ({ ...failure, stage }))))("has no Sign out for $stage $name", async ({ stage, reply }) => {
    if (stage === "lookup") {
      authorizedFetch.mockImplementationOnce(reply);
      await loadConsent();
    } else {
      await loadConsent();
      if (stage === "approve") await confirmCode();
      authorizedFetch.mockImplementationOnce(reply);
      await click(stage === "approve" ? "Approve and link" : "Deny");
    }
    expect([...container.querySelectorAll("button")].some((element) => element.textContent === "Sign out")).toBe(false);
  });

  const unknownDecisions = [
    ...failures.filter(({ name }) => ["fetch rejection", "timeout", "500 internal_error", "502 bad_gateway", "malformed JSON", "invalid success body"].includes(name)),
    { name: "200 approved missing linkId", reply: () => Promise.resolve(json({ status: "approved" })) },
    { name: "200 linkId missing status", reply: () => Promise.resolve(json({ linkId: "link_w4" })) },
    { name: "200 opposite decision status", reply: () => Promise.resolve(json({ status: "denied" })) },
  ];

  it.each(unknownDecisions)("shows an unknown approval outcome for $name", async ({ reply }) => {
    await loadConsent();
    await confirmCode();
    authorizedFetch.mockImplementationOnce(reply);
    await click("Approve and link");
    expect(container.textContent).not.toContain("Nothing was linked");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(UNKNOWN_APPROVAL);
    expect(container.textContent).not.toContain(APPROVED);
    expect(container.querySelector<HTMLInputElement>('input[type="text"]')!.value).toBe("");
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
  });

  it.each(unknownDecisions)("shows an unconfirmed denial for $name", async ({ name, reply }) => {
    await loadConsent();
    authorizedFetch.mockImplementationOnce(name === "200 opposite decision status"
      ? () => Promise.resolve(json({ status: "approved", linkId: "link_w4" })) : reply);
    await click("Deny");
    expect(container.textContent).not.toContain("Nothing was linked");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(UNKNOWN_DENIAL);
    expect(container.textContent).not.toContain(APPROVED);
    expect(authorizedFetch).toHaveBeenCalledTimes(2);
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
    authorizedFetch.mockRejectedValueOnce(new Error("WDJBMJHT req_w4_private"));
    await loadConsent();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Could not reach PCC. Nothing was linked.");
    expect(container.textContent).not.toContain("req_w4_private");
  });

  const hygieneScenarios = (["agent", "device"] as const).flatMap((role) => (["lookup", "approve", "deny"] as const).flatMap((stage) => [
    { name: `${stage} success`, stage, reply: () => Promise.resolve(json(stage === "lookup" ? request(undefined, role) : stage === "approve" ? { status: "approved", linkId: "link_w4" } : { status: "denied" })) },
    ...failures.map((failure) => ({ ...failure, name: `${stage} ${failure.name}`, stage })),
    ...(stage === "lookup" ? [] : [
      { name: `${stage} missing linkId`, stage, reply: () => Promise.resolve(json({ status: "approved", detail: privateFailure })) },
      { name: `${stage} opposite decision status`, stage, reply: () => Promise.resolve(json(stage === "approve" ? { status: "denied" } : { status: "approved", linkId: "link_w4" })) },
    ]),
  ].map((scenario) => ({ ...scenario, role, name: `${role} ${scenario.name}` }))));

  it.each(hygieneScenarios)("keeps sensitive values out of console, storage and browser URLs during $name", async ({ stage, reply, role }) => {
    const spies = (["log", "info", "debug", "warn", "error", "trace"] as const)
      .map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    // jsdom Storage instances share this method; instance spies do not intercept it.
    // mock.instances lets us inspect localStorage and sessionStorage writes separately.
    const storageWrites = vi.spyOn(Storage.prototype, "setItem");
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    authorizedFetch.mockResolvedValue(json(request(undefined, role)));
    if (stage === "lookup") {
      authorizedFetch.mockImplementationOnce(reply);
      await loadConsent();
    } else {
      await loadConsent();
      if (stage === "approve") await confirmCode();
      authorizedFetch.mockImplementationOnce(reply);
      await click(stage === "approve" ? "Approve and link" : "Deny");
    }
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expectNoSensitive(call, "console arguments");
      }
    }
    for (const [name, storage] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]] as const) {
      const calls = storageWrites.mock.calls.filter((_call, index) => (storageWrites.mock.instances[index] as unknown) === storage);
      for (const [key, value] of calls) {
        expectNoSensitive(key, `${name} write key`);
        expectNoSensitive(value, `${name} write value`);
      }
      for (const [key, value] of storageContents(storage)) {
        expectNoSensitive(key, `${name} stored key`);
        expectNoSensitive(value, `${name} stored value`);
      }
    }
    for (const spy of [pushState, replaceState]) {
      for (const call of spy.mock.calls) expectNoSensitive(String(call[2] ?? ""), "history URL");
    }
    expectNoSensitive(window.location.href, "current browser URL");
    expect(authorizedFetch).toHaveBeenCalledTimes(stage === "lookup" ? 1 : 2);
    expect(container.querySelector("main")!.classList.contains("ph-no-capture")).toBe(true);
    expect(container.querySelector("main")!.classList.contains("sentry-block")).toBe(true);
  });
});

describe("App /link auth and routing (actual private Shell through App)", () => {
  it("returns to the sign-in gate at /link after signing out from a 401", async () => {
    adoptApiKey(["pcc", "test", "walletlinkowner0123456789"].join("_"));
    authorizedFetch.mockResolvedValueOnce(json({ error: "unauthorized" }, 401));
    await act(async () => root.render(<App />));
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.textContent).toContain(TITLE);
    });
    await typeCode(DISPLAY_CODE);
    await click("Continue");
    await click("Sign out");
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(container.querySelector("[data-login-page]")).not.toBeNull();
    expect(window.location.pathname).toBe("/link");
  });

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
