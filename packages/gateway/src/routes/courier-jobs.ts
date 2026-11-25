/**
 * Courier-jobs routes — BACKWARD-COMPAT SHIM over the generic /api/job-offers/* surface.
 *
 * This file used to host xray's standalone fold of pcc-courier-jobs v0.2.
 * The handlers below still live at /api/courier-jobs/* but their implementation
 * now delegates to the courier-jobs-store SHIM (services/courier-jobs-store.ts),
 * which in turn delegates to the generic JobOffersStore. The route paths and
 * response shapes are PRESERVED so pcc-courier and other v0.2 callers continue
 * to work unchanged.
 *
 * Migration: pcc-courier should switch to posting at /api/job-offers natively
 * (capability_type = "courier.dispatch", requirements: {pickup, dropoff, ...}).
 * Once that lands, this file and routes are deprecated. Tracker:
 * docs/JOB_OFFERS.md migration section. Target window: 30 days.
 *
 * Original surface (mirror of v0.2, preserved):
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
 *   POST   /api/courier-jobs/jobs               — v0.2 alias (pcc-courier broadcasts here)
 *   GET    /api/courier-jobs/jobs/open          — v0.2 alias
 *   GET    /api/courier-jobs/jobs/:id           — v0.2 alias
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { isAdminCaller } from "../auth/admin-caller.js";
import { offerCaller } from "../services/job-offer-event-rules.js";
import { publicCourierJob, publicEvent, publicEvents, publicViewCourierJob, publicViewEvents } from "../services/job-offer-public.js";
import { getCourierJobsStore, type CourierJob } from "../services/courier-jobs-store.js";

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

const MISSING_IDENTITY = {
  error: "missing_identity",
  message: "This action needs your API key or a wallet sign-in.",
};

const VALID_EVENT_TYPES = new Set(["pickup", "delivered", "cancelled", "note"]);

interface CourierCreateBody {
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
}

async function handleCreate(
  req: FastifyRequest<{ Body: CourierCreateBody }>,
  reply: FastifyReply,
) {
  const b = req.body || {};
  if (!b.deliveryId || !b.pickup || !b.dropoff) {
    return reply.code(400).send({
      error: "missing_fields",
      required: ["deliveryId", "pickup", "dropoff"],
    });
  }
  const caller = offerCaller(req);
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
  }, caller);
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
}

interface CourierOpenQuery {
  verified?: string;
  minFeeUSD?: string;
  maxFeeUSD?: string;
  within?: string;
}

async function handleListOpen(req: FastifyRequest<{ Querystring: CourierOpenQuery }>) {
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
  return { jobs: open.map(publicViewCourierJob), count: open.length, ts: new Date().toISOString() };
}

async function handleGetById(req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  const store = getCourierJobsStore();
  const j = store.get(req.params.id);
  if (!j) return reply.code(404).send({ error: "not_found" });
  const party = isAdminCaller(req) || store.isParty(j.id, offerCaller(req));
  return party
    ? { job: publicCourierJob(j), events: publicEvents(store.getEvents(j.id)) }
    : { job: publicViewCourierJob(j), events: publicViewEvents(store.getEvents(j.id)) };
}

export async function courierJobsRoutes(app: FastifyInstance) {
  const aliasCreate = "/api/courier-jobs/jobs";
  const aliasOpen = "/api/courier-jobs/jobs/open";
  const aliasDetail = "/api/courier-jobs/jobs/:id";

  // ── GET /api/courier-jobs/healthz ───────────────────────────────────────
  app.get("/api/courier-jobs/healthz", async () => {
    const store = getCourierJobsStore();
    return {
      ok: true,
      service: "courier-jobs (v0.2 shim over generic job-offers)",
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
  app.post<{ Body: CourierCreateBody }>("/api/courier-jobs", handleCreate);

  // ── GET /api/courier-jobs/open ──────────────────────────────────────────
  app.get<{ Querystring: CourierOpenQuery }>("/api/courier-jobs/open", handleListOpen);

  // ── GET /api/courier-jobs/:id ───────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/courier-jobs/:id", handleGetById);

  // ── POST /api/courier-jobs/:id/claim ────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: { driverAgent?: string; etaMin?: number; contact?: string };
  }>("/api/courier-jobs/:id/claim", async (req, reply) => {
    const b = req.body || {};
    if (!b.driverAgent) {
      return reply.code(400).send({ error: "missing_field", required: ["driverAgent"] });
    }
    const caller = offerCaller(req);
    if (caller === null) return reply.code(401).send(MISSING_IDENTITY);
    const store = getCourierJobsStore();
    const result = await store.claim(req.params.id, {
      driverAgent: b.driverAgent,
      etaMin: b.etaMin,
      contact: b.contact,
    }, caller);
    if (!result.ok) {
      if (result.reason === "missing_identity") return reply.code(401).send(MISSING_IDENTITY);
      if (result.reason === "not_found") return reply.code(404).send({ error: "not_found" });
      if (result.reason === "not_open") {
        return reply.code(409).send({
          error: "not_open",
          currentStatus: result.currentStatus,
          claimedBy: result.claimedBy,
        });
      }
    }
    return { ok: true, job: publicCourierJob((result as { ok: true; job: CourierJob }).job) };
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
    const caller = offerCaller(req);
    const eventKind = b.event;
    const store = getCourierJobsStore();
    const result = store.recordEvent(
      req.params.id,
      b.event as "pickup" | "delivered" | "cancelled" | "note",
      caller,
      b.proof ?? null,
      b.note ?? null,
    );
    if (!result.ok) {
      switch (result.reason) {
        case "reserved_event":
          return reply.code(400).send({ error: "reserved_event", event: eventKind });
        case "missing_identity":
          return reply.code(401).send(MISSING_IDENTITY);
        case "not_found":
          return reply.code(404).send({ error: "not_found" });
        case "not_participant":
          return reply.code(403).send({
            error: "not_participant",
            need: result.need,
            message: result.need === "claimer"
              ? "Only the offer's claimer may send this event."
              : result.need === "poster"
                ? "Only the offer's poster may send this event."
                : "Only the offer's poster or its claimer may send events.",
          });
        case "invalid_transition":
          return reply.code(409).send({
            error: "invalid_transition",
            event: eventKind,
            currentStatus: result.currentStatus,
          });
      }
    }
    return { ok: true, status: result.status, event: publicEvent(result.event) };
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
    const caller = offerCaller(req);
    if (caller === null) return reply.code(401).send(MISSING_IDENTITY);
    const store = getCourierJobsStore();
    const result = store.patch(req.params.id, caller, req.body || {});
    if (!result.ok) {
      if (result.reason === "missing_identity") return reply.code(401).send(MISSING_IDENTITY);
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
    return { ok: true, job: publicCourierJob((result as { ok: true; job: CourierJob }).job) };
  });

  // ── DELETE /api/courier-jobs/:id ────────────────────────────────────────
  app.delete<{ Params: { id: string } }>("/api/courier-jobs/:id", async (req, reply) => {
    const caller = offerCaller(req);
    if (caller === null) return reply.code(401).send(MISSING_IDENTITY);
    const store = getCourierJobsStore();
    const result = store.cancel(req.params.id, caller);
    if (!result.ok) {
      if (result.reason === "missing_identity") return reply.code(401).send(MISSING_IDENTITY);
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
      const caller = offerCaller(req);
      if (caller === null) return reply.code(401).send(MISSING_IDENTITY);
      const store = getCourierJobsStore();
      const result = store.heartbeat(req.params.id, caller);
      if (!result.ok) {
        if (result.reason === "missing_identity") return reply.code(401).send(MISSING_IDENTITY);
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

  // ── v0.2 /jobs aliases (pcc-courier's manual.ts broadcasts to /jobs) ────
  app.post<{ Body: CourierCreateBody }>(aliasCreate, handleCreate);
  app.get<{ Querystring: CourierOpenQuery }>(aliasOpen, handleListOpen);
  app.get<{ Params: { id: string } }>(aliasDetail, handleGetById);
}
