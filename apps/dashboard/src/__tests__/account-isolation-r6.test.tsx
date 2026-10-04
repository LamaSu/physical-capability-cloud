/**
 * astra's round-5 verdict on #354 (pack 19e, DO-NOT-SHIP) found four more
 * ways the previous account's authority survives a switch. These reproduce
 * each, at d8ff4eb2, before any fix.
 *
 * C1a: A's SIWE verification, still in flight when B signs in, sets A's cookie
 *      after the logout that opened B's shell. The old component's cleanup
 *      logout isn't part of the boundary, and can fail.
 * C1b: a reload while the teardown is pending skips it. B's key is already
 *      persisted, and a fresh page starts settled.
 * HIGH: the teardown accepts HTTP 200 without the gateway's {ok: true}.
 * MEDIUM: a hand tracker still loading when B signs in registers onResults
 *      afterwards, and a gesture then drives B's spatial chat through
 *      getState().
 *
 * @vitest-environment jsdom
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import type { GestureEvent } from "../features/gestures/GestureRecognizer.js";
import { installFakeWebLocks } from "./fake-web-locks.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const wallet = vi.hoisted(() => ({ address: undefined as string | undefined, isConnected: false, chainId: undefined as number | undefined }));
/** When set, the wallet's signature waits for the test to give it. */
const signing = vi.hoisted(() => ({ hold: false, waiting: [] as Array<() => void> }));
const disconnects = vi.hoisted(() => ({ count: 0, refused: false }));
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
  return {
    ...actual,
    disconnect: async () => {
      disconnects.count += 1;
      if (!disconnects.refused) disconnectWallet();
    },
  };
});
// Every hand pose reads as "peace", which toggles the spatial chat's sidebar (useGestures).
vi.mock("../features/gestures/GestureRecognizer.js", () => ({ recognizeGesture: () => ({ type: "peace", confidence: 1 }) }));

const A_WALLET = "0xA11ce00000000000000000000000000000000001";

type LogoutMode = "ok" | "hold" | "fail" | "200-not-ok" | "200-html" | "ok-then-fail";

