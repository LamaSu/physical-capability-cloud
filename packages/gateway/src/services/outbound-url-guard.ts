/**
 * Outbound URL guard — SSRF protection for requests the gateway makes to a URL
 * a caller supplied (N84; today the only such site is the operator-channel
 * webhook send in routes/operator-channels.ts).
 *
 * Three layers, each independently tested:
 *
 *  1. checkOutboundUrl(): the syntactic check, run at attach time AND again at
 *     send time. WHATWG URL parse first (so decimal/octal/hex IPv4 spellings,
 *     percent-encoded dots and bracketed IPv6 are normalised before anything
 *     looks at the host), then: https only (http only when NODE_ENV is exactly
 *     "test" or "development"), no userinfo, no IP literal in a blocked range,
 *     no obviously internal host name.
 *
 *  2. guardedFetch(): at send time it resolves the host ONCE, vetoes the send
 *     if ANY answer is in a blocked range, and then dials only the validated
 *     addresses (pinned). A second resolution at connect time would reopen the
 *     DNS-rebinding window, so none ever happens.
 *
 *  3. createPinnedLookup(): the connect-time hook handed to the socket layer.
 *     It can only ever return the pinned addresses and re-validates every one
 *     of them, so a defect in layer 2 still cannot make the dialer connect to
 *     a blocked address.
 *
 * Redirects are never followed: any 3xx is a failure. By default responses are
 * never returned to the caller (only status and headers) and are read only up
 * to a byte cap. A caller that must read a verdict out of the body (the
 * source-verify check) or relay a proxied result (aggregator invoke) opts in
 * with `captureBody`: the first `maxResponseBytes` bytes come back to GATEWAY
 * CODE, and it is that code's job never to forward them to whoever supplied the
 * URL. The whole exchange, name resolution included, has a deadline.
 *
 * Transport: Node core http/https, not undici. `undici` is not a dependency of
 * this package and adding one is out of scope; the property that matters (the
 * socket can only dial addresses this module validated) is the same. Every
 * request uses `agent: false`, so no pooled socket outlives its validation.
 * TLS certificate verification is Node's default and must never be relaxed.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// ── address predicate ────────────────────────────────────────────────────────

/**
 * IPv4 ranges the gateway must never send to. One entry per range so each can be
 * tested alone; ranges that touch (224/4 and 240/4) are one entry, so no entry can
 * be widened into its neighbour without changing what is blocked.
 */
const V4_BLOCKED: ReadonlyArray<readonly [cidr: string, why: string]> = [
  ["0.0.0.0/8", "this-network / unspecified"],
  ["10.0.0.0/8", "RFC1918 private"],
  ["100.64.0.0/10", "CGNAT shared space (includes Alibaba metadata 100.100.100.200)"],
  ["127.0.0.0/8", "loopback"],
  ["168.63.129.16/32", "Azure platform address"],
  ["169.254.0.0/16", "link-local (cloud metadata 169.254.169.254)"],
  ["172.16.0.0/12", "RFC1918 private"],
  ["192.0.0.0/24", "IETF protocol assignments"],
  ["192.0.2.0/24", "TEST-NET-1"],
  ["192.88.99.0/24", "6to4 relay anycast (deprecated)"],
  ["192.168.0.0/16", "RFC1918 private"],
  ["198.18.0.0/15", "benchmarking"],
  ["198.51.100.0/24", "TEST-NET-2"],
  ["203.0.113.0/24", "TEST-NET-3"],
  ["224.0.0.0/3", "multicast 224.0.0.0/4 and reserved 240.0.0.0/4, which includes limited broadcast 255.255.255.255"],
];

/**
 * IPv6 ranges blocked outright. IPv4-mapped (::ffff:0:0/96), IPv4-translated
 * (::ffff:0:0:0/96) and NAT64 (64:ff9b::/96) sit inside ::/8 but embed an IPv4
 * address, so v6Blocked() decides them by that address BEFORE this table is
 * consulted; everything else in ::/8 is reserved and blocked here.
 */
