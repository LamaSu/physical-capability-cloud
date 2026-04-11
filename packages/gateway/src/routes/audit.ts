/**
 * Audit log query routes.
 *
 * GET /api/audit/log   — query entries (?eventType=&actor=&resourceType=&since=&limit=)
 * GET /api/audit/stats — aggregate counts by eventType, last 24h
 */

import type { FastifyInstance } from "fastify";
import { auditService } from "../services/audit-service.js";

/**
 * Audit log admins (env var: comma-separated wallet addresses or operator IDs).
 * Members of this list get unscoped audit log access. Everyone else sees only
 * their own entries.
 *
 * Set in Railway: AUDIT_ADMINS=0xabc...,operator@example.com
 */
function getAuditAdmins(): Set<string> {
  const raw = process.env.AUDIT_ADMINS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isAuditAdmin(operatorId: string): boolean {
  return getAuditAdmins().has(operatorId.toLowerCase());
}

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
    // Scope to caller unless caller is in AUDIT_ADMINS env var.
    // Previously returned ALL operators' data to any authenticated user (red team #33).
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }

    const { eventType, resourceType, since } = req.query;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10), 1000) : 100;

    // Admins can pass an explicit actor filter; everyone else is forced to self.
    const isAdmin = isAuditAdmin(operatorId);
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
    // Stats remain unscoped for now (counts only, no PII) but require auth.
    const stats = auditService.stats();
    return { stats, window: "24h" };
  });
}
