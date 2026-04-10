/**
 * Tests for idempotency middleware.
 *
 * Covers:
 * - Duplicate request with same key → returns cached response + Idempotency-Replayed: true
 * - Different keys → both execute independently
 * - Expired key → re-executes and refreshes cache
 * - No key header → passes through (no idempotency)
 * - GET requests → ignored (idempotency only on mutations)
 * - Method/path mismatch → 422
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { idempotencyGate, _clearCacheForTesting, _getCacheSizeForTesting } from "../middleware/idempotency.js";

// ---------------------------------------------------------------------------
// Test app helpers
// ---------------------------------------------------------------------------

/** Counter to verify how many times the real handler was invoked. */
let handlerCallCount = 0;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(idempotencyGate);

  // POST route that is in IDEMPOTENCY_ROUTES
  app.post("/api/capabilities/quote", async (_req, reply) => {
    handlerCallCount++;
    return reply.status(200).send({ quote: `quote-${handlerCallCount}`, amount: "1.00" });
  });

  // POST route that is NOT in IDEMPOTENCY_ROUTES (should pass through uncached)
  app.post("/api/capabilities/other", async (_req, reply) => {
    handlerCallCount++;
    return reply.status(200).send({ count: handlerCallCount });
  });

  // GET route on a gated path (should never be idempotency-protected)
  app.get("/api/capabilities/quote", async (_req, reply) => {
    handlerCallCount++;
    return reply.status(200).send({ info: "get response" });
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("idempotencyGate", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    handlerCallCount = 0;
    _clearCacheForTesting();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    _clearCacheForTesting();
  });

  // ── Core behaviour ───────────────────────────────────────────────

  it("first request executes the handler and returns live response", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-001", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().quote).toBe("quote-1");
    expect(res.headers["idempotency-replayed"]).toBeUndefined();
    expect(handlerCallCount).toBe(1);
  });

  it("duplicate request with same key returns cached response + Idempotency-Replayed header", async () => {
    // First request
    await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-002", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Second request with same key
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-002", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    // Should return the first response (quote-1), not a new one (quote-2)
    expect(res.json().quote).toBe("quote-1");
    expect(res.headers["idempotency-replayed"]).toBe("true");
    // Handler should only have been called once
    expect(handlerCallCount).toBe(1);
  });

  it("different keys both execute independently", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-key-A", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res2 = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-key-B", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    // Both should show fresh handler results
    expect(res1.json().quote).toBe("quote-1");
    expect(res2.json().quote).toBe("quote-2");
    expect(res1.headers["idempotency-replayed"]).toBeUndefined();
    expect(res2.headers["idempotency-replayed"]).toBeUndefined();
    expect(handlerCallCount).toBe(2);
  });

  it("no Idempotency-Key header passes through without caching", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res2 = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    // Both should hit the handler
    expect(handlerCallCount).toBe(2);
    expect(res1.headers["idempotency-replayed"]).toBeUndefined();
    expect(res2.headers["idempotency-replayed"]).toBeUndefined();
    // Cache should remain empty
    expect(_getCacheSizeForTesting()).toBe(0);
  });

  it("GET requests are never idempotency-protected", async () => {
    // Build a separate app that has GET on an idempotency route (which still won't be cached)
    const res1 = await app.inject({
      method: "GET",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "get-key-001" },
    });

    const res2 = await app.inject({
      method: "GET",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "get-key-001" },
    });

    // Both should hit the handler — GET is never cached
    expect(handlerCallCount).toBe(2);
    expect(res1.headers["idempotency-replayed"]).toBeUndefined();
    expect(res2.headers["idempotency-replayed"]).toBeUndefined();
  });

  it("route not in IDEMPOTENCY_ROUTES is not cached even with key", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: "/api/capabilities/other",
      headers: { "idempotency-key": "idem-other-001", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res2 = await app.inject({
      method: "POST",
      url: "/api/capabilities/other",
      headers: { "idempotency-key": "idem-other-001", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Both should hit the handler — route is not protected by idempotency
    expect(handlerCallCount).toBe(2);
    expect(res2.headers["idempotency-replayed"]).toBeUndefined();
  });

  // ── Expiry behaviour ─────────────────────────────────────────────

  it("expired key re-executes and updates the cache", async () => {
    // Fake time to simulate TTL expiry
    const realNow = Date.now;
    let fakeTime = Date.now();

    vi.spyOn(Date, "now").mockImplementation(() => fakeTime);

    // First request — cache the response
    await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-expire-001", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(handlerCallCount).toBe(1);

    // Advance time past the TTL (24h + 1ms)
    const ttl = parseInt(process.env.IDEMPOTENCY_TTL_MS ?? "", 10) || 24 * 60 * 60 * 1000;
    fakeTime += ttl + 1;

    // Second request — cache entry should be expired, handler should re-execute
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-expire-001", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(200);
    // handler ran again — quote-2 this time
    expect(res.json().quote).toBe("quote-2");
    expect(res.headers["idempotency-replayed"]).toBeUndefined();
    expect(handlerCallCount).toBe(2);

    vi.restoreAllMocks();
  });

  // ── Method/path mismatch ─────────────────────────────────────────

  it("reusing key on different path returns 422", async () => {
    // First: use the key for /api/capabilities/quote (POST)
    await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-mismatch-001", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Second: try to use the same key for a route in IDEMPOTENCY_ROUTES but different path
    // We need to register /api/capabilities/simulate in the app to test this
    // Instead, test using simulate (also in IDEMPOTENCY_ROUTES) after registering it below
    // For now, test method mismatch on the same route by building a dedicated app
    const appMismatch = Fastify({ logger: false });
    let mismatchCallCount = 0;

    await appMismatch.register(idempotencyGate);

    appMismatch.post("/api/capabilities/quote", async (_req, reply) => {
      mismatchCallCount++;
      return reply.status(200).send({ quote: "orig" });
    });
    appMismatch.post("/api/capabilities/simulate", async (_req, reply) => {
      mismatchCallCount++;
      return reply.status(200).send({ simulate: "result" });
    });
    await appMismatch.ready();

    // First request on quote with key "x"
    await appMismatch.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-mismatch-002", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    // Reuse same key on simulate — different path, should 422
    const res = await appMismatch.inject({
      method: "POST",
      url: "/api/capabilities/simulate",
      headers: { "idempotency-key": "idem-mismatch-002", "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("idempotency_key_reuse");
    expect(body.original.path).toBe("/api/capabilities/quote");
    expect(body.current.path).toBe("/api/capabilities/simulate");

    await appMismatch.close();
  });

  // ── Cache isolation by client ─────────────────────────────────────

  it("same idempotency key from different clients does not collide", async () => {
    // Client A: no auth header
    const resA = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: {
        "idempotency-key": "shared-key",
        "content-type": "application/json",
        // no authorization header — will be "anon"
      },
      body: JSON.stringify({}),
    });

    // Client B: different API key
    const resB = await app.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: {
        "idempotency-key": "shared-key",
        "content-type": "application/json",
        "authorization": "Bearer pcc_test_different_client_xyz",
      },
      body: JSON.stringify({}),
    });

    // Both should have executed (different client namespaces)
    expect(handlerCallCount).toBe(2);
    // Neither should be a replay
    expect(resA.headers["idempotency-replayed"]).toBeUndefined();
    expect(resB.headers["idempotency-replayed"]).toBeUndefined();
  });

  it("replayed response uses same status code as original", async () => {
    // Build a custom app that returns a non-200 success
    const appCustom = Fastify({ logger: false });
    await appCustom.register(idempotencyGate);

    appCustom.post("/api/capabilities/quote", async (_req, reply) => {
      return reply.status(201).send({ created: true });
    });
    await appCustom.ready();

    // First request
    const first = await appCustom.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-201", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(first.statusCode).toBe(201);

    // Second request — should replay with 201
    const second = await appCustom.inject({
      method: "POST",
      url: "/api/capabilities/quote",
      headers: { "idempotency-key": "idem-201", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(second.statusCode).toBe(201);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    expect(second.json().created).toBe(true);

    await appCustom.close();
  });
});
