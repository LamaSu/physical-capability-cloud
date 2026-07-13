/**
 * Global rate limiter middleware — Fastify plugin.
 *
 * Provides a coarse per-IP rate limit (200 req/min) as a first line of defense.
 * Route-specific limits (provisioning, SIWE verify, SSE, etc.) are handled by
 * the more granular limiters in security-hardening.ts.
 *
 * This middleware catches broad abuse (DDoS, scraping) that doesn't target
 * a specific endpoint.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 200; // per IP per window

const ipCounts = new Map<string, { count: number; windowStart: number }>();

// Cleanup stale entries every 2 minutes
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS * 2;
  for (const [ip, entry] of ipCounts) {
    if (entry.windowStart < cutoff) ipCounts.delete(ip);
  }
}, 120_000);

async function rateLimiterImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Static assets and non-API discovery routes are outside this policy.
    if (!req.url.startsWith("/api/")) return;

    const now = Date.now();
    // Health checks stay exempt from accounting, but still advertise the API
    // policy so automated clients see consistent headers on every /api/*
    // response.
    if (req.url.split("?")[0] === "/api/health") {
      reply.header("RateLimit-Limit", String(MAX_REQUESTS));
      reply.header("RateLimit-Remaining", String(MAX_REQUESTS));
      reply.header("RateLimit-Reset", String(Math.ceil(WINDOW_MS / 1_000)));
      return;
    }

    const ip = req.ip;
    let entry = ipCounts.get(ip);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      ipCounts.set(ip, entry);
    }

    entry.count++;

    const resetSeconds = Math.max(
      1,
      Math.ceil((entry.windowStart + WINDOW_MS - now) / 1_000),
    );
    const remaining = Math.max(0, MAX_REQUESTS - entry.count);

    reply.header("RateLimit-Limit", String(MAX_REQUESTS));
    reply.header("RateLimit-Remaining", String(remaining));
    reply.header("RateLimit-Reset", String(resetSeconds));

    if (entry.count > MAX_REQUESTS) {
      reply.header("Retry-After", String(resetSeconds));
      return reply.status(429).send({
        error: "rate_limited",
        message: `Too many requests (${MAX_REQUESTS}/min). Try again later.`,
      });
    }
  });
}

// This hook is intentionally global. Fastify encapsulates ordinary registered
// plugins, which would otherwise keep it from applying to sibling API routes.
// Match the established non-encapsulated pattern used by apiGate.
(rateLimiterImpl as any)[Symbol.for("skip-override")] = true;
(rateLimiterImpl as any)[Symbol.for("fastify.display-name")] = "rateLimiter";

export const rateLimiter = rateLimiterImpl;

/** Test-only state reset. */
export function __resetRateLimitState(): void {
  ipCounts.clear();
}
