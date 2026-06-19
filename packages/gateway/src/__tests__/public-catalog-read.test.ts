/**
 * implementer-charlie-public-catalog: public catalog reads
 *
 * Verifies that the catalog/discovery surface is browsable without a Bearer
 * token. Prospective operators must be able to see what categories PCC has
 * BEFORE signing up — otherwise the marketplace dies on first-touch friction.
 *
 * Public (GET only, no auth):
 *   GET /api/capabilities
 *   GET /api/capabilities/templates
 *   GET /api/capabilities/search
 *   GET /api/capabilities/by-kernel/:kernelId
 *   GET /api/capabilities/by-type/:type
 *
 * Auth-gated (writes stay protected):
 *   POST /api/capabilities  → must 401 without Bearer
 *
 * No sensitive fields (apiKey / secret / password / privateKey) appear in
 * any response shape. The DTO audit lives in the commit message.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { apiGate } from "../middleware/api-gate.js";
import { capabilityRoutes } from "../routes/capabilities.js";
import { initStore, closeStore } from "../db.js";

vi.mock("../services/audit-service.js", () => ({
  auditService: {
    log: vi.fn(),
    query: vi.fn().mockReturnValue([]),
    stats: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../telemetry.js", () => ({
  pipelineTelemetry: { emit: vi.fn() },
}));

const SENSITIVE_KEYS = [
  "apiKey",
  "api_key",
  "secret",
  "password",
  "privateKey",
  "private_key",
  "signingKey",
  "signing_key",
  "token",
];

/** Recursively scan an object for any forbidden field name. */
function hasSensitiveField(value: unknown, path = ""): string | null {
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = hasSensitiveField(value[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.includes(k)) return `${path}.${k}`;
    const hit = hasSensitiveField(v, `${path}.${k}`);
    if (hit) return hit;
  }
  return null;
}

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });
  const app = Fastify({ logger: false });
  await app.register(apiGate);
  await app.register(capabilityRoutes);
  await app.ready();
  return app;
}

describe("public catalog reads — GET /api/capabilities (unauth)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("returns 200 without Bearer header", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    expect(res.statusCode).toBe(200);
  });

  it("returns a paginated CapabilityDTO list shape", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    const body = res.json() as {
      items: Array<{ id: string; type: string }>;
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.total).toBe("number");
    expect(typeof body.offset).toBe("number");
    expect(typeof body.limit).toBe("number");
    expect(typeof body.hasMore).toBe("boolean");
  });

  it("does NOT leak apiKey / secret / password / privateKey / token fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/capabilities" });
    const body = res.json();
    const hit = hasSensitiveField(body, "$");
    expect(hit).toBeNull();
  });

  it("?limit=10 is honored", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities?limit=10&offset=0",
    });
    const body = res.json() as { limit: number; items: unknown[] };
    expect(body.limit).toBe(10);
    expect(body.items.length).toBeLessThanOrEqual(10);
  });

  it("?limit=500 is rejected by Fastify schema (max=200)", async () => {
    // Existing schema in routes/capabilities.ts caps limit at 200 — the route
    // guard documented in the brief. Pinning the cap here so a future relax
    // is intentional, not accidental.
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities?limit=500",
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("public catalog reads — filtered + search (unauth)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("GET /api/capabilities/templates returns 200 unauth + 'templates' array", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/templates",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { templates: unknown[] };
    expect(Array.isArray(body.templates)).toBe(true);
  });

  it("GET /api/capabilities/types returns 200 unauth + 'types' array", async () => {
    // Already public pre-change; this asserts the existing behavior survives
    // the gate refactor.
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/types",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { types: string[] };
    expect(Array.isArray(body.types)).toBe(true);
  });

  it("GET /api/capabilities/search returns 200 unauth (empty q → empty list)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/search",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { capabilities: unknown[] };
    expect(Array.isArray(body.capabilities)).toBe(true);
  });

  it("GET /api/capabilities/search?q=foo returns 200 unauth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/search?q=foo",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /api/capabilities/by-type/:type returns 200 unauth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/by-type/3d-printing",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { capabilities: unknown[] };
    expect(Array.isArray(body.capabilities)).toBe(true);
  });

  it("GET /api/capabilities/by-kernel/:kernelId returns 200 unauth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/capabilities/by-kernel/kernel-test-001",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { capabilities: unknown[] };
    expect(Array.isArray(body.capabilities)).toBe(true);
  });

  it("filtered responses do NOT leak sensitive fields", async () => {
    const urls = [
      "/api/capabilities/by-type/3d-printing",
      "/api/capabilities/by-kernel/kernel-test-001",
      "/api/capabilities/search?q=printer",
      "/api/capabilities/templates",
    ];
    for (const url of urls) {
      const res = await app.inject({ method: "GET", url });
      const body = res.json();
      const hit = hasSensitiveField(body, `$@${url}`);
      expect(hit, `${url} leaked field: ${hit}`).toBeNull();
    }
  });
});

describe("public catalog reads — writes stay auth-gated", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    closeStore();
  });

  it("POST /api/capabilities returns 401 without Bearer", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/capabilities",
      payload: { kernelId: "kernel-x", type: "3d-printing" },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: string };
    expect(body.error).toBe("api_key_required");
  });

  it("PATCH /api/capabilities returns 401 without Bearer (defense in depth)", async () => {
    // No PATCH route exists today, but if one is ever added under this exact
    // path it MUST inherit the gate, not the GET-only exception.
    const res = await app.inject({
      method: "PATCH",
      url: "/api/capabilities",
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it("DELETE /api/capabilities returns 401 without Bearer (defense in depth)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/capabilities",
    });
    expect(res.statusCode).toBe(401);
  });
});
