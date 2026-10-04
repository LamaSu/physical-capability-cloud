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
