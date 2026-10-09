/**
 * Board N43: pin the REGISTERED public surface, not just the allowlist declarations.
 *
 * A declaration-only pin is blind to what a prefix entry actually opens: registering
 * `app.get("/api/marketplace/brand-new-thing", ...)` widens the unauthenticated surface with no change
 * to any allowlist string (review #2829 / WP-A round 6, review A3). So this file builds the real gateway
 * (createGateway: every route plugin, in-memory DB), records every route Fastify registers with an
 * onRoute hook, substitutes a sample value for each path parameter, and runs each (method, path)
 * through the gate's own exported matcher, `isPublicRoute`. The result is compared with an EXPLICIT
 * array, not `toMatchSnapshot()`: a widening must fail here and force a reviewed edit of this file.
 *
 * Scope: registered /api/* routes, the only paths apiGate judges (its hook returns early for any other
 * path). The retired-write 410 branch is pinned separately below and, end to end, in
 * n43-public-allowlist-methods.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";

interface RegisteredRoute {
  method: string;
  url: string;
}

// vi.hoisted: the mock factory below closes over `registered`, and vi.mock calls are hoisted above
// the rest of this file.
const { registered } = vi.hoisted(() => ({ registered: [] as RegisteredRoute[] }));

// Wrap the real fastify factory so every instance gets an onRoute hook before createGateway registers
// a single plugin. A root onRoute hook fires for routes added in encapsulated child plugins too, and
// for the HEAD route Fastify adds for every GET (exposeHeadRoute). No production code changes.
vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  // The factory is overloaded (so Parameters<> of it is never): forward its arguments as they come.
  const factory = actual.default as unknown as (...args: unknown[]) => FastifyInstance;
  const wrapped = (...args: unknown[]) => {
    const instance = factory(...args);
    instance.addHook("onRoute", (route: { method: string | string[]; url: string }) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) registered.push({ method: m, url: route.url });
    });
    return instance;
  };
  return { ...actual, default: wrapped };
});

let app: FastifyInstance;
/** Frozen when boot finishes, so nothing a later test does can change what this file pins. */
let bootRoutes: RegisteredRoute[];
type Matcher = (url: string, method?: string) => boolean;
let isPublicRoute: Matcher;

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.PCC_SEED_DATA = "false";
  const server = await import("../server.js");
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready(); // no start()/listen(): no port is bound
  bootRoutes = [...registered];
  const gate = (await import("../middleware/api-gate.js")) as { isPublicRoute?: Matcher };
  isPublicRoute = gate.isPublicRoute as Matcher;
}, 180_000);

afterAll(async () => {
  await app?.close();
});

/**
 * A concrete path for a route template: ":param" (with any regex constraint) becomes "p-param" and
 * "*" becomes "p-wild". The gate judges the request path, never the template.
 */
function samplePath(template: string): string {
  return template
    .split("/")
    .map((seg) => (seg === "*" ? "p-wild" : seg.startsWith(":") ? `p-${seg.slice(1).replace(/\(.*$/, "")}` : seg))
    .join("/");
}

const isPublic = (r: RegisteredRoute) => isPublicRoute(samplePath(r.url), r.method);