/** The gateway as these tests see it. The SIWE cookie is set by a completed /api/auth/verify and destroyed by a logout that answers {ok: true}. */
const gateway = {
  siweCookie: false,
  calls: [] as string[],
  logoutMode: "ok" as LogoutMode,
  logouts: 0,
  logoutWaiting: [] as Array<(answer?: boolean) => void>,
  verifyWaiting: [] as Array<() => void>,
  /** When set, a verification already on the wire completes even if the page aborts it. */
  verifyIgnoresAbort: false,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let container: HTMLDivElement;
let root: Root;

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
  installFakeWebLocks(); // a SIWE sign-in needs Web Locks (lib/wallet-session.ts); jsdom has none. Fresh per test.
  gateway.siweCookie = false;
  gateway.calls = [];
  gateway.logoutMode = "ok";
  gateway.logouts = 0;
  gateway.logoutWaiting = [];
  gateway.verifyWaiting = [];
  gateway.verifyIgnoresAbort = false;
  disconnects.count = 0;
  disconnects.refused = false;
  signing.hold = false;
  signing.waiting = [];
  disconnectWallet();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!;
      const method = (init?.method ?? "GET").toUpperCase();
      gateway.calls.push(`${method} ${path}`);
      if (path === "/api/_probe/sent-key") {
        probe.authorization = new Headers(init?.headers).get("authorization");
        return json({});
      }
      if (path === "/api/auth/validate") return json({ valid: true });
      if (path === "/api/auth/me") return gateway.siweCookie ? json({ address: A_WALLET }) : json({ error: "Not authenticated" }, 401);
      if (path === "/api/auth/nonce") return json({ nonce: "nonce-1" });
      if (path === "/api/auth/verify" && method === "POST") {
        // Held until the test answers it. An aborted request never delivers its Set-Cookie.
        return new Promise<Response>((resolve, reject) => {
          let aborted = false;
          init?.signal?.addEventListener("abort", () => {
            if (gateway.verifyIgnoresAbort) return;
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
        gateway.logouts += 1;
        const destroy = () => {
          gateway.siweCookie = false;
          return json({ ok: true });
        };
        switch (gateway.logoutMode) {
          case "ok":
            return destroy();
          case "ok-then-fail":
            if (gateway.logouts === 1) return destroy();
            throw new TypeError("Failed to fetch");
          case "fail":
            throw new TypeError("Failed to fetch");
          case "200-not-ok":
            return json({ ok: false }); // HTTP 200, cookie kept
          case "200-html":
            return new Response("<!doctype html><title>PCC</title>", { status: 200, headers: { "Content-Type": "text/html" } }); // a fallback page, cookie kept
          case "hold":
            return new Promise<Response>((resolve, reject) =>
              gateway.logoutWaiting.push((answer = true) => (answer ? resolve(destroy()) : reject(new TypeError("Failed to fetch")))),
            );
        }
      }
      throw new TypeError("Failed to fetch");
    }),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  // A verification a test left on the wire would hold every later teardown (wallet-session's registry outlives a test).
  gateway.verifyIgnoresAbort = true;
  for (const complete of gateway.verifyWaiting.splice(0)) complete();
  await act(async () => root.unmount());
  container.remove();
  // loadScript() treats a script already in the head as loaded.
  for (const s of [...document.head.querySelectorAll('script[src*="mediapipe"]')]) s.remove();
  window.history.replaceState(null, "", "/");
  try {
    localStorage.clear();
  } catch {
    // no storage
  }
});

async function settle(n = 20) {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

async function renderAt(path: string, before?: () => void) {
  window.history.replaceState(null, "", path);
  const { useAuthStore, adoptApiKey } = await import("../stores/auth-store.js");
  adoptApiKey("pcc_test_key"); // as login() keeps it: the key's owner writes the browser's slot
  await settle(5);
  before?.();
  const { App } = await import("../App.js");
  await act(async () => {
    root.render(<App />);
  });
  await settle();
  return useAuthStore;
}

/** The authorization header of the last probe request, as the gateway stub saw it. */
const probe = { authorization: undefined as string | null | undefined };

/**
 * Which key this page would send: one request through its authorizedFetch,
 * whose header the gateway stub captures. N50 keeps the key out of every other
 * module's reach, so this is how a test asks which account the page acts as.
 * fetchWithKey reaches fetch() before any await, so it is synchronous.
 */
async function sentKey(): Promise<string | null> {
  const { authorizedFetch } = await import("../lib/authorized-fetch.js");
  probe.authorization = undefined;
  void authorizedFetch("/api/_probe/sent-key");
  const seen = probe.authorization as string | null | undefined; // set by the gateway stub during the call above
  if (seen === undefined) throw new Error("the probe didn't reach fetch synchronously");
  return seen === null ? null : seen.replace(/^Bearer /, "");
}

function click(text: string) {
  const el = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text || (b.textContent ?? "").includes(text));
  expect(el, `a button with "${text}"`).toBeDefined();
  el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("19e C1a: A's SIWE sign-in in flight at the switch leaves no cookie of A's", () => {
  it("the verification can't land after the logout that opened B's shell", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
    });
    await act(async () => click("Sign In"));
    await settle(5);
    expect(gateway.verifyWaiting, "A's /api/auth/verify is in flight").toHaveLength(1);

    // B signs in. The boundary's logout succeeds; any later logout fails, so cleanup can't be left to chance.
    gateway.logoutMode = "ok-then-fail";
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    // A's verification completes now, if it still can.
    await act(async () => {
      for (const complete of gateway.verifyWaiting.splice(0)) complete();
    });
    await settle();
    expect(gateway.siweCookie, "no SIWE cookie of A's is live in B's browser").toBe(false);
    expect(useAuthStore.getState().sessionToken).toBeNull();
  }, 20_000);
});

