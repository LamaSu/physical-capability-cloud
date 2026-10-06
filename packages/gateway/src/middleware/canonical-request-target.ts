/**
 * The gateway's request-target guard (N105). Fastify's router (find-my-way, Fastify 4) does not route
 * the raw request target that every onRequest decision reads: it percent-decodes letters, digits and
 * the other unreserved characters in a static path segment ("/%61pi/kernels" routes /api/kernels),
 * treats ";" as a second query delimiter ("/api/contributors;/x" routes /api/contributors), drops a
 * "#..." suffix, and routes an absolute-form target ("http://host/api/kernels") by its path while
 * req.url keeps the scheme and host. apiGate's "/api/" test, scopeChecker's rule match and every other
 * prefix or pattern decision then judged a different path than the handler that runs, so a request
 * could skip authentication or a scope rule.
 *
 * rejectNonCanonicalTarget is the FIRST onRequest hook. It refuses all four forms with 400 before any
 * decision is made, so for every request that goes on, the raw path and the routed path agree on
 * every character and segment boundary a decision reads. Standard clients never send any of them:
 * encodeURIComponent and its peers never escape an unreserved character (RFC 3986 section 2.3), and a
 * client sends origin-form targets without a fragment (RFC 9112 section 3.2). Percent-escapes of
 * RESERVED characters (%40, %3A, %2F, ...) stay allowed: the router does not let them change a
 * prefix or split a segment. The query is not a path decision and is left alone.
 *
 * apiGate and scopeChecker apply the same predicate themselves too, so a request that reached them
 * without passing this hook (a re-ordered or missing registration) still fails closed.
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** A percent-escape of an unreserved character (RFC 3986 section 2.3): ALPHA, DIGIT, "-", ".", "_", "~". */
const ENCODED_UNRESERVED = /%(?:3[0-9]|4[1-9a-f]|5[0-9af]|6[1-9a-f]|7[0-9ae]|2[de])/i;

export type NonCanonicalReason = "not_origin_form" | "fragment" | "semicolon" | "encoded_unreserved";

/** Why `url` (req.url, the raw request target) is not canonical, or null when it is. */
export function nonCanonicalTargetReason(url: string): NonCanonicalReason | null {
  if (!url.startsWith("/")) return "not_origin_form";
  if (url.includes("#")) return "fragment";
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  if (path.includes(";")) return "semicolon";
  if (ENCODED_UNRESERVED.test(path)) return "encoded_unreserved";
  return null;
}

/** The one refusal for every non-canonical target. It names no rule, so it teaches a prober nothing. */
export const NON_CANONICAL_REFUSAL = {
  error: "bad_request",
  message: "The request target is not in canonical form.",
} as const;

/** The first onRequest hook: a non-canonical request target is refused before any decision is made. */
export async function rejectNonCanonicalTarget(req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> {
  if (nonCanonicalTargetReason(req.url) !== null) {
    return reply.status(400).send(NON_CANONICAL_REFUSAL);
  }
}
