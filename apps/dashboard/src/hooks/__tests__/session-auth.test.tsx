/** @vitest-environment jsdom */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "../use-auth.js";
import { adoptApiKey, useAuthStore } from "../../stores/auth-store.js";
import { authorizedFetch, hasStoredApiKey } from "../../lib/authorized-fetch.js";
import { LoginPage } from "../../pages/LoginPage.js";

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
const KEY = ["pcc", "test", "session0123456789abcdef"].join("_");
const PASTED = ["pcc", "test", "pasted0123456789abcdef"].join("_");
const NEXT = ["pcc", "test", "renewed0123456789abcdef"].join("_");
const expiry = () => new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
interface Call { path: string; init: RequestInit }
let calls: Call[];
let root: Root;
let container: HTMLDivElement;
let auth: ReturnType<typeof useAuth>;
let mintReply: () => Response | Promise<Response>;
let meValid: boolean;
let requestReply: (call: Call) => Response | Promise<Response>;
let deleteStatus: number;

function Harness() { auth = useAuth(); return <p>{auth.authNotice}</p>; }
function SecondUser() { useAuth(); return null; }
const pathOf = (input: RequestInfo | URL) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin).pathname;
const count = (path: string) => calls.filter((call) => call.path === path).length;
const minted = (key = KEY, id = "session-key-1") => reply(201, { api_key: key, key_id: id, operator_id: wallet.address, expires_at: expiry() });

beforeEach(async () => {
  wallet.isConnected = true;
  wallet.onDisconnect = undefined;
  adoptApiKey(null);
  localStorage.clear();
  sessionStorage.clear();
  calls = [];
  meValid = false;
  deleteStatus = 200;
  mintReply = () => minted();
  requestReply = () => reply(200, { ok: true });
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
      case "/api/auth/keys/session-key-1": return reply(deleteStatus, {});
      default: return requestReply(call);
    }
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => { root.unmount(); adoptApiKey(null); });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signIn() { await act(async () => { await auth.login(); }); }
async function request(path = "/api/jobs/submit") {
  let response!: Response;
  await act(async () => { response = await authorizedFetch(path, { method: "POST", body: "payload" }); });
  return response;
}

