/**
 * API Gate middleware.
 *
 * Requires either a valid API key or SIWE session for all /api/* routes,
 * except explicitly public routes (health, auth, feedback, landing page assets).
 *
 * ── The public allowlist is METHOD-AWARE (WP-A fold F5) ─────────────
 * Every public entry declares the methods it opens; any other method on the
 * same path falls through to authentication. It used to be method-blind for
 * PUBLIC_PREFIXES / PUBLIC_EXACT and three of the regexes, so an allowlist
 * comment saying "listing is public" also made the WRITES on that path public:
 * POST /api/capabilities (an unauthenticated capability upsert on any kernel),
 * POST/PUT/DELETE /api/marketplace/listings(/:id) and POST
 * /api/marketplace/orders all skipped apiGate (refvertical #2586, coord-watch
 * #2608). Now:
 *   - reads are public only for GET (HEAD follows GET — same handler, no body);
 *   - a write is public only when it is listed below as PUBLIC-BY-DESIGN, each
 *     with a one-line justification, and EXACT (never a prefix);
 *   - OPTIONS is never listed: @fastify/cors answers preflight in its own
 *     onRequest hook before this gate runs.
 * __tests__/apigate-public-methods.test.ts pins the ENTIRE public (method,
 * path) set as a snapshot, so any widening shows up as a visible diff.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { resolveApiKey } from "../auth/api-key-auth.js";
import { resolveSession } from "../auth/siwe-auth.js";
import { authPath } from "./route-path.js";

type PublicMethod = "GET" | "POST";

/** One public allowlist entry. `why` is required; for a write it is the justification. */
interface PublicRoute {
  methods: readonly PublicMethod[];
  match: "prefix" | "exact" | "regex";
  /** prefix / exact: a path string; regex: an anchored RegExp. */
  path: string | RegExp;
  why: string;
}

const GET: readonly PublicMethod[] = ["GET"];
const POST: readonly PublicMethod[] = ["POST"];

// ── Public READS (GET) ──────────────────────────────────────────────
// Prefix entries are GET-only now: a prefix can only ever open reads.
const PUBLIC_READ_PREFIXES: PublicRoute[] = [
  { methods: GET, match: "prefix", path: "/api/health", why: "liveness / health probes" },
  { methods: GET, match: "prefix", path: "/api/auth/validate", why: "key validation checks the presented key itself" },
  // apiGate is non-encapsulated, so registration order does NOT exempt routes;
  // public paths must be allowlisted here.
  { methods: GET, match: "prefix", path: "/api/waitlist", why: "public waitlist count (GET /api/waitlist/count)" },
  // Admin feedback export — gated by X-Admin-Token (adminOk), NOT the API-key
  // system, so it must bypass apiGate here. Mirrors the waitlist admin-token pattern.
  { methods: GET, match: "prefix", path: "/api/admin/feedback", why: "admin export authenticated by X-Admin-Token in the route" },
  { methods: GET, match: "prefix", path: "/api/onboard/check/", why: "invite-code validation" },
  { methods: GET, match: "prefix", path: "/api/onboard/chat", why: "onboarding-chat health + transcript reads" },
  { methods: GET, match: "prefix", path: "/api/dht/", why: "DHT discovery is public (distributed capability queries)" },
  { methods: GET, match: "prefix", path: "/api/marketplace/", why: "marketplace browsing is public (see what's available)" },
  { methods: GET, match: "prefix", path: "/.well-known/", why: "discovery documents" },
  { methods: GET, match: "prefix", path: "/docs", why: "docs hub + Swagger UI (/docs/api)" },
];

