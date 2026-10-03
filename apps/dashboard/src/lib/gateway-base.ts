/**
 * The one gateway this dashboard talks to, and the one place an API key is
 * put on a request.
 *
 * N50: /setup sent the signed-in user's key to a hard-coded
 * http://localhost:3200. The reviews of the fix (sol #2857, astra round 2)
 * asked for a boundary that doesn't depend on scanning requests. It is
 * structural:
 *
 * 1. There is ONE gateway origin, and it is validated.
 *    - If VITE_PCC_URL is set, it must be an absolute https: URL, or http: on
 *      a loopback host in a dev build.
 *    - Otherwise the gateway is the page's own origin, which must itself be
 *      https:, or http: on a loopback host. On loopback the key goes back to
 *      the server that served this page and never crosses a network.
 *    - Anything else fails closed: no request carries a key, and the reason
 *      is logged once.
 * 2. fetchWithKey() is the only code that puts a key on a request. It
 *    resolves the final URL, refuses any other origin, refuses redirects, and
 *    only then sets Authorization.
 * 3. No other code can read the signed-in key.
 *    - lib/authorized-fetch.ts holds it in a module-private variable, and no
 *      export anywhere returns it (astra round 3: an exported reader could be
 *      reached by computed access).
 *    - It leaves that module only through fetchWithKey and this guard.
 *    - __tests__/no-direct-auth-headers enforces the rest over every
 *      production module: nothing else touches its storage slot or reaches
 *      storage by a computed name, and nothing but this module builds an
 *      Authorization header or a "Bearer " string, or calls sendBeacon,
 *      XMLHttpRequest or WebSocket.
 * 4. The egress guard (installKeyEgressGuard) is defence in depth, not the
 *    boundary.
 *    - It covers fetch and navigator.sendBeacon to any origin but the
 *      gateway, and inspects the URL, the headers, and a string,
 *      URLSearchParams, FormData, Blob, binary or Request body, each raw,
 *      percent-decoded and base64-encoded.
 *    - It rejects a request that carries a key, and one whose body it can't
 *      read (a stream, or a type it doesn't recognise, such as a Blob from
 *      another realm). A beacon must be answered synchronously, so a Blob or
 *      file in a beacon counts as unreadable; the one exception is an origin
 *      the app registers for such beacons (its telemetry host, whose SDK
 *      sends Blob beacons on unload).
 *    - It can't see a key transformed further (compressed or encrypted),
 *      which is why 1-3 are the boundary.
 *    - XMLHttpRequest doesn't pass through it. The dashboard's own code
 *      doesn't use it; the ratchet enforces that.
 *
 * This module does not import the auth store, so the store can use it.
 */

