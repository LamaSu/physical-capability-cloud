/**
 * The closed schema at each sink chokepoint (N107b; see closed-schema.ts for the rules):
 *   - gatewayLoggerOptions(): pino options for the gateway's Fastify logger. Every log line's
 *     object, message, bindings, request and error leave under the closed rules, and the last pass
 *     over the serialized line closes whatever reached it any other way (a child logger's bindings);
 *   - closeConsole(): request-path console output (inside a request's scope) leaves closed too;
 *   - closedSentryEvent / closedSentryTransaction / closedSentrySpan / closedBreadcrumb: Sentry's
 *     outbound events are rebuilt from closed fields only, trace and span ids remapped under the
 *     telemetry key and the envelope's sampling context rebuilt (sentry.ts wires them, and keeps
 *     a request's trace headers from being continued at all).
 */
import type { FastifyLogFn } from "fastify";
import { hostname } from "node:os";
import { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  closedError,
  closedMessage,
  closedText,
  closeField,
  closeValue,
  declare,
  emitted,
  isDeclared,
  keyedHash,
  keyedHexId,
  METHODS,
  requestScope,
  routeTemplateOf,
  routeTemplates,
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

// ── Request ids ────────────────────────────────────────────────────────────

let issued = 0;

/**
 * The gateway's request ids (Fastify's genReqId): req-<n> in base 36, as Fastify's default makes
 * them. The line pass keeps a request id only when this process issued it.
 */
export function issueRequestId(): string {
  issued = (issued + 1) & 0x7fffffff;
  return `req-${issued.toString(36)}`;
}

function isIssuedRequestId(value: unknown): boolean {
  if (typeof value !== "string" || !value.startsWith("req-")) return false;
  const n = Number.parseInt(value.slice(4), 36);
  return Number.isSafeInteger(n) && n >= 1 && n <= issued && value === `req-${n.toString(36)}`;
}

// ── Logger ─────────────────────────────────────────────────────────────────

const HOSTNAME = hostname();

/** Fastify's own messages, kept only on Fastify's own records (frameworkRecord). */
const FRAMEWORK_MESSAGES: ReadonlySet<string> = new Set(["incoming request", "request completed"]);

/**
 * What the current log call's own chokepoints produced. One pino write is synchronous: logMethod
 * closes the message, formatters.log the object, and the line pass reads both before the next call.
 */
let writing: { msg: string | undefined; keys: ReadonlySet<string> } | undefined;

/**
 * Fastify's own records ("incoming request", "request completed", its error records): an object
 * whose req is the request's own stream or whose res is the server's own response, which nothing
 * parsed from a request can be. Its response time is a measurement the server made.
 */
function frameworkRecord(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const req = obj.req as { raw?: unknown } | undefined;
  const res = obj.res as { raw?: unknown } | undefined;
  const own = (req && typeof req === "object" && req.raw instanceof Readable) || (res && typeof res === "object" && res.raw instanceof ServerResponse);
  if (!own) return undefined;
  return typeof obj.responseTime === "number" ? { ...obj, responseTime: declare.metric(obj.responseTime) } : obj;
}

/**
 * The last pass over every serialized log line. A child logger's bindings are serialized when the
 * child is made (pino resets the bindings formatter for a child), so they reach the line without
 * passing any other chokepoint: every field the call's own chokepoints did not produce is closed
 * here, recursively, nested objects and arrays included. The logger's own fields are written by the
 * server (time, pid, hostname), and a request id must be one this process issued.
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
        out.level = typeof value === "number" ? value : keyedHash(value);
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
        out.msg = own && (value === own.msg || own.keys.has("msg")) ? value : keyedHash(value);
        break;
      case "reqId":
        out.reqId = isIssuedRequestId(value) ? value : keyedHash(value);
        break;
      case "req":
      case "res":
      case "err":
        // Their serializers built them, for an object's fields and a binding's alike.
        out[key] = value;
        break;
      default:
        if (own?.keys.has(key)) {
          out[key] = value;
        } else {
          const closed = closeValue(value);
          if (closed !== undefined) out[keyedHash(key)] = closed;
        }
    }
  }
  return JSON.stringify(out) + "\n";
}

interface LoggedRequest {
  method?: string;
  ip?: string;
  routeOptions?: { url?: string };
}

/** A request as a log line carries it, built here: method, route template and the client's keyed hash. */
export function closedRequest(req: LoggedRequest | undefined): Record<string, unknown> {
  if (!req || typeof req !== "object") return {};
  return {
    method: typeof req.method === "string" && METHODS.has(req.method) ? req.method : "OTHER",
    route: routeTemplateOf(req),
    ...(typeof req.ip === "string" ? { client: keyedHash(req.ip) } : {}),
  };
}

/** A log object under the closed rules; the req, res and err keys go to their serializers. */
export function closeLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "req" || key === "res" || key === "err") {
      out[key] = value;
      continue;
    }
    const closed = closeField(value, 1);
    if (closed.value !== undefined) out[closed.declared ? key : keyedHash(key)] = closed.value;
  }
  if (writing) writing.keys = new Set(Object.keys(out).filter((key) => key !== "req" && key !== "res" && key !== "err"));
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
      req: (req: LoggedRequest) => closedRequest(req),
      res: (res: { statusCode?: unknown }) => ({ statusCode: typeof res?.statusCode === "number" ? res.statusCode : undefined }),
      err: (err: unknown) => {
        const closed = closedError(err);
        return {
          ...closed,
          type: String(closed.type),
          message: typeof closed.message === "string" ? closed.message : "",
          stack: Array.isArray(closed.stack) ? closed.stack.join("\n") : "",
        };
      },
    },
    formatters: {
      bindings: (bindings: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        if (typeof bindings.pid === "number") out.pid = bindings.pid;
        if (typeof bindings.hostname === "string") out.hostname = bindings.hostname;
        if (bindings.reqId !== undefined) out.reqId = isIssuedRequestId(bindings.reqId) ? bindings.reqId : keyedHash(bindings.reqId);
        return out;
      },
      log: (obj: Record<string, unknown>) => closeLogObject(obj),
    },
    hooks: {
      streamWrite: (line: string) => closedLine(line),
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        const [first, ...rest] = args;
        let call: unknown[];
        if (args.length === 0) {
          call = [];
        } else if (first instanceof Error) {
          call = [{ err: first }, rest.length > 0 ? closedMessage(rest[0], ...rest.slice(1)) : closedText(first.message ?? "")];
        } else if (first !== null && typeof first === "object" && !isDeclared(first)) {
          const framework = frameworkRecord(first as Record<string, unknown>);
          const message = rest.length === 0 ? undefined
            : framework && typeof rest[0] === "string" && FRAMEWORK_MESSAGES.has(rest[0]) ? rest[0]
            : closedMessage(rest[0], ...rest.slice(1));
          call = message === undefined ? [framework ?? first] : [framework ?? first, message];
        } else {
          call = [closedMessage(first, ...rest)];
        }
        const msg = call.length === 1 && typeof call[0] === "string" ? call[0] : typeof call[1] === "string" ? call[1] : undefined;
        writing = { msg, keys: new Set() };
        return method.apply(this, call);
      },
    },
  };
}

