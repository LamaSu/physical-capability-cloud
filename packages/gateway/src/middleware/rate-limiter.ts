/**
 * Rate limiter middleware — token bucket per API key with weighted endpoint costs.
 *
 * Enforces per-API-key rate limits based on operator tier (free/paid/enterprise).
 * Endpoint costs come from the rateLimitPolicies table (cached in memory, refreshed
 * every 5 minutes). Falls back to hardcoded defaults when the DB has no rows.
 *
 * Standard rate limit headers are set on every request:
 *   X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *
 * Returns 429 when the bucket is exhausted.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getRepos } from "../db.js";

// ── Token Bucket ─────────────────────────────────────────────────

interface RateLimitBucket {
  tokens: number;
  lastRefill: number;
  limit: number;
  windowMs: number;
}

const buckets = new Map<string, RateLimitBucket>();

function getOrCreateBucket(key: string, limit: number, windowMs: number): RateLimitBucket {
  const existing = buckets.get(key);
  const now = Date.now();

  if (!existing) {
    const bucket: RateLimitBucket = { tokens: limit, lastRefill: now, limit, windowMs };
    buckets.set(key, bucket);
    return bucket;
  }

  // Refill tokens proportionally based on elapsed time
  const elapsed = now - existing.lastRefill;
  if (elapsed >= windowMs) {
    // Full window elapsed — fully refill
    existing.tokens = limit;
    existing.lastRefill = now;
  } else {
    // Partial refill: add tokens proportional to time elapsed
    const tokensToAdd = (elapsed / windowMs) * limit;
    existing.tokens = Math.min(limit, existing.tokens + tokensToAdd);
    existing.lastRefill = now;
  }

  // Update limit/window in case they changed (policy refresh)
  existing.limit = limit;
  existing.windowMs = windowMs;
  return existing;
}

// ── Cost Cache ───────────────────────────────────────────────────

interface CachedCostEntry {
  pattern: string;
  cost: number;
  freeTierLimit: number;
  paidTierLimit: number;
  enterpriseTierLimit: number;
  windowMs: number;
}

let costCache: CachedCostEntry[] = [];
let lastCacheRefresh = 0;
const CACHE_TTL = 300_000; // 5 minutes

// Default cost weights — used when no DB rows exist (backwards compat)
const DEFAULT_COSTS: Array<{ method: string; pattern: string; cost: number }> = [
  { method: "POST", pattern: "/api/evidence/*",   cost: 20 },
  { method: "POST", pattern: "/api/jobs/*",        cost: 10 },
  { method: "POST", pattern: "/api/negotiate/*",   cost: 5  },
  { method: "POST", pattern: "/api/build/*",       cost: 3  },
  { method: "GET",  pattern: "/api/*",             cost: 1  },
];

// Tier limits (requests per hour) — used when no DB policy exists
const TIER_DEFAULTS = {
  free:       100,
  paid:       10_000,
  enterprise: 100_000,
};

const DEFAULT_WINDOW_MS = 3_600_000; // 1 hour

/**
 * Simple glob-style pattern match: "**" or "*" in pattern matches any path segment(s).
 * "/api/jobs/*" matches "/api/jobs/123", "/api/jobs/456" etc.
 */
function patternMatches(pattern: string, url: string): boolean {
  // Convert glob pattern to regex
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const reStr = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  const re = new RegExp(`^${reStr}(?:\\?.*)?$`);
  return re.test(url);
}

/**
 * Refresh cost cache from DB. Falls back to defaults when DB returns nothing.
 */
function refreshCostCache(): void {
  try {
    const rows = getRepos().governance.findAllPolicies();
    if (rows.length > 0) {
      costCache = rows.map((r) => ({
        pattern: r.routePattern,
        cost: r.costWeight,
        freeTierLimit: r.freeTierLimit,
        paidTierLimit: r.paidTierLimit,
        enterpriseTierLimit: r.enterpriseTierLimit,
        windowMs: r.windowMs,
      }));
    } else {
      // No DB rows — populate defaults
      costCache = DEFAULT_COSTS.map((d) => ({
        pattern: d.pattern,
        cost: d.cost,
        freeTierLimit: TIER_DEFAULTS.free,
        paidTierLimit: TIER_DEFAULTS.paid,
        enterpriseTierLimit: TIER_DEFAULTS.enterprise,
        windowMs: DEFAULT_WINDOW_MS,
      }));
    }
  } catch {
    // DB not ready — keep existing cache or use defaults
    if (costCache.length === 0) {
      costCache = DEFAULT_COSTS.map((d) => ({
        pattern: d.pattern,
        cost: d.cost,
        freeTierLimit: TIER_DEFAULTS.free,
        paidTierLimit: TIER_DEFAULTS.paid,
        enterpriseTierLimit: TIER_DEFAULTS.enterprise,
        windowMs: DEFAULT_WINDOW_MS,
      }));
    }
  }
  lastCacheRefresh = Date.now();
}

