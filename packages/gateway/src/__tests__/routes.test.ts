import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { capabilityRoutes } from "../routes/capabilities.js";
import { kernelRoutes } from "../routes/kernels.js";
import { jobRoutes } from "../routes/jobs.js";
import { escrowRoutes } from "../routes/escrow.js";
import { agentRoutes } from "../routes/agents.js";
import { registryRoutes } from "../routes/registry.js";
import { siweAuthPlugin } from "../auth/siwe-auth.js";
import { initStore, closeStore } from "../db.js";
import cookie from "@fastify/cookie";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Fastify instance with the given route plugins.
 * Uses an in-memory SQLite DB so DB-dependent routes work.
 */
async function buildApp(): Promise<FastifyInstance> {
  // Initialize in-memory DB with seed data for route tests
  process.env.PCC_DB_PATH = ":memory:";
  initStore({ seed: true });

  const app = Fastify({ logger: false });

  // Cookie support (needed by siweAuthPlugin for session cookies)
  await app.register(cookie);

  // Health check (copied from server.ts — no deps)
  app.get("/api/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  }));

  // Register route plugins
  await app.register(capabilityRoutes);
  await app.register(kernelRoutes);
  await app.register(jobRoutes);
  await app.register(escrowRoutes);
  await app.register(agentRoutes);
  await app.register(registryRoutes);
  await app.register(siweAuthPlugin);

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Gateway Routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeStore();
  });

  // ── Health ──────────────────────────────────────────────────────

  describe("GET /api/health", () => {
    it("returns status ok", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.version).toBe("0.1.0");
      expect(body.timestamp).toBeDefined();
    });
  });

  // ── Capabilities ───────────────────────────────────────────────

  describe("GET /api/capabilities/types", () => {
    it("returns array of registered types", async () => {
      const res = await app.inject({ method: "GET", url: "/api/capabilities/types" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.types).toBeDefined();
      expect(Array.isArray(body.types)).toBe(true);
      expect(body.types.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/capabilities/templates", () => {
    it("returns array of templates with metadata", async () => {
      const res = await app.inject({ method: "GET", url: "/api/capabilities/templates" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.templates).toBeDefined();
      expect(Array.isArray(body.templates)).toBe(true);
      expect(body.templates.length).toBeGreaterThan(0);

      // Each template should have key fields
      const first = body.templates[0];
      expect(first.capabilityType).toBeDefined();
      expect(first.name).toBeDefined();
      expect(first.paramCount).toBeGreaterThan(0);
    });
  });

  // ── Kernels ────────────────────────────────────────────────────

  describe("GET /api/kernels", () => {
    it("returns array of kernels", async () => {
      const res = await app.inject({ method: "GET", url: "/api/kernels" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kernels).toBeDefined();
      expect(Array.isArray(body.kernels)).toBe(true);
      expect(body.kernels.length).toBeGreaterThan(0);
    });

    it("each kernel has id, name, status, capabilities", async () => {
      const res = await app.inject({ method: "GET", url: "/api/kernels" });
      const body = res.json();
      const kernel = body.kernels[0];
      expect(kernel.id).toBeDefined();
      expect(kernel.name).toBeDefined();
      expect(kernel.status).toBeDefined();
      expect(Array.isArray(kernel.capabilities)).toBe(true);
    });
  });

  describe("GET /api/kernels/:kernelId", () => {
    it("returns a kernel by id", async () => {
      const res = await app.inject({ method: "GET", url: "/api/kernels/kernel-nyc" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.kernel).toBeDefined();
      expect(body.kernel.id).toBe("kernel-nyc");
    });

    it("reports discoveryStatus=discoverable for a seeded kernel with capabilities", async () => {
      // kernel-nyc is seeded with multiple capabilities — it should be
      // discoverable and have no further actionable nextStep.
      const res = await app.inject({ method: "GET", url: "/api/kernels/kernel-nyc" });
      const body = res.json();
      expect(body.kernel.capabilityCount).toBeGreaterThanOrEqual(1);
      expect(body.kernel.discoveryStatus).toBe("discoverable");
      expect(body.kernel.nextStep).toBeUndefined();
    });

    it("returns error for unknown kernel", async () => {
      const res = await app.inject({ method: "GET", url: "/api/kernels/kernel-nonexistent" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ── Jobs ───────────────────────────────────────────────────────

  describe("GET /api/jobs", () => {
    it("returns array of jobs", async () => {
      const res = await app.inject({ method: "GET", url: "/api/jobs" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.jobs).toBeDefined();
      expect(Array.isArray(body.jobs)).toBe(true);
      expect(body.jobs.length).toBeGreaterThan(0);
    });

    it("each job has id, status, progress", async () => {
      const res = await app.inject({ method: "GET", url: "/api/jobs" });
      const body = res.json();
      const job = body.jobs[0];
      expect(job.id).toBeDefined();
      expect(job.status).toBeDefined();
      expect(typeof job.progress).toBe("number");
    });
  });

  describe("GET /api/jobs/:jobId", () => {
    it("returns a job by id", async () => {
      const res = await app.inject({ method: "GET", url: "/api/jobs/job-001" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.job).toBeDefined();
      expect(body.job.id).toBe("job-001");
    });

    it("returns error for unknown job", async () => {
      const res = await app.inject({ method: "GET", url: "/api/jobs/job-nonexistent" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ── Escrow ─────────────────────────────────────────────────────

  describe("GET /api/escrow", () => {
    it("returns array of escrows", async () => {
      const res = await app.inject({ method: "GET", url: "/api/escrow" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.escrows).toBeDefined();
      expect(Array.isArray(body.escrows)).toBe(true);
      expect(body.escrows.length).toBeGreaterThan(0);
    });

    it("each escrow has id, totalAmount, currency, status", async () => {
      const res = await app.inject({ method: "GET", url: "/api/escrow" });
      const body = res.json();
      const escrow = body.escrows[0];
      expect(escrow.id).toBeDefined();
      expect(escrow.totalAmount).toBeDefined();
      expect(escrow.currency).toBe("USDC");
      expect(escrow.status).toBeDefined();
    });
  });

  describe("GET /api/escrow/:escrowId", () => {
    it("returns mock escrow by id", async () => {
      const res = await app.inject({ method: "GET", url: "/api/escrow/esc-001" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.escrow).toBeDefined();
      expect(body.escrow.id).toBe("esc-001");
      expect(["mock", "db"]).toContain(body.source);
    });

    it("returns 404 for unknown escrow id", async () => {
      const res = await app.inject({ method: "GET", url: "/api/escrow/esc-nonexistent" });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ── Agents (mock conversations plugin) ─────────────────────────

  describe("GET /api/agents/conversations", () => {
    it("returns array of conversations", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents/conversations" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.conversations).toBeDefined();
      expect(Array.isArray(body.conversations)).toBe(true);
      expect(body.conversations.length).toBeGreaterThan(0);
    });

    it("each conversation has id, topic, participants, status", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents/conversations" });
      const body = res.json();
      const conv = body.conversations[0];
      expect(conv.id).toBeDefined();
      expect(conv.topic).toBeDefined();
      expect(Array.isArray(conv.participants)).toBe(true);
      expect(conv.status).toBeDefined();
    });
  });

  describe("GET /api/agents/conversations/:convId", () => {
    it("returns a conversation by id", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents/conversations/conv-001" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.conversation).toBeDefined();
      expect(body.conversation.id).toBe("conv-001");
    });

    it("returns error for unknown conversation", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents/conversations/conv-nonexistent" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.error).toBe("not_found");
    });
  });

  // ── Registry ───────────────────────────────────────────────────

  describe("GET /api/registry/entities", () => {
    it("returns array of entities", async () => {
      const res = await app.inject({ method: "GET", url: "/api/registry/entities" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entities).toBeDefined();
      expect(Array.isArray(body.entities)).toBe(true);
      expect(body.total).toBeGreaterThan(0);
    });

    it("filters by entity type", async () => {
      const res = await app.inject({ method: "GET", url: "/api/registry/entities?type=1" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entities.every((e: any) => e.entityType === 1)).toBe(true);
    });
  });

  describe("GET /api/registry/summary", () => {
    it("returns registry summary with entity counts", async () => {
      const res = await app.inject({ method: "GET", url: "/api/registry/summary" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalEntities).toBeGreaterThan(0);
      expect(body.byType).toBeDefined();
      expect(body.totalAttestations).toBeDefined();
      expect(body.averageReputation).toBeGreaterThan(0);
    });
  });

  // ── Auth ───────────────────────────────────────────────────────

  describe("GET /api/auth/nonce", () => {
    it("returns a hex nonce", async () => {
      const res = await app.inject({ method: "GET", url: "/api/auth/nonce" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.nonce).toBeDefined();
      expect(typeof body.nonce).toBe("string");
      expect(body.nonce.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns 401 when no auth header is provided", async () => {
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error).toBeDefined();
    });

    it("returns 401 for an invalid session token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { authorization: "Bearer invalid-token" },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("returns ok even without a session", async () => {
      const res = await app.inject({ method: "POST", url: "/api/auth/logout" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ok).toBe(true);
    });
  });

  describe("GET /api/auth/sessions", () => {
    it("returns session count", async () => {
      const res = await app.inject({ method: "GET", url: "/api/auth/sessions" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.count).toBe("number");
      expect(Array.isArray(body.sessions)).toBe(true);
    });
  });
});