describe("wallet session credentials", () => {
  it("mints once after verification with cookies and adopts volatile metadata", async () => {
    const writes = vi.spyOn(Storage.prototype, "setItem");
    await signIn();
    expect(count("/api/auth/session-key")).toBe(1);
    const mint = calls.find((call) => call.path === "/api/auth/session-key")!;
    expect(mint.init.method).toBe("POST");
    expect(mint.init.credentials).toBe("include");
    expect(new Headers(mint.init.headers).has("x-api-key")).toBe(false);
    expect(new Headers(mint.init.headers).has("Authorization")).toBe(false);
    expect(calls.findIndex((call) => call.path === "/api/auth/verify")).toBeLessThan(calls.indexOf(mint));
    expect(hasStoredApiKey()).toBe(true);
    expect(useAuthStore.getState()).toMatchObject({ sessionKeyId: "session-key-1", sessionKeyExpiresAt: expect.any(String) });
    expect(Object.values(useAuthStore.getState())).not.toContain(KEY);
    expect(writes.mock.calls).toEqual([]);
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(sessionStorage.length).toBe(0);
    await request();
    expect(new Headers(calls.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
  });

  it("keeps a pasted key when the wallet also signs in", async () => {
    await act(async () => { expect(await useAuthStore.getState().login(PASTED)).toBe(true); });
    await signIn();
    expect(count("/api/auth/session-key")).toBe(0);
    expect(useAuthStore.getState().sessionKeyId).toBeNull();
    expect(useAuthStore.getState().sessionKeyExpiresAt).toBeNull();
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED);
    await request();
    expect(new Headers(calls.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${PASTED}`);
    calls = [];
    requestReply = () => reply(401, {});
    expect((await request()).status).toBe(401);
    expect(count("/api/auth/me")).toBe(0);
    expect(count("/api/auth/session-key")).toBe(0);
    expect(hasStoredApiKey()).toBe(true);
  });

  it("renews before expiry while the app is open", async () => {
    vi.useFakeTimers();
    mintReply = () => reply(201, { api_key: KEY, key_id: "session-key-1", operator_id: wallet.address, expires_at: new Date(Date.now() + 6 * 60 * 1000).toISOString() });
    await signIn();
    mintReply = () => minted(NEXT, "session-key-2");
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 1000); });
    expect(count("/api/auth/session-key")).toBe(2);
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-2");
  });

  it("does not replace a pasted key with a pending wallet mint", async () => {
    let finish!: (response: Response) => void;
    mintReply = () => new Promise((resolve) => { finish = resolve; });
    let login!: Promise<void>;
    await act(async () => { login = auth.login(); await Promise.resolve(); await Promise.resolve(); });
    await vi.waitFor(() => expect(count("/api/auth/session-key")).toBe(1));
    await act(async () => {
      await useAuthStore.getState().login(PASTED);
      finish(minted());
      await login;
    });
    await request();
    expect(new Headers(calls.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${PASTED}`);
    expect(useAuthStore.getState().sessionKeyId).toBeNull();
  });

  it("starts a fresh mint after signing out with an earlier mint pending", async () => {
    let finish!: (response: Response) => void;
    let attempts = 0;
    mintReply = () => ++attempts === 1 ? new Promise((resolve) => { finish = resolve; }) : minted(NEXT, "session-key-2");
    let first!: Promise<void>;
    await act(async () => { first = auth.login(); });
    await vi.waitFor(() => expect(count("/api/auth/session-key")).toBe(1));
    await act(async () => { await auth.logout(); });
    let second!: Promise<void>;
    await act(async () => { second = auth.login(); });
    try {
      await vi.waitFor(() => expect(count("/api/auth/session-key")).toBe(2));
    } finally {
      await act(async () => { finish(minted()); await Promise.all([first, second]); });
    }
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-2");
    await request();
    expect(new Headers(calls.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${NEXT}`);
  });

  it("restores a wallet credential from its cookie after reopening", async () => {
    await signIn();
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    await act(async () => { root.unmount(); adoptApiKey(null); });
    calls = [];
    root = createRoot(container);
    await act(async () => { root.render(<Harness />); });
    expect(count("/api/auth/me")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(1);
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-1");
  });

  it("makes wallet sign-in available on the login page", async () => {
    await act(async () => root.render(<LoginPage />));
    const button = [...container.querySelectorAll("button")].find((element) => element.textContent?.trim() === "Sign In");
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(count("/api/auth/session-key")).toBe(1);
    expect(hasStoredApiKey()).toBe(true);
  });

  it("keeps a restored cookie session when another wallet control mounts disconnected", async () => {
    await act(async () => { root.unmount(); });
    wallet.isConnected = false;
    meValid = true;
    calls = [];
    root = createRoot(container);
    await act(async () => { root.render(<Harness />); });
    expect(count("/api/auth/session-key")).toBe(1);
    expect(hasStoredApiKey()).toBe(true);
    const host = document.createElement("div");
    document.body.append(host);
    const second = createRoot(host);
    try {
      await act(async () => { second.render(<SecondUser />); });
      expect(calls.map((call) => call.path)).not.toContain("/api/auth/logout");
      expect(count("/api/auth/session-key")).toBe(1);
      expect(useAuthStore.getState()).toMatchObject({ address: wallet.address, sessionToken: "cookie", sessionKeyId: "session-key-1" });
      expect(hasStoredApiKey()).toBe(true);
      await request();
      expect(new Headers(calls.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    } finally {
      await act(async () => { second.unmount(); });
      host.remove();
    }
  });

  it("keeps a key persisted by another tab while renewing its wallet credential", async () => {
    vi.useFakeTimers();
    mintReply = () => reply(201, { api_key: KEY, key_id: "session-key-1", operator_id: wallet.address, expires_at: new Date(Date.now() + 6 * 60 * 1000).toISOString() });
    await signIn();
    localStorage.setItem("pcc-api-key", PASTED);
    mintReply = () => minted(NEXT, "session-key-2");
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 1000); });
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-2");
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED);
    await request();
    expect(new Headers(calls.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${NEXT}`);
    await act(async () => { await auth.logout(); });
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
  });

  it("adopts a credential only for the signed-in wallet, with matching letter case", async () => {
    for (const operator of [undefined, "0x9999999999999999999999999999999999999999"]) {
      mintReply = () => reply(201, { api_key: KEY, key_id: "session-key-1", operator_id: operator, expires_at: expiry() });
      await signIn();
      expect(hasStoredApiKey()).toBe(false);
      expect(useAuthStore.getState()).toMatchObject({ address: wallet.address, sessionKeyId: null, sessionToken: "session-token" });
    }
    mintReply = () => reply(201, { api_key: KEY, key_id: "session-key-1", operator_id: wallet.address.toUpperCase(), expires_at: expiry() });
    await signIn();
    expect(hasStoredApiKey()).toBe(true);
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-1");
  });

  it("keeps pending credentials within the wallet session and address that requested them", async () => {
    let finish!: (response: Response) => void;
    mintReply = () => new Promise((resolve) => { finish = resolve; });
    let login!: Promise<void>;
    await act(async () => { login = auth.login(); });
    await vi.waitFor(() => expect(count("/api/auth/session-key")).toBe(1));
    await act(async () => { useAuthStore.getState().setSession(null); });
    await act(async () => { finish(minted()); await login; });
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: null, sessionKeyId: null });

    let pending!: Promise<boolean>;
    await act(async () => {
      useAuthStore.getState().setSession("next-session");
      pending = useAuthStore.getState().mintSessionKey();
    });
    expect(count("/api/auth/session-key")).toBe(2);
    await act(async () => {
      useAuthStore.getState().setAddress("0x9999999999999999999999999999999999999999");
      finish(minted());
      expect(await pending).toBe(false);
    });
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState().sessionKeyId).toBeNull();
  });
});

