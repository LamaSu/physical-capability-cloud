/**
 * astra's round-9 verdict on #354 (pack 19i, DO-NOT-SHIP), reproduced at 6ff35f38.
 *
 * HIGH: a change of the stored key that the browser refused was treated as made.
 * - authorized-fetch's writeStorage() swallowed the storage error.
 * - The held key changed, and its listeners heard of it, anyway.
 * - So login(B) could return true with this tab acting as B, while the slot
 *   (every other tab, the next load) still held A.
 * - And logout() could leave this tab signed out, while the slot still held A,
 *   which the next load signs back in.
 *
 * Self-found with it: 19i's merge moved logout's generation move after the key
 * change. A listener that threw inside that change (setStoredApiKey tells every
 * listener, then rethrows the first error) skipped the move, so no other tab saw
 * the change pending. #354 had moved it before its set().
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "r9keyA0123456789abcdef"].join("_");
const KEY_B = ["pcc", "test", "r9keyB0123456789abcdef"].join("_");

const original = { setItem: Storage.prototype.setItem, removeItem: Storage.prototype.removeItem };
const probe = { authorization: undefined as string | null | undefined };

beforeEach(() => {
  vi.resetModules();
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
      throw new TypeError("Failed to fetch");
    }),
  );
});

afterEach(() => {
  Storage.prototype.setItem = original.setItem;
  Storage.prototype.removeItem = original.removeItem;
  vi.unstubAllGlobals();
  localStorage.clear();
});

/** Which key a module instance of lib/authorized-fetch.ts would send (its authorizedFetch reaches fetch() synchronously). */
function sentBy(authorizedFetch: (target: string) => Promise<Response>): string | null {
  probe.authorization = undefined;
  void authorizedFetch("/api/_probe/sent-key");
  const seen = probe.authorization as string | null | undefined;
  if (seen === undefined) throw new Error("the probe didn't reach fetch synchronously");
  return seen === null ? null : seen.replace(/^Bearer /, "");
}

/** This page's store and key owner (one module instance). */
async function page() {
  const store = await import("../stores/auth-store.js");
  const owner = await import("../lib/authorized-fetch.js");
  const generation = await import("../lib/account-generation.js");
  return { store, owner, generation, sends: () => sentBy(owner.authorizedFetch) };
}

/** What a page loaded now would act as: a fresh module instance, hydrated from the slot. */
async function aFreshLoadSends(): Promise<string | null> {
  vi.resetModules();
  const owner = await import("../lib/authorized-fetch.js");
  return sentBy(owner.authorizedFetch);
}

/** The browser refuses one kind of write to the key's slot only (a full quota, or a blocked write). */
function refuseKeySlot(op: "setItem" | "removeItem", how: "throw" | "ignore" = "throw") {
  if (op === "setItem") {
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key !== "pcc-api-key") return original.setItem.call(this, key, value);
      if (how === "throw") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  } else {
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (key !== "pcc-api-key") return original.removeItem.call(this, key);
      if (how === "throw") throw new DOMException("The operation is insecure.", "SecurityError");
    };
  }
}

describe("19i HIGH: a key change the browser refused is not made", () => {
  it("login(B) fails closed when the browser won't save B: this tab, the slot and the next load all stay A", async () => {
    const { store, sends } = await page();
    expect(sends()).toBe(KEY_A);
    refuseKeySlot("setItem");
    const ok = await store.useAuthStore.getState().login(KEY_B);
    expect(ok, "login reports the refusal").toBe(false);
    expect(sends(), "this tab still acts as A").toBe(KEY_A);
    expect(localStorage.getItem("pcc-api-key")).toBe(KEY_A);
    expect(store.useAuthStore.getState().error, "the reason, for the login page").toMatch(/wouldn't save your API key/);
    expect(await aFreshLoadSends()).toBe(KEY_A);
  });

  it("the same when the write is silently dropped: what counts is what the slot holds afterwards", async () => {
    const { store, sends } = await page();
    refuseKeySlot("setItem", "ignore");
    expect(await store.useAuthStore.getState().login(KEY_B)).toBe(false);
    expect(sends()).toBe(KEY_A);
    expect(await aFreshLoadSends()).toBe(KEY_A);
  });

  it("logout() fails closed when the browser won't remove A: this tab stays signed in as A, and the generation doesn't move", async () => {
    const { store, generation, sends } = await page();
    const before = generation.accountGeneration();
    refuseKeySlot("removeItem");
    const result = store.useAuthStore.getState().logout();
    expect(sends(), "this tab is still A's, as the slot is").toBe(KEY_A);
    expect(store.useAuthStore.getState().isAuthenticated).toBe(true);
    expect(localStorage.getItem("pcc-api-key")).toBe(KEY_A);
    expect(generation.accountGeneration(), "nothing changed, so no tab is told of a change").toBe(before);
    expect(result, "logout reports the refusal").toBe(false);
    expect(store.useAuthStore.getState().error).toMatch(/wouldn't remove your saved API key/);
    expect(await aFreshLoadSends()).toBe(KEY_A);
  });

  it("a key change the browser accepts still goes through (login B, then logout)", async () => {
    const { store, sends } = await page();
    expect(await store.useAuthStore.getState().login(KEY_B)).toBe(true);
    expect(sends()).toBe(KEY_B);
    expect(localStorage.getItem("pcc-api-key")).toBe(KEY_B);
    store.useAuthStore.getState().logout();
    expect(sends()).toBeNull();
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(await aFreshLoadSends()).toBeNull();
  });
});

describe("self-found with 19i: a listener's error can't skip logout's generation move", () => {
  it("the key goes, the generation moves, then the listener's error is rethrown", async () => {
    const { store, owner, generation, sends } = await page();
    const before = generation.accountGeneration();
    owner.onStoredKeyChange(() => {
      throw new Error("a listener failed");
    });
    expect(() => store.useAuthStore.getState().logout()).toThrow("a listener failed");
    expect(sends(), "the key is gone").toBeNull();
    expect(generation.accountGeneration(), "every other tab sees the change pending").not.toBe(before);
    expect(generation.walletSessionEnding()).toBe(true);
  });
});
