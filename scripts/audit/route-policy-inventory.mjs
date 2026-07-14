#!/usr/bin/env node
/**
 * /api/* route -> auth/scope policy inventory  (audit P0, lane d749deff)
 *
 * Purpose: the keystone that makes gateway default-deny SAFE to ship. It
 * enumerates every route the gateway registers, classifies each as PUBLIC (via
 * api-gate) / POLICED (a scope rule matches) / UNPOLICED-PRIVATE (the gap), and
 * emits a machine-readable report. A companion test
 * (route-policy-coverage.test.ts) turns the UNPOLICED-mutating set into a CI
 * gate. Once that set is empty, flipping the scope-checker's unmatched-route
 * default from allow to deny (fix/audit-p0) can no longer silently brick a
 * legitimate route.
 *
 * Method: STATIC parse of packages/gateway/src/routes/ plus a SNAPSHOT of
 * api-gate's public rules + scope-checker's DEFAULT_SCOPE_REQUIREMENTS (copied
 * below, tagged with their source lines). The owned files (api-gate.ts,
 * scope-checker.ts) belong to session 9de363c7 on fix/audit-p0 — this tool does
 * NOT import from or edit them; the snapshot is validated by a drift check in
 * the companion test. Regenerate the snapshot when those files change.
 *
 * Usage:
 *   node scripts/audit/route-policy-inventory.mjs           # human summary
 *   node scripts/audit/route-policy-inventory.mjs --json     # full JSON to stdout
 *   node scripts/audit/route-policy-inventory.mjs --out <f>  # write JSON to file
 *
 * Exported for the coverage test: buildInventory().
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Scan the WHOLE gateway src, not just routes/ (review R3 #4): the gateway
// registers real /api routes OUTSIDE routes/ too — server.ts (health, agents,
// producers), auth/siwe-auth.ts (/api/auth/*), middleware/aegis-gate.ts,
// middleware/x402-gate.ts. Scoping the scan to routes/ silently dropped them, so
// the "0 unpoliced" claim did not actually cover every registered route. This is
// an INTERIM static widening; the durable fix is deriving the route set from the
// live Fastify app via an onRoute hook (blocked on createGateway deps — R3 #9).
const GATEWAY_SRC = join(ROOT, "packages", "gateway", "src");

// ── SNAPSHOT: api-gate.ts public rules (api-gate.ts:13-89 @ lamasu/master) ──
// Keep in sync with middleware/api-gate.ts. The coverage test drift-checks this.
export const PUBLIC_PREFIXES = [
  "/api/health", "/api/auth/provision", "/api/auth/validate", "/api/waitlist",
  "/api/beta-apply", "/api/feedback", "/api/admin/feedback",
  "/api/onboard/identify-device", "/api/onboard/check/", "/api/onboard/chat",
  "/api/dht/", "/api/marketplace/", "/.well-known/", "/docs",
];
export const PUBLIC_EXACT = [
  "/api/capabilities/types", "/api/capabilities", "/api/agents/status",
  "/api/onboard/registrations", "/api/orchestrator/templates",
  "/api/capabilities/templates/match", "/openapi.json",
  "/api/courier-jobs/open", "/api/courier-jobs/jobs/open", "/api/courier-jobs/healthz",
  "/api/job-offers/open", "/api/job-offers/healthz",
];
export const PUBLIC_CAPABILITY_DETAIL_RE = /^\/api\/capabilities\/[^/]+(?:\/button|\/td)?$/;
export const PUBLIC_OPERATOR_RATINGS_RE = /^\/api\/operators\/[^/]+\/ratings$/;
export const PUBLIC_KERNEL_AGENT_CARD_RE = /^\/api\/kernels\/[^/]+\/agent-card\.json$/;
export const PUBLIC_JOB_OFFERS_DETAIL_RE = /^\/api\/job-offers\/[^/]+$/;
export const PUBLIC_COURIER_JOBS_DETAIL_RE = /^\/api\/courier-jobs\/(?:jobs\/)?[^/]+$/;
export const PUBLIC_ARTIFACTS_READ_RE = /^\/api\/artifacts(?:\/[^/]+)?$/;

/** Mirror of api-gate.ts isPublicRoute(url, method) against a CONCRETE path. */
export function isPublicRoute(path, method) {
  if (PUBLIC_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (PUBLIC_EXACT.includes(path)) return true;
  if (method === "GET" && path === "/api/kernels") return true;
  if (PUBLIC_CAPABILITY_DETAIL_RE.test(path)) return true;
  if (PUBLIC_OPERATOR_RATINGS_RE.test(path)) return true;
  if (PUBLIC_KERNEL_AGENT_CARD_RE.test(path)) return true;
  if (method === "GET" && PUBLIC_JOB_OFFERS_DETAIL_RE.test(path)) return true;
  if (method === "GET" && PUBLIC_COURIER_JOBS_DETAIL_RE.test(path)) return true;
  if (method === "GET" && PUBLIC_ARTIFACTS_READ_RE.test(path)) return true;
  return false;
}

// ── SNAPSHOT: scope-checker.ts DEFAULT_SCOPE_REQUIREMENTS (:39-61) ──
export const DEFAULT_SCOPE_REQUIREMENTS = [
  { method: "POST", pattern: "/api/kernels/*", scopes: ["operator", "admin"] },
  { method: "PUT", pattern: "/api/kernels/*", scopes: ["operator", "admin"] },
  { method: "POST", pattern: "/api/evidence/*", scopes: ["operator", "verifier", "admin"] },
  { method: "POST", pattern: "/api/negotiate/*", scopes: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", pattern: "/api/jobs/*", scopes: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", pattern: "/api/build/*", scopes: ["requestor", "operator", "agent", "admin"] },
  { method: "POST", pattern: "/api/jobs/*/attestations/*", scopes: ["verifier", "admin"] },
  { method: "*", pattern: "/api/admin/*", scopes: ["admin"] },
  { method: "POST", pattern: "/api/templates/*", scopes: ["template_author", "operator", "admin"] },
  { method: "PUT", pattern: "/api/templates/*", scopes: ["template_author", "operator", "admin"] },
  { method: "GET", pattern: "/api/audit/*", scopes: ["auditor", "admin"] },
  { method: "GET", pattern: "/api/compliance/*", scopes: ["auditor", "operator", "admin"] },
];

// ── Cross-lane pending classification (review R3 #4) ──────────────────────────
// Widening the scan to all of gateway/src surfaced the SIWE session-auth routes,
// whose policy is NOT this lane's to set: the pre-auth LOGIN HANDSHAKE must be
// api-gate PUBLIC (no principal exists yet), and the session ops need an
// "any-authenticated principal, no specific scope" allowance in the scope model —
// both owned by 9de363c7 (api-gate.ts / auth model). Rather than fabricate a scope
// rule or hide them behind a false "0 unpoliced", they are enumerated here so the
// coverage gate documents the exact gap and still fails on any NEW unclassified
// route. Flagged cross-lane. When 9de363c7 classifies each (public, or an
// any-authenticated allowance), it leaves this list.
export const UNCLASSIFIED_PENDING_OWNER = [
  { method: "GET",  path: "/api/auth/nonce",    owner: "api-gate/9de363c7", reason: "SIWE login handshake — pre-auth, MUST be api-gate PUBLIC" },
  { method: "POST", path: "/api/auth/verify",   owner: "api-gate/9de363c7", reason: "SIWE login handshake — pre-auth, MUST be api-gate PUBLIC" },
  { method: "GET",  path: "/api/auth/me",       owner: "auth-model/9de363c7", reason: "own session info — any authenticated principal, no scope" },
  { method: "GET",  path: "/api/auth/sessions", owner: "auth-model/9de363c7", reason: "own sessions — any authenticated principal, no scope" },
  { method: "POST", path: "/api/auth/logout",   owner: "auth-model/9de363c7", reason: "logout — any authenticated principal, no scope" },
];
const PENDING_KEYS = new Set(UNCLASSIFIED_PENDING_OWNER.map((r) => `${r.method} ${r.path}`));

// patternToRegex with CORRECT double-star (any-depth) semantics.
//
// WARNING: the gateway scope-checker.ts patternToRegex is BUGGY — it replaces
// double-star with dot-star, THEN replaces every single star with [^/]* , which
// corrupts the dot-star from the first step into ".[^/]*". Result: a double-star
// pattern never matches a multi-segment path there, so NO scope policy can cover
// a route deeper than one segment. This tool uses a placeholder so double-star
// works, representing the coverage the manifest ACHIEVES ONCE that 1-line bug is
// fixed. Flagged to 9de363c7 (owns scope-checker.ts) as an enforcement prereq.
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const reStr = escaped
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${reStr}(?:\\?.*)?$`);
}
function matchesDefaultRule(path, method) {
  return DEFAULT_SCOPE_REQUIREMENTS.some(
    (r) =>
      (r.method === "*" || r.method === method) && patternToRegex(r.pattern).test(path),
  );
}

// ── This lane's policy manifest (route -> required scopes) — the coverage that
// shrinks the unpoliced gap. Consumed by 9de363c7's scope-checker on fix/audit-p0.
const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), "route-policy-manifest.json");
let MANIFEST_RULES = [];
try {
  MANIFEST_RULES = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).rules ?? [];
} catch {
  MANIFEST_RULES = [];
}
function matchesManifestRule(path, method) {
  return MANIFEST_RULES.some(
    (r) =>
      (r.method === "*" || r.method === method) && patternToRegex(r.pattern).test(path),
  );
}

// ── Deterministic precedence (review findings #4/#5) ──────────────────────────
// The scope-checker's own sort is star-count only, which TIES /api/jobs/** with
// /api/jobs/*/attestations/* (both 2 stars) → insertion-order-dependent. This
// comparator breaks ties by real specificity so the WINNING policy is
// deterministic and testable. NOTE: the runtime scope-checker (9de363c7) must
// adopt the same comparator or runtime will diverge from this intended policy.
export function specificity(rule) {
  const p = rule.pattern;
  const doubleStars = (p.match(/\*\*/g) || []).length;
  const singleStars = (p.match(/\*/g) || []).length - doubleStars * 2;
  const literalSegs = p.split("/").filter((s) => s.length > 0 && !s.includes("*")).length;
  const literalChars = p.replace(/\*/g, "").length;
  return { exactMethod: rule.method !== "*" ? 1 : 0, literalSegs, doubleStars, singleStars, literalChars };
}

