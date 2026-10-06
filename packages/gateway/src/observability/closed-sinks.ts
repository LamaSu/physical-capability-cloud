/**
 * The closed schema at each sink chokepoint (N107b; see closed-schema.ts for the rules):
 *   - gatewayLoggerOptions(): pino options for the gateway's Fastify logger, with issueRequestId as
 *     Fastify's genReqId and closedLoggerHooks(app) installed on the app. Every log line's object,
 *     message, request, reply and error leave under the closed rules, and the last pass over the
 *     serialized line keeps a field only when this call's own chokepoints produced exactly that value
 *     (round 4 of #538): anything else that reached the line (a child logger's bindings, a route's
 *     own serializers) is closed there, key and value;
 *   - closeConsole(): request-path console output (inside a request's scope) leaves closed too;
 *   - closedSentryEvent / closedSentryTransaction / closedSentrySpan / closedBreadcrumb: Sentry's
 *     outbound events are rebuilt from closed fields and the server's own values only, trace and span
 *     ids remapped under the telemetry key and the envelope's sampling context rebuilt (sentry.ts
 *     wires them, and keeps a request's trace headers from being continued at all).
 */
import type { FastifyInstance, FastifyLogFn } from "fastify";
import { isTelemetrySinkRequest } from "../services/telemetry-privacy.js";
import { hostname } from "node:os";
import {
  closedError,
  closedMessage,
  closedText,
  closeField,
  closeValue,
  codeFrames,
  declare,
  emitted,
  ERROR_CLASSES,
  errorClassName,
  isDeclared,
  keyedHash,
  keyedHexId,
  METHODS,
  readSafely,
  requestScope,
  routeTemplates,
  trackRouteTemplates,
  type CodeFrame,
  type Declared,
} from "./closed-schema.js";

/** A log call whose message is declared (lit): the logger keeps it as written. */
interface DeclaredLogFn {
  (msg: Declared, ...args: unknown[]): void;
  (obj: object, msg: Declared, ...args: unknown[]): void;
}

declare module "fastify" {
  // Every Fastify logger takes a declared message as well as a string (which leaves as its keyed hash).
  interface FastifyBaseLogger {
    fatal: FastifyLogFn & DeclaredLogFn;
    error: FastifyLogFn & DeclaredLogFn;
    warn: FastifyLogFn & DeclaredLogFn;
    info: FastifyLogFn & DeclaredLogFn;
    debug: FastifyLogFn & DeclaredLogFn;
    trace: FastifyLogFn & DeclaredLogFn;
  }
}

// ── The server's own requests, replies and request ids ─────────────────────

/** How many of the most recently issued request ids a log line keeps readable (round 4 of #538, A2). */
export const REQUEST_ID_WINDOW = 200_000;

let issued = 0;
/** The request ids this process issued, the most recent REQUEST_ID_WINDOW of them: a registry, never a shape. */
const ISSUED_IDS = new Set<string>();
const ISSUED_RING: Array<string | undefined> = new Array<string | undefined>(REQUEST_ID_WINDOW);

/** The server's own requests: each raw request Fastify asked an id for (issueRequestId) or ran its hooks on. */
const OWN_REQUESTS = new WeakSet<object>();
/** The server's own replies: each raw response closedLoggerHooks saw, with its Fastify reply (for its measured time). */
const OWN_REPLIES = new WeakMap<object, object>();

/**
 * The gateway's request ids (Fastify's genReqId, which passes the raw request): req-<n> in base 36,
 * as Fastify's default makes them. Each id is recorded in a bounded registry, and the raw request in
 * the registry of the server's own requests: a log line keeps a request id, and a serializer reads a
 * request as the server's, only on membership (round 4 of #538, A2 and A4).
 */
export function issueRequestId(raw?: unknown): string {
  issued += 1;
  const id = `req-${issued.toString(36)}`;
  const slot = issued % REQUEST_ID_WINDOW;
  const evicted = ISSUED_RING[slot];
  if (evicted !== undefined) ISSUED_IDS.delete(evicted);
  ISSUED_RING[slot] = id;
  ISSUED_IDS.add(id);
  if (typeof raw === "object" && raw !== null) OWN_REQUESTS.add(raw);
  return id;
}

