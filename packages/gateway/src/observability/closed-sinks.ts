/**
 * The closed schema at each sink chokepoint (N107b; see closed-schema.ts for the rules):
 *   - gatewayLoggerOptions(): pino options for the gateway's Fastify logger. Every log line's
 *     object, message, bindings, request and error leave under the closed rules;
 *   - closeConsole(): request-path console output (inside a request's scope) leaves closed too;
 *   - closedSentryEvent / closedSentryTransaction / closedSentrySpan / closedBreadcrumb: Sentry's
 *     outbound events are rebuilt from closed fields only (sentry.ts wires them).
 */
import {
  closedError,
  closedKey,
  closedMessage,
  closedText,
  closeValue,
  keyedHash,
  METHODS,
  requestScope,
  routeTemplateOf,
} from "./closed-schema.js";

// ── Logger ─────────────────────────────────────────────────────────────────

const REQ_ID = /^req-[0-9a-z]+$/;
const HASHED = /^h:[0-9a-f]{32}$/;
/** Fields of a serialized log line that are already closed (or are the logger's own). */
const LINE_SYSTEM_KEYS: ReadonlySet<string> = new Set(["level", "time", "pid", "hostname", "msg", "req", "res", "err", "responseTime"]);

/**
 * The last check on every serialized log line: a child logger's bindings (a request id, or any
 * binding a module adds) do not pass through the bindings formatter in this Fastify, so each
 * top-level string that is not already closed is closed here, and a request id must be server-made.
 */
function closedLine(line: string): string {
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (LINE_SYSTEM_KEYS.has(key)) continue;
      if (key === "reqId") {
        record.reqId = typeof value === "string" && REQ_ID.test(value) ? value : keyedHash(value);
        continue;
      }
      if (typeof value === "string" && !HASHED.test(value)) record[key] = closedText(value);
    }
    return JSON.stringify(record) + "\n";
  } catch {
    return closedText(line) + "\n";
  }
}

interface LoggedRequest {
  method?: string;
  ip?: string;
  routeOptions?: { url?: string };
}

/** A request as a log line carries it: method, route template and the client's keyed hash. */
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
    if (key === "responseTime" && typeof value === "number") {
      out[key] = value;
      continue;
    }
    const closed = closeValue(value, key, 1);
    if (closed !== undefined) out[closedKey(key)] = closed;
  }
  return out;
}

/**
 * The gateway's pino options: the request is its method, route and client hash (never a URL or a
 * header), the response its status, an error its class, code and frames, the bindings only the
 * process and a server-made request id, and every message and object under the text rule.
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
        if (bindings.reqId !== undefined) out.reqId = typeof bindings.reqId === "string" && REQ_ID.test(bindings.reqId) ? bindings.reqId : keyedHash(bindings.reqId);
        return out;
      },
      log: (obj: Record<string, unknown>) => closeLogObject(obj),
    },
    hooks: {
      streamWrite: (line: string) => closedLine(line),
      logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
        if (args.length === 0) return method.apply(this, args);
        const [first, ...rest] = args;
        if (typeof first === "string") return method.call(this, closedMessage(first, ...rest));
        if (first instanceof Error) {
          const message = rest.length > 0 && typeof rest[0] === "string" ? closedMessage(rest[0], ...rest.slice(1)) : closedText(first.message ?? "");
          return method.call(this, { err: first }, message);
        }
        if (rest.length > 0 && typeof rest[0] === "string") return method.call(this, first, closedMessage(rest[0], ...rest.slice(1)));
        return method.call(this, first);
      },
    },
  };
}

// ── Console ────────────────────────────────────────────────────────────────

let consoleClosed = false;

/**
 * Request-path console output under the closed rules: inside a request's scope (requestScope), a
 * console line is one JSON object of closed arguments; outside it (boot, timers), output is as written.
 */
export function closeConsole(): void {
  if (consoleClosed) return;
  consoleClosed = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (!requestScope.getStore()) return original(...args);
      const closed = args.map((arg) => (typeof arg === "string" ? closedText(arg) : arg instanceof Error ? closedError(arg) : closeValue(arg, "", 1)));
      original(JSON.stringify({ console: level, args: closed }));
    };
  }
}

// ── Sentry ─────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined);

/** A transaction or span name: "METHOD template" or a closed name; anything else is unmatched. */
function closedName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const http = /^([A-Z]+) (\S+)$/.exec(name);
  if (http && METHODS.has(http[1]!)) {
    const template = closedText(http[2]!);
    return template.startsWith("h:") ? `${http[1]} unmatched` : `${http[1]} ${template}`;
  }
  const text = closedText(name);
  return text.startsWith("h:") ? "unmatched" : text;
}

