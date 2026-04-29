/**
 * repair-tier0-routes: tests for orchestratorTemplatesRoutes.
 *
 * Two routes, both intentionally PUBLIC (no auth):
 *   GET  /api/orchestrator/templates           — static directory list
 *   POST /api/capabilities/templates/match     — heuristic matcher
 *
 * Tests:
 *   - GET returns the two known slugs (physical-operator, data-product)
 *     with the dashboard-mirroring shape.
 *   - GET works WITHOUT an Authorization header (proves PUBLIC_EXACT entry).
 *   - POST /match returns 400 on missing input.
 *   - POST /match scores physical and data inputs correctly.
 *   - POST /match works WITHOUT auth.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { orchestratorTemplatesRoutes, matchTemplates } from "../routes/orchestrator-templates.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: false });
  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(orchestratorTemplatesRoutes);
  await app.ready();
  return app;
}

describe("orchestratorTemplatesRoutes — GET /api/orchestrator/templates", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("returns 200 WITHOUT auth header (route is PUBLIC_EXACT)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/orchestrator/templates",
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns the two known templates with the chat-console mirror shape", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/orchestrator/templates",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { templates: Array<Record<string, unknown>> };
    expect(Array.isArray(body.templates)).toBe(true);
    expect(body.templates.length).toBe(2);
    const slugs = body.templates.map((t) => t.slug);
    expect(slugs).toContain("physical-operator");
    expect(slugs).toContain("data-product");
  });

  it("each template entry has the seven required fields the dashboard renders", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/orchestrator/templates",
    });
    const body = res.json() as { templates: Array<Record<string, unknown>> };
    for (const tpl of body.templates) {
      expect(typeof tpl.slug).toBe("string");
      expect(typeof tpl.display_name).toBe("string");
      expect(typeof tpl.description).toBe("string");
      expect(typeof tpl.produces_kind).toBe("string");
      expect(typeof tpl.capability_class).toBe("string");
      expect(typeof tpl.greeting).toBe("string");
      expect(typeof tpl.api_base).toBe("string");
      expect(["physical", "digital"]).toContain(tpl.capability_class);
    }
  });

  it("api_base values match the chat console's expected mounts", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/orchestrator/templates",
    });
    const body = res.json() as { templates: Array<{ slug: string; api_base: string }> };
    const physical = body.templates.find((t) => t.slug === "physical-operator");
    const digital = body.templates.find((t) => t.slug === "data-product");
    expect(physical?.api_base).toBe("/api/onboard");
    expect(digital?.api_base).toBe("/api/orchestrator/data-product");
  });
});

describe("orchestratorTemplatesRoutes — POST /api/capabilities/templates/match", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("returns 200 WITHOUT auth header (route is PUBLIC_EXACT)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/templates/match",
      payload: { input: "test input" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("returns 400 when input is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/templates/match",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("input_required");
  });

  it("returns 400 when input is empty string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/templates/match",
      payload: { input: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when input is not a string", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/templates/match",
      payload: { input: 42 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ranks physical-operator highest for a 3D-printing shop description", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/templates/match",
      payload: { input: "I run a 3D printing shop with FDM machines and a CNC mill" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { matches: Array<{ slug: string; score: number; reason: string }> };
    expect(Array.isArray(body.matches)).toBe(true);
    expect(body.matches.length).toBe(2);
    expect(body.matches[0].slug).toBe("physical-operator");
    expect(body.matches[0].score).toBeGreaterThan(body.matches[1].score);
  });

  it("ranks data-product highest for a Postgres dataset description", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/templates/match",
      payload: { input: "I have a Postgres database with a GraphQL API and SQL endpoint" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { matches: Array<{ slug: string; score: number; reason: string }> };
    expect(body.matches[0].slug).toBe("data-product");
    expect(body.matches[0].score).toBeGreaterThan(0);
  });

  it("returns ALL templates ranked, even when scores are tied at zero", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities/templates/match",
      payload: { input: "qwerty asdfgh zxcvbn" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { matches: Array<{ slug: string; score: number }> };
    expect(body.matches.length).toBe(2);
    // Tie-break order: physical-operator first.
    expect(body.matches[0].slug).toBe("physical-operator");
  });
});

describe("matchTemplates() pure helper", () => {
  it("scores common physical-operator inputs above data-product", () => {
    const ranked = matchTemplates("CNC milling shop");
    expect(ranked[0].slug).toBe("physical-operator");
  });

  it("scores common data-product inputs above physical-operator", () => {
    const ranked = matchTemplates("Snowflake data lake with REST API");
    expect(ranked[0].slug).toBe("data-product");
  });

  it("always returns both templates", () => {
    const ranked = matchTemplates("hello world");
    expect(ranked.length).toBe(2);
    const slugs = ranked.map((m) => m.slug).sort();
    expect(slugs).toEqual(["data-product", "physical-operator"]);
  });

  it("includes a 'reason' string on every match", () => {
    const ranked = matchTemplates("FDM printer");
    for (const m of ranked) {
      expect(typeof m.reason).toBe("string");
      expect(m.reason.length).toBeGreaterThan(0);
    }
  });
});