function isIssuedRequestId(value: unknown): boolean {
  return typeof value === "string" && ISSUED_IDS.has(value);
}

/**
 * The closed logger's hooks on an app that logs with gatewayLoggerOptions: the vocabulary of route
 * templates (trackRouteTemplates), and an onRequest hook that registers the server's own request and
 * reply. Install it first, at the root, before any route or plugin; server.ts does, and so must any
 * app (a test's included) that logs with these options.
 */
export function closedLoggerHooks(app: FastifyInstance): void {
  trackRouteTemplates(app);
  app.addHook("onRequest", (request, reply, done) => {
    const rawRequest = readSafely(request, "raw");
    if (typeof rawRequest === "object" && rawRequest !== null) OWN_REQUESTS.add(rawRequest);
    const rawReply = readSafely(reply, "raw");
    if (typeof rawReply === "object" && rawReply !== null) OWN_REPLIES.set(rawReply, reply);
    done();
  });
}

/** The server's own raw request behind a logged request (the request itself, or its raw), by registry membership. */
function ownRequest(req: unknown): object | undefined {
  if (typeof req !== "object" || req === null) return undefined;
  if (OWN_REQUESTS.has(req)) return req;
  const raw = readSafely(req, "raw");
  return typeof raw === "object" && raw !== null && OWN_REQUESTS.has(raw) ? raw : undefined;
}

/** The server's own raw response and Fastify reply behind a logged reply, by registry membership. */
function ownReply(res: unknown): { raw: object; reply: object } | undefined {
  if (typeof res !== "object" || res === null) return undefined;
  const direct = OWN_REPLIES.get(res);
  if (direct) return { raw: res, reply: direct };
  const raw = readSafely(res, "raw");
  const reply = typeof raw === "object" && raw !== null ? OWN_REPLIES.get(raw) : undefined;
  return reply && raw ? { raw: raw as object, reply } : undefined;
}

// ── Logger ─────────────────────────────────────────────────────────────────

const HOSTNAME = hostname();

/** pino's own level numbers: a line's level is one of them, else keyed (round 4 of #538, A1). */
const PINO_LEVELS: ReadonlySet<number> = new Set([10, 20, 30, 40, 50, 60]);

/** Fastify's own messages, kept only on records of the server's own request or reply (frameworkRecord). */
const FRAMEWORK_MESSAGES: ReadonlySet<string> = new Set(["incoming request", "request completed"]);

/**
 * What the current log call's own chokepoints produced. One pino write is synchronous: logMethod
 * closes the message, formatters.log the object's fields, the req, res and err serializers their
 * values, and the line pass reads all of it before the next call. Each field is kept as its JSON, so
 * the line keeps a field only when its value is exactly what was produced for this call.
 */
interface Writing {
  msg: string | undefined;
  fields: Map<string, string>;
}
let writing: Writing | undefined;

/** Records a field this call's chokepoints produced, as JSON (a value JSON cannot hold is not recorded, so the line closes it). */
function produced<T>(key: string, value: T): T {
  if (writing) {
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) writing.fields.set(key, json);
    } catch {
      // not recorded: the line pass closes the field
    }
  }
  return value;
}

/**
 * Fastify's own records ("incoming request", "request completed", its error records): an object
 * carrying the server's own request or reply (by registry, never by its type). A record's response
 * time is the reply's own measurement (Fastify's elapsedTime, read from the registered reply),
 * never a number the record carries (round 4 of #538, A4: no trust by a declared neighbour).
 */
function frameworkRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const reply = ownReply(readSafely(obj, "res"));
  if (!reply && !ownRequest(readSafely(obj, "req"))) return undefined;
  if (!reply || !Object.hasOwn(obj, "responseTime")) return obj;
  const elapsed = readSafely(reply.reply, "elapsedTime");
  try {
    return { ...obj, responseTime: typeof elapsed === "number" ? declare.metric(elapsed) : undefined };
  } catch {
    return undefined;
  }
}

/**
 * The last pass over every serialized log line. A field leaves as written only when this call's own
 * chokepoints produced exactly that value under that key (formatters.log for the object's fields, the
 * serializers for req, res and err, logMethod for the message); req, res and err are not trusted by
 * their names, so a child logger's earlier bindings and a route's own serializers are closed here
 * like anything else, key and value. The logger's own fields are the server's: the time, pid and
 * hostname it writes, a level from pino's level numbers, a request id this process issued.
 */
