/**
 * Fastify preHandler hook for requiring authentication.
 *
 * Usage (on individual routes):
 *   app.get("/api/protected", { preHandler: [requireAuth] }, async (req) => {
 *     const address = req.userId; // ethereum address
 *   });
 *
 * Usage (on a route group/plugin):
 *   app.addHook("preHandler", requireAuth);
 *
 * The hook checks for a valid session via cookie or Bearer token.
 * If valid, `request.userId` is set to the authenticated ethereum address.
 * If invalid, returns 401.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { resolveSession } from "./siwe-auth.js";

// ---------------------------------------------------------------------------
// Augment Fastify's request type so `userId` is recognized
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    /** Authenticated ethereum address (set by requireAuth hook) */
    userId: `0x${string}` | null;
    /** API key ID (set by apiGate middleware) */
    apiKeyId: string | null;
    /** Operator identifier — email or wallet address (set by apiGate middleware) */
    operatorId: string | null;
  }
}

// ---------------------------------------------------------------------------
// preHandler hook
// ---------------------------------------------------------------------------

/**
 * Require authentication. Returns 401 if no valid session found.
 * On success, sets `request.userId` to the ethereum address.
 *
 * Accepts either:
 *   - SIWE session (cookie or Bearer <session-token>)
 *   - API key (Bearer pcc_live_... / pcc_test_...) already validated by apiGate
 *     (which sets `req.userId` before any preHandler runs)
 */
export async function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // apiGate (onRequest) may have already accepted an API key: it always sets
  // req.apiKeyId, and sets req.userId only when the key's operatorId is a wallet
  // address (C-02 review r2). An email-operator key therefore has apiKeyId set
  // but userId=null — key on EITHER so those callers stay authenticated.
  // Don't demand a SIWE session on top of a valid API key.
  if (req.userId || req.apiKeyId) return;

  const session = resolveSession(req);
  if (!session) {
    reply.status(401).send({ error: "Authentication required" });
    return;
  }
  req.userId = session.address;
}

/**
 * Optional auth — sets `request.userId` if a valid session exists,
 * but does NOT reject unauthenticated requests (userId will be null).
 * Use this for routes that work with or without auth.
 */
export async function optionalAuth(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const session = resolveSession(req);
  req.userId = session?.address ?? null;
}
