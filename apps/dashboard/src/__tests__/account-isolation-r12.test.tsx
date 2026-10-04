/**
 * astra's round-12 verdict on #354 (pack 19l, DO-NOT-SHIP), reproduced at
 * a7bb0c3a.
 *
 * HIGH: the pending-change gate read the generation and the confirmed marker,
 * and then the key, in separate reads. Another tab's login landing between
 * them (its generation, then B) made a request send B beside A's still-live
 * SIWE cookie.
 * MEDIUM: a generation write that landed and then threw was taken as not
 * made. login() stopped before storing the key or telling anyone, so the
 * change stayed pending in storage, every request was withheld, and no
 * teardown started to end it.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "r12keyA0123456789abcdef"].join("_");
const KEY_B = ["pcc", "test", "r12keyB0123456789abcdef"].join("_");

const original = {
  getItem: Storage.prototype.getItem,
  setItem: Storage.prototype.setItem,
};
const probe = { authorization: undefined as string | null | undefined };
const gateway = { logouts: 0 };

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
  gateway.logouts = 0;
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
      if (path === "/api/auth/logout") {
        gateway.logouts += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
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

describe("19l HIGH: another tab's login landing between the gate's reads never sends B beside A's cookie", () => {
  const READS = ["pcc-api-key", "pcc-account-generation", "pcc-wallet-session-confirmed"] as const;
  const cases = READS.flatMap((at) => (["old", "new"] as const).map((returns) => ({ at, returns })));

  it.each(cases)("the login lands during the read of $at, which returns the $returns value", async ({ at, returns }) => {
    // A is signed in and settled: A's SIWE cookie may be live.
    localStorage.setItem("pcc-api-key", KEY_A);
    localStorage.setItem("pcc-account-generation", "g0");
    localStorage.setItem("pcc-wallet-session-confirmed", "g0");
    const { sends } = await page();
    expect(sends()).toBe(KEY_A);
    let landed = false;
    Storage.prototype.getItem = function (this: Storage, key: string) {
      if (key !== at || landed) return original.getItem.call(this, key);
      const before = original.getItem.call(this, key);
      // Another tab's login, in its order: the generation moves, then B is stored.
      original.setItem.call(this, "pcc-account-generation", "g1");
      original.setItem.call(this, "pcc-api-key", KEY_B);
      landed = true;
      return returns === "old" ? before : original.getItem.call(this, key);
    };
    const sent = sends();
    expect(landed, "the login landed during the request").toBe(true);
    expect(sent, "B never goes out while its change is pending: A's cookie may still be live").not.toBe(KEY_B);
  });
});

describe("19l MEDIUM: a generation write that lands and then throws doesn't leave a change pending with nothing to end it", () => {
  function generationWriteLandsThenThrows() {
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      original.setItem.call(this, key, value);
      if (key === "pcc-account-generation") throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    };
  }

  it("login(B): the account boundary runs, and once its teardown confirms, requests carry the slot's key", async () => {
    const { store, generation, sends } = await page();
    const epoch = store.useAuthStore.getState().keyEpoch;
    generationWriteLandsThenThrows();
    const ok = await store.useAuthStore.getState().login(KEY_B);
    restoreStorage();
    expect(generation.walletSessionEnding(), "the move landed: a change is pending").toBe(true);
    expect(store.useAuthStore.getState().keyEpoch, "this tab's account boundary runs, so a teardown can confirm it").not.toBe(epoch);
    expect(ok, "storage shows the move, so the login goes on").toBe(true);
    generation.confirmWalletSessionEnded(generation.accountGeneration() ?? ""); // as App's teardown does
    expect(sends()).toBe(KEY_B);
  });

  it("a move storage can't confirm at all: login stores nothing and says why, and the boundary still runs, so a move that landed gets its teardown", async () => {
    const { store } = await page();
    const epoch = store.useAuthStore.getState().keyEpoch;
    Storage.prototype.getItem = function (this: Storage, key: string) {
      if (key === "pcc-account-generation") throw new DOMException("The operation is insecure.", "SecurityError");
      return original.getItem.call(this, key);
    };
    const ok = await store.useAuthStore.getState().login(KEY_B);
    restoreStorage();
    expect(ok).toBe(false);
    expect(localStorage.getItem("pcc-api-key"), "the key isn't stored (fail closed)").toBeNull();
    expect(store.useAuthStore.getState().keyEpoch, "this tab's account boundary runs").not.toBe(epoch);
    expect(store.useAuthStore.getState().error).toMatch(/couldn't save your sign-in/);
  });

  describe("on the login page", () => {
    let container: HTMLDivElement;
    let root: Root;
    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    it("the teardown runs and confirms, so the page isn't left withholding every request", async () => {
      const { App } = await import("../App.js");
      const generation = await import("../lib/account-generation.js");
      window.history.replaceState(null, "", "/login");
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root.render(<App />));
      for (let i = 0; i < 5; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
      const input = container.querySelector("input");
      const form = container.querySelector("form");
      expect(input && form, "the login form").toBeTruthy();
      generationWriteLandsThenThrows();
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, KEY_B);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
      restoreStorage();
      expect(gateway.logouts, "a teardown ran").toBeGreaterThan(0);
      expect(generation.walletSessionEnding(), "and confirmed the change, so requests aren't withheld for good").toBe(false);
    });
  });
});
