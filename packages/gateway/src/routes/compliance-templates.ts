// packages/gateway/src/routes/compliance-templates.ts
//
// CRUD routes for compliance templates and profiles — Pattern 6.
//
// GET    /api/compliance/templates                                        — list all templates
// GET    /api/compliance/templates/search?industry=&jurisdiction=&capability=  — search
// GET    /api/compliance/templates/:id                                   — get by ID
// POST   /api/compliance/templates                                       — create new template
// GET    /api/compliance/profiles/:kernelId                              — get kernel's profiles
// POST   /api/compliance/profiles                                        — create/update profile
// GET    /api/compliance/scores/:kernelId                                — compliance scores for kernel
//
// Follows the same pattern as compliance.ts — read-only endpoints are public,
// write endpoints require authentication via the apiGate middleware.

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { getRepos } from "../db.js";

// ComplianceTemplateInsert / ComplianceProfileInsert are inferred from the
// Drizzle schema. We use inline object literals that satisfy the insert shape
// rather than importing the types directly (gateway depends on @pcc/store,
// not @pcc/db, so we avoid the cross-package type import).
type ComplianceTemplateInsert = Parameters<ReturnType<typeof getRepos>["analytics"]["insertComplianceTemplate"]>[0];
type ComplianceProfileInsert = Parameters<ReturnType<typeof getRepos>["analytics"]["insertComplianceProfile"]>[0];

// ── Helpers ────────────────────────────────────────────────────────────────

