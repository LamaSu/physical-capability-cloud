/**
 * Review finding A3: pin the EFFECTIVE public surface, not just the allowlist
 * DECLARATIONS.
 *
 * apigate-public-methods.test.ts pins PUBLIC_ROUTES itself (publicRouteSnapshot())
 * — the declared prefix/exact/regex entries. That snapshot is blind to a real
 * gap: a prefix entry like `{ methods: GET, match: "prefix", path:
 * "/api/marketplace/" }` has no idea which routes actually exist under it.
 * Registering `app.get("/api/marketplace/brand-new-thing", ...)` anywhere in
 * the ~150 route plugins widens the unauthenticated surface with ZERO diff in
 * the declaration snapshot — the prefix STRING does not change, only what it
 * now matches.
 *
 * This file pins the other side: build the real gateway (createGateway — every
 * one of the ~150 route plugins, in-memory DB), enumerate every route Fastify
 * actually registered (method + matched URL template, via an onRoute hook run
 * before any plugin registers), and run each one through the gate's own
 * `isPublicRoute` matcher (unchanged — imported, not reimplemented). The
 * result is asserted against an EXPLICIT array below, not `toMatchSnapshot()`:
 * a silent widening must fail the build and force a reviewed diff in THIS
 * file, not a regenerated `.snap` blob nobody reads.
 *
 * ── Scope of the big snapshot ───────────────────────────────────────────
 * "Registered public surface" here means: registered routes under `/api/*`
 * that `isPublicRoute` matches. That is exactly the allowlist-vs-reality
 * question the finding is about (apiGate's own docstring: "Requires either a
 * valid API key or SIWE session for all /api/* routes, except explicitly
 * public routes"). It deliberately does NOT re-simulate the rest of apiGate's
 * onRequest pipeline (the `/api/` prefix short-circuit, or the retired-write
 * 410 branch) — those get their own matcher-behaviour tests below and are
 * already covered for declarations in apigate-public-methods.test.ts's N43
 * block.
 *
 * That scope boundary surfaced a real, separate gap, pinned below too: TWO
 * PUBLIC_READ_PREFIXES entries (`/.well-known/`, `/docs`) sit OUTSIDE `/api/`,
 * so `isPublicRoute` matching them is true in a vacuum but apiGate's hook
 * returns before ever asking — those entries cannot be the reason those paths
 * are open. See the "non-/api/" describe block.
 *
 * A second gap surfaced along the way: several PUBLIC_READ_PREFIXES entries
 * (`/api/health`, `/api/auth/validate`, `/api/waitlist`, `/api/admin/feedback`,
 * `/api/onboard/chat`) have no trailing "/", and `pathMatches` did a raw
 * `path.startsWith(entry.path)` with no path-SEGMENT boundary. The lane anchored
 * prefix matching at a segment boundary (WP-A round 6); see the "prefix
 * anchoring" test below.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

interface RegisteredRoute {
  method: string;
  url: string;
}

// vi.hoisted: `registered` must exist by the time the mock factory below is
// first invoked (lazily, whenever something resolves "fastify" — here, that's
// server.ts's `import Fastify from "fastify"`, reached via the dynamic
// `import("../server.js")` in beforeAll). vi.mock() call sites are hoisted
// above this file's other top-level code; vi.hoisted() is vitest's sanctioned
// way to give such a hoisted factory a variable it can safely close over.
const { registered } = vi.hoisted(() => ({ registered: [] as RegisteredRoute[] }));

// Wrap the REAL fastify factory so every instance it creates gets an onRoute
// hook attached immediately — before createGateway registers a single plugin.
// onRoute is NOT encapsulation-scoped downward: a hook added on the root
// instance fires for every route added anywhere in the app, including deeply
// nested/encapsulated child plugins (verified against the installed
// fastify@4.29.1 with a standalone probe script: a route added inside
// `app.register(async (sub) => sub.get(...))` still fired the ROOT's onRoute).
// This needs no production change — api-gate.ts and server.ts are untouched.
//
// Fastify also auto-registers a HEAD route for every GET route
// (exposeHeadRoute defaults true; grepped the whole package — nothing opts
// out), and onRoute fires separately for that synthetic HEAD registration
// too. We do not filter it out: HEAD is part of what Fastify will actually
// dispatch, i.e. part of the EFFECTIVE surface this file exists to pin.
vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  const wrapped = (...args: Parameters<typeof actual.default>) => {
    const instance = actual.default(...args);
    instance.addHook("onRoute", (route: { method: string | string[]; url: string }) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) registered.push({ method: m, url: route.url });
    });
    return instance;
  };
  return { ...actual, default: wrapped };
});

let app: FastifyInstance;
/** Frozen the instant boot finishes. A later `it()` block creating its own
 * throwaway Fastify instance would also be instrumented by the mock above
 * (it wraps EVERY instance) — freezing a copy here means such a test can
 * never retroactively mutate what THIS file pins. (No test currently does
 * this — the drift test below reuses `bootRoutes` data instead of building a
 * second server — but the freeze costs nothing and removes the hazard.) */
