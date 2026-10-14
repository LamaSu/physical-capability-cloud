/**
 * Board N43: pin the REGISTERED public surface, not just the allowlist declarations.
 *
 * A declaration-only pin is blind to what a prefix entry actually opens: registering
 * `app.get("/api/marketplace/brand-new-thing", ...)` widens the unauthenticated surface with no change
 * to any allowlist string (review #2829 / WP-A round 6, review A3). So this file builds the real gateway
 * (createGateway: every route plugin, in-memory DB), records every route Fastify registers with an
 * onRoute hook and uses the gate's own exported matcher, `isPublicRoute`. The sampled surface is
 * complemented by declaration and template-intersection pins, so parameter-specific exemptions
 * cannot disappear behind a private sample. A second boot captures production static registration;
 * the authoritative dashboard public/api inventory is pinned too. All pins are EXPLICIT arrays:
 * a widening must fail here and force a reviewed edit of this file.
 *
 * Scope: registered /api/* routes, the only paths apiGate judges (its hook returns early for any other
 * path). The retired-write 410 branch is pinned separately below and, end to end, in
 * n43-public-allowlist-methods.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PublicRoute } from "../middleware/api-gate.js";

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
let productionRoutes: RegisteredRoute[];
let dashboardFixture: string;
let declarations: readonly PublicRoute[];
type Matcher = (url: string, method?: string) => boolean;
let isPublicRoute: Matcher;
const environmentKeys = ["PCC_DB_PATH", "NODE_ENV", "PCC_SEED_DATA", "SERVE_DASHBOARD", "DASHBOARD_PATH"] as const;
const savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

beforeAll(async () => {
  process.env.PCC_DB_PATH = ":memory:";
  process.env.NODE_ENV = "test";
  process.env.PCC_SEED_DATA = "false";
  // Both registration-affecting values are explicit, even when the static branch is disabled.
  process.env.SERVE_DASHBOARD = "false";
  process.env.DASHBOARD_PATH = fileURLToPath(new URL("../../../../tmp/n43-dashboard-unused", import.meta.url));
  const server = await import("../server.js");
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready(); // no start()/listen(): no port is bound
  bootRoutes = [...registered];
  const gate = await import("../middleware/api-gate.js");
  isPublicRoute = gate.isPublicRoute;
  declarations = gate.PUBLIC_ROUTES;

  // Close before the second boot because createGateway initialises a shared database store.
  await app.close();
  registered.length = 0;
  dashboardFixture = await mkdtemp(join(tmpdir(), "n43-dashboard-"));
  await mkdir(join(dashboardFixture, "api/agent"), { recursive: true });
  await mkdir(join(dashboardFixture, "api/marketplace"), { recursive: true });
  await writeFile(join(dashboardFixture, "index.html"), "<!doctype html><title>N43 fixture</title>");
  await writeFile(join(dashboardFixture, "api/agent/tools.json"), '{"tools":[]}');
  await writeFile(join(dashboardFixture, "api/marketplace/preview.json"), '{"preview":true}');
  process.env.SERVE_DASHBOARD = "true";
  process.env.DASHBOARD_PATH = dashboardFixture;
  app = (await server.createGateway(0)).app as unknown as FastifyInstance;
  await app.ready();
  productionRoutes = [...registered];
}, 180_000);

afterAll(async () => {
  await app?.close();
  if (dashboardFixture) await rm(dashboardFixture, { recursive: true, force: true });
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

function normalizedDeclarations(entries: readonly PublicRoute[]) {
  return entries.map((entry) => [
    [...entry.methods],
    entry.methods[0] === "GET" ? ("head" in entry ? entry.head ?? "follow-get" : "follow-get") : null,
    entry.match,
    typeof entry.path === "string" ? entry.path : null,
    entry.path instanceof RegExp ? entry.path.source : null,
    entry.path instanceof RegExp ? entry.path.flags : null,
    entry.why,
  ]);
}

type Intersection = "INTERSECTS" | "AMBIGUOUS" | "DISJOINT";

function declaresMethod(entry: PublicRoute, method: string): boolean {
  return method === "HEAD"
    ? entry.methods[0] === "GET" && ("head" in entry ? entry.head ?? "follow-get" : "follow-get") === "follow-get"
    : (entry.methods as readonly string[]).includes(method);
}

/** Segment unification: a parameter can equal any literal; a wildcard can equal any suffix. */
function unifyLiteral(template: string, literal: string, kind: "exact" | "prefix"): Intersection {
  const route = template.slice(1).split("/");
  const target = literal.slice(1).replace(/\/$/, "").split("/");
  const requiresSuffix = kind === "prefix" && literal.endsWith("/");
  let ambiguous = false;
  for (let i = 0; i < target.length; i++) {
    const segment = route[i];
    if (segment === "*") return ambiguous ? "AMBIGUOUS" : "INTERSECTS";
    if (segment === undefined) return "DISJOINT";
    if (segment.startsWith(":")) {
      // Constraints and compound parameters need review; do not pretend to solve their language.
      if (!/^:[A-Za-z0-9_]+$/.test(segment)) ambiguous = true;
    } else if (segment.includes(":") || segment.includes("*")) {
      ambiguous = true;
    } else if (segment !== target[i]) {
      return "DISJOINT";
    }
  }
  if (kind === "exact" && route.length !== target.length && route[target.length] !== "*") return "DISJOINT";
  if (requiresSuffix && route.length <= target.length) return "DISJOINT";
  return ambiguous ? "AMBIGUOUS" : "INTERSECTS";
}

