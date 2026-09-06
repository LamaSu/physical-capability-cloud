/**
 * API Gate middleware.
 *
 * Requires either a valid API key or SIWE session for all /api/* routes,
 * except explicitly public routes (health, auth, feedback, landing page assets).
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveApiKey } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";

/** Routes that don't require any auth */
const PUBLIC_PREFIXES = [
  "/api/health",
  "/api/auth/provision",        // Key provisioning is public
  "/api/auth/validate",         // Key validation is public (checks key itself)
  "/api/waitlist",              // Public beta waitlist — signup (POST) + count (GET).
                                // apiGate is non-encapsulated, so registration order does
                                // NOT exempt routes; public paths must be allowlisted here.
  "/api/beta-apply",            // Public beta-tester application (POST).
  "/api/feedback",              // Public feedback sink (POST) — cold agents have no key.
                                // GET /api/feedback stays a no-op (route removed); the
                                // admin export below carries its own X-Admin-Token gate.
  "/api/admin/feedback",        // Admin feedback export — gated by X-Admin-Token (adminOk),
                                // NOT the API-key system, so it must bypass apiGate here.
                                // Mirrors the waitlist admin-token pattern.
  "/api/onboard/identify-device", // Device identification is public (install.html landing)
  "/api/onboard/check/",        // Invite code validation is public
  "/api/onboard/chat",          // Layperson conversational onboarding (coord dc4d1ec8)
                                // Public so anyone with a browser can register a capability
                                // without first holding an API key. Rate-limited by the
                                // global rate-limiter + an 8-turn-per-request hard cap.
  // REMOVED: "/api/onboard/registrations" — prefix match was too broad, exposed admin
  // endpoints (approve/reject/activate) without auth. Now uses exact match below.
  "/api/dht/",                  // DHT discovery is public (distributed capability queries)
  "/api/marketplace/",          // Marketplace browsing is public (see what's available)
  "/.well-known/",
  "/docs",                      // Docs hub + Swagger UI (/docs/api) are public
];

const PUBLIC_EXACT = [
  // ── SIWE login bootstrap ────────────────────────────────────────
  // These two MUST be reachable unauthenticated: they are how a caller with no
  // credential yet obtains one. Gating them is a bootstrap deadlock — you need
  // a nonce to authenticate, and authentication to get a nonce.
  //
  // They were NOT allowlisted, and it was not theoretical: verified against
  // production 2026-08-27, both returned 401 api_key_required, i.e. SIWE login
  // was unreachable on the live gateway and every wallet-identity flow built on
  // it (including SIWE-gated provisioning) was dead on arrival.
  //
  // Listed EXACT rather than as a prefix on purpose: a "/api/auth/verify"
  // prefix entry would also open anything merely starting with that string.
  // Risk surface of each: /nonce returns 16 random bytes and holds them in a
  // self-expiring 5-minute map; /verify is the login endpoint itself and
  // already carries its own per-IP rate limit (canSiweVerify, 30/min). The
  // session-bearing routes (/me, /logout, /sessions) stay gated.
  "/api/auth/nonce",
  "/api/auth/verify",
  "/api/capabilities/types",   // Discovery is public (see what's available)
  "/api/capabilities",         // Capability listing is public
  "/api/agents/status",        // Network status is public
  "/api/onboard/registrations", // EXACT match only — GET listing is public, but
                                // sub-paths like /approve, /reject, /activate require auth
  "/api/orchestrator/templates", // Template directory is public for unauth landing-page discovery
  "/api/capabilities/templates/match", // Heuristic template-matcher is public for landing-page picker
  "/openapi.json",             // OpenAPI 3.x spec is public (APIs.guru, Smithery, mcp.so)
  "/api/courier-jobs/open",       // Open courier-jobs feed — driver agents poll without API key (legacy shim)
  "/api/courier-jobs/jobs/open",  // v0.2 compat alias for the open feed (legacy shim)
  "/api/courier-jobs/healthz",    // Courier-jobs liveness — public for monitoring (legacy shim)
  "/api/job-offers/open",         // Generic open-offers feed — operator agents poll without API key (PRIMARY)
  "/api/job-offers/healthz",      // Job-offers liveness — public for monitoring (PRIMARY)
  // ── SIWE login bootstrap ────────────────────────────────────────────────
  // These MUST be public: SIWE login is how you get a key, so requiring a key
  // to reach them is a bootstrap deadlock. Verified 401 on production
  // 2026-08-27 — SIWE login (and the SIWE-gated provisioning built on it) was
  // dead on arrival because neither was allowlisted. Listed EXACT, not as a
  // prefix: verify carries its own per-IP rate limit (canSiweVerify, 30/min),
  // and an exact entry can't let a "/api/auth/verify-*" sibling leak public.
  "/api/auth/nonce",              // SIWE challenge — public by design (a nonce is a public challenge)
  "/api/auth/verify",             // SIWE signature verify → session; the login endpoint, must be reachable without a key
];

// Capability detail routes are public — discovery, widget embedding, etc.
// Covers: /api/capabilities/:id, /api/capabilities/:id/button, /api/capabilities/:id/td
const PUBLIC_CAPABILITY_DETAIL_RE = /^\/api\/capabilities\/[^/]+(?:\/button|\/td)?$/;

