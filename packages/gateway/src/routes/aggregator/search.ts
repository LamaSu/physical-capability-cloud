/**
 * GET /api/aggregator/tools/search — public registry query.
 *
 * Returns up to N IndexedTools matching the supplied filter (q, actionClass,
 * minTrustTier, skill, domain). Sorted ascending by id for stable pagination.
 *
 * Read-only and public per spec §4.1. No auth required to browse the index;
 * invocation is gated on /api/aggregator/invoke separately.
 */

import type { FastifyInstance } from "fastify";
import type {
  IndexedTool,
  IndexedToolActionClass,
  TrustTier,
} from "@pcc/spec";
import { getAggregatorRegistry } from "./index.js";

interface SearchQuery {
  q?: string;
  actionClass?: IndexedToolActionClass;
  minTrustTier?: TrustTier;
  skill?: string;
  domain?: string;
  limit?: string;
  offset?: string;
}

interface SearchResponse {
  tools: IndexedTool[];
  total: number;
  limit: number;
  offset: number;
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: SearchQuery; Reply: SearchResponse }>(
    "/api/aggregator/tools/search",
    async (req, reply) => {
      const registry = getAggregatorRegistry();
      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);
      const tools = registry.query({
        q: req.query.q,
        actionClass: req.query.actionClass,
        minTrustTier: req.query.minTrustTier,
        skill: req.query.skill,
        domain: req.query.domain,
        limit,
        offset,
      });
      // Total = full registry count (Phase 1 simplification). Phase 2 will
      // compute a precise filtered total via DB aggregate.
      const total = registry.count();
      return reply.send({ tools, total, limit, offset });
    },
  );
}

function parseLimit(s: string | undefined): number {
  const n = Number.parseInt(s ?? "50", 10);
  if (Number.isNaN(n)) return 50;
  return Math.min(200, Math.max(1, n));
}

function parseOffset(s: string | undefined): number {
  const n = Number.parseInt(s ?? "0", 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, n);
}
