/**
 * API Gate middleware.
 *
 * Requires either a valid API key or SIWE session for all /api/* routes,
 * except explicitly public routes (health, auth, feedback, landing page assets).
 *
 * ── The public allowlist is METHOD-AWARE (board N43) ────────────────
 * Every entry in PUBLIC_ROUTES declares its method; any method an entry does
 * not declare falls through to authentication. The allowlist used to match
 * every method, and its prefixes with a raw startsWith, so "marketplace
 * browsing is public" also made POST/PUT/DELETE /api/marketplace/listings(/:id)
 * and POST /api/marketplace/orders public to a caller with no key.
 *   - A read entry opens GET; HEAD follows GET by default. An explicit
 *     authenticated HEAD policy preserves identity for artifact detail.
 *     Fastify runs the GET handler for HEAD and removes the response body:
 *     artifact recall increments loadCount and the registry snapshot persists.
 *     These handlers can therefore have storage effects on HEAD too.
 *   - Public requests return before apiKeyId is set, so keyed HEAD requests
 *     to the newly public twins skip scopeChecker, as their public GETs do.
 *     scopeChecker is a later onRequest hook, before body parsing; a limited
 *     key can be refused before DHT's route-level 501.
 *   - A prefix or regex entry can only be a read.
 *   - A write is public only as an EXACT public-by-design entry with a
 *     one-line `why`.
 *   - OPTIONS is never listed: @fastify/cors answers preflight in its own
 *     onRequest hook, which runs before this one.
 *   - A prefix matches at a path-segment boundary: "/api/health" opens
 *     "/api/health" and "/api/health/...", never a sibling such as
 *     "/api/healthcheck-debug".
 * __tests__/apigate-registered-public-surface.test.ts pins every registered
 * (method, route) this table opens, so a widening shows up as a reviewed diff.
 *
 * ── Retired marketplace writes are DENIED for every caller (N43) ────
 * /api/marketplace/* is retiring (kits #2523). Its listing and order writes
 * edit an in-memory mock with no ownership check (PUT and DELETE change ANY
 * listing), so a key does not make them safe. Steward ruling #2637: deny those
 * writes at the gate and build no ownership logic for a surface that is going
 * away. Every method except GET, HEAD and OPTIONS under the prefix is 410,
 * keyed or not, before authentication, including write routes added later. The exact
 * public-by-design calculator POST /api/marketplace/roi and the reads stay
 * public.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { nonCanonicalTargetReason, NON_CANONICAL_REFUSAL } from "./canonical-request-target.js";
import { resolveApiKey } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";

/** A public read: HEAD follows GET unless explicitly kept authenticated. */
export interface PublicRead {
  readonly methods: readonly ["GET"];
  readonly match: "prefix" | "exact" | "regex";
  /** prefix and exact: a path; regex: an anchored RegExp. */
  readonly path: string | RegExp;
  /** Default: follow-get. Artifact detail needs authenticated SIWE identity on HEAD. */
  readonly head?: "follow-get" | "authenticated";
  readonly why: string;
}

/** A public-by-design write: POST on one EXACT path, and why a caller with no key must reach it. */
export interface PublicWrite {
  readonly methods: readonly ["POST"];
  readonly match: "exact";
  readonly path: string;
  readonly why: string;
}

export type PublicRoute = PublicRead | PublicWrite;

const GET = Object.freeze(["GET"] as const);
const POST = Object.freeze(["POST"] as const);

