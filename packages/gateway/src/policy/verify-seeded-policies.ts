/**
 * Runtime route-policy inventory gate (audit P0, lane d749deff; review finding #2).
 *
 * The RUNTIME half of the completeness guarantee (the build-time half is the CI
 * coverage gate). It verifies the LIVE endpoint_scopes table is a complete,
 * untampered seed of the manifest BEFORE prod boots in enforce.
 *
 * TRUST ROOT = the build-checked-in constants in manifest-digest.generated.ts —
 * NOT the marker row inside the DB being validated. The live rows must hash to the
 * EXACTLY-expected digest, so a stale/partial/tampered table (even one whose marker
 * was recomputed to self-certify) cannot pass: the attacker cannot change the
 * compiled constant. Fails closed (throws) on any problem.
 *
 * Wire into scope-checker.ts assertCompleteRoutePolicyInventory():
 *     verifySeededPolicies(getRepos().governance);
 */
import { createHash } from "node:crypto";
import {
  EXPECTED_MANIFEST_VERSION,
  EXPECTED_MANIFEST_COUNT,
  EXPECTED_MANIFEST_DIGEST,
} from "./manifest-digest.generated.js";

/** Kept in sync with scripts/audit/seed-route-policy.mjs MANIFEST_MARKER_ID. */
export const MANIFEST_MARKER_ID = "__route_policy_manifest__";
/** The seeder's inert marker method + scope sentinel (matchRoute never matches it). */
const MARKER_METHOD = "MARKER";
const MARKER_SCOPE = "__marker__";

const VALID_SCOPES = new Set<string>([
  "operator", "requestor", "verifier", "admin", "agent", "auditor", "template_author",
]);
const VALID_METHODS = new Set<string>(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "*"]);
const DIGEST_RE = /^[0-9a-f]{64}$/;
// A clean /api/ route pattern: only these characters. Rejects query strings,
// spaces, control characters, and anything else in one ASCII-safe check.
const CLEAN_PATTERN_RE = /^\/api\/[A-Za-z0-9/_:*.-]*$/;

export interface EndpointScopeRowLike {
  id: string;
  method: string;
  routePattern: string;
  requiredScopes: string[];
  description: string | null;
}
export interface GovLike {
  findAllEndpointScopes(): EndpointScopeRowLike[];
}

export class RoutePolicyInventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutePolicyInventoryError";
  }
}