const V6_BLOCKED: ReadonlyArray<readonly [cidr: string, why: string]> = [
  ["::/8", "reserved by IETF: unspecified, loopback, IPv4-compatible, local-use NAT64 64:ff9b:1::/48 and the rest of ::/8"],
  ["100::/64", "discard-only (RFC 6666)"],
  ["2001::/23", "IETF protocol assignments (Teredo, ORCHID, benchmarking)"],
  ["2001:db8::/32", "documentation"],
  ["2002::/16", "6to4 (embeds an IPv4 address)"],
  ["3fff::/20", "documentation (RFC 9637)"],
  ["fc00::/7", "unique local addresses (includes AWS IMDS fd00:ec2::254)"],
  ["fe80::/9", "link-local fe80::/10 and site-local fec0::/10 (deprecated)"],
  ["ff00::/8", "multicast"],
];

/** Strict dotted-quad parse. Leading zeros are refused (octal in some stacks): fail closed. */
function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith("0")) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** Strict IPv6 parse to eight 16-bit groups. No brackets, no zone id, no whitespace. */
function parseIPv6(input: string): number[] | null {
  let s = input;
  let tail: [number, number] | null = null;
  if (s.includes(".")) {
    // embedded IPv4 in the last 32 bits
    const cut = s.lastIndexOf(":");
    const v4 = parseIPv4(s.slice(cut + 1));
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536), v4 % 65536];
    s = s.slice(0, cut + 1) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = groupsOf(halves[0]!);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const rest = groupsOf(halves[1]!);
    if (rest === null) return null;
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null; // "::" stands for at least one group
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  if (tail) {
    groups[6] = tail[0];
    groups[7] = tail[1];
  }
  return groups;
}

interface V4Range {
  base: number;
  mask: number;
}
interface V6Range {
  groups: number[];
  bits: number;
}

function compileV4(table: ReadonlyArray<readonly [string, string]>): V4Range[] {
  return table.map(([cidr]) => {
    const [addr, bits] = cidr.split("/") as [string, string];
    const n = parseIPv4(addr);
    if (n === null) throw new Error(`bad IPv4 range ${cidr}`);
    const len = Number(bits);
    return { base: n, mask: len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0 };
  });
}

function compileV6(table: ReadonlyArray<readonly [string, string]>): V6Range[] {
  return table.map(([cidr]) => {
    const [addr, bits] = cidr.split("/") as [string, string];
    const groups = parseIPv6(addr);
    if (groups === null) throw new Error(`bad IPv6 range ${cidr}`);
    return { groups, bits: Number(bits) };
  });
}

const V4_RANGES = compileV4(V4_BLOCKED);
const V6_RANGES = compileV6(V6_BLOCKED);

function v4Blocked(n: number): boolean {
  for (const r of V4_RANGES) {
    if ((((n ^ r.base) & r.mask) >>> 0) === 0) return true;
  }
  return false;
}

function inV6Range(g: ReadonlyArray<number>, r: V6Range): boolean {
  for (let i = 0; i < 8; i++) {
    const bits = Math.min(16, Math.max(0, r.bits - 16 * i));
    if (bits === 0) break;
    const mask = bits === 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
    if (((g[i]! ^ r.groups[i]!) & mask) !== 0) return false;
  }
  return true;
}

function v6Blocked(g: ReadonlyArray<number>): boolean {
  const embedded = g[6]! * 65536 + g[7]!;
  const zeroTo4 = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // IPv4-mapped ::ffff:a.b.c.d: an AF_INET6 socket really dials the IPv4 address.
  if (zeroTo4 && g[5] === 0xffff) return v4Blocked(embedded);
  // IPv4-translated ::ffff:0:a.b.c.d (SIIT, RFC 2765).
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0xffff && g[5] === 0) return v4Blocked(embedded);
  // NAT64 64:ff9b::/96 (RFC 6052): a translator forwards to the embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) return v4Blocked(embedded);
  for (const r of V6_RANGES) {
    if (inV6Range(g, r)) return true;
  }
  return false;
}

