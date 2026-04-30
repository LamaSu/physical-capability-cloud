/**
 * Tier-2 polish — public-shaped operator endpoints.
 *
 *   T2.3: GET /api/operators/by-compliance/:regulationId
 *
 * The /api/operators/* prefix is auth-gated by default via apiGate (it's not
 * in PUBLIC_PREFIXES / PUBLIC_EXACT). Subsequent commits add T2.4 and T2.7
 * routes here.
 */

import type { FastifyInstance } from "fastify";
import { getRepos } from "../db.js";
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
}