// ── Public READS: prefixes (GET; segment-anchored, see pathMatches) ──
const PUBLIC_READ_PREFIXES: PublicRead[] = [
  { methods: GET, match: "prefix", path: "/api/health", why: "liveness and health probes" },
  { methods: GET, match: "prefix", path: "/api/auth/validate", why: "key validation checks the presented key itself" },
  // apiGate is non-encapsulated, so registration order does NOT exempt routes;
  // public paths must be allowlisted here.
  { methods: GET, match: "prefix", path: "/api/waitlist", why: "public beta waitlist count (GET /api/waitlist/count)" },
  // Gated by X-Admin-Token (adminOk) in the route, NOT the API-key system, so it
  // must bypass apiGate here. Mirrors the waitlist admin-token pattern.
  { methods: GET, match: "prefix", path: "/api/admin/feedback", why: "admin feedback export, authenticated by X-Admin-Token in the route" },
  { methods: GET, match: "prefix", path: "/api/onboard/check/", why: "invite-code validation" },
  { methods: GET, match: "prefix", path: "/api/onboard/chat", why: "onboarding chat health and conversation reads" },
  { methods: GET, match: "prefix", path: "/api/dht/", why: "DHT discovery (distributed capability queries)" },
  { methods: GET, match: "prefix", path: "/api/marketplace/", why: "marketplace browsing (see what's available)" },
  // apiGate never judges a path outside /api/ (its hook returns first); these
  // two are listed so the allowlist still says what is public there.
  { methods: GET, match: "prefix", path: "/.well-known/", why: "discovery documents" },
  { methods: GET, match: "prefix", path: "/docs", why: "docs hub and Swagger UI (/docs/api)" },
];

// ── Public READS: exact paths (GET) ─────────────────────────────────
const PUBLIC_READ_EXACT: PublicRead[] = [
  { methods: GET, match: "exact", path: "/api/agents/status", why: "network status" },
  // EXACT only: the GET listing is public, but sub-paths like /approve,
  // /reject and /activate require auth.
  { methods: GET, match: "exact", path: "/api/onboard/registrations", why: "public registration listing" },
  { methods: GET, match: "exact", path: "/api/orchestrator/templates", why: "template directory for unauthenticated landing-page discovery" },
  { methods: GET, match: "exact", path: "/openapi.json", why: "OpenAPI 3.x spec (APIs.guru, Smithery, mcp.so); outside /api" },
  { methods: GET, match: "exact", path: "/api/courier-jobs/open", why: "open courier-jobs feed: driver agents poll without a key (legacy shim)" },
  { methods: GET, match: "exact", path: "/api/courier-jobs/jobs/open", why: "v0.2 compat alias for the open courier-jobs feed (legacy shim)" },
  { methods: GET, match: "exact", path: "/api/courier-jobs/healthz", why: "courier-jobs liveness for monitoring (legacy shim)" },
  { methods: GET, match: "exact", path: "/api/job-offers/open", why: "open-offers feed: operator agents poll without a key" },
  { methods: GET, match: "exact", path: "/api/job-offers/healthz", why: "job-offers liveness for monitoring" },
  // SIWE login bootstrap: login is how a caller gets a key, so requiring a key
  // to reach it is a deadlock (verified 401 on production 2026-08-27). EXACT,
  // so no "/api/auth/nonce-*" sibling can leak public.
  { methods: GET, match: "exact", path: "/api/auth/nonce", why: "SIWE challenge: login needs a nonce before any key exists" },
  { methods: GET, match: "exact", path: "/api/kernels", why: "kernel discovery (creating or upserting a kernel stays authenticated)" },
  // Capability discovery is public to READ; creating or changing a capability
  // is not (N43, #564: with the listing public for every method, an anonymous
  // POST /api/capabilities created a capability on any kernel).
  { methods: GET, match: "exact", path: "/api/capabilities", why: "capability listing (creating one is not public)" },
  { methods: GET, match: "exact", path: "/api/capabilities/types", why: "capability type discovery" },
  { methods: GET, match: "exact", path: "/api/artifacts", why: "UI-artifact discovery (public listing)" },
];

