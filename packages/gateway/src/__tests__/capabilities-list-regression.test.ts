/**
 * Regression tests for the catalog-list and type-filter P0/P1 bugs reported
 * 2026-06-17 (skylar smith / driver-agent saga). Three cascading failures:
 *
 *   1. POST /api/capabilities then GET /api/capabilities returned empty
 *      (despite the cap being inserted moments earlier).
 *   2. GET /api/capabilities?type=courier returned the same set as no-filter
 *      (filter was documented in DTOs but not implemented at the route).
 *
 * These tests register caps via the real upsert path, then assert the list
 * endpoint reflects them and the type filter narrows the set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore, getRepos } from "../db.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(capabilityRoutes);
  await app.ready();
  return app;
}

describe("GET /api/capabilities -- list correctness (P0 regression)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("returns the same total as the underlying repository findAll()", async () => {
    const repoCount = getRepos().capabilities.findAll().length;
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(repoCount);
    expect(Array.isArray(body.items)).toBe(true);
    // A seeded DB should never return zero items here -- if it does, the
    // route is silently dropping rows from the facade response.
    expect(body.items.length).toBeGreaterThan(0);
  });

  it("register-then-list round-trip surfaces the newly-registered cap", async () => {
    const kernelId = "kernel-nyc"; // a seeded kernel
    const registerRes = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      payload: {
        kernelId,
        type: "pizza.order",
        id: "cap-regression-pizza-order",
        name: "Pizza Order (regression)",
      },
    });
    expect([200, 201]).toContain(registerRes.statusCode);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/capabilities?limit=200",
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    const ids = listBody.items.map((c: any) => c.id);
    expect(ids).toContain("cap-regression-pizza-order");
  });

  it("each item has the canonical CapabilityDTO shape (id, kernelId, type)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.kernelId).toBe("string");
      expect(typeof item.type).toBe("string");
    }
  });
});

describe("GET /api/capabilities?type= -- type-filter (P1 regression)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("type=courier.dispatch narrows the set to courier caps only", async () => {
    await app.inject({
      method: "POST",
      url: "/api/capabilities",
      payload: {
        kernelId: "kernel-nyc",
        type: "courier.dispatch",
        id: "cap-regression-courier-dispatch",
      },
    });

    const all = await app.inject({
      method: "GET",
      url: "/api/capabilities?limit=200",
    });
    const allBody = all.json();
    const filtered = await app.inject({
      method: "GET",
      url: "/api/capabilities?type=courier.dispatch&limit=200",
    });
    expect(filtered.statusCode).toBe(200);
    const filteredBody = filtered.json();

    expect(filteredBody.total).toBeLessThan(allBody.total);
    for (const item of filteredBody.items) {
      expect(item.type).toBe("courier.dispatch");
    }
    const ids = filteredBody.items.map((c: any) => c.id);
    expect(ids).toContain("cap-regression-courier-dispatch");
  });

  it("type= with no match returns an empty items array (not 400, not all rows)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities?type=does.not.exist.anywhere",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  it("unknown query params are tolerated (do not 400 a public discovery surface)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities?foo=bar&baz=qux",
    });
    expect(res.statusCode).toBe(200);
  });
});
