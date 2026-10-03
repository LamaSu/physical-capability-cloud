/**
 * astra's round-7 verdict on #354 (pack 19g, DO-NOT-SHIP), reproduced at
 * 9157f01b. The tabs are module instances sharing one window, as in r7.
 *
 * CRITICAL (new): login stored the next account's key, then moved the
 *   generation. A tab opened between the two writes hydrates the next key,
 *   finds the generation settled, mounts the shell and adopts the previous
 *   account's live cookie. It doesn't react when the generation moves later.
 *   Two writes in one task aren't atomic for another renderer, so a tab can
 *   load between them. Modeled here by opening the tab with storage as it
 *   stood after the first write, then delivering the rest.
 * Also: a login whose generation can't move must store no key (an
 *   interrupted change fails closed).
 * KNOWN RESIDUAL (round-6 CRITICAL 1, PARTIAL): a tab whose view of storage
 *   lags can pass its generation check under the lock, after another tab's
 *   logout. Web Locks order the callbacks, not localStorage's caches. Only
 *   the gateway can refuse the cookie this mints: bind each SIWE session to
 *   the API key it was created under (row N103, routed to the gateway lane).
 *   The last test reproduces it, and stays as a record until that lands.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWebLocks } from "./fake-web-locks.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wallet = vi.hoisted(() => ({ address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined }));
/** When set, the wallet's signature waits for the test to give it. */
const signing = vi.hoisted(() => ({ hold: false, waiting: [] as Array<() => void> }));
/** While set, a tab opened with laggingGeneration reads the generation it saw when it opened. */
const lag = vi.hoisted(() => ({ frozen: false }));
const disconnectWallet = vi.hoisted(() => () => {
  wallet.address = undefined;
  wallet.isConnected = false;
});
vi.mock("wagmi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi")>();
  return {
    ...actual,
    useAccount: () => ({ address: wallet.address, isConnected: wallet.isConnected, chainId: wallet.chainId }),
    useDisconnect: () => ({ disconnect: disconnectWallet, disconnectAsync: async () => disconnectWallet() }),
    useConnect: () => ({ connectors: [], connect: () => {} }),
    useSignMessage: () => ({
      signMessageAsync: () =>
        signing.hold ? new Promise<string>((resolve) => signing.waiting.push(() => resolve("0xsig"))) : Promise.resolve("0xsig"),
    }),
  };
});
vi.mock("wagmi/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wagmi/actions")>();
  return { ...actual, disconnect: async () => disconnectWallet() };
});

const A_WALLET = "0xA11ce00000000000000000000000000000000001";
// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "xtabA0123456789abcdef"].join("_");
const KEY_B = ["pcc", "test", "xtabB0123456789abcdef"].join("_");

/**
 * The gateway, shared by every tab. The SIWE cookie is set when a
 * verification completes (one the page aborted never delivers it) and is
 * destroyed by a logout that answers {ok: true}. Logouts are answered at once
 * while `logoutsToAnswer` lasts, then held until releaseLogouts().
 */
const gateway = {
  siweCookie: false,
  verifies: 0,
  verifyWaiting: [] as Array<() => void>,
  logoutsToAnswer: Number.POSITIVE_INFINITY,
  logoutWaiting: [] as Array<() => void>,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function releaseLogouts() {
  gateway.logoutsToAnswer = Number.POSITIVE_INFINITY;
  for (const answer of gateway.logoutWaiting.splice(0)) answer();
}

interface Tab {
  name: string;
  container: HTMLDivElement;
  root: Root;
  store: { getState: () => { apiKey: string | null; sessionToken: string | null; login: (key: string) => Promise<boolean> } };
}
let tabs: Tab[] = [];
let violations: string[] = [];

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.scrollIntoView = () => {};
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

beforeEach(() => {
  installFakeWebLocks(); // one lock manager for every tab, fresh per test
  lag.frozen = false;
  accountWrites = [];
  snapshot = null;
  gateway.siweCookie = false;
  gateway.verifies = 0;
  signing.hold = false;
  signing.waiting = [];
  gateway.verifyWaiting = [];
  gateway.logoutsToAnswer = Number.POSITIVE_INFINITY;
  gateway.logoutWaiting = [];
  tabs = [];
  violations = [];
  wallet.address = A_WALLET;
  wallet.isConnected = true;
  wallet.chainId = 84532;
  localStorage.clear();
  localStorage.setItem("pcc-api-key", KEY_A); // the browser is signed in as A
  window.history.replaceState(null, "", "/dashboard");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/auth/validate") return json({ valid: true });
      if (path === "/api/auth/me") return gateway.siweCookie ? json({ address: A_WALLET }) : json({ error: "Not authenticated" }, 401);
      if (path === "/api/auth/nonce") return json({ nonce: "nonce-1" });
      if (path === "/api/auth/verify" && method === "POST") {
        gateway.verifies += 1;
        return new Promise<Response>((resolve, reject) => {
          let aborted = false;
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
          gateway.verifyWaiting.push(() => {
            if (aborted) return;
            gateway.siweCookie = true;
            resolve(json({ token: "siwe-session-of-A" }));
          });
        });
      }
      if (path === "/api/auth/logout" && method === "POST") {
        const destroy = () => {
          gateway.siweCookie = false;
          return json({ ok: true });
        };
        if (gateway.logoutsToAnswer > 0) {
          gateway.logoutsToAnswer -= 1;
          return destroy();
        }
        return new Promise<Response>((resolve) => gateway.logoutWaiting.push(() => resolve(destroy())));
      }
      throw new TypeError("Failed to fetch");
    }),
  );
});