describe("session request renewal", () => {
  it("renews a replaced session credential and respects explicit request credentials", async () => {
    await signIn();
    calls = [];
    mintReply = () => minted(NEXT, "session-key-2");
    requestReply = (call) => new Headers(call.init.headers).get("Authorization") === `Bearer ${NEXT}`
      ? reply(200, { ok: true })
      : call.init.credentials === "omit" ? reply(401, { error: "api_key_required" }) : reply(403, { error: "insufficient_scope" });
    let responses!: Response[];
    await act(async () => {
      responses = await Promise.all([1, 2, 3].map(() => authorizedFetch("/api/jobs/submit", { method: "POST", body: "payload" })));
    });
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(count("/api/auth/me")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(1);
    const requests = calls.filter((call) => call.path === "/api/jobs/submit");
    expect(requests).toHaveLength(6);
    for (const call of requests) expect(call.init).toMatchObject({ credentials: "omit", method: "POST", body: "payload" });
    for (const credentials of ["include", "same-origin", "omit"] as const) {
      await act(async () => { expect((await authorizedFetch("/api/jobs/submit", { credentials })).status).toBe(200); });
      expect(calls.at(-1)!.init.credentials).toBe(credentials);
    }
    expect(count("/api/auth/session-key")).toBe(1);
  });

  it("checks the cookie, mints once, and retries the original request once", async () => {
    await signIn();
    calls = [];
    const network = fetch;
    let cookieAddress = wallet.address.toUpperCase();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (pathOf(input) === "/api/auth/me") {
        calls.push({ path: "/api/auth/me", init: init ?? {} });
        return reply(200, { address: cookieAddress });
      }
      return network(input, init);
    }));
    mintReply = () => minted(NEXT, "session-key-2");
    requestReply = (call) => reply(new Headers(call.init.headers).get("Authorization") === `Bearer ${NEXT}` ? 200 : 401, {});
    expect((await request()).status).toBe(200);
    expect(count("/api/auth/me")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(1);
    expect(count("/api/jobs/submit")).toBe(2);
    const me = calls.find((call) => call.path === "/api/auth/me")!;
    expect(me.init.credentials).toBe("include");
    expect(new Headers(me.init.headers).has("Authorization")).toBe(false);
    const mint = calls.find((call) => call.path === "/api/auth/session-key")!;
    expect(mint.init.credentials).toBe("include");
    expect(new Headers(mint.init.headers).has("Authorization")).toBe(false);
    expect(new Headers(mint.init.headers).has("x-api-key")).toBe(false);
    const retry = calls.at(-1)!;
    expect(retry.init.body).toBe("payload");
    expect(retry.init.method).toBe("POST");

    calls = [];
    cookieAddress = "0x9876543210987654321098765432109876543210";
    requestReply = () => reply(401, {});
    expect((await request()).status).toBe(401);
    expect(count("/api/auth/me")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(0);
    expect(count("/api/jobs/submit")).toBe(1);
    expect(hasStoredApiKey()).toBe(false);
    expect(container.textContent).toMatch(/sign in again/i);
  });

  it("shares one mint between three concurrent unauthorized requests", async () => {
    await signIn();
    calls = [];
    mintReply = async () => { await new Promise((resolve) => setTimeout(resolve, 15)); return minted(NEXT, "session-key-2"); };
    requestReply = (call) => reply(new Headers(call.init.headers).get("Authorization") === `Bearer ${NEXT}` ? 200 : 401, {});
    let responses!: Response[];
    await act(async () => { responses = await Promise.all([1, 2, 3].map((id) => authorizedFetch(`/api/jobs/${id}`, { method: "POST" }))); });
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(count("/api/auth/session-key")).toBe(1);
    expect(count("/api/auth/me")).toBe(1);
    for (const id of [1, 2, 3]) expect(count(`/api/jobs/${id}`)).toBe(2);
  });

  it("retries late responses only within their wallet session", async () => {
    await signIn();
    calls = [];
    mintReply = () => minted(NEXT, "session-key-2");
    let finish!: (response: Response) => void;
    requestReply = (call) => new Headers(call.init.headers).get("Authorization") === `Bearer ${NEXT}`
      ? reply(200, {}) : call.path.endsWith("slow") ? new Promise((resolve) => { finish = resolve; }) : reply(401, {});
    await act(async () => {
      const slow = authorizedFetch("/api/jobs/slow");
      expect((await authorizedFetch("/api/jobs/fast")).status).toBe(200);
      finish(reply(401, {}));
      expect((await slow).status).toBe(200);
    });
    expect(count("/api/auth/session-key")).toBe(1);

    calls = [];
    let attempts = 0;
    requestReply = () => ++attempts === 1 ? new Promise((resolve) => { finish = resolve; }) : reply(200, {});
    await act(async () => {
      const pending = authorizedFetch("/api/jobs/old-session", { method: "POST" });
      await auth.logout();
      await auth.login();
      finish(reply(401, {}));
      expect((await pending).status).toBe(401);
    });
    expect(count("/api/jobs/old-session")).toBe(1);
  });

  it("clears an expired session and prompts sign-in", async () => {
    await signIn();
    calls = [];
    meValid = false;
    requestReply = () => reply(401, {});
    expect((await request()).status).toBe(401);
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: null, sessionKeyId: null, sessionKeyExpiresAt: null });
    expect(container.textContent).toMatch(/sign in again/i);
    expect(count("/api/auth/session-key")).toBe(0);
    expect(count("/api/jobs/submit")).toBe(1);
  });

  it("returns the second unauthorized response without another retry", async () => {
    await signIn();
    calls = [];
    requestReply = () => reply(401, {});
    expect((await request()).status).toBe(401);
    expect(count("/api/jobs/submit")).toBe(2);
    expect(count("/api/auth/session-key")).toBe(1);
  });

  it("does not clear a pasted key adopted while the session check parses", async () => {
    await signIn();
    const network = fetch;
    let finish!: (body: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (pathOf(input) === "/api/auth/me") return { ok: true, status: 200, json: () => new Promise((resolve) => { finish = resolve; }) } as Response;
      return network(input, init);
    }));
    requestReply = () => reply(401, {});
    await act(async () => {
      const pending = authorizedFetch("/api/jobs/submit");
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      await useAuthStore.getState().login(PASTED);
      finish({});
      expect((await pending).status).toBe(401);
    });
    expect(hasStoredApiKey()).toBe(true);
    requestReply = () => reply(200, {});
    await request();
    expect(new Headers(calls.at(-1)!.init.headers).get("Authorization")).toBe(`Bearer ${PASTED}`);
  });
});

