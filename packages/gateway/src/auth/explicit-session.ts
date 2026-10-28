import type { FastifyRequest } from "fastify";
import { hasSingleValidAdminKey } from "../middleware/relay-admin-gate.js";
import { resolveSession } from "./siwe-auth.js";

const EXPLICIT_SESSION_REQUIRED = {
  error: "session_required",
  message: "An explicit bearer session is required to create or delegate credentials.",
} as const;

/** Credential writes may use a session only when its matching bearer is explicit. */
export function refuseCookieCredentialWrite(req: FastifyRequest): typeof EXPLICIT_SESSION_REQUIRED | null {
  if (req.apiKeyId != null || hasSingleValidAdminKey(req)) return null;
  if (!req.cookies?.pcc_session && !req.headers.authorization?.startsWith("Bearer ")) return null;
  const session = resolveSession(req);
  return session && req.headers.authorization !== `Bearer ${session.token}`
    ? EXPLICIT_SESSION_REQUIRED
    : null;
}
