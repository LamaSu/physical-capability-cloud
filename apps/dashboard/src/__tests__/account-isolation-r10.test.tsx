/**
 * astra's round-10 verdict on #354 (pack 19j, DO-NOT-SHIP), reproduced at 6e2f8453.
 *
 * HIGH (19i's, partly closed): a write is checked by reading the slot back, but
 * verification has three outcomes, not two. A write that COMMITTED and is then
 * read back as unreadable (or stale) was taken as refused, so this tab kept the
 * previous key live while the slot, every other tab and the next load held the
 * new one.
 * MEDIUM: a refused logout's explanation never reached the person. The shell's
 * Disconnect button ignored logout()'s result, and nothing rendered the reason.
 * MEDIUM: logout() reported success, and moved the generation only if no key was
 * held at the end, even when a listener had signed in again during delivery,
 * which is a change of account.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "r10keyA0123456789abcdef"].join("_");
const KEY_B = ["pcc", "test", "r10keyB0123456789abcdef"].join("_");

const original = {
  getItem: Storage.prototype.getItem,
  setItem: Storage.prototype.setItem,
  removeItem: Storage.prototype.removeItem,
};
const probe = { authorization: undefined as string | null | undefined };

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
  vi.resetModules();
  restoreStorage();
  localStorage.clear();
  localStorage.setItem("pcc-api-key", KEY_A); // the browser is signed in as A
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      if (path === "/api/_probe/sent-key") {
        probe.authorization = new Headers(init?.headers).get("authorization");
        return new Response("{}", { status: 200 });
      }
      if (path === "/api/auth/validate") return new Response(JSON.stringify({ valid: true }), { status: 200 });
      if (path === "/api/auth/logout") return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
});

afterEach(() => {
  restoreStorage();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function restoreStorage() {
  Storage.prototype.getItem = original.getItem;
  Storage.prototype.setItem = original.setItem;
  Storage.prototype.removeItem = original.removeItem;
}

function sentBy(authorizedFetch: (target: string) => Promise<Response>): string | null {
  probe.authorization = undefined;
  void authorizedFetch("/api/_probe/sent-key");
  const seen = probe.authorization as string | null | undefined;
  if (seen === undefined) throw new Error("the probe didn't reach fetch synchronously");
  return seen === null ? null : seen.replace(/^Bearer /, "");
}

async function page() {
  const store = await import("../stores/auth-store.js");
  const owner = await import("../lib/authorized-fetch.js");
  const generation = await import("../lib/account-generation.js");
  return { store, owner, generation, sends: () => sentBy(owner.authorizedFetch) };
}

/** What a page loaded now would act as (storage behaving normally again). */
async function aFreshLoadSends(): Promise<string | null> {
  restoreStorage();
  vi.resetModules();
  const owner = await import("../lib/authorized-fetch.js");
  return sentBy(owner.authorizedFetch);
}

/** The key slot's write goes through, then reading the slot fails: the outcome can't be confirmed. */
function commitThenUnreadable(op: "setItem" | "removeItem") {
  let committed = false;
  if (op === "setItem") {
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      original.setItem.call(this, key, value);
      if (key === "pcc-api-key") committed = true;
    };
  } else {
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      original.removeItem.call(this, key);
      if (key === "pcc-api-key") committed = true;
    };
  }
  Storage.prototype.getItem = function (this: Storage, key: string) {
    if (key === "pcc-api-key" && committed) throw new DOMException("The operation is insecure.", "SecurityError");
    return original.getItem.call(this, key);
  };
}

