/**
 * Audit log query routes.
 *
 * GET /api/audit/log   — query entries (?eventType=&actor=&resourceType=&since=&limit=)
 * GET /api/audit/stats — aggregate counts by eventType, last 24h
 */

import type { FastifyInstance } from "fastify";
import { auditService } from "../services/audit-service.js";
import { presentsAdminSecret, requireAdminSecret } from "../auth/admin-secret-gate.js";

/**
 * Who sees what (WP-A round 5; coord-watch #2883). Every caller sees only their
 * own entries. A cross-tenant view (an explicit `actor` filter, or global stats)
 * needs the admin SECRET (X-Admin-Key = PCC_ADMIN_KEY). The AUDIT_ADMINS
 * operatorId allowlist grants nothing any more: an operatorId is asserted, not held.
 */

export async function auditRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      eventType?: string;
      actor?: string;
      resourceType?: string;
      since?: string;
      limit?: string;
    };
  }>("/api/audit/log", async (req, reply) => {
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }

    const { eventType, resourceType, since } = req.query;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10), 1000) : 100;

    // Asking for the admin view means presenting the secret; a wrong one is refused,
    // never silently downgraded. Without it the caller is scoped to themselves.
    const isAdmin = presentsAdminSecret(req);
    if (isAdmin && !requireAdminSecret(req, reply)) return reply;
    const actorFilter = isAdmin ? req.query.actor : operatorId;

    const entries = auditService.query({
      eventType,
      actor: actorFilter,
      resourceType,
      since,
      limit,
    });
    return { entries, count: entries.length, scoped: !isAdmin };
  });

  app.get("/api/audit/stats", async (req, reply) => {
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    // Global counts are cross-tenant data: admin secret only. Everyone else gets
    // the same counts over their own entries.
    if (presentsAdminSecret(req)) {
      if (!requireAdminSecret(req, reply)) return reply;
      return { stats: auditService.stats(), window: "24h", scoped: false };
    }
    // Counted in the database over the caller's WHOLE 24h window (WP-A round 7, astra
    // r2 new defect 2): it used to count a query capped at 1000 rows and still say "24h".
    const stats = auditService.stats(String(operatorId)).sort((a, b) => b.count - a.count);
    return { stats, window: "24h", scoped: true };
  });
}
