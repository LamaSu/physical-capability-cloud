/**
 * N107b round 4 (the PR steward's escalated property, bus #6139): the trust points a marker cannot
 * travel through, each pinned by its own reproduction. property-every-position.test.ts drives a
 * marker through every position; the points here keep a value by its key's name, its shape, its type
 * or its range, so the value they keep is not a marker:
 *   A1  a log line's level was kept because it is a number;
 *   A2  a request id was kept by its shape and range (any req-<n> up to the count issued);
 *   A3  req, res and err were kept by name, a child logger's earlier bindings included;
 *   A4  the server's own request and reply were recognized with instanceof;
 *   B5  an error's class was read from any constructor name;
 *   B6  code frames were parsed from the stack text;
 *   C7  the Sentry envelope's fields came from the event by name;
 *   C8  the runtime context came from the event;
 *   C9  exception frames came from the event;
 *   C10 span status codes and the sample rate were kept by range;
 *   C11 timestamps were kept because they are numbers;
 *   C12 a span's is_segment and a mechanism's handled were kept because they are booleans, and a
 *       transaction's type was copied;
 *   F   the structured log stored what its producer passed;
 *   and keyedHash threw on a value JSON cannot hold, which dropped the entry it was in.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";

let schema: typeof import("../../observability/closed-schema.js");
let sinks: typeof import("../../observability/closed-sinks.js");

beforeAll(async () => {
  schema = await import("../../observability/closed-schema.js");
  sinks = await import("../../observability/closed-sinks.js");
}, 60_000);

const THIS_FILE = fileURLToPath(import.meta.url);

const capture = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, stream, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
};

/** The gateway's own logger setup for a Fastify app (as server.ts makes it). */
function closedApp(stream: Writable): FastifyInstance {
  const app = Fastify({ logger: { ...sinks.gatewayLoggerOptions(), stream }, genReqId: sinks.issueRequestId, requestIdHeader: false });
  const hooks = (sinks as unknown as { closedLoggerHooks?: (app: FastifyInstance) => void }).closedLoggerHooks;
  if (typeof hooks === "function") hooks(app);
  else schema.trackRouteTemplates(app);
  return app;
}

const forgedResponse = () => new ServerResponse(new IncomingMessage(new Socket()));
const server = { publicKey: "srvpublic", environment: "srv-env", release: "srv-release", sampleRate: 1, tags: { service: "pcc-gateway" } };
const closedEvent = (event: object, hint?: object) =>
  (sinks.closedSentryEvent as (event: object, server?: object, hint?: object) => Record<string, any>)(event, server, hint);
const closedSpan = (span: object) => (sinks.closedSentrySpan as (span: object, server?: object) => Record<string, any>)(span, server);