/** >0 if a is more specific than b, <0 if less, 0 if an exact tie. */
export function compareSpecificity(a, b) {
  const sa = specificity(a), sb = specificity(b);
  if (sa.exactMethod !== sb.exactMethod) return sa.exactMethod - sb.exactMethod;
  if (sa.literalSegs !== sb.literalSegs) return sa.literalSegs - sb.literalSegs;
  if (sa.doubleStars !== sb.doubleStars) return sb.doubleStars - sa.doubleStars; // fewer ** wins
  if (sa.singleStars !== sb.singleStars) return sb.singleStars - sa.singleStars; // fewer * wins
  if (sa.literalChars !== sb.literalChars) return sa.literalChars - sb.literalChars;
  return 0;
}

/**
 * Resolve the WINNING policy for a CONCRETE method+path against defaults ∪ manifest.
 * Returns { winner, scopes, matching, ambiguous }. `ambiguous` is true when >1
 * top-specificity rule has DIFFERENT scopes (a policy that must be rejected, not
 * silently ordered). Used by the coverage matrix — proves the intended scopes win,
 * not just that "something matches".
 */
export function resolvePolicy(method, path) {
  const rules = [...DEFAULT_SCOPE_REQUIREMENTS, ...MANIFEST_RULES];
  const matching = rules.filter(
    (r) => (r.method === "*" || r.method === method) && patternToRegex(r.pattern).test(path),
  );
  if (matching.length === 0) return { winner: null, scopes: null, matching: [], ambiguous: false };
  const sorted = [...matching].sort((a, b) => compareSpecificity(b, a));
  const top = sorted[0];
  const ties = sorted.filter((r) => compareSpecificity(r, top) === 0);
  const distinctScopes = new Set(ties.map((r) => [...r.scopes].sort().join(",")));
  return {
    winner: top,
    scopes: top.scopes,
    matching,
    ambiguous: ties.length > 1 && distinctScopes.size > 1,
  };
}