// ── Public READS: regexes (GET) ─────────────────────────────────────
const PUBLIC_READ_REGEX: PublicRead[] = [
  // /api/capabilities/:id, /:id/button and /:id/td: discovery and widget
  // embedding. GET only: the pattern also matches POST
  // /api/capabilities/graph-search, which stays gated (#564).
  { methods: GET, match: "regex", path: /^\/api\/capabilities\/[^/]+(?:\/button|\/td)?$/, why: "capability detail, button and thing-description reads" },
  // T2.7: the reputation surface. POST /rate is another path and stays gated.
  { methods: GET, match: "regex", path: /^\/api\/operators\/[^/]+\/ratings$/, why: "operator rating reads" },
  // Listed by /.well-known/agent-descriptions and fetched unauthenticated by
  // any remote A2A agent.
  { methods: GET, match: "regex", path: /^\/api\/kernels\/[^/]+\/agent-card\.json$/, why: "per-kernel A2A agent card (federated discovery)" },
  // Operator agents read an offer without a key. POST/PATCH/DELETE on the same
  // path stay gated (the route also checks requirePoster).
  { methods: GET, match: "regex", path: /^\/api\/job-offers\/[^/]+$/, why: "job-offer detail reads" },
  { methods: GET, match: "regex", path: /^\/api\/courier-jobs\/(?:jobs\/)?[^/]+$/, why: "courier-job detail reads (legacy v0.2 public GET)" },
  // On-Ramp §5.3: a shared /a/:slug link and cross-agent discovery must work
  // for an anonymous caller. The single-segment pattern excludes
  // /api/artifacts/:id/fork, and the route still runs its own visibility
  // check, so a private artifact 403s an anonymous GET. HEAD stays authenticated
  // to preserve apiGate's SIWE owner identity. GET already loses that identity
  // on master; fixing that separate limitation is outside this gate change.
  { methods: GET, head: "authenticated", match: "regex", path: /^\/api\/artifacts\/[^/]+$/, why: "UI-artifact recall (the route enforces visibility; HEAD preserves SIWE ownership)" },
  // D2 compiler ABI: the snapshot and its historical recall by digest. The
  // sibling /api/compose/:id stays gated (its second segment is never this literal).
  { methods: GET, match: "regex", path: /^\/api\/compose\/registry-snapshot(?:\/[^/]+)?$/, why: "public compiler-ABI registry snapshot" },
];

// ── PUBLIC-BY-DESIGN writes ─────────────────────────────────────────
// Each is EXACT and says why a caller with no key must reach it. A line added
// here widens the unauthenticated surface; the registered-surface test shows it.
const PUBLIC_BY_DESIGN_WRITES: PublicWrite[] = [
  { methods: POST, match: "exact", path: "/api/auth/provision", why: "self-service key provisioning: how a caller gets a key" },
  // Verify carries its own per-IP rate limit (canSiweVerify, 30/min).
  { methods: POST, match: "exact", path: "/api/auth/verify", why: "SIWE signature verify -> session: the login endpoint itself" },
  { methods: POST, match: "exact", path: "/api/waitlist", why: "public beta waitlist signup" },
  { methods: POST, match: "exact", path: "/api/beta-apply", why: "public beta-tester application" },
  { methods: POST, match: "exact", path: "/api/feedback", why: "public feedback sink: cold agents have no key" },
  { methods: POST, match: "exact", path: "/api/feedback/agent-report", why: "keyless agent friction report" },
  // coord dc4d1ec8: anyone with a browser can register a capability without
  // first holding a key. Rate-limited by the global rate limiter and an
  // 8-turn-per-request hard cap.
  { methods: POST, match: "exact", path: "/api/onboard/chat", why: "layperson conversational onboarding" },
  { methods: POST, match: "exact", path: "/api/onboard/identify-device", why: "device identification for the install.html landing page" },
  { methods: POST, match: "exact", path: "/api/capabilities/templates/match", why: "landing-page template matcher: a read-only heuristic that stores nothing" },
  { methods: POST, match: "exact", path: "/api/marketplace/roi", why: "ROI calculator: pure computation that stores nothing" },
  // EasyPost and Lob cannot present a PCC API key, so gating these on one would
  // 401 every genuine delivery before the route's signature check ran ("being
  // behind an API key is NOT provider authentication"). Their authentication is
  // the verified HMAC in the route (503 with no secret, 401 on mismatch).
  { methods: POST, match: "exact", path: "/api/carrier/webhook/easypost", why: "EasyPost webhook: X-Hmac-Signature verified in routes/carrier.ts (sol #297 finding 15)" },
  { methods: POST, match: "exact", path: "/api/lob/webhook", why: "Lob webhook: timestamp-bound HMAC verified in routes/lob.ts (carrier audit L1)" },
];

/** The entire public allowlist. No other /api/ path skips apiGate. */
export const PUBLIC_ROUTES: readonly PublicRoute[] = Object.freeze([
  ...PUBLIC_READ_PREFIXES,
  ...PUBLIC_READ_EXACT,
  ...PUBLIC_READ_REGEX,
  ...PUBLIC_BY_DESIGN_WRITES,
].map((entry) => Object.freeze(entry)));