const PUBLIC_READ_EXACT: PublicRoute[] = [
  { methods: GET, match: "exact", path: "/api/capabilities/types", why: "discovery is public (see what's available)" },
  { methods: GET, match: "exact", path: "/api/capabilities", why: "capability LISTING is public (creating one is not)" },
  { methods: GET, match: "exact", path: "/api/agents/status", why: "network status is public" },
  // EXACT match only — the GET listing is public, but sub-paths like /approve,
  // /reject, /activate require auth.
  { methods: GET, match: "exact", path: "/api/onboard/registrations", why: "public registration listing" },
  { methods: GET, match: "exact", path: "/api/orchestrator/templates", why: "template directory for unauth landing-page discovery" },
  { methods: GET, match: "exact", path: "/openapi.json", why: "OpenAPI 3.x spec (APIs.guru, Smithery, mcp.so)" },
  { methods: GET, match: "exact", path: "/api/courier-jobs/open", why: "open courier-jobs feed — driver agents poll without a key (legacy shim)" },
  { methods: GET, match: "exact", path: "/api/courier-jobs/jobs/open", why: "v0.2 compat alias for the open feed (legacy shim)" },
  { methods: GET, match: "exact", path: "/api/courier-jobs/healthz", why: "courier-jobs liveness for monitoring (legacy shim)" },
  { methods: GET, match: "exact", path: "/api/job-offers/open", why: "open-offers feed — operator agents poll without a key" },
  { methods: GET, match: "exact", path: "/api/job-offers/healthz", why: "job-offers liveness for monitoring" },
  // Kernel discovery is public; identity-bearing creation/upsert is not.
  { methods: GET, match: "exact", path: "/api/kernels", why: "kernel discovery (registration stays authenticated)" },
];

const PUBLIC_READ_REGEX: PublicRoute[] = [
  // /api/capabilities/:id, /:id/button, /:id/td — discovery, widget embedding.
  { methods: GET, match: "regex", path: /^\/api\/capabilities\/[^/]+(?:\/button|\/td)?$/, why: "capability detail / button / thing-description reads" },
  // T2.7 — operator rating reads (reputation surface). POST /rate is a
  // different path and stays gated.
  { methods: GET, match: "regex", path: /^\/api\/operators\/[^/]+\/ratings$/, why: "operator rating reads (reputation surface)" },
  // Per-kernel A2A agent card — listed by /.well-known/agent-descriptions and
  // fetched unauthenticated by any remote A2A agent.
  { methods: GET, match: "regex", path: /^\/api\/kernels\/[^/]+\/agent-card\.json$/, why: "per-kernel A2A agent card (federated discovery)" },
  // Offer / job detail so operator agents can read without a key; POST/PATCH/
  // DELETE on the same path stay gated (the route also checks requirePoster).
  // (/open and /healthz also match this single-segment regex; both are GET
  // reads listed exactly above as well.)
  { methods: GET, match: "regex", path: /^\/api\/job-offers\/[^/]+$/, why: "job-offer detail reads" },
  { methods: GET, match: "regex", path: /^\/api\/courier-jobs\/(?:jobs\/)?[^/]+$/, why: "courier-job detail reads (legacy v0.2 public GET)" },
  // On-Ramp §5.3 — UI-artifact discovery + recall. The route still runs its own
  // visibility check, so a private artifact 403s an anonymous caller.
  { methods: GET, match: "regex", path: /^\/api\/artifacts(?:\/[^/]+)?$/, why: "UI-artifact discovery + recall (route enforces visibility)" },
  // D2 compiler-ABI registry snapshot + historical recall. The sibling
  // /api/compose/:id stays gated (its second segment is never this literal).
  { methods: GET, match: "regex", path: /^\/api\/compose\/registry-snapshot(?:\/[^/]+)?$/, why: "public compiler-ABI registry snapshot" },
];