describe("19j HIGH: a write that committed but can't be confirmed leaves no previous key live", () => {
  it("login(B): B is saved but can't be read back; this tab must not stay A", async () => {
    const { store, sends } = await page();
    commitThenUnreadable("setItem");
    const ok = await store.useAuthStore.getState().login(KEY_B);
    expect(sends(), "this tab no longer acts as A (it holds no key)").toBeNull();
    expect(ok, "login can't report success it couldn't confirm").toBe(false);
    expect(store.useAuthStore.getState().error).toMatch(/couldn't confirm/i);
    expect(await aFreshLoadSends(), "the slot holds B").toBe(KEY_B);
  });

  it("logout(): A is removed but can't be confirmed; this tab must not stay A, and every tab is told", async () => {
    const { store, generation, sends } = await page();
    const before = generation.accountGeneration();
    commitThenUnreadable("removeItem");
    const result = store.useAuthStore.getState().logout();
    expect(sends(), "this tab no longer acts as A").toBeNull();
    expect(generation.accountGeneration(), "the change may have been made, so every tab sees it pending").not.toBe(before);
    expect(result, "logout can't report success it couldn't confirm").toBe(false);
    expect(store.useAuthStore.getState().error).toMatch(/couldn't confirm/i);
    expect(await aFreshLoadSends(), "the slot is empty").toBeNull();
  });

  it("a write that doesn't throw but reads back the old value can't be told from a stale read: this tab holds no key", async () => {
    const { store, sends } = await page();
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key !== "pcc-api-key") original.setItem.call(this, key, value); // the key's write is silently dropped
    };
    expect(await store.useAuthStore.getState().login(KEY_B)).toBe(false);
    expect(sends(), "neither A nor B stays live here").toBeNull();
    expect(store.useAuthStore.getState().error).toMatch(/couldn't confirm/i);
  });
});

describe("19j MEDIUM: the shell says why a sign-out didn't happen", () => {
  let container: HTMLDivElement;
  let root: Root;
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("Disconnect with the removal refused: the shell stays, and says how to finish signing out", async () => {
    const { App } = await import("../App.js");
    window.history.replaceState(null, "", "/dashboard");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<App />));
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    const disconnect = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Disconnect");
    expect(disconnect, "the shell's Disconnect button").toBeDefined();
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (key === "pcc-api-key") throw new DOMException("The operation is insecure.", "SecurityError");
      return original.removeItem.call(this, key);
    };
    await act(async () => disconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    expect(container.textContent).toContain("Disconnect");
    expect(container.textContent, "the reason, where the person clicked").toMatch(/wouldn't remove your saved API key/);
  });
});

describe("19j: a sign-out that couldn't be confirmed lands on the login page, which says why", () => {
  let container: HTMLDivElement;
  let root: Root;
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("Disconnect with the removal unconfirmed: this tab is signed out, and the login page carries the reason", async () => {
    const { App } = await import("../App.js");
    window.history.replaceState(null, "", "/dashboard");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<App />));
    for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    const disconnect = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Disconnect");
    expect(disconnect).toBeDefined();
    commitThenUnreadable("removeItem");
    await act(async () => disconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
    restoreStorage();
    expect(container.textContent, "the login page").toContain("Enter your API key");
    expect(container.textContent).toMatch(/couldn't confirm it removed your saved API key/);
  });
});

describe("19j MEDIUM: a listener that signs in again during logout is a change of account", () => {
  it("logout() doesn't report success when a key is held at the end", async () => {
    const { store, owner, sends } = await page();
    let once = true;
    owner.onStoredKeyChange(() => {
      if (!once) return;
      once = false;
      owner.setStoredApiKey(KEY_B);
    });
    const result = store.useAuthStore.getState().logout();
    expect(sends(), "B is held at the end").toBe(KEY_B);
    expect(result, "not signed out").toBe(false);
  });

  it("with another listener throwing, the generation still moves: A gave way to B", async () => {
    const { store, owner, generation, sends } = await page();
    const before = generation.accountGeneration();
    let once = true;
    owner.onStoredKeyChange(() => {
      if (!once) return;
      once = false;
      owner.setStoredApiKey(KEY_B);
    });
    owner.onStoredKeyChange(() => {
      throw new Error("a listener failed");
    });
    expect(() => store.useAuthStore.getState().logout()).toThrow("a listener failed");
    expect(sends()).toBe(KEY_B);
    expect(generation.accountGeneration(), "every tab sees the change pending").not.toBe(before);
  });
});