/** Unique, sorted "METHOD template" strings for the registered routes matching `pred`. */
function surfaceOf(routes: RegisteredRoute[], pred: (r: RegisteredRoute) => boolean): string[] {
  return [...new Set(routes.filter(pred).map((r) => `${r.method} ${r.url}`))].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// The registered /api/* public surface, pinned explicitly.
//
// HOW TO UPDATE: if only the SNAPSHOT test fails, read its diff. Every ADDED line is a (method, route)
// that is now public. Confirm in api-gate.ts's PUBLIC_ROUTES that it is intended (a deliberate read
// entry, or a public-by-design write with its `why`), then add the line here. Every REMOVED line is a
// route that disappeared or an entry that narrowed; confirm that too. Copy each line deliberately;
// never regenerate this array.
//
// Against master 7d0c27ca (101 pairs) this is: minus POST /api/dht/announce and the four retired
// marketplace writes (POST /api/marketplace/listings, PUT and DELETE /api/marketplace/listings/:id,
// POST /api/marketplace/orders); plus the HEAD twin of eight public GETs that master opened for GET
// only (HEAD follows GET: Fastify answers HEAD with the same handler and no body).
// ─────────────────────────────────────────────────────────────────────────────
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
  "POST /api/auth/provision",
  "POST /api/auth/verify",
  "POST /api/beta-apply",
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

describe("N43: the registered /api/* surface the gate's allowlist opens", () => {
  it("SNAPSHOT: every registered /api/* (method, route) that isPublicRoute opens (edit deliberately; see HOW TO UPDATE)", () => {
    expect(isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    const publicApi = surfaceOf(bootRoutes, (r) => r.url.startsWith("/api/") && isPublic(r));
    expect(publicApi).toEqual(EXPECTED_PUBLIC_API_SURFACE);
  });

  it("the only public writes are the twelve public-by-design POSTs: no PUT, PATCH or DELETE is public anywhere under /api", () => {
    expect(isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    const writes = surfaceOf(bootRoutes, (r) => r.url.startsWith("/api/") && r.method !== "GET" && r.method !== "HEAD" && isPublic(r));
    expect(writes).toEqual(EXPECTED_PUBLIC_API_SURFACE.filter((l) => !l.startsWith("GET ") && !l.startsWith("HEAD ")));
    expect(writes.every((l) => l.startsWith("POST "))).toBe(true);
    expect(writes).toHaveLength(12);
  });

  it("HEAD follows GET: the public HEAD set is exactly the public GET set", () => {
    const gets = EXPECTED_PUBLIC_API_SURFACE.filter((l) => l.startsWith("GET ")).map((l) => l.slice(4));
    const heads = EXPECTED_PUBLIC_API_SURFACE.filter((l) => l.startsWith("HEAD ")).map((l) => l.slice(5));
    expect(heads).toEqual(gets);
  });

  it("drift check: a new GET under a public prefix would be public the moment it is registered, so the SNAPSHOT would fail until this file is edited", () => {
    expect(isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    const hypothetical = { method: "GET", url: "/api/marketplace/totally-new-endpoint-not-built-yet" };
    expect(isPublic(hypothetical)).toBe(true);
    expect(bootRoutes.some((r) => r.method === hypothetical.method && r.url === hypothetical.url)).toBe(false);
    const recomputed = surfaceOf([...bootRoutes, hypothetical], (r) => r.url.startsWith("/api/") && isPublic(r));
    expect(recomputed).not.toEqual(EXPECTED_PUBLIC_API_SURFACE);
    expect(recomputed).toContain(`GET ${hypothetical.url}`);
  });

  it("a public GET prefix does not open the real writes registered under it: DHT announce and the marketplace writes", async () => {
    expect(isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    const { isRetiredWrite } = (await import("../middleware/api-gate.js")) as { isRetiredWrite?: Matcher };
    expect(isRetiredWrite, "api-gate.ts exports isRetiredWrite").toBeTypeOf("function");
    for (const [method, url, retired] of [
      ["POST", "/api/dht/announce", false],
      ["POST", "/api/marketplace/listings", true],
      ["PUT", "/api/marketplace/listings/:id", true],
      ["DELETE", "/api/marketplace/listings/:id", true],
      ["POST", "/api/marketplace/orders", true],
    ] as const) {
      const route = { method, url };
      expect(bootRoutes.some((r) => r.method === method && r.url === url), `${method} ${url} is registered`).toBe(true);
      expect(isPublic(route), `${method} ${url} is not public`).toBe(false);
      expect(isRetiredWrite!(samplePath(url), method), `${method} ${url} retired?`).toBe(retired);
    }
    // The one public-by-design write under the marketplace prefix is public and not retired.
    expect(isPublicRoute("/api/marketplace/roi", "POST")).toBe(true);
    expect(isRetiredWrite!("/api/marketplace/roi", "POST")).toBe(false);
    // Reads, HEAD and OPTIONS are never retired writes (@fastify/cors answers preflight first).
    for (const method of ["GET", "HEAD", "OPTIONS"]) expect(isRetiredWrite!("/api/marketplace/listings", method), method).toBe(false);
  });
});

describe("N43: registered wildcard routes", () => {
  it("PINNED: every registered route whose template contains '*', and whether the gate opens it", () => {
    expect(isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    // OPTIONS *: @fastify/cors's preflight route. /docs/api/static/*: Swagger UI assets, under the
    // public /docs prefix (outside /api, which apiGate never judges). /api/ot2/*: the retired OT-2
    // surface (routes/ot2-legacy-gone.ts), registered for every method and public for none.
    const wildcards = surfaceOf(bootRoutes, (r) => r.url.includes("*"));
    expect(wildcards).toEqual([
      "COPY /api/ot2/*",
      "DELETE /api/ot2/*",
      "GET /api/ot2/*",
      "GET /docs/api/static/*",
      "HEAD /api/ot2/*",
      "HEAD /docs/api/static/*",
      "LOCK /api/ot2/*",
      "MKCALENDAR /api/ot2/*",
      "MKCOL /api/ot2/*",
      "MOVE /api/ot2/*",
      "OPTIONS *",
      "OPTIONS /api/ot2/*",
      "PATCH /api/ot2/*",
      "POST /api/ot2/*",
      "PROPFIND /api/ot2/*",
      "PROPPATCH /api/ot2/*",
      "PUT /api/ot2/*",
      "REPORT /api/ot2/*",
      "SEARCH /api/ot2/*",
      "TRACE /api/ot2/*",
      "UNLOCK /api/ot2/*",
    ]);
    expect(surfaceOf(bootRoutes, (r) => r.url.includes("*") && isPublic(r))).toEqual(["GET /docs/api/static/*", "HEAD /docs/api/static/*"]);
  });
});

// Non-/api registrations the allowlist matches. apiGate returns before it consults the allowlist for
// any path outside /api/, so these entries are not why these routes are open; they are pinned so a
// change to /.well-known/, /docs or /openapi.json still shows up as a diff.
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

describe("N43: non-/api registrations (apiGate never judges them)", () => {
  it("PINNED: the registered non-/api routes the allowlist matches", () => {
    expect(isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    expect(surfaceOf(bootRoutes, (r) => !r.url.startsWith("/api/") && isPublic(r))).toEqual(EXPECTED_PUBLIC_NON_API_MATCHES);
  });

  it("the DHT WebSocket (GET /ws/dht) is outside /api, matched by no entry, and its status does not change here", () => {
    expect(isPublicRoute, "api-gate.ts exports isPublicRoute").toBeTypeOf("function");
    expect(bootRoutes.some((r) => r.method === "GET" && r.url === "/ws/dht")).toBe(true);
    expect(isPublicRoute("/ws/dht", "GET")).toBe(false);
  });
});
