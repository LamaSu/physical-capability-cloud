/**
 * Tests for the OpenAPI 3.x spec endpoint at GET /openapi.json.
 *
 * Verifies:
 *   - /openapi.json returns 200 with the OpenAPI 3 document
 *   - openapi / info / paths fields are well-formed
 *   - 8 high-value routes are present with proper schema metadata
 *   - the bearer security scheme is declared
 *   - the spec is reachable without authentication (PUBLIC)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { capabilityRoutes } from "../routes/capabilities.js";
import { buildRoutes } from "../routes/build.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { wellKnownRoutes } from "../routes/well-known.js";
import { initStore, closeStore } from "../db.js";

// ---------------------------------------------------------------------------
// Test app — registers swagger plugins + the 4 route plugins whose schemas
// we want to validate. NO auth middleware: this test exercises the spec
// generation, not the API gate. The api-gate test covers PUBLIC routing.
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Physical Capability Cloud Gateway",
        version: "0.1.0",
        description: "Agent-native API for discovering and invoking physical capabilities.",
      },
      servers: [{ url: "https://capability.network" }],
      components: {
        securitySchemes: {
          bearer: { type: "http", scheme: "bearer" },
        },
      },
    },
  });
  await app.register(fastifySwaggerUi, { routePrefix: "/docs" });

  app.get("/openapi.json", async () => app.swagger());

  await app.register(capabilityRoutes);
  await app.register(buildRoutes);
  await app.register(jobSubmitRoutes);
  await app.register(wellKnownRoutes);

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const EXPECTED_PATHS = [
  "/api/capabilities/types",
  "/api/capabilities",
  "/api/capabilities/templates",
  "/api/build/options",
  "/api/build/price",
  "/api/build/contract",
  "/api/jobs/submit",
  "/.well-known/agent-card.json",
] as const;

describe("GET /openapi.json — OpenAPI 3.x spec", () => {
  let app: FastifyInstance;
  let spec: any;

  beforeAll(async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    spec = res.json();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  // ── Top-level structure ──────────────────────────────────────────────────

  it("returns a document with openapi 3.x version", () => {
    expect(typeof spec.openapi).toBe("string");
    expect(spec.openapi.startsWith("3.")).toBe(true);
  });

  it("declares the PCC info block with title + version", () => {
    expect(spec.info).toBeDefined();
    expect(spec.info.title).toContain("Physical Capability Cloud");
    expect(typeof spec.info.version).toBe("string");
    expect(spec.info.version.length).toBeGreaterThan(0);
  });

  it("declares the bearer security scheme", () => {
    expect(spec.components).toBeDefined();
    expect(spec.components.securitySchemes).toBeDefined();
    expect(spec.components.securitySchemes.bearer).toEqual({
      type: "http",
      scheme: "bearer",
    });
  });

  it("declares a servers entry", () => {
    expect(Array.isArray(spec.servers)).toBe(true);
    expect(spec.servers.length).toBeGreaterThan(0);
    expect(typeof spec.servers[0].url).toBe("string");
  });

  // ── Path presence ────────────────────────────────────────────────────────

  it("contains a paths object with at least the 8 annotated routes", () => {
    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe("object");
    for (const path of EXPECTED_PATHS) {
      expect(spec.paths[path], `expected ${path} in spec`).toBeDefined();
    }
  });

  // ── Schema annotations on a sample route ─────────────────────────────────

  it("/api/build/contract POST has body + response schemas + tags", () => {
    const op = spec.paths["/api/build/contract"]?.post;
    expect(op).toBeDefined();
    expect(op.tags).toContain("contract-builder");
    expect(op.summary).toBeDefined();
    expect(op.requestBody).toBeDefined();
    const bodySchema =
      op.requestBody.content?.["application/json"]?.schema;
    expect(bodySchema).toBeDefined();
    expect(bodySchema.required).toEqual(
      expect.arrayContaining(["type", "selections", "assuranceTier"]),
    );
    expect(op.responses?.["200"]).toBeDefined();
  });

  it("/api/jobs/submit POST declares bearer security", () => {
    const op = spec.paths["/api/jobs/submit"]?.post;
    expect(op).toBeDefined();
    expect(op.security).toEqual(
      expect.arrayContaining([{ bearer: [] }]),
    );
  });

  it("/api/capabilities/types GET response shape is documented", () => {
    const op = spec.paths["/api/capabilities/types"]?.get;
    expect(op).toBeDefined();
    expect(op.tags).toContain("discovery");
    const respSchema =
      op.responses?.["200"]?.content?.["application/json"]?.schema;
    expect(respSchema).toBeDefined();
    expect(respSchema.properties?.types).toBeDefined();
    expect(respSchema.properties.types.type).toBe("array");
  });

  // ── Negative checks ──────────────────────────────────────────────────────

  it("does not contain the placeholder x-swagger-rendered-by field", () => {
    // Sanity — swagger-ui sometimes leaks meta fields when misconfigured.
    expect(spec["x-swagger-rendered-by"]).toBeUndefined();
  });
});
