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

/** WP-A's fold (#326 `normalizeIdentity`): trimmed, lower-cased; null/undefined fold to "". */
function normalizeIdentity(id: unknown): string {
  return String(id ?? "").trim().toLowerCase();
}

/**
 * Identity comparison with WP-A's semantics: trimmed, case-insensitive, and
 * never true for an id that folds to empty, so a blank owner can't match a blank
 * actor. Swap to WP-A's `sameIdentity` once #326 merges (this PR merges after it).
 */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = normalizeIdentity(a);
  return x.length > 0 && x === normalizeIdentity(b);
}