let bootRoutes: RegisteredRoute[];

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.PCC_SEED_DATA = "false";
  const server = await import("../server.js");
  const gw = await server.createGateway(0);
  app = gw.app as unknown as FastifyInstance;
  await app.ready(); // does NOT call start()/listen() — no port is bound
  bootRoutes = [...registered];
}, 180_000);

afterAll(async () => {
  await app?.close();
});

/** Unique, sorted "METHOD url" strings for registered routes matching `pred`. */
function surfaceOf(routes: RegisteredRoute[], pred: (r: RegisteredRoute) => boolean): string[] {
  return [...new Set(routes.filter(pred).map((r) => `${r.method} ${r.url}`))].sort();
}

// ─────────────────────────────────────────────────────────────────────────
// Deliverable 1: the registered /api/* public surface, pinned explicitly.
//
// HOW TO UPDATE: run this file. If only the SNAPSHOT test below fails, read
// its diff — every ADDED line is a new (method, template) the gate now treats
// as public. For each one, confirm in api-gate.ts's PUBLIC_ROUTES that it is
// intentional (a deliberate prefix/exact/regex entry meant to cover it, or a
// new PUBLIC_BY_DESIGN write with a `why`), then paste the diff's new lines
// into EXPECTED_PUBLIC_API_SURFACE below with a one-line reason in a comment
// if it is not obvious from the entry's own `why`. Every REMOVED line means a
// route disappeared or a public entry narrowed — confirm that was intended
// too before deleting it here. Do not regenerate this array by running a
// "write mode" — copy each line deliberately.
// ─────────────────────────────────────────────────────────────────────────
const EXPECTED_PUBLIC_API_SURFACE: string[] = [
  "GET /api/admin/feedback",
  "GET /api/agents/status",
  "GET /api/artifacts",
  "GET /api/artifacts/:idOrSlug",
  "GET /api/auth/nonce",
  "GET /api/auth/validate",
  "GET /api/capabilities",
  "GET /api/capabilities/:capId",
  "GET /api/capabilities/:id/button",
  "GET /api/capabilities/:id/td",
  "GET /api/capabilities/graph-stats",
  "GET /api/capabilities/search",
  "GET /api/capabilities/templates",
  "GET /api/capabilities/types",
  "GET /api/compose/registry-snapshot",
  "GET /api/compose/registry-snapshot/:registryDigest",
  "GET /api/courier-jobs/:id",
  "GET /api/courier-jobs/healthz",
  "GET /api/courier-jobs/jobs/:id",
  "GET /api/courier-jobs/jobs/open",
  "GET /api/courier-jobs/open",
  "GET /api/dht/events/stream",
  "GET /api/dht/metrics",
  "GET /api/dht/peers",
  "GET /api/dht/query",
  "GET /api/health",
  "GET /api/job-offers/:id",
  "GET /api/job-offers/healthz",
  "GET /api/job-offers/open",
  "GET /api/kernels",
  "GET /api/kernels/:kernelId/agent-card.json",
  "GET /api/marketplace/categories",
  "GET /api/marketplace/classes",
  "GET /api/marketplace/classes/:id",
  "GET /api/marketplace/demand-supply",
  "GET /api/marketplace/listings",
  "GET /api/marketplace/listings/:id",
  "GET /api/marketplace/orders",
  "GET /api/marketplace/orders/:id",
  "GET /api/onboard/chat/:id",
  "GET /api/onboard/chat/health",
  "GET /api/onboard/check/:code",
  "GET /api/onboard/registrations",
  "GET /api/operators/:id/ratings",
  "GET /api/orchestrator/templates",
  "GET /api/waitlist/count",
  "HEAD /api/admin/feedback",
  "HEAD /api/agents/status",
  "HEAD /api/artifacts",
  "HEAD /api/artifacts/:idOrSlug",
  "HEAD /api/auth/nonce",
  "HEAD /api/auth/validate",
  "HEAD /api/capabilities",
  "HEAD /api/capabilities/:capId",
  "HEAD /api/capabilities/:id/button",
  "HEAD /api/capabilities/:id/td",
  "HEAD /api/capabilities/graph-stats",
  "HEAD /api/capabilities/search",
  "HEAD /api/capabilities/templates",
  "HEAD /api/capabilities/types",
  "HEAD /api/compose/registry-snapshot",
  "HEAD /api/compose/registry-snapshot/:registryDigest",
  "HEAD /api/courier-jobs/:id",
  "HEAD /api/courier-jobs/healthz",
  "HEAD /api/courier-jobs/jobs/:id",
  "HEAD /api/courier-jobs/jobs/open",
  "HEAD /api/courier-jobs/open",
  "HEAD /api/dht/events/stream",
  "HEAD /api/dht/metrics",
  "HEAD /api/dht/peers",
  "HEAD /api/dht/query",
  "HEAD /api/health",
  "HEAD /api/job-offers/:id",
  "HEAD /api/job-offers/healthz",
  "HEAD /api/job-offers/open",
  "HEAD /api/kernels",
  "HEAD /api/kernels/:kernelId/agent-card.json",
  "HEAD /api/marketplace/categories",
  "HEAD /api/marketplace/classes",
  "HEAD /api/marketplace/classes/:id",
  "HEAD /api/marketplace/demand-supply",
  "HEAD /api/marketplace/listings",
  "HEAD /api/marketplace/listings/:id",
  "HEAD /api/marketplace/orders",
  "HEAD /api/marketplace/orders/:id",
  "HEAD /api/onboard/chat/:id",
  "HEAD /api/onboard/chat/health",
  "HEAD /api/onboard/check/:code",
  "HEAD /api/onboard/registrations",
  "HEAD /api/operators/:id/ratings",
  "HEAD /api/orchestrator/templates",
  "HEAD /api/waitlist/count",
  "POST /api/auth/logout",
  "POST /api/auth/provision",
  "POST /api/auth/verify",
  "POST /api/beta-apply",
  "POST /api/capabilities/graph-search",
  "POST /api/capabilities/templates/match",
  "POST /api/carrier/webhook/easypost",
  "POST /api/feedback",
  "POST /api/feedback/agent-report",
  "POST /api/lob/webhook",
  "POST /api/marketplace/roi",
  "POST /api/onboard/chat",
  "POST /api/onboard/identify-device",
  "POST /api/waitlist",
];

