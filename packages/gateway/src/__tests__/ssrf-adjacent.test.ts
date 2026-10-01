/**
 * SSRF-adjacent outbound requests in the gateway, stacked on #483 (which added
 * services/outbound-url-guard.ts and closed the operator-channel webhook).
 *
 * Written BEFORE any fix. Every site is exercised against the real, default
 * code path and each test states the behaviour the fix must have, so on the
 * unfixed tree the vulnerable sites FAIL and print their evidence on lines
 * tagged [SSRF-ADJ-REPRO] (the evidence is printed before the assertions run).
 *
 *   Site 1  job-offers `sourceVerifyUrl`: fetched at creation AND by the
 *           sweeper; up to 500 bytes of a non-2xx body came back to the caller.
 *   Site 2  courier-jobs `sourceVerifyUrl`: the courier shim delegates to the
 *           same store, so it shares both fetches, and its route reflected the
 *           same body.
 *   Site 3  aggregator invoke: `fetch(tool.upstreamUrl)`. Registration is
 *           admin-gated, but upstreamUrl is copied from third-party catalog
 *           content (OpenAPI servers[]/path keys, AGNTCY locators) unvalidated.
 *   Site 4  MCP proxy: `fetch(proxyRequest.url)`. Controls only: the URL is the
 *           configured API origin plus a static manifest path, and the origin
 *           check holds. Not reproduced, so there is no fix for it.
 *
 * Hermetic: every network target is an IP literal on 127.0.0.1 (a recording
 * listener) or an injected resolver/transport. A loopback-only fetch stub is
 * installed so that even the unfixed code cannot reach a real host.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { jobOffersRoutes } from "../routes/job-offers.js";
import { courierJobsRoutes } from "../routes/courier-jobs.js";
import {
  JobOffersStore,
  initJobOffersStore,
  getJobOffersStore,
  _resetJobOffersStoreForTests,
  type JobOffer,
  type SqliteDatabaseLike,
  type VerifyFn,
} from "../services/job-offers-store.js";
import { startJobOffersSweeper, stopJobOffersSweeper } from "../services/job-offers-sweeper.js";
import {
  initCourierJobsStore,
  getCourierJobsStore,
  _resetCourierJobsStoreForTests,
} from "../services/courier-jobs-store.js";
import {
  _setOutboundDepsForTests,
  type OutboundTransportRequest,
  type OutboundTransportResponse,
} from "../services/outbound-url-guard.js";
import {
  aggregatorRoutes,
  getAggregatorRegistry,
  _resetAggregatorRegistryForTests,
} from "../routes/aggregator/index.js";
import { initStore, closeStore } from "../db.js";
import { dispatchToolCall, loadAgentPackage, type AgentPackageTool } from "../mcp/http-mcp-server.js";
import { RENDER_DASHBOARD_TOOL_NAME } from "../mcp/mcp-app-view.js";
import { DigitalCaptureClass, TrustTier, type IndexedTool } from "@pcc/spec";

// ── shared fixtures ──────────────────────────────────────────────────────────

const MARKER = `SSRF-ADJ-${randomBytes(6).toString("hex")}`;
const PUBLIC_V4 = "93.184.216.34";
const PUBLIC_URL = "https://pos.example.com/order/123";

/** One tagged evidence line. Printed BEFORE the assertions so a failing run still shows it. */
function ev(site: string, kv: Record<string, unknown>): void {
  const parts = Object.entries(kv).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  console.log(`[SSRF-ADJ-REPRO] ${site} ${parts.join(" ")}`);
}

interface Hit {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
interface Listener {
  port: number;
  hits: Hit[];
  close: () => Promise<void>;
}

/** A recording HTTP listener on 127.0.0.1 (random port). */
async function listen(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<Listener> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      hits.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** The "internal service" the attacker wants the gateway to reach. */
let victim: Listener;
/** A third-party catalog (OpenAPI doc / MCP server / AGNTCY directory) that points at the victim. */
let catalog: Listener;

beforeAll(async () => {
  victim = await listen((req, res) => {
    if ((req.url ?? "").startsWith("/internal")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ internal: true, marker: MARKER }));
      return;
    }
    res.statusCode = 403;
    res.setHeader("content-type", "text/plain");
    res.end(`forbidden ${MARKER}`);
  });
  catalog = await listen((req, res) => {
    const url = req.url ?? "";
    const send = (obj: unknown) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };
    if (url === "/openapi.json") {
      // servers[0].url is where the doc says its API lives: here, the victim.
      return send({
        openapi: "3.0.0",
        info: { title: "third-party catalog", version: "1.0.0" },
        servers: [{ url: `http://127.0.0.1:${victim.port}` }],
        paths: { "/internal/openapi": { get: { operationId: "getSecret", summary: "read a value", tags: ["data.read"] } } },
      });
    }
    if (url === "/openapi-abs.json") {
      // A path key that is itself an absolute URL: joinUrl() returns it verbatim, servers[] is bypassed.
      return send({
        openapi: "3.0.0",
        info: { title: "third-party catalog (absolute path key)", version: "1.0.0" },
        servers: [{ url: "https://api.example.com" }],
        paths: {
          [`http://127.0.0.1:${victim.port}/internal/abs`]: { get: { operationId: "getAbs", summary: "read a value", tags: ["data.read"] } },
        },
      });
    }
    if (url === "/mcp") {
      return send({
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [{ name: "lookup", description: "look a value up", inputSchema: { type: "object" } }] },
      });
    }
    if (url === "/v1/search") {
      return send({
        records: [
          {
            name: "third-party-agent",
            description: "reads a value",
            version: "1.0.0",
            schema_version: "1.0.0",
            authors: ["catalog-author"],
            created_at: "2026-01-01T00:00:00Z",
            domains: [{ name: "test", id: 1 }],
            skills: [{ name: "data.read", id: 1 }],
            modules: [],
            locators: [{ type: "rest_endpoint", urls: [`http://127.0.0.1:${victim.port}/internal/agntcy`] }],
          },
        ],
        cids: ["bafysvurlcid1"],
      });
    }
    res.statusCode = 404;
    res.end("not found");
  });
});

afterAll(async () => {
  await victim.close();
  await catalog.close();
});

/**
 * Loopback-only fetch: the unfixed code calls global fetch, so this lets the
 * reproduction reach the 127.0.0.1 listeners and guarantees nothing else can
 * leave the machine. Any other host throws (and the message says what was tried).
 */