/** Extract only complete literal segments before the first regex construct. */
function anchoredLiteralPrefix(regex: RegExp): string | null {
  // Multiline and case-insensitive expressions can match outside this literal prefix.
  if (!regex.source.startsWith("^") || regex.flags.includes("m") || regex.flags.includes("i")) return null;
  let literal = "";
  for (let i = 1; i < regex.source.length; i++) {
    const c = regex.source[i];
    if (c === "\\") {
      const escaped = regex.source[++i];
      if (!escaped || /[A-Za-z0-9]/.test(escaped)) break;
      literal += escaped;
    } else if ("[](){}.*+?$^|".includes(c)) {
      // Zero repetitions can remove the last literal atom, including a slash boundary.
      if ("?*{".includes(c)) literal = literal.slice(0, -1);
      break;
    } else {
      literal += c;
    }
  }
  // A root-level alternative can escape the anchor. Ignore escaped syntax and character classes.
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < regex.source.length; i++) {
    const c = regex.source[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (!inClass && c === "(") depth++;
    else if (!inClass && c === ")") depth--;
    else if (!inClass && c === "|" && depth === 0) return null;
  }
  const lastSlash = literal.lastIndexOf("/");
  return lastSlash > 0 ? literal.slice(0, lastSlash + 1) : null;
}

function intersectsEntry(route: RegisteredRoute, entry: PublicRoute): Intersection {
  if (!declaresMethod(entry, route.method)) return "DISJOINT";
  if (entry.match !== "regex") return unifyLiteral(route.url, entry.path as string, entry.match);
  const regex = entry.path as RegExp;
  // A successful sample is an existential witness, never a proof of disjointness.
  const sampleIsValid = route.url.split("/").every((segment) => !segment.includes(":") || /^:[A-Za-z0-9_]+$/.test(segment));
  if (sampleIsValid && new RegExp(regex.source, regex.flags).test(samplePath(route.url))) return "INTERSECTS";
  const prefix = anchoredLiteralPrefix(regex);
  return prefix && unifyLiteral(route.url, prefix, "prefix") === "DISJOINT" ? "DISJOINT" : "AMBIGUOUS";
}

