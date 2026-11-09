// @vitest-environment jsdom
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authorizedFetch } = vi.hoisted(() => ({ authorizedFetch: vi.fn() }));
vi.mock("../lib/authorized-fetch.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/authorized-fetch.js")>(),
  authorizedFetch,
}));

// Keep App's actual BrowserRouter, Shell, auth store and lazy wallet page;
// isolate providers and unrelated shells so no wallet or telemetry SDK runs.
vi.mock("@pcc/ui", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <div data-dashboard-chrome>{children}</div>,
  Sidebar: () => <aside data-dashboard-chrome />,
  TopBar: () => <header data-dashboard-chrome />,
  StatusBar: () => null,
  ParticleBackground: () => null,
}));
vi.mock("../components/nav-config.js", () => ({ navGroups: [] }));
vi.mock("../providers/WalletProvider.js", () => ({ WalletProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../lib/telemetry.js", () => ({
  Sentry: { ErrorBoundary: ({ children }: { children: ReactNode }) => children },
  trackPageView: vi.fn(),
}));
vi.mock("../SpatialApp.js", () => ({ SpatialApp: () => <div data-dashboard-chrome>Spatial shell</div> }));
vi.mock("../pages/LoginPage.js", () => ({ LoginPage: () => <div data-login-page>Sign in</div> }));
vi.mock("../components/PageTransition.js", () => ({ PageTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("../components/NotificationToasts.js", () => ({ NotificationToasts: () => null }));
vi.mock("../components/OnboardingTour.js", () => ({ OnboardingTour: () => null, TourRestartButton: () => null }));
vi.mock("../components/ConnectWallet.js", () => ({ ConnectWallet: () => null }));
vi.mock("../components/ModeToggle.js", () => ({ ModeToggle: () => null }));
vi.mock("../components/AgentLandingHero.js", () => ({ AgentLandingHero: () => null }));

import { App } from "../App.js";
import { listWallets } from "../lib/wallet-link-api.js";
import { adoptApiKey, useAuthStore } from "../stores/auth-store.js";
import { useUIStore } from "../stores/ui-store.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const K1 = "Couldn't load your wallets.";
const K2 = "No wallets are linked with this sign-in.";
const K3 = "PCC did not confirm the unlink. Reload this page to see whether it is still linked.";
const K4a = "PCC found no link to unlink with this sign-in, so nothing was unlinked.";
const K4b = "PCC refused this request, so nothing was unlinked. Reload the page and try again.";
const K8 = "Your sign-in changed, so nothing was unlinked. The list now shows this sign-in's wallets.";
const REVOKED_AT = "2026-11-06T23:30:00Z";

const WALLETS = [
  { linkId: "wl_/private ?#%", role: "agent", keyType: "secp256k1", address: "0x1111111111111111111111111111111111111111", label: "Agent terminal", chainId: 84532, status: "active", createdAt: "2026-10-16T01:00:00Z", expiresAt: "2026-10-17T01:00:00Z", revokedAt: null },
  { linkId: "wl_device", role: "device", keyType: "secp256k1", address: "0x2222222222222222222222222222222222222222", label: "Device terminal", chainId: 1, status: "active", createdAt: "2026-10-16T02:00:00Z", expiresAt: null, revokedAt: null },
  { linkId: "wl_revoked", role: "agent", keyType: "secp256k1", address: "0x3333333333333333333333333333333333333333", label: "Old agent", chainId: 10, status: "revoked", createdAt: "2026-10-16T03:00:00Z", expiresAt: null, revokedAt: "2026-10-18T03:00:00Z" },
  { linkId: "wl_expired", role: "device", keyType: "ed25519", publicKey: "ed25519-expired-public-key", label: "Expired key", chainId: 999, status: "expired", createdAt: "2026-10-16T04:00:00Z", expiresAt: "2026-10-18T04:00:00Z", revokedAt: null },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let originalPath: string;
let originalAuth: ReturnType<typeof useAuthStore.getState>;
let originalMode: ReturnType<typeof useUIStore.getState>["interfaceMode"];
let originalStorage: [Storage, [string, string][]][];

beforeEach(() => {
  authorizedFetch.mockReset();
  authorizedFetch.mockImplementation(() => Promise.resolve(json({ links: WALLETS })));
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Unexpected unmocked request"))));
  originalPath = window.location.pathname + window.location.search + window.location.hash;
  originalAuth = useAuthStore.getState();
  originalMode = useUIStore.getState().interfaceMode;
  originalStorage = [localStorage, sessionStorage].map((storage) => [storage, Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)!;
    return [key, storage.getItem(key)!];
  })]);
  useAuthStore.setState({ isAuthenticated: true, sessionToken: null, address: null });
  useUIStore.setState({ interfaceMode: "dashboard" });
  window.history.replaceState({}, "", "/wallets");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  adoptApiKey(null);
  useAuthStore.setState(originalAuth);
  useUIStore.setState({ interfaceMode: originalMode });
  for (const [storage, contents] of originalStorage) {
    storage.clear();
    for (const [key, value] of contents) storage.setItem(key, value);
  }
  window.history.replaceState({}, "", originalPath);
  vi.unstubAllGlobals();
});

async function renderPage() {
  await act(async () => {
    root.render(<App />);
    await import("../pages/WalletsPage.js");
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.querySelector("h1")?.textContent).toBe("Wallets");
  });
}