// ── PUBLIC-BY-DESIGN routes that are not plain GET reads ────────────
// Each is EXACT, each says why a key-less caller must reach it. Adding a line
// here widens the unauthenticated surface — the snapshot test will show it.
const PUBLIC_BY_DESIGN: PublicRoute[] = [
  { methods: POST, match: "exact", path: "/api/auth/provision", why: "self-service key provisioning — this is how a caller GETS a key" },
  // SIWE login bootstrap: requiring a key to reach it is a bootstrap deadlock
  // (verified 401 on production 2026-08-27). EXACT so no /api/auth/verify-*
  // sibling can leak public; verify carries its own per-IP rate limit.
  { methods: GET, match: "exact", path: "/api/auth/nonce", why: "SIWE challenge — issues a single-use nonce (server state, rate-limited); login needs it before any key exists" },
  { methods: POST, match: "exact", path: "/api/auth/verify", why: "SIWE signature verify -> session; the login endpoint itself" },
  { methods: POST, match: "exact", path: "/api/waitlist", why: "public beta waitlist signup (email only, rate-limited)" },
  { methods: POST, match: "exact", path: "/api/beta-apply", why: "public beta-tester application" },
  { methods: POST, match: "exact", path: "/api/feedback", why: "public feedback sink — cold agents have no key (honeypot + per-IP limit)" },
  { methods: POST, match: "exact", path: "/api/feedback/agent-report", why: "keyless agent friction report (pcc_report tool)" },
  // coord dc4d1ec8: public so anyone with a browser can register a capability
  // without first holding a key. Rate-limited + an 8-turn-per-request cap.
  { methods: POST, match: "exact", path: "/api/onboard/chat", why: "layperson conversational onboarding (rate-limited, turn-capped)" },
  { methods: POST, match: "exact", path: "/api/onboard/identify-device", why: "device identification for the install.html landing page" },
  { methods: POST, match: "exact", path: "/api/capabilities/templates/match", why: "heuristic template matcher for the landing-page picker (pure computation)" },
  { methods: POST, match: "exact", path: "/api/capabilities/graph-search", why: "graph search — a read-only query carried in a POST body" },
  { methods: POST, match: "exact", path: "/api/marketplace/roi", why: "ROI calculator (pure computation, stores nothing)" },
  { methods: POST, match: "exact", path: "/api/dht/announce", why: "DHT announce authenticates itself (401s in routes/dht-ws.ts)" },
  // EasyPost / Lob cannot present a PCC key; their authentication IS the
  // verified HMAC in the route (fails closed 503 with no secret, 401 on
  // mismatch) — "being behind an API key is NOT provider authentication".
  { methods: POST, match: "exact", path: "/api/carrier/webhook/easypost", why: "carrier webhook — X-Hmac-Signature verified in routes/carrier.ts (sol #297 f15)" },
  { methods: POST, match: "exact", path: "/api/lob/webhook", why: "Lob webhook — timestamp-bound HMAC verified in routes/lob.ts" },
];

/** The ENTIRE public allowlist. Nothing outside this table skips apiGate. */
const PUBLIC_ROUTES: readonly PublicRoute[] = [
  ...PUBLIC_READ_PREFIXES,
  ...PUBLIC_READ_EXACT,
  ...PUBLIC_READ_REGEX,
  ...PUBLIC_BY_DESIGN,
];

function pathMatches(entry: PublicRoute, path: string): boolean {
  if (entry.match === "regex") return (entry.path as RegExp).test(path);
  if (entry.match === "exact") return path === entry.path;
  return path.startsWith(entry.path as string);
}

/**
 * True when (method, path) is on the public allowlist. HEAD is treated as GET
 * (Fastify serves HEAD with the GET handler). A method an entry does not list
 * is NOT public — it falls through to authentication. Exported for tests.
 */
export function isPublicRoute(url: string, method?: string): boolean {
  const path = url.split("?")[0];
  const m = (method ?? "").toUpperCase();
  const effective = m === "HEAD" ? "GET" : m;
  return PUBLIC_ROUTES.some(
    (entry) => (entry.methods as readonly string[]).includes(effective) && pathMatches(entry, path),
  );
}

/**
 * The public allowlist as stable lines — "<METHOD> <match> <path>" — for the
 * snapshot test (a regex renders as its source). Not used at runtime.
 */
export function publicRouteSnapshot(): string[] {
  return PUBLIC_ROUTES.flatMap((entry) =>
    entry.methods.map(
      (method) =>
        `${method} ${entry.match} ${entry.match === "regex" ? (entry.path as RegExp).source : (entry.path as string)}`,
    ),
  );
}

/** Every public entry that opens a non-GET method, with its justification. */
export function publicWriteJustifications(): Array<{ method: string; path: string; why: string }> {
  return PUBLIC_ROUTES.flatMap((entry) =>
    entry.methods
      .filter((m) => m !== "GET")
      .map((method) => ({ method, path: String(entry.path), why: entry.why })),
  );
}

async function apiGateImpl(app: FastifyInstance) {
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Decide on the route Fastify MATCHED, not the raw request line — otherwise a
    // percent-encoded path (/api/%73ettlement/flush reaching the money handler
    // unauthenticated, or /api/auth/%6eonce 401ing a public endpoint) evades this
    // gate while still running the real handler (sol #309 H1). See authPath.
    const path = authPath(req);

    // Only gate /api/* routes
    if (!path.startsWith("/api/")) return;

    // Skip public routes
    if (isPublicRoute(path, req.method)) return;

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
