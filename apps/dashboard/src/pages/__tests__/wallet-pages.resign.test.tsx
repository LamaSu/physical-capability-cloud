/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalletsPage } from "../WalletsPage.js";
import { WalletLinkPage } from "../WalletLinkPage.js";
import { OperatorDashboardPage } from "../OperatorDashboardPage.js";
import { adoptApiKey, useAuthStore } from "../../stores/auth-store.js";
import { useOperatorStore } from "../../stores/operator-store.js";
import { useUIStore } from "../../stores/ui-store.js";
import { SIGN_IN_EXPIRED, SIGN_IN_REFUSED } from "../../lib/wallet-link-api.js";

const wallet = vi.hoisted(() => ({
  address: "0xAbCd12345678901234567890123456789012345678" as `0x${string}`,
  isConnected: true,
  signMessageAsync: vi.fn(async () => "signed"),
  disconnect: vi.fn(),
  onDisconnect: undefined as (() => void) | undefined,
}));
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: wallet.address, isConnected: wallet.isConnected, chainId: 1 }),
  useSignMessage: () => ({ signMessageAsync: wallet.signMessageAsync }),
  useConnect: () => ({ connectors: [], connect: vi.fn() }),
  useDisconnect: () => ({ disconnect: wallet.disconnect }),
  useConnectionEffect: ({ onDisconnect }: { onDisconnect: () => void }) => { wallet.onDisconnect = onDisconnect; },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ADDRESS = wallet.address;
const NEW_KEY = ["pcc", "test", "new0123456789abcdef"].join("_");
const PASTED = ["pcc", "test", "pasted0123456789abcdef"].join("_");
const CODE = "WDJBMJHT";
const LOOKUP = "/api/wallets/link-requests/lookup";
const DECISION = "/api/wallets/link-requests/request-1/approve";
const L1 = "Connect your wallet to sign in again.";
const MACHINE = { id: "shared-lathe", name: "North lathe", status: "online", last_heartbeat: null };
const expiry = () => new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
interface Call { path: string; init: RequestInit }
let calls: Call[];
let root: Root;
let container: HTMLDivElement;
let mintReply: () => Response | Promise<Response>;
let meValid: boolean;
let requestReply: (call: Call) => Response | Promise<Response>;
let extraRoots: { root: Root; container: HTMLDivElement; client: QueryClient }[];
let originalOperator: ReturnType<typeof useOperatorStore.getState>;
let originalUI: ReturnType<typeof useUIStore.getState>;
const pathOf = (input: RequestInfo | URL) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
const count = (path: string) => calls.filter((call) => call.path === path).length;
const bearer = (call: Call) => new Headers(call.init.headers).get("Authorization");
const minted = () => reply(201, { api_key: NEW_KEY, key_id: "session-key-1", operator_id: wallet.address, expires_at: expiry() });
const request = () => reply(200, { requestId: "request-1", consent: { version: "wallet-link-v1", sha256: "a".repeat(64), text: "Confirm the code shown by your terminal." } });
const row = (label: string) => ({ linkId: label, role: "agent", keyType: "secp256k1", address: ADDRESS, label, chainId: 1, status: "active", createdAt: "2026-11-06T00:00:00Z", expiresAt: null, revokedAt: null });

