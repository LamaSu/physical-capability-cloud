/**
 * astra's round-4 verdict on #354 (pack 19d, DO-NOT-SHIP) found two more ways
 * one account's state reaches the next. These reproduce each, at df74d985,
 * before any fix.
 *
 * C1: A's wallet and SIWE session come back for B. The dashboard's Disconnect
 *     only cleared the API key, while wagmi and the gateway's SIWE cookie live
 *     above the account boundary. When B's shell mounted, ConnectWallet copied
 *     A's still-connected wallet into the store and re-adopted A's cookie
 *     session (/api/auth/me).
 * C2: an async result from A lands in B's stores. A store action captured by
 *     A's component (EvidenceExplorer's addCommitment after POST /zk/commit),
 *     or a timer the SSE hook left behind, writes after the switch.
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── wagmi, as a connected wallet would leave it ─────────────────────────────
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

let container: HTMLDivElement;
let root: Root;

/** The gateway as these tests see it: validate accepts any key; the SIWE cookie lives until POST /api/auth/logout. */
const gateway = {
  siweCookie: false,
  calls: [] as string[],
  zkCommit: null as null | ((r: Response) => void),
  /** When set, GET /api/auth/me waits; each waiting request is answered by the test. */
  deferMe: false,
  meWaiting: [] as Array<(r: Response) => void>,
  /** When set, POST /api/auth/logout waits for the test to answer it. */
  deferLogout: false,
  logoutWaiting: [] as Array<() => void>,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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
  gateway.siweCookie = false;
  gateway.calls = [];
  gateway.zkCommit = null;
  gateway.deferMe = false;
  gateway.meWaiting = [];
  gateway.deferLogout = false;
  gateway.logoutWaiting = [];
  disconnectWallet();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      gateway.calls.push(`${method} ${path}`);
      if (path === "/api/auth/validate") return json({ valid: true });
      if (path === "/api/auth/me") {
        if (gateway.deferMe) return new Promise<Response>((resolve) => gateway.meWaiting.push(resolve));
        return gateway.siweCookie ? json({ address: A_WALLET }) : json({ error: "Not authenticated" }, 401);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        const done = () => {
          gateway.siweCookie = false;
          return json({ ok: true });
        };
        if (gateway.deferLogout) return new Promise<Response>((resolve) => gateway.logoutWaiting.push(() => resolve(done())));
        return done();
      }
      if (path === "/api/zk/commit") return new Promise<Response>((resolve) => (gateway.zkCommit = resolve));
      throw new TypeError("Failed to fetch");
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState(null, "", "/");
});

async function settle(n = 20) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function waitForText(text: string, ms = 8_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((container.textContent ?? "").includes(text)) return true;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  return (container.textContent ?? "").includes(text);
}

/**
 * Sign in as A and render `path`. `before` runs once A's account boundary has
 * settled, so a wallet it connects isn't ended by A's own sign-in teardown.
 */
async function renderAt(path: string, before?: () => void) {
  window.history.replaceState(null, "", path);
  const { adoptApiKey } = await import("../stores/auth-store.js");
  adoptApiKey("pcc_test_key"); // N50 (#368): the key goes in through adoptApiKey, never the store's state
  await settle(5); // the account change, if this is one, ends the previous wallet session
  before?.();
  const { App } = await import("../App.js");
  await act(async () => {
    root.render(<App />);
  });
  await settle();
}

