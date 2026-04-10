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
    siweVerifyAttempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= SIWE_VERIFY_LIMIT) return false;
  entry.count++;
  return true;
}

// Cleanup stale SIWE entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of siweVerifyAttempts) {
    if (now - entry.windowStart > SIWE_VERIFY_WINDOW_MS) {
      siweVerifyAttempts.delete(ip);
    }
  }
}, 120_000);

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
