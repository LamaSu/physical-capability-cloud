// packages/gateway/src/routes/templates.ts
//
// CRUD routes for all template types: capability templates, machine profiles,
// verification templates, and query templates.
//
// Pattern 1: Capability Templates → DB-stored, API-managed, community-contributable
// Pattern 5: Machine Profiles → DB-stored instead of hardcoded TypeScript
//
// Routes:
//   GET    /api/templates/capabilities                — list capability templates
//   GET    /api/templates/capabilities/:id            — get by ID
//   POST   /api/templates/capabilities                — create new
//   PUT    /api/templates/capabilities/:id            — update
//   POST   /api/templates/capabilities/:id/publish    — publish (draft → active)
//   POST   /api/templates/capabilities/:id/fork       — fork a template
//   POST   /api/templates/capabilities/:id/rate       — rate a template (1-5)
//
//   GET    /api/templates/machines                    — list machine profiles
//   GET    /api/templates/machines/:id                — get by ID
//   POST   /api/templates/machines                    — create new
//   PUT    /api/templates/machines/:id                — update
//
//   GET    /api/templates/verification                — list verification templates
//   GET    /api/templates/verification/:id            — get by ID
//   POST   /api/templates/verification                — create new
//
//   GET    /api/templates/queries                     — list query templates
//   GET    /api/templates/queries/:id                 — get by ID
//
//   GET    /api/templates/search?q=&type=&capability= — cross-type search
//   GET    /api/templates/suggest?machineModel=&capabilityType=&industry=
//                                                     — onboarding suggestions

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { getRepos } from "../db.js";
import { TemplateSuggestionService } from "../services/template-suggestion-service.js";

const suggestionService = new TemplateSuggestionService();

