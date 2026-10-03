/**
 * astra's round-6 verdict on #354 (pack 19f, DO-NOT-SHIP): the SIWE cookie and
 * the teardown mark belong to the browser, but everything that ordered them
 * belonged to one tab. Two CRITICAL cross-tab paths, reproduced here at
 * d3f6ced1 with two or three tabs. Each tab is its own module instance, with
 * its own sign-in registry, run counter and React root. The tabs share the
 * window's localStorage and the gateway's cookie, as tabs of one browser do.
 *
 * X1: tab A's verification is in flight. Tab B switches the account, finds
 *     its own registry empty, logs out and mounts. A's verification then
 *     completes, and B now carries A's SIWE session.
 * X2: the same start. B's confirmed teardown removes the browser's one
 *     teardown mark, so a tab opened after A's cookie lands mounts at once and
 *     adopts A's session.
 *
 * A watcher checks after every tick that no tab shows the shell while a
 * cookie of A's is live.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWebLocks } from "./fake-web-locks.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wallet = vi.hoisted(() => ({ address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined }));
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
    useSignMessage: () => ({ signMessageAsync: async () => "0xsig" }),
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
  installFakeWebLocks();
});

beforeEach(() => {
  gateway.siweCookie = false;
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
async function openTab(name: string): Promise<Tab> {
  vi.resetModules();
  const { useAuthStore } = await import("../stores/auth-store.js");
  const { App } = await import("../App.js");
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
  gateway.logoutsToAnswer = 1; // the first logout is answered; any later one waits
  await act(async () => {
    expect(await b.store.getState().login(KEY_B)).toBe(true);
  });
  await settle();
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

describe("19f CRITICAL X1: another tab's verification can't set A's cookie beside B", () => {
  it("no tab shows B's shell while a cookie of A's is live", async () => {
    await aVerifiesWhileBSwitches();
    await aVerificationCompletes();
    await everythingSettles();
    expect(violations).toEqual([]);
    expect(gateway.siweCookie, "A's cookie is gone in the end").toBe(false);
    for (const tab of tabs) expect(transitioning(tab), `${tab.name} ends in its shell`).toBe(false);
  }, 30_000);
});

describe("19f CRITICAL X2: a tab can't clear the teardown another tab hasn't finished", () => {
  it("a tab opened after A's cookie landed doesn't mount beside it, or adopt it", async () => {
    await aVerifiesWhileBSwitches();
    await aVerificationCompletes();
    const c = await openTab("C");
    await settle();
    await everythingSettles();
    expect(violations).toEqual([]);
    expect(c.store.getState().sessionToken, "C never adopted A's session").toBeNull();
    expect(gateway.siweCookie).toBe(false);
  }, 30_000);
});