/**
 * True when the gateway must not connect to `address`. Fails closed: anything
 * that is not a canonical IPv4 or IPv6 literal (including non-strings, zone ids,
 * brackets, leading zeros, hex/octal/decimal spellings) is reported blocked.
 * Alternate IPv4 spellings in URLs are normalised by checkOutboundUrl() before
 * this is called; DNS answers are always canonical.
 */
export function isBlockedAddress(address: string): boolean {
  if (typeof address !== "string") return true;
  const v4 = parseIPv4(address);
  if (v4 !== null) return v4Blocked(v4);
  const v6 = parseIPv6(address);
  if (v6 !== null) return v6Blocked(v6);
  return true;
}

// ── URL check (attach time and send time) ────────────────────────────────────

export type OutboundUrlRefusal =
  | "invalid_url"
  | "scheme_not_allowed"
  | "userinfo_not_allowed"
  | "blocked_address"
  | "internal_hostname";

export type OutboundUrlCheck = { ok: true; url: URL } | { ok: false; reason: OutboundUrlRefusal };

const MAX_URL_LENGTH = 2048;

/**
 * Suffixes that are internal by convention or by ICANN reservation. Together with
 * the single-label rule below they cover localhost, localhost.localdomain,
 * *.localhost, metadata.google.internal and *.internal.
 */
const INTERNAL_SUFFIXES: ReadonlyArray<string> = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".lan",
  ".corp",
  ".home",
  ".private",
  ".home.arpa",
];

