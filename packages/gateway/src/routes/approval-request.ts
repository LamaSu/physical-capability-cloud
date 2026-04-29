/**
 * Server-issued approval requests — Week 5.
 *
 * Replaces the Week 3 dev-mode fake trigger in `apps/mobile/src/App.tsx`
 * with a real publish endpoint that:
 *
 *   1. Persists a pending-approval record (in-memory v1, mirrors the
 *      Week 4 passkey store pattern — a future iteration can swap in a
 *      durable store without changing the wire shape).
 *   2. Publishes a `streamHub` event to the new `approval:<sessionId>`
 *      topic, which `topic-sse.ts` exposes at
 *      `GET /sse/stream/approval/:sessionId`.
 *
 * Auth:
 *   - The route requires Bearer or session-cookie auth (same machinery
 *     as the rest of the gateway). v1 doesn't enforce a tenant boundary
 *     beyond authentication — anyone with a valid token can request an
 *     approval for any session. Cross-session SSE isolation is handled
 *     by the per-session topic + the SSE auth check in topic-sse.ts.
 *
 * State:
 *   - Held in process-level singletons (this module is the owner).
 *   - For tests, call `_resetApprovalRequestStoreForTests()` to wipe
 *     between cases.
 *
 * Integration with centralized-settle (Week 6+ follow-up):
 *   - For v1 we expose this endpoint as a standalone capability the
 *     agent / orchestrator calls explicitly. Wiring it into the full
 *     centralized-settle flow (so a SettlementMode = "centralized"
 *     session that requires operator confirmation auto-publishes an
 *     approval-request before releasing) is left for Week 6 once the
 *     SettlementMode-per-capability matrix has been exercised end-to-end.
 *
 * Wire shape (server → mobile):
 *   {
 *     id: "session-...",            // session id (opaque)
 *     capability: "haircut",
 *     amountUsd: 32,
 *     operatorName: "Andre's Hair Salon",
 *     evidenceHash: "<hex sha256>",
 *     captureClass?: "tier-1-photo",
 *     kernelId?: "kernel-...",
 *     params?: { ... }              // capability-specific
 *   }
 *
 * That payload is the body of the `approval-request` SSE event. The
 * mobile listener stuffs it directly into `setPendingApproval(...)` —
 * the field set is a superset of the `ApprovalSession` interface so
 * extra fields (kernelId, params) are simply carried through.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { StreamTopic } from "@pcc/spec";
import { ids } from "@pcc/spec";
import { streamHub, type StreamEvent } from "../sse/stream-hub.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Wire-level approval request payload. Mirrors the mobile
 * `ApprovalSession` interface (apps/mobile/src/components/ApprovalSheet.tsx)
 * so the listener can pass it through unchanged.
 */
export interface ApprovalRequestPayload {
  id: string;
  capability: string;
  amountUsd: number;
  operatorName: string;
  evidenceHash: string;
  captureClass?: string;
  kernelId?: string;
  /** Optional capability-specific params. Carried through opaque. */
  params?: Record<string, unknown>;
  /** ISO-8601 of when the gateway created the request. */
  requestedAt: string;
}

interface PendingApprovalRecord {
  payload: ApprovalRequestPayload;
  /** Who created the request (for audit / idempotency in a later week). */
  createdByApiKeyId: string | null;
  createdByOperatorId: string | null;
  /** Was this request consumed by a verify call (Week 6+)? */
  consumed: boolean;
  /** Unix epoch ms — for sweep on access. */
  createdAtMs: number;
}

interface ApprovalRequestState {
  /** Pending approvals keyed by sessionId. */
  bySession: Map<string, PendingApprovalRecord>;
}

// ── Singleton state ───────────────────────────────────────────────────

let state: ApprovalRequestState = {
  bySession: new Map(),
};

/** Test-only: wipe state between cases. */
export function _resetApprovalRequestStoreForTests(): void {
  state = {
    bySession: new Map(),
  };
}

/** Test-only: peek the pending approvals store. */
export function _peekApprovalRequestStoreForTests(): {
  pending: number;
  sessionIds: string[];
} {
  return {
    pending: state.bySession.size,
    sessionIds: Array.from(state.bySession.keys()),
  };
}

/** Test-only: read a pending approval record. */
export function _getPendingApprovalForTests(
  sessionId: string,
): PendingApprovalRecord | null {
  return state.bySession.get(sessionId) ?? null;
}

// ── Public helpers (used by other route modules / future Week 6 wire-up) ──

/**
 * Publish an approval-request event programmatically. Used by both the
 * POST /api/sessions/:sessionId/request-approval route and (in Week 6+)
 * by the centralized-settle path when a session in `centralized` mode
 * requires operator confirmation.
 *
 * Returns the persisted record so callers can echo the requestedAt back
 * to their own response.
 */
