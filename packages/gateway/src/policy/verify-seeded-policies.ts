/**
 * Runtime route-policy inventory gate (audit P0, lane d749deff).
 *
 * The RUNTIME half of the completeness guarantee (the build-time half is the CI
 * coverage gate, route-policy-coverage.test.ts, which proves the manifest covers
 * every /api/* route). This verifies the LIVE endpoint_scopes table was fully and
 * correctly seeded from the manifest before prod boots in enforce — so CI can't
 * pass on a complete JSON while production starts against an empty/stale/partial
 * policy table. Fails closed (throws) on any problem.
 *
 * Wire into scope-checker.ts assertCompleteRoutePolicyInventory():
 *     verifySeededPolicies(getRepos().governance);
 */
import { createHash } from "node:crypto";

/** Kept in sync with scripts/audit/seed-route-policy.mjs MANIFEST_MARKER_ID. */
export const MANIFEST_MARKER_ID = "__route_policy_manifest__";

/**
 * Minimum manifest version the deployed gateway will accept from the live table.
 * Bump in lockstep with the manifest's `version` field so a table seeded from an
 * older manifest than this build expects is rejected (fail closed).
 */
export const MIN_MANIFEST_VERSION = 1;

/** The manifest ships ~112 rules; a table far below that was not fully seeded. */
export const MIN_POLICY_ROWS = 100;

/** Minimal shape this gate needs — avoids a hard dependency on the repo type. */
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

/** Same canonical digest the seeder records (method + pattern + sorted scopes). */
function digestOf(rows: Array<{ method: string; pattern: string; scopes: string[] }>): string {
  const canon = rows
    .map((r) => `${r.method} ${r.pattern} ${[...r.scopes].sort().join(",")}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canon).digest("hex");
}

/**
 * Verify the live endpoint_scopes table is a complete, untampered seed of the
 * manifest. Throws RoutePolicyInventoryError on: no marker (never seeded), corrupt
 * marker, too few rows, count mismatch (partial seed), stale version, a malformed
 * row, or a digest mismatch (the table drifted from what the seeder wrote).
 */
export function verifySeededPolicies(gov: GovLike): void {
  const all = gov.findAllEndpointScopes();
  const marker = all.find((r) => r.id === MANIFEST_MARKER_ID);
  if (!marker) {
    throw new RoutePolicyInventoryError(
      "route-policy manifest not seeded (no marker row). Run scripts/audit/seed-route-policy.mjs " +
        "before SCOPE_ENFORCEMENT_MODE=enforce.",
    );
  }

  let meta: { version?: number; count?: number; digest?: string };
  try {
    meta = JSON.parse(marker.description ?? "{}");
  } catch {
    throw new RoutePolicyInventoryError("route-policy marker is corrupt (unparseable metadata)");
  }

  const rows = all
    .filter((r) => r.id !== MANIFEST_MARKER_ID && r.method !== "MARKER")
    .map((r) => ({ method: r.method, pattern: r.routePattern, scopes: r.requiredScopes }));

  if (rows.length < MIN_POLICY_ROWS) {
    throw new RoutePolicyInventoryError(
      `route-policy inventory too small: ${rows.length} rows (< ${MIN_POLICY_ROWS}) — reseed`,
    );
  }
  if (typeof meta.count === "number" && rows.length !== meta.count) {
    throw new RoutePolicyInventoryError(
      `route-policy partial seed: ${rows.length} live rows vs ${meta.count} recorded — reseed`,
    );
  }
  if ((meta.version ?? 0) < MIN_MANIFEST_VERSION) {
    throw new RoutePolicyInventoryError(
      `route-policy manifest too old: v${meta.version} < v${MIN_MANIFEST_VERSION} — reseed with the current manifest`,
    );
  }
  for (const r of rows) {
    if (!Array.isArray(r.scopes) || r.scopes.length === 0) {
      throw new RoutePolicyInventoryError(`malformed policy row (empty scopes): ${r.method} ${r.pattern}`);
    }
  }
  const live = digestOf(rows);
  if (meta.digest && live !== meta.digest) {
    throw new RoutePolicyInventoryError(
      `route-policy table drift: live digest ${live.slice(0, 12)} != seeded ${String(meta.digest).slice(0, 12)} — reseed`,
    );
  }
}
