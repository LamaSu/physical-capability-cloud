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

export async function rateLimiter(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Skip health checks and static assets
    if (req.url === "/api/health" || !req.url.startsWith("/api/")) return;

    const ip = req.ip;
    const now = Date.now();
    let entry = ipCounts.get(ip);

    if (!entry || now - entry.windowStart > WINDOW_MS) {
      entry = { count: 0, windowStart: now };
      ipCounts.set(ip, entry);
    }

    entry.count++;

    if (entry.count > MAX_REQUESTS) {
      reply.header("Retry-After", "60");
      return reply.status(429).send({
        error: "rate_limited",
        message: `Too many requests (${MAX_REQUESTS}/min). Try again later.`,
      });
    }
  });
}
