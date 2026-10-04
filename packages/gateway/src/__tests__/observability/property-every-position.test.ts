/**
 * N107b round 4: the PR steward's escalated PROPERTY (bus #6139, board v3.456). Every emitted leaf,
 * KEY and VALUE, at any depth, in every sink, is either a producer declaration or keyed: no value is
 * kept because of its key's name, its shape, its type or its range.
 *
 * One generator builds the poisoned inputs: a marker (a string, and the number 8675309) in every
 * position. A position is every key and every leaf, at depths 0 to 3, inside arrays, inside an Error
 * (its message, code, statusCode, name, an own constructor, a class named by the marker, frames
 * forged through the message or the name, an assigned stack, a cause), inside a Date and inside other
 * types (Map, Set, RegExp, URL, Buffer, boxed values, symbols, functions, getters, toJSON). Every sink
 * entry point gets every position:
 *   - the real pino logger under gatewayLoggerOptions (through Fastify): call fields, the message and
 *     its printf arguments, an error as the call, child bindings (req, res, err, level, reqId, msg,
 *     time, pid, hostname and any other name), a child's own serializers and message prefix, a
 *     route's own log serializers, a forged request or reply, and real requests carrying the marker;
 *   - closeValue and closedError;
 *   - closedSentryEvent, closedSentryTransaction, closedSentrySpan and closedBreadcrumb: every field,
 *     contexts, measurements, tags, extra, sdk, environment, release, dist, event_id, exception
 *     values and frames, spans and their data included, with and without an original exception;
 *   - the PostHog boundary (posthog-node mocked: every capture and identify is recorded);
 *   - the audit service, each stored row read back;
 *   - the structured log, written directly and through POST /api/telemetry/emit then
 *     GET /api/telemetry/logs;
 *   - console output in a request's scope;
 *   - the trace collector (trace-collector.ts and its producers' helpers in tracing.ts): every field
 *     a span stores (its ids, parent, operation, description, service, attributes, status and end
 *     time), read back through getRecentTraces and getTrace, GET /api/traces, /api/traces/:traceId
 *     and the stream's snapshot (N107b round 5).
 * The assertion, for each entry point: neither the marker string nor the marker number appears
 * anywhere in any output, and every input produced output (no sink passes by writing nothing).
 * Positive controls show that declared values and the server's own values stay readable.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";

const posthogCaptures = vi.hoisted(() => [] as unknown[]);
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(event: unknown) {
      posthogCaptures.push(event);
    }
    identify(event: unknown) {
      posthogCaptures.push(event);
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));

vi.setConfig({ testTimeout: 300_000 });

// ── The marker ────────────────────────────────────────────────────────────

// Built at runtime. The string passes every shape a chokepoint ever trusted: a class name
// (/^[A-Z][A-Za-z0-9]*$/), a frame's function name and file, base 36.
const MARK = ["Zq", "8675309", "mk"].join("");
const NUM = 8675309;

/** What of the marker a text carries: its string (in any case), or its number standing alone. */
function markerIn(text: string): string[] {
  const out: string[] = [];
  if (/zq8675309mk/i.test(text)) out.push("string");
  if (/(?<![0-9A-Za-z])8675309(?![0-9A-Za-z])/.test(text)) out.push("number");
  return out;
}

/** Any output as text, with nothing hidden: a bigint, symbol, function, Map or Set shows itself. */
function render(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, item: unknown) => {
        if (typeof item === "bigint") return item.toString();
        if (typeof item === "symbol") return String(item);
        if (typeof item === "function") return `[function ${item.name}]`;
        if (item instanceof Map) return { map: [...item.entries()] };
        if (item instanceof Set) return { set: [...item.values()] };
        return item;
      }) ?? "<nothing>"
    );
  } catch (error) {
    return `<unrenderable ${String(error)}>`;
  }
}

// ── The generator ─────────────────────────────────────────────────────────

type Make = () => unknown;

const FRAME = `\n    at ${MARK} (/srv/${MARK}/app.js:${NUM}:7)`;

/** Every leaf a marker can be, of every type. */
const LEAF_KINDS: Record<string, Make> = {
  string: () => MARK,
  prose: () => `a caller wrote ${MARK} here`,
  frameText: () => `text${FRAME}`,
  numericString: () => String(NUM),
  number: () => NUM,
  fraction: () => NUM / 1e7,
  float: () => NUM + 0.25,
  negative: () => -NUM,
  bigint: () => BigInt(NUM),
  boolean: () => true,
  null: () => null,
  dateMs: () => new Date(NUM),
  dateSeconds: () => new Date(NUM * 1000),
  dateWithProps: () => Object.assign(new Date(0), { [MARK]: MARK, n: NUM }),
  boxedString: () => new String(MARK),
  boxedNumber: () => new Number(NUM),
  map: () => new Map<unknown, unknown>([[MARK, MARK], ["n", NUM]]),
  set: () => new Set<unknown>([MARK, NUM]),
  regexp: () => new RegExp(MARK),
  url: () => new URL(`https://x.test/${MARK}?n=${NUM}`),
  buffer: () => Buffer.from(MARK),
  typedArray: () => new Float64Array([NUM]),
  symbol: () => Symbol(MARK),
  symbolKey: () => ({ [Symbol(MARK)]: MARK }),
  namedFunction: () => ({ [MARK]: () => NUM })[MARK],
  toJSON: () => ({ toJSON: () => MARK }),
  toStringValue: () => ({ toString: () => MARK, valueOf: () => NUM }),
  getter: () => Object.defineProperty({}, MARK, { enumerable: true, get: () => MARK }),
  nullPrototype: () => Object.assign(Object.create(null) as object, { [MARK]: MARK, n: NUM }),
  classInstance: () => new (({ [MARK]: class { v = MARK; n = NUM } })[MARK])(),
  markerKeyed: () => ({ [MARK]: MARK, n: NUM }),
  array: () => [MARK, NUM, [MARK, [NUM]], { [MARK]: NUM }],
  sparseArray: () => {
    const items: unknown[] = [];
    items[3] = MARK;
    return items;
  },
};