function isInternalHostname(name: string): boolean {
  // A single-label name resolves through the resolver's search domains, which
  // makes it internal by construction ("localhost", "redis", "metadata").
  if (!name.includes(".")) return true;
  return INTERNAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * http: is accepted only when NODE_ENV is exactly "test" or "development", so
 * local development and the test suite can use plain http fixtures. Unset or
 * mistyped values count as production (same convention as routes/lob.ts).
 * This relaxes the SCHEME only: blocked ranges and internal names are refused
 * in every environment.
 */
function httpAllowed(): boolean {
  const env = process.env.NODE_ENV;
  return env === "test" || env === "development";
}

/** Host without the brackets WHATWG URL keeps around IPv6 literals. */
function bareHost(url: URL): string {
  const h = url.hostname;
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

function refuse(reason: OutboundUrlRefusal): OutboundUrlCheck {
  return { ok: false, reason };
}

/**
 * Synchronous, DNS-free check that `raw` is an acceptable outbound destination.
 * Used when a channel is attached (so a bad URL is never stored) and again
 * immediately before a send (so a record stored before this guard existed is
 * still refused). Hostnames are NOT resolved here; guardedFetch() does that.
 */
export function checkOutboundUrl(raw: unknown): OutboundUrlCheck {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return refuse("invalid_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("invalid_url");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && httpAllowed())) return refuse("scheme_not_allowed");
  if (url.username !== "" || url.password !== "") return refuse("userinfo_not_allowed");

  // WHATWG parsing already turned any IPv4 spelling into dotted decimal (or
  // failed), so a host made of digits and dots here is a real IPv4 literal.
  const host = bareHost(url);
  if (net.isIP(host) !== 0) {
    return isBlockedAddress(host) ? refuse("blocked_address") : { ok: true, url };
  }
  const name = host.replace(/\.+$/, "");
  if (isInternalHostname(name)) return refuse("internal_hostname");
  return { ok: true, url };
}

// ── guarded fetch ────────────────────────────────────────────────────────────

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type OutboundResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface OutboundTransportRequest {
  url: URL;
  /** The validated, pinned answers for a host name; null for an IP-literal URL. */
  addresses: ReadonlyArray<ResolvedAddress> | null;
  /** Connect-time resolver for the socket layer: only ever yields `addresses`. */
  lookup: net.LookupFunction;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  /** Aborted when the overall deadline passes. */
  signal: AbortSignal;
  /** Set only when the caller opted in: also hand back the first `maxResponseBytes` bytes of the body. */
  captureBody?: boolean;
}

export interface OutboundTransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytesRead: number;
  /** True when the body was cut short (byte cap or deadline); the status is still valid. */
  truncated: boolean;
  /** Present only when the request set captureBody; never longer than maxResponseBytes. */
  body?: Buffer;
}

/** One raw HTTP exchange. Policy lives in guardedFetch(); a transport only moves bytes. */
export type OutboundTransport = (req: OutboundTransportRequest) => Promise<OutboundTransportResponse>;

export interface OutboundDeps {
  resolve: OutboundResolver;
  transport: OutboundTransport;
}

export type OutboundErrorCode =
  | "invalid_url"
  | "blocked_destination"
  | "dns_failure"
  | "redirect_not_followed"
  | "timeout"
  | "request_failed";

/** Policy or transport failure. Messages are deliberately generic: never put an address in one. */
export class OutboundError extends Error {
  readonly code: OutboundErrorCode;
  readonly reason?: string;
  readonly status?: number;
  constructor(code: OutboundErrorCode, message: string, extra?: { reason?: string; status?: number; cause?: unknown }) {
    super(message, extra?.cause === undefined ? undefined : { cause: extra.cause });
    this.name = "OutboundError";
    this.code = code;
    this.reason = extra?.reason;
    this.status = extra?.status;
  }
}

export interface GuardedFetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  /** Overall deadline, name resolution included. Default 5000 ms. */
  timeoutMs?: number;
  /** Response bytes read before the connection is dropped. Default 64 KiB. */
  maxResponseBytes?: number;
  /**
   * Opt in to receiving the (capped) response body in `GuardedFetchResponse.body`.
   * Default false: the operator-channel send needs only the status. Whoever sets
   * this owns the rule that the body is never reflected to the URL's supplier.
   */
  captureBody?: boolean;
}

export interface GuardedFetchResponse {
  status: number;
  /** 2xx. A 3xx never gets here (it throws redirect_not_followed). */
  ok: boolean;
  headers: Record<string, string | string[] | undefined>;
  truncated: boolean;
  /** Only when the caller set captureBody: at most maxResponseBytes bytes (possibly empty). */
  body?: Buffer;
}

export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;

function pinnedError(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "EOUTBOUNDBLOCKED" }) as NodeJS.ErrnoException;
}

/**
 * The connect-time lookup. Hands the socket layer ONLY the pinned addresses
 * (never a fresh DNS answer) and refuses if any of them is blocked, whatever
 * the caller already checked. Supports both calling conventions of net.connect:
 * `all: true` (array, used by autoSelectFamily) and the single-address form.
 */
export function createPinnedLookup(addresses: ReadonlyArray<ResolvedAddress> | null): net.LookupFunction {
  return (_hostname, options, callback) => {
    let opts: dns.LookupOptions = {};
    let cb = callback;
    if (typeof options === "function") {
      cb = options as unknown as typeof callback;
    } else if (options && typeof options === "object") {
      opts = options;
    }
    const fail = (message: string) => cb(pinnedError(message), opts.all ? [] : "");
    if (!addresses || addresses.length === 0) return fail("no pinned address");
    for (const a of addresses) {
      if (isBlockedAddress(a.address)) return fail("pinned address is blocked");
    }
    const family = opts.family === 4 || opts.family === "IPv4" ? 4 : opts.family === 6 || opts.family === "IPv6" ? 6 : 0;
    const usable = family === 0 ? addresses : addresses.filter((a) => a.family === family);
    if (usable.length === 0) return fail("no pinned address for the requested family");
    if (opts.all) return cb(null, usable.map((a) => ({ address: a.address, family: a.family })));
    return cb(null, usable[0]!.address, usable[0]!.family);
  };
}

