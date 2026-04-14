/**
 * SSE Authentication helper.
 *
 * Resolves identity from three sources (checked in order):
 *   1. ?token= query param  — API key or SIWE session token (for EventSource, which
 *                             cannot send custom headers)
 *   2. pcc_session cookie   — SIWE session (same-origin dashboard, auto-sent by browser)
 *   3. Authorization: Bearer header — API key or SIWE session (pcc-node, server clients)
 *
 * Behavior is controlled by the SSE_AUTH_REQUIRED environment variable:
 *   - truthy ("true", "1", "yes")  → auth is enforced; unauthenticated requests get 401
 *   - falsy / unset                → auth is opt-in; all connections pass (backward compat)
 *
 * Sets req.userId / req.apiKeyId / req.operatorId as a side-effect when auth succeeds,
 * mirroring what api-gate.ts does for REST endpoints.
 */

import type { FastifyRequest } from "fastify";
import { resolveSession } from "../auth/siwe-auth.js";
import { resolveApiKey } from "../auth/api-key-auth.js";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

function isAuthRequired(): boolean {
  // Opt-in auth: unauthenticated connections pass unless SSE_AUTH_REQUIRED is
  // set to a truthy value. This matches the module-level docstring, the
  // documented default in CLAUDE.md (SSE_AUTH_REQUIRED default: false), and
  // the R3-04 security commit (which only tightened the ?token= query path).
  const val = process.env.SSE_AUTH_REQUIRED;
  if (!val) return false;
  return val === "true" || val === "1" || val === "yes";
}

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface SSEAuthResult {
  authenticated: boolean;
  userId?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

/**
 * Resolve SSE authentication from the incoming request.
 *
 * Returns { authenticated: true, userId } on success.
 * Returns { authenticated: false, reason } when auth is required but absent/invalid.
 * Returns { authenticated: true } (no userId) when SSE_AUTH_REQUIRED is not set.
 */
export async function resolveSSEAuth(req: FastifyRequest): Promise<SSEAuthResult> {
  // --- 1. ?token= query param (primary path for browser EventSource) ---
  // SECURITY: Query strings are logged by proxies/CDNs/access logs.
  // This path is intentionally LIMITED to short-lived SIWE session tokens.
  // Long-lived API keys (pcc_live_*) are REJECTED here — they must use
  // the Authorization header instead to avoid leaking into logs.
  const tokenParam = (req.query as Record<string, string>).token;
  if (tokenParam) {
    // Reject long-lived API keys in query string (logged leak risk)
    if (tokenParam.startsWith("pcc_live_") || tokenParam.startsWith("pcc_test_")) {
      return {
        authenticated: false,
        reason:
          "API keys must be passed via Authorization: Bearer header, not ?token= query string (logged leak risk). Use a SIWE session token instead for browser EventSource.",
      };
    }

    // Build a synthetic request with the token injected as Authorization header.
    const syntheticReq = {
      ...req,
      headers: { ...req.headers, authorization: `Bearer ${tokenParam}` },
    } as FastifyRequest;

    // Treat as SIWE session token (dashboard reconnect after cookie clears)
    const session = resolveSession(syntheticReq);
    if (session) {
      req.userId = session.address;
      return { authenticated: true, userId: session.address };
    }
  }

  // --- 2. Cookie (pcc_session) + Authorization Bearer header ---
  // resolveSession already checks both paths in one call.
  const session = resolveSession(req);
  if (session) {
    req.userId = session.address;
    return { authenticated: true, userId: session.address };
  }

  // --- 3. Authorization: Bearer header as API key ---
  // (resolveSession above already consumed a SIWE Bearer token; this catches API keys)
  const apiKey = resolveApiKey(req);
  if (apiKey) {
    req.apiKeyId = apiKey.id;
    req.operatorId = apiKey.operatorId ?? null;
    req.userId = (apiKey.operatorId as `0x${string}`) ?? null;
    return { authenticated: true, userId: apiKey.operatorId ?? undefined };
  }

  // --- No credentials found ---
  if (isAuthRequired()) {
    return {
      authenticated: false,
      reason:
        "SSE authentication required. Provide ?token=<api-key-or-session-token> " +
        "or ensure the pcc_session cookie is set.",
    };
  }

  // Auth not required — pass through (backward compat)
  return { authenticated: true };
}