describe("19e C1b: a reload while the teardown is pending doesn't skip it", () => {
  it("the reloaded page ends A's wallet session before it mounts B", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
      gateway.siweCookie = true;
    });
    expect(useAuthStore.getState().sessionToken).toBe("cookie");
    gateway.logoutMode = "hold";
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(gateway.logoutWaiting.length, "the teardown's logout is pending").toBeGreaterThanOrEqual(1);

    // The page reloads before the gateway answers. Its request dies with it, unanswered: the cookie stays live, and
    // the page's lock is released (a browser releases a closed page's locks). A fresh page: fresh modules, B's key
    // from storage.
    await act(async () => root.unmount());
    for (const drop of gateway.logoutWaiting.splice(0)) drop(false);
    vi.resetModules();
    const React2 = await import("react");
    const { createRoot: createRoot2 } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root2 = createRoot2(host);
    const { useAuthStore: freshStore } = await import("../stores/auth-store.js");
    expect(freshStore.getState().isAuthenticated, "B's key was persisted").toBe(true);
    gateway.logoutMode = "ok"; // the gateway answers the reloaded page
    const sinceReload = gateway.calls.length;
    const { App: FreshApp } = await import("../App.js");
    await React2.act(async () => root2.render(React2.createElement(FreshApp)));
    for (let i = 0; i < 20; i++) {
      await React2.act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(gateway.siweCookie, "A's cookie was destroyed before B mounted").toBe(false);
    expect(freshStore.getState().sessionToken).toBeNull();
    expect(freshStore.getState().address).toBeNull();
    // The logout came before anything of B's asked the gateway for a session.
    const reloaded = gateway.calls.slice(sinceReload);
    const logoutAt = reloaded.indexOf("POST /api/auth/logout");
    expect(logoutAt, "the reloaded page logged A's wallet session out").toBeGreaterThanOrEqual(0);
    const meAt = reloaded.indexOf("GET /api/auth/me");
    if (meAt >= 0) expect(meAt, "B's session check came after the logout").toBeGreaterThan(logoutAt);
    const { walletSessionEnding } = await import("../lib/account-generation.js");
    expect(walletSessionEnding(), "the confirmed teardown recorded its generation as ended").toBe(false);
    await React2.act(async () => root2.unmount());
    host.remove();
  }, 20_000);
});

describe("19e HIGH: the teardown needs the gateway's {ok: true}, not just HTTP 200", () => {
  it("a logout answered 200 {ok:false} doesn't open B's shell", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
      gateway.siweCookie = true;
    });
    gateway.logoutMode = "200-not-ok";
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(container.textContent).toContain("Couldn't confirm that the previous wallet session ended");
    expect(useAuthStore.getState().sessionToken).toBeNull();
  }, 20_000);
});

describe("19e MEDIUM: a hand tracker still loading at the switch can't drive B's stores", () => {
  it("its late onResults doesn't toggle B's spatial chat", async () => {
    let onResults: ((r: unknown) => void) | null = null;
    (window as unknown as { Hands: unknown }).Hands = class {
      setOptions() {}
      onResults(cb: (r: unknown) => void) {
        onResults = cb;
      }
      send() {}
      close() {}
    };
    (window as unknown as { Camera: unknown }).Camera = class {
      start() {
        return Promise.resolve();
      }
      stop() {}
    };
    const useAuthStore = await renderAt("/app");
    await act(async () => click("Gestures"));
    await settle(3);
    const loadScripts = async () => {
      for (const s of [...document.head.querySelectorAll<HTMLScriptElement>('script[src*="mediapipe"]')]) {
        await act(async () => s.dispatchEvent(new Event("load")));
      }
    };
    // B signs in while MediaPipe is still loading.
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    await loadScripts(); // the hands script
    await settle(3);
    await loadScripts(); // the camera script, requested after the first loaded
    await settle(3);
    const { useSpatialChatStore } = await import("../features/chat/ChatStore.js");
    const before = useSpatialChatStore.getState().sidebarOpen;
    await act(async () => onResults?.({ multiHandLandmarks: [[{ x: 0, y: 0, z: 0 }]] }));
    expect(useSpatialChatStore.getState().sidebarOpen, "B's sidebar is unchanged").toBe(before);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Each part of the fixes, pinned on its own
// ---------------------------------------------------------------------------

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
function productionFiles(dir: string): Array<{ rel: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : productionFiles(full);
    if (!/\.(ts|tsx)$/.test(name) || /\.(test|spec)\.tsx?$/.test(name) || name.endsWith(".d.ts")) return [];
    return [{ rel: relative(SRC, full).split(sep).join("/"), text: readFileSync(full, "utf-8") }];
  });
}

describe("19e C1a, the parts", () => {
  it("a verification already on the wire holds the boundary until it settles; the logout comes after it", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
    });
    await act(async () => click("Sign In"));
    await settle(5);
    expect(gateway.verifyWaiting).toHaveLength(1);
    gateway.verifyIgnoresAbort = true; // the gateway completes it anyway
    gateway.logoutMode = "ok-then-fail";
    gateway.logouts = 0;
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(container.textContent, "B's shell waits for A's verification").toContain("Signing out of the previous account");
    expect(gateway.logouts, "no logout before A's verification settled").toBe(0);
    await act(async () => {
      for (const complete of gateway.verifyWaiting.splice(0)) complete();
    });
    await settle();
    expect(gateway.logouts).toBe(1);
    expect(gateway.siweCookie, "the logout after it destroyed A's cookie").toBe(false);
    expect(useAuthStore.getState().sessionToken, "the aborted sign-in adopted nothing").toBeNull();
    expect(container.textContent).not.toContain("Signing out of the previous account");
  }, 20_000);

  it("a verification answered after the switch is adopted by nothing, even with the wallet still connected", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
    });
    await act(async () => click("Sign In"));
    await settle(5);
    gateway.verifyIgnoresAbort = true;
    disconnects.refused = true; // the wallet stays connected through the teardown
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    await act(async () => {
      for (const complete of gateway.verifyWaiting.splice(0)) complete();
    });
    await settle();
    expect(useAuthStore.getState().sessionToken, "A's answer isn't B's session").toBeNull();
    expect(gateway.siweCookie).toBe(false);
  }, 20_000);

  it("a sign-in whose wallet was still signing at the switch sends no verification", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
    });
    signing.hold = true;
    await act(async () => click("Sign In"));
    await settle(5);
    expect(signing.waiting, "A's wallet is signing").toHaveLength(1);
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    const sinceSwitch = gateway.calls.length;
    await act(async () => {
      for (const sign of signing.waiting.splice(0)) sign();
    });
    await settle();
    expect(gateway.calls.slice(sinceSwitch), "nothing sent for A after the switch").not.toContain("POST /api/auth/verify");
    expect(gateway.siweCookie).toBe(false);
    expect(useAuthStore.getState().sessionToken).toBeNull();
  }, 20_000);

  it("only lib/wallet-session.ts sends /api/auth/verify, so every verification is one the teardown waits for", () => {
    const senders = productionFiles(SRC).filter((f) => f.text.includes("/api/auth/verify")).map((f) => f.rel);
    expect(senders).toEqual(["lib/wallet-session.ts"]);
  });
});

