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

/**
 * The compared form of an id: ASCII letters folded to lower case, and nothing
 * else changed. No Unicode case folding (U+212A KELVIN SIGN lower-cases to
 * ASCII "k" under String#toLowerCase) and no trimming (NBSP, BOM and other
 * padding), so a lookalike or padded id stays a different principal (cf. #461
 * HIGH 2). A non-string is "".
 */
function comparedIdentity(id: unknown): string {
  return typeof id === "string" ? id.replace(/[A-Z]/g, (c) => c.toLowerCase()) : "";
}

/**
 * Identity comparison: ASCII case-insensitive (emails and hex addresses), never
 * Unicode-folded or trimmed, and never true for a blank or whitespace-only id,
 * so a blank owner can't match a blank actor. Do not swap to WP-A's (#326)
 * `sameIdentity` while it folds with trim().toLowerCase().
 */
export function sameIdentity(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = comparedIdentity(a);
  return x.trim().length > 0 && x === comparedIdentity(b);
}