function pathMatches(entry: PublicRoute, path: string): boolean {
  if (entry.match === "regex") return (entry.path as RegExp).test(path);
  if (entry.match === "exact") return path === entry.path;
  // A prefix ending in "/" covers the paths below it. One without covers itself
  // and the paths below it, never a sibling that only shares its characters:
  // "/api/health" does not open "/api/healthcheck-debug".
  const prefix = entry.path as string;
  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * True when (method, url) is on the public allowlist. HEAD follows each read's
 * policy (default: follow GET). Fastify runs GET's handler with no response body. A method no entry
 * declares is not public: it falls through to authentication. Exported for tests.
 */
export function isPublicRoute(url: string, method?: string): boolean {
  const path = url.split("?")[0];
  const m = (method ?? "").toUpperCase();
  const effective = m === "HEAD" ? "GET" : m;
  return PUBLIC_ROUTES.some(
    (entry) => (entry.methods as readonly string[]).includes(effective)
      && !(m === "HEAD" && "head" in entry && entry.head === "authenticated")
      && pathMatches(entry, path),
  );
}

/** The retired write surface (N43, steward #2637). */
const RETIRED_WRITE_PREFIX = "/api/marketplace/";

/** The answer to every retired marketplace write, whoever the caller is. */
export const MARKETPLACE_WRITES_RETIRED = {
  error: "marketplace_writes_retired",
  message: "Marketplace listing and order writes are retired. Reads remain available.",
} as const;

/**
 * True when (method, url) is a write on the retired marketplace surface. GET,
 * HEAD and OPTIONS are never retired writes, and the exact public-by-design
 * POST /api/marketplace/roi stays reachable. Exported for tests.
 */
export function isRetiredWrite(url: string, method?: string): boolean {
  const path = url.split("?")[0];
  const m = (method ?? "").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  return path.startsWith(RETIRED_WRITE_PREFIX) && !isPublicRoute(path, m);
}

async function apiGateImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // A target the router would route differently is never judged (N105; the server-level guard
    // refuses it first, and this keeps apiGate closed even without that guard).
    if (nonCanonicalTargetReason(req.url) !== null) return reply.status(400).send(NON_CANONICAL_REFUSAL);
    // Only gate /api/* routes
    if (!req.url.startsWith("/api/")) return;

    // Retired marketplace writes: refused before authentication, so no key or session opens them.
    if (isRetiredWrite(req.url, req.method)) return reply.status(410).send(MARKETPLACE_WRITES_RETIRED);

    // Skip public routes
    if (isPublicRoute(req.url, req.method)) return;

    // Try API key first (most common for agents)
    const apiKey = resolveApiKey(req);
    if (apiKey) {
      req.apiKeyId = apiKey.id;
      req.operatorId = apiKey.operatorId;
      req.userId = apiKey.operatorId as `0x${string}`;
      return;
    }

    // Try SIWE session (dashboard users)
    const session = resolveSession(req);
    if (session) {
      req.userId = session.address;
      return;
    }

    // No auth — reject
    return reply.status(401).send({
      error: "api_key_required",
      message: "This endpoint requires authentication. Provide an API key via Authorization: Bearer pcc_live_... header, or sign in with your wallet.",
      provision_url: "/api/auth/provision",
      docs: "https://capability.network/whitepaper.md",
    });
  });
}

// T1.5 (2026-04-29): apiGate must run as a NON-ENCAPSULATED plugin so its
// onRequest hook applies to sibling route plugins registered against the
// parent app. Without these symbols Fastify isolates the hook to the gate's
// own scope, leaving every /api/* route registered AFTER apiGate effectively
// unauthenticated. Verified via apigate-encapsulation.test.ts.
//
// Equivalent to wrapping with fastify-plugin(fn) without adding the dep.
(apiGateImpl as any)[Symbol.for("skip-override")] = true;
(apiGateImpl as any)[Symbol.for("fastify.display-name")] = "apiGate";

export const apiGate = apiGateImpl;
