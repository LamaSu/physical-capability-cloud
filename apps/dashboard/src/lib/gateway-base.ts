/**
 * The one gateway this dashboard talks to: the only origin that may receive
 * an API key.
 *
 * N50: /setup sent the signed-in user's key to a hard-coded
 * http://localhost:3200. The cross-family review of that fix (sol, #2857)
 * found the deeper weakness: the key was attached regardless of where a
 * request went. Relative /api calls went to the dashboard's origin,
 * VITE_PCC_URL calls went to another, and VITE_PCC_URL was never validated.
 * The rules:
 *
 * 1. There is ONE gateway origin. It is VITE_PCC_URL when set and valid: an
 *    absolute https: URL, or http: on a loopback host in a dev build.
 *    Otherwise it is the page's own origin (in production the gateway serves
 *    the dashboard). A VITE_PCC_URL that fails validation is a
 *    misconfiguration: no request gets a key (fail closed), and the reason is
 *    logged once.
 * 2. fetchWithKey() is the one place a key goes onto a request. It resolves
 *    the final URL, refuses any origin but the gateway's, and only then adds
 *    the Authorization header. Signed-in calls use authorizedFetch()
 *    (lib/authorized-fetch.ts), which passes it the stored key.
 * 3. The egress guard (installed at startup) backs up call sites that still
 *    build headers themselves. It rejects any fetch that carries a PCC key to
 *    another origin before the request leaves the browser.
 *
 * This module does not import the auth store, so the store can use it.
 */

export type GatewayOriginResult = { ok: true; origin: string } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Resolve and validate the gateway origin. Pure, so every case can be tested. */
export function resolveGatewayOrigin(
  configured: string | undefined,
  pageOrigin: string,
  isProdBuild: boolean,
): GatewayOriginResult {
  const raw = (configured ?? "").trim();
  if (!raw) return { ok: true, origin: pageOrigin };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `VITE_PCC_URL is not an absolute URL: "${raw}"` };
  }
  if (url.username || url.password) return { ok: false, error: "VITE_PCC_URL must not carry credentials" };
  if (url.protocol === "https:") return { ok: true, origin: url.origin };
  if (url.protocol === "http:" && !isProdBuild && LOOPBACK.has(url.hostname)) return { ok: true, origin: url.origin };
  return {
    ok: false,
    error: `VITE_PCC_URL must be an https: origin${isProdBuild ? "" : " (or http: on localhost in a dev build)"}: "${raw}"`,
  };
}

/** Outside a browser there is no page; ".invalid" can never resolve (RFC 2606). */
const NO_PAGE = "http://page.invalid";

function pageOrigin(): string {
  return typeof window !== "undefined" ? window.location.origin : NO_PAGE;
}

let warned = false;

/** The validated gateway origin, or null when VITE_PCC_URL is misconfigured (fail closed). */
export function gatewayOrigin(): string | null {
  // Read as import.meta.env.* so Vite substitutes the values at build time.
  const r = resolveGatewayOrigin(import.meta.env.VITE_PCC_URL as string | undefined, pageOrigin(), import.meta.env.PROD === true);
  if (r.ok) return r.origin;
  if (!warned) {
    warned = true;
    console.error(`[pcc] ${r.error}. No request will carry an API key until this is fixed.`);
  }
  return null;
}

/**
 * The base for building gateway URLs for requests that carry no key: "" (so
 * URLs stay relative) when the gateway is the page's own origin, otherwise
 * the validated origin.
 */
export const GATEWAY_BASE: string = (() => {
  const origin = gatewayOrigin();
  return origin === null || origin === pageOrigin() ? "" : origin;
})();

