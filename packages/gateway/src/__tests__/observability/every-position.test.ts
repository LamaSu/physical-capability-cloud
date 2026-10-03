/**
 * N107b, the every-position test (the PR steward's ruling of 10/03, bus #5315 and #5319): a marker
 * in every position a request has, under arbitrary names, driven through the REAL gateway
 * (createGateway) and its real handlers, reaches no sink and no console line.
 *   positions: the query (several names), the fragment, encoded separators (%3F %23 %26 %3D),
 *              path segments, every header (User-Agent, Accept-Language, Referer with userinfo,
 *              X-Forwarded-For, Authorization, Cookie, a request-id, an arbitrary header), a JSON
 *              body, a form body and a prose field;
 *   handlers:  a forced 500 (Sentry, the error log, the write audit), request-path console output,
 *              the security monitor's honeypot, provision (PostHog and audit producers), a 404,
 *              a route with a path parameter, and the payment stats;
 *   sinks:     the Sentry envelope (a capture transport under the gateway's own Sentry options
 *              and init path), the gateway's log stream, stdout and stderr, every audit row, and
 *              PostHog (posthog-node mocked, so the gateway's own posthog-service runs).
 * Round 2 (cross-family review r1 of #538) adds the trace headers a caller may send (sentry-trace,
 * traceparent, baggage), a valid timestamp and a gateway literal as request values, and checks
 * that Sentry does not continue the caller's trace at all.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";

const captured = vi.hoisted(() => ({ logs: [] as string[], posthog: [] as unknown[], stdio: [] as string[] }));

// The gateway's own Fastify logger options, with only the destination captured.
vi.mock("fastify", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown> & { default: (opts?: Record<string, unknown>) => unknown };
  const { Writable } = await import("node:stream");
  const sink = new Writable({
    write(chunk, _encoding, done) {
      captured.logs.push(String(chunk));
      done();
    },
  });
  const fastify = (opts: Record<string, unknown> = {}) => {
    const logger =
      opts.logger === true
        ? { level: "info", stream: sink }
        : opts.logger && typeof opts.logger === "object"
          ? { ...(opts.logger as Record<string, unknown>), stream: sink }
          : opts.logger;
    return real.default({ ...opts, logger });
  };
  return { ...real, default: fastify, fastify };
});
vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(event: unknown) {
      captured.posthog.push(event);
    }
    identify(event: unknown) {
      captured.posthog.push(event);
    }
    shutdown() {
      return Promise.resolve();
    }
  },
}));
vi.mock("@pcc/kernel/evidence-storage-factory", () => ({
  createEvidenceStorage: vi.fn().mockResolvedValue({
    init: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockReturnValue(true),
    archiveBundle: vi.fn().mockResolvedValue({ cid: "bafytest123", metadataCid: "bafymeta456" }),
    archiveEncryptedBundle: vi.fn().mockResolvedValue({ cid: "bafyenc789", metadataCid: "bafyencmeta012" }),
    retrieveBundle: vi.fn().mockResolvedValue({}),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.setConfig({ testTimeout: 120_000 });

// Every marker is built at runtime, so no literal here looks like a secret or is a gateway literal.
const mark = (name: string) => ["n107b", "ep", name, "6d2a"].join("-");
// Round 2 (cross-family review r1 of #538): hex markers valid as trace and span ids, a valid ISO
// timestamp no server writes now, and a string the gateway's own source contains.
const hex = (unit: string, times: number) => Array.from({ length: times }, () => unit).join("");
const TRACE = hex("c0de", 8);
const SPAN = hex("5ba1", 4);
const W3C_TRACE = hex("beef", 8);
const W3C_SPAN = hex("d00d", 4);
const STAMP = ["2031-07-19T04", "23", "55.817Z"].join(":");
const GATEWAY_LITERAL = "[payment-gate] MPP payment check error — blocking request";
const DSN = "https://public@o0.ingest.sentry.io/0";

const sentryBodies: string[] = [];
let port = 0;
let app: { close(): Promise<unknown>; listen(o: { port: number; host: string }): Promise<string>; server: http.Server };

const request = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

let restoreStdio: () => void = () => {};
// The console as closeConsole binds it: spies installed before the gateway is imported.
const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
const consoleText = () => JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls));

beforeAll(async () => {
  delete process.env.SENTRY_DSN;
  delete process.env.VITE_SENTRY_DSN;
  delete process.env.TENANT_ENFORCE;
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ["n107b", "ep", "admin"].join("-");
  process.env.MOCK_SETTLEMENT = "true";
  process.env.POSTHOG_API_KEY = ["n107b", "ep", "posthog"].join("-");
  // The gateway's own Sentry options and init path; only the transport is a capture. Dedupe is off,
  // so the gateway's own capture is not hidden behind the SDK's capture of the same error.
  // The gateway's own options; before N107b there were none, only master's defaults (the reproduction).
  const sentryModule = (await import("../../sentry.js")) as {
    sentryOptions?: (dsn: string) => Sentry.NodeOptions;
    startSentry?: (options: Sentry.NodeOptions) => void;
  };
  const options: Sentry.NodeOptions = sentryModule.sentryOptions ? sentryModule.sentryOptions(DSN) : { dsn: DSN, tracesSampleRate: 1.0 };
  const start = sentryModule.startSentry ?? ((o: Sentry.NodeOptions) => void Sentry.init(o));
  start({
    ...options,
    integrations: (defaults) => {
      const own = typeof options.integrations === "function" ? options.integrations(defaults) : defaults;
      return own.filter((integration) => integration.name !== "Dedupe");
    },
    transport: (transportOptions) =>
      Sentry.createTransport(transportOptions, async (req) => {
        sentryBodies.push(typeof req.body === "string" ? req.body : Buffer.from(req.body).toString("utf8"));
        return { statusCode: 200 };
      }),
  });
  const { createGateway } = await import("../../server.js");
  const gateway = await createGateway(0);
  app = gateway.app as unknown as typeof app;
  // Stand-ins for a route that fails on a request, and one that writes request values to the
  // console (outside /api/, so no API gate).
  const routes = gateway.app as unknown as {
    post(path: string, handler: () => Promise<unknown>): void;
    get(path: string, handler: (req: { query: Record<string, unknown>; headers: Record<string, unknown> }) => Promise<unknown>): void;
  };
  routes.post("/n107b-ep/throws", async () => {
    throw new Error("n107b forced failure");
  });
  routes.get("/n107b-ep/console", async (req) => {
    console.log("echo", req.query, req.headers["user-agent"]);
    console.error(`request said ${String(req.query.zq)}`);
    return { ok: true };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  const { trackServerEvent } = await import("../../services/posthog-service.js");
  for (let i = 0; i < 50 && captured.posthog.length === 0; i++) {
    trackServerEvent("n107b_ready", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(captured.posthog.length, "PostHog's client is up").toBeGreaterThan(0);
  // Capture stdout and stderr only now, after boot.
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    captured.stdio.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    captured.stdio.push(String(chunk));
    return true;
  });
  restoreStdio = () => {
    out.mockRestore();
    err.mockRestore();
  };
  for (const spy of consoleSpies) spy.mockClear();
}, 180_000);

afterAll(async () => {
  restoreStdio();
  await app?.close();
  await Sentry.close(2000);
  (await import("../../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.MOCK_SETTLEMENT;
  delete process.env.POSTHOG_API_KEY;
});

describe("N107b: a marker in every request position reaches no sink and no console line", () => {
  it("through the real gateway: a 500, console output, the honeypot, provision, a 404, a path parameter and the stats", async () => {
    const m = {
      query: mark("query"), code: mark("code"), fragment: mark("fragment"), encoded: mark("encoded"),
      path: mark("path"), ua: mark("ua"), lang: mark("lang"), refUser: mark("refuser"), refQuery: mark("refquery"),
      xff: mark("xff"), auth: mark("auth"), cookie: mark("cookie"), reqId: mark("reqid"), custom: mark("custom"),
      json: mark("json"), prose: mark("prose"), form: mark("form"), email: mark("email"), name: mark("name"),
      capability: mark("capability"), consoleQuery: mark("consolequery"), notFound: mark("notfound"),
      traceId: TRACE, spanId: SPAN, w3cTrace: W3C_TRACE, w3cSpan: W3C_SPAN, baggageRelease: mark("bgrelease"),
      baggageTxn: mark("bgtxn"), baggageSegment: mark("bgsegment"), baggageOther: mark("bgother"), stamp: STAMP,
      literal: GATEWAY_LITERAL,
    };
    const headers = {
      "user-agent": `ordinary-client ${m.ua}`,
      "accept-language": m.lang,
      referer: `https://user:${m.refUser}@r.test/cb?zq=${m.refQuery}`,
      "x-forwarded-for": m.xff,
      authorization: `Bearer ${m.auth}`,
      cookie: `zq=${m.cookie}`,
      "request-id": m.reqId,
      "x-n107b-zq": m.custom,
      // Distributed tracing headers a caller may send (round 2, CRITICAL 1).
      "sentry-trace": `${m.traceId}-${m.spanId}-1`,
      traceparent: `00-${m.w3cTrace}-${m.w3cSpan}-01`,
      baggage: `sentry-trace_id=${m.traceId},sentry-public_key=public,sentry-release=${m.baggageRelease},sentry-transaction=${m.baggageTxn},sentry-user_segment=${m.baggageSegment},zq=${m.baggageOther}`,
    };
    const json = JSON.stringify({ password: m.json, zq: m.json, note: `the caller writes ${m.prose}` });

    // A forced 500: Sentry, the error log and the write audit.
    const failed = await request("POST", `/n107b-ep/throws?zq1=${m.query}&code=${m.code}#zq2=${m.fragment}`, { ...headers, "content-type": "application/json" }, json);
    expect(failed.status).toBe(500);
    // A second forced 500 with the same trace headers: continued, it would join the first's trace.
    const again = await request("POST", "/n107b-ep/throws", { ...headers, "content-type": "application/json" }, json);
    expect(again.status).toBe(500);
    // A form body to the same route.
    await request("POST", "/n107b-ep/throws", { ...headers, "content-type": "application/x-www-form-urlencoded" }, `zq=${m.form}&code=${m.form}`);
    // Request-path console output.
    const echoed = await request("GET", `/n107b-ep/console?zq=${m.consoleQuery}`, headers);
    expect(echoed.status).toBe(200);
    // The security monitor's honeypot.
    await request("GET", `/admin?zq=${m.query}`, headers);
    // Provision: a PostHog and audit producer that copies body fields.
    await request("POST", "/api/auth/provision", { ...headers, "content-type": "application/json" },
      JSON.stringify({ email: `${m.email}@x.test`, name: m.name, capability: m.capability }));
    // A request value that is a valid timestamp, and one equal to a gateway literal (round 2, MEDIUM 3).
    await request("POST", "/api/auth/provision", { ...headers, "content-type": "application/json" },
      JSON.stringify({ email: `${m.email}@y.test`, name: m.stamp, capability: m.literal }));
    // A 404 with encoded separators, and a route with a path parameter.
    await request("GET", `/n107b-ep/none%3Fzq%3D${m.encoded}%26code%3D${m.encoded}?zq=${m.notFound}`, headers);
    await request("GET", `/api/jobs/${m.path}`, headers);
    // The payment stats.
    await request("GET", `/api/x402/stats?zq=${m.query}`, headers);

    await Sentry.flush(5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const { auditService } = await import("../../services/audit-service.js");
    const sinks: Record<string, string> = {
      sentry: sentryBodies.join("\n"),
      log: captured.logs.join(""),
      console: consoleText() + captured.stdio.join(""),
      audit: JSON.stringify(auditService.query({ limit: 5000 })),
      posthog: JSON.stringify(captured.posthog),
    };
    // Each sink saw this traffic (so an empty sink cannot pass for a closed one).
    expect(sinks.sentry.length, "Sentry captured the 500").toBeGreaterThan(0);
    expect(sinks.log.length, "the log captured the requests").toBeGreaterThan(0);
    expect(sinks.audit).toContain("http.write");
    expect(consoleSpies.some((spy) => spy.mock.calls.length > 0), "the console route wrote").toBe(true);
    expect(captured.posthog.length).toBeGreaterThan(1);
    const found = Object.fromEntries(
      Object.entries(sinks).map(([sink, text]) => [sink, Object.entries(m).filter(([, value]) => text.includes(value)).map(([key]) => key)]),
    );
    expect(found).toEqual({ sentry: [], log: [], console: [], audit: [], posthog: [] });

    // Round 2, CRITICAL 1: Sentry does not continue the caller's trace, even remapped. Each event's
    // envelope header carries a sampling context of closed members only, for the event's own trace.
    const { keyedHash, keyedHexId } = await import("../../observability/closed-schema.js");
    const events = sentryBodies.flatMap((body) => {
      const lines = body.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
      const out: Array<{ header: Record<string, any>; type: string; item: Record<string, any> }> = [];
      for (let i = 1; i + 1 < lines.length; i += 2) out.push({ header: lines[0]!, type: lines[i]!.type, item: lines[i + 1]! });
      return out;
    });
    const traced = events.filter((e) => e.type === "event" || e.type === "transaction");
    expect(traced.length, "events and transactions were sent").toBeGreaterThan(0);
    for (const { header, item } of traced) {
      expect(item.contexts.trace.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(item.contexts.trace.trace_id, "the caller's trace is not continued").not.toBe(keyedHexId(TRACE, 32));
      if (header.trace) {
        expect(header.trace.trace_id).toBe(item.contexts.trace.trace_id);
        for (const key of Object.keys(header.trace)) expect(["trace_id", "public_key", "environment", "release", "sample_rate", "sampled"]).toContain(key);
      }
    }
    const failures = traced.filter((e) => e.type === "event" && e.item.exception?.values?.[0]?.value === keyedHash("n107b forced failure"));
    expect(new Set(failures.map((e) => e.item.contexts.trace.trace_id)).size, "the two forced 500s, sent with the same sentry-trace, are two traces").toBeGreaterThanOrEqual(2);
  });

  // N107b codemod regression (orchestrator review, round 3): declare.metric emits its number
  // RAW — it must never wrap a caller-controlled value. routes/diagnostic-logs.ts's bundleSize
  // and logLineCount come straight from the POST body; this pins them to declare.id (hashed),
  // never declare.metric, so a caller-chosen magnitude can never appear in the log in the clear.
  it("N107b regression: a caller-chosen bundleSize never reaches the log in the clear", async () => {
    const provisioned = await request(
      "POST", "/api/auth/provision", { "content-type": "application/json" },
      JSON.stringify({ email: "n107b-diag@x.test" }),
    );
    expect(provisioned.status).toBe(201);
    const apiKey = (JSON.parse(provisioned.body) as { api_key: string }).api_key;

    const before = captured.logs.join("").length;
    const CALLER_BUNDLE_SIZE = 8675309;
    const res = await request(
      "POST", "/api/operator/diagnostics",
      { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      JSON.stringify({
        kernelId: "n107b-diag-kernel",
        encrypted: { ciphertext_b64: "AAAA", iv_b64: "AAAA", salt_b64: "AAAA", tag_b64: "AAAA" },
        bundleHash: "deadbeef",
        bundleSize: CALLER_BUNDLE_SIZE,
        logLineCount: 42,
      }),
    );
    expect(res.status).toBe(200);

    const newLogText = captured.logs.join("").slice(before);
    expect(newLogText.length, "the bundle-received line was logged").toBeGreaterThan(0);
    expect(newLogText).not.toContain(String(CALLER_BUNDLE_SIZE));
  });
});
