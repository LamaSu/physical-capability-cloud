/**
 * Audit log query routes.
 *
 * GET /api/audit/log   — query entries (?eventType=&actor=&resourceType=&since=&limit=)
 * GET /api/audit/stats — aggregate counts by eventType, last 24h
 */

import type { FastifyInstance } from "fastify";
import { auditService } from "../services/audit-service.js";

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
    // Scope to caller — only return audit entries for the authenticated operator.
    // Previously returned ALL operators' data (red team #33).
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }

    const { eventType, resourceType, since } = req.query;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10), 1000) : 100;

    // Force the actor filter to the authenticated caller — ignore any body actor override.
    const entries = auditService.query({
      eventType,
      actor: operatorId,
      resourceType,
      since,
      limit,
    });
    return { entries, count: entries.length };
  });

  app.get("/api/audit/stats", async (req, reply) => {
    // Stats are also scoped — no cross-operator aggregates.
    const operatorId = (req as any).operatorId ?? (req as any).userId;
    if (!operatorId) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    const stats = auditService.stats();
    return { stats, window: "24h" };
  });
}
