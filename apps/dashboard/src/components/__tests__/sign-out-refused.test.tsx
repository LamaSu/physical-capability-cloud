/**
 * astra 19j MEDIUM: a sign-out the browser refused must be explained where the
 * person asked for it, from logout()'s typed result (DECISIONS 04:14). The
 * shell's Disconnect is covered in __tests__/account-isolation-r10. These are
 * ConnectWallet's Disconnect and useAuth().logout, the store's other two
 * callers. Since 19k a refused removal is "unconfirmed": it can't be told
 * from one that went through and then threw.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wallet = vi.hoisted(() => ({ address: "0xA11ce00000000000000000000000000000000001", chainId: 8453 }));
vi.mock("wagmi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("wagmi")>()),
  useAccount: () => ({ address: wallet.address, isConnected: true, chainId: wallet.chainId }),
  useConnect: () => ({ connectors: [], connect: () => {} }),
  useDisconnect: () => ({ disconnect: () => {} }),
  useSignMessage: () => ({ signMessageAsync: async () => "0xsig" }),
}));

// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY_A = ["pcc", "test", "signoutA0123456789abcdef"].join("_");
const originalSet = Storage.prototype.setItem;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem("pcc-api-key", KEY_A);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      if (path === "/api/auth/me") return new Response(JSON.stringify({ address: wallet.address }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
  // The browser refuses to change the saved key's slot (since DECISIONS 05:04 a sign-out is one write of its record).
  Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
    if (key === "pcc-api-key") throw new DOMException("The operation is insecure.", "SecurityError");
    return originalSet.call(this, key, value);
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Storage.prototype.setItem = originalSet;
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const button = (text: string) => [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);

describe("a refused sign-out is explained (astra 19j)", () => {
  it("ConnectWallet's Disconnect keeps its panel open and says why", async () => {
    const { ConnectWallet } = await import("../ConnectWallet.js");
    await act(async () => root.render(<ConnectWallet />));
    await settle();
    await settle();
    const opener = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("0xA11c"));
    expect(opener, "the signed-in wallet's button").toBeDefined();
    await act(async () => opener!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const disconnect = button("Disconnect");
    expect(disconnect, "the panel's Disconnect").toBeDefined();
    await act(async () => disconnect!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent ?? "").toMatch(/couldn't confirm it removed your saved API key/);
    expect(button("Disconnect"), "the panel stays open").toBeDefined();
  });

  it("useAuth().logout answers with the typed result, and the store keeps it for the surfaces", async () => {
    const { useAuth } = await import("../../hooks/use-auth.js");
    const { useAuthStore } = await import("../../stores/auth-store.js");
    let auth: ReturnType<typeof useAuth> | null = null;
    function Probe() {
      auth = useAuth();
      return null;
    }
    await act(async () => root.render(<Probe />));
    await settle();
    let result: Awaited<ReturnType<ReturnType<typeof useAuth>["logout"]>> | undefined;
    await act(async () => {
      result = await auth!.logout();
    });
    expect(result).toEqual({ status: "unconfirmed", reason: expect.stringMatching(/couldn't confirm it removed your saved API key/) });
    expect(useAuthStore.getState().lastSignOut).toEqual(result);
  });
});