describe("wallet sign-out", () => {
  it("revokes the wallet credential when the connected wallet disconnects", async () => {
    await signIn();
    expect(useAuthStore.getState().sessionKeyId).toBe("session-key-1");
    calls = [];
    wallet.isConnected = false;
    await act(async () => { wallet.onDisconnect?.(); root.render(<Harness />); });
    expect(calls.map((call) => call.path)).toEqual(["/api/auth/keys/session-key-1", "/api/auth/logout"]);
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: null, sessionKeyId: null, sessionKeyExpiresAt: null });
  });

  it.each([200, 500])("revokes before logout and clears afterward (DELETE %s)", async (status) => {
    await signIn();
    calls = [];
    deleteStatus = status;
    const events: string[] = [];
    const stop = useAuthStore.subscribe((state, previous) => { if (previous.isAuthenticated && !state.isAuthenticated) events.push("clear"); });
    const network = fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      events.push(init?.method === "DELETE" ? "DELETE" : pathOf(input));
      return network(input, init);
    }));
    await act(async () => { await auth.logout(); });
    stop();
    expect(events).toEqual(["DELETE", "/api/auth/logout", "clear"]);
    expect(new Headers(calls[0].init.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0].init.credentials ?? "same-origin").toBe("same-origin");
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: null, sessionKeyId: null, sessionKeyExpiresAt: null });
    expect(hasStoredApiKey()).toBe(false);
  });
});