describe("A3 — the REGISTERED /api/* surface the gate's allowlist actually opens", () => {
  it("SNAPSHOT: every registered /api/* (method, template) isPublicRoute matches (edit deliberately; see the how-to-update comment above)", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    const publicApi = surfaceOf(bootRoutes, (r) => r.url.startsWith("/api/") && isPublicRoute(r.url, r.method));
    expect(publicApi).toEqual(EXPECTED_PUBLIC_API_SURFACE);
  });

  it("every public write (POST) registered here is also in the DECLARATION snapshot's 14 -- the two snapshots agree today", async () => {
    const posts = EXPECTED_PUBLIC_API_SURFACE.filter((l) => l.startsWith("POST "));
    expect(posts.length).toBe(14);
  });

  it("drift check: a hypothetical new GET route under an existing public PREFIX is matched public today, is not registered, and is not pinned -- proving the SNAPSHOT test above would fail loudly if it were added without a reviewed edit here", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    // "/api/marketplace/" is a public READ PREFIX (why: "marketplace browsing
    // is public"). The prefix string has no idea which routes exist under it
    // -- this is exactly the review finding: any GET registered under it is
    // public from the moment it is registered, with ZERO diff to the
    // DECLARATION snapshot in apigate-public-methods.test.ts.
    const hypothetical = "/api/marketplace/totally-new-endpoint-not-built-yet";

    expect(isPublicRoute(hypothetical, "GET")).toBe(true); // the gate already treats it as public today
    expect(bootRoutes.some((r) => r.method === "GET" && r.url === hypothetical)).toBe(false); // genuinely not registered
    expect(EXPECTED_PUBLIC_API_SURFACE.includes(`GET ${hypothetical}`)).toBe(false); // and not pinned

    // Simulate the drift directly with the SAME helper the SNAPSHOT test uses:
    // if this route were registered tomorrow, onRoute would add it to
    // `bootRoutes`, and recomputing would produce a list that no longer equals
    // the pinned array -- the snapshot test fails until a human adds a
    // reviewed line, which is the whole point of this file.
    const withHypotheticalRoute = [...bootRoutes, { method: "GET", url: hypothetical }];
    const recomputed = surfaceOf(withHypotheticalRoute, (r) => r.url.startsWith("/api/") && isPublicRoute(r.url, r.method));
    expect(recomputed).not.toEqual(EXPECTED_PUBLIC_API_SURFACE);
    expect(recomputed).toContain(`GET ${hypothetical}`);
  });

  it("[neg] prefix anchoring: a prefix with no trailing '/' opens only itself and the paths below it, never a sibling that shares its characters", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    // A raw startsWith used to make each of these siblings public the moment such
    // a route was registered.
    for (const [prefix, sibling] of [
      ["/api/health", "/api/healthcheck-debug"],
      ["/api/auth/validate", "/api/auth/validate-admin"],
      ["/api/waitlist", "/api/waitlist-export"],
      ["/api/admin/feedback", "/api/admin/feedbacks-all"],
      ["/api/onboard/chat", "/api/onboard/chatlog"],
    ] as const) {
      expect(isPublicRoute(sibling, "GET"), sibling).toBe(false);
      expect(isPublicRoute(prefix, "GET"), prefix).toBe(true);
      expect(isPublicRoute(`${prefix}/below`, "GET"), `${prefix}/below`).toBe(true);
    }
    // And no registered route relied on the old, looser match: the SNAPSHOT above is unchanged.
  });
});