const defaultResolve: OutboundResolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a): ResolvedAddress => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/**
 * Production transport: Node core http/https over a pinned lookup. It follows
 * no redirects (Node never does), reads at most `maxResponseBytes`, and stops at
 * the deadline. After the status line has arrived, a cap or deadline hit is a
 * truncated success, not a failure: the receiver did get the request.
 */
export const nodeTransport: OutboundTransport = (req) =>
  new Promise<OutboundTransportResponse>((resolve, reject) => {
    const secure = req.url.protocol === "https:";
    const payload = req.body === undefined ? undefined : Buffer.from(req.body, "utf8");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() !== "content-length" && k.toLowerCase() !== "host") headers[k] = v;
    }
    if (payload) headers["content-length"] = String(payload.length);

    let settled = false;
    let received: { status: number; headers: http.IncomingHttpHeaders } | null = null;
    let bytes = 0;
    // Body bytes kept for a captureBody caller; never more than maxResponseBytes.
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let clientReq: http.ClientRequest | undefined;

    const onAbort = () => expire();
    const timer = setTimeout(() => expire(), req.timeoutMs);
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
    };
    const succeed = (truncated: boolean) => {
      if (settled || !received) return;
      cleanup();
      resolve({
        status: received.status,
        headers: received.headers,
        bytesRead: bytes,
        truncated,
        ...(req.captureBody ? { body: Buffer.concat(kept, keptBytes) } : {}),
      });
      clientReq?.destroy();
    };
    const fail = (err: unknown) => {
      if (settled) return;
      cleanup();
      clientReq?.destroy();
      reject(err instanceof OutboundError ? err : new OutboundError("request_failed", "request failed", { cause: err }));
    };
    function expire(): void {
      if (received) succeed(true);
      else fail(new OutboundError("timeout", `request timed out after ${req.timeoutMs}ms`));
    }

    if (req.signal.aborted) return fail(new OutboundError("timeout", "request aborted"));
    req.signal.addEventListener("abort", onAbort, { once: true });

    const options: http.RequestOptions = {
      method: req.method,
      hostname: bareHost(req.url),
      port: req.url.port === "" ? (secure ? 443 : 80) : Number(req.url.port),
      path: `${req.url.pathname}${req.url.search}`,
      headers,
      agent: false,
      lookup: req.lookup,
    };
    try {
      clientReq = secure ? https.request(options) : http.request(options);
    } catch (e) {
      return fail(e);
    }
    clientReq.on("error", fail);
    clientReq.on("response", (res) => {
      received = { status: res.statusCode ?? 0, headers: res.headers };
      res.on("data", (chunk: Buffer) => {
        if (req.captureBody && keptBytes < req.maxResponseBytes) {
          const room = req.maxResponseBytes - keptBytes;
          const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
          kept.push(piece);
          keptBytes += piece.length;
        }
        bytes += chunk.length;
        if (bytes > req.maxResponseBytes) succeed(true);
      });
      res.on("end", () => succeed(false));
      // Node reports a connection cut mid-body as an error on the response. The
      // status line already arrived, so that is a truncated answer, not a failure.
      res.on("error", () => succeed(true));
    });
    if (payload) clientReq.write(payload);
    clientReq.end();
  });

let activeDeps: OutboundDeps = { resolve: defaultResolve, transport: nodeTransport };

/**
 * TEST SEAM. Swaps the resolver and/or transport used by guardedFetch() so a
 * test can prove the decision logic without real DNS or sockets; null restores
 * the production defaults. Refuses to run when NODE_ENV is "production". It is
 * not reachable from configuration, environment variables or any request.
 */
