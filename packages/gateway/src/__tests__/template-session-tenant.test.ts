/**
 * N58: an onboarding-template session belongs to the tenant that started it.
 *
 * Every `:id` route of templateSessionRoutes (/scrape, /ingest-docs,
 * /build-agent, GET /status, GET /live-data) answers 404 unless the caller's
 * tenant started the session: the same answer as an unknown id, so another
 * tenant's key holding a leaked id can neither read the event log nor drive
 * /build-agent, and cannot even learn that the session exists. The check
 * fails closed on a missing actor: a caller with no tenant matches nothing,
 * not even a session stored with a null tenant.
 *
 * Tenants come from real API keys (apiGate + tenantContext, as in
 * template-session.test.ts). The missing-actor cases use a mount without
 * apiGate whose hook sets req.tenantId from a test header, because an
 * authenticated request always has a tenant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { templateSessionRoutes, _resetSessionsForTests } from "../routes/template-session.js";
import { initStore, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";
import { auditService } from "../services/audit-service.js";

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

function stubAgent() {
  return {
    onStart: vi.fn().mockResolvedValue(undefined),
    onScrape: vi.fn().mockResolvedValue({ ok: true }),
    onIngestDocs: vi.fn().mockResolvedValue(undefined),
    onBuild: vi.fn().mockResolvedValue({ capabilities: ["test:cap"], operator_id: "op-1" }),
  };
}

type Agent = ReturnType<typeof stubAgent>;

interface Route {
  name: string;
  method: "GET" | "POST";
  suffix: string;
  payload?: Record<string, unknown>;
  /** The agent hook this route drives, if any: it must not run for a stranger. */
  hook?: keyof Agent;
}

const ROUTES: Route[] = [
  { name: "POST /:id/scrape", method: "POST", suffix: "scrape", payload: { url: "https://example.test" }, hook: "onScrape" },
  { name: "POST /:id/ingest-docs", method: "POST", suffix: "ingest-docs", payload: { doc_urls: ["local://a"] }, hook: "onIngestDocs" },
  { name: "POST /:id/build-agent", method: "POST", suffix: "build-agent", payload: {}, hook: "onBuild" },
  { name: "GET /:id/status", method: "GET", suffix: "status" },
  { name: "GET /:id/live-data", method: "GET", suffix: "live-data" },
];

const MOUNTS = [
  { prefix: "/api/onboard", template: "physical-operator" },
  { prefix: "/api/orchestrator/data-product", template: "data-product" },
];

describe.each(MOUNTS)("N58 tenant check at $prefix", ({ prefix, template }) => {
  let app: FastifyInstance;
  let agent: Agent;
  let ownerKey: string;
  let strangerKey: string;

  beforeEach(async () => {
    _resetSessionsForTests();
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    ownerKey = provisionApiKey({ operatorId: "owner@example.com", name: "owner", scopes: ["*"] }).rawKey;
    strangerKey = provisionApiKey({ operatorId: "stranger@example.com", name: "stranger", scopes: ["*"] }).rawKey;
    agent = stubAgent();
    app = Fastify({ logger: false });
    await app.register(apiGate);
    await app.register(tenantContext);
    await app.register(templateSessionRoutes, { routePrefix: prefix, template, agentFactory: () => agent });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    _resetSessionsForTests();
  });

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });

  async function start(key: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: `${prefix}/start`, headers: auth(key), payload: { name: "Acme" } });
    expect(res.statusCode).toBe(200);
    return res.json().session_id as string;
  }

  const call = (route: Route, id: string, key: string, payload = route.payload) =>
    app.inject({ method: route.method, url: `${prefix}/${id}/${route.suffix}`, headers: auth(key), ...(payload ? { payload } : {}) });

  async function ownerView(id: string) {
    const res = await app.inject({ method: "GET", url: `${prefix}/${id}/live-data`, headers: auth(ownerKey) });
    expect(res.statusCode).toBe(200);
    return res.json() as { events: unknown[]; updated_at: number };
  }

  for (const route of ROUTES) {
    it(`${route.name}: another tenant gets the unknown-id 404, and nothing happens`, async () => {
      const id = await start(ownerKey);
      const before = await ownerView(id);

      const stranger = await call(route, id, strangerKey);
      const unknown = await call(route, "00000000-0000-4000-8000-000000000000", strangerKey);
      expect(stranger.statusCode).toBe(404);
      expect(stranger.json()).toEqual({ error: "session_not_found" });
      expect(stranger.json()).toEqual(unknown.json());

      if (route.hook) expect(agent[route.hook]).not.toHaveBeenCalled();
      const after = await ownerView(id);
      expect(after.events).toEqual(before.events);
      expect(after.updated_at).toBe(before.updated_at);
    });

    it(`${route.name}: the owner still gets through`, async () => {
      const id = await start(ownerKey);
      const res = await call(route, id, ownerKey);
      expect(res.statusCode).toBe(200);
      if (route.hook) expect(agent[route.hook]).toHaveBeenCalledTimes(1);
    });
  }

  it("a stranger's malformed body still gets 404, not 400: validation is no oracle for the id", async () => {
    const id = await start(ownerKey);
    for (const route of ROUTES.filter((r) => r.method === "POST" && r.suffix !== "build-agent")) {
      const res = await call(route, id, strangerKey, {});
      expect(res.statusCode).toBe(404);
      const own = await call(route, id, ownerKey, {});
      expect(own.statusCode).toBe(400);
    }
  });

  it("a stranger cannot publish the owner's session through /build-agent", async () => {
    const id = await start(ownerKey);
    const res = await call(ROUTES[2], id, strangerKey);
    expect(res.statusCode).toBe(404);
    expect(agent.onBuild).not.toHaveBeenCalled();
    const status = await app.inject({ method: "GET", url: `${prefix}/${id}/status`, headers: auth(ownerKey) });
    expect(status.json().state).toBe("started");
    expect(status.json().publication).toBeNull();
  });
});