describe("session credential notices", () => {
  it.each([
    [401, "session_required"], [403, "session_required"], [401, "api_key_required"],
    [429, "too_many_keys"], [500, "provision_failed"],
  ])("keeps the wallet signed in after %s %s", async (status, error) => {
    mintReply = () => reply(Number(status), { error, message: "server-detail-not-for-display" });
    await signIn();
    expect(auth.isAuthenticated).toBe(true);
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ sessionKeyId: null, sessionKeyExpiresAt: null });
    expect(container.textContent).toMatch(/wallet.*signed in/i);
    expect(container.textContent).not.toContain("server-detail-not-for-display");
    expect(count("/api/auth/session-key")).toBe(status === 500 ? 2 : 1);
  });

  it("adopts a successful second provision response", async () => {
    let attempts = 0;
    mintReply = () => ++attempts === 1 ? reply(500, { error: "provision_failed" }) : minted();
    await signIn();
    expect(count("/api/auth/session-key")).toBe(2);
    expect(hasStoredApiKey()).toBe(true);
    expect(auth.authNotice).toBeNull();
  });
});

describe("wallet session transitions", () => {
  it("discards a pending login credential when the wallet disconnects", async () => {
    let finish!: (response: Response) => void;
    mintReply = () => new Promise((resolve) => { finish = resolve; });
    let login!: Promise<void>;
    await act(async () => { login = auth.login(); });
    await vi.waitFor(() => expect(count("/api/auth/session-key")).toBe(1));
    wallet.isConnected = false;
    await act(async () => { wallet.onDisconnect?.(); root.render(<Harness />); });
    await act(async () => { finish(minted()); await login; });
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState().sessionToken).toBeNull();
    expect(useAuthStore.getState().authNotice).toBeNull();
  });

  it.each([401, 403, 200])("keeps another tab's persisted key when renewal ends the wallet session (%s)", async (status) => {
    await signIn();
    localStorage.setItem("pcc-api-key", PASTED);
    const network = fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (pathOf(input) === "/api/auth/me") {
        calls.push({ path: "/api/auth/me", init: init ?? {} });
        return reply(status, status === 200 ? { address: "0x9999999999999999999999999999999999999999" } : { error: "session_required" });
      }
      return network(input, init);
    }));
    calls = [];
    requestReply = () => reply(401, { error: "api_key_required" });
    expect((await request()).status).toBe(401);
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED);
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: null, sessionKeyId: null, sessionKeyExpiresAt: null });
    expect(container.textContent).toMatch(/sign in again/i);
    expect(count("/api/auth/me")).toBe(1);
    expect(count("/api/auth/session-key")).toBe(0);
    expect(count("/api/jobs/submit")).toBe(1);
  });

  it("keeps another tab's persisted key when the wallet disconnects", async () => {
    await signIn();
    localStorage.setItem("pcc-api-key", PASTED);
    calls = [];
    wallet.isConnected = false;
    await act(async () => { wallet.onDisconnect?.(); root.render(<Harness />); });
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED);
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState()).toMatchObject({ sessionToken: null, sessionKeyId: null, sessionKeyExpiresAt: null });
    expect(calls.map((call) => call.path)).toEqual(["/api/auth/keys/session-key-1", "/api/auth/logout"]);
  });

  it("clears the persisted key on explicit sign-out after reconnecting the wallet", async () => {
    await signIn();
    localStorage.setItem("pcc-api-key", PASTED);
    wallet.isConnected = false;
    await act(async () => { wallet.onDisconnect?.(); root.render(<Harness />); });
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED);
    wallet.isConnected = true;
    await act(async () => { root.render(<Harness />); });
    await signIn();
    expect(hasStoredApiKey()).toBe(true);
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED);
    await act(async () => { await auth.logout(); });
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState().sessionToken).toBeNull();

    await signIn();
    localStorage.setItem("pcc-api-key", PASTED);
    const network = fetch;
    let finishLogout!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (pathOf(input) === "/api/auth/logout") return new Promise<Response>((resolve) => { finishLogout = resolve; });
      return network(input, init);
    }));
    wallet.isConnected = false;
    await act(async () => { wallet.onDisconnect?.(); root.render(<Harness />); });
    await vi.waitFor(() => expect(finishLogout).toBeTypeOf("function"));
    await act(async () => {
      const logout = auth.logout();
      finishLogout(reply(200, {}));
      await logout;
    });
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(hasStoredApiKey()).toBe(false);
    expect(useAuthStore.getState().sessionToken).toBeNull();
  });

  it("clears the persisted key when the wallet disconnects during an explicit sign-out", async () => {
    await signIn();
    localStorage.setItem("pcc-api-key", PASTED);
    const network = fetch;
    let finishLogout!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (pathOf(input) === "/api/auth/logout") return new Promise<Response>((resolve) => { finishLogout = resolve; });
      return network(input, init);
    }));
    let logout!: Promise<void>;
    await act(async () => { logout = auth.logout(); });
    await vi.waitFor(() => expect(finishLogout).toBeTypeOf("function"));
    wallet.isConnected = false;
    await act(async () => { wallet.onDisconnect?.(); root.render(<Harness />); });
    await act(async () => { finishLogout(reply(200, {})); await logout; });
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(hasStoredApiKey()).toBe(false);
  });

  it("keeps the persisted key on a disconnect after an explicit sign-out", async () => {
    await signIn();
    await act(async () => { await auth.logout(); });
    await signIn();
    localStorage.setItem("pcc-api-key", PASTED);
    wallet.isConnected = false;
    await act(async () => { wallet.onDisconnect?.(); root.render(<Harness />); });
    await vi.waitFor(() => expect(hasStoredApiKey()).toBe(false));
    expect(localStorage.getItem("pcc-api-key")).toBe(PASTED);
  });

  it("prompts sign-in when the wallet address changes during a pending login mint", async () => {
    let finish!: (response: Response) => void;
    mintReply = () => new Promise((resolve) => { finish = resolve; });
    let login!: Promise<void>;
    await act(async () => { login = auth.login(); });
    await vi.waitFor(() => expect(count("/api/auth/session-key")).toBe(1));
    const signed = wallet.address;
    const late = minted();
    wallet.address = "0x9999999999999999999999999999999999999999";
    try {
      await act(async () => { root.render(<Harness />); });
      await act(async () => { finish(late); await login; });
      expect(hasStoredApiKey()).toBe(false);
      expect(useAuthStore.getState()).toMatchObject({ address: wallet.address, sessionToken: "session-token", sessionKeyId: null });
      expect(auth.isAuthenticated).toBe(true);
      expect(auth.authNotice).toBe("Your wallet is signed in. Sign in again to enable operator actions.");
      expect(container.textContent).toContain(auth.authNotice);
    } finally {
      wallet.address = signed;
    }
  });
});
