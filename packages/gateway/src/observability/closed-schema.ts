/**
 * The closed observability schema (N107b; the PR steward's ruling of 10/03, bus #5315 and #5319,
 * DECISIONS.md): no request-controlled value reaches any sink or console line, except as a keyed
 * hash or a coarse class. Every sink chokepoint (the PostHog boundary, the audit writer, the logger,
 * request-path console output and Sentry) rebuilds what it sends from these rules:
 *
 *   - identifiers (keys named id, *Id, *_id, ip, address, actor, principal, email, user, wallet,
 *     distinctId) leave as keyedHash: an HMAC under the server secret PCC_TELEMETRY_KEY, so a value
 *     cannot be recovered by guessing;
 *   - a string leaves as itself only when it is one of the gateway's own string literals, a
 *     registered closed value (a route template, a registered vocabulary word), or an ISO-8601 timestamp;
 *     anything else, prose included, leaves as its keyed hash. A request value cannot be one of the
 *     gateway's literals unless the code already says it, so nothing secret passes as text;
 *   - object keys follow the same rule (a key a caller chose, like a query parameter's name, is
 *     hashed), numbers leave only under known server-side metric names, errors leave as their class,
 *     code and code frames;
 *   - the User-Agent is a coarse class: bot, browser, sdk or unknown.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

// ── Coarse classes ─────────────────────────────────────────────────────────

export type UaClass = "bot" | "browser" | "sdk" | "unknown";

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

// ── Closed values: route templates and registered vocabularies ─────────────

const CLOSED_VALUES = new Set<string>();

/** Declares values that may leave as text: a producer's enumerated codes, names or classes. */
export function registerClosedValues(values: Iterable<string>): void {
  for (const value of values) CLOSED_VALUES.add(value);
}

const ROUTE_TEMPLATES = new Set<string>();

/** Records every route the app declares (an onRoute hook): its pattern, never a caller's path. */
export function trackRouteTemplates(app: { addHook(name: "onRoute", hook: (route: { url: string }) => void): unknown }): void {
  app.addHook("onRoute", (route) => {
    if (typeof route.url === "string") ROUTE_TEMPLATES.add(route.url);
  });
}

/** The route a request matched, as the app declared it; "unmatched" when it matched none. */
export function routeTemplateOf(req: { routeOptions?: { url?: string } }): string {
  const url = req.routeOptions?.url;
  return typeof url === "string" && url !== "" ? url : "unmatched";
}

// ── The gateway's own literals ─────────────────────────────────────────────

/** Messages the web framework itself logs, which are not in the gateway's source. */
const FRAMEWORK_LITERALS = ["incoming request", "request completed", "unmatched"];

let literals: Set<string> | null = null;
let identifiers: Set<string> | null = null;

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/**
 * Every whole string literal in a source file: a small scanner that skips comments, reads quoted
 * strings to their closing quote on the same line, and reads a template literal to its closing
 * backtick, keeping it only when it has no interpolation. (A regex pairs quotes and backticks
 * across code and comments, and so swallows real literals.)
 */