function notFound(reply: FastifyReply, message = "not_found") {
  return reply.code(404).send({ error: message });
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: "bad_request", message });
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function complianceTemplateRoutes(app: FastifyInstance) {
  const prefix = "/api/compliance";

  // ── GET /api/compliance/templates — list all compliance templates ─────────
  // Note: search route must be registered BEFORE the :id param route or Fastify
  // would treat "search" as a template ID.
  app.get(`${prefix}/templates/search`, async (req) => {
    const qs = req.query as {
      industry?: string;
      jurisdiction?: string;
      capability?: string;
      status?: string;
    };

    const repos = getRepos();
    let templates = repos.analytics.findAllComplianceTemplates();

    // Filter by industry (JSON array contains check)
    if (qs.industry) {
      const industry = qs.industry.toLowerCase();
      templates = templates.filter((t) => {
        const industries = Array.isArray(t.industries) ? t.industries : [];
        return industries.some((i) => String(i).toLowerCase().includes(industry));
      });
    }

    // Filter by jurisdiction
    if (qs.jurisdiction) {
      const jurisdiction = qs.jurisdiction.toLowerCase();
      templates = templates.filter((t) => {
        const jurisdictions = Array.isArray(t.jurisdictions) ? t.jurisdictions : [];
        return (
          jurisdictions.some((j) => String(j).toLowerCase().includes(jurisdiction)) ||
          jurisdictions.includes("global")
        );
      });
    }

    // Filter by applicable capability type
    if (qs.capability) {
      const capability = qs.capability.toLowerCase();
      templates = templates.filter((t) => {
        const types = Array.isArray(t.applicableCapabilityTypes) ? t.applicableCapabilityTypes : [];
        // Empty array = applies to all capability types
        return types.length === 0 || types.some((c) => String(c).toLowerCase().includes(capability));
      });
    }

    // Filter by status
    if (qs.status) {
      templates = templates.filter((t) => t.status === qs.status);
    }

    return { templates, total: templates.length };
  });

  // ── GET /api/compliance/templates — list all templates ─────────────────
  app.get(`${prefix}/templates`, async (req) => {
    const qs = req.query as { status?: string };
    const repos = getRepos();

    const templates = qs.status
      ? repos.analytics.findComplianceTemplatesByStatus(qs.status)
      : repos.analytics.findAllComplianceTemplates();

    return { templates, total: templates.length };
  });

  // ── GET /api/compliance/templates/:id — get template by ID ────────────
  app.get<{ Params: { id: string } }>(
    `${prefix}/templates/:id`,
    async (req, reply) => {
      const repos = getRepos();
      const template = repos.analytics.findComplianceTemplateById(req.params.id);
      if (!template) return notFound(reply);
      return { template };
    },
  );

  // ── POST /api/compliance/templates — create new template ───────────────
  app.post<{
    Body: {
      regulationId?: string;
      name?: string;
      description?: string;
      version?: string;
      industries?: string[];
      jurisdictions?: string[];
      applicableCapabilityTypes?: string[];
      rules?: unknown[];
      minimumAssuranceTier?: number;
      retentionPeriodDays?: number;
      effectiveDate?: string;
      status?: string;
    };
  }>(
    `${prefix}/templates`,
    async (req, reply) => {
      const body = req.body ?? {};

      if (!body.regulationId || !body.name || !body.version) {
        return badRequest(reply, "regulationId, name, and version are required");
      }

      const repos = getRepos();
      const now = new Date().toISOString();

      const insert: ComplianceTemplateInsert = {
        id: randomUUID(),
        regulationId: body.regulationId,
        name: body.name,
        description: body.description ?? null,
        version: body.version,
        industries: body.industries ?? [],
        jurisdictions: body.jurisdictions ?? ["global"],
        applicableCapabilityTypes: body.applicableCapabilityTypes ?? [],
        rules: body.rules ?? [],
        minimumAssuranceTier: body.minimumAssuranceTier ?? 0,
        retentionPeriodDays: body.retentionPeriodDays ?? 365,
        authorId: (req as unknown as { operatorId?: string }).operatorId ?? null,
        status: (body.status as "draft" | "active" | "superseded" | "archived") ?? "draft",
        supersededBy: null,
        effectiveDate: body.effectiveDate ?? now,
        sunsetDate: null,
        usageCount: 0,
        rating: null,
        createdAt: now,
        updatedAt: now,
      };

      const created = repos.analytics.insertComplianceTemplate(insert);
      if (!created) {
        return reply.code(500).send({ error: "Failed to create compliance template" });
      }

      return reply.code(201).send({ template: created });
    },
  );

  // ── GET /api/compliance/profiles/:kernelId — kernel's compliance profile ─
  app.get<{ Params: { kernelId: string } }>(
    `${prefix}/profiles/:kernelId`,
    async (req, reply) => {
      const repos = getRepos();
      const profiles = repos.analytics.findComplianceProfilesByKernel(req.params.kernelId);

      if (profiles.length === 0) {
        return notFound(reply, "No compliance profile found for this kernel");
      }

      return { profiles, total: profiles.length };
    },
  );

  // ── POST /api/compliance/profiles — create or update compliance profile ─
  app.post<{
    Body: {
      kernelId?: string;
      templateIds?: string[];
      industry?: string;
      jurisdictions?: string[];
      overrides?: unknown[];
    };
  }>(
    `${prefix}/profiles`,
    async (req, reply) => {
      const body = req.body ?? {};

      if (!body.kernelId) {
        return badRequest(reply, "kernelId is required");
      }

      const repos = getRepos();
      const now = new Date().toISOString();

      // Check if profile exists for this kernel
      const existing = repos.analytics.findComplianceProfilesByKernel(body.kernelId);

      if (existing.length > 0) {
        // Update the first matching profile
        const profile = existing[0]!;
        const updated = repos.analytics.updateComplianceProfile(profile.id, {
          templateIds: body.templateIds ?? profile.templateIds,
          industry: body.industry ?? profile.industry,
          jurisdictions: body.jurisdictions ?? profile.jurisdictions,
          overrides: body.overrides ?? profile.overrides,
          updatedAt: now,
        });
        return { profile: updated, created: false };
      }

      // Create new profile
      const insert: ComplianceProfileInsert = {
        id: randomUUID(),
        kernelId: body.kernelId,
        templateIds: body.templateIds ?? [],
        industry: body.industry ?? "general",
        jurisdictions: body.jurisdictions ?? ["global"],
        overrides: body.overrides ?? null,
        createdAt: now,
        updatedAt: now,
      };

      const created = repos.analytics.insertComplianceProfile(insert);
      if (!created) {
        return reply.code(500).send({ error: "Failed to create compliance profile" });
      }

      return reply.code(201).send({ profile: created, created: true });
    },
  );

  // ── GET /api/compliance/scores/:kernelId — compliance scores ────────────
  app.get<{ Params: { kernelId: string } }>(
    `${prefix}/scores/:kernelId`,
    async (req, reply) => {
      const repos = getRepos();
      const { kernelId } = req.params;

      // Get the kernel's compliance profiles
      const profiles = repos.analytics.findComplianceProfilesByKernel(kernelId);
      if (profiles.length === 0) {
        return notFound(reply, "No compliance profile found for this kernel");
      }

      const profile = profiles[0]!;
      const templateIds = Array.isArray(profile.templateIds) ? profile.templateIds : [];

      // Load each template and compute a simple score
      const scores = templateIds.map((templateId) => {
        const template = repos.analytics.findComplianceTemplateById(templateId);
        if (!template) {
          return {
            kernelId,
            templateId,
            regulationId: "unknown",
            score: 0,
            ruleResults: [],
            passed: 0,
            total: 0,
            computedAt: new Date().toISOString(),
          };
        }

        const rules = Array.isArray(template.rules) ? template.rules : [];

        // MVP: return a structural score based on template metadata
        // Real implementation would check evidence bundles and job history
        return {
          kernelId,
          templateId,
          regulationId: template.regulationId,
          score: 0, // will be computed from actual evidence
          ruleResults: rules.map((r: unknown) => {
            const rule = r as { ruleId?: string; name?: string; severity?: string } | null;
            return {
              ruleId: rule?.ruleId ?? "",
              ruleName: rule?.name ?? "",
              passed: false, // requires evidence to determine
              severity: rule?.severity ?? "informational",
              details: "Not yet evaluated — requires evidence submission",
            };
          }),
          passed: 0,
          total: rules.length,
          computedAt: new Date().toISOString(),
        };
      });

      return { kernelId, scores, total: scores.length };
    },
  );
}