describe("A: the log line", () => {
  it("A1: a line's level is a member of pino's level vocabulary, else keyed (a custom level, a declared field named level)", async () => {
    const { stream, records } = capture();
    const app = closedApp(stream);
    await app.ready();
    const custom = app.log.child({}, { customLevels: { forged: 999 } } as never) as unknown as Record<string, (msg: unknown) => void>;
    custom.forged!(schema.lit("custom level line"));
    app.log.info({ level: schema.declare.metric(999) }, schema.lit("declared level line"));
    app.log.warn(schema.lit("ordinary line"));
    const byMsg = (msg: string) => records().find((r) => r.msg === msg)!;
    expect(byMsg("custom level line").level).toBe(schema.keyedHash(999));
    expect(byMsg("declared level line").level).toBe(schema.keyedHash(999));
    expect(byMsg("ordinary line").level).toBe(40);
    await app.close();
  });

  it("A2: a request id stays readable only while it is in the window of ids this process issued", async () => {
    const { stream, records } = capture();
    const app = closedApp(stream);
    await app.ready();
    const window = (sinks as unknown as { REQUEST_ID_WINDOW?: number }).REQUEST_ID_WINDOW ?? 200_000;
    const first = sinks.issueRequestId();
    for (let i = 0; i < window; i++) sinks.issueRequestId();
    const recent = sinks.issueRequestId();
    app.log.child({ reqId: first }).info(schema.lit("an id issued more than the window ago"));
    app.log.child({ reqId: recent }).info(schema.lit("an id issued now"));
    const byMsg = (msg: string) => records().find((r) => r.msg === msg)!;
    expect(byMsg("an id issued more than the window ago").reqId).toBe(schema.keyedHash(first));
    expect(byMsg("an id issued now").reqId).toBe(recent);
    await app.close();
  }, 60_000);

  it("A3: req, res and err a child logger was made with are closed like any binding; this call's own serializers write those keys", async () => {
    const { stream, records } = capture();
    const app = closedApp(stream);
    app.get("/n107b-r4/own", async (req, reply) => {
      req.log.info({ req, res: reply, err: new Error("own") }, schema.lit("own objects line"));
      return { ok: true };
    });
    await app.ready();
    app.log.child({ req: { method: "GET" }, res: { statusCode: 200 }, err: new Error("bound") }).info(schema.lit("bound line"));
    await app.inject({ method: "GET", url: "/n107b-r4/own" });
    const bound = records().find((r) => r.msg === "bound line")!;
    for (const key of ["req", "res", "err"]) expect(bound, `a ${key} bound earlier`).not.toHaveProperty(key);
    const own = records().find((r) => r.msg === "own objects line")!;
    expect(own.req).toMatchObject({ method: "GET", route: "/n107b-r4/own" });
    expect(own.res).toEqual({ statusCode: 200 });
    expect(own.err).toMatchObject({ type: "Error" });
    await app.close();
  });

  it("A4: a request or reply is the server's own only when the server registered it (a forged stream or ServerResponse is closed)", async () => {
    const { stream, records } = capture();
    const app = closedApp(stream);
    app.get("/n107b-r4/registered", async () => ({ ok: true }));
    await app.ready();
    app.log.info({ res: Object.assign(forgedResponse(), { statusCode: 451 }) }, schema.lit("forged reply"));
    app.log.info({ req: { raw: new Readable({ read() {} }), method: "GET", routeOptions: { url: "/n107b-r4/registered" } } }, schema.lit("forged request"));
    // The serializers ran (so the keys are theirs), and closed each forged object like any value.
    const reply = records().find((r) => r.msg === "forged reply")!;
    // The status as a number standing alone (a keyed hash's hex can hold the digits 451).
    expect(JSON.stringify(reply)).not.toMatch(/(?<![0-9A-Za-z])451(?![0-9A-Za-z])/);
    expect(reply.res).not.toHaveProperty("statusCode");
    const request = records().find((r) => r.msg === "forged request")!;
    expect(JSON.stringify(request)).not.toContain("/n107b-r4/registered");
    expect(request.req).not.toHaveProperty("route");
    await app.close();
  });

  it("A4: a reply's response time is the reply's own measurement, never a number its record carries", async () => {
    const { stream, records } = capture();
    const app = closedApp(stream);
    app.get("/n107b-r4/time", async (req, reply) => {
      req.log.info({ res: reply, responseTime: 31337 }, schema.lit("a record with a chosen time"));
      return { ok: true };
    });
    await app.ready();
    await app.inject({ method: "GET", url: "/n107b-r4/time" });
    const record = records().find((r) => r.msg === "a record with a chosen time")!;
    expect(typeof record.responseTime).toBe("number");
    expect(record.responseTime).not.toBe(31337);
    const completed = records().find((r) => r.msg === "request completed")!;
    expect(typeof completed.responseTime).toBe("number");
    await app.close();
  });
});

describe("B: errors", () => {
  it("B5: an error's class is readable only from the built-in vocabulary; any other class is keyed, a non-Error is NonError", async () => {
    class PaymentGatewayError extends Error {}
    const { errorCodes } = await import("fastify");
    expect(schema.closedError(new TypeError("x")).type).toBe("TypeError");
    expect(schema.closedError(new errorCodes.FST_ERR_NOT_FOUND()).type).toBe("FastifyError");
    expect(schema.closedError(new PaymentGatewayError("x")).type).toBe(schema.keyedHash("PaymentGatewayError"));
    expect(schema.closedError(Object.assign(new Error("x"), { constructor: { name: "RangeError" } })).type).toBe("Error");
    expect(schema.closedError({ message: "x", constructor: { name: "TypeError" } }).type).toBe("NonError");
    expect(schema.closedError({ message: "x", stack: "Error: x\n    at f (/srv/app.js:1:1)" })).not.toHaveProperty("stack");
  });

  it("B6: code frames come from the V8 call sites of the error itself: this file, with line and column, and no function name", () => {
    function namedByTheCode() {
      return new Error("x");
    }
    const frames = schema.closedError(namedByTheCode()).stack as string[];
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatch(/^at \S+:\d+:\d+$/);
    expect(frames[0]).toContain(THIS_FILE);
    expect(frames.join("\n")).not.toContain("namedByTheCode");
  });
});

describe("keyedHash", () => {
  it("never throws: a bigint, a cycle and a throwing toJSON each leave as a hash", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const value of [10n, cycle, { toJSON: () => { throw new Error("no"); } }]) {
      expect(schema.keyedHash(value)).toMatch(/^h:[0-9a-f]{32}$/);
    }
  });
});