afterEach(async () => {
  releaseLogouts();
  for (const complete of gateway.verifyWaiting.splice(0)) complete();
  for (const tab of tabs) {
    await act(async () => tab.root.unmount());
    tab.container.remove();
  }
  localStorage.clear();
});

const transitioning = (tab: Tab) => /Signing out of the previous account|Couldn't confirm that the previous wallet session ended/.test(tab.container.textContent ?? "");

/**
 * A cookie of A's is live in this browser, and a tab that is no longer A's
 * shows its shell beside it, or holds A's session. (A tab still signed in as A
 * may show A's shell with A's own cookie until it hears of the switch.)
 */
function watch() {
  if (!gateway.siweCookie) return;
  for (const tab of tabs) {
    if (tab.store.getState().apiKey === KEY_A) continue;
    if (!transitioning(tab)) violations.push(`${tab.name} showed the next account's shell while A's SIWE cookie was live`);
    if (tab.store.getState().sessionToken !== null) violations.push(`${tab.name} adopted A's SIWE session`);
  }
}

async function settle(n = 20) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    watch();
  }
}

/** Opens a tab: its own module instances (registry, run counter, store), the shared window, storage and gateway. */
async function openTab(name: string, options: { laggingGeneration?: boolean } = {}): Promise<Tab> {
  vi.resetModules();
  if (options.laggingGeneration) {
    // This tab's view of the generation stays where it was when it opened (astra 19g's stale read).
    vi.doMock("../lib/account-generation.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../lib/account-generation.js")>();
      const seen = actual.accountGeneration();
      return { ...actual, accountGeneration: () => (lag.frozen ? seen : actual.accountGeneration()) };
    });
  }
  const { useAuthStore } = await import("../stores/auth-store.js");
  const { App } = await import("../App.js");
  if (options.laggingGeneration) vi.doUnmock("../lib/account-generation.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const tab: Tab = { name, container, root, store: useAuthStore };
  tabs.push(tab);
  await act(async () => root.render(<App />));
  await settle();
  return tab;
}

function click(tab: Tab, text: string) {
  const button = [...tab.container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
  expect(button, `tab ${tab.name} has a "${text}" button`).toBeDefined();
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** Tab A starts a SIWE sign-in whose verification the gateway holds; tab B, unaware of it, switches the account to B. */
async function aVerifiesWhileBSwitches() {
  const a = await openTab("A");
  const b = await openTab("B");
  await act(async () => click(a, "Sign In"));
  await settle(5);
  expect(gateway.verifyWaiting, "A's verification is on the wire").toHaveLength(1);
  gateway.logoutsToAnswer = 1; // a logout during the switch is answered
  await act(async () => {
    expect(await b.store.getState().login(KEY_B)).toBe(true);
  });
  await settle();
  gateway.logoutsToAnswer = 0; // any later one waits for everythingSettles()
  return { a, b };
}

/** Then A's verification completes, and the gateway sets A's cookie. A hasn't heard of the switch yet. */
async function aVerificationCompletes() {
  await act(async () => {
    for (const complete of gateway.verifyWaiting.splice(0)) complete();
  });
  await settle();
}

/** Finally A hears of the switch (the storage event a browser sends to the other tabs), and every logout is answered. */
async function everythingSettles() {
  releaseLogouts();
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: "pcc-api-key", oldValue: KEY_A, newValue: KEY_B }));
  });
  await settle(40);
}


// ---------------------------------------------------------------------------
// Storage as another process sees it: the writes to the API key and the
// generation, in order, and what storage held after the first of them.
// ---------------------------------------------------------------------------

const ACCOUNT_SLOTS = new Set(["pcc-api-key", "pcc-account-generation"]);
let accountWrites: Array<{ key: string; oldValue: string | null; newValue: string | null }> = [];
let snapshot: Record<string, string> | null = null;
const storageOriginal = { setItem: Storage.prototype.setItem, removeItem: Storage.prototype.removeItem };

afterEach(() => stopRecording());

function dump(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    out[k] = localStorage.getItem(k)!;
  }
  return out;
}

function restore(state: Record<string, string>) {
  localStorage.clear();
  for (const [k, v] of Object.entries(state)) storageOriginal.setItem.call(localStorage, k, v);
}

function recordAccountWrites() {
  accountWrites = [];
  snapshot = null;
  const record = (storage: Storage, key: string, oldValue: string | null, newValue: string | null) => {
    if (!ACCOUNT_SLOTS.has(key)) return;
    accountWrites.push({ key, oldValue, newValue });
    snapshot ??= dump();
  };
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    const oldValue = this.getItem(key);
    storageOriginal.setItem.call(this, key, value);
    record(this, key, oldValue, value);
  };
  Storage.prototype.removeItem = function (this: Storage, key: string) {
    const oldValue = this.getItem(key);
    storageOriginal.removeItem.call(this, key);
    record(this, key, oldValue, null);
  };
}