/** Every place in an error a marker can hide. */
const ERROR_KINDS: Record<string, Make> = {
  errorMessage: () => new Error(MARK),
  errorCode: () => Object.assign(new Error("x"), { code: MARK }),
  errorNumericCode: () => Object.assign(new Error("x"), { code: NUM }),
  errorStatusCode: () => Object.assign(new Error("x"), { statusCode: NUM }),
  errorStatus: () => Object.assign(new Error("x"), { status: NUM }),
  errorName: () => Object.assign(new Error("x"), { name: MARK }),
  errorOwnConstructor: () => Object.assign(new Error("x"), { constructor: { name: MARK } }),
  errorMarkerClass: () => new (({ [MARK]: class extends Error {} })[MARK])("x"),
  errorFramesInMessage: () => new Error(`x${FRAME}`),
  errorFramesInName: () => {
    const error = new Error("");
    error.name = `Error${FRAME}`;
    return error;
  },
  errorAssignedStack: () => {
    const error = new Error("x");
    error.stack = `Error: x${FRAME}`;
    return error;
  },
  errorMessageChangedAfterStack: () => {
    const error = new Error(`x${FRAME}`);
    void error.stack;
    error.message = "y";
    return error;
  },
  errorOwnProps: () => Object.assign(new TypeError(MARK), { [MARK]: MARK, n: NUM }),
  errorSystemLike: () => Object.assign(new Error(MARK), { code: "ECONNRESET", errno: NUM, syscall: MARK, address: MARK, port: NUM }),
  errorCause: () => new Error("outer", { cause: new Error(MARK, { cause: { [MARK]: NUM } }) }),
  errorAggregate: () => new AggregateError([new Error(MARK), MARK], MARK),
  errorLike: () => ({ name: MARK, message: MARK, code: MARK, statusCode: NUM, stack: `Error: ${MARK}${FRAME}`, constructor: { name: MARK } }),
};

const ALL_KINDS: Record<string, Make> = { ...LEAF_KINDS, ...ERROR_KINDS };

/** The kinds a JSON request body can carry. */
const JSON_KINDS: Record<string, Make> = {
  string: () => MARK,
  prose: () => `a caller wrote ${MARK} here`,
  frameText: () => `text${FRAME}`,
  numericString: () => String(NUM),
  number: () => NUM,
  fraction: () => NUM / 1e7,
  negative: () => -NUM,
  markerKeyed: () => ({ [MARK]: MARK, n: NUM }),
  array: () => [MARK, NUM, [MARK, [NUM]], { [MARK]: NUM }],
  errorLike: () => ({ name: MARK, message: MARK, code: MARK, statusCode: NUM, stack: `Error: ${MARK}${FRAME}`, constructor: { name: MARK } }),
};

/** Names a chokepoint might treat specially: a value under any of them is a value like any other. */
const SPECIAL_NAMES = [
  // the logger's own fields and Fastify's
  "level", "time", "pid", "hostname", "msg", "reqId", "req", "res", "err", "responseTime",
  // an error's
  "message", "code", "statusCode", "status", "name", "stack", "constructor", "cause", "errors",
  // Sentry's
  "event_id", "timestamp", "start_timestamp", "platform", "environment", "release", "dist", "sdk", "contexts",
  "trace", "runtime", "exception", "values", "type", "value", "mechanism", "handled", "stacktrace", "frames",
  "filename", "function", "lineno", "colno", "in_app", "tags", "extra", "transaction", "transaction_info",
  "source", "spans", "span_id", "trace_id", "parent_span_id", "segment_id", "op", "origin", "description",
  "data", "measurements", "is_segment", "exclusive_time", "breadcrumbs", "category", "sdkProcessingMetadata",
  "dynamicSamplingContext", "sampled", "sample_rate", "http.route", "http.response.status_code",
  "http.status_code", "http.method", "http.request.method", "sentry.op", "sentry.origin", "sentry.source",
  "sentry.sample_rate", "otel.kind", "service",
  // PostHog's
  "distinctId", "distinct_id", "event", "properties", "$set", "$set_once", "$groups", "groups", "uuid", "$ip", "kind",
  // the audit log's and the structured log's
  "id", "eventType", "actor", "resourceType", "resourceId", "action", "metadata", "ip", "userAgent",
  "jobId", "kernelId", "phase", "duration_ms",
  // a request's
  "method", "url", "route", "routeOptions", "raw", "headers", "query", "body", "client", "user-agent",
  // a declared value's look-alikes, and a prototype's name
  "toJSON", "toString", "__proto__",
  // the marker itself as a name
  MARK,
];

/** Object.prototype's member names (see the child bindings below). */
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

type Path = Array<string | number>;
const isContainer = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const pathLabel = (path: Path) => (path.length === 0 ? "<root>" : path.join("."));

/** Every path in a template (each container and each leaf). */
function pathsOf(value: unknown, prefix: Path = []): Path[] {
  if (!isContainer(value)) return [prefix];
  const out: Path[] = prefix.length > 0 ? [prefix] : [];
  for (const [key, item] of Object.entries(value)) out.push(...pathsOf(item, [...prefix, Array.isArray(value) ? Number(key) : key]));
  return out;
}

/** Every container in a template, the template itself included. */
function containersOf(value: unknown, prefix: Path = []): Path[] {
  if (!isContainer(value)) return [];
  const out: Path[] = [prefix];
  for (const [key, item] of Object.entries(value)) out.push(...containersOf(item, [...prefix, Array.isArray(value) ? Number(key) : key]));
  return out;
}

/** A copy of a template with one path set to a value, or a value added to one container (under the marker's key, or as an array's next item). */
function withValue(template: unknown, path: Path, value: unknown, add = false): unknown {
  const copy = structuredClone(template);
  if (!add && path.length === 0) return value;
  let node = copy as Record<string | number, unknown>;
  for (const key of add ? path : path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  if (!add) node[path[path.length - 1]!] = value;
  else if (Array.isArray(node)) node.push(value);
  else node[MARK] = value;
  return copy;
}

/** Markers under markers' keys at depths 0 to 3: every leaf kind at each depth, an object and an array at each depth. */
function markerTree(kinds: Record<string, Make>, depth = 0): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const [kind, make] of Object.entries(kinds)) node[`${MARK}-${kind}-${depth}`] = make();
  if (depth < 3) {
    node[`${MARK}-object-${depth}`] = markerTree(kinds, depth + 1);
    node[`${MARK}-array-${depth}`] = [markerTree(kinds, depth + 1), MARK, NUM];
  }
  return node;
}

interface Position {
  label: string;
  value: unknown;
}

/** Every position of a template: each path set to each kind, and at each container a marker-keyed value of each kind and a marker tree. */
function* positionsOf(template: unknown, kinds: Record<string, Make>): Generator<Position> {
  for (const path of pathsOf(template)) {
    for (const [kind, make] of Object.entries(kinds)) yield { label: `${pathLabel(path)} = ${kind}`, value: withValue(template, path, make()) };
  }
  for (const path of containersOf(template)) {
    for (const [kind, make] of Object.entries(kinds)) yield { label: `${pathLabel(path)}.<marker> = ${kind}`, value: withValue(template, path, make(), true) };
    yield { label: `${pathLabel(path)}.<marker tree>`, value: withValue(template, path, markerTree(kinds), true) };
  }
}

