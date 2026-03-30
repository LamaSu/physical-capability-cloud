import type { FastifyInstance } from "fastify";
import { getAllTemplates, getRegisteredTypes } from "@pcc/contract-builder";
import { getRepos } from "../db.js";
import { pipelineTelemetry } from "../telemetry.js";

export async function capabilityRoutes(app: FastifyInstance) {
  // List all registered capability types (from contract-builder templates)
  app.get("/api/capabilities/types", async () => {
    pipelineTelemetry.emit("pipeline-" + Date.now(), "discovery", "completed", { metadata: { endpoint: "/api/capabilities/types" } });
    return { types: getRegisteredTypes() };
  });

  // List all capability templates with their details (contract-builder)
  app.get("/api/capabilities/templates", async () => {
    const templates = getAllTemplates();
    return {
      templates: templates.map((t) => ({
        capabilityType: t.capabilityType,
        name: t.name,
        version: t.version,
        description: t.description,
        paramCount: t.params.length,
        groups: [...new Set(t.params.map((p) => p.group))],
        basePrice: t.basePricingHints?.basePrice,
        currency: t.basePricingHints?.currency,
      })),
    };
  });

  // ── DB-backed capability instances (live from kernels) ──────────────

  /** All capability instances across all kernels */
  app.get("/api/capabilities", async () => {
    try {
      const repos = getRepos();
      const capabilities = repos.capabilities.findAll();
      pipelineTelemetry.emit("pipeline-" + Date.now(), "discovery", "completed", { metadata: { endpoint: "/api/capabilities", count: capabilities.length } });
      return { capabilities };
    } catch {
      return { capabilities: [] };
    }
  });

  /** Capabilities for a specific kernel */
  app.get<{ Params: { kernelId: string } }>(
    "/api/capabilities/by-kernel/:kernelId",
    async (req) => {
      try {
        const repos = getRepos();
        const capabilities = repos.capabilities.findByKernel(req.params.kernelId);
        return { capabilities };
      } catch {
        return { capabilities: [] };
      }
    },
  );

  /** Capabilities by type */
  app.get<{ Params: { type: string } }>(
    "/api/capabilities/by-type/:type",
    async (req) => {
      try {
        const repos = getRepos();
        const capabilities = repos.capabilities.findByType(req.params.type);
        return { capabilities };
      } catch {
        return { capabilities: [] };
      }
    },
  );

  /** Search capabilities by name */
  app.get<{ Querystring: { q?: string } }>(
    "/api/capabilities/search",
    async (req) => {
      const query = req.query.q ?? "";
      if (!query) return { capabilities: [] };
      try {
        const repos = getRepos();
        const capabilities = repos.capabilities.search(query);
        return { capabilities };
      } catch {
        return { capabilities: [] };
      }
    },
  );

  /** Single capability by ID */
  app.get<{ Params: { capId: string } }>(
    "/api/capabilities/:capId",
    async (req) => {
      try {
        const repos = getRepos();
        const capability = repos.capabilities.findById(req.params.capId);
        if (!capability) return { error: "not_found" };
        return { capability };
      } catch {
        return { error: "db_unavailable" };
      }
    },
  );
}