function stopRecording() {
  Storage.prototype.setItem = storageOriginal.setItem;
  Storage.prototype.removeItem = storageOriginal.removeItem;
}

/** Opens a tab whose process has seen only `view` of storage, then lets storage catch up (no event yet). */
async function openTabSeeing(name: string, view: Record<string, string>): Promise<Tab> {
  const full = dump();
  restore(view);
  const tab = await openTab(name);
  restore(full);
  return tab;
}

/** The storage events for the recorded writes, which every other tab receives in order. */
async function deliver(writes: typeof accountWrites) {
  for (const w of writes) {
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: w.key, oldValue: w.oldValue, newValue: w.newValue }));
    });
    await settle(5);
  }
}

/** Tab A signs in with its wallet: A's SIWE cookie is live. */
async function aSignedIn(): Promise<Tab> {
  const a = await openTab("A");
  await act(async () => click(a, "Sign In"));
  await settle(5);
  await aVerificationCompletes();
  expect(gateway.siweCookie, "A's cookie is live").toBe(true);
  expect(a.store.getState().sessionToken, "A holds its session").not.toBeNull();
  return a;
}

describe("19g CRITICAL: the next account's key is stored only after the generation moved", () => {
  it("a tab opened between the two writes doesn't mount beside the previous account's cookie, or adopt it", async () => {
    await aSignedIn();
    const b = await openTab("B");
    gateway.logoutsToAnswer = 0; // B's teardown waits at the gateway: A's cookie stays live meanwhile
    recordAccountWrites();
    await act(async () => {
      expect(await b.store.getState().login(KEY_B)).toBe(true);
    });
    stopRecording();
    expect(accountWrites.map((w) => w.key).sort(), "login wrote the key and the generation").toEqual(["pcc-account-generation", "pcc-api-key"]);
    const c = await openTabSeeing("C", snapshot!);
    await settle();
    await deliver(accountWrites);
    await everythingSettles();
    expect([...new Set(violations)]).toEqual([]);
    expect(c.store.getState().sessionToken, "C never adopted A's session").toBeNull();
    expect(gateway.siweCookie, "A's cookie is gone in the end").toBe(false);
  }, 30_000);

  it("a tab that hears of the generation's move before the key's holds its shell and drops the wallet session", async () => {
    const a = await aSignedIn();
    const b = await openTab("B");
    gateway.logoutsToAnswer = 0;
    recordAccountWrites();
    await act(async () => {
      expect(await b.store.getState().login(KEY_B)).toBe(true);
    });
    stopRecording();
    await deliver(accountWrites.filter((w) => w.key === "pcc-account-generation")); // the key's event hasn't reached A yet
    expect(transitioning(a), "A holds its shell while the change is pending").toBe(true);
    expect(a.store.getState().sessionToken, "A dropped its SIWE session").toBeNull();
    await deliver(accountWrites.filter((w) => w.key === "pcc-api-key"));
    await everythingSettles();
    expect([...new Set(violations)]).toEqual([]);
    expect(gateway.siweCookie).toBe(false);
  }, 30_000);

  it("a login whose generation can't move stores no key: an interrupted change fails closed", async () => {
    const b = await openTab("B");
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key === "pcc-account-generation") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      storageOriginal.setItem.call(this, key, value);
    };
    let ok: boolean | undefined;
    await act(async () => {
      ok = await b.store.getState().login(KEY_B);
    });
    stopRecording();
    expect(ok, "the login reports failure").toBe(false);
    expect(localStorage.getItem("pcc-api-key"), "the next account's key isn't stored").toBe(KEY_A);
    expect(b.store.getState().apiKey).toBe(KEY_A);
  });
});

describe("19g KNOWN RESIDUAL, closed only by the gateway binding SIWE sessions to the API key (row N103)", () => {
  it("a tab whose storage view lags passes its generation check under the lock, after another tab's logout", async () => {
    lag.frozen = true;
    const a = await openTab("A", { laggingGeneration: true });
    const b = await openTab("B");
    signing.hold = true;
    await act(async () => click(a, "Sign In"));
    await settle(5);
    expect(signing.waiting, "A's wallet is signing").toHaveLength(1);
    await act(async () => {
      expect(await b.store.getState().login(KEY_B)).toBe(true);
    });
    await settle();
    expect(transitioning(b), "B's teardown logged out under the lock, confirmed, and B mounted").toBe(false);
    await act(async () => {
      for (const sign of signing.waiting.splice(0)) sign();
    });
    await settle(5);
    await aVerificationCompletes();
    // Reproduced: A read its stale generation under the lock, sent its verification after B's logout, and its cookie is live beside B's shell.
    expect(gateway.verifies, "A's verification went out").toBe(1);
    expect(violations).toContain("B showed the next account's shell while A's SIWE cookie was live");
    await everythingSettles();
  }, 30_000);
});