// ── Route extraction (static) ──
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
// instance.method<Generics>( "path"  — path may sit on the next line, any quote.
const ROUTE_RE = new RegExp(
  String.raw`[A-Za-z_$][\w$]*\.(` + METHODS.join("|") + String.raw`)\s*(?:<[^>]*>)?\s*\(\s*(['"\`])(\/[^'"\`]*?)\2`,
  "g",
);

function listTsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // Skip test dirs/files: they contain synthetic app.get("/api/...") calls that
    // are NOT real registrations and would pollute the inventory.
    if (e.name === "__tests__" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

// Strip block comments (incl. JSDoc /** ... */) and full-line // comments before
// route extraction, so a documentation EXAMPLE like `* app.get("/api/protected"…)`
// in auth/require-auth.ts is not mistaken for a real route. Real registrations are
// code, never inside comments, so this only removes false positives.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block + JSDoc comments
    .replace(/^\s*\/\/.*$/gm, "");        // whole-line // comments
}

/** :param -> single no-slash token so the api-gate/scope regexes match. */
function concretize(routePath) {
  return routePath.replace(/:[A-Za-z0-9_]+/g, "_");
}

export function buildInventory() {
  const files = listTsFiles(GATEWAY_SRC);
  const routes = [];
  const seen = new Set();
  for (const file of files) {
    const src = stripComments(readFileSync(file, "utf8"));
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
    let m;
    ROUTE_RE.lastIndex = 0;
    while ((m = ROUTE_RE.exec(src)) !== null) {
      const method = m[1].toUpperCase();
      const routePath = m[3];
      if (!routePath.startsWith("/")) continue;
      const key = `${method} ${routePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      routes.push({ method, path: routePath, file: rel });
    }
  }

  const apiRoutes = routes.filter((r) => r.path.startsWith("/api/"));
  const nonApi = routes.filter((r) => !r.path.startsWith("/api/"));

  const classified = apiRoutes.map((r) => {
    const concrete = concretize(r.path);
    const isPublic = isPublicRoute(concrete, r.method);
    const byDefault = !isPublic && matchesDefaultRule(concrete, r.method);
    const byManifest = !isPublic && !byDefault && matchesManifestRule(concrete, r.method);
    const isPoliced = byDefault || byManifest;
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(r.method);
    const isPending = PENDING_KEYS.has(`${r.method} ${r.path}`);
    let bucket;
    if (isPublic) bucket = "public";
    else if (isPoliced) bucket = "policed";
    else if (isPending) bucket = "cross_lane_pending"; // documented, owned elsewhere (R3 #4)
    else bucket = mutating ? "unpoliced_private_mutating" : "unpoliced_private_read";
    return { ...r, bucket, mutating, policedBy: byDefault ? "default" : byManifest ? "manifest" : null };
  });

  const by = (b) => classified.filter((r) => r.bucket === b);
  return {
    totals: {
      api_routes: apiRoutes.length,
      non_api_routes: nonApi.length,
      public: by("public").length,
      policed: by("policed").length,
      policed_by_default: classified.filter((r) => r.policedBy === "default").length,
      policed_by_manifest: classified.filter((r) => r.policedBy === "manifest").length,
      unpoliced_private_mutating: by("unpoliced_private_mutating").length,
      unpoliced_private_read: by("unpoliced_private_read").length,
      cross_lane_pending: by("cross_lane_pending").length,
    },
    routes: classified,
    non_api: nonApi,
  };
}

// ── CLI (only when run directly, so the coverage test can import cleanly) ──
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) runCli();

function runCli() {
const args = process.argv.slice(2);
const inv = buildInventory();
const outIdx = args.indexOf("--out");
if (outIdx !== -1 && args[outIdx + 1]) {
  writeFileSync(args[outIdx + 1], JSON.stringify(inv, null, 2));
  console.log(`[route-policy-inventory] wrote ${args[outIdx + 1]}`);
} else if (args.includes("--json")) {
  console.log(JSON.stringify(inv, null, 2));
} else {
  const t = inv.totals;
  console.log("── /api/* route -> policy inventory ──");
  console.log(`  total /api/* routes:            ${t.api_routes}`);
  console.log(`  PUBLIC (api-gate):              ${t.public}`);
  console.log(`  POLICED (total):                ${t.policed}   (defaults ${t.policed_by_default} + manifest ${t.policed_by_manifest})`);
  console.log(`  UNPOLICED private MUTATING:     ${t.unpoliced_private_mutating}  <-- CI gate target (must reach 0)`);
  console.log(`  UNPOLICED private read (GET):   ${t.unpoliced_private_read}`);
  console.log(`  (non-/api routes, informational:${t.non_api_routes})`);
  const danger = inv.routes.filter((r) => r.bucket === "unpoliced_private_mutating");
  console.log(`\n  First 25 unpoliced MUTATING routes (the default-deny risk set):`);
  for (const r of danger.slice(0, 25)) console.log(`    ${r.method.padEnd(6)} ${r.path.padEnd(52)} ${r.file}`);
  if (danger.length > 25) console.log(`    … and ${danger.length - 25} more`);
}
}
