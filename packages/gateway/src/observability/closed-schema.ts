/**
 * The closed observability schema (N107b; the PR steward's ruling of 10/03, bus #5315 and #5319,
 * DECISIONS.md; round 2 after the cross-family review r1 of #538): no request-controlled value
 * reaches any sink or console line, except as a keyed hash or a coarse class. Every sink chokepoint
 * (the PostHog boundary, the audit writer, the logger, request-path console output and Sentry)
 * rebuilds what it sends from these rules:
 *
 *   - every value leaves as its keyed hash (an HMAC under the server secret PCC_TELEMETRY_KEY, so a
 *     value cannot be recovered by guessing): strings, numbers, booleans and timestamps alike. An
 *     object key leaves as its keyed hash too, unless its field was declared;
 *   - a producer opts a field in by declaring it: declare.metric (a measurement the server made),
 *     declare.code (a member of a closed vocabulary), declare.serverTime (a time the server took),
 *     declare.id (an identifier, or any request value a field carries, which leaves hashed) and
 *     declare.flag (a condition the server decided); a message, event name or code with lit(),
 *     whose type takes only a compile-time literal. A declared field leaves as declared, under its
 *     own key. Trust comes from the producer, never from a value's spelling or its key's name: only
 *     this module makes a declared value, and nothing parsed from a request can be one;
 *   - the chokepoints declare what they build themselves: a request's method and route template, a
 *     response's status and time, an error's class and code, the request id;
 *   - the User-Agent is a coarse class: bot, browser, sdk or unknown.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { format } from "node:util";

// ── Keyed hash ─────────────────────────────────────────────────────────────

const ENV_KEY = process.env.PCC_TELEMETRY_KEY;
const KEY = ENV_KEY && ENV_KEY.length >= 32 ? Buffer.from(ENV_KEY, "utf8") : randomBytes(32);

/** True when PCC_TELEMETRY_KEY is unset or short: hashes then do not correlate across restarts. */
export const TELEMETRY_KEY_EPHEMERAL = !(ENV_KEY && ENV_KEY.length >= 32);

/** A value as every sink may carry it: an HMAC-SHA256 under the server secret, truncated. */
export function keyedHash(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return "h:" + createHmac("sha256", KEY).update(text).digest("hex").slice(0, 32);
}

/**
 * A trace or span id as Sentry may carry it: lowercase hex of the same length, keyed under the
 * server secret. One id always maps to one id, so a trace tree still links up.
 */
export function keyedHexId(id: unknown, length: 16 | 32): string | undefined {
  if (typeof id !== "string" || id === "") return undefined;
  return createHmac("sha256", KEY).update(`sentry-id:${length}:${id}`).digest("hex").slice(0, length);
}

// ── Declared fields ────────────────────────────────────────────────────────

type Emitted = string | number | boolean | null;

/** The emitted form of every declared value. Only make() adds to it, so no other object is declared. */
const DECLARED = new WeakMap<object, Emitted>();
const brand: unique symbol = Symbol("declared");

/** A field a producer declared. Opaque: made only by declare and lit, read only by the chokepoints. */
export interface Declared {
  readonly [brand]: true;
}

function make(emitted: Emitted): Declared {
  const value = Object.freeze({ toJSON: () => emitted, toString: () => String(emitted) });
  DECLARED.set(value, emitted);
  return value as unknown as Declared;
}

/** True only for a value declare or lit made (never for a parsed body, a copy or a look-alike). */
export function isDeclared(value: unknown): value is Declared {
  return typeof value === "object" && value !== null && DECLARED.has(value);
}

/** A declared value as it leaves. */
export function emitted(value: Declared): Emitted {
  return DECLARED.get(value as unknown as object) ?? null;
}

/** A string type that is a compile-time literal (or a union of them): never string, never a template with a value in it. */
export type Literal<T extends string> = {} extends Record<T, never> ? never : T;

const members = (vocabulary: ReadonlySet<string> | readonly string[]): ReadonlySet<string> =>
  vocabulary instanceof Set ? vocabulary : new Set(vocabulary as readonly string[]);

/** How a producer declares a field: the only way a value leaves a sink as anything but its keyed hash. */
export const declare = {
  /** A measurement the server made (a duration, a count it took, a status it set): the number itself. */
  metric(n: number): Declared {
    return make(typeof n === "number" && Number.isFinite(n) ? n : null);
  },
  /** A member of a closed vocabulary: itself. Any other value leaves as its keyed hash (no value: null). */
  code(value: unknown, vocabulary: ReadonlySet<string> | readonly string[]): Declared {
    if (value === undefined || value === null) return make(null);
    return make(typeof value === "string" && members(vocabulary).has(value) ? value : keyedHash(value));
  },
  /** A time the server took (a Date or epoch milliseconds; now by default): its ISO string. */
  serverTime(at: Date | number = new Date()): Declared {
    const date = at instanceof Date ? at : new Date(at);
    return make(Number.isNaN(date.getTime()) ? null : date.toISOString());
  },
  /** An identifier, or any request value a field carries: its keyed hash, under the field's own key (no value: null). */
  id(value: unknown): Declared {
    if (value === undefined || value === null) return make(null);
    return make(isDeclared(value) ? keyedHash(emitted(value)) : keyedHash(value));
  },
  /** A condition the server decided: the boolean itself. */
  flag(b: boolean): Declared {
    return make(b === true);
  },
};