function extractLiterals(text: string, out: Set<string>): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      if (end < 0) return;
      i = end + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let body = "";
      let closed = false;
      while (j < n) {
        const d = text[j]!;
        if (d === "\\") {
          body += d + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (d === "\n") break;
        if (d === c) {
          closed = true;
          break;
        }
        body += d;
        j++;
      }
      if (closed && body.length <= 500) out.add(unescapeLiteral(body));
      i = j + 1;
      continue;
    }
    if (c === "`") {
      let j = i + 1;
      let body = "";
      let interpolated = false;
      while (j < n) {
        const d = text[j]!;
        if (d === "\\") {
          body += d + (text[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (d === "`") break;
        if (d === "$" && text[j + 1] === "{") {
          interpolated = true;
          let k = j + 2;
          let depth = 1;
          while (k < n && depth > 0) {
            if (text[k] === "{") depth++;
            else if (text[k] === "}") depth--;
            k++;
          }
          j = k;
          continue;
        }
        body += d;
        j++;
      }
      if (!interpolated && body.length <= 500) out.add(unescapeLiteral(body));
      i = j + 1;
      continue;
    }
    i++;
  }
}

function unescapeLiteral(body: string): string {
  if (!body.includes("\\")) return body;
  try {
    return JSON.parse(`"${body.replace(/\\'/g, "'").replace(/\\`/g, "`").replace(/(?<!\\)"/g, '\\"')}"`) as string;
  } catch {
    return body;
  }
}

function sourceRoot(): string {
  // This file is <root>/observability/closed-schema.(ts|js): the gateway's src or dist.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function collectSource(dir: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "__tests__" || name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) collectSource(path, out, depth + 1);
    else if (/\.(ts|js|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
}

function loadLiterals(): void {
  literals = new Set(FRAMEWORK_LITERALS);
  identifiers = new Set();
  const files: string[] = [];
  collectSource(sourceRoot(), files);
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    extractLiterals(text, literals);
    for (const match of text.matchAll(IDENTIFIER)) identifiers.add(match[0]);
  }
}

/** True when the whole string is one of the gateway's own literals or a registered closed value. */
export function isClosedText(text: string): boolean {
  if (!literals) loadLiterals();
  return literals!.has(text) || CLOSED_VALUES.has(text) || ROUTE_TEMPLATES.has(text);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A string as a sink may carry it: itself when closed (or a timestamp), otherwise its keyed hash. */
export function closedText(text: string): string {
  return isClosedText(text) || ISO_TIMESTAMP.test(text) ? text : keyedHash(text);
}

/** An object key as a sink may carry it: a name the gateway's code uses, otherwise its keyed hash. */
export function closedKey(key: string): string {
  if (!identifiers) loadLiterals();
  return identifiers!.has(key) || isClosedText(key) ? key : keyedHash(key);
}

// ── Values ─────────────────────────────────────────────────────────────────

/** Keys whose values are identifiers: always a keyed hash, whatever they hold. */
const ID_KEY = /^(?:id|ids|ip|ips|address|actor|principal|email|user|wallet|distinctId|clientIp|remoteAddress)$|(?:Id|Ids|_id|_ids|Address|Email|Wallet|Ip)$/;

/** Server-side metrics: the only keys a number may leave under. */
const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "statusCode", "status", "status_code", "responseTime", "durationMs", "duration_ms", "elapsedMs", "elapsed",
  "requestCount", "windowMs", "confidence", "count", "total", "attempt", "attempts", "retries", "port", "pid",
  "forwardedHops", "progress", "epoch", "level", "time", "uptime", "latencyMs", "latency_ms", "timeoutMs",
]);

/** Keys an error's class name may leave under: constructor names, never caller text. */
const ERROR_CLASS_KEYS: ReadonlySet<string> = new Set(["errorClass", "errorType"]);
const CLASS_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const STACK_FRAME = /^\s*at (?:[\w$.<>\[\] ]+ \()?[^()\s]+:\d+:\d+\)?\s*$/;

/** An error as a sink may carry it: its class, its code, its message under the text rule and its code frames. */
export function closedError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error) && (err === null || typeof err !== "object")) {
    return { type: "NonError", message: typeof err === "string" ? closedText(err) : undefined };
  }
  const e = err as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown; statusCode?: unknown; constructor?: { name?: unknown } };
  const name = typeof e.name === "string" && CLASS_NAME.test(e.name) ? e.name
    : typeof e.constructor?.name === "string" && CLASS_NAME.test(e.constructor.name) ? e.constructor.name : "Error";
  const code = typeof e.code === "number" ? e.code
    : typeof e.code === "string" ? (ERROR_CODE.test(e.code) ? e.code : closedText(e.code)) : undefined;
  const frames = typeof e.stack === "string"
    ? e.stack.split("\n").slice(1).filter((line) => STACK_FRAME.test(line)).slice(0, 12).map((line) => line.trim())
    : undefined;
  return {
    type: name,
    ...(code !== undefined ? { code } : {}),
    ...(typeof e.statusCode === "number" ? { statusCode: e.statusCode } : {}),
    message: typeof e.message === "string" ? closedText(e.message) : undefined,
    ...(frames && frames.length ? { stack: frames } : {}),
  };
}

/** Any value as a sink may carry it, under the rules above. Undefined means: leave it out. */
export function closeValue(value: unknown, key = "", depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return NUMERIC_KEYS.has(key) && Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    if (ID_KEY.test(key)) return keyedHash(value);
    if (ERROR_CLASS_KEYS.has(key) && CLASS_NAME.test(value)) return value;
    return closedText(value);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof Error) return closedError(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => (ID_KEY.test(key) && typeof item === "string" ? keyedHash(item) : closeValue(item, key, depth + 1)));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (++n > 100) break;
      const closed = closeValue(v, k, depth + 1);
      if (closed !== undefined) out[closedKey(k)] = closed;
    }
    return out;
  }
  return undefined;
}

/** A free-text line (a log message, a console argument): the text rule, after printf formatting. */
export function closedMessage(message: unknown, ...args: unknown[]): string {
  const text = args.length > 0 ? format(message as string, ...args) : String(message);
  return closedText(text);
}

// ── Request scope ──────────────────────────────────────────────────────────

/** Set for the lifetime of each request (an onRequest hook): request-path console output is closed. */
export const requestScope = new AsyncLocalStorage<true>();

/** The onRequest hook that opens the request scope: register it first, at the root. */
export function openRequestScope(_req: unknown, _reply: unknown, done: () => void): void {
  requestScope.run(true, done);
}
