/**
 * Cross-family review r5 of #441 (rm-px7-441-r5-179c4777, DO-NOT-SHIP), CRITICAL 1, and the PR
 * steward's rule for round 6 (#5254): every outbound observability sink is VALUE-FREE by default.
 * It keeps no query or fragment value, no form or request-body value, and no header outside the
 * allowlist, whatever the name. No credential-name list is load-bearing.
 *
 * One pass through the REAL gateway (createGateway: its Sentry options, its logger options, its
 * audit hook, its security monitor and its PostHog service). A marker is sent in every position
 * under arbitrary names (zq1, x_custom, code): query, fragment, header, form body and JSON body.
 * No sink may hold it:
 *   - the Sentry envelope (error events, transactions with their spans, breadcrumbs);
 *   - every line the request log writes;
 *   - the audit rows;
 *   - every PostHog capture.
 * Only the destinations are swapped for captures. The verdict's own reproductions are kept below.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as Sentry from "@sentry/node";

const captured = vi.hoisted(() => ({ logs: [] as string[], posthog: [] as unknown[] }));

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
// The PostHog client: the gateway's own posthog-service runs, and its client captures.
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

vi.setConfig({ testTimeout: 60_000 });

// Every marker is built at runtime, so no literal here looks like a secret.
const mark = (name: string) => ["px7", "r6", name, "3e9b"].join("-");
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

beforeAll(async () => {
  delete process.env.SENTRY_DSN;
  delete process.env.VITE_SENTRY_DSN;
  delete process.env.TENANT_ENFORCE;
  process.env.PCC_DB_PATH = ":memory:";
  process.env.PCC_ADMIN_KEY = ["px7", "r6", "admin"].join("-");
  process.env.MOCK_SETTLEMENT = "true";
  process.env.POSTHOG_API_KEY = ["px7", "r6", "posthog"].join("-");
  // The gateway's own Sentry options; only the transport is a capture. Dedupe is off, as in r5:
  // it would hide the gateway's own capture behind the SDK's capture of the same error.
  const { sentryOptions } = await import("../sentry.js");
  const options = sentryOptions(DSN);
  Sentry.init({
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
  const { createGateway } = await import("../server.js");
  const gateway = await createGateway(0);
  app = gateway.app as unknown as typeof app;
  // Stand-ins for any route that fails on a request (outside /api/, so no API gate).
  const routes = gateway.app as unknown as { post(path: string, handler: () => Promise<unknown>): void };
  routes.post("/px7-r6/throws", async () => {
    throw new Error("px7-r6 forced failure");
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
  // posthog-service starts its client without awaiting it: wait until it is up.
  const { trackServerEvent } = await import("../services/posthog-service.js");
  for (let i = 0; i < 50 && captured.posthog.length === 0; i++) {
    trackServerEvent("px7_r6_ready", {});
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(captured.posthog.length, "PostHog's client is up").toBeGreaterThan(0);
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Sentry.close(2000);
  (await import("../db.js")).closeStore();
  delete process.env.PCC_ADMIN_KEY;
  delete process.env.MOCK_SETTLEMENT;
  delete process.env.POSTHOG_API_KEY;
});

describe("CRITICAL 1 (review r5 of #441) and the steward's rule: no sink keeps a request value, whatever its name", () => {
  it("a marker in the query, fragment, headers, form body and JSON body under arbitrary names reaches no sink", async () => {
    const m = {
      q: [mark("q-zq1"), mark("q-xc"), mark("q-code")],
      f: [mark("f-zq1"), mark("f-code")],
      h: [mark("h-zq1"), mark("h-xc"), mark("h-code")],
      form: [mark("form-zq1"), mark("form-xc"), mark("form-code")],
      json: [mark("json-zq1"), mark("json-xc"), mark("json-code")],
      ref: [mark("ref-q"), mark("ref-f")],
    };
    const query = `?zq1=${m.q[0]}&x_custom=${m.q[1]}&code=${m.q[2]}#zq1=${m.f[0]}&code=${m.f[1]}`;
    const headers = { "x-zq1": m.h[0], x_custom: m.h[1], code: m.h[2], referer: `https://r.test/cb?zq1=${m.ref[0]}#code=${m.ref[1]}` };
    const before = { sentry: sentryBodies.length, logs: captured.logs.length, posthog: captured.posthog.length };

    // A JSON body to a route that throws: a 500, so an error event, a transaction and a log line.
    const json = await request("POST", `/px7-r6/throws${query}`, { ...headers, "content-type": "application/json" },
      JSON.stringify({ zq1: m.json[0], x_custom: m.json[1], code: m.json[2] }));
    expect(json.status).toBe(500);
    // A form body: the same route as text, and the same body as a form (the gateway has no form parser: 415).
    const formBody = `zq1=${m.form[0]}&x_custom=${m.form[1]}&code=${m.form[2]}`;
    expect((await request("POST", `/px7-r6/throws${query}`, { ...headers, "content-type": "text/plain" }, formBody)).status).toBe(500);
    expect((await request("POST", `/px7-r6/throws${query}`, { ...headers, "content-type": "application/x-www-form-urlencoded" }, formBody)).status).toBe(415);
    // The security monitor's honeypot, with an attack in the JSON body: a PostHog attack event.
    const honeypot = await request("POST", `/admin${query}`, { ...headers, "content-type": "application/json" },
      JSON.stringify({ zq1: m.json[0], x_custom: m.json[1], probe: "javascript:alert(1)" }));
    expect(honeypot.status).toBe(403);

    await Sentry.flush(5000);
    await new Promise((resolve) => setTimeout(resolve, 100)); // the monitor's un-awaited PostHog calls
    const sent = sentryBodies.slice(before.sentry).join("\n");
    const logged = captured.logs.slice(before.logs).join("");
    const posthog = JSON.stringify(captured.posthog.slice(before.posthog));
    const { auditService } = await import("../services/audit-service.js");
    const audit = JSON.stringify(auditService.query({ eventType: "http.write", limit: 500 }));

    // Each sink did receive these requests, so its silence about the markers means something.
    expect(sent).toContain("px7-r6 forced failure");
    expect(sent).toContain('"type":"transaction"');
    expect(sent).toContain('"breadcrumbs"');
    expect(logged).toContain("/px7-r6/throws");
    expect(audit).toContain("/px7-r6/throws");
    expect(posthog).toContain("attack_detected");

    // Sentry collects no body, cookie or query string at all: not even a redacted placeholder.
    const requests = sent.split("\n").flatMap((line) => {
      try {
        const event = JSON.parse(line) as { request?: Record<string, unknown> };
        return event && typeof event === "object" && event.request ? [event.request] : [];
      } catch {
        return [];
      }
    });
    expect(requests.length, "the error event carries its request").toBeGreaterThan(0);
    for (const req of requests) expect(Object.keys(req)).not.toEqual(expect.arrayContaining(["data"]));
    for (const req of requests) expect(Object.keys(req).filter((k) => k === "cookies" || k === "query_string")).toEqual([]);

    const all = Object.values(m).flat();
    const found = (text: string) => all.filter((marker) => text.includes(marker));
    expect({ sentry: found(sent), log: found(logged), audit: found(audit), posthog: found(posthog) }).toEqual({
      sentry: [],
      log: [],
      audit: [],
      posthog: [],
    });
  });
});

describe("the verdict's own reproductions (review r5 of #441, CRITICAL 1)", () => {
  it("redactCredentials keeps no value of an OAuth code, or of any other parameter, in a URL, query string, body or span attribute", async () => {
    const { redactCredentials } = await import("../observability-redact.js");
    const MARKER = mark("verdict");
    const out = JSON.stringify(
      redactCredentials({
        request: {
          url: `/oauth/callback?code=${MARKER}`,
          query_string: `code=${MARKER}`,
          data: `grant_type=authorization_code&code=${MARKER}`,
        },
        contexts: { trace: { data: { "http.url": `/oauth/callback?code=${MARKER}` } } },
        message: `retrying /oauth/token?code_verifier=${MARKER}&ticket=${MARKER}&client_assertion=${MARKER}`,
      }),
    );
    expect(out).not.toContain(MARKER);
    expect(out).toContain("/oauth/callback");
  });

  it("withoutQueryValues drops a fragment's values when the URL has no query", async () => {
    const { withoutQueryValues } = await import("../observability-redact.js");
    const MARKER = mark("fragment");
    expect(withoutQueryValues(`/p#token=${MARKER}`)).not.toContain(MARKER);
    expect(withoutQueryValues(`/p#zq1=${MARKER}`)).not.toContain(MARKER);
  });

  it("an OAuth code in a write request's URL is not kept in the audit row", async () => {
    const MARKER = mark("audit-code");
    await request("POST", `/api/px7-r6-no-such-route?code=${MARKER}`, { "content-type": "application/json" }, "{}");
    const { auditService } = await import("../services/audit-service.js");
    const rows = JSON.stringify(auditService.query({ eventType: "http.write", limit: 500 }));
    expect(rows).toContain("/api/px7-r6-no-such-route");
    expect(rows).not.toContain(MARKER);
  });

  it("the PostHog boundary keeps no URL or form value, whoever sends the event", async () => {
    const { trackServerEvent } = await import("../services/posthog-service.js");
    const MARKER = mark("posthog");
    const before = captured.posthog.length;
    trackServerEvent("px7_r6_boundary", {
      url: `/cb?zq1=${MARKER}`,
      note: `fetched https://x.test/a?x_custom=${MARKER}#code=${MARKER}`,
      form: `zq1=${MARKER}&code=${MARKER}`,
      headers: { "x-zq1": MARKER },
    });
    const sent = JSON.stringify(captured.posthog.slice(before));
    expect(sent).toContain("px7_r6_boundary");
    expect(sent).not.toContain(MARKER);
  });
});