// ── Console ────────────────────────────────────────────────────────────────

let consoleClosed = false;

/**
 * Request-path console output under the closed rules: inside a request's scope (requestScope), a
 * console line is one JSON object of closed arguments; outside it (boot, timers), output is as
 * written, a declared argument as its text.
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
  "manual", "generic", "chained", "instrument", "onerror", "onunhandledrejection", "onuncaughtexception",
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
const LEVELS: ReadonlySet<string> = new Set(["fatal", "error", "warning", "log", "info", "debug"]);
const BREADCRUMB_TYPES: ReadonlySet<string> = new Set(["default", "debug", "error", "navigation", "http", "info", "query", "transaction", "ui", "user"]);
const BREADCRUMB_CATEGORIES: ReadonlySet<string> = new Set([
  "console", "http", "fetch", "xhr", "navigation", "ui.click", "ui.input", "sentry.event", "sentry.transaction", "query",
]);

const httpStatus = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined);

/** A route field Sentry built: a template the app declared, or unmatched. */
const route = (v: unknown) => (typeof v === "string" && routeTemplates().has(v) ? v : undefined);

/** A transaction or span name: "METHOD template" or a declared route; anything else is unmatched. */
function closedName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const http = /^([A-Z]+) (\S+)$/.exec(name);
  if (http && METHODS.has(http[1]!)) return `${http[1]} ${route(http[2]) ?? "unmatched"}`;
  return route(name) ?? "unmatched";
}

