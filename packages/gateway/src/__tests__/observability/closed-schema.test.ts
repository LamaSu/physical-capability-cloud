/**
 * N107b: the closed observability schema (the PR steward's ruling of 10/03, bus #5315 and #5319):
 * no request-controlled value reaches any sink or console line, except as a keyed hash or a coarse
 * class. Each chokepoint is driven here with a marker under arbitrary names and in prose; the
 * every-position test (every-position.test.ts) drives the real gateway.
 * Also #514 r2's two MEDIUMs: a caller's two letters as a country or language, and the MPP failure
 * log carrying the payment library's error.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Writable } from "node:stream";
import Fastify from "fastify";

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
const mark = (name: string) => ["n107b", name, "8f3e"].join("-");

let schema: typeof import("../../observability/closed-schema.js");
let sinks: typeof import("../../observability/closed-sinks.js");

beforeAll(async () => {
  schema = await import("../../observability/closed-schema.js");
  sinks = await import("../../observability/closed-sinks.js");
}, 60_000);

describe("the shared rules", () => {
  it("keyedHash is an h: prefixed 128-bit hex, stable for a value and distinct across values", () => {
    const a = schema.keyedHash(mark("a"));
    expect(a).toMatch(/^h:[0-9a-f]{32}$/);
    expect(schema.keyedHash(mark("a"))).toBe(a);
    expect(schema.keyedHash(mark("b"))).not.toBe(a);
  });

  it("closedText keeps the gateway's own literals, framework messages and timestamps; hashes anything else", () => {
    expect(schema.closedText("[payment-gate] MPP payment check error — blocking request")).toBe("[payment-gate] MPP payment check error — blocking request");
    expect(schema.closedText("request completed")).toBe("request completed");
    expect(schema.closedText("2026-10-03T09:00:00.000Z")).toBe("2026-10-03T09:00:00.000Z");
    expect(schema.closedText(`caller supplied ${mark("prose")}`)).toMatch(/^h:/);
    expect(schema.closedText(mark("plain"))).toMatch(/^h:/);
  });

  it("closeValue: no marker survives under any key, in prose, in a key, in an error or in an array", () => {
    const m = mark("cv");
    const closed = closeValueText({
      zq1: m,
      note: `caller supplied ${m}`,
      [m]: "x",
      nested: { deeper: [m, { email: m }] },
      jobId: m,
      err: new Error(`failed for ${m}`),
      count: 3,
      amount: 123456,
    });
    expect(closed).not.toContain(m);
    expect(closed).toContain('"count":3');
    expect(closed).not.toContain("123456");
  });

  it("uaClass is one of bot, browser, sdk, unknown", () => {
    expect(schema.uaClass("Mozilla/5.0 (X11) Firefox/128.0")).toBe("browser");
    expect(schema.uaClass("HeadlessChrome/120 Mozilla/5.0")).toBe("bot");
    expect(schema.uaClass("python-requests/2.31")).toBe("sdk");
    expect(schema.uaClass(`ordinary-client ${mark("ua")}`)).toBe("unknown");
    expect(schema.uaClass(undefined)).toBe("unknown");
  });
});

function closeValueText(value: unknown) {
  return JSON.stringify(schema.closeValue(value, "", 1));
}

describe("the PostHog boundary", () => {
  beforeAll(async () => {
    process.env.POSTHOG_API_KEY = ["n107b", "posthog", "key"].join("-");
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

  it("the verdict's reproduction (#441 r6, CRITICAL 2): payload, prose and distinct id values never reach PostHog", async () => {
    const { trackServerEvent, identifyAgent } = await import("../../services/posthog-service.js");
    const m = mark("ph");
    const before = posthogCaptures.length;
    trackServerEvent("probe", { payload: { zq1: m }, note: `caller supplied ${m}`, email: `${m}@x.test` }, m);
    trackServerEvent(`event-${m}`, {});
    identifyAgent(m, { first_route: m });
    const sent = posthogCaptures.slice(before) as Array<{ distinctId: string }>;
    expect(sent).toHaveLength(3);
    expect(JSON.stringify(sent)).not.toContain(m);
    expect(sent[0]!.distinctId).toMatch(/^h:[0-9a-f]{32}$/);
    expect(sent[2]!.distinctId).toBe(sent[0]!.distinctId);
  });
});

describe("the audit writer", () => {
  beforeAll(async () => {
    process.env.PCC_DB_PATH = ":memory:";
    const db = await import("../../db.js");
    db.initStore({ seed: false });
  });
  afterAll(async () => {
    (await import("../../db.js")).closeStore();
  });

  it("actor, resource id, address, user agent and metadata are stored closed; a query by actor still finds the row", async () => {
    const { auditService } = await import("../../services/audit-service.js");
    const m = mark("audit");
    auditService.log({
      eventType: "http.write",
      actor: m,
      resourceType: "http",
      resourceId: m,
      action: "post",
      metadata: { email: m, note: `prose ${m}`, [m]: 1, route: "/x", statusCode: 201 },
      ip: m,
      userAgent: `ordinary-client ${m}`,
    });
    const rows = auditService.query({ actor: m });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(m);
    expect(rows[0]!.userAgent).toBe("unknown");
    expect(rows[0]!.metadata).toMatchObject({ statusCode: 201 });
  });
});

describe("the logger", () => {
  it("objects, messages, printf arguments, errors and a caller's request id never reach the log", async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    // The gateway's own logger options, through Fastify (which owns pino), with a captured stream.
    const app = Fastify({ logger: { ...sinks.gatewayLoggerOptions(), stream } });
    await app.ready();
    const logger = app.log;
    const m = mark("log");
    logger.info({ zq1: m, note: `prose ${m}`, [m]: 1, url: `/cb?code=${m}` }, `route ${m} not found`);
    logger.warn("printf %s and %j", m, { m });
    logger.error(new Error(`boom ${m}`));
    logger.error({ err: new Error(`boom ${m}`) }, "[payment-gate] MPP payment check error — blocking request");
    logger.child({ reqId: m }).info("request completed");
    logger.child({ reqId: "req-1" }).info("request completed");
    const text = lines.join("");
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(text).not.toContain(m);
    expect(text).toContain("[payment-gate] MPP payment check error — blocking request");
    expect(text).toContain('"reqId":"req-1"');
    await app.close();
  });
});

describe("request-path console output", () => {
  it("inside a request's scope a console line is closed; outside it (boot) it is as written", async () => {
    // Spies installed before closeConsole binds the console, so they receive exactly what it writes.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const written = () => JSON.stringify([...log.mock.calls, ...info.mock.calls]);
    try {
      sinks.closeConsole();
      const m = mark("console");
      schema.requestScope.run(true, () => {
        console.log(`echo ${m}`, { zq: m });
        console.info("request completed");
      });
      expect(log.mock.calls.length + info.mock.calls.length).toBe(2);
      expect(written()).not.toContain(m);
      expect(written()).toContain("request completed");
      console.log("[boot] plain", m);
      expect(written()).toContain(m);
    } finally {
      log.mockRestore();
      info.mockRestore();
    }
  });
});

describe("Sentry", () => {
  it("an error event, a transaction, a span and a breadcrumb leave with no marker", () => {
    const m = mark("sentry");
    const event = sinks.closedSentryEvent({
      event_id: "abc",
      exception: { values: [{ type: "Error", value: `failed for ${m}`, stacktrace: { frames: [{ filename: "/app/x.js", function: "f", lineno: 1, vars: { m } }] } }] },
      request: { url: `/cb?code=${m}`, headers: { "user-agent": m }, data: m, cookies: { zq: m } },
      user: { id: m, ip_address: m },
      extra: { url: `/cb?code=${m}`, zq1: m },
      tags: { service: "pcc-gateway", zq: m },
      contexts: { trace: { trace_id: "t", span_id: "s", data: { "url.full": m, "http.route": "/x" } }, culture: { locale: m } },
      breadcrumbs: [{ category: "http", message: m, data: { url: m } }],
      server_name: m,
      transaction: `GET /cb/${m}`,
    });
    expect(JSON.stringify(event)).not.toContain(m);
    const transaction = sinks.closedSentryTransaction({
      type: "transaction",
      transaction: `GET /cb/${m}`,
      contexts: { trace: { trace_id: "t", data: { "url.full": `/cb?code=${m}`, "user_agent.original": m, "http.request.method": "GET" } } },
      spans: [{ span_id: "1", description: `GET https://x.test/?code=${m}`, data: { "url.full": m, "client.address": m } }],
    });
    expect(JSON.stringify(transaction)).not.toContain(m);
    expect(JSON.stringify(sinks.closedSentrySpan({ span_id: "1", description: m, data: { "http.target": m } }))).not.toContain(m);
    expect(JSON.stringify(sinks.closedBreadcrumb({ category: m, message: m, data: { m } }))).not.toContain(m);
  });
});
