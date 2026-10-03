/**
 * N107b round 2 (cross-family review r1 of #538, rm-n107b-538-r1-1da7717e, DO-NOT-SHIP). Each
 * finding is reproduced here, and the rule that closes it is pinned:
 *   CRITICAL 1  caller-controlled trace and span ids, and the dynamic sampling context, left
 *               through Sentry unhashed;
 *   MEDIUM 2    a child logger's nested bindings passed the line check untouched;
 *   MEDIUM 3    trust came from a value's spelling or key: an ISO timestamp, a number under a
 *               metric-like key, or a value equal to one of the gateway's literals left raw;
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { propagation, ROOT_CONTEXT, type TextMapPropagator } from "@opentelemetry/api";

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

// Built at runtime, so no literal here looks like a secret or is one of the gateway's literals.
const mark = (name: string) => ["n107b", "r2", name, "5c1e"].join("-");
// Hex markers, valid as Sentry trace and span ids.
const TRACE = ["c0de", "c0de", "c0de", "c0de", "c0de", "c0de", "c0de", "c0de"].join("");
const SPAN = ["5ba1", "5ba1", "5ba1", "5ba1"].join("");
const PARENT = ["fa11", "fa11", "fa11", "fa11"].join("");
// A valid ISO timestamp no server would write now.
const STAMP = ["2031-07-19T04", "23", "55.817Z"].join(":");
// A number a caller chose.
const NUMBER = 8675309;
// A string the gateway's own source contains (server.ts, x402-gate.ts).
const GATEWAY_LITERAL = "[payment-gate] MPP payment check error — blocking request";

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

describe("CRITICAL 1: a caller's trace and span ids, and its sampling context, never leave raw", () => {
  it("an error event, a transaction, its spans and a standalone span: ids are remapped, the sampling context is closed", () => {
    const dsc = {
      trace_id: TRACE, public_key: mark("public"), environment: mark("env"), release: mark("release"), org_id: mark("org"),
      transaction: mark("txn"), sampled: "true", sample_rate: "0.0001", sample_rand: "0.5", user_segment: mark("segment"), replay_id: mark("replay"),
    };
    const server = { publicKey: "serverpublic", environment: "production", release: "gw-1", sampleRate: 1 };
    const event = sinks.closedSentryEvent({
      event_id: "e1",
      contexts: { trace: { trace_id: TRACE, span_id: SPAN, parent_span_id: PARENT } },
      sdkProcessingMetadata: { dynamicSamplingContext: dsc, normalizedRequest: { url: mark("url") } },
    }, server) as Record<string, any>;
    const transaction = sinks.closedSentryTransaction({
      type: "transaction",
      contexts: { trace: { trace_id: TRACE, span_id: SPAN, parent_span_id: PARENT } },
      spans: [{ trace_id: TRACE, span_id: PARENT, parent_span_id: SPAN }],
      sdkProcessingMetadata: { dynamicSamplingContext: dsc },
    }, server) as Record<string, any>;
    const span = sinks.closedSentrySpan({ trace_id: TRACE, span_id: SPAN, parent_span_id: PARENT, segment_id: SPAN }) as Record<string, any>;
    const sent = JSON.stringify([event, transaction, span]);
    for (const value of [TRACE, SPAN, PARENT, ...Object.values(dsc).filter((v) => v.startsWith("n107b")), "0.0001", mark("url")]) {
      expect(sent, value).not.toContain(value);
    }
    // The tree still links up: one mapping, at Sentry's id lengths.
    const trace = event.contexts.trace;
    expect(trace.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(trace.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.parent_span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(transaction.contexts.trace.trace_id).toBe(trace.trace_id);
    expect(transaction.spans[0].parent_span_id).toBe(trace.span_id);
    expect(transaction.spans[0].span_id).toBe(trace.parent_span_id);
    expect(span.span_id).toBe(trace.span_id);
    expect(span.segment_id).toBe(trace.span_id);
    // The envelope header's sampling context: the remapped trace id, the decision, the server's own values.
    for (const header of [event.sdkProcessingMetadata, transaction.sdkProcessingMetadata]) {
      expect(header).toEqual({
        dynamicSamplingContext: { trace_id: trace.trace_id, public_key: "serverpublic", environment: "production", release: "gw-1", sample_rate: "1", sampled: "true" },
      });
    }
  });

  it("the registered propagator never reads a request's trace headers; outgoing propagation is unchanged", async () => {
    const extracted: unknown[] = [];
    const registered: TextMapPropagator = {
      inject: (_context, carrier, setter) => setter.set(carrier, "sentry-trace", "outgoing"),
      extract: (context, carrier) => {
        extracted.push(carrier);
        return context;
      },
      fields: () => ["sentry-trace", "baggage"],
    };
    propagation.disable();
    propagation.setGlobalPropagator(registered);
    try {
      const { closeIncomingTraces } = await import("../../sentry.js");
      expect(closeIncomingTraces()).toBe(true);
      expect(closeIncomingTraces(), "a second call wraps nothing").toBe(false);
      propagation.extract(ROOT_CONTEXT, { "sentry-trace": `${TRACE}-${SPAN}-1`, traceparent: `00-${TRACE}-${SPAN}-01`, baggage: `sentry-release=${mark("bg")}` });
      expect(extracted, "the registered propagator sees a request with no trace headers").toEqual([{}]);
      const carrier: Record<string, string> = {};
      propagation.inject(ROOT_CONTEXT, carrier);
      expect(carrier).toEqual({ "sentry-trace": "outgoing" });
      expect(propagation.fields()).toEqual(["sentry-trace", "baggage"]);
    } finally {
      propagation.disable();
    }
  }, 60_000);
});

describe("MEDIUM 2: every field the call did not declare is closed on the line, a child logger's bindings included", () => {
  it("nested bindings, bindings that shadow the logger's own fields, and undeclared fields write no marker", async () => {
    const { lines, stream } = capture();
    const app = Fastify({ logger: { ...sinks.gatewayLoggerOptions(), stream }, genReqId: sinks.issueRequestId });
    const m = mark("child");
    app.get("/n107b-r2/child", async (req) => {
      req.log.child({ context: { note: (req.query as { marker?: string }).marker } }).info(schema.lit("child line"));
      return { ok: true };
    });
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/n107b-r2/child?marker=${m}` });
    expect(res.statusCode).toBe(200);
    app.log.child({ ctx: [m, { deeper: m }] }).info(schema.lit("detached line"));
    app.log.child({ time: NUMBER, pid: NUMBER, hostname: m, msg: m, reqId: `req-${m}`, level: m }).info({ count: schema.declare.metric(3) });
    app.log.info({ count: schema.declare.metric(4), at: STAMP, total: NUMBER, note: GATEWAY_LITERAL }, schema.lit("metrics line"));
    app.log.info({ at: STAMP }, GATEWAY_LITERAL);
    const text = lines.join("");
    for (const value of [m, STAMP, String(NUMBER), GATEWAY_LITERAL]) expect(text, value).not.toContain(value);
    // What the call declared, Fastify's own records and an issued request id stay readable.
    expect(text).toContain('"msg":"child line"');
    expect(text).toContain('"msg":"detached line"');
    expect(text).toContain('"msg":"request completed"');
    expect(text).toContain('"msg":"incoming request"');
    expect(text).toContain('"count":3');
    expect(text).toContain('"count":4');
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const child = records.find((r) => r.msg === "child line")!;
    expect(child.reqId).toMatch(/^req-[0-9a-z]+$/);
    expect(child, "a nested binding's key is closed too").not.toHaveProperty("context");
    const completed = records.find((r) => r.msg === "request completed")!;
    expect(typeof completed.responseTime).toBe("number");
    expect(completed.res).toEqual({ statusCode: 200 });
    for (const record of records) {
      expect(record.pid).toBe(process.pid);
      expect(typeof record.time).toBe("number");
    }
    await app.close();
  });
});

describe("MEDIUM 3: no value leaves raw because of its spelling or its key; a producer declares what may", () => {
  it("closeValue: a timestamp, a number under a metric-like key, a boolean and a value equal to a gateway literal are hashed, keys too", () => {
    const closed = JSON.stringify(schema.closeValue({ at: STAMP, count: NUMBER, total: NUMBER, status: NUMBER, ok: true, name: GATEWAY_LITERAL }));
    for (const value of [STAMP, String(NUMBER), GATEWAY_LITERAL, '"ok"', "true", '"count"', '"status"']) expect(closed, value).not.toContain(value);
  });

  it("declared fields leave as declared, under their own keys; an undeclared sibling is hashed", () => {
    const closed = schema.closeValue({
      count: schema.declare.metric(3),
      at: schema.declare.serverTime(new Date(0)),
      stage: schema.declare.code("provision", ["provision", "discover"]),
      other: schema.declare.code(mark("code"), ["provision", "discover"]),
      who: schema.declare.id(mark("who")),
      ok: schema.declare.flag(true),
      text: schema.lit("hello"),
      nested: { inner: schema.declare.metric(1), raw: mark("raw") },
      raw: mark("raw"),
    }) as Record<string, unknown>;
    expect(closed).toMatchObject({
      count: 3,
      at: "1970-01-01T00:00:00.000Z",
      stage: "provision",
      other: schema.keyedHash(mark("code")),
      who: schema.keyedHash(mark("who")),
      ok: true,
      text: "hello",
      nested: { inner: 1, [schema.keyedHash("raw")]: schema.keyedHash(mark("raw")) },
      [schema.keyedHash("raw")]: schema.keyedHash(mark("raw")),
    });
    expect(closed).not.toHaveProperty("raw");
  });

  it("a declared value cannot be forged: a look-alike, a copy, or a declared value after a JSON round trip is hashed", () => {
    const declared = schema.lit("declared text");
    const lookAlike = { toJSON: () => "declared text", toString: () => "declared text" };
    const roundTrip = JSON.parse(JSON.stringify({ v: declared })) as { v: unknown };
    expect(schema.isDeclared(declared)).toBe(true);
    for (const value of [lookAlike, { ...(declared as object) }, roundTrip.v, "declared text"]) {
      expect(schema.isDeclared(value)).toBe(false);
      expect(JSON.stringify(schema.closeValue({ v: value }))).not.toContain("declared text");
    }
    expect(schema.closedText(roundTrip.v)).toBe(schema.keyedHash("declared text"));
    expect(schema.closedText(declared)).toBe("declared text");
  });

  it("a declared message keeps its text and closes its printf arguments", () => {
    expect(schema.closedMessage(schema.lit("job %s settled"), mark("job"))).toBe(`job ${schema.keyedHash(mark("job"))} settled`);
    expect(schema.closedMessage(`job ${mark("job")} settled`)).toBe(schema.keyedHash(`job ${mark("job")} settled`));
  });

  describe("through the PostHog boundary", () => {
    beforeAll(async () => {
      process.env.POSTHOG_API_KEY = ["n107b", "r2", "posthog"].join("-");
      const { initPostHog, trackServerEvent } = await import("../../services/posthog-service.js");
      initPostHog();
      for (let i = 0; i < 50 && posthogCaptures.length === 0; i++) {
        trackServerEvent("n107b_ready", {});
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    });
    afterAll(() => {
      delete process.env.POSTHOG_API_KEY;
    });

    it("a request-derived count, timestamp or literal-equal value never reaches PostHog raw; a declared field does", async () => {
      const { trackServerEvent } = await import("../../services/posthog-service.js");
      const before = posthogCaptures.length;
      trackServerEvent("probe", { count: NUMBER, at: STAMP, name: GATEWAY_LITERAL });
      trackServerEvent(schema.lit("declared_probe"), { count: schema.declare.metric(2), stage: schema.declare.code("fund", ["fund"]) });
      const sent = posthogCaptures.slice(before) as Array<{ event: string; properties: Record<string, unknown> }>;
      expect(sent).toHaveLength(2);
      const text = JSON.stringify(sent);
      for (const value of [String(NUMBER), STAMP, GATEWAY_LITERAL, '"probe"']) expect(text, value).not.toContain(value);
      expect(sent[0]!.event).toBe(schema.keyedHash("probe"));
      expect(sent[1]!.event).toBe("declared_probe");
      expect(sent[1]!.properties).toMatchObject({ count: 2, stage: "fund", source: "gateway" });
    });
  });
});

describe("MEDIUM 3 (audit): the closed audit log", () => {
  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const db = await import("../../db.js");
    db.initStore({ seed: false });
  });
  afterAll(async () => {
    (await import("../../db.js")).closeStore();
  });

  it("MEDIUM 3: a request-derived number or timestamp in audit metadata is not stored raw; a declared field is", async () => {
    const { auditService } = await import("../../services/audit-service.js");
    auditService.log({ eventType: "http.write", action: "post", metadata: { count: NUMBER, at: STAMP, name: GATEWAY_LITERAL } });
    auditService.log({ eventType: schema.lit("n107b.declared"), action: schema.lit("probe"), metadata: { count: schema.declare.metric(5) } });
    const stored = JSON.stringify(auditService.query({ eventType: "http.write", limit: 100 }));
    for (const value of [String(NUMBER), STAMP, GATEWAY_LITERAL]) expect(stored, value).not.toContain(value);
    const [declared] = auditService.query({ eventType: "n107b.declared" });
    expect(declared).toMatchObject({ eventType: "n107b.declared", action: "probe", metadata: { count: 5 } });
  });

});