export async function templateRoutes(app: FastifyInstance) {
  // ── Capability Templates ────────────────────────────────────────────────────

  // GET /api/templates/capabilities — list all capability templates
  app.get("/api/templates/capabilities", async (_req, _reply) => {
    const repos = getRepos();
    return repos.templateStore.findAllCapabilityTemplates();
  });

  // GET /api/templates/capabilities/:id — get by ID
  app.get<{ Params: { id: string } }>(
    "/api/templates/capabilities/:id",
    async (req, reply) => {
      const repos = getRepos();
      const template = repos.templateStore.findCapabilityTemplateById(req.params.id);
      if (!template) return reply.status(404).send({ error: "not_found" });
      return template;
    },
  );

  // POST /api/templates/capabilities — create new
  app.post<{ Body: Record<string, unknown> }>(
    "/api/templates/capabilities",
    async (req, reply) => {
      const repos = getRepos();
      const operatorId = (req as any).operatorId ?? (req as any).userId;

      const body = req.body ?? {};
      const capabilityType = body.capabilityType as string | undefined;
      const name = body.name as string | undefined;
      const version = (body.version as string | undefined) ?? "1.0.0";

      if (!capabilityType || !name) {
        return reply.status(400).send({ error: "capabilityType and name are required" });
      }

      const now = new Date().toISOString();
      const template = repos.templateStore.insertCapabilityTemplate({
        id: randomUUID(),
        capabilityType,
        name,
        version,
        description: body.description as string | undefined,
        templateData: (body.templateData as Record<string, unknown>) ?? {},
        authorId: operatorId ?? null,
        status: "draft",
        tags: (body.tags as string[]) ?? null,
        usageCount: 0,
        forkCount: 0,
        rating: null,
        ratingCount: 0,
        forkedFrom: null,
        isVerified: false,
        createdAt: now,
        updatedAt: null,
      });

      return reply.status(201).send(template);
    },
  );

  // PUT /api/templates/capabilities/:id — update
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/templates/capabilities/:id",
    async (req, reply) => {
      const repos = getRepos();
      const existing = repos.templateStore.findCapabilityTemplateById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "not_found" });

      const body = req.body ?? {};
      const updated = repos.templateStore.updateCapabilityTemplate(req.params.id, {
        ...(body.name !== undefined && { name: body.name as string }),
        ...(body.description !== undefined && { description: body.description as string }),
        ...(body.version !== undefined && { version: body.version as string }),
        ...(body.templateData !== undefined && { templateData: body.templateData as Record<string, unknown> }),
        ...(body.tags !== undefined && { tags: body.tags as string[] }),
        updatedAt: new Date().toISOString(),
      });

      return updated;
    },
  );

  // POST /api/templates/capabilities/:id/publish — publish (draft → active)
  app.post<{ Params: { id: string } }>(
    "/api/templates/capabilities/:id/publish",
    async (req, reply) => {
      const repos = getRepos();
      const existing = repos.templateStore.findCapabilityTemplateById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "not_found" });

      const operatorId = (req as any).operatorId ?? (req as any).userId;
      if (existing.authorId && existing.authorId !== operatorId) {
        return reply.status(403).send({ error: "forbidden", message: "Only the author can publish this template" });
      }

      const updated = repos.templateStore.updateCapabilityTemplate(req.params.id, {
        status: "active",
        updatedAt: new Date().toISOString(),
      });

      return updated;
    },
  );

  // POST /api/templates/capabilities/:id/fork — fork a template
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/templates/capabilities/:id/fork",
    async (req, reply) => {
      const repos = getRepos();
      const source = repos.templateStore.findCapabilityTemplateById(req.params.id);
      if (!source) return reply.status(404).send({ error: "not_found" });

      const operatorId = (req as any).operatorId ?? (req as any).userId;
      const body = req.body ?? {};
      const now = new Date().toISOString();

      // Create the fork
      const forked = repos.templateStore.insertCapabilityTemplate({
        id: randomUUID(),
        capabilityType: source.capabilityType,
        name: (body.name as string | undefined) ?? `${source.name} (fork)`,
        version: "1.0.0",
        description: source.description ?? undefined,
        templateData: source.templateData as Record<string, unknown>,
        authorId: operatorId ?? null,
        status: "draft",
        tags: source.tags ?? null,
        usageCount: 0,
        forkCount: 0,
        rating: null,
        ratingCount: 0,
        forkedFrom: source.id,
        isVerified: false,
        createdAt: now,
        updatedAt: null,
      });

      // Increment fork count on source
      repos.templateStore.updateCapabilityTemplate(source.id, {
        forkCount: (source.forkCount ?? 0) + 1,
        updatedAt: now,
      });

      return reply.status(201).send(forked);
    },
  );

  // POST /api/templates/capabilities/:id/rate — rate a template (1-5)
  app.post<{ Params: { id: string }; Body: { score: number; comment?: string } }>(
    "/api/templates/capabilities/:id/rate",
    async (req, reply) => {
      const repos = getRepos();
      const existing = repos.templateStore.findCapabilityTemplateById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "not_found" });

      const operatorId = (req as any).operatorId ?? (req as any).userId ?? "anonymous";
      const score = req.body?.score;
      if (!score || score < 1 || score > 5) {
        return reply.status(400).send({ error: "score must be between 1 and 5" });
      }

      // Insert rating record
      repos.templateStore.insertRating({
        id: randomUUID(),
        templateId: req.params.id,
        templateType: "capability",
        raterId: operatorId,
        score,
        comment: req.body?.comment ?? null,
        createdAt: new Date().toISOString(),
      });

      // Recompute average rating
      const allRatings = repos.templateStore.findRatingsByTemplate(req.params.id, "capability");
      const avg = allRatings.reduce((sum, r) => sum + r.score, 0) / allRatings.length;

      const updated = repos.templateStore.updateCapabilityTemplate(req.params.id, {
        rating: avg,
        ratingCount: allRatings.length,
        updatedAt: new Date().toISOString(),
      });

      return updated;
    },
  );

  // ── Machine Profiles ────────────────────────────────────────────────────────

  // GET /api/templates/machines — list all machine profiles
  app.get("/api/templates/machines", async (_req, _reply) => {
    const repos = getRepos();
    return repos.templateStore.findAllMachineProfiles();
  });

  // GET /api/templates/machines/:id — get by ID
  app.get<{ Params: { id: string } }>(
    "/api/templates/machines/:id",
    async (req, reply) => {
      const repos = getRepos();
      const profile = repos.templateStore.findMachineProfileById(req.params.id);
      if (!profile) return reply.status(404).send({ error: "not_found" });
      return profile;
    },
  );

  // POST /api/templates/machines — create new
  app.post<{ Body: Record<string, unknown> }>(
    "/api/templates/machines",
    async (req, reply) => {
      const repos = getRepos();
      const operatorId = (req as any).operatorId ?? (req as any).userId;

      const body = req.body ?? {};
      const capabilityType = body.capabilityType as string | undefined;
      const machineName = body.machineName as string | undefined;

      if (!capabilityType || !machineName) {
        return reply.status(400).send({ error: "capabilityType and machineName are required" });
      }

      const now = new Date().toISOString();
      const profile = repos.templateStore.insertMachineProfile({
        id: randomUUID(),
        capabilityType,
        machineName,
        kernelId: (body.kernelId as string | undefined) ?? null,
        profileData: (body.profileData as Record<string, unknown>) ?? {},
        authorId: operatorId ?? null,
        status: "draft",
        tags: (body.tags as string[]) ?? null,
        usageCount: 0,
        rating: null,
        ratingCount: 0,
        isVerified: false,
        createdAt: now,
        updatedAt: null,
      });

      return reply.status(201).send(profile);
    },
  );

  // PUT /api/templates/machines/:id — update
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/templates/machines/:id",
    async (req, reply) => {
      const repos = getRepos();
      const existing = repos.templateStore.findMachineProfileById(req.params.id);
      if (!existing) return reply.status(404).send({ error: "not_found" });

      const body = req.body ?? {};
      const updated = repos.templateStore.updateMachineProfile(req.params.id, {
        ...(body.machineName !== undefined && { machineName: body.machineName as string }),
        ...(body.profileData !== undefined && { profileData: body.profileData as Record<string, unknown> }),
        ...(body.tags !== undefined && { tags: body.tags as string[] }),
        ...(body.status !== undefined && { status: body.status as string }),
        updatedAt: new Date().toISOString(),
      });

      return updated;
    },
  );

  // ── Verification Templates ──────────────────────────────────────────────────

  // GET /api/templates/verification — list all
  app.get("/api/templates/verification", async (_req, _reply) => {
    const repos = getRepos();
    return repos.templateStore.findAllVerificationTemplates();
  });

  // GET /api/templates/verification/:id — get by ID
  app.get<{ Params: { id: string } }>(
    "/api/templates/verification/:id",
    async (req, reply) => {
      const repos = getRepos();
      const template = repos.templateStore.findVerificationTemplateById(req.params.id);
      if (!template) return reply.status(404).send({ error: "not_found" });
      return template;
    },
  );

  // POST /api/templates/verification — create new
  app.post<{ Body: Record<string, unknown> }>(
    "/api/templates/verification",
    async (req, reply) => {
      const repos = getRepos();
      const operatorId = (req as any).operatorId ?? (req as any).userId;

      const body = req.body ?? {};
      const capabilityType = body.capabilityType as string | undefined;
      const name = body.name as string | undefined;
      const version = (body.version as string | undefined) ?? "1.0.0";

      if (!capabilityType || !name) {
        return reply.status(400).send({ error: "capabilityType and name are required" });
      }

      const now = new Date().toISOString();
      const template = repos.templateStore.insertVerificationTemplate({
        id: randomUUID(),
        capabilityType,
        name,
        version,
        description: body.description as string | undefined,
        requirements: (body.requirements as Record<string, unknown>) ?? {},
        authorId: operatorId ?? null,
        status: "draft",
        usageCount: 0,
        createdAt: now,
        updatedAt: null,
      });

      return reply.status(201).send(template);
    },
  );

  // ── Query Templates ─────────────────────────────────────────────────────────

  // GET /api/templates/queries — list all
  app.get("/api/templates/queries", async (_req, _reply) => {
    const repos = getRepos();
    return repos.templateStore.findAllQueryTemplates();
  });

  // GET /api/templates/queries/:id — get by ID
  app.get<{ Params: { id: string } }>(
    "/api/templates/queries/:id",
    async (req, reply) => {
      const repos = getRepos();
      const template = repos.templateStore.findQueryTemplateById(req.params.id);
      if (!template) return reply.status(404).send({ error: "not_found" });
      return template;
    },
  );

  // ── Search & Suggest ────────────────────────────────────────────────────────

  // GET /api/templates/search?q=<text>&type=<type>&capability=<type>
  // Search across all template types
  app.get<{ Querystring: { q?: string; type?: string; capability?: string } }>(
    "/api/templates/search",
    async (req, _reply) => {
      const repos = getRepos();
      const { q = "", type, capability } = req.query;

      const results: {
        type: string;
        id: string;
        name: string;
        capabilityType?: string;
        status: string;
      }[] = [];

      // Search capability templates
      if (!type || type === "capability") {
        const matches = capability
          ? repos.templateStore.findCapabilityTemplatesByType(capability)
          : repos.templateStore.searchCapabilityTemplates(q);
        for (const t of matches) {
          if (!q || t.name.toLowerCase().includes(q.toLowerCase())) {
            results.push({ type: "capability", id: t.id, name: t.name, capabilityType: t.capabilityType, status: t.status });
          }
        }
      }

      // Search machine profiles
      if (!type || type === "machine") {
        const profiles = capability
          ? repos.templateStore.findMachineProfilesByType(capability)
          : repos.templateStore.findAllMachineProfiles();
        for (const p of profiles) {
          if (!q || p.machineName.toLowerCase().includes(q.toLowerCase())) {
            results.push({ type: "machine", id: p.id, name: p.machineName, capabilityType: p.capabilityType, status: p.status });
          }
        }
      }

      // Search verification templates
      if (!type || type === "verification") {
        const verTemplates = capability
          ? repos.templateStore.findVerificationTemplatesByType(capability)
          : repos.templateStore.findAllVerificationTemplates();
        for (const t of verTemplates) {
          if (!q || t.name.toLowerCase().includes(q.toLowerCase())) {
            results.push({ type: "verification", id: t.id, name: t.name, capabilityType: t.capabilityType, status: t.status });
          }
        }
      }

      // Search query templates
      if (!type || type === "query") {
        const queryTpls = repos.templateStore.searchQueryTemplates(q);
        for (const t of queryTpls) {
          results.push({ type: "query", id: t.id, name: t.name, status: t.status });
        }
      }

      return results;
    },
  );

  // GET /api/templates/suggest?machineModel=&capabilityType=&industry=&deviceProtocol=
  // Suggest templates for onboarding
  app.get<{ Querystring: { machineModel?: string; capabilityType?: string; industry?: string; deviceProtocol?: string } }>(
    "/api/templates/suggest",
    async (req, _reply) => {
      const { machineModel, capabilityType, industry, deviceProtocol } = req.query;
      return suggestionService.suggest({ machineModel, capabilityType, industry, deviceProtocol });
    },
  );
}
