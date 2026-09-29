/**
 * Shared route-path normalization for the auth + scope middleware.
 *
 * Both api-gate (authN) and scope-checker (authZ) must decide about the SAME path
 * the router will actually dispatch to. find-my-way percent-decodes unreserved
 * characters before it matches, so the raw request line and the matched route can
 * differ — `POST /api/%73ettlement/flush` runs the settlement handler while
 * `req.url` still reads `/api/%73ettlement/...`. Basing a security decision on
 * `req.url` therefore lets an encoded path evade the gate while still executing the
 * real handler (cross-family review of #309, finding H1: it bypassed BOTH authN and
 * the money-scope check).
 *
 * `authPath` returns the matched route template (`routeOptions.url`, e.g.
 * "/api/escrow/:id/release") — exactly what will run, so it cannot be
 * desynchronised from routing by encoding. When nothing matched (a 404-bound
 * request) there is no template, so it returns a decoded raw path: an encoded
 * `/api/...` then still trips the `/api/` gate instead of slipping past a
 * raw-string `startsWith`. One helper, so the two middlewares can never disagree
 * about what "the path" is. Read defensively so it does not depend on a specific
 * Fastify type surface (routeOptions in v4.10+, routerPath on older builds).
 */
import type { FastifyRequest } from "fastify";

export function authPath(req: FastifyRequest): string {
  // Prefer the matched route template — immune to encoding. NOT req.routerPath:
  // it is deprecated and removed in fastify@5, and merely reading it emits a
  // deprecation warning; routeOptions.url is the supported accessor.
  const url = (req as unknown as { routeOptions?: { url?: string } }).routeOptions?.url;
  if (typeof url === "string" && url.length > 0) return url;
  // No template (unmatched/404-bound, or a Fastify context that does not populate
  // it): a DECODED raw path still defeats the %73->s style attack — an encoded
  // /api/... normalizes back before the /api/ and money-prefix checks. decodeURI-
  // Component also collapses an encoded %2F, which only ever makes a money-prefix
  // match MORE likely (fail-safe).
  //
  // Precise safety claim (corrected, review finding A3; the previous wording here
  // overstated it). Prefix entries are segment-anchored now (api-gate.ts
  // pathMatches), but a decoded path CAN still land on a public entry: an unknown
  // path under a public prefix. What makes this fallback safe is reachability,
  // not the allowlist's shape: this branch runs only when Fastify's router
  // already failed to match ANY real route for the request. So even when
  // isPublicRoute(decoded, method) says "public", there is still no route
  // handler behind it — the request falls through to a 404 (server.ts's
  // SERVE_DASHBOARD notFoundHandler, or Fastify's own default 404 otherwise;
  // both answer any unmatched /api/* or /sse/* path with a bare 404 and no
  // side effects). That guarantee depends on no catch-all route existing under
  // /api/* — verified true today (no wildcard/`*` route is registered under
  // /api/*; see apigate-registered-public-surface.test.ts's wildcard-routes
  // test) — and would need re-checking the day one is added.
  return decodedRequestPath(req.url);
}

/**
 * The request path with its query string stripped and %-decoded: authPath's
 * fallback, exported so the not-found handler (server.ts, SERVE_DASHBOARD)
 * classifies an unmatched request by the SAME path apiGate authorized. It used to
 * test the raw url, so an unmatched /%61pi/... was authorized as /api/... and then
 * answered with the SPA (astra, pack 59, AZ-6). Malformed %-encoding keeps the raw
 * path.
 */
export function decodedRequestPath(url: string): string {
  const raw = url.split("?")[0];
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed %-encoding — keep raw; still gated by the /api/ check
  }
}
