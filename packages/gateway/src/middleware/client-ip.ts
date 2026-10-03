/**
 * Client IP resolution behind Cloudflare + Railway.
 *
 * Fastify's `req.ip` (even with trustProxy) surfaces the nearest proxy hop — behind
 * Cloudflare that's a Cloudflare edge address (104.x / 172.6x-7x / 162.158.x), which
 * is why raw visitor IPs never reached our logs, analytics, or per-IP rate limiters.
 * Cloudflare puts the real visitor IP in `CF-Connecting-IP` on every proxied request.
 */
import type { FastifyRequest } from "fastify";

/** First value of a header that may arrive as string | string[]. */
export function firstHeaderValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Resolve the true client IP.
 *
 * Order:
 *   1. CF-Connecting-IP — but only when `cf-ray` is also present, proving the request
 *      actually transited Cloudflare. This stops a client that reaches the origin
 *      directly from forging CF-Connecting-IP to poison logs / evade rate limits.
 *   2. True-Client-IP — Cloudflare Enterprise / Akamai equivalent.
 *   3. Left-most X-Forwarded-For entry — the originating client in a proxy chain.
 *   4. Fastify's req.ip — last-resort fallback (direct connection, no proxy).
 *
 * Caveat: if the origin is reachable without going through Cloudflare, cf-ray and
 * CF-Connecting-IP can both be spoofed. Full hardening = allowlist the peer socket
 * against Cloudflare's published IP ranges (follow-up).
 */
export function getClientIp(req: FastifyRequest): string {
  const cfRay = firstHeaderValue(req.headers["cf-ray"]);
  const cfConnectingIp = firstHeaderValue(req.headers["cf-connecting-ip"]);
  if (cfRay && cfConnectingIp) return cfConnectingIp.trim();

  const trueClientIp = firstHeaderValue(req.headers["true-client-ip"]);
  if (trueClientIp) return trueClientIp.trim();

  const xff = firstHeaderValue(req.headers["x-forwarded-for"]);
  const xffFirst = xff?.split(",")[0]?.trim();
  if (xffFirst) return xffFirst;

  return req.ip;
}

/**
 * App-wide normalization hook. Registered as the FIRST onRequest hook so that
 * `req.ip` — which every rate limiter, audit log, and SSE guard reads — resolves to
 * the true client IP instead of the Cloudflare edge. When the request transited
 * Cloudflare (proven by cf-ray), rewrite X-Forwarded-For to the CF-Connecting-IP so
 * Fastify's trustProxy resolver returns it. The original chain is preserved in
 * `x-original-forwarded-for` for forensics / attack-scanning.
 *
 * Strictly non-regressing: a request that did NOT transit Cloudflare is left
 * untouched, so `req.ip` behaves exactly as it did before.
 */
export async function normalizeClientIp(req: FastifyRequest): Promise<void> {
  const cfRay = firstHeaderValue(req.headers["cf-ray"]);
  const cfConnectingIp = firstHeaderValue(req.headers["cf-connecting-ip"]);
  if (!cfRay || !cfConnectingIp) return;

  const original = req.headers["x-forwarded-for"];
  if (original && !req.headers["x-original-forwarded-for"]) {
    req.headers["x-original-forwarded-for"] = Array.isArray(original) ? original.join(", ") : original;
  }
  req.headers["x-forwarded-for"] = cfConnectingIp.trim();
}
