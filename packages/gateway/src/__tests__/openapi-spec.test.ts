/**
 * Tests for the OpenAPI 3.x spec endpoint at GET /openapi.json.
 *
 * Verifies:
 *   - /openapi.json returns 200 with the OpenAPI 3 document
 *   - openapi / info / paths fields are well-formed
 *   - 8 high-value routes are present with proper schema metadata
 *   - the bearer security scheme is declared
 *   - the spec is reachable without authentication (PUBLIC)
 *   - every operation in the document has a unique, non-empty operationId
 *     (see ../openapi/operation-id.ts — required for GPT Actions import and
 *     other OpenAPI-driven tooling)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { capabilityRoutes } from "../routes/capabilities.js";
import { buildRoutes } from "../routes/build.js";
import { jobSubmitRoutes } from "../routes/job-submit.js";
import { wellKnownRoutes } from "../routes/well-known.js";
import { kernelRoutes } from "../routes/kernels.js";
import { jobRoutes } from "../routes/jobs.js";
import { initStore, closeStore } from "../db.js";
import { createOperationIdTransform } from "../openapi/operation-id.js";

// ---------------------------------------------------------------------------
// Test app — registers swagger plugins + 6 route plugins whose schemas we
// want to validate. NO auth middleware: this test exercises the spec
// generation, not the API gate. The api-gate test covers PUBLIC routing.
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });

  await app.register(fastifySwagger, {
    // Mirrors server.ts's registration — every operation gets a stable,
    // unique operationId even though none of these route files declare one
    // explicitly. See ../openapi/operation-id.ts.
    transform: createOperationIdTransform(),
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
  // Pulled in for operationId-coverage tests below: both route files
  // declare :param routes (e.g. "/api/kernels/:kernelId",
  // "/api/kernels/:kernelId/devices", "/api/jobs/:jobId") so the spec this
  // test app produces exercises path-param normalization + collision
  // handling on real, production route definitions — not synthetic ones.
  await app.register(kernelRoutes);
  await app.register(jobRoutes);

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

// ---------------------------------------------------------------------------
// operationId coverage — every operation must have a unique, non-empty id.
//
// Reuses the same buildApp() (and therefore the same production
// createOperationIdTransform() wiring as server.ts) but registers a wider
// set of route plugins, including two with real :param routes
// (kernelRoutes, jobRoutes), so this exercises path-param normalization and
// collision handling against actual production route definitions rather
// than synthetic ones.
// ---------------------------------------------------------------------------

describe("operationId coverage", () => {
  let app: FastifyInstance;
  let spec: any;
  /** Flat list of every {path, method, operationId} triple in the spec. */
  let operations: Array<{ path: string; method: string; operationId: unknown }>;

  const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

  beforeAll(async () => {
    app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    spec = res.json();

    operations = [];
    for (const [path, pathItem] of Object.entries<any>(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        if (pathItem[method]) {
          operations.push({ path, method, operationId: pathItem[method].operationId });
        }
      }
    }
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  it("found more than one operation to check (sanity — a 0-op run would pass trivially)", () => {
    expect(operations.length).toBeGreaterThan(10);
  });

  it("every operation has a non-empty string operationId", () => {
    const missing = operations.filter(
      (op) => typeof op.operationId !== "string" || op.operationId.trim().length === 0,
    );
    expect(missing, `operations missing operationId: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it("every operationId is unique across the whole spec", () => {
    const ids = operations.map((op) => op.operationId as string);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect([...new Set(duplicates)], `duplicate operationIds: ${duplicates.join(", ")}`).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("derives the documented deterministic naming convention for a plain route", () => {
    expect(spec.paths["/api/capabilities/types"]?.get?.operationId).toBe("get_api_capabilities_types");
  });

  it("derives the documented :param -> by_<param> convention for a real route", () => {
    // kernelRoutes registers GET /api/kernels/:kernelId.
    const op = spec.paths["/api/kernels/{kernelId}"]?.get;
    expect(op).toBeDefined();
    expect(op.operationId).toBe("get_api_kernels_by_kernelid");
  });
});
