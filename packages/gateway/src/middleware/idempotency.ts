/**
 * Idempotency middleware for payment-gated routes.
 *
 * Checks the `Idempotency-Key` header on POST/PUT/PATCH requests.
 * - Key seen before (within TTL): return cached response verbatim, set `Idempotency-Replayed: true`
 * - Key new: execute handler normally, cache the response
 * - No key: pass through (opt-in, Stripe-style)
 * - Key with mismatched path/method: return 422
 *
 * Cache key includes the client API key (when present) so idempotency is per-client.
 *
 * Storage: in-memory Map with TTL cleanup (no DB needed for v1).
 * TTL: 24h default, configurable via IDEMPOTENCY_TTL_MS env var.
 * Cleanup: prune expired entries every 5 minutes.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TTL_MS = parseInt(process.env.IDEMPOTENCY_TTL_MS ?? "", 10) || 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Routes subject to idempotency protection — must match payment gate routes.
// GET routes are excluded here; the onRequest hook also double-checks the method.
const IDEMPOTENCY_ROUTES = new Set([
  "POST /api/capabilities/quote",
  "POST /api/capabilities/simulate",
  "POST /api/capabilities/route",
]);

// ---------------------------------------------------------------------------
// Cache types
// ---------------------------------------------------------------------------

interface CachedResponse {
  statusCode: number;
  body: string; // JSON-stringified
  headers: Record<string, string>;
  method: string;
  path: string;
  expiresAt: number; // epoch ms
}

// Cache key: `clientId:idempotency_key` — isolated per API key / session
const cache = new Map<string, CachedResponse>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the compound cache key incorporating the client identity. */
function buildCacheKey(clientId: string, idempotencyKey: string): string {
  return `${clientId}:${idempotencyKey}`;
}

/** Extract a stable client identifier from the request (API key, session, or anonymous). */
function getClientId(req: FastifyRequest): string {
  // Prefer operator / API key attached by auth middleware
  const opId = (req as any).operatorId;
  const keyId = (req as any).apiKeyId;
  if (opId) return `op:${opId}`;
  if (keyId) return `key:${keyId}`;
  // Fall back to Authorization header value (hashed cheaply by substring)
  const auth = req.headers.authorization;
  if (auth) {
    const token = auth.replace(/^bearer\s+/i, "");
    return `auth:${token.slice(0, 16)}`;
  }
  // Completely anonymous — use a shared namespace (less safe, still better than nothing)
  return "anon";
}

/** Prune all expired entries from the cache. */
function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Fastify plugin (non-encapsulated — skip-override symbol set so hooks apply
 * to all routes in the parent scope, matching the pattern used by x402-gate
 * and aegis-gate. Equivalent to wrapping with fastify-plugin without the dep.)
 */
async function idempotencyGateImpl(app: FastifyInstance): Promise<void> {
  // Schedule periodic pruning
  const pruneTimer = setInterval(pruneCache, PRUNE_INTERVAL_MS);
  // Ensure the timer does not prevent the process from exiting
  if (pruneTimer.unref) pruneTimer.unref();

  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
  });

  // onRequest: replay cached response early (before any other hook including payment gate)
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const key = req.headers["idempotency-key"] as string | undefined;
    if (!key) return; // Opt-in — no key, no idempotency

    // Only apply to mutating methods
    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE") return;

    const path = req.url.split("?")[0];
    const routeKey = `${method} ${path}`;

    // Not a payment-gated route — pass through
    if (!IDEMPOTENCY_ROUTES.has(routeKey)) return;

    const clientId = getClientId(req);
    const cacheKey = buildCacheKey(clientId, key);
    const entry = cache.get(cacheKey);

    if (!entry) return; // First request — fall through to handler

    // Key exists — check method/path match (422 if mismatch)
    if (entry.method !== method || entry.path !== path) {
      return reply.status(422).send({
        error: "idempotency_key_reuse",
        message: "Idempotency key was used with a different request (method or path mismatch).",
        original: { method: entry.method, path: entry.path },
        current: { method, path },
      });
    }

    // Expired — remove and fall through to re-execute
    if (entry.expiresAt <= Date.now()) {
      cache.delete(cacheKey);
      return;
    }

    // Valid cached response — replay
    const replayHeaders: Record<string, string> = {
      ...entry.headers,
      "Idempotency-Replayed": "true",
      "Content-Type": "application/json",
    };

    return reply
      .status(entry.statusCode)
      .headers(replayHeaders)
      .send(JSON.parse(entry.body));
  });

  // onSend: cache successful responses for idempotent routes
  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const key = req.headers["idempotency-key"] as string | undefined;
    if (!key) return payload;

    const method = req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "DELETE") return payload;

    const path = req.url.split("?")[0];
    const routeKey = `${method} ${path}`;
    if (!IDEMPOTENCY_ROUTES.has(routeKey)) return payload;

    // Only cache non-5xx, non-402 responses (402 = payment still pending; 5xx = server error)
    const status = reply.statusCode;
    if (status >= 500 || status === 402) return payload;

    // Avoid caching the 422 mismatch response we send ourselves
    if (status === 422) return payload;

    // Don't overwrite an existing valid entry (first-write-wins)
    const clientId = getClientId(req);
    const cacheKey = buildCacheKey(clientId, key);
    if (cache.has(cacheKey)) {
      const existing = cache.get(cacheKey)!;
      if (existing.expiresAt > Date.now()) return payload;
    }

    // Collect relevant response headers to replay
    const headersToCache: Record<string, string> = {};
    const preserveHeaders = ["content-type", "x-pcc-request-id", "payment-receipt"];
    for (const h of preserveHeaders) {
      const v = reply.getHeader(h);
      if (typeof v === "string") headersToCache[h] = v;
    }

    const bodyStr = typeof payload === "string" ? payload : JSON.stringify(payload);

    cache.set(cacheKey, {
      statusCode: status,
      body: bodyStr,
      headers: headersToCache,
      method,
      path,
      expiresAt: Date.now() + TTL_MS,
    });

    return payload;
  });
}

// Mark as non-encapsulated so hooks apply to ALL routes in the parent scope.
// This is equivalent to wrapping with fastify-plugin(fn) without requiring the dep.
(idempotencyGateImpl as any)[Symbol.for("skip-override")] = true;
(idempotencyGateImpl as any)[Symbol.for("fastify.display-name")] = "idempotencyGate";

export const idempotencyGate = idempotencyGateImpl;

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

/** Clears the in-memory cache (test helper — do not call in production). */
export function _clearCacheForTesting(): void {
  cache.clear();
}

/** Returns current cache size (test helper). */
export function _getCacheSizeForTesting(): number {
  return cache.size;
}
