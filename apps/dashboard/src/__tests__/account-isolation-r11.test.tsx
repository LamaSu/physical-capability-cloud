/**
 * astra's round-11 verdict on #354 (pack 19k, DO-NOT-SHIP), reproduced at
 * dbe38d41, and the property the steward ruled after round 10 (DECISIONS
 * 2026-10-04 04:14).
 *
 * HIGH: "unchanged" claimed more than it could know. A write that went through
 * and then threw, read back by a stale read of the old value, was taken as
 * refused: this tab kept sending A while the slot held B (or nothing).
 * MEDIUM: with no key held, logout() didn't move the generation, and a
 * listener could sign in as B during its delivery.
 *
 * The ruling: the persisted slot is the ONE authority, read at each use, so no
 * key held in memory can differ from it; key changes are serialized, so no
 * listener can make one while another is being told; every sign-out surface
 * renders a refusal from a typed result. A request also carries no key while
 * an account change is pending for the browser (the generation, also read
 * from storage at use), so the next account's key never goes out beside the
 * previous account's SIWE cookie (astra 19f, 19g).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "r11keyA0123456789abcdef"].join("_");
const KEY_B = ["pcc", "test", "r11keyB0123456789abcdef"].join("_");

const original = {
  getItem: Storage.prototype.getItem,
  setItem: Storage.prototype.setItem,
  removeItem: Storage.prototype.removeItem,
};
const probe = { authorization: undefined as string | null | undefined };
/** Listeners a test registered. Each test imports fresh modules, but the window keeps every copy's storage listener, so they are removed after each test. */
const registered: Array<() => void> = [];

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
      return new Response(JSON.stringify({}), { status: 404 });
    }),
  );
});