// T2.7 — operator rating reads are public (reputation surface). The POST
// /rate route remains auth-gated because it falls outside this regex.
const PUBLIC_OPERATOR_RATINGS_RE = /^\/api\/operators\/[^/]+\/ratings$/;

// Per-kernel A2A agent card is part of the federated discovery surface —
// /.well-known/agent-descriptions lists it. Must be reachable unauthed by
// any remote A2A agent.
const PUBLIC_KERNEL_AGENT_CARD_RE = /^\/api\/kernels\/[^/]+\/agent-card\.json$/;

// Generic /api/job-offers/:id GET is public so operator agents can fetch
// offer detail without holding a gateway API key. POST/PATCH/DELETE on the
// same path stays auth-gated by the route handler (requirePoster). The
// regex matches /api/job-offers/<anything-without-slash> — excluding the
// /open and /healthz exact entries above (those are matched first).
const PUBLIC_JOB_OFFERS_DETAIL_RE = /^\/api\/job-offers\/[^/]+$/;

// Same for /api/courier-jobs/:id (legacy shim — preserve v0.2's public-GET
// behavior).
const PUBLIC_COURIER_JOBS_DETAIL_RE = /^\/api\/courier-jobs\/(?:jobs\/)?[^/]+$/;

// On-Ramp §5.3 / acceptance #8 — UI-artifact discovery + recall are public
// reads: GET /api/artifacts (public listing) and GET /api/artifacts/:idOrSlug
// (recall by id or slug). A shared /a/:slug link and cross-agent discovery
// must work for an anonymous caller. Only GET is public: the single-segment
// regex excludes /api/artifacts/:id/fork, and the method guard below keeps
// POST/PUT/DELETE (save/modify/retire/fork) Bearer-gated. The route handler
// still runs its own visibility check, so a `private` artifact 403s an
// anonymous caller — the public path never leaks private content.
const PUBLIC_ARTIFACTS_READ_RE = /^\/api\/artifacts(?:\/[^/]+)?$/;

// D2 compiler-ABI: the registry snapshot + its historical-by-digest recall are
// public reads (the snapshot IS the public compiler ABI; no auth to read).
// Matches GET /api/compose/registry-snapshot and
// /api/compose/registry-snapshot/:registryDigest. GET-only — there is no
// mutation surface, and the sibling /api/compose/:id stays auth-gated (its
// second segment is never the literal "registry-snapshot").
const PUBLIC_REGISTRY_SNAPSHOT_RE = /^\/api\/compose\/registry-snapshot(?:\/[^/]+)?$/;

// Carrier tracking webhook (EasyPost -> PCC). EasyPost cannot present a PCC
// API key, so gating this path on one would 401 every genuine delivery before
// the route's HMAC check ever ran — the exact defect that got the unsigned
// Stripe/Yellowcard webhooks retired ("being behind an API key is NOT provider
// authentication"). This path's authentication IS the verified X-Hmac-Signature
// in routes/carrier.ts (fails closed 503 with no secret, 401 on mismatch).
// POST only; nothing else under /api/carrier/ is public. sol #297 finding 15.
const PUBLIC_CARRIER_WEBHOOK_PATH = "/api/carrier/webhook/easypost";

// Lob letter webhook (Lob -> PCC). Same argument as the carrier webhook above:
// Lob's servers cannot present a PCC API key, so gating this path on one would
// 401 every genuine letter event before routes/lob.ts's timestamp-bound HMAC
// verification ever ran — the webhook/evidence leg was structurally dead on any
// apiGate-fronted deployment (carrier audit L1). POST only; nothing else under
// /api/lob/ is public.
const PUBLIC_LOB_WEBHOOK_PATH = "/api/lob/webhook";

function isPublicRoute(url: string, method?: string): boolean {
  const path = url.split("?")[0];
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (PUBLIC_EXACT.includes(path)) return true;
  if (method === "POST" && path === PUBLIC_CARRIER_WEBHOOK_PATH) return true;
  if (method === "POST" && path === PUBLIC_LOB_WEBHOOK_PATH) return true;
  // Kernel discovery is public; identity-bearing creation/upsert is not.
  if (method === "GET" && path === "/api/kernels") return true;
  if (PUBLIC_CAPABILITY_DETAIL_RE.test(path)) return true;
  if (PUBLIC_OPERATOR_RATINGS_RE.test(path)) return true;
  if (PUBLIC_KERNEL_AGENT_CARD_RE.test(path)) return true;
  // Only GET on the offer/job detail routes is public.
  if (method === "GET" && PUBLIC_JOB_OFFERS_DETAIL_RE.test(path)) return true;
  if (method === "GET" && PUBLIC_COURIER_JOBS_DETAIL_RE.test(path)) return true;
  // Only GET on artifact discovery/recall is public; mutations stay gated.
  if (method === "GET" && PUBLIC_ARTIFACTS_READ_RE.test(path)) return true;
  // D2 compiler-ABI registry snapshot + historical recall — public GET reads.
  if (method === "GET" && PUBLIC_REGISTRY_SNAPSHOT_RE.test(path)) return true;
  return false;
}

async function apiGateImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Only gate /api/* routes
    if (!req.url.startsWith("/api/")) return;

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