/** One field under every special name, of every kind. */
function* namedFields(kinds: Record<string, Make>, names: readonly string[] = SPECIAL_NAMES): Generator<Position> {
  for (const name of names) {
    for (const [kind, make] of Object.entries(kinds)) yield { label: `{${name}} = ${kind}`, value: Object.fromEntries([[name, make()]]) };
  }
}

interface Result {
  label: string;
  text: string | undefined;
}

/** The Sentry positions that are the SDK's own clock (C11): see the Sentry test below. */
const SDK_TIME_PATHS = [
  "transaction start_timestamp", "transaction timestamp",
  "transaction spans.0.start_timestamp", "transaction spans.0.timestamp", "transaction spans.0.exclusive_time",
  "span start_timestamp", "span timestamp", "span exclusive_time",
];
const SDK_TIME_POSITION = new RegExp(`^(${SDK_TIME_PATHS.map((path) => path.replace(/\./g, "\\.")).join("|")}) = `);

/**
 * The positions that leaked (or produced no output), summarized. Empty when the property holds.
 * With N107B_PROPERTY_DUMP set to a file path, every violation is appended to that file too.
 */
function violations(sink: string, results: Result[]): string {
  const bad = results.flatMap((r) => {
    if (r.text === undefined) return [`${r.label}: NO OUTPUT`];
    const found = markerIn(r.text);
    return found.length > 0 ? [`${r.label}: ${found.join("+")}`] : [];
  });
  const dump = process.env.N107B_PROPERTY_DUMP;
  if (dump) appendFileSync(dump, `## ${sink}: ${bad.length} of ${results.length} position(s)\n${bad.map((line) => `  ${line}\n`).join("")}`);
  if (bad.length === 0) return "";
  const shown = bad.slice(0, 150);
  return `${bad.length} of ${results.length} position(s):\n  ${shown.join("\n  ")}${bad.length > shown.length ? `\n  … ${bad.length - shown.length} more` : ""}`;
}

// ── Setup ─────────────────────────────────────────────────────────────────

let schema: typeof import("../../observability/closed-schema.js");
let sinks: typeof import("../../observability/closed-sinks.js");

beforeAll(async () => {
  schema = await import("../../observability/closed-schema.js");
  sinks = await import("../../observability/closed-sinks.js");
}, 60_000);

const capture = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream };
};

/** The gateway's own logger setup for a Fastify app: the closed logger options, the server's request ids, and its hooks. */
function closedApp(stream: Writable): FastifyInstance {
  const app = Fastify({ logger: { ...sinks.gatewayLoggerOptions(), stream }, genReqId: sinks.issueRequestId, requestIdHeader: false });
  const hooks = (sinks as unknown as { closedLoggerHooks?: (app: FastifyInstance) => void }).closedLoggerHooks;
  if (typeof hooks === "function") hooks(app);
  else schema.trackRouteTemplates(app);
  return app;
}

const forgedResponse = () => new ServerResponse(new IncomingMessage(new Socket()));