const realFetch = globalThis.fetch;
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const host = new URL(raw).hostname;
    if (host !== "127.0.0.1") throw new Error(`test guard: refusing a non-loopback fetch to ${host}`);
    return realFetch(input, init);
  });
});

const ENV_KEYS = ["NODE_ENV", "PCC_AGGREGATOR_ADMINS", "PCC_API_BASE_URL", "PCC_X402_ENABLED"] as const;
let savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  victim.hits.length = 0;
  catalog.hits.length = 0;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _setOutboundDepsForTests(null);
  stopJobOffersSweeper();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Swap the guard's resolver and transport: no real DNS, no real sockets. */
function injectOutbound(opts: {
  addresses?: string[];
  respond?: (req: OutboundTransportRequest) => Promise<OutboundTransportResponse>;
}) {
  const resolved: string[] = [];
  const calls: OutboundTransportRequest[] = [];
  _setOutboundDepsForTests({
    resolve: async (host) => {
      resolved.push(host);
      return (opts.addresses ?? [PUBLIC_V4]).map((address) => ({ address, family: address.includes(":") ? (6 as const) : (4 as const) }));
    },
    transport: async (req) => {
      calls.push(req);
      if (!opts.respond) throw new Error("test transport: nothing configured");
      return opts.respond(req);
    },
  });
  return { resolved, calls };
}

/** A transport answer. `body` is what a transport that honours captureBody would hand back. */
const answer =
  (status: number, body?: string, headers: Record<string, string> = {}) =>
  async (): Promise<OutboundTransportResponse> =>
    ({
      status,
      headers,
      bytesRead: body?.length ?? 0,
      truncated: false,
      ...(body === undefined ? {} : { body: Buffer.from(body) }),
    }) as OutboundTransportResponse;

// ── job-offers helpers ───────────────────────────────────────────────────────

function pizzaOffer(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    capabilityType: "pizza.order",
    requirements: { store: "domino-sf-7764", items: [{ size: "large" }] },
    pricing: { amount: 21.71, currency: "USD", model: "fixed" },
    ...extra,
  };
}

const T0 = Date.parse("2026-06-19T00:00:00.000Z");

/** A row as it would be hydrated from sqlite: stored before any URL rule existed. */
function storedOffer(over: Partial<JobOffer>): JobOffer {
  return {
    id: "stored-1",
    capabilityType: "pizza.order",
    requirements: { store: "domino-sf-7764" },
    requirementsValidated: false,
    serviceAreaGeofence: null,
    pricing: { amount: 21.71, currency: "USD", model: "fixed" },
    deadlineIso: null,
    assuranceTier: null,
    evidenceRequirements: null,
    sourceVerifyUrl: null,
    requireHeartbeat: false,
    posterDid: "legacy-poster",
    posterKernelId: null,
    idempotencyKey: null,
    status: "open",
    postedAt: new Date(T0).toISOString(),
    validUntil: new Date(T0 + 2 * 3600e3).toISOString(),
    claimedByKernelId: null,
    claimedAt: null,
    claimSignature: null,
    verified: true,
    lastVerifyAt: new Date(T0).toISOString(),
    lastHeartbeatAt: null,
    deliveredAt: null,
    cancelledAt: null,
    expiredAt: null,
    ...over,
  };
}

/** The raw sqlite handle, reduced to what hydrateFromSqlite() reads. */
function sqliteWith(rows: JobOffer[]): SqliteDatabaseLike {
  return {
    prepare(sql: string) {
      const isOffers = /FROM job_offers\b/.test(sql) && !sql.includes("job_offer_events");
      return {
        run: () => ({}),
        all: () => (isOffers ? rows.map((o) => ({ id: o.id, data: JSON.stringify(o) })) : []),
        get: () => undefined,
      };
    },
  };
}

/** Two minutes after posting: inside the 60 s early re-verify window. */
const sweepNow = () => new Date(T0 + 2 * 60e3);

const UNSAFE_SOURCE_URLS: Array<[label: string, url: unknown]> = [
  ["loopback literal", `http://127.0.0.1:${9}/x`],
  ["localhost", "http://localhost:9/x"],
  ["IPv6 loopback", "http://[::1]:9/x"],
  ["decimal IPv4 spelling of 127.0.0.1", "http://2130706433/x"],
  ["hex IPv4 spelling of 127.0.0.1", "http://0x7f000001/x"],
  ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
  ["RFC1918", "http://10.0.0.5/x"],
  ["IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/x"],
  ["userinfo", "https://user:pw@pos.example.com/x"],
  ["non-http scheme", "ftp://pos.example.com/x"],
  ["file scheme", "file:///etc/passwd"],
  ["*.internal name", "https://metadata.google.internal/x"],
  ["single-label host", "https://pos/x"],
  ["not a URL", "not a url"],
  ["non-string value", 123],
  ["object value", { href: "http://127.0.0.1/" }],
];

// ═════════════════════════════════════════════════════════════════════════════
// Site 1: job-offers sourceVerifyUrl
// ═════════════════════════════════════════════════════════════════════════════

