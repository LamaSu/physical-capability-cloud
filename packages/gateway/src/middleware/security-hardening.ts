/**
 * Security Hardening Plugin — Structural security fixes.
 *
 * Registers: CORS restriction, body limits, SSE connection caps,
 * telemetry emit restriction, and security response headers.
 *
 * Separate from security-monitor.ts (event-night detection/telemetry)
 * to avoid merge conflicts during parallel development.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

// ── CORS Allowlist ──────────────────────────────────────────────────────────

/** Origins allowed to make credentialed requests */
const ALLOWED_ORIGINS = new Set([
  "https://capability.network",
  "https://lamasu.github.io",   // GitHub Pages landing site — feedback form POSTs to /api/feedback
  "http://localhost:5173",      // Vite dev server
  "http://localhost:3200",      // Local gateway
  "http://127.0.0.1:5173",
  "http://127.0.0.1:3200",
]);

/**
 * Strict CORS origin validator.
 * Returns the origin if it's in our allowlist, false otherwise.
 */
export function corsOriginValidator(
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean | string) => void,
) {
  // No origin = same-origin request (e.g., curl, server-to-server) → allow
  if (!origin) return cb(null, true);

  if (ALLOWED_ORIGINS.has(origin)) {
    return cb(null, origin);
  }

  // Reject unknown origins for credentialed requests
  return cb(null, false);
}

// ── SSE Connection Limiter ──────────────────────────────────────────────────

const sseConnectionsPerIp = new Map<string, number>();
const MAX_SSE_PER_IP = 20;

export function canOpenSSE(ip: string): boolean {
  const count = sseConnectionsPerIp.get(ip) ?? 0;
  return count < MAX_SSE_PER_IP;
}

export function trackSSEOpen(ip: string): void {
  const count = sseConnectionsPerIp.get(ip) ?? 0;
  sseConnectionsPerIp.set(ip, count + 1);
}

export function trackSSEClose(ip: string): void {
  const count = sseConnectionsPerIp.get(ip) ?? 0;
  if (count <= 1) {
    sseConnectionsPerIp.delete(ip);
  } else {
    sseConnectionsPerIp.set(ip, count - 1);
  }
}

// Cleanup stale entries every 5 minutes
setInterval(() => {
  for (const [ip, count] of sseConnectionsPerIp) {
    if (count <= 0) sseConnectionsPerIp.delete(ip);
  }
}, 300_000);

// ── API Key Provisioning Rate Limiter ───────────────────────────────────────

const provisionAttempts = new Map<string, { count: number; windowStart: number }>();
const PROVISION_LIMIT = 5;       // max provisions per IP
const PROVISION_WINDOW_MS = 3600_000; // 1 hour

export function canProvision(ip: string): boolean {
  const now = Date.now();
  const entry = provisionAttempts.get(ip);

  if (!entry || now - entry.windowStart > PROVISION_WINDOW_MS) {
    provisionAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= PROVISION_LIMIT) {
    return false;
  }

  entry.count++;
  return true;
}

// ── SIWE Verify Rate Limiter ────────────────────────────────────────────────
// Prevents unthrottled SIWE signature replay / brute force on /api/auth/verify.
// 30 attempts per IP per minute is generous for legit users, tight for attackers.

const siweVerifyAttempts = new Map<string, { count: number; windowStart: number }>();
const SIWE_VERIFY_LIMIT = 30;
const SIWE_VERIFY_WINDOW_MS = 60_000; // 1 minute

export function canSiweVerify(ip: string): boolean {
  const now = Date.now();
  const entry = siweVerifyAttempts.get(ip);
  if (!entry || now - entry.windowStart > SIWE_VERIFY_WINDOW_MS) {
    boundLimiter(siweVerifyAttempts);
    siweVerifyAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= SIWE_VERIFY_LIMIT) return false;
  entry.count++;
  return true;
}