function buttons(label: string, scope: ParentNode = container): HTMLButtonElement[] {
  return [...scope.querySelectorAll("button")].filter((element) => element.textContent === label);
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const found = buttons(label, scope)[0];
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

async function click(label: string, scope: ParentNode = container) {
  await act(async () => button(label, scope).click());
}

function rows() { return [...container.querySelectorAll("li")]; }
function posts() { return authorizedFetch.mock.calls.filter(([, init]) => (init as RequestInit).method === "POST"); }
function gets() { return authorizedFetch.mock.calls.filter(([, init]) => (init as RequestInit).method === "GET"); }
function changedIdentity() {
  useAuthStore.setState((state) => ({ keyEpoch: state.keyEpoch + 1 }));
}
async function startUnlink() {
  await renderPage();
  await click("Unlink", rows()[0]);
}

describe("/wallets", () => {
  it.each(["spatial", "agent", "dashboard"] as const)("T1: renders WalletsPage in %s mode", async (interfaceMode) => {
    useUIStore.setState({ interfaceMode });
    await renderPage();
    expect(container.querySelector("[data-dashboard-chrome]")).toBeNull();
    expect(container.querySelector("main")?.className).toBe("ph-no-capture sentry-block min-h-screen bg-[#0B0D12] px-6 py-12 text-white");
    expect(container.textContent).toContain("Wallets you can manage with this sign-in.");
    expect(gets()).toHaveLength(1);
  });

  it.each(["spatial", "agent", "dashboard"] as const)("T1: signed out in %s mode shows LoginPage without a request", async (interfaceMode) => {
    useUIStore.setState({ interfaceMode });
    useAuthStore.setState({ isAuthenticated: false, sessionToken: null });
    await act(async () => root.render(<App />));
    expect(container.querySelector("[data-login-page]")).not.toBeNull();
    expect(container.querySelector("h1")).toBeNull();
    expect(authorizedFetch).not.toHaveBeenCalled();
  });

  it("T2: renders every server field in order, with server status and verbatim times", async () => {
    await renderPage();
    expect(rows()).toHaveLength(4);
    const statuses = ["Linked", "Linked", "Unlinked", "Expired"];
    const extraTimes = ["Expires at", null, "Unlinked at", "Expired at"];
    rows().forEach((row, index) => {
      const wallet = WALLETS[index]!;
      expect(row.querySelector("h2")?.textContent).toBe(wallet.label);
      const paragraphs = [...row.querySelectorAll("p")].map((element) => element.textContent);
      expect(paragraphs).toEqual([
        wallet.role === "agent" ? "Agent" : "Device",
        wallet.address ?? wallet.publicKey,
        `Chain ${wallet.chainId}`,
        statuses[index],
        `Linked at ${wallet.createdAt}`,
        ...(extraTimes[index] ? [`${extraTimes[index]} ${wallet.revokedAt ?? wallet.expiresAt}`] : []),
      ]);
      const key = row.querySelectorAll("p")[1]!;
      expect(key.classList.contains("font-mono")).toBe(true);
      expect(key.classList.contains("break-all")).toBe(true);
      const times = [...row.querySelectorAll("time")];
      expect(times.map((time) => time.dateTime)).toEqual([wallet.createdAt, ...((wallet.revokedAt ?? wallet.expiresAt) ? [wallet.revokedAt ?? wallet.expiresAt] : [])]);
      for (const time of times) expect(time.textContent).toBe(time.dateTime);
    });
  });

  it("T3: an empty successful list shows K2 and the /link link, without K1", async () => {
    authorizedFetch.mockResolvedValueOnce(json({ links: [] }));
    await renderPage();
    expect(container.textContent).toContain(K2);
    expect(container.textContent).not.toContain(K1);
    expect(rows()).toHaveLength(0);
    expect(container.querySelector('a[href="/link"]')?.textContent).toBe("Link a wallet");
  });

  const invalidRows = [
    ["null", null], ["array", []],
    ...Object.entries({ linkId: "", role: "owner", keyType: "rsa", address: null, label: 1, chainId: 1.5, status: "unknown", createdAt: null, expiresAt: 1, revokedAt: false })
      .map(([name, value]) => [name, { ...WALLETS[0], [name]: value }]),
    ["missing expiresAt", { ...WALLETS[0], expiresAt: undefined }],
    ["missing revokedAt", { ...WALLETS[0], revokedAt: undefined }],
    ["ed25519 without publicKey", { ...WALLETS[3], publicKey: null }],
  ] as const;
  const failedReads = [
    { name: "500", reply: () => Promise.resolve(json({ error: "private" }, 500)) },
    { name: "network", reply: () => Promise.reject(new Error("private")) },
    { name: "malformed JSON", reply: () => Promise.resolve(new Response("private")) },
    ...[null, [], {}, { links: {} }].map((body, index) => ({ name: `invalid envelope ${index}`, reply: () => Promise.resolve(json(body)) })),
    ...invalidRows.map(([name, row]) => ({ name: `bad row ${name}`, reply: () => Promise.resolve(json({ links: [WALLETS[0], row] })) })),
  ];
  it.each(failedReads)("T4: $name fails closed with K1 and no rows or K2", async ({ reply }) => {
    authorizedFetch.mockImplementationOnce(reply);
    await renderPage();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(K1);
    expect(rows()).toHaveLength(0);
    expect(container.textContent).not.toContain(WALLETS[0]!.label);
    expect(container.textContent).not.toContain(K2);
    expect(buttons("Sign out")).toHaveLength(0);
  });

  it.each([
    { status: 401, message: "Your sign-in is no longer valid; sign in again." },
    { status: 403, message: "PCC refused this with your current sign-in." },
  ])("T4: load $status offers its sign-in message and Sign out", async ({ status, message }) => {
    const signOut = vi.fn(async () => {});
    useAuthStore.setState({ signOutWallet: signOut });
    authorizedFetch.mockResolvedValueOnce(json({ error: "unauthorized" }, status));
    await renderPage();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(rows()).toHaveLength(0);
    expect(container.textContent).not.toContain(K2);
    await click("Sign out");
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith();
  });

  it("T5: GET uses the wallet API with no cookies and no cache", async () => {
    const pending = deferred<Response>();
    authorizedFetch.mockReturnValueOnce(pending.promise);
    await renderPage();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading your wallets…");
    expect(authorizedFetch).toHaveBeenCalledTimes(1);
    expect(authorizedFetch).toHaveBeenCalledWith("/api/wallets", { method: "GET", credentials: "omit", cache: "no-store" });
    await act(async () => pending.resolve(json({ links: [] })));
    expect(container.textContent).not.toContain("Loading your wallets…");
  });

  it("T6: only active rows can open K6 and Keep linked closes it without a POST", async () => {
    await renderPage();
    expect(rows().map((row) => buttons("Unlink", row).length)).toEqual([1, 1, 0, 0]);
    await click("Unlink", rows()[0]);
    expect(rows()[0]!.textContent).toContain(`Unlink ${WALLETS[0]!.label}? Unlinking doesn't move funds. To link this wallet again, start a new link from its terminal.`);
    await click("Keep linked");
    expect(buttons("Keep linked")).toHaveLength(0);
    expect(container.textContent).not.toContain("Unlinking doesn't move funds.");
    expect(posts()).toHaveLength(0);
    expect(gets()).toHaveLength(1);
  });

  it("T7: confirmed unlink encodes the ID, sends {}, shows K5 and reloads server status", async () => {
    await startUnlink();
    const refreshed = deferred<Response>();
    authorizedFetch.mockResolvedValueOnce(json({ status: "revoked", revokedAt: REVOKED_AT })).mockReturnValueOnce(refreshed.promise);
    await click("Unlink", rows()[0]);
    expect(posts()).toEqual([[`/api/wallets/${encodeURIComponent(WALLETS[0]!.linkId)}/revoke`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "omit", cache: "no-store",
    }]]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(`Unlinked ${WALLETS[0]!.label}.`);
    expect(gets()).toHaveLength(2);
    expect(rows()).toHaveLength(0);
    await act(async () => refreshed.resolve(json({ links: [{ ...WALLETS[0], status: "revoked", revokedAt: REVOKED_AT }] })));
    expect(rows()[0]!.textContent).toContain("Unlinked");
    expect(rows()[0]!.textContent).toContain(`Unlinked at ${REVOKED_AT}`);
    expect(buttons("Unlink")).toHaveLength(0);
  });

  const unknownUnlinks = [
    { name: "500", reply: () => Promise.resolve(json({ error: "private" }, 500)) },
    { name: "network", reply: () => Promise.reject(new Error("private")) },
    { name: "wrong body", reply: () => Promise.resolve(json({ status: "active", revokedAt: REVOKED_AT })) },
    { name: "empty revokedAt", reply: () => Promise.resolve(json({ status: "revoked", revokedAt: "" })) },
    { name: "missing revokedAt", reply: () => Promise.resolve(json({ status: "revoked" })) },
    { name: "malformed JSON", reply: () => Promise.resolve(new Response("private")) },
  ];
  it.each(unknownUnlinks)("T8: $name shows K3, never K5, and reloads", async ({ reply }) => {
    await startUnlink();
    authorizedFetch.mockImplementationOnce(reply);
    await click("Unlink", rows()[0]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(K3);
    expect(container.textContent).not.toContain(`Unlinked ${WALLETS[0]!.label}.`);
    expect(gets()).toHaveLength(2);
    expect(buttons("Keep linked")).toHaveLength(0);
  });

  it.each([
    { status: 404, message: K4a, signOut: false },
    { status: 400, message: K4b, signOut: false },
    { status: 403, message: "PCC refused this with your current sign-in.", signOut: true },
    { status: 401, message: "Your sign-in is no longer valid; sign in again.", signOut: true },
  ])("T9: unlink $status shows the approved message and reloads", async ({ status, message, signOut }) => {
    const signOutWallet = vi.fn(async () => {});
    useAuthStore.setState({ signOutWallet });
    await startUnlink();
    authorizedFetch.mockResolvedValueOnce(json({ error: "private" }, status));
    await click("Unlink", rows()[0]);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(container.textContent).not.toContain(`Unlinked ${WALLETS[0]!.label}.`);
    expect(buttons("Sign out")).toHaveLength(signOut ? 1 : 0);
    if (signOut) {
      await click("Sign out");
      expect(signOutWallet).toHaveBeenCalledTimes(1);
      expect(signOutWallet).toHaveBeenCalledWith();
    }
    expect(gets()).toHaveLength(2);
  });

  it("T10: a double click sends one POST and disables every Unlink while busy", async () => {
    await startUnlink();
    const pending = deferred<Response>();
    authorizedFetch.mockReturnValue(pending.promise);
    const confirmButton = button("Unlink", rows()[0]);
    await act(async () => { confirmButton.click(); confirmButton.click(); });
    expect(posts()).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Unlinking…");
    expect(buttons("Unlink").every((element) => element.disabled)).toBe(true);
    await act(async () => pending.resolve(json({ status: "revoked", revokedAt: REVOKED_AT })));
  });

  it.each(["keyEpoch", "address", "sessionToken"] as const)("T11a: a %s change clears confirm, shows K8 and reloads with the new identity", async (field) => {
    await startUnlink();
    const refreshed = deferred<Response>();
    const observed: unknown[] = [];
    authorizedFetch.mockImplementationOnce(() => { observed.push(useAuthStore.getState()[field]); return refreshed.promise; });
    await act(async () => {
      if (field === "keyEpoch") changedIdentity();
      else useAuthStore.setState({ [field]: "new-identity" });
    });
    expect(observed).toEqual([useAuthStore.getState()[field]]);
    expect(gets()).toHaveLength(2);
    expect(posts()).toHaveLength(0);
    expect(buttons("Keep linked")).toHaveLength(0);
    expect(rows()).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(K8);
    await act(async () => refreshed.resolve(json({ links: [{ ...WALLETS[0], label: "New sign-in wallet" }] })));
    expect(rows().map((row) => row.querySelector("h2")?.textContent)).toEqual(["New sign-in wallet"]);
    expect(buttons("Keep linked")).toHaveLength(0);
    expect(posts()).toHaveLength(0);
  });

  it.each(["success", "failure"])("T11b: a stale GET %s after an identity change renders no rows or messages", async (outcome) => {
    const old = deferred<Response>();
    authorizedFetch.mockReturnValueOnce(old.promise);
    await renderPage();
    authorizedFetch.mockResolvedValueOnce(json({ links: [{ ...WALLETS[1], label: "Current wallet" }] }));
    await act(async () => changedIdentity());
    expect(gets()).toHaveLength(2);
    await act(async () => {
      if (outcome === "success") old.resolve(json({ links: [{ ...WALLETS[0], label: "Stale wallet" }] }));
      else old.reject(new Error("old request"));
    });
    expect(rows().map((row) => row.querySelector("h2")?.textContent)).toEqual(["Current wallet"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain(K1);
    expect(container.textContent).not.toContain(K8);
  });

  it("T12: labels and keys render as React text with no img elements", async () => {
    const label = "<img src=x onerror=alert(1)>";
    authorizedFetch.mockResolvedValueOnce(json({ links: [{ ...WALLETS[0], label, address: label }, { ...WALLETS[3], publicKey: label }] }));
    await renderPage();
    expect(rows()[0]!.querySelector("h2")?.textContent).toBe(label);
    expect(rows()[0]!.querySelectorAll("p")[1]!.textContent).toBe(label);
    expect(rows()[1]!.querySelectorAll("p")[1]!.textContent).toBe(label);
    await click("Unlink", rows()[0]);
    expect(container.textContent).toContain(`Unlink ${label}?`);
    expect(container.querySelector("img")).toBeNull();
  });

  it.each([200, 404])("T14: identity changes during an unlink ending in %s show only K3 and reload under the new identity", async (status) => {
    await startUnlink();
    const pending = deferred<Response>();
    const newIdentityReads: number[] = [];
    authorizedFetch.mockReturnValueOnce(pending.promise);
    await click("Unlink", rows()[0]);
    authorizedFetch.mockImplementation(() => {
      newIdentityReads.push(useAuthStore.getState().keyEpoch);
      return Promise.resolve(json({ links: [{ ...WALLETS[1], label: "New owner wallet" }] }));
    });
    await act(async () => changedIdentity());
    expect(container.textContent).not.toContain(K8);
    expect(gets()).toHaveLength(2);
    expect(buttons("Unlink").every((element) => element.disabled)).toBe(true);
    await act(async () => pending.resolve(json(status === 200 ? { status: "revoked", revokedAt: REVOKED_AT } : { error: "not_found" }, status)));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(K3);
    expect(container.textContent).not.toContain(`Unlinked ${WALLETS[0]!.label}.`);
    expect(container.textContent).not.toContain(K8);
    expect(container.textContent).not.toContain(K4a);
    expect(container.textContent).not.toContain(K4b);
    expect(gets()).toHaveLength(3);
    expect(newIdentityReads).toEqual([useAuthStore.getState().keyEpoch, useAuthStore.getState().keyEpoch]);
    expect(rows()[0]!.querySelector("h2")?.textContent).toBe("New owner wallet");
  });

  it("T15: a late identity-change read never overwrites the read that follows an in-flight unlink", async () => {
    await startUnlink();
    const post = deferred<Response>();
    authorizedFetch.mockReturnValueOnce(post.promise);
    await click("Unlink", rows()[0]);
    const identityRead = deferred<Response>();
    authorizedFetch.mockReturnValueOnce(identityRead.promise);
    await act(async () => changedIdentity());
    expect(gets()).toHaveLength(2);
    authorizedFetch.mockResolvedValueOnce(json({ links: [{ ...WALLETS[0], status: "revoked", revokedAt: REVOKED_AT }] }));
    await act(async () => post.resolve(json({ status: "revoked", revokedAt: REVOKED_AT })));
    expect(gets()).toHaveLength(3);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(K3);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain(`Unlinked at ${REVOKED_AT}`);
    await act(async () => identityRead.resolve(json({ links: [WALLETS[0]] })));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.textContent).toContain(`Unlinked at ${REVOKED_AT}`);
    expect(buttons("Unlink")).toHaveLength(0);
  });

  it.each([
    { name: "K5", reply: () => Promise.resolve(json({ status: "revoked", revokedAt: REVOKED_AT })), text: `Unlinked ${WALLETS[0]!.label}.` },
    { name: "K4a", reply: () => Promise.resolve(json({ error: "not_found" }, 404)), text: K4a },
    { name: "K4b", reply: () => Promise.resolve(json({ error: "invalid_request" }, 400)), text: K4b },
  ])("T16: a settled $name does not stay beside the next sign-in's list", async ({ reply, text }) => {
    await startUnlink();
    authorizedFetch.mockImplementationOnce(reply);
    await click("Unlink", rows()[0]);
    expect(container.textContent).toContain(text);
    authorizedFetch.mockResolvedValueOnce(json({ links: [{ ...WALLETS[1], label: "New sign-in wallet" }] }));
    await act(async () => changedIdentity());
    expect(container.textContent).not.toContain(text);
    expect(container.textContent).not.toContain(K8);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(rows().map((row) => row.querySelector("h2")?.textContent)).toEqual(["New sign-in wallet"]);
  });

  it("T17: an Unlink click that lands before the re-render after a sign-in change sends nothing and shows K8", async () => {
    await startUnlink();
    const confirmButton = button("Unlink", rows()[0]);
    authorizedFetch.mockReturnValueOnce(deferred<Response>().promise);
    await act(async () => { changedIdentity(); confirmButton.click(); });
    expect(posts()).toHaveLength(0);
    expect(gets()).toHaveLength(3);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(K8);
    expect(buttons("Keep linked")).toHaveLength(0);
  });

  it("T18: an unlink that settles after the page unmounts sends no further request", async () => {
    await startUnlink();
    const post = deferred<Response>();
    authorizedFetch.mockReturnValueOnce(post.promise);
    await click("Unlink", rows()[0]);
    await act(async () => {
      window.history.pushState({}, "", "/link");
      window.dispatchEvent(new PopStateEvent("popstate"));
      await import("../pages/WalletLinkPage.js");
    });
    await vi.waitFor(async () => {
      await act(async () => {});
      expect(container.querySelector("h1")?.textContent).toBe("Link a wallet to your PCC account");
    });
    const calls = authorizedFetch.mock.calls.length;
    await act(async () => post.resolve(json({ status: "revoked", revokedAt: REVOKED_AT })));
    expect(authorizedFetch.mock.calls.length).toBe(calls);
  });

  it("returns only validated list fields", async () => {
    authorizedFetch.mockResolvedValueOnce(json({ links: [{ ...WALLETS[0], balance: "private", publicKey: "irrelevant", ownerId: "private" }] }));
    expect(await listWallets()).toEqual([WALLETS[0]]);
  });
});
