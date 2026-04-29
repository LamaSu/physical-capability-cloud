/**
 * Subscription routes — Week 6 A3: decouple channel-id from session-token.
 *
 * Why this exists:
 *   For Week 5 the mobile listener used the persisted Week-4 passkey
 *   session token AS the SSE channel id (i.e. it subscribed to the
 *   `approval:<sessionToken>` topic). That kept day-1 plumbing trivial,
 *   but blends two concerns:
 *
 *     - the session token is the bearer credential for authenticated
 *       calls to the gateway
 *     - the channel id is a routing key that says "publish events
 *       intended for this client to that topic"
 *
 *   With the two collapsed:
 *     - rotating the session token forces every consumer (e.g. an agent
 *       acting on the user's behalf) to re-learn the channel id
 *     - logging or persisting the channel-id risks logging the auth
 *       credential
 *
 * What this route does:
 *   POST /api/sessions/:sessionId/subscribe
 *     Auth: Bearer <session-token> (or any pcc auth credential)
 *     Body: optional { ttlSeconds?: number }
 *     Returns: { channelId, sessionId, expiresAt? }
 *
 *   The channelId is a fresh 32-byte base64url-encoded opaque id, stored
 *   in an in-memory map (channelId → sessionId). Publishers downstream
 *   (centralized-settle / publishApprovalRequest) look up the channelId
 *   by sessionId and publish to `approval:<channelId>` when found,
 *   falling back to `approval:<sessionId>` when no subscription exists.
 *   That fallback preserves the W5 token-as-channel-id behavior so the
 *   mobile keeps working without a flag day.
 *
 * Storage:
 *   In-memory; this is per-process. A future iteration can swap to
 *   Redis without changing the wire shape. Use the test-only reset
 *   helper between tests.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { resolveSession } from "../auth/siwe-auth.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

interface SubscriptionRecord {
  channelId: string;
  sessionId: string;
  createdAtMs: number;
  /** Optional epoch ms TTL. Null when not used. */
  expiresAtMs: number | null;
  createdByApiKeyId: string | null;
  createdByOperatorId: string | null;
}

interface SubscriptionState {
  /** Map of sessionId → record. Latest wins on re-subscribe. */
  bySession: Map<string, SubscriptionRecord>;
  /** Map of channelId → sessionId. Reverse lookup for publishers. */
  byChannel: Map<string, string>;
}

let state: SubscriptionState = {
  bySession: new Map(),
  byChannel: new Map(),
};

// ── Test-only helpers ─────────────────────────────────────────────────

export function _resetSubscriptionStoreForTests(): void {
  state = { bySession: new Map(), byChannel: new Map() };
}

export function _peekSubscriptionsForTests(): {
  bySession: number;
  byChannel: number;
} {
  return { bySession: state.bySession.size, byChannel: state.byChannel.size };
}

// ── Public lookup API for publishers ──────────────────────────────────

/**
 * Resolve the channelId for a session, if a subscription exists. Returns
 * null when no subscription is registered — publishers fall back to
 * publishing on `approval:<sessionId>` for W5 backward-compat.
 */
export function getChannelIdForSession(sessionId: string): string | null {
  const record = state.bySession.get(sessionId);
  if (!record) return null;
  if (record.expiresAtMs !== null && record.expiresAtMs < Date.now()) {
    // Expired — sweep on access.
    state.bySession.delete(sessionId);
    state.byChannel.delete(record.channelId);
    return null;
  }
  return record.channelId;
}

/** Reverse lookup — useful for diagnostics. */
export function getSessionIdForChannel(channelId: string): string | null {
  return state.byChannel.get(channelId) ?? null;
}

// ── Auth helper (mirrors approval-request.ts) ─────────────────────────

function resolveSubscribeAuth(req: FastifyRequest): {
  apiKeyId: string | null;
  operatorId: string | null;
} | null {
  const session = resolveSession(req);
  if (session) return { apiKeyId: null, operatorId: session.address };
  const apiKey = resolveApiKey(req);
  if (apiKey) {
    return { apiKeyId: apiKey.id, operatorId: apiKey.operatorId ?? null };
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────

interface SubscribeBody {
  ttlSeconds?: unknown;
}

export async function subscriptionRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * POST /api/sessions/:sessionId/subscribe
   *
   * Mints a fresh channelId for a session. Auth-gated; responds 401 on
   * missing/invalid credential. Subsequent calls for the same sessionId
   * REPLACE the prior channelId (the prior one becomes orphaned and is
   * eventually evicted from the byChannel map at this call). The mobile
   * client should call this once on app boot after passkey-verify.
   */
  app.post<{
    Params: { sessionId: string };
    Body: SubscribeBody;
  }>(
    "/api/sessions/:sessionId/subscribe",
    async (req, reply: FastifyReply) => {
      const auth = resolveSubscribeAuth(req);
      if (!auth) {
        return reply.status(401).send({
          error: "unauthorized",
          message:
            "Authorization required: Bearer <api-key> or pcc_session cookie",
        });
      }
      const { sessionId } = req.params;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return reply.status(400).send({
          error: "invalid_session_id",
          message: "sessionId is required",
        });
      }

      const body = (req.body ?? {}) as SubscribeBody;
      let expiresAtMs: number | null = null;
      if (body.ttlSeconds !== undefined) {
        if (
          typeof body.ttlSeconds !== "number" ||
          !Number.isFinite(body.ttlSeconds) ||
          body.ttlSeconds <= 0
        ) {
          return reply.status(400).send({
            error: "invalid_ttl",
            message: "ttlSeconds must be a positive number when provided",
          });
        }
        expiresAtMs = Date.now() + Math.floor(body.ttlSeconds * 1000);
      }

      // Evict prior record for this session (if any).
      const prior = state.bySession.get(sessionId);
      if (prior) state.byChannel.delete(prior.channelId);

      const channelId = randomBytes(32).toString("base64url");
      const record: SubscriptionRecord = {
        channelId,
        sessionId,
        createdAtMs: Date.now(),
        expiresAtMs,
        createdByApiKeyId: auth.apiKeyId,
        createdByOperatorId: auth.operatorId,
      };
      state.bySession.set(sessionId, record);
      state.byChannel.set(channelId, sessionId);

      return reply.status(201).send({
        channelId,
        sessionId,
        ...(expiresAtMs !== null
          ? { expiresAt: new Date(expiresAtMs).toISOString() }
          : {}),
      });
    },
  );
}
