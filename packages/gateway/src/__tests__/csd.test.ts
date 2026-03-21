import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { csdRoutes, resetCsdRegistry } from "../routes/csd.js";

// ---------------------------------------------------------------------------
// Test app builder
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(csdRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CSD Registry API", () => {
  let app: FastifyInstance;

  beforeEach(() => {
    // Each test gets a fresh registry with only the built-in CSDs
    resetCsdRegistry();
  });

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    resetCsdRegistry();
  });

  // ── GET /api/csd ────────────────────────────────────────────────

  describe("GET /api/csd", () => {
    it("lists all 5 built-in CSDs", async () => {
      const res = await app.inject({ method: "GET", url: "/api/csd" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Array.isArray(body.csds)).toBe(true);
      expect(body.csds.length).toBe(5);
    });

    it("each CSD has url, name, version, status, kind", async () => {
      const res = await app.inject({ method: "GET", url: "/api/csd" });
      const body = res.json();
      for (const csd of body.csds) {
        expect(csd.url).toBeDefined();
        expect(csd.name).toBeDefined();
        expect(csd.version).toBeDefined();
        expect(csd.status).toBeDefined();
        expect(csd.kind).toBeDefined();
      }
    });

    it("filters by kind=base", async () => {
      const res = await app.inject({ method: "GET", url: "/api/csd?kind=base" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.csds.every((c: { kind: string }) => c.kind === "base")).toBe(true);
      expect(body.csds.length).toBeGreaterThan(0);
    });

    it("filters by status=active", async () => {
      const res = await app.inject({ method: "GET", url: "/api/csd?status=active" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.csds.every((c: { status: string }) => c.status === "active")).toBe(true);
    });

    it("returns empty array when filter matches nothing", async () => {
      const res = await app.inject({ method: "GET", url: "/api/csd?status=retired" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.csds).toHaveLength(0);
    });
  });

  // ── GET /api/csd/:url ───────────────────────────────────────────

  describe("GET /api/csd/:url", () => {
    it("returns the FDM CSD by URI", async () => {
      const encoded = encodeURIComponent("pcc://capabilities/fdm/v2");
      const res = await app.inject({ method: "GET", url: `/api/csd/${encoded}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.csd.url).toBe("pcc://capabilities/fdm/v2");
      expect(body.csd.name).toBe("FDM 3D Printing");
    });

    it("returns the 2d-print CSD", async () => {
      const encoded = encodeURIComponent("pcc://capabilities/2d-print/v1");
      const res = await app.inject({ method: "GET", url: `/api/csd/${encoded}` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.csd.url).toBe("pcc://capabilities/2d-print/v1");
    });

    it("returns 404 for unknown URL", async () => {
      const encoded = encodeURIComponent("pcc://capabilities/does-not-exist/v1");
      const res = await app.inject({ method: "GET", url: `/api/csd/${encoded}` });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ── POST /api/csd ───────────────────────────────────────────────

  describe("POST /api/csd", () => {
    it("registers a new valid CSD", async () => {
      const newCsd = {
        url: "pcc://capabilities/test-cap/v1",
        version: "1.0.0",
        status: "active",
        name: "Test Capability",
        description: "A test capability for unit tests",
        kind: "base",
        baseDefinition: null,
        parameters: [],
        constraints: [],
        pricing: { basePrice: "1.00", currency: "USDC" },
      };

      const res = await app.inject({
        method: "POST",
        url: "/api/csd",
        payload: newCsd,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.registered).toBe(true);
      expect(body.url).toBe("pcc://capabilities/test-cap/v1");
    });

    it("returns 400 for an invalid CSD (missing required fields)", async () => {
      const bad = { url: "pcc://test", name: "bad" };
      const res = await app.inject({
        method: "POST",
        url: "/api/csd",
        payload: bad,
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors.length).toBeGreaterThan(0);
    });

    it("the registered CSD appears in GET /api/csd", async () => {
      const newCsd = {
        url: "pcc://capabilities/test-cap-2/v1",
        version: "1.0.0",
        status: "active",
        name: "Test Capability 2",
        description: "Another test capability",
        kind: "base",
        baseDefinition: null,
        parameters: [],
        constraints: [],
        pricing: { basePrice: "2.00", currency: "USDC" },
      };

      await app.inject({ method: "POST", url: "/api/csd", payload: newCsd });

      const listRes = await app.inject({ method: "GET", url: "/api/csd" });
      const body = listRes.json();
      const found = body.csds.find(
        (c: { url: string }) => c.url === "pcc://capabilities/test-cap-2/v1",
      );
      expect(found).toBeDefined();
    });
  });

  // ── POST /api/csd/validate ──────────────────────────────────────

  describe("POST /api/csd/validate", () => {
    it("returns valid:true for a valid CSD", async () => {
      const validCsd = {
        url: "pcc://capabilities/valid-test/v1",
        version: "1.0.0",
        status: "active",
        name: "Valid Test",
        description: "Valid test CSD",
        kind: "base",
        baseDefinition: null,
        parameters: [],
        constraints: [],
        pricing: { basePrice: "5.00", currency: "USDC" },
      };

      const res = await app.inject({
        method: "POST",
        url: "/api/csd/validate",
        payload: validCsd,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(body.errors).toHaveLength(0);
    });

    it("returns valid:false with errors for an invalid CSD", async () => {
      const invalid = { url: "pcc://test", description: "no kind or version" };
      const res = await app.inject({
        method: "POST",
        url: "/api/csd/validate",
        payload: invalid,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors.length).toBeGreaterThan(0);
    });

    it("catches invalid version format", async () => {
      const badVersion = {
        url: "pcc://capabilities/test/v1",
        version: "not-semver",
        status: "active",
        name: "Test",
        description: "Test",
        kind: "base",
        baseDefinition: null,
        parameters: [],
        constraints: [],
        pricing: { basePrice: "1.00", currency: "USDC" },
      };
      const res = await app.inject({
        method: "POST",
        url: "/api/csd/validate",
        payload: badVersion,
      });
      const body = res.json();
      expect(body.valid).toBe(false);
      expect(body.errors.some((e: string) => e.includes("semver") || e.includes("version"))).toBe(true);
    });
  });

  // ── POST /api/csd/resolve ───────────────────────────────────────

  describe("POST /api/csd/resolve", () => {
    it("resolves a base CSD (returns as-is)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/csd/resolve",
        payload: { url: "pcc://capabilities/fdm/v2" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.csd.url).toBe("pcc://capabilities/fdm/v2");
      expect(Array.isArray(body.csd.parameters)).toBe(true);
      expect(body.csd.parameters.length).toBeGreaterThan(0);
    });

    it("resolves a profile CSD by applying inheritance", async () => {
      // Register a profile that inherits from fdm
      const profile = {
        url: "pcc://capabilities/fdm-high-detail/v1",
        version: "1.0.0",
        status: "active",
        name: "FDM High Detail Profile",
        description: "FDM with fine layer heights only",
        kind: "profile",
        baseDefinition: "pcc://capabilities/fdm/v2",
        parameters: [],
        constraints: [],
        pricing: { basePrice: "25.00", currency: "USDC" },
      };
      await app.inject({ method: "POST", url: "/api/csd", payload: profile });

      const res = await app.inject({
        method: "POST",
        url: "/api/csd/resolve",
        payload: { url: "pcc://capabilities/fdm-high-detail/v1" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Resolved CSD should inherit parameters from the FDM base
      expect(body.csd.parameters.length).toBeGreaterThan(0);
      expect(body.csd.url).toBe("pcc://capabilities/fdm-high-detail/v1");
    });

    it("returns 400 when url is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/csd/resolve",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 404 for unknown CSD url", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/csd/resolve",
        payload: { url: "pcc://capabilities/nonexistent/v1" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── DELETE /api/csd/:url ────────────────────────────────────────

  describe("DELETE /api/csd/:url", () => {
    it("retires a CSD", async () => {
      // First register a CSD
      const csd = {
        url: "pcc://capabilities/to-retire/v1",
        version: "1.0.0",
        status: "active",
        name: "To Retire",
        description: "CSD that will be retired",
        kind: "base",
        baseDefinition: null,
        parameters: [],
        constraints: [],
        pricing: { basePrice: "1.00", currency: "USDC" },
      };
      await app.inject({ method: "POST", url: "/api/csd", payload: csd });

      // Now retire it
      const encoded = encodeURIComponent("pcc://capabilities/to-retire/v1");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/csd/${encoded}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.retired).toBe(true);
    });

    it("returns retired status after deletion", async () => {
      // Register another CSD
      const csd = {
        url: "pcc://capabilities/to-retire-2/v1",
        version: "1.0.0",
        status: "active",
        name: "To Retire 2",
        description: "Another CSD that will be retired",
        kind: "base",
        baseDefinition: null,
        parameters: [],
        constraints: [],
        pricing: { basePrice: "1.00", currency: "USDC" },
      };
      await app.inject({ method: "POST", url: "/api/csd", payload: csd });

      const encoded = encodeURIComponent("pcc://capabilities/to-retire-2/v1");
      await app.inject({ method: "DELETE", url: `/api/csd/${encoded}` });

      // Verify status is now retired
      const getRes = await app.inject({ method: "GET", url: `/api/csd/${encoded}` });
      const getBody = getRes.json();
      expect(getBody.csd.status).toBe("retired");
    });

    it("returns 404 for unknown URL", async () => {
      const encoded = encodeURIComponent("pcc://capabilities/ghost/v1");
      const res = await app.inject({
        method: "DELETE",
        url: `/api/csd/${encoded}`,
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
