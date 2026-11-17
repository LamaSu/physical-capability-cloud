import type { FastifyRequest } from "fastify";
import { countAdminKeyFields, hasSingleValidAdminKey } from "../middleware/relay-admin-gate.js";
import { getCallerScopes } from "../middleware/scope-checker.js";

/**
 * Posture's admin test (routes/admin-posture.ts:9-23), without its audit:
 * - More than one X-Admin-Key field is refused, without API-key fallback.
 * - Exactly one field requires hasSingleValidAdminKey and a value other than "*";
 *   a failing header never falls through to the API-key arm.
 * - No field requires apiKeyId and scopes including "admin" but excluding "*".
 * Logs nothing, writes nothing, and returns false on errors.
 */
export function isAdminCaller(req: FastifyRequest): boolean {
  try {
    const count = countAdminKeyFields(req);
    if (count > 1) return false;
    if (count === 1) {
      return hasSingleValidAdminKey(req) && req.headers["x-admin-key"] !== "*";
    }
    if (!req.apiKeyId) return false;
    const scopes = getCallerScopes(req);
    return scopes.includes("admin") && !scopes.includes("*");
  } catch {
    return false;
  }
}