/** A message, event name or code the code itself spells: its type takes only a compile-time literal. */
export function lit<T extends string>(text: Literal<T>): Declared {
  return make(text as string);
}

/** A string as a sink may carry it: a declared value as declared, anything else as its keyed hash. */
export function closedText(text: unknown): string {
  return isDeclared(text) ? String(emitted(text)) : keyedHash(text);
}

/** An identifier as a sink keeps it: its keyed hash (once, when a producer already declared it). */
export function closedId(value: unknown): string {
  return isDeclared(value) ? String(emitted(value)) : keyedHash(value);
}

// ── Coarse classes ─────────────────────────────────────────────────────────

export type UaClass = "bot" | "browser" | "sdk" | "unknown";
export const UA_CLASSES: readonly UaClass[] = ["bot", "browser", "sdk", "unknown"];

/** The User-Agent as a coarse class (the steward's four): never its text. */
export function uaClass(ua: unknown): UaClass {
  const text = typeof ua === "string" ? ua : Array.isArray(ua) ? ua.join(" ") : "";
  if (text.length < 3) return "unknown";
  if (/headless|phantomjs|slimerjs|splash|puppeteer|playwright|selenium|webdriver|cypress|nmap|nikto|sqlmap|burp|zap\b|nuclei|gobuster|dirbuster|wfuzz|ffuf|feroxbuster|masscan|shodan|censys|bot\b|crawler|spider|claude|anthropic|openai|chatgpt|gpt-|langchain|autogpt|babyagi/i.test(text)) return "bot";
  if (/python-requests|python-urllib|httpx|aiohttp|go-http-client|axios|node-fetch|undici|got\/|curl\/|wget\/|okhttp|java\/|libwww|scrapy|httpclient|pcc-node|pcc-sdk|postman/i.test(text)) return "sdk";
  if (/mozilla\/|chrome\/|firefox\/|safari\/|edg\//i.test(text)) return "browser";
  return "unknown";
}

export const METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

// ── Route templates ────────────────────────────────────────────────────────

const ROUTE_TEMPLATES = new Set<string>(["unmatched"]);

/** Records every route the app declares (an onRoute hook): its pattern, never a caller's path. */
export function trackRouteTemplates(app: { addHook(name: "onRoute", hook: (route: { url: string }) => void): unknown }): void {
  app.addHook("onRoute", (route) => {
    if (typeof route.url === "string") ROUTE_TEMPLATES.add(route.url);
  });
}

/** The route templates the app declared, and "unmatched": the vocabulary of a route field. */
export function routeTemplates(): ReadonlySet<string> {
  return ROUTE_TEMPLATES;
}

/** The route a request matched, as the app declared it; "unmatched" when it matched none. */
export function routeTemplateOf(req: { routeOptions?: { url?: string } }): string {
  const url = req.routeOptions?.url;
  return typeof url === "string" && url !== "" ? url : "unmatched";
}

/**
 * The route a request matched, declared: Fastify sets routeOptions.url from the matched route's
 * declared pattern (a wildcard route's too), never from the caller's path.
 */
export function declaredRoute(req: { routeOptions?: { url?: string } }): Declared {
  return make(routeTemplateOf(req));
}

// ── Errors ─────────────────────────────────────────────────────────────────

const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STACK_FRAME = /^\s*at (?:[\w$.<>\[\] ]+ \()?[^()\s]+:\d+:\d+\)?\s*$/;

/** An error's class as the error chokepoint builds it: the constructor the code ran, never its data. */
function classOf(err: unknown): string {
  if (!(err instanceof Error) && (err === null || typeof err !== "object")) return "NonError";
  const name = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && CLASS_NAME.test(name) ? name : "Error";
}

/** An error's class, declared: for a producer that reports a failure's kind without its message. */
export function errorClassOf(err: unknown): Declared {
  return make(classOf(err));
}

/**
 * An error as a sink may carry it, built here: its class (the constructor the code ran), its code
 * (a code-shaped string or a number the code set) and HTTP status, its message as a keyed hash
 * (a message can echo a request) and its code frames.
 */
export function closedError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error) && (err === null || typeof err !== "object")) {
    return { type: "NonError", ...(err !== undefined ? { message: closedText(err) } : {}) };
  }
  const e = err as { code?: unknown; message?: unknown; stack?: unknown; statusCode?: unknown };
  const code = typeof e.code === "number" && Number.isFinite(e.code) ? e.code
    : typeof e.code === "string" ? (ERROR_CODE.test(e.code) ? e.code : keyedHash(e.code)) : undefined;
  const status = typeof e.statusCode === "number" && Number.isInteger(e.statusCode) && e.statusCode >= 100 && e.statusCode <= 599 ? e.statusCode : undefined;
  const frames = typeof e.stack === "string"
    ? e.stack.split("\n").slice(1).filter((line) => STACK_FRAME.test(line)).slice(0, 12).map((line) => line.trim())
    : undefined;
  return {
    type: classOf(err),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { statusCode: status } : {}),
    ...(typeof e.message === "string" ? { message: closedText(e.message) } : {}),
    ...(frames && frames.length ? { stack: frames } : {}),
  };
}