const SPAN_DATA_KEYS: Readonly<Record<string, (value: unknown) => unknown>> = {
  "http.route": (v) => (typeof v === "string" && !closedText(v).startsWith("h:") ? v : undefined),
  "http.request.method": (v) => (typeof v === "string" && METHODS.has(v) ? v : undefined),
  "http.method": (v) => (typeof v === "string" && METHODS.has(v) ? v : undefined),
  "http.response.status_code": (v) => (typeof v === "number" ? v : undefined),
  "http.status_code": (v) => (typeof v === "number" ? v : undefined),
  "sentry.op": (v) => (typeof v === "string" ? closedText(v) : undefined),
  "sentry.origin": (v) => (typeof v === "string" ? closedText(v) : undefined),
  "sentry.source": (v) => (typeof v === "string" ? closedText(v) : undefined),
  "sentry.sample_rate": (v) => (typeof v === "number" ? v : undefined),
  "otel.kind": (v) => (typeof v === "string" ? closedText(v) : undefined),
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

function closedTrace(trace: unknown): Json | undefined {
  const t = obj(trace);
  if (!t) return undefined;
  return {
    trace_id: t.trace_id,
    span_id: t.span_id,
    parent_span_id: t.parent_span_id,
    op: typeof t.op === "string" ? closedText(t.op) : undefined,
    status: typeof t.status === "string" ? closedText(t.status) : undefined,
    origin: typeof t.origin === "string" ? closedText(t.origin) : undefined,
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

function closedTags(tags: unknown): Json | undefined {
  const t = obj(tags);
  return t ? (closeValue(t, "tags", 1) as Json) : undefined;
}

/** A breadcrumb: its type, category and level. Its message and data never leave. */
export function closedBreadcrumb<T extends object>(breadcrumb: T): T {
  const b = breadcrumb as Json;
  return {
    type: typeof b.type === "string" ? closedText(b.type) : undefined,
    category: typeof b.category === "string" ? closedText(b.category) : undefined,
    level: b.level,
    timestamp: b.timestamp,
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
    mechanism: mechanism ? { type: typeof mechanism.type === "string" ? closedText(mechanism.type) : undefined, handled: mechanism.handled } : undefined,
    stacktrace: stacktrace ? { frames: closedFrames(stacktrace.frames) } : undefined,
  };
}

/** The envelope fields every Sentry event keeps: identity, time, platform and the SDK's own metadata. */
function envelopeFields(e: Json): Json {
  return {
    event_id: e.event_id,
    timestamp: e.timestamp,
    start_timestamp: e.start_timestamp,
    platform: e.platform,
    level: e.level,
    environment: e.environment,
    release: e.release,
    dist: e.dist,
    sdk: e.sdk,
    sdkProcessingMetadata: e.sdkProcessingMetadata,
  };
}

/**
 * An error event rebuilt from closed fields: the exception's class, message under the text rule and
 * code frames; the trace context; closed tags and extra; breadcrumbs as their kind only. No request,
 * user, server name, module list or context beyond the trace and runtime.
 */
export function closedSentryEvent<T extends object>(event: T): T {
  const e = event as Json;
  const exception = obj(e.exception);
  const message = typeof e.message === "string" ? e.message : obj(e.message)?.formatted;
  return {
    ...envelopeFields(e),
    exception: exception && Array.isArray(exception.values) ? { values: exception.values.map(closedException) } : undefined,
    message: typeof message === "string" ? closedText(message) : undefined,
    transaction: closedName(e.transaction),
    tags: closedTags(e.tags),
    extra: e.extra ? (closeValue(e.extra, "extra", 1) as Json) : undefined,
    contexts: closedContexts(e.contexts),
    breadcrumbs: Array.isArray(e.breadcrumbs) ? e.breadcrumbs.map((b) => closedBreadcrumb(b as object)) : undefined,
    fingerprint: Array.isArray(e.fingerprint) ? e.fingerprint.map((f) => (typeof f === "string" ? closedText(f) : undefined)) : undefined,
  } as unknown as T;
}

/** A span (a transaction's child, or a standalone span): ids, times, its op and closed data. */
export function closedSentrySpan<T extends object>(span: T): T {
  const s = span as Json;
  return {
    span_id: s.span_id,
    trace_id: s.trace_id,
    parent_span_id: s.parent_span_id,
    segment_id: s.segment_id,
    start_timestamp: s.start_timestamp,
    timestamp: s.timestamp,
    exclusive_time: s.exclusive_time,
    is_segment: s.is_segment,
    status: typeof s.status === "string" ? closedText(s.status) : s.status,
    op: typeof s.op === "string" ? closedText(s.op) : undefined,
    origin: typeof s.origin === "string" ? closedText(s.origin) : undefined,
    description: closedName(s.description),
    data: closedSpanData(s.data) ?? {},
    measurements: s.measurements,
  } as unknown as T;
}

/** A transaction rebuilt from closed fields: its route name, trace, measurements and closed spans. */
export function closedSentryTransaction<T extends object>(event: T): T {
  const e = event as Json;
  const info = obj(e.transaction_info);
  return {
    ...envelopeFields(e),
    type: e.type,
    transaction: closedName(e.transaction),
    transaction_info: info ? { source: typeof info.source === "string" ? closedText(info.source) : undefined } : undefined,
    contexts: closedContexts(e.contexts),
    tags: closedTags(e.tags),
    measurements: e.measurements,
    spans: Array.isArray(e.spans) ? e.spans.map((span) => closedSentrySpan(span as object)) : undefined,
  } as unknown as T;
}