function closedLine(line: string): string {
  const own = writing;
  writing = undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return keyedHash(line) + "\n";
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) return keyedHash(line) + "\n";
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
    switch (key) {
      case "level":
        out.level = typeof value === "number" && PINO_LEVELS.has(value) ? value : keyedHash(value);
        break;
      case "time":
        out.time = Date.now();
        break;
      case "pid":
        out.pid = process.pid;
        break;
      case "hostname":
        out.hostname = HOSTNAME;
        break;
      case "msg":
        out.msg = own !== undefined && typeof value === "string" && (value === own.msg || own.fields.get("msg") === JSON.stringify(value))
          ? value
          : keyedHash(value);
        break;
      case "reqId":
        out.reqId = isIssuedRequestId(value) ? value : keyedHash(value);
        break;
      default:
        if (own !== undefined && own.fields.get(key) === JSON.stringify(value)) {
          out[key] = value;
        } else {
          const closed = closeValue(value);
          if (closed !== undefined) out[keyedHash(key)] = closed;
        }
    }
  }
  return JSON.stringify(out) + "\n";
}

/**
 * A request as a log line carries it, built here: method, route template and the client's keyed
 * hash. Only the server's own request (registered when Fastify issued its id, or by its hooks) is
 * read this way: its method from its own raw request, its route only when the app declared it.
 * Anything else is closed like any value (round 4 of #538, A4).
 */
export function closedRequest(req: unknown): Record<string, unknown> {
  const raw = ownRequest(req);
  if (!raw) return (closeValue(req) as Record<string, unknown> | undefined) ?? {};
  const requestMethod = readSafely(raw, "method");
  const url = readSafely(readSafely(req, "routeOptions"), "url");
  const route = typeof url === "string" && url !== "" ? url : "unmatched";
  const ip = readSafely(req, "ip");
  // #458: a request that targets or imitates the public telemetry sink leaves no client value,
  // not even its keyed hash.
  const rawUrl = readSafely(raw, "url");
  const sink = typeof rawUrl === "string" && isTelemetrySinkRequest(rawUrl);
  return {
    method: typeof requestMethod === "string" && METHODS.has(requestMethod) ? requestMethod : "OTHER",
    route: routeTemplates().has(route) ? route : keyedHash(route),
    ...(typeof ip === "string" && !sink ? { client: keyedHash(ip) } : {}),
  };
}

/**
 * A response as a log line carries it: the status the server's own response carries (registered by
 * closedLoggerHooks), read from that response. Anything else is closed like any value (round 4, A4).
 */
export function closedResponse(res: unknown): Record<string, unknown> {
  const own = ownReply(res);
  if (!own) return (closeValue(res) as Record<string, unknown> | undefined) ?? {};
  const status = readSafely(own.raw, "statusCode");
  return typeof status === "number" && Number.isInteger(status) ? { statusCode: status } : {};
}

/** An error as a log line carries it: closedError, its frames as one string. */
function serializedError(err: unknown): { [key: string]: unknown; type: string; message: string; stack: string } {
  const closed = closedError(err);
  return {
    ...closed,
    type: String(closed.type),
    message: typeof closed.message === "string" ? closed.message : "",
    stack: Array.isArray(closed.stack) ? closed.stack.join("\n") : "",
  };
}

/** A log object under the closed rules; the req, res and err keys go to their serializers. Each field it produces is recorded. */
export function closeLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let entries: Array<[string, unknown]>;
  try {
    entries = Object.entries(obj);
  } catch {
    return out;
  }
  for (const [key, value] of entries) {
    if (key === "req" || key === "res" || key === "err") {
      out[key] = value;
      continue;
    }
    const closed = closeField(value, 1);
    if (closed.value === undefined) continue;
    const name = closed.declared ? key : keyedHash(key);
    out[name] = produced(name, closed.value);
  }
  return out;
}

/**
 * The gateway's pino options: the request is its method, route and client hash (never a URL or a
 * header), the response its status, an error its class, code and frames, the bindings only the
 * process and an issued request id, and every message and field under the closed rules.
 */
