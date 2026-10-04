/**
 * astra's round-13 verdict on #354 (pack 19m, SHIP): its follow-ups,
 * reproduced at de50286b.
 *
 * MEDIUM: a teardown whose gateway logout succeeded counted as done even when
 * its confirmation wasn't recorded: the marker's write was refused or dropped,
 * or the record couldn't be read. App mounted the shell while every request
 * was withheld, with no failure screen and no retry.
 * MEDIUM: a value that starts as a record but isn't a whole one ({"key": B}
 * with no generation, or with a generation that isn't a string) still gave B,
 * under generation "". With no marker yet, B was sent.
 * LOW: setStoredApiKey(B) with no options kept the confirmed generation, so B
 * was sent at once.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_SLOT, storeRecord } from "./account-record.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "r13keyA0123456789abcdef"].join("_");
const KEY_B = ["pcc", "test", "r13keyB0123456789abcdef"].join("_");
const MARKER = "pcc-wallet-session-confirmed";

const original = {
  getItem: Storage.prototype.getItem,
  setItem: Storage.prototype.setItem,
};
const probe = { authorization: undefined as string | null | undefined };
const gateway = { logouts: 0 };

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.resetModules();
  restoreStorage();
  localStorage.clear();
  gateway.logouts = 0;
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      if (path === "/api/_probe/sent-key") {
        probe.authorization = new Headers(init?.headers).get("authorization");
        return new Response("{}", { status: 200 });
      }
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
  const owner = await import("../lib/authorized-fetch.js");
  const generation = await import("../lib/account-generation.js");
  return { owner, generation, sends: () => sentBy(owner.authorizedFetch) };
}

/** B was stored under g1, and the last confirmed teardown is g0's: a change is pending. */
function changePending() {
  storeRecord(KEY_B, "g1", original.setItem);
  original.setItem.call(localStorage, MARKER, "g0");
}

describe("19m MEDIUM: a teardown counts only once its confirmation is recorded", () => {
  it.each([
    [
      "the marker's write is refused",
      () => {
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (key === MARKER) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
          return original.setItem.call(this, key, value);
        };
      },
    ],
    [
      "the marker's write is silently dropped",
      () => {
        Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
          if (key !== MARKER) return original.setItem.call(this, key, value);
        };
      },
    ],
    [
      "the record can't be read, so there is no generation to confirm",
      () => {
        Storage.prototype.getItem = function (this: Storage, key: string) {
          if (key === KEY_SLOT) throw new DOMException("The operation is insecure.", "SecurityError");
          return original.getItem.call(this, key);
        };
      },
    ],
  ])("%s: endWalletSession() answers false, so App keeps its failure screen and retry", async (_, breakStorage) => {
    changePending();
    const { endWalletSession } = await import("../lib/wallet-session.js");
    const generation = await import("../lib/account-generation.js");
    breakStorage();
    const ended = await endWalletSession();
    restoreStorage();
    expect(gateway.logouts, "the gateway's logout went through").toBe(1);
    expect(ended, "but nothing the request gate reads records it").toBe(false);
    expect(generation.walletSessionEnding(), "the change is still pending").toBe(true);
  });

  describe("in App", () => {
    let container: HTMLDivElement;
    let root: Root;
    afterEach(async () => {
      await act(async () => root.unmount());
      container.remove();
    });

    it("a pending change whose confirmation can't be recorded shows the failure screen with its retry, not a shell that sends nothing", async () => {
      changePending();
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === MARKER) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        return original.setItem.call(this, key, value);
      };
      const { App } = await import("../App.js");
      window.history.replaceState(null, "", "/dashboard");
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root.render(<App />));
      for (let i = 0; i < 20; i++) await act(async () => new Promise((r) => setTimeout(r, 10)));
      expect(gateway.logouts, "the load-time teardown ran").toBeGreaterThan(0);
      expect(container.textContent).toMatch(/Couldn't confirm that the previous wallet session ended/);
      expect([...container.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "Try again")).toBe(true);
      expect(container.textContent, "no shell").not.toContain("Disconnect");
    });
  });
});

describe("19m MEDIUM: only a whole record gives a key", () => {
  it.each([
    ["no generation", JSON.stringify({ key: KEY_B })],
    ["a generation that isn't a string", JSON.stringify({ key: KEY_B, generation: 0 })],
    ["a field this module never writes", JSON.stringify({ key: KEY_B, generation: "", extra: true })],
    ["an empty key", JSON.stringify({ key: "", generation: "" })],
    ["an array", JSON.stringify([KEY_B, ""])],
  ])("%s: no key (fail closed)", async (_, value) => {
    original.setItem.call(localStorage, KEY_SLOT, value); // no confirmed marker yet
    const { owner, sends } = await page();
    expect(sends()).toBeNull();
    expect(owner.hasStoredApiKey()).toBe(false);
  });

  it("a whole record still gives its key", async () => {
    storeRecord(KEY_B, "", original.setItem);
    const { sends } = await page();
    expect(sends()).toBe(KEY_B);
  });
});

describe("19m LOW: a key write is an account change unless it says otherwise", () => {
  it("setStoredApiKey(B) with no options moves the generation: B waits for a teardown", async () => {
    storeRecord(KEY_A, "g0", original.setItem);
    original.setItem.call(localStorage, MARKER, "g0");
    const { owner, generation, sends } = await page();
    expect(sends()).toBe(KEY_A);
    owner.setStoredApiKey(KEY_B);
    expect(sends(), "not at once, beside A's settled session").toBeNull();
    expect(generation.walletSessionEnding()).toBe(true);
  });

  it("a write that keeps the account says so", async () => {
    storeRecord(KEY_A, "g0", original.setItem);
    original.setItem.call(localStorage, MARKER, "g0");
    const { owner, sends } = await page();
    owner.setStoredApiKey(KEY_B, { accountChange: false });
    expect(sends()).toBe(KEY_B);
  });
});
