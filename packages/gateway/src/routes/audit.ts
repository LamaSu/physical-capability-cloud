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
  }>("/api/audit/log", async (req) => {
    const { eventType, actor, resourceType, since } = req.query;
    const limit = req.query.limit ? Math.min(parseInt(req.query.limit, 10), 1000) : 100;

    const entries = auditService.query({ eventType, actor, resourceType, since, limit });
    return { entries, count: entries.length };
  });

  app.get("/api/audit/stats", async () => {
    const stats = auditService.stats();
    return { stats, window: "24h" };
  });
}