export function gatewayLoggerOptions() {
  return {
    level: "info",
    serializers: {
      req: (req: unknown) => produced("req", closedRequest(req)),
      res: (res: unknown) => produced("res", closedResponse(res)),
      err: (err: unknown) => produced("err", serializedError(err)),
    },
    formatters: {
      bindings: (bindings: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        if (Object.hasOwn(bindings, "pid")) out.pid = process.pid;
        if (Object.hasOwn(bindings, "hostname")) out.hostname = HOSTNAME;
        if (bindings.reqId !== undefined) out.reqId = isIssuedRequestId(bindings.reqId) ? bindings.reqId : keyedHash(bindings.reqId);
        return out;
      },
      log: (obj: Record<string, unknown>) => closeLogObject(obj),
    },
    hooks: {
      streamWrite: (line: string) => closedLine(line),
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        const [first, ...rest] = args;
        writing = { msg: undefined, fields: new Map() };
        let call: unknown[];
        if (args.length === 0) {
          call = [];
        } else if (first instanceof Error) {
          call = [{ err: first }, rest.length > 0 ? closedMessage(rest[0], ...rest.slice(1)) : closedText(readSafely(first, "message") ?? "")];
        } else if (first !== null && typeof first === "object" && !isDeclared(first)) {
          const framework = frameworkRecord(first as Record<string, unknown>);
          const message = rest.length === 0 ? undefined
            : framework && typeof rest[0] === "string" && FRAMEWORK_MESSAGES.has(rest[0]) ? rest[0]
            : closedMessage(rest[0], ...rest.slice(1));
          call = message === undefined ? [framework ?? first] : [framework ?? first, message];
        } else {
          call = [closedMessage(first, ...rest)];
        }
        writing.msg = call.length === 1 && typeof call[0] === "string" ? call[0] : typeof call[1] === "string" ? call[1] : undefined;
        return method.apply(this, call);
      },
    },
  };
}

// ── Console ────────────────────────────────────────────────────────────────

let consoleClosed = false;

/**
 * Request-path console output under the closed rules: inside a request's scope (requestScope), a
 * console line is one JSON object of closed arguments (closeValue, the same rules as every sink);
 * outside it (boot, timers), output is as written, a declared argument as its text.
 */
export function closeConsole(): void {
  if (consoleClosed) return;
  consoleClosed = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (!requestScope.getStore()) return original(...args.map((arg) => (isDeclared(arg) ? emitted(arg) : arg)));
      original(JSON.stringify({ console: level, args: args.map((arg) => closeValue(arg) ?? null) }));
    };
  }
}

// ── Sentry ─────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);

/** A value from a closed vocabulary: itself; anything else its keyed hash (or left out). */
const coded = (value: unknown, vocabulary: ReadonlySet<string>): string | undefined =>
  typeof value === "string" ? (vocabulary.has(value) ? value : keyedHash(value)) : undefined;

/** Sentry's span statuses. */
const SPAN_STATUSES: ReadonlySet<string> = new Set([
  "ok", "cancelled", "unknown", "unknown_error", "invalid_argument", "deadline_exceeded", "not_found",
  "already_exists", "permission_denied", "resource_exhausted", "failed_precondition", "aborted",
  "out_of_range", "unimplemented", "internal_error", "unavailable", "data_loss", "unauthenticated",
]);
/** Sentry's transaction sources. */
const SOURCES: ReadonlySet<string> = new Set(["custom", "url", "route", "view", "component", "task"]);
/** OpenTelemetry span kinds. */
const SPAN_KINDS: ReadonlySet<string> = new Set(["INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"]);
/** Span operations: the SDK's, and the gateway's own (settlement-service.ts). */
const SPAN_OPS: ReadonlySet<string> = new Set([
  "http.server", "http.client", "http", "db", "db.query", "db.sql.query", "cache.get", "cache.put", "function",
  "middleware.fastify", "request_handler.fastify", "hook.fastify", "graphql", "rpc", "file", "console",
  "settlement", "storage", "blockchain", "default",
]);
/** Span and mechanism origins the SDK sets (its integrations' names), and manual. */
const ORIGINS: ReadonlySet<string> = new Set([
  "manual", "generic", "chained", "instrument", "onerror", "onunhandledrejection", "onuncaughtexception", "internal",
  "auto.http.otel.http", "auto.http.otel.fastify", "auto.http.otel.node_fetch", "auto.http.otel.connect",
  "auto.http.otel.express", "auto.http.otel.hapi", "auto.http.otel.koa", "auto.http.otel.hono",
  "auto.function.fastify", "auto.function.hapi", "auto.middleware.connect", "auto.middleware.express",
  "auto.middleware.hono", "auto.middleware.koa", "auto.db.otel.postgres", "auto.db.otel.redis",
  "auto.db.otel.prisma", "auto.db.otel.knex", "auto.db.otel.mongo", "auto.db.otel.mongoose",
  "auto.db.otel.tedious", "auto.db.otel.generic_pool", "auto.db.otel.dataloader", "auto.db.postgresjs",
  "auto.file.fs", "auto.log.console", "auto.log.pino", "auto.core.capture_console", "auto.core.linked_errors",
  "auto.node.onuncaughtexception", "auto.node.onunhandledrejection", "auto.graphql.otel.graphql",
  "auto.ai.anthropic", "auto.ai.openai", "auto.vercelai.otel", "auto.child_process.worker_thread",
]);
/**
 * Whether Sentry reports an exception handled, by its mechanism's type (round 4 of #538, C12): the SDK
 * sets handled from the integration that caught the error, and the chokepoint derives it the same
 * way from the type's vocabulary instead of copying a boolean. A type not listed leaves no handled.
 */