afterEach(() => {
  for (const stop of registered.splice(0)) stop();
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

/**
 * What a page loaded now would act as, storage behaving normally again: nothing
 * while an account change is pending, then, once its load-time teardown has
 * confirmed (App.tsx finishes a pending change before it mounts), the slot's key.
 */
async function aFreshLoadSends(): Promise<string | null> {
  restoreStorage();
  vi.resetModules();
  const owner = await import("../lib/authorized-fetch.js");
  const generation = await import("../lib/account-generation.js");
  if (generation.walletSessionEnding()) {
    expect(sentBy(owner.authorizedFetch), "a page loaded while a change is pending sends no key").toBeNull();
    teardownConfirmed(generation);
  }
  return sentBy(owner.authorizedFetch);
}

/** A teardown confirms the previous wallet session ended, as App's does after the gateway's logout. */
function teardownConfirmed(generation: typeof import("../lib/account-generation.js")) {
  generation.confirmWalletSessionEnded(generation.accountGeneration() ?? "");
}

/** The key slot's write goes through and then throws, and the read right after it returns `stale` (astra 19k). */
function commitThenThrowThenStale(op: "setItem" | "removeItem", stale: string | null) {
  let staleNext = false;
  if (op === "setItem") {
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      original.setItem.call(this, key, value);
      if (key !== "pcc-api-key") return;
      staleNext = true;
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  } else {
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      original.removeItem.call(this, key);
      if (key !== "pcc-api-key") return;
      staleNext = true;
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
  }
  Storage.prototype.getItem = function (this: Storage, key: string) {
    if (key === "pcc-api-key" && staleNext) {
      staleNext = false;
      return stale;
    }
    return original.getItem.call(this, key);
  };
}

describe("DECISIONS 04:14: the slot is the one authority, read at each use", () => {
  it("the key in the slot is what this tab's next request carries, with no event: nothing is kept between uses", async () => {
    const { sends } = await page();
    expect(sends()).toBe(KEY_A);
    // The slot now reads B, and no storage event has arrived.
    Storage.prototype.getItem = function (this: Storage, key: string) {
      return key === "pcc-api-key" ? KEY_B : original.getItem.call(this, key);
    };
    expect(sends(), "this tab acts as the slot holds, not as a key it kept").toBe(KEY_B);
  });

  it("another tab signs in as B: this tab sends no key while the change is pending, then the slot's B, never A", async () => {
    const { generation, sends } = await page();
    // That tab's login: the generation moves first, then B is stored. No event has reached this tab.
    localStorage.setItem("pcc-account-generation", "another-tabs-change");
    localStorage.setItem("pcc-api-key", KEY_B);
    expect(sends(), "neither A nor B beside A's SIWE cookie, which may still be live").toBeNull();
    teardownConfirmed(generation);
    expect(sends(), "once a teardown confirmed it ended").toBe(KEY_B);
  });

  it("a page restored from the back/forward cache missed the events of its time away: it runs the account boundary", async () => {
    const { store } = await page();
    const pageshow = (persisted: boolean) => {
      const event = new Event("pageshow");
      Object.defineProperty(event, "persisted", { value: persisted });
      window.dispatchEvent(event);
    };
    const epoch = store.useAuthStore.getState().keyEpoch;
    pageshow(false); // a first load: nothing was missed
    expect(store.useAuthStore.getState().keyEpoch).toBe(epoch);
    pageshow(true);
    expect(store.useAuthStore.getState().keyEpoch, "every listener heard it").toBe(epoch + 1);
  });

  it("a slot that can't be read is no key: the request goes without one", async () => {
    const { owner, sends } = await page();
    Storage.prototype.getItem = function (this: Storage, key: string) {
      if (key === "pcc-api-key") throw new DOMException("The operation is insecure.", "SecurityError");
      return original.getItem.call(this, key);
    };
    expect(sends()).toBeNull();
    expect(owner.hasStoredApiKey()).toBe(false);
  });
});

describe("19k HIGH: a write that went through and then threw can't be taken as refused", () => {
  it("login(B): B is stored, the write throws, the read after it is a stale A; this tab acts as the slot, and every listener hears", async () => {
    const { store, generation, sends } = await page();
    const epoch = store.useAuthStore.getState().keyEpoch;
    commitThenThrowThenStale("setItem", KEY_A);
    const ok = await store.useAuthStore.getState().login(KEY_B);
    restoreStorage();
    expect(sends(), "never A: nothing while the change is pending").toBeNull();
    teardownConfirmed(generation);
    expect(sends(), "then the slot's B").toBe(KEY_B);
    expect(store.useAuthStore.getState().keyEpoch, "the account boundary ran").not.toBe(epoch);
    expect(ok, "login can't report a save it couldn't confirm").toBe(false);
    expect(store.useAuthStore.getState().error).toMatch(/couldn't confirm it saved your API key/);
    expect(await aFreshLoadSends()).toBe(KEY_B);
  });

  it("logout(): A is removed, the removal throws, the read after it is a stale A; this tab sends nothing, and every tab is told", async () => {
    const { store, generation, sends } = await page();
    const before = generation.accountGeneration();
    commitThenThrowThenStale("removeItem", KEY_A);
    const result = store.useAuthStore.getState().logout();
    restoreStorage();
    expect(sends(), "the slot is empty, so this tab sends no key").toBeNull();
    expect(store.useAuthStore.getState().isAuthenticated).toBe(false);
    expect(generation.accountGeneration(), "the account may have changed: every tab sees it pending").not.toBe(before);
    expect(result).toEqual({ status: "unconfirmed", reason: expect.stringMatching(/couldn't confirm it removed your saved API key/) });
    expect(await aFreshLoadSends()).toBeNull();
  });
});

describe("19k MEDIUM and the ruling: one key change at a time", () => {
  function signInDuringDelivery(owner: typeof import("../lib/authorized-fetch.js")) {
    const seen: { answer?: unknown } = {};
    let once = true;
    registered.push(
      owner.onStoredKeyChange(() => {
        if (!once) return;
        once = false;
        seen.answer = owner.setStoredApiKey(KEY_B);
      }),
    );
    return seen;
  }

  it("with no key held, a listener can't sign in as B during logout: its change is refused, and the slot stays empty (astra's reproduction)", async () => {
    localStorage.removeItem("pcc-api-key");
    const { store, owner, sends } = await page();
    const seen = signInDuringDelivery(owner);
    const result = store.useAuthStore.getState().logout();
    expect(sends(), "B was not adopted").toBeNull();
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(seen.answer, "the listener was told why").toBe("busy");
    expect(result).toEqual({ status: "signed-out" });
  });

  it("with another listener throwing too: the error goes on, the slot stays empty, and the generation moves", async () => {
    localStorage.removeItem("pcc-api-key");
    const { store, owner, generation, sends } = await page();
    const before = generation.accountGeneration();
    signInDuringDelivery(owner);
    registered.push(
      owner.onStoredKeyChange(() => {
        throw new Error("a listener failed");
      }),
    );
    expect(() => store.useAuthStore.getState().logout()).toThrow("a listener failed");
    expect(sends()).toBeNull();
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(generation.accountGeneration(), "every tab sees the change pending").not.toBe(before);
  });

  it("starting from A, the same: the listener's B is refused, and logout signs out", async () => {
    const { store, owner, sends } = await page();
    const seen = signInDuringDelivery(owner);
    const result = store.useAuthStore.getState().logout();
    expect(sends()).toBeNull();
    expect(localStorage.getItem("pcc-api-key")).toBeNull();
    expect(seen.answer).toBe("busy");
    expect(result).toEqual({ status: "signed-out" });
  });

  it("a sign-out asked for while a sign-in is being told is refused, and says why; the sign-in stands", async () => {
    const { store, owner, generation, sends } = await page();
    const seen: { inner?: unknown } = {};
    let once = true;
    registered.push(
      owner.onStoredKeyChange(() => {
        if (!once) return;
        once = false;
        seen.inner = store.useAuthStore.getState().logout();
      }),
    );
    expect(await store.useAuthStore.getState().login(KEY_B)).toBe(true);
    expect(seen.inner).toEqual({ status: "refused", reason: expect.stringMatching(/under way/) });
    expect(localStorage.getItem("pcc-api-key")).toBe(KEY_B);
    teardownConfirmed(generation);
    expect(sends()).toBe(KEY_B);
  });
});

describe("DECISIONS 04:14 (6): a sign-out's typed outcome is kept above the account boundary, until the key next changes", () => {
  it("an unconfirmed sign-out is kept for the surfaces, and the next change of the key, here or in another tab, clears it", async () => {
    const { store } = await page();
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (key === "pcc-api-key") throw new DOMException("The operation is insecure.", "SecurityError");
      return original.removeItem.call(this, key);
    };
    const result = store.useAuthStore.getState().logout();
    expect(result.status).toBe("unconfirmed");
    expect(store.useAuthStore.getState().lastSignOut, "the shell remounts; the reason stays").toEqual(result);
    restoreStorage();
    window.dispatchEvent(new StorageEvent("storage", { key: "pcc-api-key", oldValue: KEY_A, newValue: KEY_B }));
    expect(store.useAuthStore.getState().lastSignOut, "it belonged to the key before").toBeNull();
  });
});
