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
  /**
   * Opaque per-request id (Week 6 A2). Set when a settle path issued an
   * awaitable approval gate; the mobile client echoes this in the
   * approve/reject endpoint URL so we can route the user's decision to
   * the right pending gate.
   */
  approvalId?: string;
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

/**
 * Awaitable approval gate (Week 6 A2).
 *
 * Used by centralized-settle (and any other future caller that needs an
 * "are you sure?" hop before continuing). When a settle request lands for
 * a session that requires user approval, the caller calls
 * `awaitApprovalDecision(sessionId, { timeoutMs })` which returns a promise
 * that resolves with `{ decision: "approve" | "reject" }` once the user
 * acts via `POST /api/sessions/:sessionId/approval/:approvalId/{approve,reject}`.
 *
 * If the user does not act within the timeout, the promise rejects with an
 * `ApprovalTimeoutError`. The caller maps that to HTTP 408.
 */
interface PendingApprovalGate {
  approvalId: string;
  resolve: (decision: ApprovalDecision) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export type ApprovalDecision =
  | { decision: "approve"; at: string; signature?: string }
  | { decision: "reject"; at: string; reason?: string };

export class ApprovalTimeoutError extends Error {
  constructor(public readonly sessionId: string) {
    super(`Approval timeout for session ${sessionId}`);
    this.name = "ApprovalTimeoutError";
  }
}

interface ApprovalRequestState {
  /** Pending approvals keyed by sessionId. */
  bySession: Map<string, PendingApprovalRecord>;
  /**
   * Pending approval gates keyed by sessionId. Used by
   * `awaitApprovalDecision()` to block the centralized-settle flow until
   * the user POSTs an approve/reject. Only one gate per session at a time
   * — re-entry on a session with an existing gate is rejected with a
   * conflict.
   */
  gates: Map<string, PendingApprovalGate>;
}

// ── Singleton state ───────────────────────────────────────────────────

let state: ApprovalRequestState = {
  bySession: new Map(),
  gates: new Map(),
};

/** Test-only: wipe state between cases. */
export function _resetApprovalRequestStoreForTests(): void {
  // Clear any pending gates so timers don't leak across test files.
  for (const gate of state.gates.values()) {
    if (gate.timer) clearTimeout(gate.timer);
    try {
      gate.reject(new Error("test-reset"));
    } catch {
      /* swallow */
    }
  }
  state = {
    bySession: new Map(),
    gates: new Map(),
  };
}

/** Test-only: peek the pending approvals store. */
export function _peekApprovalRequestStoreForTests(): {
  pending: number;
  sessionIds: string[];
  gates: number;
} {
  return {
    pending: state.bySession.size,
    sessionIds: Array.from(state.bySession.keys()),
    gates: state.gates.size,
  };
}

/** Test-only: read a pending approval record. */
export function _getPendingApprovalForTests(
  sessionId: string,
): PendingApprovalRecord | null {
  return state.bySession.get(sessionId) ?? null;
}

/** Test-only: read the pending gate id (if any) for a session. */
export function _getApprovalGateIdForTests(
  sessionId: string,
): string | null {
  return state.gates.get(sessionId)?.approvalId ?? null;
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

/**
 * Default approval timeout in ms. Override via env `APPROVAL_TIMEOUT_MS`.
 * When the user does not act within this window the gate rejects and the
 * centralized-settle caller maps the rejection to HTTP 408.
 */
function getApprovalTimeoutMs(): number {
  const raw = process.env.APPROVAL_TIMEOUT_MS;
  if (!raw) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

/**
 * Generate a short opaque approval id. Returned in the publish response
 * + on the SSE event payload so the mobile client knows which approve/
 * reject endpoint to hit.
 */
function nextApprovalId(): string {
  // crypto.randomUUID is universal in modern Node + browser; fallback for
  // ancient runtimes.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return `appr_${g.crypto.randomUUID()}`;
  return `appr_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Block the caller until the user approves/rejects this session, or the
 * timeout fires. Used by centralized-settle to gate a settlement on user
 * confirmation.
 *
 * Behavior:
 *   - Creates a pending gate keyed by sessionId.
 *   - If a gate already exists for the session, returns a fresh promise
 *     attached to the SAME gate (idempotent under double-invocation —
 *     useful when a settle retry happens while the user is still deciding).
 *   - Cleans up timers + gate state in both resolve and reject paths.
 *
 * Returns the approvalId so the caller can include it in the publish
 * payload and on the response/event.
 */
export function awaitApprovalDecision(
  sessionId: string,
  opts: { approvalId: string; timeoutMs?: number },
): Promise<ApprovalDecision> {
  const timeoutMs = opts.timeoutMs ?? getApprovalTimeoutMs();

  // Idempotency: re-using an existing gate. This keeps double-invocation
  // safe (e.g. a network retry on the settle endpoint won't strand a
  // second timer).
  const existing = state.gates.get(sessionId);
  if (existing) {
    return new Promise<ApprovalDecision>((res, rej) => {
      // Wrap existing.resolve/reject so multiple awaiters get the answer.
      const prevResolve = existing.resolve;
      const prevReject = existing.reject;
      existing.resolve = (d) => {
        prevResolve(d);
        res(d);
      };
      existing.reject = (e) => {
        prevReject(e);
        rej(e);
      };
    });
  }

  return new Promise<ApprovalDecision>((res, rej) => {
    const gate: PendingApprovalGate = {
      approvalId: opts.approvalId,
      resolve: (decision) => {
        if (gate.timer) clearTimeout(gate.timer);
        state.gates.delete(sessionId);
        res(decision);
      },
      reject: (err) => {
        if (gate.timer) clearTimeout(gate.timer);
        state.gates.delete(sessionId);
        rej(err);
      },
      timer: setTimeout(() => {
        // Timer fired before the user acted: drop the gate + reject.
        state.gates.delete(sessionId);
        rej(new ApprovalTimeoutError(sessionId));
      }, timeoutMs),
    };
    state.gates.set(sessionId, gate);
  });
}

/**
 * Resolve a pending approval gate with an approve decision. Returns
 * `false` when no gate exists (caller maps to 404).
 */
export function resolveApprovalGate(
  sessionId: string,
  approvalId: string,
  decision: ApprovalDecision,
): "ok" | "not-found" | "wrong-id" {
  const gate = state.gates.get(sessionId);
  if (!gate) return "not-found";
  if (gate.approvalId !== approvalId) return "wrong-id";
  gate.resolve(decision);
  return "ok";
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

  /**
   * POST /api/sessions/:sessionId/approval/:approvalId/approve
   *
   * Resolves a pending approval gate (Week 6 A2). The mobile client hits
   * this from `ApprovalSheet`'s approve button after the user signs the
   * passkey assertion. The body is OPTIONAL — when present, it carries
   * the WebAuthn assertion / signed receipt for evidentiary purposes.
   *
   * Auth: same Bearer/cookie gate as the publish endpoint.
   *
   * Status codes:
   *   200 — gate resolved
   *   404 — no pending gate for that session
   *   409 — gate exists but approvalId mismatch (stale UI / replay)
   */
  app.post<{
    Params: { sessionId: string; approvalId: string };
    Body: { signature?: unknown };
  }>(
    "/api/sessions/:sessionId/approval/:approvalId/approve",
    async (req, reply: FastifyReply) => {
      const auth = resolvePublishAuth(req);
      if (!auth) {
        return reply.status(401).send({
          error: "unauthorized",
          message:
            "Authorization required: Bearer <api-key> or pcc_session cookie",
        });
      }
      const { sessionId, approvalId } = req.params;
      if (!isString(sessionId) || !isString(approvalId)) {
        return reply.status(400).send({
          error: "invalid_params",
          message: "sessionId and approvalId are required",
        });
      }
      const body = (req.body ?? {}) as { signature?: unknown };
      const signature =
        typeof body.signature === "string" ? body.signature : undefined;
      const decision: ApprovalDecision = {
        decision: "approve",
        at: new Date().toISOString(),
        ...(signature ? { signature } : {}),
      };
      const result = resolveApprovalGate(sessionId, approvalId, decision);
      if (result === "not-found") {
        return reply.status(404).send({
          error: "approval_not_found",
          message: `No pending approval for session ${sessionId}`,
        });
      }
      if (result === "wrong-id") {
        return reply.status(409).send({
          error: "approval_id_mismatch",
          message: "approvalId does not match the pending gate",
        });
      }
      return reply.status(200).send({ ok: true, sessionId, approvalId });
    },
  );

  /**
   * POST /api/sessions/:sessionId/approval/:approvalId/reject
   *
   * Mirror of /approve — resolves the gate with a "reject" decision.
   */
  app.post<{
    Params: { sessionId: string; approvalId: string };
    Body: { reason?: unknown };
  }>(
    "/api/sessions/:sessionId/approval/:approvalId/reject",
    async (req, reply: FastifyReply) => {
      const auth = resolvePublishAuth(req);
      if (!auth) {
        return reply.status(401).send({
          error: "unauthorized",
          message:
            "Authorization required: Bearer <api-key> or pcc_session cookie",
        });
      }
      const { sessionId, approvalId } = req.params;
      if (!isString(sessionId) || !isString(approvalId)) {
        return reply.status(400).send({
          error: "invalid_params",
          message: "sessionId and approvalId are required",
        });
      }
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" ? body.reason : undefined;
      const decision: ApprovalDecision = {
        decision: "reject",
        at: new Date().toISOString(),
        ...(reason ? { reason } : {}),
      };
      const result = resolveApprovalGate(sessionId, approvalId, decision);
      if (result === "not-found") {
        return reply.status(404).send({
          error: "approval_not_found",
          message: `No pending approval for session ${sessionId}`,
        });
      }
      if (result === "wrong-id") {
        return reply.status(409).send({
          error: "approval_id_mismatch",
          message: "approvalId does not match the pending gate",
        });
      }
      return reply.status(200).send({ ok: true, sessionId, approvalId });
    },
  );
}

/**
 * Generate a fresh approvalId. Exposed so the centralized-settle route
 * can mint one before calling `awaitApprovalDecision()` and including it
 * in the publish payload.
 */
export function mintApprovalId(): string {
  return nextApprovalId();
}