const SPAN_DATA_KEYS: Readonly<Record<string, (value: unknown) => unknown>> = {
  "http.route": route,
  "http.request.method": (v) => (typeof v === "string" && METHODS.has(v) ? v : undefined),
  "http.method": (v) => (typeof v === "string" && METHODS.has(v) ? v : undefined),
  "http.response.status_code": httpStatus,
  "http.status_code": httpStatus,
  "sentry.op": (v) => coded(v, SPAN_OPS),
  "sentry.origin": (v) => coded(v, ORIGINS),
  "sentry.source": (v) => coded(v, SOURCES),
  "sentry.sample_rate": (v) => (typeof v === "number" && v >= 0 && v <= 1 ? v : undefined),
  "otel.kind": (v) => coded(v, SPAN_KINDS),
};

/** A span's data: only the route template, method, status and Sentry's own bookkeeping. */
export function closedSpanData(data: unknown): Json | undefined {
  const d = obj(data);
  if (!d) return undefined;
  const out: Json = {};
  for (const [key, rule] of Object.entries(SPAN_DATA_KEYS)) {
    if (key in d) {
      const value = rule(d[key]);
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

const traceId = (id: unknown) => keyedHexId(id, 32);
const spanId = (id: unknown) => keyedHexId(id, 16);

function closedTrace(trace: unknown): Json | undefined {
  const t = obj(trace);
  if (!t) return undefined;
  return {
    trace_id: traceId(t.trace_id),
    span_id: spanId(t.span_id),
    parent_span_id: spanId(t.parent_span_id),
    op: coded(t.op, SPAN_OPS),
    status: coded(t.status, SPAN_STATUSES),
    origin: coded(t.origin, ORIGINS),
    data: closedSpanData(t.data),
  };
}

function closedContexts(contexts: unknown): Json | undefined {
  const c = obj(contexts);
  if (!c) return undefined;
  const out: Json = {};
  if (c.trace) out.trace = closedTrace(c.trace);
  const runtime = obj(c.runtime);
  if (runtime) out.runtime = { name: runtime.name, version: runtime.version };
  return out;
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
  if (typeof server.sampleRate === "number" && Number.isFinite(server.sampleRate)) out.sample_rate = String(server.sampleRate);
  if (dsc.sampled === "true" || dsc.sampled === "false") out.sampled = dsc.sampled;
  return { dynamicSamplingContext: out };
}

/** A breadcrumb: its type, category and level from Sentry's vocabularies, and its time. Its message and data never leave. */
export function closedBreadcrumb<T extends object>(breadcrumb: T): T {
  const b = breadcrumb as Json;
  return {
    type: coded(b.type, BREADCRUMB_TYPES),
    category: coded(b.category, BREADCRUMB_CATEGORIES),
    level: coded(b.level, LEVELS),
    timestamp: typeof b.timestamp === "number" ? b.timestamp : undefined,
  } as unknown as T;
}

function closedFrames(frames: unknown): Json[] | undefined {
  if (!Array.isArray(frames)) return undefined;
  return frames.map((frame) => {
    const f = obj(frame) ?? {};
    return {
      filename: f.filename,
      abs_path: f.abs_path,
      module: f.module,
      function: f.function,
      lineno: f.lineno,
      colno: f.colno,
      in_app: f.in_app,
    };
  });
}

function closedException(value: unknown): Json {
  const v = obj(value) ?? {};
  const mechanism = obj(v.mechanism);
  const stacktrace = obj(v.stacktrace);
  return {
    type: typeof v.type === "string" && /^[A-Z][A-Za-z0-9]{0,63}$/.test(v.type) ? v.type : "Error",
    value: typeof v.value === "string" ? closedText(v.value) : undefined,
    mechanism: mechanism ? { type: coded(mechanism.type, ORIGINS), handled: typeof mechanism.handled === "boolean" ? mechanism.handled : undefined } : undefined,
    stacktrace: stacktrace ? { frames: closedFrames(stacktrace.frames) } : undefined,
  };
}

/** The fields every Sentry event keeps: identity, time, platform and the SDK's own metadata. */
function envelopeFields(e: Json, server: SentryServerValues): Json {
  const contexts = closedContexts(e.contexts);
  return {
    event_id: e.event_id,
    timestamp: e.timestamp,
    start_timestamp: e.start_timestamp,
    platform: e.platform,
    level: coded(e.level, LEVELS),
    environment: e.environment,
    release: e.release,
    dist: e.dist,
    sdk: e.sdk,
    contexts,
    sdkProcessingMetadata: closedSamplingContext(e.sdkProcessingMetadata, obj(contexts?.trace), server),
  };
}

/**
 * An error event rebuilt from closed fields: the exception's class, its message as a keyed hash and
 * its code frames; the trace context, its ids remapped; closed tags and extra; breadcrumbs as their
 * kind only. No request, user, server name, module list or context beyond the trace and runtime.
 */
export function closedSentryEvent<T extends object>(event: T, server: SentryServerValues = {}): T {
  const e = event as Json;
  const exception = obj(e.exception);
  const message = typeof e.message === "string" ? e.message : obj(e.message)?.formatted;
  return {
    ...envelopeFields(e, server),
    exception: exception && Array.isArray(exception.values) ? { values: exception.values.map(closedException) } : undefined,
    message: typeof message === "string" ? closedText(message) : undefined,
    transaction: closedName(e.transaction),
    tags: closedTags(e.tags, server),
    extra: e.extra ? (closeValue(e.extra) as Json) : undefined,
    breadcrumbs: Array.isArray(e.breadcrumbs) ? e.breadcrumbs.map((b) => closedBreadcrumb(b as object)) : undefined,
    fingerprint: Array.isArray(e.fingerprint) ? e.fingerprint.map((f) => (typeof f === "string" ? closedText(f) : undefined)) : undefined,
  } as unknown as T;
}

/** A span (a transaction's child, or a standalone span): ids remapped, times, its op and closed data. */
export function closedSentrySpan<T extends object>(span: T): T {
  const s = span as Json;
  return {
    span_id: spanId(s.span_id),
    trace_id: traceId(s.trace_id),
    parent_span_id: spanId(s.parent_span_id),
    segment_id: spanId(s.segment_id),
    start_timestamp: s.start_timestamp,
    timestamp: s.timestamp,
    exclusive_time: s.exclusive_time,
    is_segment: typeof s.is_segment === "boolean" ? s.is_segment : undefined,
    status: coded(s.status, SPAN_STATUSES),
    op: coded(s.op, SPAN_OPS),
    origin: coded(s.origin, ORIGINS),
    description: closedName(s.description),
    data: closedSpanData(s.data) ?? {},
    measurements: s.measurements,
  } as unknown as T;
}

/** A transaction rebuilt from closed fields: its route name, trace, measurements and closed spans. */
export function closedSentryTransaction<T extends object>(event: T, server: SentryServerValues = {}): T {
  const e = event as Json;
  const info = obj(e.transaction_info);
  return {
    ...envelopeFields(e, server),
    type: e.type,
    transaction: closedName(e.transaction),
    transaction_info: info ? { source: coded(info.source, SOURCES) } : undefined,
    tags: closedTags(e.tags, server),
    measurements: e.measurements,
    spans: Array.isArray(e.spans) ? e.spans.map((span) => closedSentrySpan(span as object)) : undefined,
  } as unknown as T;
}
