/**
 * External Demand-Intent Ingest — Phase 2.1
 *
 * Today PCC captures intent at its OWN /api/* surface (Phase 1: requests,
 * negotiate, query). This endpoint captures intent for agents that act
 * EXTERNALLY — Amazon, DoorDash, custom MCPs, etc. — by exposing a public
 * ingest URL their MCP brokers / SDKs can POST DemandEnvelopes to.
 *
 * Hard rules:
 *   - Auth required (API key Bearer token; operatorId pinned to the key).
 *   - Per-operator rate limit (600 / minute = 10/sec sustained + surge).
 *   - Idempotency-Key header is honored — replays within IDEMPOTENCY_TTL_MS
 *     return the cached response, never re-emit the event.
 *   - Envelope is validated server-side against DemandEnvelopeSchema. The
 *     ingest layer is thin and never trusts client framing.
 *   - Emits an `intent.external_ingest` analytics event so the existing
 *     demand-intel aggregator folds external intents into the same snapshots
 *     as internal ones (composition signature does the deduping).
 *
 * Endpoint:
 *   POST /api/intents/ingest
 *     Body: DemandEnvelope (validated)
 *     Headers:
 *       Authorization: Bearer <pcc-api-key>
 *       Idempotency-Key: <optional> opaque client-chosen string
 *     Response 202:
 *       { accepted: true, envelopeId, dedupeKey }
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { DemandEnvelopeSchema, type DemandEnvelope } from "@pcc/spec";
import { getEventBus } from "../services/event-bus.js";
import { checkCallerRate } from "../middleware/security-hardening.js";

// ── Config ────────────────────────────────────────────────────────────────

/** TTL for idempotent replays. Mirrors the global IDEMPOTENCY_TTL_MS env var. */
const TTL_MS =
  parseInt(process.env.IDEMPOTENCY_TTL_MS ?? "", 10) || 24 * 60 * 60 * 1000;

/** Cleanup expired idempotency entries every 5 minutes. */
const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

/** 600 ingests per operator per minute (10/sec sustained + small surge). */
const RATE_LIMIT_PER_MIN = 600;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ── In-memory idempotency cache ───────────────────────────────────────────

interface CachedIngest {
  envelopeId: string;
  dedupeKey: string;
  expiresAt: number; // epoch ms
}

/** Key = `${operatorId}:${idempotencyKey}` — isolated per operator. */
const idemCache = new Map<string, CachedIngest>();

function buildIdemKey(operatorId: string, key: string): string {
  return `${operatorId}:${key}`;
}

function pruneIdemCache(): void {
  const now = Date.now();
  for (const [k, v] of idemCache) {
    if (v.expiresAt <= now) idemCache.delete(k);
  }
}

/** Test helper — wipe the cache between tests. */
export function _clearIntentIngestCacheForTesting(): void {
  idemCache.clear();
}

/** Test helper — current cache size. */
export function _getIntentIngestCacheSizeForTesting(): number {
  return idemCache.size;
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Resolve operatorId attached by apiGate. Returns null if no auth context. */
function getOperatorId(req: FastifyRequest): string | null {
  const opId = (req as unknown as { operatorId?: string }).operatorId;
  return typeof opId === "string" && opId.length > 0 ? opId : null;
}

/**
 * Best-effort intent.external_ingest emission. Event-bus failures must NEVER
 * break the ingest call — telemetry is best-effort and can be replayed from
 * analytics_events if needed.
 */
function emitExternalIngest(envelope: DemandEnvelope, operatorId: string): void {
  try {
    getEventBus().publish({
      eventType: "intent.external_ingest",
      category: "intent",
      actorId: operatorId,
      actorType: "agent",
      resourceType: "intent",
      resourceId: envelope.id,
      payload: envelope as unknown as Record<string, unknown>,
    });
  } catch {
    // Swallow — non-fatal.
  }
}

// ── Route plugin ──────────────────────────────────────────────────────────

export async function intentIngestRoutes(app: FastifyInstance): Promise<void> {
  // Periodic prune of the in-memory idempotency cache.
  const pruneTimer = setInterval(pruneIdemCache, PRUNE_INTERVAL_MS);
  if (pruneTimer.unref) pruneTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
  });

  app.post("/api/intents/ingest", async (req: FastifyRequest, reply: FastifyReply) => {
    // ── 1. Auth gate (apiGate normally sets req.operatorId before we run,
    //      but defensive double-check protects against mis-registration). ──
    const operatorId = getOperatorId(req);
    if (!operatorId) {
      return reply.status(401).send({
        error: "authentication_required",
        message:
          "POST /api/intents/ingest requires a PCC API key (Authorization: Bearer pcc_live_...).",
      });
    }

    // ── 2. Rate limit (per-operator, 600/min). ─────────────────────────
    if (
      !checkCallerRate(
        operatorId,
        "intent_ingest",
        RATE_LIMIT_PER_MIN,
        RATE_LIMIT_WINDOW_MS,
      )
    ) {
      reply.header("Retry-After", "60");
      return reply.status(429).send({
        error: "rate_limited",
        message: `intent ingest is capped at ${RATE_LIMIT_PER_MIN}/minute per operator`,
      });
    }

    // ── 3. Validate envelope. ──────────────────────────────────────────
    const parsed = DemandEnvelopeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_envelope",
        message: "Request body did not match DemandEnvelope schema",
        details: parsed.error.flatten(),
      });
    }
    const envelope = parsed.data as DemandEnvelope;

    // ── 4. Idempotency replay check. ───────────────────────────────────
    const rawKey = req.headers["idempotency-key"];
    const idemKey =
      typeof rawKey === "string" && rawKey.length > 0 ? rawKey : null;

    if (idemKey) {
      const cacheKey = buildIdemKey(operatorId, idemKey);
      const existing = idemCache.get(cacheKey);
      if (existing && existing.expiresAt > Date.now()) {
        reply.header("Idempotency-Replayed", "true");
        return reply.status(202).send({
          accepted: true,
          envelopeId: existing.envelopeId,
          dedupeKey: existing.dedupeKey,
        });
      }
    }

    // ── 5. Emit event + persist idempotency record. ────────────────────
    emitExternalIngest(envelope, operatorId);

    // dedupeKey collapses repeated ingestions of the same composition by the
    // same operator into one analytical bucket for the aggregator.
    const dedupeKey = `${operatorId}:${envelope.compositionSignature}`;

    if (idemKey) {
      idemCache.set(buildIdemKey(operatorId, idemKey), {
        envelopeId: envelope.id,
        dedupeKey,
        expiresAt: Date.now() + TTL_MS,
      });
    }

    return reply.status(202).send({
      accepted: true,
      envelopeId: envelope.id,
      dedupeKey,
    });
  });
}