describe("N58 fails closed on a missing actor", () => {
  const prefix = "/api/onboard";
  let app: FastifyInstance;

  beforeEach(async () => {
    _resetSessionsForTests();
    app = Fastify({ logger: false });
    // An authenticated request always has a tenant, so this mount skips
    // apiGate and takes the tenant from a test header (absent -> null).
    app.addHook("onRequest", async (req) => {
      const header = req.headers["x-test-tenant"];
      req.tenantId = typeof header === "string" ? header : null;
    });
    await app.register(templateSessionRoutes, { routePrefix: prefix, template: "physical-operator", agentFactory: stubAgent });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    _resetSessionsForTests();
  });

  const as = (tenant?: string) => (tenant === undefined ? {} : { "x-test-tenant": tenant });

  async function start(tenant?: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: `${prefix}/start`, headers: as(tenant), payload: { name: "Acme" } });
    expect(res.statusCode).toBe(200);
    return res.json().session_id as string;
  }

  const status = (id: string, tenant?: string) =>
    app.inject({ method: "GET", url: `${prefix}/${id}/status`, headers: as(tenant) });

  it("a session stored with a null tenant is reachable by no one, not even a caller with no tenant", async () => {
    const id = await start();
    expect((await status(id)).statusCode).toBe(404);
    expect((await status(id, "anyone")).statusCode).toBe(404);
  });

  it("a session started with an empty tenant is reachable by no one, not even an empty-tenant caller", async () => {
    const id = await start("");
    expect((await status(id, "")).statusCode).toBe(404);
    expect((await status(id)).statusCode).toBe(404);
  });

  it("a caller with no tenant, or an empty one, never matches a tenant's session", async () => {
    const id = await start("tenant-a");
    expect((await status(id)).statusCode).toBe(404);
    expect((await status(id, "")).statusCode).toBe(404);
    expect((await status(id, "tenant-b")).statusCode).toBe(404);
    expect((await status(id, "tenant-a")).statusCode).toBe(200);
  });
});


/**
 * Verdict 75 on #443, each failed at 874c5c46:
 * - MEDIUM: both mounts share one session store, and ownedSession checked the
 *   tenant but not the template, so an owner could drive one mount's session
 *   through the other mount's hooks;
 * - CRITICAL (this file's half): /start wrote the session id, name and URL to
 *   the audit log, which other tenants can read through unscoped audit routes
 *   (the read scoping is the gateway lane's).
 */
describe("verdict 75: a session stays in its mount and leaves no usable trail in the audit log", () => {
  let app: FastifyInstance;
  let ownerKey: string;
  let agents: Record<string, Agent>;

  beforeEach(async () => {
    _resetSessionsForTests();
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: false });
    ownerKey = provisionApiKey({ operatorId: "owner@example.com", name: "owner", scopes: ["*"] }).rawKey;
    agents = { "physical-operator": stubAgent(), "data-product": stubAgent() };
    app = Fastify({ logger: false });
    await app.register(apiGate);
    await app.register(tenantContext);
    for (const { prefix, template } of MOUNTS) {
      await app.register(templateSessionRoutes, { routePrefix: prefix, template, agentFactory: () => agents[template] });
    }
    await app.ready();
    vi.mocked(auditService.log).mockClear();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
    _resetSessionsForTests();
  });

  const headers = () => ({ authorization: `Bearer ${ownerKey}` });

  it("M3: a session started on one mount is unknown to the other, even to its owner", async () => {
    const started = await app.inject({ method: "POST", url: "/api/onboard/start", headers: headers(), payload: { name: "Acme" } });
    const id = started.json().session_id as string;
    for (const route of ROUTES) {
      const res = await app.inject({ method: route.method, url: `/api/orchestrator/data-product/${id}/${route.suffix}`,
        headers: headers(), ...(route.payload ? { payload: route.payload } : {}) });
      expect(res.statusCode, route.name).toBe(404);
      if (route.hook) expect(agents["data-product"][route.hook], route.name).not.toHaveBeenCalled();
    }
    const own = await app.inject({ method: "GET", url: `/api/onboard/${id}/status`, headers: headers() });
    expect(own.statusCode).toBe(200);
  });

  it("C2: the audit log carries neither the session id nor its name or URL", async () => {
    const started = await app.inject({ method: "POST", url: "/api/onboard/start", headers: headers(),
      payload: { name: "Secret project", url: "https://secret.example/plans" } });
    const id = started.json().session_id as string;
    const logged = JSON.stringify(vi.mocked(auditService.log).mock.calls);
    expect(logged).toContain("physical-operator.session_started");
    expect(logged).not.toContain(id);
    expect(logged).not.toContain("Secret project");
    expect(logged).not.toContain("secret.example");
  });
});