export type GatewayOriginResult = { ok: true; origin: string } | { ok: false; error: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The page's own origin as the gateway: https:, or http: back to this page's own server on loopback. */
function checkPageOrigin(page: string): GatewayOriginResult {
  let url: URL;
  try {
    url = new URL(page);
  } catch {
    return { ok: false, error: `the page origin is not a URL: "${page}"` };
  }
  if (url.protocol === "https:") return { ok: true, origin: url.origin };
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return { ok: true, origin: url.origin };
  return {
    ok: false,
    error: `this dashboard is served over ${url.protocol.replace(/:$/, "")} from ${url.host}; an API key is sent only over https (or to this page's own server on localhost)`,
  };
}

/** Resolve and validate the gateway origin. Pure, so every case can be tested. */
export function resolveGatewayOrigin(
  configured: string | undefined,
  pageOrigin: string,
  isProdBuild: boolean,
): GatewayOriginResult {
  const raw = (configured ?? "").trim();
  if (!raw) return checkPageOrigin(pageOrigin);
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

/** The validated gateway origin, or null when there is none (fail closed). */
export function gatewayOrigin(): string | null {
  // Read as import.meta.env.* so Vite substitutes the values at build time.
  const r = resolveGatewayOrigin(import.meta.env.VITE_PCC_URL as string | undefined, pageOrigin(), import.meta.env.PROD === true);
  if (r.ok) return r.origin;
  // Outside a browser (tests, tooling) there is no page to warn about.
  if (!warned && typeof window !== "undefined") {
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
  if (origin === null) return { ok: false, error: new KeyEgressRefused(target, "there is no valid gateway origin") };
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
 * redirect is refused too: it would carry the request, body included, to
 * wherever the gateway pointed. A null key sends the request without one.
 */
export async function fetchWithKey(target: string, key: string | null, init: RequestInit = {}): Promise<Response> {
  const resolved = resolveGatewayTarget(target);
  if (!resolved.ok) throw resolved.error;
  const headers = new Headers(init.headers);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(resolved.url, { ...init, headers, redirect: "error" });
}

// ---------------------------------------------------------------------------
// Egress guard (defence in depth; see rule 4 above)
// ---------------------------------------------------------------------------

/** The shape of every key the gateway issues (packages/gateway/src/auth/api-key-auth.ts). */
const PCC_KEY = /pcc_(?:live|test)_[A-Za-z0-9]{8,}/;

/** The stored key as it may appear after encoding: raw and base64 (standard and URL-safe). */
function storedKeyForms(storedKey: string | null): string[] {
  // A stored value too short to be a key would match unrelated text.
  if (!storedKey || storedKey.length < 16) return [];
  let b64: string;
  try {
    b64 = btoa(storedKey);
  } catch {
    return [storedKey];
  }
  const unpadded = b64.replace(/=+$/, "");
  return [storedKey, b64, unpadded, unpadded.replace(/\+/g, "-").replace(/\//g, "_")];
}

/** `text`, plus what a recipient could percent-decode it into. */
function decodedForms(text: string): string[] {
  const forms = [text];
  for (const t of [text, text.replace(/\+/g, " ")]) {
    try {
      const once = decodeURIComponent(t);
      forms.push(once);
      forms.push(decodeURIComponent(once));
    } catch {
      // A malformed escape: the raw text was already checked.
    }
  }
  return forms;
}

function textCarriesKey(text: string, keyForms: string[]): boolean {
  return decodedForms(text).some((t) => PCC_KEY.test(t) || keyForms.some((k) => t.includes(k)));
}

/** A Blob's text, through FileReader where Blob.text() is missing (older engines, jsdom). */
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

/** A real ArrayBuffer from any realm: the byteLength getter checks its receiver's internal slot. */
function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (!arrayBufferByteLength) return value instanceof ArrayBuffer;
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every string a request body turns into, or null when it can't be read
 * without consuming it (a stream) or isn't a type we recognise. fetch reads a
 * Blob, FormData or buffer from another realm by its contents, not String(),
 * so an unrecognised object is never guessed to be clean.
 */
async function bodyTexts(body: unknown): Promise<string[] | null> {
  if (body === undefined || body === null) return [];
  if (typeof body === "string") return [body];
  if (body instanceof URLSearchParams) return [body.toString()];
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const out: string[] = [];
    for (const [name, value] of body.entries()) {
      out.push(name);
      if (typeof value === "string") out.push(value);
      else out.push(value.name, await blobText(value));
    }
    return out;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return [await blobText(body)];
  if (ArrayBuffer.isView(body) || isArrayBuffer(body)) return [new TextDecoder().decode(body)];
  if (typeof body !== "object" && typeof body !== "function") return [String(body)];
  return null;
}

export type RequestInspection = "clean" | "carries-key" | "uninspectable";

/**
 * Whether a fetch of (input, init) would carry a PCC key, or `storedKey`, in
 * its URL, a header or its body. Exported for tests.
 */
export async function inspectRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  storedKey: string | null,
): Promise<RequestInspection> {
  const keyForms = storedKeyForms(storedKey);
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (textCarriesKey(url, keyForms)) return "carries-key";
  const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
  for (const source of [init?.headers, request?.headers]) {
    if (!source) continue;
    for (const [name, value] of new Headers(source)) {
      if (textCarriesKey(name, keyForms) || textCarriesKey(value, keyForms)) return "carries-key";
    }
  }
  let texts: string[] | null;
  if (init?.body !== undefined && init.body !== null) {
    texts = await bodyTexts(init.body);
  } else if (request && request.body !== null) {
    try {
      texts = [await request.clone().text()];
    } catch {
      texts = null;
    }
  } else {
    texts = [];
  }
  if (texts === null) return "uninspectable";
  return texts.some((t) => textCarriesKey(t, keyForms)) ? "carries-key" : "clean";
}

/** The texts a beacon body turns into right now, or null when that needs an async read (a Blob or a file) or the type is unknown. */
function beaconTexts(data: unknown): string[] | null {
  if (data === undefined || data === null) return [];
  if (typeof data === "string") return [data];
  if (data instanceof URLSearchParams) return [data.toString()];
  if (typeof FormData !== "undefined" && data instanceof FormData) {
    const out: string[] = [];
    for (const [name, value] of data.entries()) {
      if (typeof value !== "string") return null;
      out.push(name, value);
    }
    return out;
  }
  if (ArrayBuffer.isView(data) || isArrayBuffer(data)) return [new TextDecoder().decode(data)];
  return null;
}

/** Whether a sendBeacon of (url, data) would carry a PCC key, or `storedKey`. Synchronous, as sendBeacon is. */
export function inspectBeacon(url: string, data: unknown, storedKey: string | null): RequestInspection {
  const keyForms = storedKeyForms(storedKey);
  if (textCarriesKey(url, keyForms)) return "carries-key";
  const texts = beaconTexts(data);
  if (texts === null) return "uninspectable";
  return texts.some((t) => textCarriesKey(t, keyForms)) ? "carries-key" : "clean";
}

export interface EgressGuardOptions {
  /**
   * Origins that may receive a beacon whose body can't be read synchronously
   * (a Blob or a file). A body that can be read is still inspected, whatever
   * the origin. Meant for the app's telemetry host only.
   */
  unreadableBeaconOrigins?: readonly string[];
}

/**
 * Wrap window.fetch and navigator.sendBeacon so a request to any origin but
 * the gateway is inspected first. It is rejected before it leaves the browser
 * if it carries a key, or if it has a body that can't be read. Requests to
 * the gateway pass untouched. `getStoredKey` supplies the signed-in key,
 * which may predate the pcc_ key format. Idempotent; returns an uninstall
 * function.
 */
export function installKeyEgressGuard(getStoredKey: () => string | null, options: EgressGuardOptions = {}): () => void {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return () => {};
  const w = window as unknown as { __pccKeyEgressGuard?: boolean };
  if (w.__pccKeyEgressGuard) return () => {};
  const original = window.fetch;
  const guarded: typeof window.fetch = async (input, init) => {
    let target: URL;
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      target = new URL(raw, window.location.href);
    } catch {
      // fetch itself rejects a URL it can't parse.
      return original.call(window, input, init);
    }
    const origin = gatewayOrigin();
    if (origin !== null && target.origin === origin) return original.call(window, input, init);
    let verdict: RequestInspection;
    try {
      verdict = await inspectRequest(input, init, getStoredKey());
    } catch {
      verdict = "uninspectable";
    }
    if (verdict === "clean") return original.call(window, input, init);
    const reason =
      verdict === "uninspectable"
        ? "its body can't be checked for a key"
        : origin === null
          ? "there is no valid gateway origin"
          : `it is not the gateway (${origin})`;
    const refusal = new KeyEgressRefused(target.href, reason);
    console.error(`[pcc] ${refusal.message}`);
    throw refusal;
  };
  window.fetch = guarded;

  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const originalBeacon = nav && typeof nav.sendBeacon === "function" ? nav.sendBeacon : undefined;
  const unreadableOk = new Set(options.unreadableBeaconOrigins ?? []);
  let guardedBeacon: Navigator["sendBeacon"] | undefined;
  if (nav && originalBeacon) {
    guardedBeacon = (url, data) => {
      let target: URL;
      try {
        target = new URL(String(url), window.location.href);
      } catch {
        // sendBeacon itself throws on a URL it can't parse.
        return originalBeacon.call(nav, url, data);
      }
      const origin = gatewayOrigin();
      if (origin !== null && target.origin === origin) return originalBeacon.call(nav, url, data);
      const verdict = inspectBeacon(target.href, data, getStoredKey());
      if (verdict === "clean" || (verdict === "uninspectable" && unreadableOk.has(target.origin))) {
        return originalBeacon.call(nav, url, data);
      }
      const reason =
        verdict === "uninspectable"
          ? "its body can't be checked for a key"
          : origin === null
            ? "there is no valid gateway origin"
            : `it is not the gateway (${origin})`;
      console.error(`[pcc] ${new KeyEgressRefused(target.href, reason).message}`);
      return false;
    };
    nav.sendBeacon = guardedBeacon;
  }

  w.__pccKeyEgressGuard = true;
  return () => {
    if (window.fetch === guarded) window.fetch = original;
    if (nav && guardedBeacon && nav.sendBeacon === guardedBeacon) nav.sendBeacon = originalBeacon!;
    w.__pccKeyEgressGuard = false;
  };
}