export function _setOutboundDepsForTests(deps: Partial<OutboundDeps> | null): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("_setOutboundDepsForTests is not available in production");
  }
  activeDeps = {
    resolve: deps?.resolve ?? defaultResolve,
    transport: deps?.transport ?? nodeTransport,
  };
}

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), Math.max(1, ms));
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The only way the gateway should send to a caller-supplied URL. Throws
 * OutboundError for every policy refusal and every failure to complete the
 * exchange; returns for any HTTP answer that is not a redirect, 4xx and 5xx
 * included (the status is for the operator to see). `overrides` exists for
 * direct unit tests; production callers pass nothing.
 */
export async function guardedFetch(
  rawUrl: string,
  init: GuardedFetchInit,
  overrides?: Partial<OutboundDeps>,
): Promise<GuardedFetchResponse> {
  const deps: OutboundDeps = {
    resolve: overrides?.resolve ?? activeDeps.resolve,
    transport: overrides?.transport ?? activeDeps.transport,
  };
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  const check = checkOutboundUrl(rawUrl);
  if (!check.ok) throw new OutboundError("invalid_url", "url is not an allowed destination", { reason: check.reason });
  const url = check.url;
  const host = bareHost(url);

  let pinned: ResolvedAddress[] | null = null;
  if (net.isIP(host) === 0) {
    // Resolve exactly once. Every answer must be public: one private answer
    // among public ones vetoes the send (an attacker controls the DNS answer set).
    let answers: ReadonlyArray<ResolvedAddress>;
    try {
      answers = await withDeadline(
        deps.resolve(host),
        remaining(),
        () => new OutboundError("timeout", `name resolution timed out after ${timeoutMs}ms`),
      );
    } catch (e) {
      if (e instanceof OutboundError) throw e;
      throw new OutboundError("dns_failure", "name resolution failed", { cause: e });
    }
    if (!Array.isArray(answers) || answers.length === 0) {
      throw new OutboundError("dns_failure", "name resolution returned no address");
    }
    for (const a of answers) {
      if (!a || typeof a.address !== "string" || isBlockedAddress(a.address)) {
        throw new OutboundError("blocked_destination", "destination resolves to a blocked address");
      }
    }
    pinned = answers.map((a): ResolvedAddress => ({ address: a.address, family: net.isIPv6(a.address) ? 6 : 4 }));
  }
  // An IP-literal host was already vetted by checkOutboundUrl(); Node never
  // calls lookup for a literal, so there is nothing to pin.

  const controller = new AbortController();
  let res: OutboundTransportResponse;
  try {
    res = await withDeadline(
      deps.transport({
        url,
        addresses: pinned,
        lookup: createPinnedLookup(pinned),
        method: init.method,
        headers: init.headers ?? {},
        body: init.body,
        timeoutMs: remaining(),
        maxResponseBytes,
        signal: controller.signal,
        // Only present when asked for, so a transport that predates the option sees the same request as before.
        ...(init.captureBody === true ? { captureBody: true } : {}),
      }),
      remaining(),
      () => {
        controller.abort();
        return new OutboundError("timeout", `request timed out after ${timeoutMs}ms`);
      },
    );
  } catch (e) {
    if (e instanceof OutboundError) throw e;
    throw new OutboundError("request_failed", "request failed", { cause: e });
  }

  if (!Number.isInteger(res.status) || res.status < 100 || res.status > 599) {
    throw new OutboundError("request_failed", "malformed response");
  }
  if (res.status >= 300 && res.status < 400) {
    throw new OutboundError("redirect_not_followed", `HTTP ${res.status}: redirects are never followed`, {
      status: res.status,
    });
  }
  const response: GuardedFetchResponse = {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: res.headers,
    truncated: res.truncated,
  };
  // Without the opt-in the response carries no body property at all, whatever a transport returned.
  if (init.captureBody === true) {
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0);
    response.body = body.length > maxResponseBytes ? body.subarray(0, maxResponseBytes) : body;
  }
  return response;
}