// ── Anonymous A2A discovery limiter ──────────────────────────────────────────
// POST /a2a/tasks/send lets UNAUTHENTICATED callers run the discovery skill
// (pcc-discover / discover_capability) so a third-party host can find PCC
// capabilities with no PCC credential on it at all (coord #1667). The reads are
// the same ones behind the already-public GET /api/capabilities*, so the data
// exposure is nil — but every tasks/send stores a task in the gateway's
// in-memory a2aTasks map until TTL prune. Public must not mean unbounded, or
// anonymous discovery becomes a way to fill gateway memory. 60/min/IP is far
// more than a polling agent needs and far less than a memory-fill needs.

const anonA2aDiscoverAttempts = new Map<string, { count: number; windowStart: number }>();
const ANON_A2A_DISCOVER_LIMIT = 60;
const ANON_A2A_DISCOVER_WINDOW_MS = 60_000; // 1 minute

export function canAnonA2aDiscover(ip: string): boolean {
  const now = Date.now();
  const entry = anonA2aDiscoverAttempts.get(ip);
  if (!entry || now - entry.windowStart > ANON_A2A_DISCOVER_WINDOW_MS) {
    boundLimiter(anonA2aDiscoverAttempts);
    anonA2aDiscoverAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= ANON_A2A_DISCOVER_LIMIT) return false;
  entry.count++;
  return true;
}

/** Test hook — clears the anonymous-discovery window so suites don't bleed into each other. */
export function __resetAnonA2aDiscoverForTest(): void {
  anonA2aDiscoverAttempts.clear();
}

/**
 * Bound a per-IP limiter map's ENTRY count (finding M5). These maps key on the
 * client IP, and with trustProxy:true that IP is read from X-Forwarded-For — which
 * a caller can vary freely — so a flood of distinct spoofed IPs would grow the map
 * until the 120s cleanup sweep. Call before inserting a NEW window: at cap, evict
 * the oldest entries (Map preserves insertion order). Evicting a legit IP's window
 * early merely grants it a fresh window; it never denies service. Cheap O(k) where
 * k is the small overshoot, and only runs once the map is already large.
 */
const MAX_LIMITER_ENTRIES = 20_000;
function boundLimiter(map: Map<string, { count: number; windowStart: number }>): void {
  if (map.size < MAX_LIMITER_ENTRIES) return;
  const evict = map.size - MAX_LIMITER_ENTRIES + 1;
  let i = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++i >= evict) break;
  }
}

// ── Anonymous SIWE nonce-issuance limiter ────────────────────────────────────
// Same principle as the A2A limiter above. GET /api/auth/nonce is necessarily
// PUBLIC — it is how a caller with no credential bootstraps one — and it was
// previously both unlimited AND doing real work per call (a full nonce-map
// sweep plus a SQLite session DELETE), i.e. an unauthenticated amplification
// path. Cross-family review of PR #309 flagged it. A legitimate client needs
// ONE nonce per login, so 60/min/IP is far more than a human or agent needs and
// far less than a flood needs.
const siweNonceAttempts = new Map<string, { count: number; windowStart: number }>();
const SIWE_NONCE_LIMIT = 60;
const SIWE_NONCE_WINDOW_MS = 60_000; // 1 minute

export function canSiweNonce(ip: string): boolean {
  const now = Date.now();
  const entry = siweNonceAttempts.get(ip);
  if (!entry || now - entry.windowStart > SIWE_NONCE_WINDOW_MS) {
    boundLimiter(siweNonceAttempts);
    siweNonceAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= SIWE_NONCE_LIMIT) return false;
  entry.count++;
  return true;
}

/** Test hook — clears the nonce-issuance window between suites. */
export function __resetSiweNonceForTest(): void {
  siweNonceAttempts.clear();
}

