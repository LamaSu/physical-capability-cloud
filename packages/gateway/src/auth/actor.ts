/**
 * The authenticated principal behind a request, and identity comparison.
 *
 * Ownership checks must use the principal that authentication established,
 * the API key's operatorId or the SIWE session's userId, never a body field or
 * a header the caller can set to anything (board rule 7: an owner check fails
 * CLOSED on a missing actor).
 */

import type { FastifyRequest } from "fastify";

/** The authenticated principal, or null. Header- or body-asserted identities do not count. */
export function authenticatedActor(req: FastifyRequest): string | null {
  const r = req as unknown as { operatorId?: unknown; userId?: unknown };
  for (const candidate of [r.operatorId, r.userId]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

/** Identity comparison, trimmed and case-insensitive (the same normalization as WP-A). */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
