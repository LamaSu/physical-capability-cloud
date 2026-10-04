/**
 * Cross-family review r2 of #538 (rm-n107b-538-r2-core-4c74f870, SHIP-WITH-FIXES): C1 and M4 are
 * closed; four MEDIUMs remain under M2 and M3. Each test below is the review's own cheapest
 * reproduction, written to fail at 4c74f870 and to pin the fix:
 *   M2   a child logger's reserved req/res bindings left raw (the line pass exempted them, the req
 *        serializer copied any route template, the res serializer any number);
 *   M3a  a declared value anywhere inside a container kept the container's caller-controlled key;
 *   M3b  closedError kept an error's code and statusCode raw by their spelling;
 *   M3c  Sentry transactions and standalone spans passed `measurements` through raw.
 * And the r2 codemod round (rm-n107b-538-r2-codemod-4c74f870, SHIP-WITH-FIXES):
 *   Q2   POST /api/telemetry/emit wrote the caller's duration_ms raw into the structured log that
 *        GET /api/telemetry/logs returns.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Readable, Writable } from "node:stream";
import Fastify from "fastify";

let schema: typeof import("../../observability/closed-schema.js");
let sinks: typeof import("../../observability/closed-sinks.js");

beforeAll(async () => {
  schema = await import("../../observability/closed-schema.js");
  sinks = await import("../../observability/closed-sinks.js");
}, 60_000);

const mark = (name: string) => ["n107b", "r3", name, "7e11"].join("-");
const NUMBER = 8675309;

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

describe("MEDIUM (M2, r2): a child logger's reserved req and res bindings are closed too", () => {
  it("the review's reproduction: a forged req route and res status write neither value", async () => {
    const { lines, stream } = capture();
    const app = Fastify({ logger: { ...sinks.gatewayLoggerOptions(), stream }, genReqId: sinks.issueRequestId, requestIdHeader: false });
    sinks.closedLoggerHooks(app);
    await app.ready();
    const m = mark("route");
    app.log.child({ req: { method: "GET", routeOptions: { url: m } }, res: { statusCode: NUMBER } }).info(schema.lit("probe"));
    app.log.info({ req: { method: m, url: m }, res: { statusCode: NUMBER, statusMessage: m } }, schema.lit("probe two"));
    // A forged response with a status in range: only the response's own-object check stops it.
    app.log.child({ res: { statusCode: 451 } }).info(schema.lit("probe three"));
    // A request-like object carrying a real stream is not the server's own (round 4 of #538: the
    // server registers its own requests; a stream's type proves nothing), so it is closed whole.
    const m2 = mark("streamed-route");
    app.log.info({ req: { raw: new Readable({ read() {} }), method: "GET", routeOptions: { url: m2 } } }, schema.lit("probe four"));
    const text = lines.join("");
    expect(text).toContain('"msg":"probe"');
    expect(text).toContain('"msg":"probe two"');
    expect(text).toContain('"msg":"probe three"');
    expect(text).toContain('"msg":"probe four"');
    for (const value of [m, m2, String(NUMBER), '"statusCode":451']) expect(text, value).not.toContain(value);
    await app.close();
  });

  it("a real request still logs its method, registered route and status (positive control)", async () => {
    const { lines, stream } = capture();
    const app = Fastify({ logger: { ...sinks.gatewayLoggerOptions(), stream }, genReqId: sinks.issueRequestId, requestIdHeader: false });
    sinks.closedLoggerHooks(app);
    app.get("/n107b-r3/items/:id", async () => ({ ok: true }));
    await app.ready();
    const res = await app.inject({ method: "GET", url: `/n107b-r3/items/${mark("id")}` });
    expect(res.statusCode).toBe(200);
    const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const incoming = records.find((r) => r.msg === "incoming request")!;
    expect(incoming.req).toMatchObject({ method: "GET", route: "/n107b-r3/items/:id" });
    const completed = records.find((r) => r.msg === "request completed")!;
    expect(completed.res).toEqual({ statusCode: 200 });
    expect(lines.join("")).not.toContain(mark("id"));
    await app.close();
  });
});

describe("MEDIUM (M3, r2): no value leaves raw because of its spelling or its key", () => {
  it("M3a, the review's reproduction: a declared descendant does not launder its container's key", () => {
    const m = mark("key");
    for (const value of [
      { [m]: [schema.declare.metric(1), "raw"] },
      { [m]: [schema.declare.metric(1)] },
      { [m]: { inner: schema.declare.metric(1) } },
      { outer: { [m]: { inner: schema.declare.code("A", ["A"]) } } },
    ]) {
      expect(JSON.stringify(schema.closeValue(value)), JSON.stringify(Object.keys(value))).not.toContain(m);
    }
  });

  it("M3a: a field whose value a producer declared keeps its key (positive control)", () => {
    const closed = JSON.stringify(schema.closeValue({ count: schema.declare.metric(3), kind: schema.declare.code("A", ["A"]) }));
    expect(closed).toContain('"count":3');
    expect(closed).toContain('"kind":"A"');
  });

  it("M3b, the review's reproduction: an error's code and statusCode are not trusted by their spelling", () => {
    const err = Object.assign(new Error("boom"), { code: "CALLERSECRET", statusCode: 418 });
    // Checked field by field: a keyed hash's hex can hold the digits 418 by chance (round 4 of #538).
    const [nested] = Object.values(schema.closeValue({ err }) as Record<string, Record<string, unknown>>);
    for (const closed of [nested!, schema.closedError(err)]) {
      expect(JSON.stringify(closed)).not.toContain("CALLERSECRET");
      expect(closed.code).toBe(schema.keyedHash("CALLERSECRET"));
      expect(closed.statusClass).toBe("4xx");
      expect(closed).not.toHaveProperty("statusCode");
    }
  });

  it("M3c, the review's reproduction: Sentry measurements do not pass through raw", () => {
    const m = mark("measure");
    const tx = { type: "transaction", measurements: { [m]: { value: NUMBER, unit: m } } };
    const closedTx = JSON.stringify(sinks.closedSentryTransaction(tx as never));
    expect(closedTx).not.toContain(m);
    expect(closedTx).not.toContain(String(NUMBER));
    const span = { measurements: { [m]: { value: NUMBER } } };
    const closedSpan = JSON.stringify(sinks.closedSentrySpan(span as never));
    expect(closedSpan).not.toContain(m);
    expect(closedSpan).not.toContain(String(NUMBER));
  });
});

describe("MEDIUM (Q2, codemod r2): the telemetry log carries no caller-chosen duration", () => {
  it("the review's reproduction: duration_ms from the request never reaches /api/telemetry/logs raw", async () => {
    const { telemetryRoutes } = await import("../../routes/telemetry.js");
    const app = Fastify({ logger: false });
    app.addHook("onRequest", async (req) => {
      (req as unknown as { apiKeyId: string; operatorId: string }).apiKeyId = "key-q2";
      (req as unknown as { apiKeyId: string; operatorId: string }).operatorId = "operator-q2";
    });
    await app.register(telemetryRoutes);
    await app.ready();
    const m = mark("duration");
    for (const duration_ms of [m, NUMBER]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/telemetry/emit",
        payload: { jobId: "job-q2", phase: "execution", status: "completed", duration_ms },
      });
      expect(res.statusCode).toBe(200);
    }
    // #403 (merged): the log is a job read; the admin reads every line.
    const savedAdmin = process.env.PCC_ADMIN_KEY;
    process.env.PCC_ADMIN_KEY = "n107b-r3-admin";
    try {
      const logs = await app.inject({ method: "GET", url: "/api/telemetry/logs?limit=500", headers: { "x-admin-key": "n107b-r3-admin" } });
      expect(logs.statusCode).toBe(200);
      expect(logs.body).not.toContain(m);
      expect(logs.body).not.toContain(String(NUMBER));
    } finally {
      if (savedAdmin === undefined) delete process.env.PCC_ADMIN_KEY;
      else process.env.PCC_ADMIN_KEY = savedAdmin;
    }
    await app.close();
  });
});
