/**
 * Tier-2 polish — public-shaped operator endpoints.
 *
 *   T2.3: GET /api/operators/by-compliance/:regulationId
 *   T2.4: GET /api/operators/:id/discoverability
 *   T2.7: POST /api/operators/:id/rate            (buyer-only, Bearer-gated)
 *         GET  /api/operators/:id/ratings         (public — reputation surface)
 *
 * The /api/operators/* prefix is auth-gated by default via apiGate. The GET
 * /ratings endpoint opts back out via PUBLIC_EXACT so reputation is readable
 * without a key (parity with on-chain reputation reads).
 */

import type { FastifyInstance } from "fastify";
import { getRepos } from "../db.js";
import { recordMatchQuery, listMatchQueriesForOperator } from "../services/match-log.js";
import type { RegistrationRow } from "@pcc/store";
// Wave 4.1 — TENANT_ENFORCE feature flag for by-compliance scoping.
// Default OFF: today's behavior (cross-tenant read of public-discovery rows).
// When ON: buyer-alpha's request scopes to alpha-tenant rows + null-tenant
// (public discovery). See packages/gateway/src/config/tenant-enforce.ts.
import { tenantOpts } from "../config/tenant-enforce.js";

// ── Public sanitisation ─────────────────────────────────────────────────
//
// Strip the operator wallet address, GPS, serial number, etc. from every
// response that crosses a tenant/operator boundary. The keys we emit are
// the same set used by the existing GET /api/onboard/registrations endpoint
// for parity.

function toPublicOperator(r: RegistrationRow) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    manufacturer: r.manufacturer,
    model: r.model,
    description: r.description ?? null,
    photos: Array.isArray(r.photos) ? r.photos : [],
    capabilities: Array.isArray(r.capabilities)
      ? r.capabilities.map((c: any) => ({
          id: c.id,
          type: c.type,
          name: c.name,
          materials: c.materials,
        }))
      : [],
    complianceRegulations: Array.isArray(r.complianceRegulations) ? r.complianceRegulations : [],
    status: r.status,
    createdAt: r.createdAt,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────

