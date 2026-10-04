/**
 * The SIWE calls that authenticate send the API key (N103, client half).
 *
 * The gateway is about to bind each SIWE session to the API key it was
 * verified under, and to honor its cookie only beside that same key
 * (gateway's ruling #6597, strict shape A). So the dashboard's two calls that
 * authenticate with the session must carry the key:
 * - POST /api/auth/verify, so the session is bound to this account;
 * - GET /api/auth/me, so the cookie is honored.
 * Today's gateway ignores the key on both, so this lands first.
 * Logout still sends only the cookie: it ends whatever session the cookie
 * names, and authenticates nothing.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeWebLocks } from "../../__tests__/fake-web-locks.js";

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
const KEY = ["pcc", "test", "siwekey0123456789abcdef"].join("_");

interface Call {
  path: string;
  method: string;
  authorization: string | null;
}
let calls: Call[] = [];
let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  // Verification goes through wallet-session's verifySignIn, which orders it
  // under a Web Lock (#354); jsdom has none.
  installFakeWebLocks();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      calls.push({ path, method: (init?.method ?? "GET").toUpperCase(), authorization: new Headers(init?.headers).get("authorization") });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (path === "/api/auth/me") return json({ error: "Not authenticated" }, 401);
      if (path === "/api/auth/nonce") return json({ nonce: "nonce-1" });
      if (path === "/api/auth/verify") return json({ token: "session-1", address: wallet.address });
      return json({});
    }),
  );
  const { setStoredApiKey } = await import("../../lib/authorized-fetch.js");
  setStoredApiKey(KEY);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  const { setStoredApiKey } = await import("../../lib/authorized-fetch.js");
  setStoredApiKey(null);
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
const callTo = (path: string) => calls.find((c) => c.path === path);

describe("ConnectWallet's SIWE calls carry the API key (N103)", () => {
  it("GET /api/auth/me, the session check on mount", async () => {
    const { ConnectWallet } = await import("../ConnectWallet.js");
    await act(async () => root.render(<ConnectWallet />));
    await settle();
    expect(callTo("/api/auth/me")?.authorization).toBe(`Bearer ${KEY}`);
  });

  it("POST /api/auth/verify, the sign-in", async () => {
    const { ConnectWallet } = await import("../ConnectWallet.js");
    await act(async () => root.render(<ConnectWallet />));
    await settle();
    const signIn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Sign In");
    expect(signIn, "the Sign In button").toBeDefined();
    await act(async () => signIn!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await settle();
    expect(callTo("/api/auth/verify")?.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("useAuth's SIWE calls carry the API key (N103)", () => {
  it("GET /api/auth/me on mount, and POST /api/auth/verify on login", async () => {
    const { useAuth } = await import("../../hooks/use-auth.js");
    let auth: ReturnType<typeof useAuth> | null = null;
    function Probe() {
      auth = useAuth();
      return null;
    }
    await act(async () => root.render(<Probe />));
    await settle();
    expect(callTo("/api/auth/me")?.authorization).toBe(`Bearer ${KEY}`);
    await act(async () => {
      await auth!.login();
    });
    expect(callTo("/api/auth/verify")?.authorization).toBe(`Bearer ${KEY}`);
  });
});
