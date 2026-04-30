/**
 * Tier-2 polish — public-shaped operator endpoints.
 *
 *   T2.3: GET /api/operators/by-compliance/:regulationId
 *   T2.4: GET /api/operators/:id/discoverability
 *
 * The /api/operators/* prefix is auth-gated by default via apiGate (it's not
 * in PUBLIC_PREFIXES / PUBLIC_EXACT). A subsequent commit adds T2.7 routes.
 */

import type { FastifyInstance } from "fastify";
import { getRepos } from "../db.js";
import { recordMatchQuery, listMatchQueriesForOperator } from "../services/match-log.js";
import type { RegistrationRow } from "@pcc/store";

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
      const rows = repos.registrations.findByCompliance(regulationId);
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
}

// Keep recordMatchQuery in the module's import graph so tree-shakers don't
// drop the import. Routes call it indirectly via service callers (e.g. the
// match-capabilities route, when wired); guarded here as a no-op reference.
void recordMatchQuery;