function ensureCacheReady(): void {
  if (Date.now() - lastCacheRefresh > CACHE_TTL) {
    refreshCostCache();
  }
}

interface PolicyMatch {
  cost: number;
  freeTierLimit: number;
  paidTierLimit: number;
  enterpriseTierLimit: number;
  windowMs: number;
}

/**
 * Find the most-specific matching cost policy for a URL.
 * More-specific patterns (fewer wildcards) win.
 */
function getPolicyForUrl(url: string): PolicyMatch {
  const cleanUrl = url.split("?")[0];

  // Sort by specificity: count wildcards — fewer = more specific
  const sorted = [...costCache].sort((a, b) => {
    const wildA = (a.pattern.match(/\*/g) ?? []).length;
    const wildB = (b.pattern.match(/\*/g) ?? []).length;
    return wildA - wildB;
  });

  for (const entry of sorted) {
    if (patternMatches(entry.pattern, cleanUrl)) {
      return {
        cost: entry.cost,
        freeTierLimit: entry.freeTierLimit,
        paidTierLimit: entry.paidTierLimit,
        enterpriseTierLimit: entry.enterpriseTierLimit,
        windowMs: entry.windowMs,
      };
    }
  }

  // No match — use cheapest default
  return {
    cost: 1,
    freeTierLimit: TIER_DEFAULTS.free,
    paidTierLimit: TIER_DEFAULTS.paid,
    enterpriseTierLimit: TIER_DEFAULTS.enterprise,
    windowMs: DEFAULT_WINDOW_MS,
  };
}

// ── Tier Detection ───────────────────────────────────────────────

type OperatorTier = "free" | "paid" | "enterprise";

function detectTier(req: FastifyRequest): OperatorTier {
  // Derive tier from API key metadata when available
  if (req.apiKeyId) {
    try {
      const keyRecord = getRepos().apiKeys.findById(req.apiKeyId);
      if (keyRecord?.metadata) {
        const meta = JSON.parse(keyRecord.metadata) as Record<string, unknown>;
        const tier = meta["tier"] as string | undefined;
        if (tier === "enterprise" || tier === "paid" || tier === "free") {
          return tier;
        }
        // Legacy rateLimit string "1000/hour" etc — treat higher limits as paid/enterprise
        const rateLimit = keyRecord.rateLimit ?? "";
        const match = rateLimit.match(/^(\d+)/);
        if (match) {
          const n = parseInt(match[1], 10);
          if (n >= 100_000) return "enterprise";
          if (n >= 1_000) return "paid";
        }
      }
    } catch {
      // Non-fatal — fall back to free tier
    }
  }
  return "free";
}

function tierLimit(tier: OperatorTier, policy: PolicyMatch): number {
  switch (tier) {
    case "enterprise": return policy.enterpriseTierLimit;
    case "paid":       return policy.paidTierLimit;
    default:           return policy.freeTierLimit;
  }
}

// ── Routes to skip ───────────────────────────────────────────────

const SKIP_PREFIXES = [
  "/api/health",
  "/api/auth/provision",
  "/api/auth/validate",
  "/api/feedback",
  "/api/onboard/check/",
  "/api/dht/",
  "/api/marketplace/",
  "/.well-known/",
];

function shouldSkip(url: string): boolean {
  const path = url.split("?")[0];
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

// ── Fastify Plugin ───────────────────────────────────────────────

export async function rateLimiter(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith("/api/")) return;
    if (shouldSkip(req.url)) return;

    // Only rate-limit authenticated API key callers
    const apiKeyId = req.apiKeyId;
    if (!apiKeyId) return;

    ensureCacheReady();

    const policy = getPolicyForUrl(req.url);
    const tier = detectTier(req);
    const limit = tierLimit(tier, policy);
    const windowMs = policy.windowMs;

    const bucket = getOrCreateBucket(apiKeyId, limit, windowMs);

    // Check if we have enough tokens for this request's cost
    if (bucket.tokens < policy.cost) {
      const resetAt = Math.ceil((bucket.lastRefill + windowMs) / 1000);
      reply
        .header("X-RateLimit-Limit", String(limit))
        .header("X-RateLimit-Remaining", "0")
        .header("X-RateLimit-Reset", String(resetAt))
        .header("Retry-After", String(Math.ceil(windowMs / 1000)));
      return reply.status(429).send({
        error: "rate_limit_exceeded",
        message: `Rate limit exceeded. Tier: ${tier}, limit: ${limit} requests per window.`,
        limit,
        remaining: 0,
        resetAt,
        tier,
      });
    }

    // Consume tokens
    bucket.tokens = Math.max(0, bucket.tokens - policy.cost);

    const resetAt = Math.ceil((bucket.lastRefill + windowMs) / 1000);
    reply
      .header("X-RateLimit-Limit", String(limit))
      .header("X-RateLimit-Remaining", String(Math.floor(bucket.tokens)))
      .header("X-RateLimit-Reset", String(resetAt));
  });
}
