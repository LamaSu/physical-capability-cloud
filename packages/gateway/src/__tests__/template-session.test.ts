/**
 * repair-tier0-routes: tests for the generic templateSessionRoutes plugin.
 *
 * Coverage:
 *   - 401 without Authorization on every route (auth gate honoured)
 *   - 200 happy path with a valid Bearer key on every route
 *   - 400 on missing/invalid body fields
 *   - 404 on unknown :id
 *   - Both mounts (physical-operator at /api/onboard, data-product at
 *     /api/orchestrator/data-product) share the same shape
 *
 * Auth approach: provision a real test API key via the api-keys repo so the
 * apiGate's resolveApiKey() succeeds. Mirrors how onboard-register-auth.test.ts
 * tests the auth path (401 first, then we extend with 200).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { tenantContext } from "../middleware/tenant-context.js";
import { templateSessionRoutes, _resetSessionsForTests } from "../routes/template-session.js";
import { initStore, closeStore } from "../db.js";
import { provisionApiKey } from "../auth/api-key-auth.js";

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

// Stub agent that records calls without doing real work — keeps the tests
// deterministic and offline.
const stubAgent = () => ({
  onStart: vi.fn().mockResolvedValue(undefined),
  onScrape: vi.fn().mockResolvedValue({ ok: true, scraped: "stub" }),
  onIngestDocs: vi.fn().mockResolvedValue(undefined),
  onBuild: vi.fn().mockResolvedValue({
    capabilities: ["test:cap-a", "test:cap-b"],
    operator_id: "op-stub-001",
    discovery_url: "https://example.test/operators/stub",
  }),
});

interface TestApp {
  app: FastifyInstance;
  apiKey: string;
}

async function buildApp(prefix: string, template: string): Promise<TestApp> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });

  // Provision a real API key the apiGate can validate against.
  const { rawKey } = provisionApiKey({
    operatorId: "test-operator@example.com",
    name: "test key",
    scopes: ["*"],
  });

  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(tenantContext);
  await app.register(templateSessionRoutes, {
    routePrefix: prefix,
    template,
    agentFactory: stubAgent,
  });
  await app.ready();
  return { app, apiKey: rawKey };
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

describe("templateSessionRoutes — physical-operator mount at /api/onboard", () => {
  let testApp: TestApp;
  const PREFIX = "/api/onboard";

  beforeEach(async () => {
    _resetSessionsForTests();
    testApp = await buildApp(PREFIX, "physical-operator");
  });

  afterEach(async () => {
    await testApp.app.close();
    closeStore();
    _resetSessionsForTests();
  });

  describe("auth gate", () => {
    it("POST /start returns 401 without Authorization header", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        payload: { name: "Test Op" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("api_key_required");
    });

    it("POST /:id/scrape returns 401 without Authorization", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/sess-x/scrape`,
        payload: { url: "https://example.test" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /:id/status returns 401 without Authorization", async () => {
      const res = await testApp.app.inject({
        method: "GET",
        url: `${PREFIX}/sess-x/status`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /:id/live-data returns 401 without Authorization", async () => {
      const res = await testApp.app.inject({
        method: "GET",
        url: `${PREFIX}/sess-x/live-data`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with an invalid Bearer token", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: { authorization: "Bearer pcc_live_invalid_xyz" },
        payload: { name: "Test Op" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("happy path with valid Bearer", () => {
    it("POST /start creates a session and returns session_id + state", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: auth(testApp.apiKey),
        payload: { name: "Oakland Titanium Mills", url: "https://oakland-titanium-mills.example" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.session_id).toBe("string");
      expect(body.session_id.length).toBeGreaterThan(0);
      expect(body.state).toBe("started");
    });

    it("full flow: start -> scrape -> ingest-docs -> build-agent -> status -> live-data", async () => {
      // 1. start
      const startRes = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: auth(testApp.apiKey),
        payload: { name: "Acme Robotics", url: "https://acme-robotics.example" },
      });
      expect(startRes.statusCode).toBe(200);
      const sessionId = startRes.json().session_id;

      // 2. scrape
      const scrapeRes = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/${sessionId}/scrape`,
        headers: auth(testApp.apiKey),
        payload: { url: "https://acme-robotics.example/about" },
      });
      expect(scrapeRes.statusCode).toBe(200);
      expect(scrapeRes.json().ok).toBe(true);
      expect(scrapeRes.json().scraped).toMatchObject({ ok: true, scraped: "stub" });

      // 3. ingest-docs
      const ingestRes = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/${sessionId}/ingest-docs`,
        headers: auth(testApp.apiKey),
        payload: { doc_urls: ["local://datasheet.pdf", "https://example.test/manual.pdf"] },
      });
      expect(ingestRes.statusCode).toBe(200);
      expect(ingestRes.json()).toMatchObject({ ok: true, ingested: 2 });

      // 4. build-agent
      const buildRes = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/${sessionId}/build-agent`,
        headers: auth(testApp.apiKey),
        payload: {},
      });
      expect(buildRes.statusCode).toBe(200);
      const buildBody = buildRes.json();
      expect(buildBody.ok).toBe(true);
      expect(buildBody.capabilities).toEqual(["test:cap-a", "test:cap-b"]);
      expect(buildBody.publication.discovery_url).toBe("https://example.test/operators/stub");

      // 5. status
      const statusRes = await testApp.app.inject({
        method: "GET",
        url: `${PREFIX}/${sessionId}/status`,
        headers: auth(testApp.apiKey),
      });
      expect(statusRes.statusCode).toBe(200);
      const statusBody = statusRes.json();
      expect(statusBody.session_id).toBe(sessionId);
      expect(statusBody.state).toBe("built");
      expect(statusBody.progress).toBe(100);
      expect(statusBody.scraped_count).toBe(1);
      expect(statusBody.ingested_count).toBe(2);
      expect(statusBody.publication.capabilities).toEqual(["test:cap-a", "test:cap-b"]);

      // 6. live-data
      const liveRes = await testApp.app.inject({
        method: "GET",
        url: `${PREFIX}/${sessionId}/live-data`,
        headers: auth(testApp.apiKey),
      });
      expect(liveRes.statusCode).toBe(200);
      const liveBody = liveRes.json();
      expect(liveBody.session_id).toBe(sessionId);
      expect(Array.isArray(liveBody.events)).toBe(true);
      // session_started + scrape_kicked_off + scrape_complete + docs_ingest_kicked_off + docs_ingested + build_kicked_off + build_complete = 7
      expect(liveBody.events.length).toBeGreaterThanOrEqual(7);
      // Events should be in chronological order (ascending t).
      for (let i = 1; i < liveBody.events.length; i++) {
        expect(liveBody.events[i].t).toBeGreaterThanOrEqual(liveBody.events[i - 1].t);
      }
      // First event = session_started.
      expect(liveBody.events[0].type).toBe("session_started");
      // Last event = build_complete.
      expect(liveBody.events[liveBody.events.length - 1].type).toBe("build_complete");
    });
  });

  describe("validation errors", () => {
    it("POST /start returns 400 when name is missing", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: auth(testApp.apiKey),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("name_required");
    });

    it("POST /start returns 400 when name is empty string", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: auth(testApp.apiKey),
        payload: { name: "   " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /:id/scrape returns 400 when url is missing", async () => {
      const startRes = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: auth(testApp.apiKey),
        payload: { name: "Acme" },
      });
      const sessionId = startRes.json().session_id;
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/${sessionId}/scrape`,
        headers: auth(testApp.apiKey),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("url_required");
    });

    it("POST /:id/ingest-docs returns 400 when doc_urls is empty", async () => {
      const startRes = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: auth(testApp.apiKey),
        payload: { name: "Acme" },
      });
      const sessionId = startRes.json().session_id;
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/${sessionId}/ingest-docs`,
        headers: auth(testApp.apiKey),
        payload: { doc_urls: [] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("doc_urls_required");
    });
  });

  describe("session lookup errors", () => {
    it("POST /:id/scrape returns 404 for unknown session id", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/does-not-exist/scrape`,
        headers: auth(testApp.apiKey),
        payload: { url: "https://example.test" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("session_not_found");
    });

    it("POST /:id/build-agent returns 404 for unknown session id", async () => {
      const res = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/does-not-exist/build-agent`,
        headers: auth(testApp.apiKey),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("GET /:id/status returns 404 for unknown session id", async () => {
      const res = await testApp.app.inject({
        method: "GET",
        url: `${PREFIX}/does-not-exist/status`,
        headers: auth(testApp.apiKey),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("live-data ?since= filtering", () => {
    it("returns only events newer than the cursor", async () => {
      const startRes = await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/start`,
        headers: auth(testApp.apiKey),
        payload: { name: "Cursor Co" },
      });
      const sessionId = startRes.json().session_id;

      // Snapshot the first cursor.
      const firstLive = await testApp.app.inject({
        method: "GET",
        url: `${PREFIX}/${sessionId}/live-data`,
        headers: auth(testApp.apiKey),
      });
      const firstCursor = firstLive.json().cursor as number;
      expect(firstCursor).toBeGreaterThan(0);

      // Advance the timeline with another action.
      await new Promise((r) => setTimeout(r, 5));
      await testApp.app.inject({
        method: "POST",
        url: `${PREFIX}/${sessionId}/scrape`,
        headers: auth(testApp.apiKey),
        payload: { url: "https://example.test" },
      });

      // Poll with the cursor — should only return the new events.
      const sinceLive = await testApp.app.inject({
        method: "GET",
        url: `${PREFIX}/${sessionId}/live-data?since=${firstCursor}`,
        headers: auth(testApp.apiKey),
      });
      expect(sinceLive.statusCode).toBe(200);
      const events = sinceLive.json().events as Array<{ type: string; t: number }>;
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) {
        expect(ev.t).toBeGreaterThan(firstCursor);
      }
    });
  });
});

describe("templateSessionRoutes — data-product mount at /api/orchestrator/data-product", () => {
  let testApp: TestApp;
  const PREFIX = "/api/orchestrator/data-product";

  beforeEach(async () => {
    _resetSessionsForTests();
    testApp = await buildApp(PREFIX, "data-product");
  });

  afterEach(async () => {
    await testApp.app.close();
    closeStore();
    _resetSessionsForTests();
  });

  it("POST /start under the data-product prefix returns a session_id", async () => {
    const res = await testApp.app.inject({
      method: "POST",
      url: `${PREFIX}/start`,
      headers: auth(testApp.apiKey),
      payload: { name: "Acme Postgres Dataset" },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().session_id).toBe("string");
  });

  it("returns 401 on the data-product prefix without auth (proves apiGate covers both mounts)", async () => {
    const res = await testApp.app.inject({
      method: "POST",
      url: `${PREFIX}/start`,
      payload: { name: "Test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("status reports the right template slug", async () => {
    const startRes = await testApp.app.inject({
      method: "POST",
      url: `${PREFIX}/start`,
      headers: auth(testApp.apiKey),
      payload: { name: "Test DP" },
    });
    const sessionId = startRes.json().session_id;
    const statusRes = await testApp.app.inject({
      method: "GET",
      url: `${PREFIX}/${sessionId}/status`,
      headers: auth(testApp.apiKey),
    });
    expect(statusRes.json().template).toBe("data-product");
  });
});