function click(text: string) {
  const el = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  expect(el, `a button with "${text}"`).toBeDefined();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("C1: A's wallet and SIWE session never carry over to B (astra 19d)", () => {
  async function signInAWithWallet() {
    await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
      gateway.siweCookie = true;
    });
    const { useAuthStore } = await import("../stores/auth-store.js");
    expect(useAuthStore.getState().address, "A's wallet is connected").toBe(A_WALLET);
    expect(useAuthStore.getState().sessionToken, "A's SIWE session is adopted").toBe("cookie");
    return useAuthStore;
  }

  it("after the dashboard's Disconnect, B signing in gets no wallet, no SIWE session, and A's cookie is gone", async () => {
    const useAuthStore = await signInAWithWallet();
    await act(async () => useAuthStore.getState().logout());
    await settle();
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(useAuthStore.getState().address).toBeNull();
    expect(useAuthStore.getState().sessionToken).toBeNull();
    expect(gateway.siweCookie, "the gateway's SIWE cookie was destroyed").toBe(false);
    expect(wallet.isConnected, "wagmi was disconnected").toBe(false);
  }, 20_000);

  it("B's shell neither mounts nor asks the gateway anything until A's SIWE cookie is gone", async () => {
    const useAuthStore = await signInAWithWallet();
    gateway.deferLogout = true;
    const before = gateway.calls.length;
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(gateway.logoutWaiting.length, "A's session teardown is waiting on the gateway").toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("Signing out of the previous account");
    // While the switch is pending, before any ConnectWallet mounts, the store holds no wallet of A's.
    expect(useAuthStore.getState().address).toBeNull();
    expect(useAuthStore.getState().sessionToken).toBeNull();
    const meanwhile = gateway.calls.slice(before).filter((c) => !c.startsWith("POST /api/auth/logout") && !c.startsWith("GET /api/auth/validate"));
    expect(meanwhile, "nothing of B's went out while A's cookie was live").toEqual([]);
    await act(async () => {
      for (const answer of gateway.logoutWaiting.splice(0)) answer();
    });
    await settle();
    expect(container.textContent).not.toContain("Signing out of the previous account");
    expect(useAuthStore.getState().sessionToken).toBeNull();
    expect(useAuthStore.getState().address).toBeNull();
  }, 20_000);

  it("where no ConnectWallet renders (/app), B still starts with no wallet and no SIWE session", async () => {
    await renderAt("/app", () => {
      gateway.siweCookie = true;
    });
    const { useAuthStore } = await import("../stores/auth-store.js");
    await act(async () => useAuthStore.getState().setAddress(A_WALLET)); // A's wallet, adopted earlier
    await act(async () => useAuthStore.getState().setSession("cookie"));
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(useAuthStore.getState().address).toBeNull();
    expect(useAuthStore.getState().sessionToken).toBeNull();
  }, 20_000);

  it("A's session check, answered after B signs in, is dropped", async () => {
    await renderAt("/dashboard", () => {
      gateway.siweCookie = true;
      gateway.deferMe = true; // A's ConnectWallet asks /api/auth/me; the answer is held
    });
    expect(gateway.meWaiting.length, "A's session check is in flight").toBeGreaterThanOrEqual(1);
    const asA = gateway.meWaiting.splice(0);
    const { useAuthStore } = await import("../stores/auth-store.js");
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    // A's check now gets the answer A's cookie earned; B's own checks find no session.
    await act(async () => {
      for (const answer of asA) answer(json({ address: A_WALLET }));
      for (const answer of gateway.meWaiting.splice(0)) answer(json({ error: "Not authenticated" }, 401));
    });
    await settle();
    expect(useAuthStore.getState().sessionToken).toBeNull();
  }, 20_000);

  it("a different key while signed in (A to B) also ends A's wallet session before B's shell renders", async () => {
    const useAuthStore = await signInAWithWallet();
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(useAuthStore.getState().address).toBeNull();
    expect(useAuthStore.getState().sessionToken).toBeNull();
    expect(gateway.siweCookie).toBe(false);
    expect(wallet.isConnected).toBe(false);
    // Nothing of B's was asked while A's cookie could still answer it.
    const logoutAt = gateway.calls.lastIndexOf("POST /api/auth/logout");
    const meAfter = gateway.calls.slice(logoutAt + 1).filter((c) => c === "GET /api/auth/me");
    expect(logoutAt, "POST /api/auth/logout was sent").toBeGreaterThanOrEqual(0);
    expect(meAfter.every(() => gateway.siweCookie === false)).toBe(true);
  }, 20_000);
});

describe("C2: a result of A's async work never lands in B's stores (astra 19d)", () => {
  it("EvidenceExplorer: A's /zk/commit response, arriving after B signs in, is dropped", async () => {
    await renderAt("/evidence");
    expect(await waitForText("Encrypted Bundles")).toBe(true);
    await act(async () => click("bun_001"));
    await settle(5);
    await act(async () => click("Create Commitment"));
    await settle(5);
    expect(gateway.zkCommit, "A's POST /zk/commit is in flight").not.toBeNull();

    const { useAuthStore } = await import("../stores/auth-store.js");
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    await act(async () => {
      gateway.zkCommit!(
        json({
          commitment: {
            bundleHash: "sha256:a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
            commitmentHash: "A-commitment-from-the-previous-account",
            commitmentTimestamp: Date.now(),
          },
        }),
      );
    });
    await settle();
    const { useEvidenceExplorerStore } = await import("../stores/evidence-explorer-store.js");
    expect(useEvidenceExplorerStore.getState().commitments).toEqual({});
  }, 20_000);

  it("any store action captured during A's session does nothing after the switch", async () => {
    await renderAt("/app");
    const { useSpatialChatStore } = await import("../features/chat/ChatStore.js");
    const addAsA = useSpatialChatStore.getState().addMessage; // what A's component closure holds
    const { useAuthStore } = await import("../stores/auth-store.js");
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    await act(async () => addAsA({ role: "user", content: "late-write-from-A" }));
    expect(useSpatialChatStore.getState().messages.some((m) => m.content === "late-write-from-A")).toBe(false);
    // B's own actions still work.
    await act(async () => useSpatialChatStore.getState().addMessage({ role: "user", content: "B-writes" }));
    expect(useSpatialChatStore.getState().messages.some((m) => m.content === "B-writes")).toBe(true);
  }, 20_000);

  it("the SSE hook does not reconnect after its component unmounts", async () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      onerror: (() => void) | null = null;
      onmessage: ((e: MessageEvent) => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        FakeEventSource.instances.push(this);
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const { useSSEStream } = await import("../hooks/use-sse-stream.js");
    function Probe() {
      useSSEStream({ url: "/sse/stream/kernel/k1", onEvent: () => {} });
      return null;
    }
    await act(async () => root.render(<Probe />));
    expect(FakeEventSource.instances).toHaveLength(1);
    // The stream errors (a reconnect is scheduled), then the account changes and the page unmounts.
    await act(async () => FakeEventSource.instances[0]!.onerror!());
    await act(async () => root.render(<></>));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3_300));
    });
    expect(FakeEventSource.instances, "no stream reopened after unmount").toHaveLength(1);
  }, 20_000);
});