function templateIntersections(routes: RegisteredRoute[], entries: readonly PublicRoute[]): string[] {
  const results: string[] = [];
  for (const route of routes) {
    const first = route.url.split("/")[1] ?? "";
    if (!(route.url.startsWith("/api/") || first.includes(":")) || !/[:*]/.test(route.url)) continue;
    const matches = entries.map((entry) => intersectsEntry(route, entry));
    const result = matches.includes("INTERSECTS") ? "INTERSECTS" : matches.includes("AMBIGUOUS") ? "AMBIGUOUS" : "DISJOINT";
    if (result !== "DISJOINT") results.push(`${route.method} ${route.url} ${result}`);
  }
  return [...new Set(results)].sort();
}

const dashboardPublic = fileURLToPath(new URL("../../../../apps/dashboard/public/", import.meta.url));
async function staticApiInventory(): Promise<string[]> {
  const paths: string[] = [];
  async function visit(relative: string) {
    for (const entry of await readdir(join(dashboardPublic, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else {
        // Refuse unsupported inventory entries instead of silently dropping them.
        expect(entry.isFile(), `${path} is a regular static file`).toBe(true);
        for (const method of ["GET", "HEAD"]) paths.push(`${method} /${path} ${isPublicRoute(`/${path}`, method) ? "PUBLIC" : "AUTHENTICATED"}`);
      }
    }
  }
  await visit("api");
  return paths.sort();
}

/** Unique, sorted "METHOD template" strings for the registered routes matching `pred`. */
function surfaceOf(routes: RegisteredRoute[], pred: (r: RegisteredRoute) => boolean): string[] {
  return [...new Set(routes.filter(pred).map((r) => `${r.method} ${r.url}`))].sort();
}

// Tuple fields: methods, effective HEAD policy (null for writes), match kind, literal path,
// regex source, regex flags, and justification. A declaration edit always requires explicit review.
const EXPECTED_DECLARATIONS = [
  [["GET"],"follow-get","prefix","/api/health",null,null,"liveness and health probes"],
  [["GET"],"follow-get","prefix","/api/auth/validate",null,null,"key validation checks the presented key itself"],
  [["GET"],"follow-get","prefix","/api/waitlist",null,null,"public beta waitlist count (GET /api/waitlist/count)"],
  [["GET"],"follow-get","prefix","/api/admin/feedback",null,null,"admin feedback export, authenticated by X-Admin-Token in the route"],
  [["GET"],"follow-get","prefix","/api/onboard/check/",null,null,"invite-code validation"],
  [["GET"],"follow-get","prefix","/api/onboard/chat",null,null,"onboarding chat health and conversation reads"],
  [["GET"],"follow-get","prefix","/api/dht/",null,null,"DHT discovery (distributed capability queries)"],
  [["GET"],"follow-get","prefix","/api/marketplace/",null,null,"marketplace browsing (see what's available)"],
  [["GET"],"follow-get","prefix","/.well-known/",null,null,"discovery documents"],
  [["GET"],"follow-get","prefix","/docs",null,null,"docs hub and Swagger UI (/docs/api)"],
  [["GET"],"follow-get","exact","/api/agents/status",null,null,"network status"],
  [["GET"],"follow-get","exact","/api/onboard/registrations",null,null,"public registration listing"],
  [["GET"],"follow-get","exact","/api/orchestrator/templates",null,null,"template directory for unauthenticated landing-page discovery"],
  [["GET"],"follow-get","exact","/openapi.json",null,null,"OpenAPI 3.x spec (APIs.guru, Smithery, mcp.so); outside /api"],
  [["GET"],"follow-get","exact","/api/courier-jobs/open",null,null,"open courier-jobs feed: driver agents poll without a key (legacy shim)"],
  [["GET"],"follow-get","exact","/api/courier-jobs/jobs/open",null,null,"v0.2 compat alias for the open courier-jobs feed (legacy shim)"],
  [["GET"],"follow-get","exact","/api/courier-jobs/healthz",null,null,"courier-jobs liveness for monitoring (legacy shim)"],
  [["GET"],"follow-get","exact","/api/job-offers/open",null,null,"open-offers feed: operator agents poll without a key"],
  [["GET"],"follow-get","exact","/api/job-offers/healthz",null,null,"job-offers liveness for monitoring"],
  [["GET"],"follow-get","exact","/api/auth/nonce",null,null,"SIWE challenge: login needs a nonce before any key exists"],
  [["GET"],"follow-get","exact","/api/kernels",null,null,"kernel discovery (creating or upserting a kernel stays authenticated)"],
  [["GET"],"follow-get","exact","/api/capabilities",null,null,"capability listing (creating one is not public)"],
  [["GET"],"follow-get","exact","/api/capabilities/types",null,null,"capability type discovery"],
  [["GET"],"follow-get","exact","/api/artifacts",null,null,"UI-artifact discovery (public listing)"],
  [["GET"],"follow-get","regex",null,"^\\/api\\/capabilities\\/[^/]+(?:\\/button|\\/td)?$","","capability detail, button and thing-description reads"],
  [["GET"],"follow-get","regex",null,"^\\/api\\/operators\\/[^/]+\\/ratings$","","operator rating reads"],
  [["GET"],"follow-get","regex",null,"^\\/api\\/kernels\\/[^/]+\\/agent-card\\.json$","","per-kernel A2A agent card (federated discovery)"],
  [["GET"],"follow-get","regex",null,"^\\/api\\/job-offers\\/[^/]+$","","job-offer detail reads"],
  [["GET"],"follow-get","regex",null,"^\\/api\\/courier-jobs\\/(?:jobs\\/)?[^/]+$","","courier-job detail reads (legacy v0.2 public GET)"],
  [["GET"],"authenticated","regex",null,"^\\/api\\/artifacts\\/[^/]+$","","UI-artifact recall (the route enforces visibility; HEAD preserves SIWE ownership)"],
  [["GET"],"follow-get","regex",null,"^\\/api\\/compose\\/registry-snapshot(?:\\/[^/]+)?$","","public compiler-ABI registry snapshot"],
  [["POST"],null,"exact","/api/auth/provision",null,null,"self-service key provisioning: how a caller gets a key"],
  [["POST"],null,"exact","/api/auth/verify",null,null,"SIWE signature verify -> session: the login endpoint itself"],
  [["POST"],null,"exact","/api/waitlist",null,null,"public beta waitlist signup"],
  [["POST"],null,"exact","/api/beta-apply",null,null,"public beta-tester application"],
  [["POST"],null,"exact","/api/feedback",null,null,"public feedback sink: cold agents have no key"],
  [["POST"],null,"exact","/api/feedback/agent-report",null,null,"keyless agent friction report"],
  [["POST"],null,"exact","/api/onboard/chat",null,null,"layperson conversational onboarding"],
  [["POST"],null,"exact","/api/onboard/identify-device",null,null,"device identification for the install.html landing page"],
  [["POST"],null,"exact","/api/capabilities/templates/match",null,null,"landing-page template matcher: a read-only heuristic that stores nothing"],
  [["POST"],null,"exact","/api/marketplace/roi",null,null,"ROI calculator: pure computation that stores nothing"],
  [["POST"],null,"exact","/api/carrier/webhook/easypost",null,null,"EasyPost webhook: X-Hmac-Signature verified in routes/carrier.ts (sol #297 finding 15)"],
  [["POST"],null,"exact","/api/lob/webhook",null,null,"Lob webhook: timestamp-bound HMAC verified in routes/lob.ts (carrier audit L1)"],
];

const EXPECTED_TEMPLATE_INTERSECTIONS: string[] = [
  "GET /api/artifacts/:idOrSlug INTERSECTS",
  "GET /api/capabilities/:capId INTERSECTS",
  "GET /api/capabilities/:capabilityId/compliance AMBIGUOUS",
  "GET /api/capabilities/:id/button INTERSECTS",
  "GET /api/capabilities/:id/td INTERSECTS",
  "GET /api/capabilities/by-kernel/:kernelId AMBIGUOUS",
  "GET /api/capabilities/by-type/:type AMBIGUOUS",
  "GET /api/capabilities/graph-search/:searchId AMBIGUOUS",
  "GET /api/compose/:id AMBIGUOUS",
  "GET /api/compose/registry-snapshot/:registryDigest INTERSECTS",
  "GET /api/courier-jobs/:id INTERSECTS",
  "GET /api/courier-jobs/jobs/:id INTERSECTS",
  "GET /api/job-offers/:id INTERSECTS",
  "GET /api/kernels/:kernelId AMBIGUOUS",
  "GET /api/kernels/:kernelId/agent-card.json INTERSECTS",
  "GET /api/kernels/:kernelId/agent-package AMBIGUOUS",
  "GET /api/kernels/:kernelId/agent-package/suggest AMBIGUOUS",
  "GET /api/kernels/:kernelId/devices AMBIGUOUS",
  "GET /api/kernels/:kernelId/jobs AMBIGUOUS",
  "GET /api/kernels/:kernelId/sdk/:language AMBIGUOUS",
  "GET /api/kernels/marketplace/:kernelId AMBIGUOUS",
  "GET /api/marketplace/classes/:id INTERSECTS",
  "GET /api/marketplace/listings/:id INTERSECTS",
  "GET /api/marketplace/orders/:id INTERSECTS",
  "GET /api/onboard/:id/live-data INTERSECTS",
  "GET /api/onboard/:id/status INTERSECTS",
  "GET /api/onboard/chat/:id INTERSECTS",
  "GET /api/onboard/check/:code INTERSECTS",
  "GET /api/operators/:id/discoverability AMBIGUOUS",
  "GET /api/operators/:id/ratings INTERSECTS",
  "GET /api/operators/:slug/channels AMBIGUOUS",
  "GET /api/operators/:slug/status AMBIGUOUS",
  "GET /api/operators/by-compliance/:regulationId AMBIGUOUS",
  "HEAD /api/capabilities/:capId INTERSECTS",
  "HEAD /api/capabilities/:capabilityId/compliance AMBIGUOUS",
  "HEAD /api/capabilities/:id/button INTERSECTS",
  "HEAD /api/capabilities/:id/td INTERSECTS",
  "HEAD /api/capabilities/by-kernel/:kernelId AMBIGUOUS",
  "HEAD /api/capabilities/by-type/:type AMBIGUOUS",
  "HEAD /api/capabilities/graph-search/:searchId AMBIGUOUS",
  "HEAD /api/compose/:id AMBIGUOUS",
  "HEAD /api/compose/registry-snapshot/:registryDigest INTERSECTS",
  "HEAD /api/courier-jobs/:id INTERSECTS",
  "HEAD /api/courier-jobs/jobs/:id INTERSECTS",
  "HEAD /api/job-offers/:id INTERSECTS",
  "HEAD /api/kernels/:kernelId AMBIGUOUS",
  "HEAD /api/kernels/:kernelId/agent-card.json INTERSECTS",
  "HEAD /api/kernels/:kernelId/agent-package AMBIGUOUS",
  "HEAD /api/kernels/:kernelId/agent-package/suggest AMBIGUOUS",
  "HEAD /api/kernels/:kernelId/devices AMBIGUOUS",
  "HEAD /api/kernels/:kernelId/jobs AMBIGUOUS",
  "HEAD /api/kernels/:kernelId/sdk/:language AMBIGUOUS",
  "HEAD /api/kernels/marketplace/:kernelId AMBIGUOUS",
  "HEAD /api/marketplace/classes/:id INTERSECTS",
  "HEAD /api/marketplace/listings/:id INTERSECTS",
  "HEAD /api/marketplace/orders/:id INTERSECTS",
  "HEAD /api/onboard/:id/live-data INTERSECTS",
  "HEAD /api/onboard/:id/status INTERSECTS",
  "HEAD /api/onboard/chat/:id INTERSECTS",
  "HEAD /api/onboard/check/:code INTERSECTS",
  "HEAD /api/operators/:id/discoverability AMBIGUOUS",
  "HEAD /api/operators/:id/ratings INTERSECTS",
  "HEAD /api/operators/:slug/channels AMBIGUOUS",
  "HEAD /api/operators/:slug/status AMBIGUOUS",
  "HEAD /api/operators/by-compliance/:regulationId AMBIGUOUS",
];

// Vite's unmodified publicDir="public" and copyPublicDir=true copy these files verbatim.
// vite.config.ts has no API entries or custom output filenames; all generated assets use assets/.
const EXPECTED_STATIC_API_INVENTORY = [
  "GET /api/agent/tools.json AUTHENTICATED",
  "HEAD /api/agent/tools.json AUTHENTICATED",
];

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
// POST /api/marketplace/orders); plus the HEAD twin of seven public GETs that master opened for GET
// only. Artifact-detail HEAD remains authenticated so SIWE owners retain private-artifact access.
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
  it("DECLARATIONS: methods, HEAD policy, match, literal path, regex source/flags and why are pinned", () => {
    expect(declarations).toBeInstanceOf(Array);
    expect(Object.isFrozen(declarations)).toBe(true);
    for (const entry of declarations) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.methods)).toBe(true);
    }
    expect(normalizedDeclarations(declarations)).toEqual(EXPECTED_DECLARATIONS);
  });

  it("INTERSECTIONS: every parameter or wildcard template that could be public is explicitly reviewed", () => {
    expect(templateIntersections(bootRoutes, declarations)).toEqual(EXPECTED_TEMPLATE_INTERSECTIONS);
  });

  it("F2 exact parameter exception: changing only cap-a must fail a policy pin", () => {
    const original = surfaceOf(bootRoutes, (r) => r.url.startsWith("/api/") && isPublic(r));
    const patchedMatcher: Matcher = (url, method) =>
      (method === "POST" && url === "/api/capabilities/cap-a/heartbeat") || isPublicRoute(url, method);
    expect(patchedMatcher("/api/capabilities/cap-a/heartbeat", "POST")).toBe(true);
    expect(patchedMatcher("/api/capabilities/p-capId/heartbeat", "POST")).toBe(false);
    const patched = surfaceOf(bootRoutes, (r) => r.url.startsWith("/api/") && patchedMatcher(samplePath(r.url), r.method));
    expect(patched).toEqual(original); // Demonstrate why the sampled pin alone is insufficient.
    const patchedDeclarations: PublicRoute[] = [...declarations, {
      methods: ["POST"], match: "exact", path: "/api/capabilities/cap-a/heartbeat", why: "N43 negative-control exception",
    }];
    expect(() => expect(normalizedDeclarations(patchedDeclarations)).toEqual(EXPECTED_DECLARATIONS)).toThrow();
    expect(() => expect(templateIntersections(bootRoutes, patchedDeclarations)).toEqual(EXPECTED_TEMPLATE_INTERSECTIONS)).toThrow();
    expect(templateIntersections(bootRoutes, patchedDeclarations)).toContain("POST /api/capabilities/:capId/heartbeat INTERSECTS");
  });

  it("F2 parameter registration: a health-valued section must fail a template pin", async () => {
    const cursor = registered.length;
    const fixtureApp = (await import("fastify")).default();
    try {
      fixtureApp.get("/api/:section/__n43_probe", async () => ({ probe: true }));
      await fixtureApp.ready();
      const fixtureRoutes = registered.slice(cursor);
      const fixture = fixtureRoutes.find((route) => route.method === "GET")!;
      expect(fixture).toEqual({ method: "GET", url: "/api/:section/__n43_probe" });
      expect(isPublicRoute("/api/health/__n43_probe", "GET")).toBe(true);
      expect(isPublic(fixture)).toBe(false);
      const patched = surfaceOf([...bootRoutes, ...fixtureRoutes], (r) => r.url.startsWith("/api/") && isPublic(r));
      expect(patched).toEqual(EXPECTED_PUBLIC_API_SURFACE);
      const intersections = templateIntersections([...bootRoutes, ...fixtureRoutes], declarations);
      expect(intersections).toContain("GET /api/:section/__n43_probe INTERSECTS");
      expect(() => expect(intersections).toEqual(EXPECTED_TEMPLATE_INTERSECTIONS)).toThrow();
    } finally {
      await fixtureApp.close();
    }
  });

  it("F2 root parameter registration: an api-valued section must fail a template pin", async () => {
    const cursor = registered.length;
    const fixtureApp = (await import("fastify")).default();
    try {
      const { apiGate } = await import("../middleware/api-gate.js");
      await fixtureApp.register(apiGate);
      fixtureApp.get("/:section/dht/__n43_probe", async () => ({ probe: true }));
      await fixtureApp.ready();
      const fixtureRoutes = registered.slice(cursor);
      const fixture = fixtureRoutes.find((route) => route.method === "GET")!;
      expect(fixture).toEqual({ method: "GET", url: "/:section/dht/__n43_probe" });
      expect(isPublicRoute("/api/dht/__n43_probe", "GET")).toBe(true);
      expect(isPublic(fixture)).toBe(false);
      const res = await fixtureApp.inject({ method: "GET", url: "/api/dht/__n43_probe" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ probe: true });
      const intersections = templateIntersections([...bootRoutes, ...fixtureRoutes], declarations);
      expect(intersections).toContain("GET /:section/dht/__n43_probe INTERSECTS");
      expect(() => expect(intersections).toEqual(EXPECTED_TEMPLATE_INTERSECTIONS)).toThrow();
    } finally {
      await fixtureApp.close();
    }
  });

  it("unsupported regex languages remain ambiguous rather than disappearing from review", () => {
    const route = { method: "GET", url: "/api/:section/__n43_regex_probe" };
    for (const path of [
      /^\/api\/health(?:x)?|^\/api\/other\/[^/]+$/,
      /^\/api\/health\/?[^/]+$/,
      /^\/api\/health\/*[^/]+$/,
      /^\/api\/health\/{0,1}[^/]+$/,
      /^\/api\/health\/[^/]+$/i,
    ]) {
      expect(intersectsEntry(route, { methods: ["GET"], match: "regex", path, why: "conservative regex control" }), path.source).toBe("AMBIGUOUS");
    }
  });

  it("F3 production static registrations: capture authenticated tools and public marketplace preview", async () => {
    const staticPaths = ["/api/agent/tools.json", "/api/marketplace/preview.json"];
    expect(surfaceOf(productionRoutes, (r) => staticPaths.includes(r.url))).toEqual([
      "GET /api/agent/tools.json", "GET /api/marketplace/preview.json",
      "HEAD /api/agent/tools.json", "HEAD /api/marketplace/preview.json",
    ]);
    for (const method of ["GET", "HEAD"] as const) {
      expect(isPublicRoute("/api/agent/tools.json", method)).toBe(false);
      expect(isPublicRoute("/api/marketplace/preview.json", method)).toBe(true);
      expect((await app.inject({ method, url: "/api/agent/tools.json" })).statusCode).toBe(401);
      expect((await app.inject({ method, url: "/api/marketplace/preview.json" })).statusCode).toBe(200);
    }
    // This fixture proves the production branch actually contributes to the public inventory.
    const staticPublic = surfaceOf(productionRoutes, (r) => r.url.startsWith("/api/") && isPublic(r));
    expect(staticPublic).toContain("GET /api/marketplace/preview.json");
    expect(() => expect(staticPublic).toEqual(EXPECTED_PUBLIC_API_SURFACE)).toThrow();
  });

  it("STATIC INVENTORY: dashboard public/api files copied verbatim to dist are pinned with gate classification", async () => {
    expect(await staticApiInventory()).toEqual(EXPECTED_STATIC_API_INVENTORY);
  });

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

  it("HEAD follows GET except artifact detail, which authenticates to retain SIWE ownership", () => {
    const gets = EXPECTED_PUBLIC_API_SURFACE.filter((l) => l.startsWith("GET ")).map((l) => l.slice(4));
    const heads = EXPECTED_PUBLIC_API_SURFACE.filter((l) => l.startsWith("HEAD ")).map((l) => l.slice(5));
    expect(heads).toEqual(gets.filter((path) => path !== "/api/artifacts/:idOrSlug"));
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