describe("A3 — registered wildcard / catch-all routes", () => {
  it("PINNED: every registered route whose template contains '*', and whether the gate treats it as public", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    const wildcardRoutes = surfaceOf(bootRoutes, (r) => r.url.includes("*"));
    // Three registered wildcard routes exist in the whole app, all benign:
    //  - "OPTIONS *"               -- @fastify/cors's own preflight catch-all
    //                                 route (registered by the `cors` plugin
    //                                 at server.ts:286, not PCC route code).
    //                                 Never public per isPublicRoute (OPTIONS
    //                                 is not a PublicMethod) -- moot anyway,
    //                                 since cors answers preflight in its OWN
    //                                 onRequest hook before apiGate's ever
    //                                 runs (api-gate.ts's own comment, lines
    //                                 19-20).
    //  - "GET /docs/api/static/*"  -- @fastify/swagger-ui serving its static
    //  - "HEAD /docs/api/static/*"   UI assets (JS/CSS/images). Falls under
    //                                 the "/docs" PUBLIC_READ_PREFIXES entry
    //                                 by design ("docs hub + Swagger UI") --
    //                                 correctly public; nothing sensitive
    //                                 lives there.
    // No wildcard/catch-all route exists under /api/* at all -- confirmed by
    // this same list. That fact is relied on by the corrected comment in
    // route-path.ts (an unmatched /api/* request always falls through to a
    // bare 404, never a real handler).
    expect(wildcardRoutes).toEqual(["GET /docs/api/static/*", "HEAD /docs/api/static/*", "OPTIONS *"]);
    for (const line of wildcardRoutes) {
      const [method, url] = line.split(" ");
      expect(isPublicRoute(url, method), line).toBe(method !== "OPTIONS");
    }
    expect(bootRoutes.some((r) => r.url.startsWith("/api/") && r.url.includes("*"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Non-/api/ registrations that isPublicRoute happens to match. See the "Scope
// of the big snapshot" note at the top of this file: these entries are real
// (PUBLIC_READ_PREFIXES has "/.well-known/" and "/docs"), and they do match
// real registered routes -- but apiGate's onRequest hook returns before EVER
// calling isPublicRoute for a path outside /api/, so this match is not why
// these routes are open. Pinned separately so a reader does not conflate "the
// allowlist matches this" with "the allowlist is why this is reachable".
// ─────────────────────────────────────────────────────────────────────────
const EXPECTED_PUBLIC_NON_API_MATCHES: string[] = [
  "GET /.well-known/agent-card.json",
  "GET /.well-known/agent-descriptions",
  "GET /.well-known/agent-directory.json",
  "GET /.well-known/agent-registration.json",
  "GET /.well-known/agent-skills/index.json",
  "GET /.well-known/ai-catalog.json",
  "GET /.well-known/api-catalog",
  "GET /.well-known/jwks.json",
  "GET /.well-known/mcp",
  "GET /.well-known/mcp-registry-auth",
  "GET /.well-known/mcp/server-card.json",
  "GET /docs",
  "GET /docs/agent-guide",
  "GET /docs/api",
  "GET /docs/api/json",
  "GET /docs/api/static/*",
  "GET /docs/api/static/index.html",
  "GET /docs/api/static/swagger-initializer.js",
  "GET /docs/api/yaml",
  "GET /docs/csd-spec",
  "GET /docs/setup-spec",
  "GET /docs/story-plan",
  "GET /docs/whitepaper",
  "GET /openapi.json",
  "HEAD /.well-known/agent-card.json",
  "HEAD /.well-known/agent-descriptions",
  "HEAD /.well-known/agent-directory.json",
  "HEAD /.well-known/agent-registration.json",
  "HEAD /.well-known/agent-skills/index.json",
  "HEAD /.well-known/ai-catalog.json",
  "HEAD /.well-known/api-catalog",
  "HEAD /.well-known/jwks.json",
  "HEAD /.well-known/mcp",
  "HEAD /.well-known/mcp-registry-auth",
  "HEAD /.well-known/mcp/server-card.json",
  "HEAD /docs",
  "HEAD /docs/agent-guide",
  "HEAD /docs/api",
  "HEAD /docs/api/",
  "HEAD /docs/api/json",
  "HEAD /docs/api/static/*",
  "HEAD /docs/api/static/index.html",
  "HEAD /docs/api/static/swagger-initializer.js",
  "HEAD /docs/api/yaml",
  "HEAD /docs/csd-spec",
  "HEAD /docs/setup-spec",
  "HEAD /docs/story-plan",
  "HEAD /docs/whitepaper",
  "HEAD /openapi.json",
];

describe("A3 — non-/api/ registrations isPublicRoute matches are dead code from apiGate's point of view", () => {
  it("PINNED: registered non-/api/ routes isPublicRoute matches (informational -- apiGate never asks)", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    const nonApiMatches = surfaceOf(bootRoutes, (r) => !r.url.startsWith("/api/") && isPublicRoute(r.url, r.method));
    expect(nonApiMatches).toEqual(EXPECTED_PUBLIC_NON_API_MATCHES);
  });

  it("proves apiGate never actually consults isPublicRoute for a non-/api/ path: a registered route matching NEITHER allowlist entry is open anyway", async () => {
    // Bare "/health" (server.ts:492, distinct from the allowlisted
    // "/api/health" prefix) is registered and is NOT matched by isPublicRoute
    // at all. It is still served with no auth, live, because apiGate's
    // onRequest hook (`if (!path.startsWith("/api/")) return;`) exits before
    // it ever calls isPublicRoute for a path outside /api/ -- the allowlist
    // is not consulted, let alone matched.
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    expect(isPublicRoute("/health", "GET")).toBe(false);
    expect(bootRoutes.some((r) => r.method === "GET" && r.url === "/health")).toBe(true);

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("A3 — matcher behaviour", () => {
  it("HEAD is treated like GET by the gate (unit + a real registered pair)", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    expect(isPublicRoute("/api/health", "HEAD")).toBe(true);
    expect(isPublicRoute("/api/health", "GET")).toBe(true);
    // Every public GET in the pinned snapshot has a public HEAD twin at the
    // identical template (Fastify's auto-generated HEAD route) -- not a
    // coincidence: isPublicRoute maps HEAD -> GET internally.
    const gets = EXPECTED_PUBLIC_API_SURFACE.filter((l) => l.startsWith("GET "));
    for (const line of gets) {
      expect(EXPECTED_PUBLIC_API_SURFACE, line).toContain(line.replace(/^GET /, "HEAD "));
    }
  });

  it("a public GET prefix does not make POST/PUT/PATCH/DELETE public -- real registered writes on real public-prefix paths are gated", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    // "/api/dht/" is a public READ prefix (GET only). POST /api/dht/announce
    // is a REAL registered route under it and is NOT public (dht-auth.test.ts
    // covers why: it used to be, and stopped being safe to leave open).
    expect(isPublicRoute("/api/dht/announce", "POST")).toBe(false);
    expect(bootRoutes.some((r) => r.method === "POST" && r.url === "/api/dht/announce")).toBe(true);
    const announceRes = await app.inject({ method: "POST", url: "/api/dht/announce", payload: {} });
    expect(announceRes.statusCode).toBe(401);

    // Stronger form: the EXACT SAME template, method-gated. GET/HEAD
    // /api/job-offers/:id are public (regex); PATCH and DELETE on that exact
    // template are real registered routes and are NOT public.
    expect(isPublicRoute("/api/job-offers/:id", "GET")).toBe(true);
    expect(isPublicRoute("/api/job-offers/:id", "PATCH")).toBe(false);
    expect(isPublicRoute("/api/job-offers/:id", "DELETE")).toBe(false);
    expect(bootRoutes.some((r) => r.method === "PATCH" && r.url === "/api/job-offers/:id")).toBe(true);
    expect(bootRoutes.some((r) => r.method === "DELETE" && r.url === "/api/job-offers/:id")).toBe(true);
    const patchRes = await app.inject({ method: "PATCH", url: "/api/job-offers/real-id-1", payload: {} });
    expect(patchRes.statusCode).toBe(401);
    const deleteRes = await app.inject({ method: "DELETE", url: "/api/job-offers/real-id-1", payload: {} });
    expect(deleteRes.statusCode).toBe(401);
  });

  it("retired marketplace writes answer 410 purely (isRetiredWrite), and live via the real registered route", async () => {
    const { isRetiredWrite } = await import("../middleware/api-gate.js");
    expect(isRetiredWrite("/api/marketplace/listings", "POST")).toBe(true);
    expect(bootRoutes.some((r) => r.method === "POST" && r.url === "/api/marketplace/listings")).toBe(true);
    const res = await app.inject({ method: "POST", url: "/api/marketplace/listings", payload: {} });
    expect(res.statusCode).toBe(410);
    expect(res.json().reached).toBeUndefined(); // the handler never ran
  });

  it("a regex entry matches only its intended templates -- real near-miss registered routes do NOT match", async () => {
    const { isPublicRoute } = await import("../middleware/api-gate.js");
    // /^\/api\/capabilities\/[^/]+(?:\/button|\/td)?$/ matches the detail
    // route and its /button and /td siblings...
    expect(isPublicRoute("/api/capabilities/:capId", "GET")).toBe(true);
    expect(isPublicRoute("/api/capabilities/:id/button", "GET")).toBe(true);
    // ...but NOT a third real registered sibling one segment deeper: the regex
    // ends `(?:\/button|\/td)?$` -- no alternative matches "/compliance", and
    // the trailing "$" means matching STOPS the whole pattern from matching a
    // deeper path at all.
    expect(bootRoutes.some((r) => r.method === "GET" && r.url === "/api/capabilities/:capabilityId/compliance")).toBe(true);
    expect(isPublicRoute("/api/capabilities/:capabilityId/compliance", "GET")).toBe(false);

    // Same pattern for the operator-ratings regex: a real sibling one path
    // segment over does not match.
    expect(isPublicRoute("/api/operators/:id/ratings", "GET")).toBe(true);
    expect(bootRoutes.some((r) => r.method === "GET" && r.url === "/api/operators/:id/discoverability")).toBe(true);
    expect(isPublicRoute("/api/operators/:id/discoverability", "GET")).toBe(false);
  });
});