describe("19e C1b, the parts", () => {
  it("a page loaded after a confirmed teardown mounts straight away, with no logout", async () => {
    const useAuthStore = await renderAt("/dashboard");
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    const { walletSessionEnding } = await import("../lib/account-generation.js");
    expect(walletSessionEnding(), "nothing pending once the teardown confirmed").toBe(false);
    await act(async () => root.unmount());
    vi.resetModules();
    const React2 = await import("react");
    const { createRoot: createRoot2 } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root2 = createRoot2(host);
    const logoutsBefore = gateway.logouts;
    const { App: FreshApp } = await import("../App.js");
    await React2.act(async () => root2.render(React2.createElement(FreshApp)));
    expect(host.textContent).not.toContain("Signing out of the previous account");
    for (let i = 0; i < 5; i++) {
      await React2.act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
    }
    expect(gateway.logouts).toBe(logoutsBefore);
    await React2.act(async () => root2.unmount());
    host.remove();
    root = createRoot(container); // for afterEach
  }, 20_000);

  it("the teardown waits for wagmi to finish restoring the last page's connection, then disconnects it", async () => {
    const { wagmiConfig } = await import("../providers/WalletProvider.js");
    const { endWalletSession } = await import("../lib/wallet-session.js");
    wagmiConfig.setState((x) => ({ ...x, status: "reconnecting" }));
    const ending = endWalletSession();
    await settle(3);
    expect(disconnects.count, "nothing disconnected while wagmi is still restoring").toBe(0);
    wagmiConfig.setState((x) => ({ ...x, status: "connected" }));
    expect(await ending).toBe(true);
    expect(disconnects.count).toBeGreaterThan(0);
    wagmiConfig.setState((x) => ({ ...x, status: "disconnected" }));
  }, 20_000);
});

describe("19e HIGH, the parts", () => {
  it("a logout answered 200 with a fallback page doesn't open B's shell", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      gateway.siweCookie = true;
    });
    gateway.logoutMode = "200-html";
    await act(async () => {
      expect(await useAuthStore.getState().login("pcc_test_key_b")).toBe(true);
    });
    await settle();
    expect(container.textContent).toContain("Couldn't confirm that the previous wallet session ended");
  }, 20_000);
});