beforeEach(() => {
  wallet.address = ADDRESS;
  wallet.isConnected = true;
  wallet.onDisconnect = undefined;
  wallet.signMessageAsync.mockReset().mockResolvedValue("signed");
  wallet.disconnect.mockReset();
  adoptApiKey(null);
  localStorage.clear();
  sessionStorage.clear();
  // A reload restores the cookie placeholder, never a session key.
  useAuthStore.getState().setAddress(wallet.address);
  useAuthStore.getState().setSession("cookie");
  expect(useAuthStore.getState().sessionKeyId).toBeNull();
  calls = [];
  meValid = true;
  mintReply = minted;
  requestReply = () => reply(401, { error: "unauthorized" });
  extraRoots = [];
  originalOperator = useOperatorStore.getState();
  originalUI = useUIStore.getState();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { path: pathOf(input), init };
    calls.push(call);
    switch (call.path) {
      case "/api/auth/me": return reply(meValid ? 200 : 401, meValid ? { address: wallet.address } : { error: "session_required" });
      case "/api/auth/nonce": return reply(200, { nonce: "nonce" });
      case "/api/auth/verify": meValid = true; return reply(200, { token: "session-token", address: wallet.address });
      case "/api/auth/validate": return reply(200, { valid: true });
      case "/api/auth/session-key": return mintReply();
      case "/api/auth/logout": return reply(200, { ok: true });
      case "/api/auth/keys/session-key-1": return reply(200, {});
      default: return requestReply(call);
    }
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    for (const extra of extraRoots) extra.root.unmount();
    adoptApiKey(null);
  });
  for (const extra of extraRoots) { extra.client.clear(); extra.container.remove(); }
  container.remove();
  useOperatorStore.setState(originalOperator);
  useUIStore.setState(originalUI);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function buttons(label: string, host = container): HTMLButtonElement[] {
  return [...host.querySelectorAll("button")].filter((button) => button.textContent?.trim() === label);
}
function button(label: string, host = container): HTMLButtonElement {
  expect(buttons(label, host), label).toHaveLength(1);
  return buttons(label, host)[0];
}
function alerts(message: string) {
  return [...container.querySelectorAll('[role="alert"]')].filter((alert) => alert.textContent === message);
}
async function click(label: string, host = container) {
  await act(async () => button(label, host).click());
}
async function renderPage(page: "wallets" | "link") {
  await act(async () => root.render(page === "wallets" ? <MemoryRouter><WalletsPage /></MemoryRouter> : <WalletLinkPage />));
  expect(container.querySelector("main")?.classList.contains("ph-no-capture")).toBe(true);
  expect(container.querySelector("main")?.classList.contains("sentry-block")).toBe(true);
}
async function lookup() {
  const input = container.querySelector("input")!;
  expect(input).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, CODE);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Continue");
}
async function showFailure(page: "wallets" | "link") {
  await renderPage(page);
  if (page === "link") await lookup();
}
function expectRemedy(message = SIGN_IN_EXPIRED, signIn = true) {
  expect(alerts(message)).toHaveLength(1);
  expect(buttons("Sign out")).toHaveLength(1);
  expect(buttons("Sign in again")).toHaveLength(signIn ? 1 : 0);
}
function expectRecovered() {
  expect(alerts(SIGN_IN_EXPIRED)).toHaveLength(0);
  expect(buttons("Sign out")).toHaveLength(0);
  expect(buttons("Sign in again")).toHaveLength(0);
}

