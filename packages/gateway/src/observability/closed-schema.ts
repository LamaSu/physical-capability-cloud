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
 *
 * Round 4 (the PR steward's escalated property, bus #6139): every emitted leaf, key and value, is a
 * producer declaration or keyed, with no trust by a key's name, a value's shape, its type or its
 * range. What a chokepoint keeps readable it keeps by membership: in a closed vocabulary the server
 * defines (error classes and codes, route templates, pino's levels) or in a registry the server fills
 * (the declared values below, the request ids it issued, its own requests and replies, the V8 call
 * sites of its errors). A coarse class a chokepoint computes (a status as "4xx") is a transformation.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { format } from "node:util";
import { errorCodes as FASTIFY_ERROR_CODES } from "fastify";

// ── Keyed hash ─────────────────────────────────────────────────────────────

const ENV_KEY = process.env.PCC_TELEMETRY_KEY;
const KEY = ENV_KEY && ENV_KEY.length >= 32 ? Buffer.from(ENV_KEY, "utf8") : randomBytes(32);

/** True when PCC_TELEMETRY_KEY is unset or short: hashes then do not correlate across restarts. */
export const TELEMETRY_KEY_EPHEMERAL = !(ENV_KEY && ENV_KEY.length >= 32);

/** The text a value is hashed as: itself for a string, else its JSON, else its string form; never a throw. */
function hashText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // a bigint, a cycle or a throwing toJSON: hashed by its string form below
  }
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * A value as every sink may carry it: an HMAC-SHA256 under the server secret, truncated. It never
 * throws (round 4 of #538): a value JSON cannot hold no longer drops the entry or the log call it is in.
 */
export function keyedHash(value: unknown): string {
  let text: string;
  try {
    text = hashText(value);
  } catch {
    text = "[unhashable]";
  }
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

type Emitted = string | number | boolean | null | Emitted[];

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
  /**
   * A list a producer declares as one field: each declared item as declared, any other as its keyed
   * hash. Only a field whose own value is declared keeps its key (round 2 of #538, M3), so a list
   * of declared values is declared as a list.
   */
  list(items: readonly unknown[]): Declared {
    return make(items.slice(0, 50).map((item) => (isDeclared(item) ? emitted(item) : keyedHash(item))));
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

/** A property read that never throws (a getter, a revoked proxy): undefined when it would. */
export function readSafely(target: unknown, key: string): unknown {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) return undefined;
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * The error codes an error may carry readable (round 2 of #538, M3: never by spelling): the system
 * error names (os.constants.errno), Fastify's own codes and SQLite's result codes. Any other code
 * leaves as its keyed hash.
 */
const ERROR_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(osConstants.errno),
  ...Object.keys(FASTIFY_ERROR_CODES),
  "SQLITE_ERROR", "SQLITE_BUSY", "SQLITE_LOCKED", "SQLITE_READONLY", "SQLITE_IOERR", "SQLITE_CORRUPT",
  "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_CONSTRAINT", "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_FOREIGNKEY", "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_CHECK", "SQLITE_MISMATCH", "SQLITE_RANGE", "SQLITE_NOTADB",
]);

/**
 * The error classes whose names leave readable (round 4 of #538, B5): JavaScript's built-in error
 * classes, the runtime's own (DOMException, AbortError, SystemError) and Fastify's. Any other class
 * name leaves as its keyed hash: code can name a class at run time (a computed key), so a class name
 * is trusted by membership, never by its spelling.
 */
export const ERROR_CLASSES: ReadonlySet<string> = new Set([
  "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError",
  "DOMException", "AbortError", "SystemError", "FastifyError",
]);

/**
 * An error's class as the error chokepoint builds it: the class its prototype names (never an own
 * `constructor` property, which data can carry), readable from ERROR_CLASSES and keyed otherwise;
 * "NonError" for anything that is not an Error.
 */
export function errorClassName(err: unknown): string {
  if (!(err instanceof Error)) return "NonError";
  let name: unknown;
  try {
    name = (Object.getPrototypeOf(err) as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  } catch {
    name = undefined;
  }
  return typeof name === "string" && ERROR_CLASSES.has(name) ? name : keyedHash(name);
}

/** An error's class, declared: for a producer that reports a failure's kind without its message. */
export function errorClassOf(err: unknown): Declared {
  return make(errorClassName(err));
}

// ── Code frames ────────────────────────────────────────────────────────────

/** A code location V8 recorded for an error: its script, line and column. */
export interface CodeFrame {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/**
 * The code frames of each error whose stack this process formatted, taken from V8's own call sites
 * (round 4 of #538, B6). No stack text is parsed: a frame written into a message, a name or an
 * assigned stack is text, and only a call site V8 recorded is a frame. A function's name is left out,
 * because code can name a function at run time (a computed key, Object.defineProperty); a frame is
 * where the code is, never what it was called.
 */
const FRAMES = new WeakMap<object, readonly CodeFrame[]>();
const MAX_FRAMES = 12;

type PrepareStackTrace = (error: Error, sites: NodeJS.CallSite[]) => unknown;

function framesOf(sites: readonly NodeJS.CallSite[]): CodeFrame[] {
  const frames: CodeFrame[] = [];
  for (const site of sites) {
    if (frames.length >= MAX_FRAMES) break;
    try {
      const file = site.getFileName();
      const line = site.getLineNumber();
      const column = site.getColumnNumber();
      if (typeof file === "string" && file !== "" && typeof line === "number" && typeof column === "number") frames.push({ file, line, column });
    } catch {
      // a call site that cannot be read is left out
    }
  }
  return frames;
}

/**
 * Wraps the runtime's Error.prepareStackTrace (V8 calls it once per error, the first time its stack
 * is read): the call sites are recorded, and the stack text is still what the wrapped function makes.
 */
function installFrameRecorder(): void {
  const previous = Error.prepareStackTrace as PrepareStackTrace | undefined;
  Error.prepareStackTrace = function recordFrames(this: unknown, error: Error, sites: NodeJS.CallSite[]): unknown {
    try {
      if (typeof error === "object" && error !== null) FRAMES.set(error, framesOf(sites));
    } catch {
      // recording never breaks a stack
    }
    if (previous) return previous.call(this, error, sites);
    return `${Error.prototype.toString.call(error)}${sites.map((site) => `\n    at ${String(site)}`).join("")}`;
  };
}
installFrameRecorder();

/** The code frames V8 recorded for an error (its stack is formatted first if nothing has read it); none for anything else. */
export function codeFrames(err: unknown): readonly CodeFrame[] {
  if (typeof err !== "object" || err === null) return [];
  if (!FRAMES.has(err)) readSafely(err, "stack");
  return FRAMES.get(err) ?? [];
}

/**
 * An error as a sink may carry it, built here: its class (ERROR_CLASSES, else keyed), its code when it
 * is a known system, Fastify or SQLite code (any other as its keyed hash), its HTTP status as a class
 * ("4xx"; the exact status a response carries comes from the response itself), its message as a
 * keyed hash (a message can echo a request) and its code frames (V8's call sites). Anything that is
 * not an Error is "NonError" with its keyed hash: a plain object's fields are never read as an error's.
 */
export function closedError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: "NonError", ...(err !== undefined ? { message: closedText(err) } : {}) };
  const rawCode = readSafely(err, "code");
  const statusCode = readSafely(err, "statusCode");
  const message = readSafely(err, "message");
  const code = rawCode === undefined || rawCode === null ? undefined
    : typeof rawCode === "string" && ERROR_CODES.has(rawCode) ? rawCode : keyedHash(rawCode);
  const status = typeof statusCode === "number" && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
    ? `${Math.floor(statusCode / 100)}xx` : undefined;
  const frames = codeFrames(err).map((frame) => `at ${frame.file}:${frame.line}:${frame.column}`);
  return {
    type: errorClassName(err),
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { statusClass: status } : {}),
    ...(typeof message === "string" ? { message: closedText(message) } : {}),
    ...(frames.length > 0 ? { stack: frames } : {}),
  };
}

// ── Values ─────────────────────────────────────────────────────────────────

/** A value closed, and whether a producer declared any of it (which keeps its key). */
export interface ClosedField {
  value: unknown;
  declared: boolean;
}

/**
 * Any value as a sink may carry it, with whether it IS declared. A declared value leaves as
 * declared; an error as the error chokepoint builds it; every other leaf as its keyed hash. An
 * object's key leaves as itself only when its own value is declared: a declared value inside a
 * container never vouches for the container's key (round 2 of #538, M3), and a list of declared
 * values is declared with declare.list. Undefined means: leave it out.
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
  if (value instanceof Error) return { value: closedError(value), declared: false };
  if (value instanceof Date) return { value: Number.isNaN(value.getTime()) ? undefined : keyedHash(value.toISOString()), declared: false };
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return { value: undefined, declared: false };
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, 50).map((item) => {
        const closed = closeField(item, depth + 1);
        return closed.value === undefined ? null : closed.value;
      });
      return { value: out, declared: false };
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (++n > 100) break;
      const closed = closeField(item, depth + 1);
      if (closed.value === undefined) continue;
      out[closed.declared ? key : keyedHash(key)] = closed.value;
    }
    return { value: out, declared: false };
  } catch {
    return { value: undefined, declared: false };
  }
}

/** Any value as a sink may carry it, under the rules above. Undefined means: leave it out. */
export function closeValue(value: unknown, depth = 0): unknown {
  return closeField(value, depth).value;
}

/**
 * A record as a sink stores it: every object and array in it frozen, so a reader can change
 * nothing the chokepoint closed (#538 round 3, astra source pack). Closed values are plain data,
 * so this reaches every leaf.
 */
export function frozen<T>(value: T, depth = 0): T {
  if (typeof value !== "object" || value === null || depth > 64) return value;
  for (const key of Object.keys(value)) frozen((value as Record<string, unknown>)[key], depth + 1);
  return Object.freeze(value);
}

/**
 * A free-text line (a log message, a console argument): a declared message as itself, with its
 * printf arguments closed first; anything else as the keyed hash of the formatted text (a string
 * message alone formats as itself). It never throws: a message String() cannot convert is hashed whole.
 */
export function closedMessage(message: unknown, ...args: unknown[]): string {
  if (isDeclared(message)) {
    const text = String(emitted(message));
    return args.length > 0 ? format(text, ...args.map((arg) => (isDeclared(arg) ? emitted(arg) : keyedHash(arg)))) : text;
  }
  try {
    return keyedHash(format(message, ...args));
  } catch {
    return keyedHash(message);
  }
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
