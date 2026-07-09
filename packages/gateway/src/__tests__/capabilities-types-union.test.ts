/**
 * Tests for GET /api/capabilities/types — the "shop window" union.
 *
 * The endpoint historically returned ONLY the built-in compile-time templates
 * (getRegisteredTypes), so it under-advertised a system that already accepts,
 * prices, and composes arbitrary capability types. These tests pin the fix:
 * the endpoint now returns the UNION of
 *   1. built-in template types,
 *   2. distinct `type` values registered in the capabilities table
 *      (including ad-hoc types with no compile-time template), and
 *   3. CSD-registered types,
 * deduped + sorted — and it fails SAFE (DB error → templates, never a 500).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { getRegisteredTypes } from "@pcc/contract-builder";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore } from "../db.js";

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(capabilityRoutes);
  await app.ready();
  return app;
}

describe("GET /api/capabilities/types -- union of templates + catalog + CSD", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("advertises an ad-hoc registered type that has NO compile-time template", async () => {
    // A type the network can price/compose but ships no template for. Before
    // the fix this could never appear in /types — the shop window lied.
    const AD_HOC = "wood-fired-pizza";
    expect(getRegisteredTypes()).not.toContain(AD_HOC); // guard: truly template-less

    const reg = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      payload: {
        kernelId: "kernel-nyc", // a seeded kernel
        type: AD_HOC,
        id: "cap-test-wood-fired-pizza",
        name: "Wood-fired pizza (ad-hoc)",
      },
    });
    expect([200, 201]).toContain(reg.statusCode);

    const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.types)).toBe(true);
    // The ad-hoc type now advertises — the shop window tells the truth.
    expect(body.types).toContain(AD_HOC);
  });

  it("still includes every built-in template type (backward-compatible superset)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
    const body = res.json();
    for (const t of getRegisteredTypes()) {
      expect(body.types).toContain(t);
    }
  });

  it("includes CSD-registered types with no matching template (e.g. make-pizza)", async () => {
    // `make-pizza` is a built-in CSD slug (pcc://capabilities/make-pizza/v1) but
    // is NOT a registered template — its presence proves the CSD path feeds
    // the union.
    expect(getRegisteredTypes()).not.toContain("make-pizza");
    const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
    const body = res.json();
    expect(body.types).toContain("make-pizza");
  });

  it("returns a deduped, sorted, string[] (stable shape for public clients)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
    const body = res.json();
    expect(Array.isArray(body.types)).toBe(true);
    for (const t of body.types) expect(typeof t).toBe("string");
    // deduped
    expect(new Set(body.types).size).toBe(body.types.length);
    // sorted (lexicographic, matching [...set].sort())
    const sorted = [...body.types].sort();
    expect(body.types).toEqual(sorted);
  });
});

describe("GET /api/capabilities/types -- fail-safe (never 500)", () => {
  it("DB error falls back to the built-in templates with a 200, not a 500", async () => {
    process.env.PCC_DB_PATH = ":memory:";
    initStore({ seed: true });
    const app = Fastify({ logger: false });
    await app.register(capabilityRoutes);
    await app.ready();

    // Force a DB failure: closing the store makes getRepos() throw inside the
    // facade the moment the distinct-type query runs. The route must catch it,
    // fall back to templates, and still answer 200 with the canonical shape.
    closeStore();

    const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
    expect(res.statusCode).toBe(200); // never 500
    const body = res.json();
    expect(Array.isArray(body.types)).toBe(true);
    // Fell back to (at least) the built-in templates.
    for (const t of getRegisteredTypes()) {
      expect(body.types).toContain(t);
    }

    await app.close();
  });
});