const MECHANISM_HANDLED: ReadonlyMap<string, boolean> = new Map([
  ["generic", true], ["chained", true], ["instrument", true], ["auto.core.linked_errors", true],
  ["onerror", false], ["onunhandledrejection", false], ["onuncaughtexception", false], ["internal", false],
  ["auto.node.onuncaughtexception", false], ["auto.node.onunhandledrejection", false],
  ["auto.function.fastify", false], ["auto.function.hapi", false], ["auto.middleware.express", false],
  ["auto.middleware.connect", false], ["auto.middleware.hono", false], ["auto.middleware.koa", false],
  ["auto.child_process.worker_thread", false], ["auto.ai.anthropic", false], ["auto.ai.openai", false],
]);
const LEVELS: ReadonlySet<string> = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const BREADCRUMB_TYPES: ReadonlySet<string> = new Set(["default", "debug", "error", "navigation", "http", "info", "query", "transaction", "ui", "user"]);
const BREADCRUMB_CATEGORIES: ReadonlySet<string> = new Set([
  "console", "http", "fetch", "xhr", "navigation", "ui.click", "ui.input", "sentry.event", "sentry.transaction", "query",
]);

/** The server's own runtime, the only runtime context an event carries (round 4 of #538, C8). */
const RUNTIME = Object.freeze({ name: "node", version: process.version });

/** An HTTP status as its class ("4xx"), computed here: the exact status never leaves Sentry (round 4, C10). */
const statusClass = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? `${Math.floor(v / 100)}xx` : undefined);

/** A request method from METHODS, else left out. */
const method = (v: unknown) => (typeof v === "string" && METHODS.has(v) ? v : undefined);

/** A route field Sentry built: a template the app declared, or unmatched. */
const route = (v: unknown) => (typeof v === "string" && routeTemplates().has(v) ? v : undefined);

/**
 * A time the Sentry SDK took for a transaction or a span (its start, end and exclusive time). These
 * are declared by construction, the one such source: no gateway code passes a time to a Sentry or
 * OpenTelemetry span API (sentry-timing-ratchet.test.ts proves it), so only the SDK's clock writes
 * them. An error event's and a breadcrumb's time are the server's clock, read at the chokepoint.
 */
const sdkTime = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A transaction or span name: "METHOD template" or a declared route; anything else is unmatched. */
function closedName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const http = /^([A-Z]+) (\S+)$/.exec(name);
  if (http && METHODS.has(http[1]!)) return `${http[1]} ${route(http[2]) ?? "unmatched"}`;
  return route(name) ?? "unmatched";
}

/** What the server itself sets on every event: its DSN's public key, environment, release, sample rate and tags. */
export interface SentryServerValues {
  publicKey?: string;
  environment?: string;
  release?: string;
  sampleRate?: number;
  /** Tags the server set (initialScope), each with the one value it set. */
  tags?: Readonly<Record<string, string>>;
}