/** A URL on the configured gateway, for requests that carry no key. */
export function gatewayUrl(path: string): string {
  return `${GATEWAY_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Origin and path only: a refused URL's query string may itself hold a key. */
function describeTarget(raw: string): string {
  try {
    const url = new URL(raw, typeof window !== "undefined" ? window.location.href : `${NO_PAGE}/`);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "an unreadable URL";
  }
}

/** Thrown, or rejected, instead of sending a key anywhere but the gateway. */
export class KeyEgressRefused extends Error {
  constructor(target: string, reason: string) {
    super(`Refused to send the API key to ${describeTarget(target)}: ${reason}`);
    this.name = "KeyEgressRefused";
  }
}

/**
 * Where a request for `target` would go, if that is the gateway. `target` is
 * resolved the way fetch resolves it against the gateway: "/api/x", "api/x",
 * or an absolute URL. A protocol-relative "//host/x" names another host.
 * Same-origin targets stay relative, as they were before this module existed.
 */
export function resolveGatewayTarget(target: string): { ok: true; url: string } | { ok: false; error: KeyEgressRefused } {
  const origin = gatewayOrigin();
  if (origin === null) return { ok: false, error: new KeyEgressRefused(target, "the gateway origin is misconfigured") };
  let url: URL;
  try {
    url = new URL(target, `${origin}/`);
  } catch {
    return { ok: false, error: new KeyEgressRefused(target, "it is not a URL") };
  }
  if (url.origin !== origin) return { ok: false, error: new KeyEgressRefused(url.href, `it is not the gateway (${origin})`) };
  // A same-origin path is passed on relative, unless it starts with "//":
  // fetch would read that as another host.
  const relative = origin === pageOrigin() && !url.pathname.startsWith("//");
  return { ok: true, url: relative ? `${url.pathname}${url.search}${url.hash}` : url.href };
}

/**
 * fetch() carrying `key`, only toward the gateway. A target that does not
 * resolve to the gateway origin is refused before any request is made. A
 * null key sends the request without one.
 */
export async function fetchWithKey(target: string, key: string | null, init: RequestInit = {}): Promise<Response> {
  const resolved = resolveGatewayTarget(target);
  if (!resolved.ok) throw resolved.error;
  const headers = new Headers(init.headers);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(resolved.url, { ...init, headers });
}

// ---------------------------------------------------------------------------
// Egress guard
// ---------------------------------------------------------------------------

/** The shape of every key the gateway issues (packages/gateway/src/auth/api-key-auth.ts). */
const PCC_KEY = /pcc_(?:live|test)_[A-Za-z0-9]{8,}/;

function carriesKey(text: string, storedKey: string | null): boolean {
  // A stored value too short to be a key would match unrelated text.
  return PCC_KEY.test(text) || (!!storedKey && storedKey.length >= 16 && text.includes(storedKey));
}

/**
 * True if a fetch of (input, init) would carry a PCC key, or `storedKey`, in
 * a header, the URL or a string body. Exported for tests.
 */
export function requestCarriesKey(input: RequestInfo | URL, init: RequestInit | undefined, storedKey: string | null): boolean {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (carriesKey(url, storedKey)) return true;
  const sources = [init?.headers, typeof input === "object" && "headers" in input ? input.headers : undefined];
  for (const source of sources) {
    if (!source) continue;
    for (const [, value] of new Headers(source)) if (carriesKey(value, storedKey)) return true;
  }
  return typeof init?.body === "string" && carriesKey(init.body, storedKey);
}

/**
 * Wrap window.fetch so a request that carries a PCC key to any origin but
 * the gateway is rejected before it leaves the browser. Other requests,
 * including every request without a key, pass through untouched.
 * `getStoredKey` supplies the signed-in key, which may predate the pcc_ key
 * format. Idempotent; returns an uninstall function.
 */
export function installKeyEgressGuard(getStoredKey: () => string | null): () => void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return () => {};
  const w = window as unknown as { __pccKeyEgressGuard?: boolean };
  if (w.__pccKeyEgressGuard) return () => {};
  const original = window.fetch;
  const guarded: typeof window.fetch = (input, init) => {
    let refusal: KeyEgressRefused | null = null;
    try {
      if (requestCarriesKey(input, init, getStoredKey())) {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const target = new URL(raw, window.location.href);
        const origin = gatewayOrigin();
        if (origin === null) refusal = new KeyEgressRefused(target.href, "the gateway origin is misconfigured");
        else if (target.origin !== origin) refusal = new KeyEgressRefused(target.href, `it is not the gateway (${origin})`);
      }
    } catch {
      refusal = new KeyEgressRefused(String(input), "the request could not be checked");
    }
    if (refusal) {
      console.error(`[pcc] ${refusal.message}`);
      return Promise.reject(refusal);
    }
    return original.call(window, input, init);
  };
  window.fetch = guarded;
  w.__pccKeyEgressGuard = true;
  return () => {
    if (window.fetch === guarded) window.fetch = original;
    w.__pccKeyEgressGuard = false;
  };
}