/** The gateway's own posthog-service, its client up (posthog-node is mocked, so captures are recorded). */
async function postHogUp(): Promise<typeof import("../../services/posthog-service.js")> {
  const service = await import("../../services/posthog-service.js");
  if (posthogCaptures.length > 0) return service;
  process.env.POSTHOG_API_KEY = ["n107b", "prop", "posthog"].join("-");
  try {
    service.initPostHog();
    for (let i = 0; i < 100 && posthogCaptures.length === 0; i++) {
      service.trackServerEvent(schema.lit("n107b_ready"), {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    delete process.env.POSTHOG_API_KEY;
  }
  return service;
}

// ── The property ──────────────────────────────────────────────────────────

describe("N107b round 4, the property: a marker in every position of every sink entry point never leaves", () => {
  it("closeValue and closedError", () => {
    const results: Result[] = [];
    const template = { field: "v", nested: { inner: "v", deeper: { deepest: "v" } }, list: ["v", { item: "v" }] };
    const closed = (label: string, run: () => unknown) => {
      try {
        results.push({ label, text: render(run()) });
      } catch (error) {
        results.push({ label: `${label} (threw ${String(error)})`, text: undefined });
      }
    };
    for (const { label, value } of positionsOf(template, ALL_KINDS)) closed(`closeValue ${label}`, () => schema.closeValue(value));
    for (const { label, value } of namedFields(ALL_KINDS)) closed(`closeValue ${label}`, () => schema.closeValue(value));
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      closed(`closeValue(${kind})`, () => schema.closeValue(make()));
      closed(`closedError(${kind})`, () => schema.closedError(make()));
      closed(`closedText(${kind})`, () => schema.closedText(make()));
      closed(`closedMessage(${kind})`, () => schema.closedMessage(make()));
      closed(`closedMessage(lit, ${kind})`, () => schema.closedMessage(schema.lit("m %s %d %j %o"), make(), make(), make(), make()));
    }
    expect(violations("closeValue and closedError", results), "positions that left the closed rules").toBe("");
  });

  it("the real pino logger under gatewayLoggerOptions: fields, messages, errors, child bindings, own serializers, forged and real requests", async () => {
    const { lines, stream } = capture();
    const app = closedApp(stream);
    // A real request's values through a handler's own logging, its child bindings and an error.
    app.get("/n107b-prop/plain/:id", async (req, reply) => {
      const query = req.query as Record<string, string>;
      req.log.info({ q: req.query, h: req.headers, p: req.params }, schema.lit("handler line"));
      req.log.child({ req: query, res: query, err: query, reqId: query.x, msg: query.x, time: query.x, level: query.x, [MARK]: query }).info(schema.lit("handler child line"));
      req.log.info({ res: reply, responseTime: Number(query.n) }, schema.lit("handler reply line"));
      req.log.info({ req, responseTime: Number(query.n) }, "incoming request");
      return { ok: true };
    });
    app.post("/n107b-prop/throws", async (req) => {
      const body = req.body as Record<string, unknown>;
      throw Object.assign(new Error(`failed for ${String(body.x)}${FRAME}`), { code: body.x, statusCode: 500 });
    });
    // A route's own log serializers: what they write is not what the gateway's serializers wrote.
    app.get(
      "/n107b-prop/own-serializers",
      {
        logSerializers: {
          req: (req: { url?: string; headers?: Record<string, unknown> }) => ({ url: req.url, ua: req.headers?.["user-agent"] }),
          res: (res: { statusCode?: number }) => ({ status: res.statusCode, n: NUM }),
        },
      },
      async () => ({ ok: true }),
    );
    await app.ready();

    const results: Result[] = [];
    const log = (label: string, run: () => void) => {
      const before = lines.length;
      try {
        run();
      } catch (error) {
        results.push({ label: `${label} (threw ${String(error)})`, text: undefined });
        return;
      }
      results.push({ label, text: lines.length > before ? lines.slice(before).join("") : undefined });
    };
    const logger = app.log as unknown as Record<string, (...args: unknown[]) => void> & { child(b: object, o?: object): Record<string, (...args: unknown[]) => void> };

    // Call fields: under every special name and the marker's name, of every kind; and every position of a nested template.
    for (const { label, value } of namedFields(ALL_KINDS)) {
      log(`fields ${label}`, () => logger.info!(value, schema.lit("fields")));
      log(`fields without a message ${label}`, () => logger.info!(value));
    }
    for (const { label, value } of positionsOf({ a: "v", nested: { b: { c: "v" } }, list: ["v", { d: "v" }] }, ALL_KINDS)) {
      log(`fields ${label}`, () => logger.warn!(value, schema.lit("tree")));
    }
    // The message: every kind as the message, after fields, as printf arguments, and in a raw template.
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      log(`message ${kind}`, () => logger.info!(make()));
      log(`message after fields ${kind}`, () => logger.info!({ k: schema.declare.metric(1) }, make()));
      log(`printf arguments ${kind}`, () => logger.info!(schema.lit("p %s %d %j %o %O"), make(), make(), make(), make(), make()));
      log(`raw template message ${kind}`, () => logger.info!(`raw ${render(make())}`));
    }
    // An error as the call, with and without a message, and under err.
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      log(`error as the call ${kind}`, () => logger.error!(make()));
      log(`error as the call with a message ${kind}`, () => logger.error!(make(), schema.lit("failed")));
      log(`err field ${kind}`, () => logger.error!({ err: make() }, schema.lit("failed")));
      log(`err field without a message ${kind}`, () => logger.error!({ err: make() }));
    }
    // Child bindings: the logger's own names, Fastify's, and any other; a grandchild; message-less lines.
    // Left out: a binding KEY named like an Object.prototype member (__proto__, constructor). pino
    // looks a binding's key up in a plain serializers object, so it runs that member as a serializer
    // (for __proto__ it throws) while making the child, before any chokepoint; nothing is written, so
    // nothing leaks, and no gateway code makes a child logger (Fastify's own binds only reqId).
    for (const { label, value } of namedFields(ALL_KINDS, SPECIAL_NAMES.filter((name) => !PROTOTYPE_NAMES.has(name)))) {
      log(`child binding ${label}`, () => logger.child(value as object).info!(schema.lit("child")));
      log(`child binding, no message ${label}`, () => logger.child(value as object).info!({ k: schema.declare.metric(1) }));
      log(`grandchild binding ${label}`, () => logger.child({ ok: 1 }).child(value as object).warn!(schema.lit("grandchild")));
    }
    // A child's own serializers, and its message prefix.
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      const own = { serializers: { req: (v: unknown) => v, res: (v: unknown) => v, err: (v: unknown) => v } };
      log(`child with its own serializers ${kind}`, () => logger.child({ req: make(), res: make(), err: make() }, own).info!(schema.lit("own serializers")));
      log(`child with its own serializers, called with fields ${kind}`, () => logger.child({}, own).info!({ req: make(), res: make(), err: make() }, schema.lit("own serializers")));
    }
    log("child with a message prefix", () => logger.child({}, { msgPrefix: MARK }).info!(schema.lit("prefixed")));
    // Forged requests and replies: a stream that is not the server's, a ServerResponse it never sent.
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      log(`forged request ${kind}`, () =>
        logger.info!({ req: { raw: new Readable({ read() {} }), method: make(), ip: make(), url: make(), routeOptions: { url: make() } }, responseTime: make() }, "incoming request"));
      log(`forged reply ${kind}`, () => logger.info!({ res: { raw: forgedResponse(), statusCode: make() }, responseTime: make() }, "request completed"));
      log(`forged ServerResponse ${kind}`, () => logger.info!({ res: Object.assign(forgedResponse(), { statusCode: 200 }), responseTime: make() }, "request completed"));
    }

    // Real requests carrying the marker in the path, query, headers and body.
    const headers = {
      "user-agent": `ordinary-client ${MARK}`,
      "x-n107b": MARK,
      cookie: `${MARK}=${NUM}`,
      referer: `https://${MARK}.test/?n=${NUM}`,
      "request-id": MARK,
      "x-request-id": MARK,
    };
    const request = async (label: string, options: Parameters<FastifyInstance["inject"]>[0]) => {
      const before = lines.length;
      await app.inject(options as never);
      results.push({ label, text: lines.length > before ? lines.slice(before).join("") : undefined });
    };
    await request("a request to a route that logs request values", { method: "GET", url: `/n107b-prop/plain/${MARK}?x=${MARK}&n=${NUM}&${MARK}=${NUM}`, headers });
    await request("a request that throws request values", { method: "POST", url: `/n107b-prop/throws?x=${MARK}`, headers, payload: { x: MARK, tree: markerTree(JSON_KINDS) } });
    await request("a request to a route with its own log serializers", { method: "GET", url: `/n107b-prop/own-serializers?x=${MARK}`, headers });
    await request("a request that matches no route", { method: "GET", url: `/n107b-prop/${MARK}/none?n=${NUM}`, headers });
    await request("an OPTIONS request to a path carrying the marker", { method: "OPTIONS", url: `/n107b-prop/plain/${MARK}`, headers });

    expect(violations("the pino logger", results), "positions that reached the log").toBe("");
    await app.close();
  });

  it("Sentry: every field of an error event, a transaction, a span and a breadcrumb", () => {
    const server = { publicKey: "srvpublic", environment: "srv-env", release: "srv-release", sampleRate: 1, tags: { service: "pcc-gateway" } };
    const data = {
      "http.route": "/x", "http.method": "GET", "http.request.method": "GET", "http.response.status_code": 200, "http.status_code": 200,
      "sentry.op": "http.server", "sentry.origin": "manual", "sentry.source": "route", "sentry.sample_rate": 1, "otel.kind": "SERVER", "url.full": "u",
    };
    const sdk = { name: "n", version: "v", integrations: ["i"], packages: [{ name: "p", version: "v" }], settings: { infer_ip: "never" } };
    const dsc = { trace_id: "t", public_key: "p", environment: "e", release: "r", transaction: "t", sampled: "true", sample_rate: "1", sample_rand: "0.5", org_id: "o", replay_id: "r", user_segment: "u" };
    const contexts = {
      trace: { trace_id: "t", span_id: "s", parent_span_id: "p", op: "http.server", status: "ok", origin: "manual", data },
      runtime: { name: "node", version: "v" }, os: { name: "o" }, app: { app_start_time: "t" }, culture: { locale: "l" },
      otel: { resource: { a: "b" } }, cloud_resource: { c: "d" }, response: { status_code: 200 }, state: { s: "t" },
    };
    const breadcrumb = { type: "default", category: "console", level: "info", message: "m", data: { a: "b", url: "u", nested: { c: "d" } }, timestamp: 1, event_id: "e" };
    const event = {
      event_id: "e", timestamp: 1, start_timestamp: 1, platform: "node", level: "error", logger: "l", environment: "e", release: "r", dist: "d",
      server_name: "s", transaction: "GET /x", message: "m", logentry: { message: "m", params: ["p"] }, sdk, contexts,
      exception: {
        values: [{
          type: "Error", value: "v", module: "m", thread_id: 1,
          mechanism: { type: "generic", handled: true, synthetic: false, data: { a: "b" }, source: "s", exception_id: 0, parent_id: 0, is_exception_group: false },
          stacktrace: { frames: [{ filename: "f", abs_path: "a", module: "m", function: "fn", lineno: 1, colno: 1, in_app: true, pre_context: ["p"], context_line: "c", post_context: ["p"], vars: { a: "b" }, platform: "node", instruction_addr: "0x0" }] },
        }],
      },
      threads: { values: [{ id: 1, name: "n", crashed: false }] },
      tags: { service: "pcc-gateway", t: "v" }, extra: { e: "v", nested: { n: "v" } },
      user: { id: "u", ip_address: "i", email: "e", username: "n", geo: { city: "c" } },
      request: { url: "u", method: "GET", headers: { a: "b" }, query_string: "q", data: "d", cookies: { a: "b" }, env: { e: "v" } },
      modules: { m: "1" }, fingerprint: ["f"], breadcrumbs: [breadcrumb], measurements: { m: { value: 1, unit: "u" } },
      debug_meta: { images: [{ code_file: "c", debug_id: "d" }] },
      sdkProcessingMetadata: { dynamicSamplingContext: dsc, normalizedRequest: { url: "u", headers: { a: "b" } }, capturedSpanScope: { s: "t" } },
    };
    const span = {
      span_id: "s", trace_id: "t", parent_span_id: "p", segment_id: "g", start_timestamp: 1, timestamp: 2, exclusive_time: 1, is_segment: false,
      status: "ok", op: "db", origin: "manual", description: "GET /x", data, measurements: { m: { value: 1, unit: "u" } },
      links: [{ trace_id: "t", span_id: "s", attributes: { a: "b" } }], profile_id: "p", tags: { a: "b" },
    };
    const transaction = {
      type: "transaction", event_id: "e", timestamp: 2, start_timestamp: 1, platform: "node", level: "info", environment: "e", release: "r", dist: "d",
      transaction: "GET /x", transaction_info: { source: "route", changes: [{ source: "url" }] }, sdk, contexts, tags: { service: "pcc-gateway", t: "v" },
      extra: { e: "v" }, measurements: { m: { value: 1, unit: "u" } }, spans: [span], sdkProcessingMetadata: { dynamicSamplingContext: dsc },
      user: { id: "u" }, request: { url: "u" }, breadcrumbs: [breadcrumb], server_name: "s", modules: { m: "1" },
    };

    const results: Result[] = [];
    const send = (label: string, run: () => unknown) => {
      try {
        results.push({ label, text: render(run()) });
      } catch (error) {
        results.push({ label: `${label} (threw ${String(error)})`, text: undefined });
      }
    };
    const closedEvent = sinks.closedSentryEvent as (event: object, server?: object, hint?: object) => object;
    const closedTransaction = sinks.closedSentryTransaction as (event: object, server?: object) => object;
    const closedSpan = sinks.closedSentrySpan as (span: object, server?: object) => object;
    for (const { label, value } of positionsOf(event, ALL_KINDS)) send(`event ${label}`, () => closedEvent(value as object, server));
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      send(`event with hint.originalException = ${kind}`, () => closedEvent(structuredClone(event), server, { originalException: make() }));
    }
    for (const { label, value } of positionsOf(transaction, ALL_KINDS)) send(`transaction ${label}`, () => closedTransaction(value as object, server));
    for (const { label, value } of positionsOf(span, ALL_KINDS)) send(`span ${label}`, () => closedSpan(value as object, server));
    for (const { label, value } of positionsOf(breadcrumb, ALL_KINDS)) send(`breadcrumb ${label}`, () => sinks.closedBreadcrumb(value as object));
    // The one declared-by-construction source (C11): a transaction's and a span's start, end and
    // exclusive times leave as the Sentry SDK took them, because no producer can supply them: no
    // gateway code passes a time to a Sentry or OpenTelemetry span API (sentry-timing-ratchet.test.ts).
    // Fed a marker directly, they keep a number and nothing else; every other position keeps nothing.
    const sdkTimes = results.filter((r) => SDK_TIME_POSITION.test(r.label));
    const leaked = violations("Sentry", results.filter((r) => !SDK_TIME_POSITION.test(r.label)));
    expect(new Set(sdkTimes.map((r) => r.label.replace(/ = .*$/, ""))), "the SDK-time positions").toEqual(new Set(SDK_TIME_PATHS));
    expect(sdkTimes.filter((r) => r.text === undefined || markerIn(r.text).includes("string")).map((r) => r.label), "an SDK time keeps only a number").toEqual([]);
    expect(leaked, "positions that reached Sentry").toBe("");
  });

  describe("the PostHog boundary", () => {
    it("the event name, the distinct id and every property, captured and identified", async () => {
      const { trackServerEvent, identifyAgent } = await postHogUp();
      expect(posthogCaptures.length, "PostHog's client is up").toBeGreaterThan(0);
      const results: Result[] = [];
      const sent = (label: string, run: () => void) => {
        const before = posthogCaptures.length;
        run();
        results.push({ label, text: posthogCaptures.length > before ? render(posthogCaptures.slice(before)) : undefined });
      };
      const track = trackServerEvent as (event: unknown, properties?: unknown, distinctId?: unknown) => void;
      const identify = identifyAgent as (distinctId: unknown, properties?: unknown) => void;
      for (const [kind, make] of Object.entries(ALL_KINDS)) {
        sent(`event name ${kind}`, () => track(make(), {}));
        sent(`distinct id ${kind}`, () => track(schema.lit("n107b_prop"), {}, make()));
        sent(`identify distinct id ${kind}`, () => identify(make(), {}));
      }
      for (const { label, value } of namedFields(ALL_KINDS)) {
        sent(`properties ${label}`, () => track(schema.lit("n107b_prop"), value));
        sent(`identify properties ${label}`, () => identify(schema.lit("n107b-id"), value));
      }
      for (const { label, value } of positionsOf({ a: "v", nested: { b: "v" }, list: ["v"] }, ALL_KINDS)) {
        sent(`properties ${label}`, () => track(schema.lit("n107b_prop"), value));
      }
      expect(violations("PostHog", results), "positions that reached PostHog").toBe("");
    });
  });

  describe("the audit service", () => {
    beforeAll(async () => {
      process.env.PCC_DB_PATH = ":memory:";
      (await import("../../db.js")).initStore({ seed: false });
    });
    afterAll(async () => {
      (await import("../../db.js")).closeStore();
    });

    it("every column of every entry, each stored row read back", async () => {
      const db = await import("../../db.js");
      const { auditService } = await import("../../services/audit-service.js");
      const latest = () => db.getRepos().auditLog.query({ limit: 1 })[0];
      const results: Result[] = [];
      const stored = (label: string, entry: Record<string, unknown>) => {
        const before = latest()?.id;
        auditService.log({ eventType: schema.lit("n107b.prop"), action: schema.lit("probe"), ...entry } as never);
        const row = latest();
        results.push({ label, text: row && row.id !== before ? render(row) : undefined });
      };
      for (const field of ["eventType", "actor", "resourceType", "resourceId", "action", "ip", "userAgent"]) {
        for (const [kind, make] of Object.entries(ALL_KINDS)) stored(`${field} = ${kind}`, { [field]: make() });
      }
      for (const { label, value } of namedFields(ALL_KINDS)) stored(`metadata ${label}`, { metadata: value });
      for (const { label, value } of positionsOf({ a: "v", nested: { b: { c: "v" } }, list: ["v", { d: "v" }] }, ALL_KINDS)) {
        stored(`metadata ${label}`, { metadata: value });
      }
      expect(violations("the audit log", results), "positions that reached the audit log").toBe("");
    });
  });

  it("the structured log: written directly, and POST /api/telemetry/emit then GET /api/telemetry/logs", async () => {
    const { logger } = await import("../../structured-logger.js");
    const results: Result[] = [];
    const write = logger as unknown as { info(...a: unknown[]): void; warn(...a: unknown[]): void; log(...a: unknown[]): void; getRecent(n: number): unknown[] };
    let count = write.getRecent(1_000_000).length;
    const logged = (label: string, run: () => void) => {
      try {
        run();
      } catch (error) {
        results.push({ label: `${label} (threw ${String(error)})`, text: undefined });
        return;
      }
      const now = write.getRecent(1_000_000).length;
      results.push({ label, text: now > count ? render(write.getRecent(now - count)) : undefined });
      count = now;
    };
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      logged(`message ${kind}`, () => write.info(make()));
      logged(`level ${kind}`, () => write.log(make(), schema.lit("level probe")));
    }
    for (const { label, value } of namedFields(ALL_KINDS)) logged(`fields ${label}`, () => write.warn(schema.lit("fields probe"), value));
    for (const { label, value } of positionsOf({ a: "v", nested: { b: { c: "v" } }, list: ["v", { d: "v" }] }, ALL_KINDS)) {
      logged(`fields ${label}`, () => write.info(schema.lit("tree probe"), value));
    }

    // Through the route, with every JSON position of the emit body.
    const { telemetryRoutes } = await import("../../routes/telemetry.js");
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      Object.assign(req, { apiKeyId: "key-n107b-prop", operatorId: "operator-n107b-prop" });
    });
    await app.register(telemetryRoutes);
    await app.ready();
    const body = { jobId: "job-prop", phase: "job_submit", status: "completed", duration_ms: 5, level: "info", source: "s", metadata: { a: "v", nested: { b: "v" }, list: ["v"] } };
    for (const { label, value } of positionsOf(body, JSON_KINDS)) {
      const before = write.getRecent(1_000_000).length;
      const res = await app.inject({ method: "POST", url: "/api/telemetry/emit", payload: value as Record<string, unknown> });
      if (res.statusCode !== 200) {
        results.push({ label: `emit ${label} (rejected ${res.statusCode}: nothing written)`, text: write.getRecent(1_000_000).length === before ? "" : undefined });
        continue;
      }
      const logs = await app.inject({ method: "GET", url: "/api/telemetry/logs?limit=1" });
      results.push({ label: `emit ${label}, then GET /api/telemetry/logs`, text: write.getRecent(1_000_000).length > before ? logs.body : undefined });
    }
    const queried = await app.inject({
      method: "GET",
      url: `/api/telemetry/logs?level=${MARK}&source=${MARK}&jobId=${MARK}&kernelId=${MARK}&search=${MARK}&after=${MARK}&before=${MARK}&limit=${NUM}`,
    });
    results.push({ label: "GET /api/telemetry/logs with a marker in every query parameter", text: queried.body });
    expect(violations("the structured log", results), "positions that reached the structured log").toBe("");
    await app.close();
  });

  it("console output in a request's scope (and, as a positive control, a declared message stays readable)", () => {
    const levels = ["log", "info", "warn", "error", "debug"] as const;
    // Spies installed before closeConsole binds the console, so they receive exactly what it writes.
    const spies = levels.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const snapshot = () => spies.map((spy) => spy.mock.calls.length);
    const since = (before: number[]) => spies.flatMap((spy, i) => spy.mock.calls.slice(before[i]));
    const results: Result[] = [];
    let declared = "";
    try {
      sinks.closeConsole();
      const inScope = (label: string, run: () => void) => {
        const before = snapshot();
        schema.requestScope.run(true, run);
        const calls = since(before);
        results.push({ label, text: calls.length > 0 ? render(calls) : undefined });
      };
      for (const [kind, make] of Object.entries(ALL_KINDS)) {
        for (const level of levels) inScope(`console.${level}(${kind})`, () => console[level](make()));
        inScope(`console.log(lit, ${kind})`, () => console.log(schema.lit("m %s %j"), make(), make()));
        inScope(`console.error(several, ${kind})`, () => console.error(make(), make(), { [MARK]: make() }));
      }
      for (const { label, value } of positionsOf({ a: "v", nested: { b: { c: "v" } }, list: ["v", { d: "v" }] }, ALL_KINDS)) {
        inScope(`console.log ${label}`, () => console.log(value));
      }
      for (const { label, value } of namedFields(ALL_KINDS)) inScope(`console.warn ${label}`, () => console.warn(value));
      const before = snapshot();
      schema.requestScope.run(true, () => console.info(schema.lit("declared console line")));
      declared = render(since(before));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(violations("console in request scope", results), "positions that reached request-path console output").toBe("");
    expect(declared, "a declared console message stays readable").toContain("declared console line");
  });

  it("the trace collector: every stored field of a span, read back through the collector, GET /api/traces, /api/traces/:traceId and the stream snapshot", async () => {
    const { traceCollector, TraceCollector } = await import("../../trace-collector.js");
    const tracing = await import("../../tracing.js");
    const { traceRoutes } = await import("../../routes/traces.js");
    const app = Fastify({ logger: false });
    // The stream route's own handler, kept to read its snapshot: it writes the snapshot and then
    // holds the connection open for good, so it is called with a reply that records what it writes.
    let streamHandler: ((req: unknown, reply: unknown) => Promise<unknown>) | undefined;
    app.addHook("onRoute", (route) => {
      if (route.url === "/api/traces/stream") streamHandler = route.handler as unknown as typeof streamHandler;
    });
    await app.register(traceRoutes);
    await app.ready();
    const collector = traceCollector as unknown as {
      startSpan(opts: Record<string, unknown>): void;
      endSpan(opts: Record<string, unknown>): void;
      getRecentTraces(limit?: number): Array<{ traceId: unknown }>;
      getTrace(id: string): unknown;
    };
    const helpers = tracing as unknown as {
      startTrace(operation: unknown, service: unknown, attributes?: unknown): { traceId: string; spanId: string };
      withSpanSync(opts: Record<string, unknown>, fn: () => unknown): unknown;
      endTrace(traceId: unknown, spanId: unknown, status: unknown, endTime?: unknown): void;
    };
    const results: Result[] = [];
    let pending: string[] = [];

    /** The stream's snapshot (the most recent traces), as its handler writes it before it holds the connection open. */
    const streamSnapshot = async () => {
      const written: string[] = [];
      const raw = new EventEmitter();
      const reply = {
        raw: { writeHead: () => undefined, write: (chunk: unknown) => written.push(String(chunk)) },
        status: () => ({ send: (body: unknown) => written.push(JSON.stringify(body)) }),
      };
      const pendingHandler = streamHandler!.call(app, { ip: "127.0.0.1", raw }, reply);
      pendingHandler.catch((error: unknown) => written.push(`<the stream handler threw ${String(error)}>`));
      await new Promise((resolve) => setImmediate(resolve));
      raw.emit("close");
      return written.join("");
    };
    const flushStream = async () => {
      if (pending.length === 0) return;
      const text = await streamSnapshot();
      const label = `the stream snapshot of: ${pending.join(" | ")}`;
      results.push({ label, text });
      if (!text.includes("event: connected")) results.push({ label: `${label} (the stream did not complete)`, text: undefined });
      pending = [];
    };
    /** Reads the newest traces back through every read path (all 50 when a variant poisons the trace id itself). */
    const readBack = async (label: string, all = false) => {
      const limit = all ? 50 : 1;
      const texts: string[] = [];
      try {
        const recent = collector.getRecentTraces(limit);
        if (recent.length === 0) {
          results.push({ label, text: undefined });
          return;
        }
        texts.push(render(recent), (await app.inject({ method: "GET", url: `/api/traces?limit=${limit}` })).body);
        for (const trace of recent) {
          let id: string;
          try {
            id = String(trace.traceId);
          } catch {
            id = "unprintable";
          }
          texts.push(render(collector.getTrace(id)), (await app.inject({ method: "GET", url: `/api/traces/${encodeURIComponent(id)}` })).body);
        }
      } catch (error) {
        // A read that throws (the collector cannot even list its traces) is a sink that broke.
        results.push({ label: `${label} (a read threw ${String(error)})`, text: undefined });
        return;
      }
      results.push({ label, text: texts.join("\n") });
      pending.push(label);
      if (pending.length >= 20) await flushStream();
    };
    const base = () => ({
      traceId: TraceCollector.newTraceId(),
      spanId: TraceCollector.newSpanId(),
      operation: schema.lit("n107b.prop.operation"),
      service: schema.lit("n107b"),
      description: schema.lit("n107b description"),
      attributes: { count: schema.declare.metric(1) },
    });
    const span = async (label: string, opts: Record<string, unknown>, end: Record<string, unknown> = {}, all = false) => {
      try {
        collector.startSpan(opts);
        collector.endSpan({ traceId: opts.traceId, spanId: opts.spanId, status: "ok", ...end });
      } catch (error) {
        results.push({ label: `${label} (threw ${String(error)})`, text: undefined });
        return;
      }
      await readBack(label, all);
    };
    // Every field a span stores: its ids, its parent's id, its operation, description and service.
    for (const field of ["traceId", "spanId", "parentSpanId", "operation", "description", "service"]) {
      for (const [kind, make] of Object.entries(ALL_KINDS)) await span(`startSpan ${field} = ${kind}`, { ...base(), [field]: make() }, {}, field === "traceId");
    }
    // Every attribute key and value, at every depth.
    for (const { label, value } of namedFields(ALL_KINDS)) await span(`attributes ${label}`, { ...base(), attributes: value });
    for (const { label, value } of positionsOf({ a: "v", nested: { b: { c: "v" } }, list: ["v", { d: "v" }] }, ALL_KINDS)) {
      await span(`attributes ${label}`, { ...base(), attributes: value });
    }
    // What endSpan stores: the status and the end time.
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      await span(`endSpan status = ${kind}`, base(), { status: make() });
      await span(`endSpan endTime = ${kind}`, base(), { endTime: make() });
    }
    // The producers' helpers (tracing.ts).
    const viaStartTrace = async (label: string, start: () => { traceId: string; spanId: string }, status: unknown = "ok", endTime?: unknown) => {
      try {
        const { traceId, spanId } = start();
        helpers.endTrace(traceId, spanId, status, endTime);
      } catch (error) {
        results.push({ label: `${label} (threw ${String(error)})`, text: undefined });
        return;
      }
      await readBack(label);
    };
    for (const [kind, make] of Object.entries(ALL_KINDS)) {
      await viaStartTrace(`startTrace operation = ${kind}`, () => helpers.startTrace(make(), schema.lit("n107b")));
      await viaStartTrace(`startTrace service = ${kind}`, () => helpers.startTrace(schema.lit("n107b.op"), make()));
      await viaStartTrace(`startTrace attributes = ${kind}`, () => helpers.startTrace(schema.lit("n107b.op"), schema.lit("n107b"), { [MARK]: make(), a: make() }));
      await viaStartTrace(`endTrace status = ${kind}`, () => helpers.startTrace(schema.lit("n107b.op"), schema.lit("n107b")), make());
      await viaStartTrace(`endTrace endTime = ${kind}`, () => helpers.startTrace(schema.lit("n107b.op"), schema.lit("n107b")), "ok", make());
      for (const field of ["traceId", "parentSpanId", "operation", "service", "description", "attributes"]) {
        const label = `withSpanSync ${field} = ${kind}`;
        try {
          const opts = { traceId: TraceCollector.newTraceId(), operation: schema.lit("n107b.op"), service: schema.lit("n107b"), [field]: field === "attributes" ? { [MARK]: make() } : make() };
          helpers.withSpanSync(opts, () => 1);
        } catch (error) {
          results.push({ label: `${label} (threw ${String(error)})`, text: undefined });
          continue;
        }
        await readBack(label, field === "traceId");
      }
    }
    await flushStream();
    expect(violations("the trace collector", results), "positions that reached the trace collector").toBe("");
    await app.close();
  });
});