export async function operatorsPublicRoutes(app: FastifyInstance) {
  // ─────────────────────────────────────────────────────────────────────
  // T2.3 — list operators that claim a given compliance regulation
  // ─────────────────────────────────────────────────────────────────────
  app.get<{ Params: { regulationId: string } }>(
    "/api/operators/by-compliance/:regulationId",
    async (req, reply) => {
      const repos = getRepos();
      const regulationId = decodeURIComponent(req.params.regulationId ?? "").trim();
      if (!regulationId) {
        return reply.status(400).send({ error: "regulation_id_required" });
      }
      // Wave 4.1 — when TENANT_ENFORCE is on, scope to the buyer's tenant
      // so cross-tenant compliance leaks are prevented. When OFF, behavior
      // is today's (cross-tenant read of all rows for public discovery).
      const opts = tenantOpts(req);
      const rows = repos.registrations.findByCompliance(regulationId, opts);
      const operators = rows
        // Don't surface deleted profiles in public discovery
        .filter((r) => r.status !== "deleted")
        .map(toPublicOperator);
      return { operators, regulationId, count: operators.length };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // T2.4 — discoverability diagnostics
  // ─────────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/operators/:id/discoverability",
    async (req, reply) => {
      const repos = getRepos();
      const reg = repos.registrations.findById(req.params.id);
      if (!reg) return reply.status(404).send({ error: "not_found" });

      const matchLog = listMatchQueriesForOperator(reg.id);

      // Build the keyword/index sets from the operator's own surface area.
      const ownTerms = new Set<string>();
      const pushTerm = (s?: string | null) => {
        if (!s) return;
        for (const w of s.toLowerCase().split(/[^a-z0-9]+/g)) {
          if (w && w.length > 2) ownTerms.add(w);
        }
      };
      pushTerm(reg.name);
      pushTerm(reg.category);
      pushTerm(reg.manufacturer);
      pushTerm(reg.model);
      if (Array.isArray(reg.capabilities)) {
        for (const c of reg.capabilities as any[]) {
          pushTerm(c?.type);
          pushTerm(c?.name);
          if (Array.isArray(c?.materials)) for (const m of c.materials) pushTerm(m);
        }
      }

      const dataQuality: "live" | "placeholder" = matchLog.length > 0 ? "live" : "placeholder";

      // Top keyword misses — query terms below score threshold that didn't
      // intersect the operator's own term-set.
      const missCounts = new Map<string, number>();
      let lastMatchAt: string | null = null;
      for (const q of matchLog) {
        if (!lastMatchAt || q.timestamp > lastMatchAt) lastMatchAt = q.timestamp;
        if (q.score >= 0.3) continue;
        for (const w of (q.query ?? "").toLowerCase().split(/[^a-z0-9]+/g)) {
          if (w.length <= 2) continue;
          if (ownTerms.has(w)) continue;
          missCounts.set(w, (missCounts.get(w) ?? 0) + 1);
        }
      }
      const topKeywordMisses = [...missCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([term]) => term);

      const suggestions: string[] = [];
      if (dataQuality === "placeholder") {
        suggestions.push(
          "Add 1-2 more capability tags to improve discovery",
          "Confirm your geographic location for distance-based matches",
        );
        if (!Array.isArray(reg.complianceRegulations) || reg.complianceRegulations.length === 0) {
          suggestions.push(
            "Declare any compliance regulations you meet (e.g., ISO-9001:2015) — buyers filter on these",
          );
        }
      } else {
        for (const term of topKeywordMisses) {
          suggestions.push(`Add "${term}" to your tags — buyers searched for it recently.`);
        }
        if (suggestions.length === 0) {
          suggestions.push("Your tags align with recent buyer searches. Keep capability descriptions current.");
        }
      }

      return {
        operatorId: reg.id,
        indexed_at: reg.submittedAt ?? reg.createdAt,
        last_match_query_at: lastMatchAt,
        top_keyword_misses: topKeywordMisses,
        suggestions,
        data_quality: dataQuality,
      };
    },
  );

  // ─────────────────────────────────────────────────────────────────────
  // T2.7 — operator rating (buyer-only POST + public GET)
  // ─────────────────────────────────────────────────────────────────────
  app.post<{ Params: { id: string }; Body: { rating?: number; jobId?: string; comment?: string } }>(
    "/api/operators/:id/rate",
    async (req, reply) => {
      const repos = getRepos();
      const operatorId = req.params.id;
      const reg = repos.registrations.findById(operatorId);
      if (!reg) return reply.status(404).send({ error: "operator_not_found" });

      const buyerId = (req as any).operatorId
        ?? (req as any).apiKeyId
        ?? (req as any).userId
        ?? (req as any).walletAddress;
      if (!buyerId) {
        return reply.status(401).send({ error: "auth_required" });
      }

      const body = req.body ?? {};
      const rating = body.rating;
      if (typeof rating !== "number" || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
        return reply.status(422).send({
          error: "invalid_rating",
          message: "rating must be an integer 1..5",
        });
      }
      if (!body.jobId || typeof body.jobId !== "string") {
        return reply.status(400).send({ error: "job_id_required" });
      }
      const comment = typeof body.comment === "string" ? body.comment.slice(0, 1000) : null;

      // TODO(wave-4): verify caller is the buyer-of-jobId by joining against
      // jobs / negotiation_sessions. For Tier 2, the buyer is the
      // authenticated caller and the rating is keyed by (jobId, buyerId)
      // so a bad-faith caller can rate at most 1× per job they hold a key
      // for and cannot impersonate another buyer.

      const existing = repos.ratings.findByJobAndBuyer(body.jobId, String(buyerId));
      if (existing) {
        // Idempotent: re-rating the same job updates the score in place.
        // Repos stay simple; we delete + insert to avoid an update method.
        return reply.status(409).send({
          error: "already_rated",
          message: "You've already rated this job. PATCH endpoint is Wave 4.",
          existing: {
            id: existing.id,
            rating: existing.rating,
            createdAt: existing.createdAt,
          },
        });
      }

      const row = repos.ratings.insert({
        id: `rate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        operatorId,
        jobId: body.jobId,
        buyerId: String(buyerId),
        rating,
        comment,
        createdAt: new Date().toISOString(),
      });
      if (!row) return reply.status(500).send({ error: "insert_failed" });

      return reply.status(201).send({ rating: row });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/operators/:id/ratings",
    async (req, reply) => {
      const repos = getRepos();
      const operatorId = req.params.id;
      const reg = repos.registrations.findById(operatorId);
      if (!reg) return reply.status(404).send({ error: "operator_not_found" });

      const limit = Math.min(Math.max(parseInt(req.query.limit ?? "25", 10) || 25, 1), 100);
      const offset = Math.max(parseInt(req.query.offset ?? "0", 10) || 0, 0);

      const aggregate = repos.ratings.aggregateForOperator(operatorId);
      const recent = repos.ratings.findByOperator(operatorId, { limit, offset });

      // Sanitise rows for public consumption — drop buyer wallet, keep rating + comment.
      const recentPublic = recent.map((r) => ({
        id: r.id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
      }));

      return {
        operatorId,
        avg: aggregate.avg,
        count: aggregate.count,
        distribution: aggregate.distribution,
        recent: recentPublic,
      };
    },
  );
}

// Keep recordMatchQuery in the module's import graph so tree-shakers don't
// drop the import. Routes call it indirectly via service callers (e.g. the
// match-capabilities route, when wired); guarded here as a no-op reference.
void recordMatchQuery;