/** Same canonical digest the seeder writes (method + pattern + sorted scopes). */
function digestOf(rows: Array<{ method: string; pattern: string; scopes: string[] }>): string {
  const canon = rows
    .map((r) => `${r.method} ${r.pattern} ${[...r.scopes].sort().join(",")}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canon).digest("hex");
}

function fail(msg: string): never {
  throw new RoutePolicyInventoryError(msg);
}

/**
 * Verify the live endpoint_scopes table is a complete, untampered seed of THIS
 * build's manifest. Fails closed on: no/corrupt marker; missing or malformed
 * version/count/digest; version/count/digest not exactly the build constants; wrong
 * live row count; a malformed row (bad method, unclean /api pattern, empty /
 * duplicate / unknown / wildcard scope); a duplicate method+pattern; or a live
 * digest that differs from the build-trusted digest (drift / coordinated tamper).
 */
export function verifySeededPolicies(gov: GovLike): void {
  const all = gov.findAllEndpointScopes();

  const marker = all.find((r) => r.id === MANIFEST_MARKER_ID);
  if (!marker) {
    fail("route-policy manifest not seeded (no marker row). Run scripts/audit/seed-route-policy.mjs " +
      "before SCOPE_ENFORCEMENT_MODE=enforce.");
  }
  // The marker is excluded from the digest/structural checks below, so its WHOLE
  // row must retain the inert shape the seeder wrote — otherwise a tampered marker
  // (valid description, but method/pattern/scopes rewritten to a real protected
  // route) would become an active policy in the runtime scope cache while passing
  // this gate. Validate every field, not just the description.
  if (
    marker!.method !== MARKER_METHOD ||
    marker!.routePattern !== MANIFEST_MARKER_ID ||
    !Array.isArray(marker!.requiredScopes) ||
    marker!.requiredScopes.length !== 1 ||
    marker!.requiredScopes[0] !== MARKER_SCOPE
  ) {
    fail("route-policy marker row has been tampered (inert shape changed)");
  }
  let meta: { version?: unknown; count?: unknown; digest?: unknown };
  try {
    meta = JSON.parse(marker!.description ?? "{}");
  } catch {
    return fail("route-policy marker is corrupt (unparseable metadata)");
  }

  // Presence + shape — missing count/digest/version must NOT be tolerated.
  if (!Number.isInteger(meta.version)) fail("route-policy marker: version missing or malformed");
  if (!Number.isInteger(meta.count)) fail("route-policy marker: count missing or malformed");
  if (typeof meta.digest !== "string" || !DIGEST_RE.test(meta.digest)) {
    fail("route-policy marker: digest missing or malformed");
  }

  // EXACT equality against the build-trusted constants (the trust root).
  if (meta.version !== EXPECTED_MANIFEST_VERSION) {
    fail(`route-policy version ${meta.version} != expected ${EXPECTED_MANIFEST_VERSION} — reseed with this build's manifest`);
  }
  if (meta.count !== EXPECTED_MANIFEST_COUNT) {
    fail(`route-policy marker count ${meta.count} != expected ${EXPECTED_MANIFEST_COUNT}`);
  }
  if (meta.digest !== EXPECTED_MANIFEST_DIGEST) {
    fail("route-policy marker digest != build-trusted digest — reseed");
  }

  const rows = all
    .filter((r) => r.id !== MANIFEST_MARKER_ID && r.method !== MARKER_METHOD)
    .map((r) => ({ method: r.method, pattern: r.routePattern, scopes: r.requiredScopes }));

  if (rows.length !== EXPECTED_MANIFEST_COUNT) {
    fail(`route-policy inventory has ${rows.length} live rows, expected ${EXPECTED_MANIFEST_COUNT} — partial/extra seed, reseed`);
  }

  // Structural validity + de-dup (clear diagnostics; also fail-closed on any bad row).
  const seenRoute = new Set<string>();
  for (const r of rows) {
    if (!VALID_METHODS.has(r.method)) fail(`route-policy: invalid method "${r.method}" (${r.pattern})`);
    if (typeof r.pattern !== "string" || !CLEAN_PATTERN_RE.test(r.pattern)) {
      fail(`route-policy: unclean /api/ pattern (${r.method} ${JSON.stringify(r.pattern)})`);
    }
    if (!Array.isArray(r.scopes) || r.scopes.length === 0) {
      fail(`route-policy: empty scopes (${r.method} ${r.pattern})`);
    }
    const seenScope = new Set<string>();
    for (const s of r.scopes) {
      if (s === "*") fail(`route-policy: wildcard "*" scope forbidden (${r.method} ${r.pattern})`);
      if (!VALID_SCOPES.has(s)) fail(`route-policy: unknown scope "${s}" (${r.method} ${r.pattern})`);
      if (seenScope.has(s)) fail(`route-policy: duplicate scope "${s}" (${r.method} ${r.pattern})`);
      seenScope.add(s);
    }
    const key = `${r.method} ${r.pattern}`;
    if (seenRoute.has(key)) fail(`route-policy: duplicate method+pattern (${key})`);
    seenRoute.add(key);
  }

  // Integrity: the live rows must hash to the BUILD-trusted digest. This is what
  // defeats coordinated row+marker tampering — the constant cannot be forged.
  const live = digestOf(rows);
  if (live !== EXPECTED_MANIFEST_DIGEST) {
    fail(`route-policy table drift: live digest ${live.slice(0, 12)} != build-trusted ${EXPECTED_MANIFEST_DIGEST.slice(0, 12)} — reseed`);
  }
}