// ── Values ─────────────────────────────────────────────────────────────────

/** A value closed, and whether a producer declared any of it (which keeps its key). */
export interface ClosedField {
  value: unknown;
  declared: boolean;
}

/**
 * Any value as a sink may carry it, with whether it holds a declared field. A declared value
 * leaves as declared; an error as the error chokepoint builds it; every other leaf as its keyed
 * hash; an object's key as itself only when its field holds a declared value, otherwise as its
 * keyed hash. Undefined means: leave it out.
 */
export function closeField(value: unknown, depth = 0): ClosedField {
  if (value === null || value === undefined) return { value, declared: false };
  if (isDeclared(value)) return { value: emitted(value), declared: true };
  if (depth > 6) return { value: undefined, declared: false };
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return { value: keyedHash(value), declared: false };
    case "bigint":
    case "function":
    case "symbol":
      return { value: undefined, declared: false };
  }
  if (value instanceof Error) return { value: closedError(value), declared: true };
  if (value instanceof Date) return { value: Number.isNaN(value.getTime()) ? undefined : keyedHash(value.toISOString()), declared: false };
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { value: undefined, declared: false };
  try {
    if (Array.isArray(value)) {
      let declared = false;
      const out = value.slice(0, 50).map((item) => {
        const closed = closeField(item, depth + 1);
        declared ||= closed.declared;
        return closed.value === undefined ? null : closed.value;
      });
      return { value: out, declared };
    }
    const out: Record<string, unknown> = {};
    let declared = false;
    let n = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (++n > 100) break;
      const closed = closeField(item, depth + 1);
      if (closed.value === undefined) continue;
      out[closed.declared ? key : keyedHash(key)] = closed.value;
      declared ||= closed.declared;
    }
    return { value: out, declared };
  } catch {
    return { value: undefined, declared: false };
  }
}

/** Any value as a sink may carry it, under the rules above. Undefined means: leave it out. */
export function closeValue(value: unknown, depth = 0): unknown {
  return closeField(value, depth).value;
}

/**
 * A free-text line (a log message, a console argument): a declared message as itself, with its
 * printf arguments closed first; anything else as the keyed hash of the formatted text.
 */
export function closedMessage(message: unknown, ...args: unknown[]): string {
  if (isDeclared(message)) {
    const text = String(emitted(message));
    return args.length > 0 ? format(text, ...args.map((arg) => (isDeclared(arg) ? emitted(arg) : keyedHash(arg)))) : text;
  }
  const text = args.length > 0 ? format(message as string, ...args) : String(message);
  return keyedHash(text);
}

// ── The telemetry key at boot ──────────────────────────────────────────────

/**
 * What boot says about the telemetry key (round 2, MEDIUM 4). Without a valid PCC_TELEMETRY_KEY every
 * hash uses a per-process key; in production that is one loud warning naming what breaks. The
 * gateway still starts: refusing to is the operator's decision (#5708).
 */
export function telemetryKeyWarning(nodeEnv: string | undefined, ephemeral = TELEMETRY_KEY_EPHEMERAL): { level: "error" | "warn"; message: Declared } | undefined {
  if (!ephemeral) return undefined;
  if (nodeEnv === "production") {
    return {
      level: "error",
      message: lit("[observability] WARNING: NODE_ENV=production and PCC_TELEMETRY_KEY is unset or shorter than 32 characters. Every telemetry hash uses a key this process made: after a restart, audit rows it wrote are no longer found by actor, trace or report id, and PostHog and Sentry ids no longer join across restarts. Set PCC_TELEMETRY_KEY (32+ characters) to keep them."),
    };
  }
  return { level: "warn", message: lit("[observability] PCC_TELEMETRY_KEY is not set: telemetry hashes use a per-process key and do not correlate across restarts.") };
}

// ── Request scope ──────────────────────────────────────────────────────────

/** Set for the lifetime of each request (an onRequest hook): request-path console output is closed. */
export const requestScope = new AsyncLocalStorage<true>();

/** The onRequest hook that opens the request scope: register it first, at the root. */
export function openRequestScope(_req: unknown, _reply: unknown, done: () => void): void {
  requestScope.run(true, done);
}