describe("site 1: job-offers sourceVerifyUrl (default verify, real code path)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetJobOffersStoreForTests();
    initJobOffersStore({});
    app = Fastify({ logger: false });
    await app.register(jobOffersRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    _resetJobOffersStoreForTests();
  });

  it("[neg] creation: a loopback sourceVerifyUrl is refused before any fetch, and no remote body is reflected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      headers: { "x-posted-by": "mallory" },
      payload: pizzaOffer("ssrf-1", { sourceVerifyUrl: `http://127.0.0.1:${victim.port}/secret` }),
    });
    const body = res.json();
    ev("site1 create", {
      status: res.statusCode,
      error: body.error,
      reason: body.reason,
      listenerHits: victim.hits.length,
      hits: victim.hits.map((h) => `${h.method} ${h.url} accept=${h.headers.accept ?? ""}`),
      sourceBody: body.sourceBody ?? null,
      markerInResponse: res.body.includes(MARKER),
    });
    expect(victim.hits, "the gateway fetched the caller-chosen loopback URL").toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(body.error).toBe("invalid_source_verify_url");
    expect(res.body, "the remote response body was reflected to the caller").not.toContain(MARKER);
    expect(body).not.toHaveProperty("sourceBody");
    expect(getJobOffersStore().has("ssrf-1")).toBe(false);
  });

  it("[neg] every unsafe spelling is refused at creation: 400 invalid_source_verify_url, nothing stored, nothing fetched", async () => {
    for (const [label, url] of UNSAFE_SOURCE_URLS) {
      const id = `unsafe-${label.replace(/\W+/g, "-")}`;
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        headers: { "x-posted-by": "mallory" },
        payload: pizzaOffer(id, { sourceVerifyUrl: url }),
      });
      expect(res.statusCode, label).toBe(400);
      expect(res.json().error, label).toBe("invalid_source_verify_url");
      expect(getJobOffersStore().has(id), `${label}: stored`).toBe(false);
    }
    expect(victim.hits).toHaveLength(0);
  });

  it("[neg] http is refused for a public host outside test/development", async () => {
    process.env.NODE_ENV = "production";
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("prod-http", { sourceVerifyUrl: "http://pos.example.com/order/1" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_source_verify_url", reason: "scheme_not_allowed" });
    expect(getJobOffersStore().has("prod-http")).toBe(false);
  });

  it("an empty sourceVerifyUrl still means 'no source to verify' (unchanged)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("no-source", { sourceVerifyUrl: "" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().verified).toBe(false);
  });

  it("[neg] a hostname that resolves to a private address is never dialled (injected resolver + transport)", async () => {
    const { resolved, calls } = injectOutbound({ addresses: ["10.0.0.5"], respond: answer(200, "{}") });
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("dns-private", { sourceVerifyUrl: PUBLIC_URL }),
    });
    ev("site1 dns-private", { status: res.statusCode, resolved, transportCalls: calls.length, body: res.body });
    expect(resolved, "the host was resolved through the guard").toEqual(["pos.example.com"]);
    expect(calls, "a socket was opened to a private address").toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "source_verify_failed", reason: "verify_request_failed" });
    expect(res.body, "an address leaked into the response").not.toMatch(/10\.0\.0\.5/);
    expect(getJobOffersStore().has("dns-private")).toBe(false);
  });

  it("a public https source verifies through the guarded transport: pinned address, GET, bounded", async () => {
    const { resolved, calls } = injectOutbound({ respond: answer(200, JSON.stringify({ placed: true })) });
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("public-ok", { sourceVerifyUrl: PUBLIC_URL }),
    });
    ev("site1 public-ok", { status: res.statusCode, resolved, transportCalls: calls.length });
    expect(res.statusCode).toBe(201);
    expect(res.json().verified).toBe(true);
    expect(resolved).toEqual(["pos.example.com"]);
    expect(calls).toHaveLength(1);
    const req = calls[0]!;
    expect(req.method).toBe("GET");
    expect(req.url.href).toBe(PUBLIC_URL);
    expect(req.addresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    expect(req.headers.accept).toBe("application/json");
    expect(req.body).toBeUndefined();
    expect(req.timeoutMs).toBeLessThanOrEqual(8000);
    expect(req.maxResponseBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it("documented verdicts survive the guard: placed:false and valid:false in a 2xx body fail the create; non-JSON 2xx is alive", async () => {
    for (const [i, [bodyText, expectOk]] of (
      [
        [JSON.stringify({ placed: false }), false],
        [JSON.stringify({ valid: false }), false],
        [JSON.stringify({ placed: true, valid: true }), true],
        ["<html>status page</html>", true],
        ["", true],
      ] as Array<[string, boolean]>
    ).entries()) {
      injectOutbound({ respond: answer(200, bodyText) });
      const res = await app.inject({
        method: "POST",
        url: "/api/job-offers",
        payload: pizzaOffer(`verdict-${i}`, { sourceVerifyUrl: PUBLIC_URL }),
      });
      if (expectOk) {
        expect(res.statusCode, bodyText).toBe(201);
      } else {
        expect(res.statusCode, bodyText).toBe(400);
        expect(res.json()).toMatchObject({ error: "source_verify_failed", reason: "source_says_not_real", sourceStatus: 200 });
        expect(res.body).not.toContain("placed");
      }
    }
  });

  it("[neg] a non-2xx source: the status comes back, the body never does", async () => {
    injectOutbound({ respond: answer(403, `forbidden ${MARKER}`) });
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("non-2xx", { sourceVerifyUrl: PUBLIC_URL }),
    });
    ev("site1 non-2xx", { status: res.statusCode, markerInResponse: res.body.includes(MARKER), body: res.body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "source_verify_failed", reason: "http_non_2xx", sourceStatus: 403 });
    expect(res.body).not.toContain(MARKER);
    expect(res.json()).not.toHaveProperty("sourceBody");
  });

  it("[neg] the store itself never carries a remote body in a failed verify result", async () => {
    injectOutbound({ respond: answer(403, `forbidden ${MARKER}`) });
    const store = new JobOffersStore({});
    const result = await store.create({
      capabilityType: "pizza.order",
      requirements: { store: "s" },
      pricing: { amount: 1, currency: "USD", model: "fixed" },
      sourceVerifyUrl: PUBLIC_URL,
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(result).toMatchObject({ reason: "http_non_2xx", status: 403 });
  });

  it("[neg] a redirect is a failure, never followed", async () => {
    const { calls } = injectOutbound({
      respond: answer(302, undefined, { location: `http://127.0.0.1:${victim.port}/internal` }),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("redirect", { sourceVerifyUrl: PUBLIC_URL }),
    });
    expect(calls).toHaveLength(1);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "source_verify_failed", reason: "http_non_2xx", sourceStatus: 302 });
    expect(victim.hits).toHaveLength(0);
  });

  it("[neg] reflection at the route: a body a verify function hands back is not forwarded", async () => {
    _resetJobOffersStoreForTests();
    const leaky: VerifyFn = async () => ({ ok: false, reason: "http_non_2xx", status: 403, body: `leak ${MARKER}` });
    initJobOffersStore({ verify: leaky });
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("route-reflect", { sourceVerifyUrl: PUBLIC_URL }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "source_verify_failed", reason: "http_non_2xx", sourceStatus: 403 });
    expect(res.body).not.toContain(MARKER);
    expect(res.json()).not.toHaveProperty("sourceBody");
  });

  it("[neg] an injected verify function is never handed a refused URL at creation", async () => {
    _resetJobOffersStoreForTests();
    const seen: string[] = [];
    initJobOffersStore({
      verify: async (url) => {
        seen.push(url);
        return { ok: true, body: null };
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/job-offers",
      payload: pizzaOffer("stub-refused", { sourceVerifyUrl: `http://127.0.0.1:${victim.port}/secret` }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_source_verify_url");
    expect(seen).toEqual([]);
  });

  describe("the sweeper (periodic re-verify of a STORED row), invoked directly", () => {
    it("[neg] a stored row whose URL points at loopback is not fetched; it is marked unverified", async () => {
      _resetJobOffersStoreForTests();
      const url = `http://127.0.0.1:${victim.port}/secret`;
      initJobOffersStore({ sqlite: sqliteWith([storedOffer({ id: "legacy-1", sourceVerifyUrl: url })]), now: sweepNow });
      const store = getJobOffersStore();
      const result = await store.sweep();
      const o = store.get("legacy-1")!;
      const cancelled = store.getEvents("legacy-1").find((e) => e.event === "cancelled");
      ev("site1 sweep", {
        sweepResult: result,
        listenerHits: victim.hits.length,
        hits: victim.hits.map((h) => `${h.method} ${h.url}`),
        status: o.status,
        verified: o.verified,
        publicEvent: cancelled ?? null,
      });
      expect(victim.hits, "the sweeper fetched a stored loopback URL").toHaveLength(0);
      expect(result.autoCancelled).toBe(1);
      expect(o.verified).toBe(false);
      expect(cancelled).toMatchObject({ reason: "source_verify_failed_after_post", verifyReason: "invalid_source_verify_url", sourceStatus: null });
      expect(JSON.stringify(store.getEvents("legacy-1"))).not.toContain(MARKER);
    });

    it("[neg] the sweeper hands an injected verify function no refused URL", async () => {
      _resetJobOffersStoreForTests();
      const seen: string[] = [];
      initJobOffersStore({
        sqlite: sqliteWith([storedOffer({ id: "legacy-2", sourceVerifyUrl: "http://169.254.169.254/latest/meta-data/" })]),
        now: sweepNow,
        verify: async (url) => {
          seen.push(url);
          return { ok: true, body: null };
        },
      });
      const store = getJobOffersStore();
      const result = await store.sweep();
      expect(seen).toEqual([]);
      expect(result.autoCancelled).toBe(1);
      expect(store.get("legacy-2")!.verified).toBe(false);
    });

    it("a stored row with a public URL is re-verified through the guarded transport", async () => {
      _resetJobOffersStoreForTests();
      const { resolved, calls } = injectOutbound({ respond: answer(200, JSON.stringify({ placed: true })) });
      initJobOffersStore({ sqlite: sqliteWith([storedOffer({ id: "legacy-3", sourceVerifyUrl: PUBLIC_URL })]), now: sweepNow });
      const store = getJobOffersStore();
      const result = await store.sweep();
      expect(result).toEqual({ expired: 0, reverified: 1, autoCancelled: 0 });
      expect(resolved).toEqual(["pos.example.com"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.addresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
    });

    it("a stored row whose source now says placed:false is cancelled (documented behaviour kept)", async () => {
      _resetJobOffersStoreForTests();
      injectOutbound({ respond: answer(200, JSON.stringify({ placed: false })) });
      initJobOffersStore({ sqlite: sqliteWith([storedOffer({ id: "legacy-4", sourceVerifyUrl: PUBLIC_URL })]), now: sweepNow });
      const store = getJobOffersStore();
      const result = await store.sweep();
      expect(result.autoCancelled).toBe(1);
      expect(store.getEvents("legacy-4").find((e) => e.event === "cancelled")).toMatchObject({
        verifyReason: "source_says_not_real",
        sourceStatus: 200,
      });
    });

    it("[neg] the status of a refused source is not leaked through the public event", async () => {
      _resetJobOffersStoreForTests();
      initJobOffersStore({
        sqlite: sqliteWith([storedOffer({ id: "legacy-5", sourceVerifyUrl: `http://127.0.0.1:${victim.port}/secret` })]),
        now: sweepNow,
      });
      await getJobOffersStore().sweep();
      const got = await app.inject({ method: "GET", url: "/api/job-offers/legacy-5" });
      expect(got.json().events.find((e: { event: string }) => e.event === "cancelled").sourceStatus).toBeNull();
      expect(got.body).not.toContain(MARKER);
      expect(victim.hits).toHaveLength(0);
    });

    it("[neg] the real sweeper timer (startJobOffersSweeper) reaches the same decision", async () => {
      _resetJobOffersStoreForTests();
      initJobOffersStore({
        sqlite: sqliteWith([storedOffer({ id: "legacy-6", sourceVerifyUrl: `http://127.0.0.1:${victim.port}/secret` })]),
        now: sweepNow,
      });
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      startJobOffersSweeper();
      vi.advanceTimersByTime(60_000);
      const store = getJobOffersStore();
      for (let i = 0; i < 150 && store.get("legacy-6")!.status === "open"; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      const o = store.get("legacy-6")!;
      ev("site1 sweeper-timer", { status: o.status, verified: o.verified, listenerHits: victim.hits.length });
      expect(victim.hits).toHaveLength(0);
      expect(o.status).toBe("cancelled");
      expect(o.verified).toBe(false);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Site 2: courier-jobs sourceVerifyUrl (shim over the same store)
// ═════════════════════════════════════════════════════════════════════════════

describe("site 2: courier-jobs sourceVerifyUrl (shim over the generic store)", () => {
  let app: FastifyInstance;

  const courierBody = (id: string, extra: Record<string, unknown> = {}) => ({
    deliveryId: id,
    pickup: { name: "Store", lat: 37.77, lng: -122.42 },
    dropoff: { name: "Tower" },
    feeUSD: 6.7,
    ...extra,
  });

  beforeEach(async () => {
    _resetCourierJobsStoreForTests();
    initCourierJobsStore({});
    app = Fastify({ logger: false });
    await app.register(courierJobsRoutes);
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    _resetCourierJobsStoreForTests();
  });

  it("[neg] creation: a loopback sourceVerifyUrl is refused before any fetch, and no remote body is reflected", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/courier-jobs",
      headers: { "x-posted-by": "mallory" },
      payload: courierBody("c-ssrf-1", { sourceVerifyUrl: `http://127.0.0.1:${victim.port}/secret` }),
    });
    const body = res.json();
    ev("site2 create", {
      status: res.statusCode,
      error: body.error,
      reason: body.reason,
      listenerHits: victim.hits.length,
      hits: victim.hits.map((h) => `${h.method} ${h.url}`),
      sourceBody: body.sourceBody ?? null,
      markerInResponse: res.body.includes(MARKER),
    });
    expect(victim.hits, "the gateway fetched the caller-chosen loopback URL").toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(body.error).toBe("invalid_source_verify_url");
    expect(res.body, "the remote response body was reflected to the caller").not.toContain(MARKER);
    expect(body).not.toHaveProperty("sourceBody");
    expect(getCourierJobsStore().has("c-ssrf-1")).toBe(false);
  });

  it("[neg] the /jobs alias is the same handler and is covered too", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/courier-jobs/jobs",
      payload: courierBody("c-alias-1", { sourceVerifyUrl: `http://127.0.0.1:${victim.port}/secret` }),
    });
    expect(victim.hits).toHaveLength(0);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_source_verify_url");
  });

  it("[neg] every unsafe spelling is refused at creation, nothing stored or fetched", async () => {
    for (const [label, url] of UNSAFE_SOURCE_URLS) {
      const id = `c-unsafe-${label.replace(/\W+/g, "-")}`;
      const res = await app.inject({ method: "POST", url: "/api/courier-jobs", payload: courierBody(id, { sourceVerifyUrl: url }) });
      expect(res.statusCode, label).toBe(400);
      expect(res.json().error, label).toBe("invalid_source_verify_url");
      expect(getCourierJobsStore().has(id), `${label}: stored`).toBe(false);
    }
    expect(victim.hits).toHaveLength(0);
  });

  it("[neg] a non-2xx source: the status comes back, the body never does", async () => {
    injectOutbound({ respond: answer(403, `forbidden ${MARKER}`) });
    const res = await app.inject({
      method: "POST",
      url: "/api/courier-jobs",
      payload: courierBody("c-non-2xx", { sourceVerifyUrl: "https://kernel.example.com/orders/abc/status" }),
    });
    ev("site2 non-2xx", { status: res.statusCode, markerInResponse: res.body.includes(MARKER), body: res.body });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "source_verify_failed", reason: "http_non_2xx", sourceStatus: 403 });
    expect(res.body).not.toContain(MARKER);
    expect(res.json()).not.toHaveProperty("sourceBody");
  });

  it("[neg] reflection at the route: a body a verify function hands back is not forwarded", async () => {
    _resetCourierJobsStoreForTests();
    initCourierJobsStore({ verify: async () => ({ ok: false, reason: "http_non_2xx", status: 403, body: `leak ${MARKER}` }) });
    const res = await app.inject({
      method: "POST",
      url: "/api/courier-jobs",
      payload: courierBody("c-route-reflect", { sourceVerifyUrl: "https://kernel.example.com/orders/abc/status" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "source_verify_failed", reason: "http_non_2xx", sourceStatus: 403 });
    expect(res.body).not.toContain(MARKER);
    expect(res.json()).not.toHaveProperty("sourceBody");
  });

  it("a public https source verifies through the guarded transport (documented create + placed:false)", async () => {
    const ok = injectOutbound({ respond: answer(200, JSON.stringify({ valid: true })) });
    const created = await app.inject({
      method: "POST",
      url: "/api/courier-jobs",
      payload: courierBody("c-public-ok", { sourceVerifyUrl: "https://kernel.example.com/orders/abc/status" }),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().verified).toBe(true);
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.url.href).toBe("https://kernel.example.com/orders/abc/status");

    injectOutbound({ respond: answer(200, JSON.stringify({ placed: false })) });
    const refused = await app.inject({
      method: "POST",
      url: "/api/courier-jobs",
      payload: courierBody("c-placed-false", { sourceVerifyUrl: "https://kernel.example.com/orders/def/status" }),
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "source_verify_failed", reason: "source_says_not_real" });
  });

  it("[neg] the courier sweep (shim -> generic sweep) does not fetch a stored loopback URL", async () => {
    _resetCourierJobsStoreForTests();
    const url = `http://127.0.0.1:${victim.port}/secret`;
    initCourierJobsStore({
      sqlite: sqliteWith([storedOffer({ id: "legacy-c1", capabilityType: "courier.dispatch", sourceVerifyUrl: url, requirements: { pickup: { name: "S" }, dropoff: { name: "T" } } })]),
      now: sweepNow,
    });
    const result = await getCourierJobsStore().sweep();
    const job = getCourierJobsStore().get("legacy-c1")!;
    ev("site2 sweep", { sweepResult: result, listenerHits: victim.hits.length, status: job.status, verified: job.verified });
    expect(victim.hits, "the courier sweeper fetched a stored loopback URL").toHaveLength(0);
    expect(result.autoCancelled).toBe(1);
    expect(job.verified).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Site 3: aggregator invoke, fetch(tool.upstreamUrl)
// ═════════════════════════════════════════════════════════════════════════════

const SHA = "sha256:" + "a".repeat(64);

function makeTool(overrides: Partial<IndexedTool> = {}): IndexedTool {
  return {
    id: "svurl-tool-1",
    cid: SHA,
    version: "1.0.0",
    source: { type: "mcp-directory", url: "https://mcp.example.com", fetchedAt: "2026-05-23T00:00:00.000Z" },
    ingestedAt: "2026-05-23T00:00:00.000Z",
    ingestionMethod: "mcp-list",
    upstreamUrl: "https://api.example.com/echo",
    skills: ["data.echo"],
    domains: ["test"],
    features: [],
    inputSchema: { type: "object" },
    description: "echo back the input",
    actionClass: "read",
    assuranceCeiling: DigitalCaptureClass.DCC3,
    trustTier: TrustTier.AUTO_INDEXED,
    knownVulns: [],
    lastFetchedAt: "2026-05-23T00:00:00.000Z",
    invocationCount: 0,
    driftAlerts: [],
    schemaHashHistory: [SHA],
    hostingPeers: [],
    ...overrides,
  };
}

describe("site 3: aggregator invoke upstreamUrl", () => {
  let app: FastifyInstance;

  async function buildApp(): Promise<FastifyInstance> {
    const a = Fastify({ logger: false });
    // Stand-in for the API-key gate: the operator id comes from a test header.
    a.addHook("onRequest", async (req) => {
      const op = req.headers["x-test-operator"];
      if (typeof op === "string") (req as unknown as { operatorId?: string }).operatorId = op;
    });
    await a.register(aggregatorRoutes);
    await a.ready();
    return a;
  }

  const ingest = (route: "openapi" | "mcp" | "agntcy", body: Record<string, unknown>, operator: string) =>
    app.inject({
      method: "POST",
      url: `/api/aggregator/ingest/${route}`,
      headers: { "x-test-operator": operator },
      payload: body,
    });
  const invoke = (id: string, operator = "mallory") =>
    app.inject({
      method: "POST",
      url: `/api/aggregator/invoke/${encodeURIComponent(id)}`,
      headers: { "x-test-operator": operator },
      payload: { args: {} },
    });

  beforeEach(async () => {
    _resetAggregatorRegistryForTests();
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    delete process.env.PCC_X402_ENABLED;
    process.env.PCC_AGGREGATOR_ADMINS = "admin-1";
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    closeStore();
  });

  describe("who can set tool.upstreamUrl", () => {
    it("[ctl] a non-admin cannot register or ingest a tool: the ingest routes are allowlist-gated and closed by default", async () => {
      const targets: Array<["openapi" | "mcp" | "agntcy", Record<string, unknown>]> = [
        ["openapi", { url: `http://127.0.0.1:${catalog.port}/openapi.json` }],
        ["mcp", { url: `http://127.0.0.1:${catalog.port}/mcp` }],
        ["agntcy", { skill: "data.read", url: `http://127.0.0.1:${catalog.port}` }],
      ];
      const seen: Record<string, number[]> = {};
      for (const [route, body] of targets) {
        const anon = await app.inject({ method: "POST", url: `/api/aggregator/ingest/${route}`, payload: body });
        const mallory = await ingest(route, body, "mallory");
        delete process.env.PCC_AGGREGATOR_ADMINS; // unset allowlist: nobody is an admin
        const nobody = await ingest(route, body, "admin-1");
        process.env.PCC_AGGREGATOR_ADMINS = "admin-1";
        seen[route] = [anon.statusCode, mallory.statusCode, nobody.statusCode];
        expect(anon.statusCode, `${route} unauthenticated`).toBe(401);
        expect(mallory.statusCode, `${route} non-admin`).toBe(403);
        expect(nobody.statusCode, `${route} empty allowlist`).toBe(403);
      }
      ev("site3 who-sets", { statusesAnonMalloryEmptyAllowlist: seen, catalogHits: catalog.hits.length, registrySize: getAggregatorRegistry().query({}).length });
      expect(catalog.hits, "a refused ingest must not even fetch the catalog").toHaveLength(0);
      expect(getAggregatorRegistry().query({})).toHaveLength(0);
    });

    it("[ctl] the only writer of the registry in the gateway is the admin-gated ingest pipeline", async () => {
      // routes/aggregator/*: registry.upsert appears in invoke.ts (a counter bump on an existing tool) and
      // via runPipeline in ingest.ts/agntcy.ts. A non-admin invoke therefore cannot add a tool:
      const res = await invoke("tool-that-does-not-exist");
      expect(res.statusCode).toBe(404);
      expect(getAggregatorRegistry().query({})).toHaveLength(0);
    });
  });

  describe("the value is third-party catalog content, so an admin-ingested catalog steers the fetch", () => {
    it("[neg] OpenAPI servers[0].url: an internal base URL is refused at registration and never fetched at invoke", async () => {
      const ing = await ingest("openapi", { url: `http://127.0.0.1:${catalog.port}/openapi.json` }, "admin-1");
      const registered = getAggregatorRegistry().query({});
      const id = `openapi:http://127.0.0.1:${catalog.port}/openapi.json#getSecret`;
      let inv: Awaited<ReturnType<typeof invoke>> | undefined;
      if (getAggregatorRegistry().get(id)) inv = await invoke(id, "mallory");
      ev("site3 openapi-servers", {
        ingestStatus: ing.statusCode,
        registered: registered.map((t) => ({ id: t.id, upstreamUrl: t.upstreamUrl })),
        nonAdminInvokeStatus: inv?.statusCode ?? "not-invoked",
        victimHits: victim.hits.map((h) => `${h.method} ${h.url}`),
        markerInInvokeResult: inv ? inv.body.includes(MARKER) : false,
        invokeResult: inv ? JSON.parse(inv.body).result : null,
      });
      expect(ing.statusCode).toBe(200);
      expect(registered, "a tool whose upstream is a loopback URL was registered").toHaveLength(0);
      expect(victim.hits, "the gateway fetched the internal upstream").toHaveLength(0);
      expect(inv?.body ?? "").not.toContain(MARKER);
      const publish = ing.json().stages.find((s: { stage: string }) => s.stage === "publish");
      expect(Object.keys(publish.errors)).toEqual([id]);
      expect(publish.errors[id]).toMatch(/upstream_url_not_allowed/);
      expect(ing.json().published).toEqual([]);
    });

    it("[neg] OpenAPI absolute path key: it overrides servers[] and is refused the same way", async () => {
      const ing = await ingest("openapi", { url: `http://127.0.0.1:${catalog.port}/openapi-abs.json` }, "admin-1");
      const registered = getAggregatorRegistry().query({});
      ev("site3 openapi-abs", { ingestStatus: ing.statusCode, registered: registered.map((t) => t.upstreamUrl) });
      expect(registered).toHaveLength(0);
      expect(ing.json().published).toEqual([]);
      expect(victim.hits).toHaveLength(0);
    });

    it("[neg] AGNTCY locators[].urls[0]: an internal locator is refused at registration", async () => {
      const ing = await ingest("agntcy", { skill: "data.read", url: `http://127.0.0.1:${catalog.port}` }, "admin-1");
      const registered = getAggregatorRegistry().query({});
      let inv: Awaited<ReturnType<typeof invoke>> | undefined;
      if (getAggregatorRegistry().get("agntcy:bafysvurlcid1")) inv = await invoke("agntcy:bafysvurlcid1", "mallory");
      ev("site3 agntcy", {
        ingestStatus: ing.statusCode,
        registered: registered.map((t) => ({ id: t.id, upstreamUrl: t.upstreamUrl })),
        nonAdminInvokeStatus: inv?.statusCode ?? "not-invoked",
        victimHits: victim.hits.map((h) => `${h.method} ${h.url}`),
        markerInInvokeResult: inv ? inv.body.includes(MARKER) : false,
      });
      expect(registered).toHaveLength(0);
      expect(victim.hits).toHaveLength(0);
      expect(inv?.body ?? "").not.toContain(MARKER);
    });

    it("[neg] MCP ingest of a loopback server (admin-chosen): the tools are refused at registration", async () => {
      const ing = await ingest("mcp", { url: `http://127.0.0.1:${catalog.port}/mcp` }, "admin-1");
      expect(ing.statusCode).toBe(200);
      expect(getAggregatorRegistry().query({})).toHaveLength(0);
      expect(ing.json().published).toEqual([]);
      const publish = ing.json().stages.find((s: { stage: string }) => s.stage === "publish");
      expect(Object.values(publish.errors).join(" ")).toMatch(/upstream_url_not_allowed:blocked_address/);
    });

    it("an ingest of a public catalog still registers its tools (control)", async () => {
      // A catalog on a public https name; the adapter's own fetch is stubbed, so nothing real is contacted.
      const doc = {
        openapi: "3.0.0",
        info: { title: "public catalog", version: "1.0.0" },
        servers: [{ url: "https://api.example.com/v1" }],
        paths: { "/items": { get: { operationId: "listItems", summary: "list items", tags: ["data.read"] } } },
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } }));
      const ing = await ingest("openapi", { url: "https://catalog.example.com/openapi.json" }, "admin-1");
      expect(ing.statusCode).toBe(200);
      expect(ing.json().published.map((t: IndexedTool) => t.upstreamUrl)).toEqual(["https://api.example.com/v1/items"]);
      expect(getAggregatorRegistry().query({}).map((t) => t.upstreamUrl)).toEqual(["https://api.example.com/v1/items"]);
    });
  });

  describe("invoke fetches only validated destinations, through the guarded transport", () => {
    it("[neg] a tool already in the registry with an internal upstream is refused: nothing is fetched, no body comes back", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "seeded-loopback", upstreamUrl: `http://127.0.0.1:${victim.port}/internal/seeded` }));
      const res = await invoke("seeded-loopback");
      ev("site3 invoke-seeded-loopback", { status: res.statusCode, victimHits: victim.hits.length, markerInResponse: res.body.includes(MARKER), body: res.body.slice(0, 200) });
      expect(victim.hits, "the gateway fetched an internal upstream").toHaveLength(0);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("tool_upstream_blocked");
      expect(res.body).not.toContain(MARKER);
    });

    it("[neg] cloud metadata and RFC1918 upstreams are refused before any attempt", async () => {
      for (const [i, url] of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/admin", "http://[::1]:9/x", "https://metadata.google.internal/x"].entries()) {
        getAggregatorRegistry().upsert(makeTool({ id: `seeded-${i}`, upstreamUrl: url }));
        const calls = injectOutbound({ respond: answer(200, "{}") }).calls;
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const res = await invoke(`seeded-${i}`);
        ev("site3 invoke-seeded-internal", { url, status: res.statusCode, fetchAttempts: fetchSpy.mock.calls.length, body: res.body.slice(0, 160) });
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error, url).toBe("tool_upstream_blocked");
        expect(calls, url).toHaveLength(0);
        expect(fetchSpy.mock.calls.filter((c) => !String(c[0]).startsWith("http://127.0.0.1")), `${url}: global fetch attempted`).toHaveLength(0);
      }
    });

    it("a public upstream is called through the guarded transport (pinned, bounded) and its JSON result is returned", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "echo-1" }));
      const { resolved, calls } = injectOutbound({ respond: answer(200, JSON.stringify({ echoed: true })) });
      const res = await invoke("echo-1");
      ev("site3 invoke-public", { status: res.statusCode, resolved, transportCalls: calls.length });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toEqual({ echoed: true });
      expect(resolved).toEqual(["api.example.com"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.url.href).toBe("https://api.example.com/echo");
      expect(calls[0]!.addresses).toEqual([{ address: PUBLIC_V4, family: 4 }]);
      expect(calls[0]!.maxResponseBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(30_000);
    });

    it("a write tool POSTs the args as JSON through the guarded transport", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "write-1", actionClass: "write", upstreamUrl: "https://api.example.com/do" }));
      const { calls } = injectOutbound({ respond: answer(200, JSON.stringify({ done: true })) });
      const res = await app.inject({
        method: "POST",
        url: "/api/aggregator/invoke/write-1",
        headers: { "x-test-operator": "mallory" },
        payload: { args: { msg: "hi" } },
      });
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.body).toBe(JSON.stringify({ msg: "hi" }));
      expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    });

    it("[neg] a hostname that resolves to a private address is never dialled; the failure text is generic", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "rebind-1", upstreamUrl: "https://rebind.example.com/x" }));
      const { resolved, calls } = injectOutbound({ addresses: ["10.1.2.3"], respond: answer(200, "{}") });
      const res = await invoke("rebind-1");
      ev("site3 invoke-dns-private", { status: res.statusCode, resolved, transportCalls: calls.length, body: res.body });
      expect(resolved).toEqual(["rebind.example.com"]);
      expect(calls).toHaveLength(0);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("upstream_unreachable");
      expect(res.body).not.toMatch(/10\.1\.2\.3/);
    });

    it("[neg] transport failures never put an internal address or system error text in the response", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "leaky-1" }));
      injectOutbound({
        respond: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 10.1.2.3:5432"), { code: "ECONNREFUSED" });
        },
      });
      const res = await invoke("leaky-1");
      ev("site3 invoke-error-text", { status: res.statusCode, body: res.body });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("upstream_unreachable");
      expect(res.body).not.toMatch(/10\.1\.2\.3|5432|ECONNREFUSED/);
    });

    it("[neg] a redirect from the upstream is not followed", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "redir-1" }));
      const { calls } = injectOutbound({
        respond: answer(302, undefined, { location: `http://127.0.0.1:${victim.port}/internal/redirect` }),
      });
      const res = await invoke("redir-1");
      expect(calls).toHaveLength(1);
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("upstream_redirect_not_followed");
      expect(victim.hits).toHaveLength(0);
      expect(res.body).not.toContain("127.0.0.1");
    });

    it("[neg] an upstream body over the cap is a failure, not a silent truncation", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "big-1" }));
      injectOutbound({
        respond: async () => ({ status: 200, headers: {}, bytesRead: 5 * 1024 * 1024, truncated: true, body: Buffer.from('{"partial":') }) as OutboundTransportResponse,
      });
      const res = await invoke("big-1");
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe("upstream_response_truncated");
    });

    it("a non-JSON upstream body comes back as text; an empty body as null", async () => {
      getAggregatorRegistry().upsert(makeTool({ id: "text-1" }));
      injectOutbound({ respond: answer(200, "plain text result") });
      const text = await invoke("text-1");
      expect(text.statusCode).toBe(200);
      expect(text.json().result).toBe("plain text result");
      injectOutbound({ respond: answer(204) });
      const empty = await invoke("text-1");
      expect(empty.statusCode).toBe(200);
      expect(empty.json().result).toBeNull();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Site 4: MCP proxy, fetch(proxyRequest.url). Controls: the URL is not steerable.
// ═════════════════════════════════════════════════════════════════════════════

describe("site 4: MCP proxy URL construction (controls: not reproduced)", () => {
  let gw: Listener; // stands in for the configured API origin (PCC_API_BASE_URL)
  const signal = new AbortController().signal;

  const mkTool = (method: AgentPackageTool["endpoint"]["method"], path: string, name = "probe"): AgentPackageTool => ({
    name,
    description: "probe tool used by the SSRF-adjacent controls",
    input_schema: { type: "object" } as AgentPackageTool["input_schema"],
    endpoint: { method, path },
  });
  const call = (tool: AgentPackageTool, args: Record<string, unknown>) =>
    dispatchToolCall(new Map([[tool.name, tool]]), tool.name, args, undefined, signal);

  beforeAll(async () => {
    gw = await listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ from: "configured-origin" }));
    });
  });
  afterAll(async () => {
    await gw.close();
  });
  beforeEach(() => {
    gw.hits.length = 0;
    process.env.PCC_API_BASE_URL = `http://127.0.0.1:${gw.port}`;
  });

  it("[ctl] a caller-supplied path-parameter value cannot change the host: every spelling stays on the configured origin", async () => {
    const B = `127.0.0.1:${victim.port}`;
    const values = [
      `//${B}/internal`,
      `http://${B}/internal`,
      `https://${B}/internal`,
      `@${B}`,
      `\\\\${B}\\internal`,
      B,
      "../../../internal",
      "..",
      "%2e%2e/%2e%2e",
      "..;/..",
      `a\r\nHost: ${B}`,
      `a#@${B}`,
      `a?@${B}`,
      `x/${B}`,
    ];
    const landed: string[] = [];
    for (const v of values) {
      gw.hits.length = 0;
      for (const path of ["/api/things/{id}", "/api/things/:id/detail"]) {
        gw.hits.length = 0;
        const res = (await call(mkTool("GET", path), { id: v })) as { isError?: boolean; content: Array<{ text: string }> };
        expect(res.isError, `${JSON.stringify(v)} on ${path}`).toBeUndefined();
        expect(gw.hits, `${JSON.stringify(v)} on ${path}`).toHaveLength(1);
        landed.push(`${JSON.stringify(v)} -> origin${gw.hits[0]!.url}`);
      }
    }
    ev("site4 path-param", { victimHits: victim.hits.length, landedOnConfiguredOrigin: landed.length });
    console.log(`[SSRF-ADJ-REPRO] site4 path-param detail:\n  ${landed.join("\n  ")}`);
    expect(victim.hits).toHaveLength(0);
  });

  it("[ctl] a manifest path that tries to leave the origin: an absolute URL is reduced to its path; protocol-relative and backslash forms are refused", async () => {
    const B = `127.0.0.1:${victim.port}`;
    const absolute = (await call(mkTool("GET", `http://${B}/internal/abs`), {})) as { isError?: boolean };
    expect(absolute.isError).toBeUndefined();
    expect(gw.hits.map((h) => h.url)).toEqual(["/internal/abs"]);
    for (const path of [`//${B}/internal`, `\\\\${B}\\internal`, `/\\${B}/internal`]) {
      gw.hits.length = 0;
      const res = (await call(mkTool("GET", path), {})) as { isError?: boolean; content: Array<{ text: string }> };
      ev("site4 manifest-escape", { path, isError: res.isError ?? false, text: res.content[0]!.text.slice(0, 80), gwHits: gw.hits.length });
      expect(res.isError, path).toBe(true);
      expect(res.content[0]!.text, path).toMatch(/escaped the configured API origin/);
      expect(gw.hits, path).toHaveLength(0);
    }
    expect(victim.hits).toHaveLength(0);
  });

  it("[ctl] tool arguments named url/host/baseUrl/endpoint travel as query or body only, never as a destination", async () => {
    const B = `127.0.0.1:${victim.port}`;
    const args = { url: `http://${B}/`, host: B, baseUrl: `http://${B}`, endpoint: `http://${B}/internal`, path: `//${B}/internal` };
    for (const method of ["GET", "POST"] as const) {
      gw.hits.length = 0;
      const res = (await call(mkTool(method, "/api/fixed"), args)) as { isError?: boolean };
      expect(res.isError).toBeUndefined();
      expect(gw.hits).toHaveLength(1);
      expect(gw.hits[0]!.url.startsWith("/api/fixed")).toBe(true);
    }
    expect(victim.hits).toHaveLength(0);
  });

  it("[ctl] every tool in the shipped agent-package manifest resolves to the configured origin", async () => {
    const pack = loadAgentPackage();
    const proxied = pack.tools.filter((t) => !t.name.startsWith("pcc.op.") && t.name !== RENDER_DASHBOARD_TOOL_NAME);
    let landed = 0;
    for (const t of proxied) {
      const names = [...t.endpoint.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
      const args = Object.fromEntries(names.map((n) => [n, "x1"]));
      gw.hits.length = 0;
      const res = (await dispatchToolCall(new Map([[t.name, t]]), t.name, args, undefined, signal)) as { isError?: boolean; content: Array<{ text: string }> };
      expect(res.isError, `${t.name}: ${t.endpoint.path}`).toBeUndefined();
      expect(gw.hits, `${t.name}: ${t.endpoint.path}`).toHaveLength(1);
      landed++;
    }
    ev("site4 manifest-scan", {
      manifestTools: pack.tools.length,
      proxied: proxied.length,
      landedOnConfiguredOrigin: landed,
      absoluteUrlPaths: pack.tools.filter((t) => /^https?:\/\//i.test(t.endpoint.path)).map((t) => `${t.name} -> ${t.endpoint.path}`),
      protocolRelativePaths: pack.tools.filter((t) => t.endpoint.path.startsWith("//")).length,
      victimHits: victim.hits.length,
    });
    expect(landed).toBe(proxied.length);
    expect(victim.hits).toHaveLength(0);
  });
});
