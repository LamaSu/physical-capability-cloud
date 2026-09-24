/**
 * The admin SECRET as the gate on privileged handlers (WP-A round 5; coord-watch
 * #2883, board N2 / MUST-CLOSE 9).
 *
 * Privileged effects used to be granted to whoever's key carried an operatorId on
 * an env allowlist (AUDIT_ADMINS, PCC_DEMAND_ADMINS, PCC_OBSERVABILITY_ADMINS,
 * PCC_TOOL_INDEX_ADMINS, PCC_AGGREGATOR_ADMINS). An operatorId is something a
 * caller SAYS (the email path asserts it), and a key minted for an allowlisted
 * identity before identity binding still carries it. The secret is something a
 * caller HOLDS. These handlers now require `X-Admin-Key` = `PCC_ADMIN_KEY`
 * (checkAdminKey: constant time, fail closed outside test/development), and the
 * allowlists grant nothing. They stay reserved from self-service claims
 * (auth/reserved-identities.ts).
 *
 * Kept separate from auth/admin-key.ts, which is byte-identical across WP-A and
 * WP-C.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import { checkAdminKey, ADMIN_KEY_HEADER } from "./admin-key.js";

/** True when the admin secret checks out; otherwise sends its 401/403/503 and returns false. */
export function requireAdminSecret(req: FastifyRequest, reply: FastifyReply): boolean {
  const check = checkAdminKey(req);
  if (check.ok) return true;
  void reply.status(check.status).send({ error: check.error, message: check.message });
  return false;
}

/** True when the request PRESENTS an admin secret (valid or not). Absent means "not asking for admin". */
export function presentsAdminSecret(req: FastifyRequest): boolean {
  return req.headers[ADMIN_KEY_HEADER] !== undefined;
}
