/**
 * Gate for the scaffold `_dev/*` write endpoints (WP-C R1).
 *
 * `POST /api/capabilities/graph/_dev/register-node`, `.../register-edge` and
 * `POST /api/compose/_dev/register-candidate` write straight into the tables
 * that graph-search and /api/compose select from. They were documented as
 * "gated behind apiGate in production", but apiGate only requires SOME key, so
 * any key could inject a node or candidate for any kernel at any claimed tier.
 *
 * Rule:
 *   - NODE_ENV exactly "test" or "development": open (tests and local dev
 *     rely on these endpoints);
 *   - anywhere else (production, staging, a typo, or NODE_ENV unset): the
 *     admin secret is required, `X-Admin-Key == PCC_ADMIN_KEY`, checked by the
 *     shared auth/admin-key.ts helper (constant-time). An unset PCC_ADMIN_KEY
 *     refuses (503); a missing header is 401; a wrong key is 403.
 *
 * This gate says WHETHER the endpoint may be used at all. Routes that name a
 * kernel must still require the actor to own it (auth/kernel-owner-guard.ts).
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { checkAdminKey } from "./admin-key.js";

/** True only for the exact NODE_ENV values in which scaffold endpoints are open. */
export function devEndpointsOpen(): boolean {
  const env = process.env.NODE_ENV;
  return env === "test" || env === "development";
}

/**
 * Returns true when the scaffold endpoint may run. Otherwise it has already
 * sent the refusal (the admin-key helper's status and error code).
 */
export function requireDevOrAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (devEndpointsOpen()) return true;
  const check = checkAdminKey(req);
  if (check.ok) return true;
  void reply.code(check.status).send({ error: check.error, message: check.message });
  return false;
}
