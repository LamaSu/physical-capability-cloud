/**
 * Job-offers routes — the generic matching primitive at /api/job-offers/*.
 *
 * Replaces the courier-specific /api/courier-jobs/* surface (xray's fold)
 * with a category-agnostic version. EVERY PCC adapter (pcc-courier,
 * pcc-dominos, pcc-hamilton, pcc-kdense, pcc-opentrons, ...) shares this
 * primitive — they each contribute a `capability_type` and an opaque
 * `requirements` JSON blob; the gateway's job is just matching.
 *
 * Surface:
 *   POST   /api/job-offers                       — create open offer
 *   GET    /api/job-offers/open                  — operator feed (PUBLIC; ?capabilityType= REQUIRED)
 *                                                  filters: ?within=lat,lng,miles
 *                                                           ?minAmount=N ?maxAmount=N ?currency=USD
 *                                                           ?tier=0..3
 *                                                           ?verified=true
 *                                                           ?limit=N&offset=N
 *   GET    /api/job-offers/:id                   — single offer + events (PUBLIC)
 *   POST   /api/job-offers/:id/claim             — race-safe claim
 *   POST   /api/job-offers/:id/events            — operator progress event
 *   POST   /api/job-offers/:id/heartbeat         — poster liveness
 *   PATCH  /api/job-offers/:id                   — poster updates
 *   DELETE /api/job-offers/:id                   — poster cancels
 *   GET    /api/job-offers/healthz               — liveness (PUBLIC)
 *
 * Auth:
 *   - POST/PATCH/DELETE/heartbeat require an authenticated poster identity
 *     (API key operatorId, SIWE userId, or X-Posted-By header fallback).
 *   - PATCH/DELETE/heartbeat check the original poster matches the current
 *     identity (or are permitted if posterDid was null at creation).
 *   - GET /open + GET /:id + healthz are PUBLIC so operator agents can poll
 *     without holding a gateway API key. Public allowlist additions live in
 *     middleware/api-gate.ts.
 *
 * Backward compat: courier-specific /api/courier-jobs/* routes are kept as
 * thin shims that forward to this generic surface. See
 * routes/courier-jobs.ts. Migration window: pcc-courier and other clients
 * are expected to switch to /api/job-offers/* over the next 30 days.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getJobOffersStore,
  type ClaimInput,
  type CreateJobOfferInput,
  type EvidenceRequirements,
  type GeoFence,
  type PricingSpec,
} from "../services/job-offers-store.js";

// Posting identity helper — prefers API key operatorId, falls back to
// SIWE-session userId, else X-Posted-By header (matches v0.2 surface for
// callers that haven't migrated yet, e.g., pcc-courier outside the gateway).
function resolvePoster(req: FastifyRequest): string | null {
  const op = (req as unknown as { operatorId?: string | null }).operatorId;
  if (op) return op;
  const uid = (req as unknown as { userId?: string | null }).userId;
  if (uid) return uid;
  const header = req.headers["x-posted-by"];
  if (typeof header === "string" && header.trim() !== "") return header.trim();
  if (Array.isArray(header) && header[0]) return header[0];
  return null;
}

function requirePoster(req: FastifyRequest, reply: FastifyReply): string | null {
  const p = resolvePoster(req);
  if (!p) {
    void reply.code(401).send({
      error: "missing_identity",
      message:
        "Operator identity required. Authenticate with an API key (preferred) or set X-Posted-By.",
    });
    return null;
  }
  return p;
}

interface CreateBody {
  id?: string;                              // optional caller-supplied id
  capabilityType?: string;                  // REQUIRED
  requirements?: Record<string, unknown>;   // REQUIRED — opaque shape per capability type
  serviceAreaGeofence?: GeoFence;
  pricing?: PricingSpec;                    // REQUIRED
  deadline?: string;
  assuranceTier?: 0 | 1 | 2 | 3;
  evidenceRequirements?: EvidenceRequirements;
  sourceVerifyUrl?: string;
  requireHeartbeat?: boolean;
  idempotencyKey?: string;
  posterKernelId?: string;
  validUntil?: string;
}

function buildCreateInputFromBody(b: CreateBody, posterDid: string | null): CreateJobOfferInput {
  return {
    id: b.id,
    capabilityType: b.capabilityType!,        // caller validated
    requirements: b.requirements!,            // caller validated
    serviceAreaGeofence: b.serviceAreaGeofence ?? null,
    pricing: b.pricing!,                      // caller validated
    deadline: b.deadline ?? null,
    assuranceTier: b.assuranceTier ?? null,
    evidenceRequirements: b.evidenceRequirements ?? null,
    sourceVerifyUrl: b.sourceVerifyUrl ?? null,
    requireHeartbeat: !!b.requireHeartbeat,
    idempotencyKey: b.idempotencyKey ?? null,
    posterDid,
    posterKernelId: b.posterKernelId ?? null,
    validUntilIso: b.validUntil ?? null,
  };
}

function validatePricing(p: unknown): p is PricingSpec {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (typeof o.amount !== "number") return false;
  if (typeof o.currency !== "string") return false;
  if (typeof o.model !== "string") return false;
  if (!["fixed", "quote-required", "per-unit"].includes(o.model as string)) return false;
  return true;
}

export async function jobOffersRoutes(app: FastifyInstance) {
  // ── GET /api/job-offers/healthz ────────────────────────────────────────
  app.get("/api/job-offers/healthz", async () => {
    const store = getJobOffersStore();
    return {
      ok: true,
      service: "job-offers (generic matching primitive)",
      offers: store.size(),
      open: store.countByStatus("open"),
      expired: store.countByStatus("expired"),
      claimed: store.countByStatus("claimed"),
      in_progress: store.countByStatus("in_progress"),
      delivered: store.countByStatus("delivered"),
      cancelled: store.countByStatus("cancelled"),
      ts: new Date().toISOString(),
    };
  });

  // ── POST /api/job-offers ───────────────────────────────────────────────
  app.post<{ Body: CreateBody }>("/api/job-offers", async (req, reply) => {
    const b = req.body || {};
    const missing: string[] = [];
    if (!b.capabilityType) missing.push("capabilityType");
    if (!b.requirements || typeof b.requirements !== "object") missing.push("requirements");
    if (!b.pricing) missing.push("pricing");
    if (missing.length) {
      return reply.code(400).send({
        error: "missing_fields",
        required: ["capabilityType", "requirements", "pricing"],
        missing,
      });
    }
    if (!validatePricing(b.pricing)) {
      return reply.code(400).send({
        error: "invalid_pricing",
        message: "pricing must be { amount:number, currency:string, model: 'fixed'|'quote-required'|'per-unit' }",
      });
    }
    const posterDid = resolvePoster(req);
    const store = getJobOffersStore();
    const result = await store.create(buildCreateInputFromBody(b, posterDid));
    if (!result.ok) {
      if (result.reason === "schema_validation_failed") {
        return reply.code(400).send({
          error: "schema_validation_failed",
          message: result.error,
        });
      }
      // VerifyFail
      return reply.code(400).send({
        error: "source_verify_failed",
        reason: result.reason,
        sourceStatus: result.status ?? null,
        sourceBody: result.body ?? null,
      });
    }
    if (!result.created) {
      return reply.code(200).send({
        ok: true,
        id: result.offer.id,
        status: result.offer.status,
        note: "already posted",
        requirementsValidated: result.offer.requirementsValidated,
      });
    }
    return reply.code(201).send({
      ok: true,
      id: result.offer.id,
      capabilityType: result.offer.capabilityType,
      status: result.offer.status,
      verified: result.offer.verified,
      validUntil: result.offer.validUntil,
      requirementsValidated: result.offer.requirementsValidated,
      feedUrl: `/api/job-offers/open?capabilityType=${encodeURIComponent(result.offer.capabilityType)}`,
    });
  });

  // ── GET /api/job-offers/open ───────────────────────────────────────────
  app.get<{
    Querystring: {
      capabilityType?: string;
      verified?: string;
      minAmount?: string;
      maxAmount?: string;
      currency?: string;
      tier?: string;
      within?: string;
      limit?: string;
      offset?: string;
    };
  }>("/api/job-offers/open", async (req, reply) => {
    const q = req.query || {};
    if (!q.capabilityType) {
      return reply.code(400).send({
        error: "missing_field",
        required: ["capabilityType"],
        message: "?capabilityType= is required so operators see only what they can fulfill. Example: ?capabilityType=courier.dispatch",
      });
    }
    let within: { lat: number; lng: number; miles: number } | null = null;
    if (q.within) {
      const parts = String(q.within).split(",").map((s) => Number(s.trim()));
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        within = { lat: parts[0]!, lng: parts[1]!, miles: parts[2]! };
      }
    }
    const minAmount = q.minAmount != null ? Number(q.minAmount) : null;
    const maxAmount = q.maxAmount != null ? Number(q.maxAmount) : null;
    const tier = q.tier != null ? Number(q.tier) : null;
    const limit = q.limit != null ? Math.max(1, Math.min(1000, Number(q.limit) | 0)) : 100;
    const offset = q.offset != null ? Math.max(0, Number(q.offset) | 0) : 0;
    const store = getJobOffersStore();
    const all = store.listOpen({
      capabilityType: q.capabilityType,
      verified: q.verified === "true",
      minAmount: minAmount != null && Number.isFinite(minAmount) ? minAmount : null,
      maxAmount: maxAmount != null && Number.isFinite(maxAmount) ? maxAmount : null,
      currency: q.currency,
      tier: tier != null && (tier === 0 || tier === 1 || tier === 2 || tier === 3) ? tier as 0|1|2|3 : null,
      within,
    });
    const offers = all.slice(offset, offset + limit);
    return {
      offers,
      count: offers.length,
      total: all.length,
      offset,
      limit,
      ts: new Date().toISOString(),
    };
  });

  // ── GET /api/job-offers/:id ────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/job-offers/:id", async (req, reply) => {
    const store = getJobOffersStore();
    const o = store.get(req.params.id);
    if (!o) return reply.code(404).send({ error: "not_found" });
    return { offer: o, events: store.getEvents(o.id) };
  });

  // ── POST /api/job-offers/:id/claim ─────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { kernelId?: string; claimSignature?: string; etaMin?: number; contact?: string };
  }>("/api/job-offers/:id/claim", async (req, reply) => {
    const b = req.body || {};
    if (!b.kernelId) {
      return reply.code(400).send({ error: "missing_field", required: ["kernelId"] });
    }
    const store = getJobOffersStore();
    const claim: ClaimInput = {
      kernelId: b.kernelId,
      claimSignature: b.claimSignature,
      etaMin: b.etaMin,
      contact: b.contact,
    };
    const result = await store.claim(req.params.id, claim);
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.reason === "not_open") {
        return reply.code(409).send({
          error: "not_open",
          currentStatus: result.currentStatus,
          claimedBy: result.claimedBy,
        });
      }
    }
    return { ok: true, offer: (result as { ok: true; offer: unknown }).offer };
  });

  // ── POST /api/job-offers/:id/events ────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { event?: string; kind?: string; by?: string; payload?: unknown; note?: string };
  }>("/api/job-offers/:id/events", async (req, reply) => {
    const b = req.body || {};
    const eventKind = b.event ?? b.kind;
    if (!eventKind || typeof eventKind !== "string") {
      return reply.code(400).send({
        error: "missing_field",
        required: ["event"],
        message: "event (or kind) is required. Common values: acknowledged, in_progress, progress_update, delivered, error, cancelled, note.",
      });
    }
    const store = getJobOffersStore();
    const result = store.recordEvent(
      req.params.id,
      eventKind,
      b.by ?? null,
      b.payload ?? null,
      b.note ?? null,
    );
    if (!result.ok) return reply.code(404).send({ error: "not_found" });
    return { ok: true, status: result.status, event: result.event };
  });

  // ── PATCH /api/job-offers/:id ──────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: {
      pricing?: PricingSpec;
      deadline?: string;
      validUntil?: string;
      requirements?: Record<string, unknown>;
    };
  }>("/api/job-offers/:id", async (req, reply) => {
    const poster = requirePoster(req, reply);
    if (poster === null) return;
    const b = req.body || {};
    if (b.pricing && !validatePricing(b.pricing)) {
      return reply.code(400).send({ error: "invalid_pricing" });
    }
    const store = getJobOffersStore();
    const result = store.patch(req.params.id, poster, {
      pricing: b.pricing,
      deadlineIso: b.deadline,
      validUntil: b.validUntil,
      requirements: b.requirements,
    });
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.reason === "forbidden") {
        return reply.code(403).send({
          error: "forbidden",
          message: "You can only patch offers you posted",
        });
      }
      if (result.reason === "not_editable") {
        return reply.code(409).send({
          error: "not_editable",
          currentStatus: result.currentStatus,
        });
      }
    }
    return { ok: true, offer: (result as { ok: true; offer: unknown }).offer };
  });

  // ── DELETE /api/job-offers/:id ─────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/job-offers/:id", async (req, reply) => {
    const poster = requirePoster(req, reply);
    if (poster === null) return;
    const store = getJobOffersStore();
    const result = store.cancel(req.params.id, poster);
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.reason === "forbidden") {
        return reply.code(403).send({
          error: "forbidden",
          message: "You can only cancel offers you posted",
        });
      }
    }
    return { ok: true, status: (result as { ok: true; status: string }).status };
  });

  // ── POST /api/job-offers/:id/heartbeat ─────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/api/job-offers/:id/heartbeat",
    async (req, reply) => {
      const poster = requirePoster(req, reply);
      if (poster === null) return;
      const store = getJobOffersStore();
      const result = store.heartbeat(req.params.id, poster);
      if (!result.ok) {
        if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
        if (result.reason === "forbidden") {
          return reply.code(403).send({
            error: "forbidden",
            message: "You can only heartbeat offers you posted",
          });
        }
      }
      return {
        ok: true,
        lastHeartbeatAt: (result as { ok: true; lastHeartbeatAt: string }).lastHeartbeatAt,
      };
    },
  );
}