describe("N107b round 4, positive controls: declared values and the server's own values stay readable", () => {
  it("closeValue keeps every declaration under its own key", () => {
    const closed = schema.closeValue({
      count: schema.declare.metric(3),
      stage: schema.declare.code("provision", ["provision"]),
      at: schema.declare.serverTime(new Date(0)),
      ok: schema.declare.flag(true),
      text: schema.lit("hello"),
      list: schema.declare.list([schema.declare.metric(1), schema.lit("two")]),
    });
    expect(closed).toEqual({ count: 3, stage: "provision", at: "1970-01-01T00:00:00.000Z", ok: true, text: "hello", list: [1, "two"] });
  });

  it("the logger keeps a declared message and field, and a real request's method, route, status, time and issued id", async () => {
    const { lines, stream } = capture();
    const app = closedApp(stream);
    app.get("/n107b-prop/control/:id", async (req) => {
      req.log.info({ count: schema.declare.metric(7) }, schema.lit("control line"));
      return { ok: true };
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/n107b-prop/control/abc" });
    expect(res.statusCode).toBe(200);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const incoming = records.find((r) => r.msg === "incoming request")!;
    expect(incoming.req).toMatchObject({ method: "GET", route: "/n107b-prop/control/:id" });
    expect(incoming.reqId).toMatch(/^req-[0-9a-z]+$/);
    expect(incoming.level).toBe(30);
    const control = records.find((r) => r.msg === "control line")!;
    expect(control.count).toBe(7);
    expect(control.reqId).toBe(incoming.reqId);
    const completed = records.find((r) => r.msg === "request completed")!;
    expect(completed.res).toEqual({ statusCode: 200 });
    expect(typeof completed.responseTime).toBe("number");
    await app.close();
  });

  it("Sentry keeps the server's tags, the trace tree's links and a declared route name", () => {
    const closed = sinks.closedSentryTransaction({
      type: "transaction",
      transaction: "GET /n107b-prop/control/:id",
      tags: { service: "pcc-gateway" },
      contexts: { trace: { trace_id: "a".repeat(32), span_id: "b".repeat(16) } },
      spans: [{ trace_id: "a".repeat(32), span_id: "c".repeat(16), parent_span_id: "b".repeat(16) }],
    }, { tags: { service: "pcc-gateway" } }) as Record<string, any>;
    expect(closed.transaction).toBe("GET /n107b-prop/control/:id");
    expect(closed.tags).toEqual({ service: "pcc-gateway" });
    expect(closed.spans[0].parent_span_id).toBe(closed.contexts.trace.span_id);
    expect(closed.contexts.trace.trace_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("PostHog, the audit log and the structured log keep a declared name and a declared field", async () => {
    const { trackServerEvent } = await postHogUp();
    const before = posthogCaptures.length;
    trackServerEvent(schema.lit("n107b_declared"), { stage: schema.declare.code("fund", ["fund"]), count: schema.declare.metric(2) });
    const sent = posthogCaptures.slice(before) as Array<{ event: string; properties: Record<string, unknown> }>;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event).toBe("n107b_declared");
    expect(sent[0]!.properties).toMatchObject({ stage: "fund", count: 2 });
    const db = await import("../../db.js");
    db.initStore({ seed: false });
    try {
      const { auditService } = await import("../../services/audit-service.js");
      auditService.log({ eventType: schema.lit("n107b.declared"), action: schema.lit("probe"), metadata: { count: schema.declare.metric(5) } });
      expect(auditService.query({ eventType: "n107b.declared" })[0]).toMatchObject({ eventType: "n107b.declared", action: "probe", metadata: { count: 5 } });
    } finally {
      db.closeStore();
    }
  });
  it("the trace collector keeps its own ids, a declared operation, service and attribute, and the server's clock (round 5)", async () => {
    const { traceCollector, TraceCollector } = await import("../../trace-collector.js");
    const { traceRoutes } = await import("../../routes/traces.js");
    const traceId = TraceCollector.newTraceId();
    const spanId = TraceCollector.newSpanId();
    const before = Date.now();
    traceCollector.startSpan({
      traceId,
      spanId,
      operation: schema.lit("n107b.control"),
      service: schema.lit("n107b"),
      attributes: { count: schema.declare.metric(3), stage: schema.declare.code("fund", ["fund"]) },
    } as never);
    traceCollector.endSpan({ traceId, spanId, status: "ok" });
    const after = Date.now();
    const app = Fastify({ logger: false });
    await app.register(traceRoutes);
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/api/traces/${traceId}` });
    expect(res.statusCode).toBe(200);
    const { trace } = res.json() as { trace: Record<string, any> };
    expect(trace.traceId).toBe(traceId);
    expect(trace.spans[0]).toMatchObject({ spanId, operation: "n107b.control", service: "n107b", status: "ok", attributes: { count: 3, stage: "fund" } });
    expect(trace.spans[0].startTime).toBeGreaterThanOrEqual(before);
    expect(trace.spans[0].endTime).toBeLessThanOrEqual(after);
    await app.close();
  });
});
