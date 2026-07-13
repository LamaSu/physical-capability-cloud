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
const ROUTES_DIR = join(ROOT, "packages", "gateway", "src", "routes");

// ── SNAPSHOT: api-gate.ts public rules (api-gate.ts:13-89 @ lamasu/master) ──
// Keep in sync with middleware/api-gate.ts. The coverage test drift-checks this.
const PUBLIC_PREFIXES = [
  "/api/health", "/api/auth/provision", "/api/auth/validate", "/api/waitlist",
  "/api/beta-apply", "/api/feedback", "/api/admin/feedback",
  "/api/onboard/identify-device", "/api/onboard/check/", "/api/onboard/chat",
  "/api/dht/", "/api/marketplace/", "/.well-known/", "/docs",
];
const PUBLIC_EXACT = [
  "/api/capabilities/types", "/api/capabilities", "/api/agents/status",
  "/api/onboard/registrations", "/api/orchestrator/templates",
  "/api/capabilities/templates/match", "/openapi.json",
  "/api/courier-jobs/open", "/api/courier-jobs/jobs/open", "/api/courier-jobs/healthz",
  "/api/job-offers/open", "/api/job-offers/healthz",
];
const PUBLIC_CAPABILITY_DETAIL_RE = /^\/api\/capabilities\/[^/]+(?:\/button|\/td)?$/;
const PUBLIC_OPERATOR_RATINGS_RE = /^\/api\/operators\/[^/]+\/ratings$/;
const PUBLIC_KERNEL_AGENT_CARD_RE = /^\/api\/kernels\/[^/]+\/agent-card\.json$/;
const PUBLIC_JOB_OFFERS_DETAIL_RE = /^\/api\/job-offers\/[^/]+$/;
const PUBLIC_COURIER_JOBS_DETAIL_RE = /^\/api\/courier-jobs\/(?:jobs\/)?[^/]+$/;
const PUBLIC_ARTIFACTS_READ_RE = /^\/api\/artifacts(?:\/[^/]+)?$/;

/** Mirror of api-gate.ts isPublicRoute(url, method) against a CONCRETE path. */
function isPublicRoute(path, method) {
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

// ── SNAPSHOT: scope-checker.ts DEFAULT_SCOPE_REQUIREMENTS (:22-45) ──
const DEFAULT_SCOPE_REQUIREMENTS = [
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

/** Mirror of scope-checker.ts patternToRegex + matchRoute. */
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const reStr = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${reStr}(?:\\?.*)?$`);
}
function matchesAnyScopeRule(path, method) {
  return DEFAULT_SCOPE_REQUIREMENTS.some(
    (r) =>
      (r.method === "*" || r.method === method) && patternToRegex(r.pattern).test(path),
  );
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
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listTsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** :param -> single no-slash token so the api-gate/scope regexes match. */
function concretize(routePath) {
  return routePath.replace(/:[A-Za-z0-9_]+/g, "_");
}

export function buildInventory() {
  const files = listTsFiles(ROUTES_DIR);
  const routes = [];
  const seen = new Set();
  for (const file of files) {
    const src = readFileSync(file, "utf8");
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
    const isPoliced = matchesAnyScopeRule(concrete, r.method);
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(r.method);
    let bucket;
    if (isPublic) bucket = "public";
    else if (isPoliced) bucket = "policed";
    else bucket = mutating ? "unpoliced_private_mutating" : "unpoliced_private_read";
    return { ...r, bucket, mutating };
  });

  const by = (b) => classified.filter((r) => r.bucket === b);
  return {
    totals: {
      api_routes: apiRoutes.length,
      non_api_routes: nonApi.length,
      public: by("public").length,
      policed: by("policed").length,
      unpoliced_private_mutating: by("unpoliced_private_mutating").length,
      unpoliced_private_read: by("unpoliced_private_read").length,
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
  console.log(`  POLICED (scope rule matches):   ${t.policed}`);
  console.log(`  UNPOLICED private MUTATING:     ${t.unpoliced_private_mutating}  <-- CI gate target (must reach 0)`);
  console.log(`  UNPOLICED private read (GET):   ${t.unpoliced_private_read}`);
  console.log(`  (non-/api routes, informational:${t.non_api_routes})`);
  const danger = inv.routes.filter((r) => r.bucket === "unpoliced_private_mutating");
  console.log(`\n  First 25 unpoliced MUTATING routes (the default-deny risk set):`);
  for (const r of danger.slice(0, 25)) console.log(`    ${r.method.padEnd(6)} ${r.path.padEnd(52)} ${r.file}`);
  if (danger.length > 25) console.log(`    … and ${danger.length - 25} more`);
}
}