describe("19e MEDIUM, the parts", () => {
  it("a tracker that unmounts while MediaPipe loads builds no tracker and starts no camera", async () => {
    let built = 0;
    let started = 0;
    (window as unknown as { Hands: unknown }).Hands = class {
      constructor() {
        built += 1;
      }
      setOptions() {}
      onResults() {}
      send() {}
      close() {}
    };
    (window as unknown as { Camera: unknown }).Camera = class {
      start() {
        started += 1;
        return Promise.resolve();
      }
      stop() {}
    };
    await renderAt("/app");
    await act(async () => click("Gestures"));
    await settle(3);
    await act(async () => root.unmount()); // the page goes away while the library loads
    root = createRoot(container);
    for (let round = 0; round < 2; round++) {
      for (const s of [...document.head.querySelectorAll<HTMLScriptElement>('script[src*="mediapipe"]')]) {
        await act(async () => s.dispatchEvent(new Event("load")));
      }
      await settle(3);
    }
    expect(built, "no tracker built after unmount").toBe(0);
    expect(started, "no camera started after unmount").toBe(0);
  }, 20_000);

  it("a gesture handler held from before the account changed does nothing after it", async () => {
    const { useGestures } = await import("../features/gestures/useGestures.js");
    const { resetAccountScopedState } = await import("../lib/account-scope.js");
    const { useSpatialChatStore } = await import("../features/chat/ChatStore.js");
    let held: ((e: GestureEvent) => void) | null = null;
    function Probe() {
      held = useGestures().handleGesture;
      return null;
    }
    const peace = { type: "peace", x: 0.5, y: 0.5, confidence: 1, landmarks: [] } as unknown as GestureEvent;
    await act(async () => root.render(<Probe />));
    const asA = held!;
    await act(async () => root.render(<></>));
    resetAccountScopedState(); // the account changes
    const before = useSpatialChatStore.getState().sidebarOpen;
    asA(peace);
    expect(useSpatialChatStore.getState().sidebarOpen, "A's handler left B's chat alone").toBe(before);
    await act(async () => root.render(<Probe />)); // mounted for the current account, it works
    held!(peace);
    expect(useSpatialChatStore.getState().sidebarOpen).toBe(!before);
  });
});

describe("self-found (19e's weakest link, another tab): the account follows the browser's key", () => {
  it("another tab signing B in switches this tab too, and ends the wallet session here", async () => {
    const useAuthStore = await renderAt("/dashboard", () => {
      wallet.address = A_WALLET;
      wallet.isConnected = true;
      wallet.chainId = 84532;
      gateway.siweCookie = true;
    });
    expect(useAuthStore.getState().sessionToken, "this tab is A, with A's SIWE session").toBe("cookie");
    // (Assertions are on this page, not on gateway counters: modules re-imported by earlier tests
    // leave stale copies whose listeners also hear the event. A real page has one copy.)
    gateway.logoutMode = "hold";
    // Another tab signs B in. Its login() stored B's key; this tab gets the storage event.
    localStorage.setItem("pcc-api-key", "pcc_test_key_b");
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "pcc-api-key", oldValue: "pcc_test_key", newValue: "pcc_test_key_b" }));
    });
    await settle(5);
    expect(await sentKey(), "this tab no longer acts as A").toBe("pcc_test_key_b");
    expect(useAuthStore.getState().sessionToken, "A's SIWE session left this tab").toBeNull();
    expect(container.textContent, "this tab runs its own account boundary").toContain("Signing out of the previous account");
    gateway.logoutMode = "ok";
    await act(async () => {
      for (const answer of gateway.logoutWaiting.splice(0)) answer();
    });
    await settle();
    expect(container.textContent).not.toContain("Signing out of the previous account");
    expect(gateway.siweCookie).toBe(false);
  }, 20_000);

  it("a storage event for anything else, or for the key this tab already holds, changes nothing", async () => {
    const useAuthStore = await renderAt("/dashboard");
    gateway.logoutMode = "hold";
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "pcc-something-else", newValue: "x" }));
      window.dispatchEvent(new StorageEvent("storage", { key: "pcc-api-key", oldValue: null, newValue: "pcc_test_key" }));
    });
    await settle(5);
    expect(await sentKey(), "this tab still acts as A").toBe("pcc_test_key");
    expect(container.textContent, "no account boundary here").not.toContain("Signing out of the previous account");
  }, 20_000);
});