export function publishApprovalRequest(
  payload: ApprovalRequestPayload,
  meta: {
    apiKeyId: string | null;
    operatorId: string | null;
  },
): PendingApprovalRecord {
  const record: PendingApprovalRecord = {
    payload,
    createdByApiKeyId: meta.apiKeyId,
    createdByOperatorId: meta.operatorId,
    consumed: false,
    createdAtMs: Date.now(),
  };
  state.bySession.set(payload.id, record);

  const topic: StreamTopic = { type: "approval", id: payload.id };
  const event: StreamEvent = {
    id: ids.stream(),
    type: "approval-request",
    timestamp: new Date().toISOString(),
    topic,
    payload,
  };
  streamHub.publish([topic], event);

  return record;
}

// ── Body schemas ──────────────────────────────────────────────────────

interface RequestApprovalBody {
  capability?: unknown;
  amountUsd?: unknown;
  operatorName?: unknown;
  evidenceHash?: unknown;
  captureClass?: unknown;
  kernelId?: unknown;
  params?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ── Auth helper ───────────────────────────────────────────────────────

/**
 * Resolve auth for the publish endpoint. We use the same dual mechanism
 * as the rest of the gateway: SIWE session cookie OR Authorization Bearer
 * (API key or session token). Returns null when no valid credential.
 */
function resolvePublishAuth(req: FastifyRequest): {
  apiKeyId: string | null;
  operatorId: string | null;
} | null {
  const session = resolveSession(req);
  if (session) {
    return { apiKeyId: null, operatorId: session.address };
  }
  const apiKey = resolveApiKey(req);
  if (apiKey) {
    return { apiKeyId: apiKey.id, operatorId: apiKey.operatorId ?? null };
  }
  return null;
}

// ── Routes ────────────────────────────────────────────────────────────

export async function approvalRequestRoutes(
  app: FastifyInstance,
): Promise<void> {
  /**
   * POST /api/sessions/:sessionId/request-approval
   *
   * Issue a pending approval request for a given session. Persists the
   * record + publishes an `approval-request` event to the
   * `approval:<sessionId>` SSE topic.
   *
   * Body: {capability, amountUsd, operatorName, evidenceHash,
   *        captureClass?, kernelId?, params?}
   *
   * Returns 201 with `{ ok: true, sessionId, requestedAt, subscriberCount }`.
   * `subscriberCount` is informational — it tells the caller how many SSE
   * subscribers actually received the event at publish time.
   */
  app.post<{
    Params: { sessionId: string };
    Body: RequestApprovalBody;
  }>(
    "/api/sessions/:sessionId/request-approval",
    async (req, reply: FastifyReply) => {
      const auth = resolvePublishAuth(req);
      if (!auth) {
        return reply
          .status(401)
          .send({
            error: "unauthorized",
            message:
              "Authorization required: Bearer <api-key> or pcc_session cookie",
          });
      }

      const { sessionId } = req.params;
      if (!isString(sessionId)) {
        return reply
          .status(400)
          .send({ error: "invalid_session_id", message: "sessionId is required" });
      }

      const body = (req.body ?? {}) as RequestApprovalBody;
      const {
        capability,
        amountUsd,
        operatorName,
        evidenceHash,
        captureClass,
        kernelId,
        params,
      } = body;

      if (
        !isString(capability) ||
        !isFiniteNumber(amountUsd) ||
        !isString(operatorName) ||
        !isString(evidenceHash)
      ) {
        return reply.status(400).send({
          error: "invalid_body",
          message:
            "capability (string), amountUsd (number), operatorName (string), evidenceHash (string) are required",
        });
      }
      if (amountUsd < 0) {
        return reply.status(400).send({
          error: "invalid_amount",
          message: "amountUsd must be non-negative",
        });
      }

      // Optional fields — type-check if present.
      if (captureClass !== undefined && !isString(captureClass)) {
        return reply.status(400).send({
          error: "invalid_capture_class",
          message: "captureClass must be a string when provided",
        });
      }
      if (kernelId !== undefined && !isString(kernelId)) {
        return reply.status(400).send({
          error: "invalid_kernel_id",
          message: "kernelId must be a string when provided",
        });
      }
      if (
        params !== undefined &&
        (typeof params !== "object" || params === null || Array.isArray(params))
      ) {
        return reply.status(400).send({
          error: "invalid_params",
          message: "params must be a plain object when provided",
        });
      }

      const requestedAt = new Date().toISOString();
      const payload: ApprovalRequestPayload = {
        id: sessionId,
        capability,
        amountUsd,
        operatorName,
        evidenceHash,
        ...(captureClass !== undefined ? { captureClass } : {}),
        ...(kernelId !== undefined ? { kernelId } : {}),
        ...(params !== undefined
          ? { params: params as Record<string, unknown> }
          : {}),
        requestedAt,
      };

      // Capture subscriber count BEFORE publish so the response reflects
      // who was actually live at the moment the request fired. (publish()
      // doesn't change subscriber count, but doing it before is robust to
      // any future shimming.)
      const topic: StreamTopic = { type: "approval", id: sessionId };
      const subscriberCount = streamHub.getSubscriberCount(topic);

      publishApprovalRequest(payload, {
        apiKeyId: auth.apiKeyId,
        operatorId: auth.operatorId,
      });

      return reply.status(201).send({
        ok: true,
        sessionId,
        requestedAt,
        subscriberCount,
      });
    },
  );
}
