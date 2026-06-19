/**
 * Courier-jobs routes — folded port of pcc-courier-jobs v0.2.
 *
 * Standalone Railway demo at https://web-production-3c660.up.railway.app
 * is the source; this is the gateway-side fold per coord bulletin #207.
 *
 * Surface (mirror of v0.2):
 *   POST   /api/courier-jobs                    — create open delivery request
 *   GET    /api/courier-jobs/open               — driver-agent feed (PUBLIC)
 *                                                 filters: ?within=lat,lng,miles
 *                                                          ?verified=true
 *                                                          ?minFeeUSD=N  ?maxFeeUSD=N
 *   GET    /api/courier-jobs/:id                — single job + events (PUBLIC)
 *   POST   /api/courier-jobs/:id/claim          — race-safe claim
 *   POST   /api/courier-jobs/:id/events         — driver progress event
 *   POST   /api/courier-jobs/:id/heartbeat      — poster liveness ping
 *   PATCH  /api/courier-jobs/:id                — poster updates
 *   DELETE /api/courier-jobs/:id                — poster cancels
 *   GET    /api/courier-jobs/healthz            — liveness (PUBLIC)
 *
 * Auth differences vs v0.2:
 *   - v0.2 took an X-Posted-By: <name> header at face value (no auth).
 *   - Folded version uses the API key's operatorId as the posting identity.
 *     PATCH/DELETE/heartbeat check the original poster matches the current
 *     operatorId (or are permitted if postedBy was null at creation).
 *   - GET /open + GET /:id + healthz are PUBLIC so driver agents can poll
 *     without holding a gateway API key (matches v0.2's open feed model).
 *     Public allowlist additions live in middleware/api-gate.ts.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getCourierJobsStore } from "../services/courier-jobs-store.js";

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

const VALID_EVENT_TYPES = new Set(["pickup", "delivered", "cancelled", "note"]);

export async function courierJobsRoutes(app: FastifyInstance) {
  // ── v0.2 compatibility aliases ───────────────────────────────────────────
  // pcc-courier's `manual.ts` broadcasts to `${COURIER_JOBS_URL}/jobs`.
  // Setting COURIER_JOBS_URL=https://<gateway>/api/courier-jobs makes the
  // alias resolve to /api/courier-jobs/jobs — same handler as POST /
  // The /open + /:id GETs mirror v0.2 paths too so legacy driver agents work.
  const aliasCreate = "/api/courier-jobs/jobs";
  const aliasOpen = "/api/courier-jobs/jobs/open";
  const aliasDetail = "/api/courier-jobs/jobs/:id";

  // ── GET /api/courier-jobs/healthz ───────────────────────────────────────
  app.get("/api/courier-jobs/healthz", async () => {
    const store = getCourierJobsStore();
    return {
      ok: true,
      service: "courier-jobs (folded into pcc gateway)",
      jobs: store.size(),
      open: store.countByStatus("open"),
      expired: store.countByStatus("expired"),
      claimed: store.countByStatus("claimed"),
      in_transit: store.countByStatus("in_transit"),
      delivered: store.countByStatus("delivered"),
      cancelled: store.countByStatus("cancelled"),
      ts: new Date().toISOString(),
    };
  });

  // ── POST /api/courier-jobs ──────────────────────────────────────────────
  app.post<{
    Body: {
      deliveryId?: string;
      pickup?: Record<string, unknown>;
      dropoff?: Record<string, unknown>;
      pickupReadyAt?: string;
      feeUSD?: number;
      tipUSD?: number;
      externalRef?: string;
      description?: string;
      raw?: unknown;
      sourceVerifyUrl?: string;
      requireHeartbeat?: boolean;
    };
  }>("/api/courier-jobs", async (req, reply) => {
    const b = req.body || {};
    if (!b.deliveryId || !b.pickup || !b.dropoff) {
      return reply.code(400).send({
        error: "missing_fields",
        required: ["deliveryId", "pickup", "dropoff"],
      });
    }
    const poster = resolvePoster(req);
    const store = getCourierJobsStore();
    const result = await store.create({
      deliveryId: b.deliveryId,
      pickup: b.pickup,
      dropoff: b.dropoff,
      pickupReadyAt: b.pickupReadyAt ?? null,
      feeUSD: typeof b.feeUSD === "number" ? b.feeUSD : null,
      tipUSD: typeof b.tipUSD === "number" ? b.tipUSD : null,
      externalRef: b.externalRef ?? null,
      description: b.description ?? null,
      raw: b.raw ?? null,
      sourceVerifyUrl: b.sourceVerifyUrl ?? null,
      requireHeartbeat: !!b.requireHeartbeat,
      postedBy: poster,
    });
    if (!result.ok) {
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
        id: result.job.id,
        status: result.job.status,
        note: "already posted",
      });
    }
    return reply.code(201).send({
      ok: true,
      id: result.job.id,
      status: result.job.status,
      verified: result.job.verified,
      validUntil: result.job.validUntil,
      feedUrl: "/api/courier-jobs/open",
    });
  });

  // ── GET /api/courier-jobs/open ──────────────────────────────────────────
  app.get<{
    Querystring: {
      verified?: string;
      minFeeUSD?: string;
      maxFeeUSD?: string;
      within?: string;
    };
  }>("/api/courier-jobs/open", async (req) => {
    const q = req.query || {};
    let within: { lat: number; lng: number; miles: number } | null = null;
    if (q.within) {
      const parts = String(q.within).split(",").map((s) => Number(s.trim()));
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        within = { lat: parts[0]!, lng: parts[1]!, miles: parts[2]! };
      }
    }
    const minFee = q.minFeeUSD != null ? Number(q.minFeeUSD) : null;
    const maxFee = q.maxFeeUSD != null ? Number(q.maxFeeUSD) : null;
    const store = getCourierJobsStore();
    const open = store.listOpen({
      verified: q.verified === "true",
      minFeeUSD: minFee != null && Number.isFinite(minFee) ? minFee : null,
      maxFeeUSD: maxFee != null && Number.isFinite(maxFee) ? maxFee : null,
      within,
    });
    return { jobs: open, count: open.length, ts: new Date().toISOString() };
  });

  // ── GET /api/courier-jobs/:id ───────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/courier-jobs/:id", async (req, reply) => {
    const store = getCourierJobsStore();
    const j = store.get(req.params.id);
    if (!j) return reply.code(404).send({ error: "not_found" });
    return { job: j, events: store.getEvents(j.id) };
  });

  // ── POST /api/courier-jobs/:id/claim ────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { driverAgent?: string; etaMin?: number; contact?: string };
  }>("/api/courier-jobs/:id/claim", async (req, reply) => {
    const b = req.body || {};
    if (!b.driverAgent) {
      return reply.code(400).send({ error: "missing_field", required: ["driverAgent"] });
    }
    const store = getCourierJobsStore();
    const result = await store.claim(req.params.id, {
      driverAgent: b.driverAgent,
      etaMin: b.etaMin,
      contact: b.contact,
    });
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
    return { ok: true, job: (result as { ok: true; job: unknown }).job };
  });

  // ── POST /api/courier-jobs/:id/events ───────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { event?: string; driverAgent?: string; proof?: unknown; note?: string };
  }>("/api/courier-jobs/:id/events", async (req, reply) => {
    const b = req.body || {};
    if (!b.event || !VALID_EVENT_TYPES.has(b.event)) {
      return reply.code(400).send({
        error: "invalid_event",
        valid: [...VALID_EVENT_TYPES],
      });
    }
    const store = getCourierJobsStore();
    const result = store.recordEvent(
      req.params.id,
      b.event as "pickup" | "delivered" | "cancelled" | "note",
      b.driverAgent ?? null,
      b.proof ?? null,
      b.note ?? null,
    );
    if (!result.ok) return reply.code(404).send({ error: "not_found" });
    return { ok: true, status: result.status, event: result.event };
  });

  // ── PATCH /api/courier-jobs/:id ─────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: {
      pickupReadyAt?: string;
      feeUSD?: number;
      description?: string;
      validUntil?: string;
    };
  }>("/api/courier-jobs/:id", async (req, reply) => {
    const poster = requirePoster(req, reply);
    if (poster === null) return;
    const store = getCourierJobsStore();
    const result = store.patch(req.params.id, poster, req.body || {});
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.reason === "forbidden") {
        return reply.code(403).send({
          error: "forbidden",
          message: "You can only patch jobs you posted",
        });
      }
      if (result.reason === "not_editable") {
        return reply.code(409).send({
          error: "not_editable",
          currentStatus: result.currentStatus,
        });
      }
    }
    return { ok: true, job: (result as { ok: true; job: unknown }).job };
  });

  // ── DELETE /api/courier-jobs/:id ────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/courier-jobs/:id", async (req, reply) => {
    const poster = requirePoster(req, reply);
    if (poster === null) return;
    const store = getCourierJobsStore();
    const result = store.cancel(req.params.id, poster);
    if (!result.ok) {
      if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.reason === "forbidden") {
        return reply.code(403).send({
          error: "forbidden",
          message: "You can only cancel jobs you posted",
        });
      }
    }
    return { ok: true, status: (result as { ok: true; status: string }).status };
  });

  // ── POST /api/courier-jobs/:id/heartbeat ────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/api/courier-jobs/:id/heartbeat",
    async (req, reply) => {
      const poster = requirePoster(req, reply);
      if (poster === null) return;
      const store = getCourierJobsStore();
      const result = store.heartbeat(req.params.id, poster);
      if (!result.ok) {
        if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
        if (result.reason === "forbidden") {
          return reply.code(403).send({
            error: "forbidden",
            message: "You can only heartbeat jobs you posted",
          });
        }
      }
      return {
        ok: true,
        lastHeartbeatAt: (result as { ok: true; lastHeartbeatAt: string }).lastHeartbeatAt,
      };
    },
  );

  // ── v0.2 compat: /jobs aliases (pcc-courier broadcasts to this path) ────
  // pcc-courier's manual.ts appends `/jobs` to COURIER_JOBS_URL. Setting
  // that env to https://capability.network/api/courier-jobs (the gateway
  // base) makes the broadcast hit the alias below — zero client change.
  app.post<{
    Body: {
      deliveryId?: string;
      pickup?: Record<string, unknown>;
      dropoff?: Record<string, unknown>;
      pickupReadyAt?: string;
      feeUSD?: number;
      tipUSD?: number;
      externalRef?: string;
      description?: string;
      raw?: unknown;
      sourceVerifyUrl?: string;
      requireHeartbeat?: boolean;
    };
  }>(aliasCreate, async (req, reply) => {
    // Forward to the canonical create handler. Re-emit the same response shape.
    const b = req.body || {};
    if (!b.deliveryId || !b.pickup || !b.dropoff) {
      return reply.code(400).send({
        error: "missing_fields",
        required: ["deliveryId", "pickup", "dropoff"],
      });
    }
    const poster = resolvePoster(req);
    const store = getCourierJobsStore();
    const result = await store.create({
      deliveryId: b.deliveryId,
      pickup: b.pickup,
      dropoff: b.dropoff,
      pickupReadyAt: b.pickupReadyAt ?? null,
      feeUSD: typeof b.feeUSD === "number" ? b.feeUSD : null,
      tipUSD: typeof b.tipUSD === "number" ? b.tipUSD : null,
      externalRef: b.externalRef ?? null,
      description: b.description ?? null,
      raw: b.raw ?? null,
      sourceVerifyUrl: b.sourceVerifyUrl ?? null,
      requireHeartbeat: !!b.requireHeartbeat,
      postedBy: poster,
    });
    if (!result.ok) {
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
        id: result.job.id,
        status: result.job.status,
        note: "already posted",
      });
    }
    return reply.code(201).send({
      ok: true,
      id: result.job.id,
      status: result.job.status,
      verified: result.job.verified,
      validUntil: result.job.validUntil,
      feedUrl: "/api/courier-jobs/open",
    });
  });

  app.get<{
    Querystring: {
      verified?: string;
      minFeeUSD?: string;
      maxFeeUSD?: string;
      within?: string;
    };
  }>(aliasOpen, async (req) => {
    const q = req.query || {};
    let within: { lat: number; lng: number; miles: number } | null = null;
    if (q.within) {
      const parts = String(q.within).split(",").map((s) => Number(s.trim()));
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        within = { lat: parts[0]!, lng: parts[1]!, miles: parts[2]! };
      }
    }
    const minFee = q.minFeeUSD != null ? Number(q.minFeeUSD) : null;
    const maxFee = q.maxFeeUSD != null ? Number(q.maxFeeUSD) : null;
    const store = getCourierJobsStore();
    const open = store.listOpen({
      verified: q.verified === "true",
      minFeeUSD: minFee != null && Number.isFinite(minFee) ? minFee : null,
      maxFeeUSD: maxFee != null && Number.isFinite(maxFee) ? maxFee : null,
      within,
    });
    return { jobs: open, count: open.length, ts: new Date().toISOString() };
  });

  app.get<{ Params: { id: string } }>(aliasDetail, async (req, reply) => {
    const store = getCourierJobsStore();
    const j = store.get(req.params.id);
    if (!j) return reply.code(404).send({ error: "not_found" });
    return { job: j, events: store.getEvents(j.id) };
  });
}