const serverSampleRate = (server: SentryServerValues) =>
  typeof server.sampleRate === "number" && Number.isFinite(server.sampleRate) ? server.sampleRate : undefined;

/**
 * A span's data: only the route template, method, status class and Sentry's own bookkeeping, each
 * from its vocabulary; the sample rate is the server's own (round 4 of #538, C10).
 */
export function closedSpanData(data: unknown, server: SentryServerValues = {}): Json | undefined {
  const d = obj(data);
  if (!d) return undefined;
  const rules: Readonly<Record<string, (value: unknown) => unknown>> = {
    "http.route": route,
    "http.request.method": method,
    "http.method": method,
    "http.response.status_code": statusClass,
    "http.status_code": statusClass,
    "sentry.op": (v) => coded(v, SPAN_OPS),
    "sentry.origin": (v) => coded(v, ORIGINS),
    "sentry.source": (v) => coded(v, SOURCES),
    "sentry.sample_rate": () => serverSampleRate(server),
    "otel.kind": (v) => coded(v, SPAN_KINDS),
  };
  const out: Json = {};
  for (const [key, rule] of Object.entries(rules)) {
    if (Object.hasOwn(d, key)) {
      const value = rule(d[key]);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

const traceId = (id: unknown) => keyedHexId(id, 32);
const spanId = (id: unknown) => keyedHexId(id, 16);

function closedTrace(trace: unknown, server: SentryServerValues): Json | undefined {
  const t = obj(trace);
  if (!t) return undefined;
  return {
    trace_id: traceId(t.trace_id),
    span_id: spanId(t.span_id),
    parent_span_id: spanId(t.parent_span_id),
    op: coded(t.op, SPAN_OPS),
    status: coded(t.status, SPAN_STATUSES),
    origin: coded(t.origin, ORIGINS),
    data: closedSpanData(t.data, server),
  };
}

/** The contexts an event keeps: its trace (closed) and the server's own runtime; no other context leaves. */
function closedContexts(contexts: unknown, server: SentryServerValues): Json | undefined {
  const c = obj(contexts);
  if (!c) return undefined;
  const out: Json = {};
  if (c.trace) out.trace = closedTrace(c.trace, server);
  if (c.runtime) out.runtime = { ...RUNTIME };
  return out;
}

/** Tags: a tag the server set keeps its value; any other tag leaves under the closed rules. */
function closedTags(tags: unknown, server: SentryServerValues): Json | undefined {
  const t = obj(tags);
  if (!t) return undefined;
  const out: Json = {};
  for (const [key, value] of Object.entries(t)) {
    if (server.tags && Object.hasOwn(server.tags, key) && server.tags[key] === value) out[key] = value;
    else out[keyedHash(key)] = closeValue(value);
  }
  return out;
}

/**
 * The envelope header's dynamic sampling context, rebuilt from closed values only: the event's own
 * trace id as remapped (the SDK can take an error event's context from the scope's propagation
 * context while its trace context comes from the active span; the header now names the event's
 * trace), the sampling decision, and what the server set (public key, environment, release,
 * sample rate). A caller's baggage members (release, transaction, segment, replay, org) never
 * reach it. Sentry reads it from sdkProcessingMetadata after beforeSend and beforeSendTransaction
 * (@sentry/core: _processEvent, then sendEvent, then createEventEnvelope), and the rest of
 * sdkProcessingMetadata never leaves the process.
 */
function closedSamplingContext(meta: unknown, trace: Json | undefined, server: SentryServerValues): Json {
  const dsc = obj(obj(meta)?.dynamicSamplingContext);
  if (!dsc) return {};
  const out: Json = {};
  const id = (typeof trace?.trace_id === "string" ? trace.trace_id : undefined) ?? traceId(dsc.trace_id);
  if (id) out.trace_id = id;
  if (server.publicKey) out.public_key = server.publicKey;
  if (server.environment) out.environment = server.environment;
  if (server.release) out.release = server.release;
  const sampleRate = serverSampleRate(server);
  if (sampleRate !== undefined) out.sample_rate = String(sampleRate);
  if (dsc.sampled === "true" || dsc.sampled === "false") out.sampled = dsc.sampled;
  return { dynamicSamplingContext: out };
}

/**
 * The breadcrumb times closedBreadcrumb issued (the server's clock), the most recent of them: an
 * event keeps a breadcrumb's time only on membership (round 4 of #538, C11).
 */
const BREADCRUMB_WINDOW = 10_000;
const BREADCRUMB_TIMES = new Set<number>();
const BREADCRUMB_RING: Array<number | undefined> = new Array<number | undefined>(BREADCRUMB_WINDOW);
let breadcrumbSlot = 0;

function issueBreadcrumbTime(): number {
  const at = Date.now() / 1000;
  if (!BREADCRUMB_TIMES.has(at)) {
    const evicted = BREADCRUMB_RING[breadcrumbSlot];
    if (evicted !== undefined) BREADCRUMB_TIMES.delete(evicted);
    BREADCRUMB_RING[breadcrumbSlot] = at;
    BREADCRUMB_TIMES.add(at);
    breadcrumbSlot = (breadcrumbSlot + 1) % BREADCRUMB_WINDOW;
  }
  return at;
}

/**
 * A breadcrumb (Sentry's beforeBreadcrumb): its type, category and level from Sentry's vocabularies,
 * and the server's clock as its time. Its message and data never leave.
 */
export function closedBreadcrumb<T extends object>(breadcrumb: T): T {
  const b = obj(breadcrumb) ?? {};
  return {
    type: coded(b.type, BREADCRUMB_TYPES),
    category: coded(b.category, BREADCRUMB_CATEGORIES),
    level: coded(b.level, LEVELS),
    timestamp: issueBreadcrumbTime(),
  } as unknown as T;
}

/** A breadcrumb an event carries: its kind, and its time only when closedBreadcrumb issued it. */
function closedEventBreadcrumb(breadcrumb: unknown): Json {
  const b = obj(breadcrumb) ?? {};
  return {
    type: coded(b.type, BREADCRUMB_TYPES),
    category: coded(b.category, BREADCRUMB_CATEGORIES),
    level: coded(b.level, LEVELS),
    timestamp: typeof b.timestamp === "number" && BREADCRUMB_TIMES.has(b.timestamp) ? b.timestamp : undefined,
  };
}

/** Code frames as Sentry frames, oldest first: where the code is, from V8's call sites (no function name). */
function sentryFrames(frames: readonly CodeFrame[]): Json[] {
  return [...frames].reverse().map((frame) => ({
    filename: frame.file,
    abs_path: frame.file,
    lineno: frame.line,
    colno: frame.column,
    in_app: !frame.file.startsWith("node:") && !frame.file.includes("/node_modules/"),
  }));
}

/**
 * One exception value. With the original exception (the hint's, for the event's last value: the SDK
 * puts the exception it was given last), its class, message and frames are rebuilt from the error
 * itself (round 4 of #538, B5 and C9); without one, the type is kept only from ERROR_CLASSES, the
 * value is keyed, and no frame leaves. The mechanism keeps its type from Sentry's vocabulary and a
 * handled the chokepoint derives from that type (C12).
 */
function closedException(value: unknown, original: unknown): Json {
  const v = obj(value) ?? {};
  const mechanism = obj(v.mechanism);
  const mechanismType = mechanism ? coded(mechanism.type, ORIGINS) : undefined;
  const fromOriginal = original instanceof Error;
  const message = fromOriginal ? readSafely(original, "message") : undefined;
  const frames = fromOriginal ? sentryFrames(codeFrames(original)) : [];
  return {
    type: fromOriginal ? errorClassName(original) : typeof v.type === "string" ? (ERROR_CLASSES.has(v.type) ? v.type : keyedHash(v.type)) : undefined,
    value: typeof message === "string" ? closedText(message) : typeof v.value === "string" ? closedText(v.value) : undefined,
    mechanism: mechanism ? { type: mechanismType, handled: mechanismType === undefined ? undefined : MECHANISM_HANDLED.get(mechanismType) } : undefined,
    stacktrace: frames.length > 0 ? { frames } : undefined,
  };
}

/**
 * The fields every Sentry event and transaction keeps, each the server's own or keyed (round 4 of
 * #538, C7): the event id keyed (32 hex), the platform "node", the level from Sentry's vocabulary,
 * the server's environment and release, the closed contexts and sampling context. No dist (the
 * server sets none) and no sdk: after beforeSend the SDK itself adds its own name, version and
 * packages from the client's metadata (@sentry/core createEventEnvelope), the installed SDK's constants.
 */
function envelopeFields(e: Json, server: SentryServerValues): Json {
  const contexts = closedContexts(e.contexts, server);
  return {
    event_id: keyedHexId(e.event_id, 32),
    platform: "node",
    level: coded(e.level, LEVELS),
    environment: server.environment,
    release: server.release,
    contexts,
    sdkProcessingMetadata: closedSamplingContext(e.sdkProcessingMetadata, obj(contexts?.trace), server),
  };
}

/**
 * An error event rebuilt from closed fields (sentry.ts beforeSend, with its hint): the envelope
 * fields; the server's clock as its time (C11); the exception's class, message as a keyed hash and
 * frames from the original exception; the trace context, its ids remapped; closed tags and extra;
 * breadcrumbs as their kind and the times the server issued. No request, user, server name, module
 * list or context beyond the trace and runtime.
 */
export function closedSentryEvent<T extends object>(event: T, server: SentryServerValues = {}, hint?: { originalException?: unknown }): T {
  const e = obj(event) ?? {};
  const exception = obj(e.exception);
  const values = exception && Array.isArray(exception.values) ? exception.values : undefined;
  const last = values ? values.length - 1 : -1;
  const message = typeof e.message === "string" ? e.message : obj(e.message)?.formatted;
  return {
    ...envelopeFields(e, server),
    timestamp: Date.now() / 1000,
    exception: values ? { values: values.map((value, i) => closedException(value, i === last ? hint?.originalException : undefined)) } : undefined,
    message: typeof message === "string" ? closedText(message) : undefined,
    transaction: closedName(e.transaction),
    tags: closedTags(e.tags, server),
    extra: e.extra ? (closeValue(e.extra) as Json) : undefined,
    breadcrumbs: Array.isArray(e.breadcrumbs) ? e.breadcrumbs.map(closedEventBreadcrumb) : undefined,
    fingerprint: Array.isArray(e.fingerprint) ? e.fingerprint.map((f) => (typeof f === "string" ? closedText(f) : undefined)) : undefined,
  } as unknown as T;
}

/**
 * A span (a transaction's child, or a standalone span): ids remapped, the SDK's times (declared by
 * construction, see sdkTime), is_segment derived from its own ids (C12), its status, op and origin
 * from Sentry's vocabularies, its name closed and its data closed. No measurements (M3 of r2).
 */
export function closedSentrySpan<T extends object>(span: T, server: SentryServerValues = {}): T {
  const s = obj(span) ?? {};
  return {
    span_id: spanId(s.span_id),
    trace_id: traceId(s.trace_id),
    parent_span_id: spanId(s.parent_span_id),
    segment_id: spanId(s.segment_id),
    start_timestamp: sdkTime(s.start_timestamp),
    timestamp: sdkTime(s.timestamp),
    exclusive_time: sdkTime(s.exclusive_time),
    is_segment: typeof s.span_id === "string" && typeof s.segment_id === "string" ? s.span_id === s.segment_id : undefined,
    status: coded(s.status, SPAN_STATUSES),
    op: coded(s.op, SPAN_OPS),
    origin: coded(s.origin, ORIGINS),
    description: closedName(s.description),
    data: closedSpanData(s.data, server) ?? {},
  } as unknown as T;
}

/** A transaction rebuilt from closed fields: the envelope fields, the SDK's times, its route name, trace and closed spans (no measurements). */
export function closedSentryTransaction<T extends object>(event: T, server: SentryServerValues = {}): T {
  const e = obj(event) ?? {};
  const info = obj(e.transaction_info);
  return {
    ...envelopeFields(e, server),
    start_timestamp: sdkTime(e.start_timestamp),
    timestamp: sdkTime(e.timestamp),
    type: "transaction",
    transaction: closedName(e.transaction),
    transaction_info: info ? { source: coded(info.source, SOURCES) } : undefined,
    tags: closedTags(e.tags, server),
    spans: Array.isArray(e.spans) ? e.spans.map((span) => closedSentrySpan(obj(span) ?? {}, server)) : undefined,
  } as unknown as T;
}