// Cleanup stale SIWE entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of siweVerifyAttempts) {
    if (now - entry.windowStart > SIWE_VERIFY_WINDOW_MS) {
      siweVerifyAttempts.delete(ip);
    }
  }
  for (const [ip, entry] of siweNonceAttempts) {
    if (now - entry.windowStart > SIWE_NONCE_WINDOW_MS) {
      siweNonceAttempts.delete(ip);
    }
  }
}, 120_000);

// ── Broker / dispatcher role check ──────────────────────────────────────────
//
// BROKER_OPERATORS env var (comma-separated wallet addresses or operator IDs)
// lists callers that are allowed to assign work to OTHER operators (e.g. assign
// a request node to a specific kernel operator). Everyone else can only act on
// their own behalf.
//
// Set in Railway: BROKER_OPERATORS=0xabc...,broker@example.com

export function isBrokerOperator(operatorId: string | undefined | null): boolean {
  if (!operatorId) return false;
  const raw = process.env.BROKER_OPERATORS ?? "";
  const set = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return set.has(operatorId.toLowerCase());
}

// ── Generic per-caller rate limiter ─────────────────────────────────────────
//
// Used for any endpoint that needs throttling beyond the SIWE/provision specific
// limiters. Tracks per (operatorId, endpointKey) tuple.

const callerRateMap = new Map<string, { count: number; windowStart: number }>();

export function checkCallerRate(
  operatorId: string,
  endpointKey: string,
  limit: number,
  windowMs: number,
): boolean {
  const key = `${operatorId}::${endpointKey}`;
  const now = Date.now();
  const entry = callerRateMap.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    callerRateMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// Cleanup stale rate-limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of callerRateMap) {
    if (now - entry.windowStart > 3_600_000) callerRateMap.delete(key);
  }
}, 300_000);

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of provisionAttempts) {
    if (now - entry.windowStart > PROVISION_WINDOW_MS) {
      provisionAttempts.delete(ip);
    }
  }
}, 600_000);

// ── Security Response Headers ───────────────────────────────────────────────

export async function securityHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (_req: FastifyRequest, reply: FastifyReply) => {
    // Prevent clickjacking
    reply.header("X-Frame-Options", "DENY");
    // Prevent MIME type sniffing
    reply.header("X-Content-Type-Options", "nosniff");
    // XSS protection (legacy but still useful)
    reply.header("X-XSS-Protection", "1; mode=block");
    // Referrer policy
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    // Permissions policy (disable dangerous browser features)
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(self)",
    );
    // HSTS (enforce HTTPS) — 1 year, include subdomains
    if (process.env.NODE_ENV === "production") {
      reply.header(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains; preload",
      );
    }
    // Content Security Policy
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",  // unsafe-inline needed for Vite/React in dev
        "style-src 'self' 'unsafe-inline'",   // inline styles used by dashboard
        "img-src 'self' data: https:",
        "font-src 'self' https://fonts.gstatic.com",
        "connect-src 'self' https://capability.network https://*.posthog.com https://*.sentry.io wss://capability.network",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
  });
}

// ── Telemetry Emit Restriction ──────────────────────────────────────────────

/** Only allow telemetry emit from operators/admins, not arbitrary users */
export function isTelemetryEmitAllowed(req: FastifyRequest): boolean {
  // Must have an API key (not just a session)
  const apiKeyId = (req as any).apiKeyId;
  const operatorId = (req as any).operatorId;

  // Only operators with API keys can emit telemetry
  return !!(apiKeyId && operatorId);
}

// ── Body Size Limits ────────────────────────────────────────────────────────

/** Recommended Fastify body limit options */
export const BODY_LIMIT_OPTIONS = {
  bodyLimit: 1_048_576, // 1 MB default
};

/** Routes that need larger body limits (file uploads, etc.) */
export const LARGE_BODY_ROUTES = new Set([
  "/api/relay/*/camera/frame",
  "/api/ot2/camera/frame",
  "/api/evidence/upload",
]);
