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
import { isIrBindablePath } from "../mcp/dashboard-ir.js";
import { projectIrRead } from "../mcp/dashboard-ir-read-projection.js";

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

/** The gateway's CORS options before row 37, unchanged: the credentialed allowlist above. */
export const CORS_ALLOWLIST_OPTIONS = Object.freeze({
  origin: corsOriginValidator,
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-PCC-API-Key", "X-PCC-Session", "X-Request-ID"],
  maxAge: 86400, // Cache preflight for 24h
});

/** Credential-less READ access for the governed GenUI view (row 37; operator item 109(b)).
 *  The IR kit fetches PCC's public read routes with credentials:"omit"
 *  (mcp/dashboard-ir-browser-entry.ts) from the MCP App domain or a host's sandbox origin
 *  (which can even be the opaque "null"). So it needs `Access-Control-Allow-Origin` and
 *  NOTHING else:
 *  - never Allow-Credentials, so no cookie-authenticated response is ever readable cross-origin;
 *  - GET only.
 *  "*" is safe here because these routes are public and the response is never credentialed. */
export const CORS_IR_READ_OPTIONS = Object.freeze({
  origin: "*",
  credentials: false,
  methods: ["GET"],
  allowedHeaders: ["Accept"],
  maxAge: 86400,
});

/** The marker corsDelegator puts on a GET it grants the credential-less wildcard: the IR path. */
const IR_CORS_READ = Symbol.for("pcc.irCorsReadPath");

/** onSend hook (registered at the ROOT, so it wraps every route). A response to a GET that
 *  received the CORS wildcard is replaced by the server-side IR projection: only the fields the
 *  closed IR reads (projectIrRead). The raw body's other fields (operator addresses, precise
 *  locations, physical addresses) never reach a cross-origin script (astra #562 r1 F1).
 *  - A non-200 response becomes "{}": the view only needs the status.
 *  - An unparseable payload also becomes "{}": fail closed, never the raw bytes.
 *  - Unmarked requests (allowlisted origins, no Origin, everything else) are untouched. */
export async function irCorsReadProjection(
  req: { method: string },
  reply: { statusCode: number; header: (name: string, value: string) => unknown },
  payload: unknown,
): Promise<unknown> {
  const path = (req as unknown as Record<symbol, unknown>)[IR_CORS_READ];
  if (typeof path !== "string" || req.method !== "GET") return payload;
  reply.header("content-type", "application/json; charset=utf-8");
  if (reply.statusCode !== 200) return "{}";
  let body: unknown;
  try {
    body = JSON.parse(typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : "");
  } catch {
    return "{}";
  }
  return JSON.stringify(projectIrRead(path, body));
}

/** Per-request CORS options for @fastify/cors's `delegator`. Every request gets
 *  CORS_ALLOWLIST_OPTIONS exactly as before, with ONE exception: an Origin outside the
 *  allowlist making a GET (or the CORS preflight for a GET) of a route the closed IR can bind to
 *  (isIrBindablePath). That gets CORS_IR_READ_OPTIONS. Methods other than GET, routes outside
 *  the IR bind registry, reserved routes and encoded or dotted paths keep the allowlist (so an
 *  unknown origin gets no CORS headers at all). */
export function corsDelegator(
  req: { headers: Record<string, string | string[] | undefined>; method: string; url: string },
  cb: (err: Error | null, options: typeof CORS_ALLOWLIST_OPTIONS | typeof CORS_IR_READ_OPTIONS) => void,
): void {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const preflightForGet = req.method === "OPTIONS" && req.headers["access-control-request-method"] === "GET";
    if ((req.method === "GET" || preflightForGet) && isIrBindablePath(path)) {
      // Mark the GET: its response must be the server-side IR projection (irCorsReadProjection),
      // never the raw body (astra #562 r1 F1).
      if (req.method === "GET") (req as unknown as Record<symbol, unknown>)[IR_CORS_READ] = path;
      return cb(null, CORS_IR_READ_OPTIONS);
    }
  }
  return cb(null, CORS_ALLOWLIST_OPTIONS);
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

// Cleanup stale SIWE entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of siweVerifyAttempts) {
    if (now - entry.windowStart > SIWE_VERIFY_WINDOW_MS) {
      siweVerifyAttempts.delete(ip);
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