describe("wallet pages re-sign through the existing SIWE flow", () => {
  it("K1: /wallets offers both remedies after a reload's 401", async () => {
    await showFailure("wallets");
    expectRemedy();
    const read = calls.find((call) => call.path === "/api/wallets")!;
    expect(read.init.credentials).toBe("omit");
    expect(bearer(read)).toBeNull();
    expect(count("/api/auth/me")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(0);
  });

  it("K2: /link offers both remedies after a reload's lookup 401 without a Router", async () => {
    await showFailure("link");
    expectRemedy();
    const read = calls.find((call) => call.path === LOOKUP)!;
    expect(read.init.credentials).toBe("omit");
    expect(bearer(read)).toBeNull();
    expect(count("/api/auth/me")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(0);
  });

  it("K3: /wallets reloads with the minted key and drops a pre-mint read that finishes later", async () => {
    let finishOld!: (response: Response) => void;
    let reads = 0;
    requestReply = (call) => {
      expect(call.path).toBe("/api/wallets");
      expect(call.init.credentials).toBe("omit");
      if (bearer(call) === `Bearer ${NEW_KEY}`) return reply(200, { links: [row("new-key-wallet")] });
      if (++reads === 1) return reply(401, {});
      return new Promise((resolve) => { finishOld = resolve; });
    };
    await showFailure("wallets");
    await click("Sign in again");
    expect(finishOld).toBeTypeOf("function");
    expect(container.textContent).toContain("new-key-wallet");
    expectRecovered();
    expect(count("/api/auth/verify")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(1);
    expect(bearer(calls.find((call) => call.path === "/api/auth/session-key")!)).toBe("Bearer session-token");
    await act(async () => finishOld(reply(200, { links: [row("stale-wallet")] })));
    expect(container.textContent).toContain("new-key-wallet");
    expect(container.textContent).not.toContain("stale-wallet");
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });

  it.each(["lookup", "decision"] as const)("K3: /link recovers from a %s 401, uses the minted key and requires fresh consent", async (failure) => {
    let failed = false;
    requestReply = (call) => {
      expect(call.init.credentials).toBe("omit");
      if (!failed && call.path === (failure === "lookup" ? LOOKUP : DECISION)) {
        failed = true;
        return reply(401, {});
      }
      if (call.path === LOOKUP) return request();
      expect(call.path).toBe(DECISION);
      return reply(200, { status: "approved", linkId: "linked" });
    };
    await renderPage("link");
    await lookup();
    if (failure === "decision") {
      await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
      await click("Approve and link");
    }
    expectRemedy();
    const decisionsBefore = count(DECISION);
    await click("Sign in again");
    expectRecovered();
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("");
    expect(count(DECISION)).toBe(decisionsBefore);
    await lookup();
    expect(bearer(calls.filter((call) => call.path === LOOKUP).at(-1)!)).toBe(`Bearer ${NEW_KEY}`);
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    expect(button("Approve and link").disabled).toBe(true);
    await click("Approve and link");
    expect(count(DECISION)).toBe(decisionsBefore);
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await click("Approve and link");
    expect(count(DECISION)).toBe(decisionsBefore + 1);
    expect(bearer(calls.filter((call) => call.path === DECISION).at(-1)!)).toBe(`Bearer ${NEW_KEY}`);
  });

  it("K4: same-wallet re-sign changes sessionEpoch and keeps a confirmed emergency stop in a second root", async () => {
    requestReply = (call) => {
      if (call.path === "/api/agent/me") return reply(200, { ok: true, kernels: { count: 1, items: [MACHINE] } });
      if (call.path === "/api/operator/emergency-stop") return reply(200, { stopped: true, kernelId: MACHINE.id });
      return bearer(call) === `Bearer ${NEW_KEY}` ? reply(200, { links: [] }) : reply(401, {});
    };
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useOperatorStore.setState({ activeTab: "overview" });
    const host = document.createElement("div");
    document.body.append(host);
    const second = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    extraRoots.push({ root: second, container: host, client });
    await act(async () => second.render(<QueryClientProvider client={client}><MemoryRouter><OperatorDashboardPage /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(buttons(`EMERGENCY STOP: ${MACHINE.name}`, host)).toHaveLength(1)); });
    await click(`EMERGENCY STOP: ${MACHINE.name}`, host);
    expect(host.textContent).toContain(`EMERGENCY STOP ACTIVE for ${MACHINE.name}`);
    expect(button(`Resume Operations: ${MACHINE.name}`, host).disabled).toBe(false);
    await showFailure("wallets");
    const before = useAuthStore.getState().sessionEpoch;
    await click("Sign in again");
    expect(useAuthStore.getState().sessionEpoch).toBeGreaterThan(before);
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-1");
    expect(host.textContent).toContain(`EMERGENCY STOP ACTIVE for ${MACHINE.name}`);
    expect(button(`Resume Operations: ${MACHINE.name}`, host).disabled).toBe(false);
  });

  it("K5: page single flight survives a control remount while the signature is pending", async () => {
    const signatures: ((signature: string) => void)[] = [];
    wallet.signMessageAsync.mockImplementation(() => new Promise((resolve) => { signatures.push(resolve); }));
    await showFailure("wallets");
    const first = button("Sign in again");
    await act(async () => { first.click(); first.click(); });
    expect(count("/api/auth/nonce")).toBe(1);
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
    await act(async () => {
      wallet.address = "0x9999999999999999999999999999999999999999";
      useAuthStore.getState().setAddress(wallet.address);
    });
    expectRemedy();
    expect(button("Sign in again")).not.toBe(first);
    expect(button("Sign in again").disabled).toBe(true);
    await click("Sign in again");
    try {
      expect(count("/api/auth/nonce")).toBe(1);
      expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { for (const finish of signatures) finish("signed"); });
    }
    expect(count("/api/auth/session-key")).toBeLessThanOrEqual(1);
  });

  it("K5: /link single flight survives a control remount while the signature is pending", async () => {
    const signatures: ((signature: string) => void)[] = [];
    wallet.signMessageAsync.mockImplementation(() => new Promise((resolve) => { signatures.push(resolve); }));
    await showFailure("link");
    const first = button("Sign in again");
    await act(async () => { first.click(); first.click(); });
    expect(count("/api/auth/nonce")).toBe(1);
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
    // The code is still typed: Continue's lookup clears the alert, answers 401 and remounts the control.
    await click("Continue");
    expectRemedy();
    expect(button("Sign in again")).not.toBe(first);
    expect(button("Sign in again").disabled).toBe(true);
    await click("Sign in again");
    try {
      expect(count("/api/auth/nonce")).toBe(1);
      expect(wallet.signMessageAsync).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { for (const finish of signatures) finish("signed"); });
    }
    expect(count("/api/auth/session-key")).toBeLessThanOrEqual(1);
  });

  it.each(["wallets", "link"] as const)("K6: /%s displays a refused signature and allows exactly one retry", async (page) => {
    const refusal = "Signature refused by wallet";
    wallet.signMessageAsync.mockRejectedValueOnce(new Error(refusal));
    await showFailure(page);
    await click("Sign in again");
    expect(alerts(refusal)).toHaveLength(1);
    expect(button("Sign in again").disabled).toBe(false);
    expect(count("/api/auth/nonce")).toBe(1);
    expect(count("/api/auth/verify")).toBe(0);
    await click("Sign in again");
    expect(count("/api/auth/nonce")).toBe(2);
    expect(wallet.signMessageAsync).toHaveBeenCalledTimes(2);
    expect(count("/api/auth/verify")).toBe(1);
  });

  it.each(["wallets", "link"] as const)("K7: /%s asks for a connection instead of offering a dead re-sign button", async (page) => {
    wallet.isConnected = false;
    await showFailure(page);
    expectRemedy(SIGN_IN_EXPIRED, false);
    expect(container.textContent).toContain(L1);
    expect(buttons("Connect Wallet")).toHaveLength(1);
    expect(count("/api/auth/nonce")).toBe(0);
    expect(count("/api/auth/session-key")).toBe(0);
  });

  it.each(["wallets", "link"] as const)("F7: /%s hides an earlier auth error until this page attempts to sign in again", async (page) => {
    const earlierError = "Earlier wallet sign-in failed";
    const refusal = "Signature refused by wallet";
    useAuthStore.getState().setError(earlierError);
    wallet.isConnected = false;
    wallet.signMessageAsync.mockRejectedValueOnce(new Error(refusal));
    await showFailure(page);
    expectRemedy(SIGN_IN_EXPIRED, false);
    expect(container.textContent).toContain(L1);
    expect(buttons("Connect Wallet")).toHaveLength(1);
    expect(container.textContent).not.toContain(earlierError);
    wallet.isConnected = true;
    await renderPage(page);
    await click("Sign in again");
    expect(alerts(refusal)).toHaveLength(1);
    expect(button("Sign in again").disabled).toBe(false);
    expect(count("/api/auth/nonce")).toBe(1);
    expect(count("/api/auth/verify")).toBe(0);
  });

  it.each(["wallets", "link"] as const)("K8: /%s offers only Sign out for a pasted key's 401", async (page) => {
    useAuthStore.getState().setSession(null);
    adoptApiKey(PASTED);
    await showFailure(page);
    expectRemedy(SIGN_IN_EXPIRED, false);
    expect(buttons("Connect Wallet")).toHaveLength(0);
    expect(count("/api/auth/me")).toBe(0);
  });

  it.each(["wallets", "link"] as const)("K8: /%s keeps the pasted-key remedy when a wallet cookie also exists", async (page) => {
    adoptApiKey(PASTED);
    await showFailure(page);
    expectRemedy(SIGN_IN_EXPIRED, false);
    expect(count("/api/auth/me")).toBe(0);
  });

  it.each(["wallets", "link"] as const)("K9: /%s offers only Sign out for a wallet session's 403", async (page) => {
    requestReply = () => reply(403, { error: "insufficient_scope" });
    await showFailure(page);
    expectRemedy(SIGN_IN_REFUSED, false);
    expect(buttons("Connect Wallet")).toHaveLength(0);
    expect(count("/api/auth/me")).toBe(0);
  });

  it.each(["wallets", "link"] as const)("C2: /%s offers Sign in again when a held session key's 401 survives renewal", async (page) => {
    // A wallet sign-in holds a session key. The gateway then refuses it and /api/auth/me is down, so renewal keeps the key.
    await act(async () => {
      useAuthStore.getState().setSession("session-token");
      await useAuthStore.getState().mintSessionKey();
    });
    expect(useAuthStore.getState()).toMatchObject({ isAuthenticated: true, sessionKeyId: "session-key-1" });
    const stub = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      pathOf(input) === "/api/auth/me" ? reply(503, {}) : stub(input, init)));
    await showFailure(page);
    expectRemedy();
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-1");
  });

  it("F5: an unlink 401 followed by its reload's 401 shows one alert and one of each remedy", async () => {
    let reads = 0;
    requestReply = (call) => call.path === "/api/wallets" && ++reads === 1
      ? reply(200, { links: [row("unlink-wallet")] }) : reply(401, {});
    await renderPage("wallets");
    await click("Unlink");
    await click("Unlink");
    expectRemedy();
    expect(calls.filter((call) => call.path === "/api/wallets/unlink-wallet/revoke")).toHaveLength(1);
  });

  it.each([[401, "unauthorized", true], [403, "insufficient_scope", false]] as const)("L1: an unlink %s, then a reload that fails for another reason, keeps the unlink's remedy", async (status, code, signIn) => {
    let reads = 0;
    requestReply = (call) => call.path === "/api/wallets"
      ? (++reads === 1 ? reply(200, { links: [row("unlink-wallet")] }) : reply(500, {}))
      : reply(status, { error: code });
    await renderPage("wallets");
    await click("Unlink");
    await click("Unlink");
    expectRemedy(status === 401 ? SIGN_IN_EXPIRED : SIGN_IN_REFUSED, signIn);
    expect(alerts("Couldn't load your wallets.")).toHaveLength(1);
  });

  it.each(["wallets", "link"] as const)("K11: /%s says why a re-sign left no key when the session-key mint is refused", async (page) => {
    // The reload's restore path leaves its own notice; only this page's attempt may surface one.
    await act(async () => { await useAuthStore.getState().mintSessionKey(); });
    const restoreNotice = useAuthStore.getState().authNotice;
    expect(restoreNotice).toEqual(expect.any(String));
    mintReply = () => reply(429, { error: "too_many_keys", message: "Maximum 5 active API keys per operator" });
    await showFailure(page);
    expect(container.textContent).not.toContain(restoreNotice);
    await click("Sign in again");
    expect(count("/api/auth/verify")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    const notice = useAuthStore.getState().authNotice;
    expect(notice).toEqual(expect.any(String));
    expect(notice).not.toBe(restoreNotice);
    expect(container.textContent).toContain(notice);
  });

  it("K3: /link drops a lookup failure that was sent before the re-sign's key", async () => {
    const signatures: ((signature: string) => void)[] = [];
    wallet.signMessageAsync.mockImplementation(() => new Promise((resolve) => { signatures.push(resolve); }));
    let lookups = 0;
    let finishLookup: ((response: Response) => void) | undefined;
    requestReply = (call) => {
      if (call.path !== LOOKUP) return reply(404, {});
      if (++lookups === 2) return new Promise((resolve) => { finishLookup = resolve; });
      return lookups === 1 ? reply(401, {}) : request();
    };
    await showFailure("link");
    await click("Sign in again");
    // While the wallet prompt is open, the typed code goes out again with no key.
    await click("Continue");
    await act(async () => { for (const finish of signatures) finish("signed"); });
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-1");
    await act(async () => finishLookup?.(reply(401, {})));
    expect(alerts(SIGN_IN_EXPIRED)).toHaveLength(0);
    expect(buttons("Sign in again")).toHaveLength(0);
  });
});
