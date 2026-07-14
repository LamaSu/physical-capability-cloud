#!/usr/bin/env node
/**
 * Seed the route-policy manifest into the endpoint_scopes table (audit P0, lane
 * d749deff). The gateway scope-checker's mergeScopeRequirements loads these rows
 * and merges them OVER the 11 code DEFAULT_SCOPE_REQUIREMENTS — so this seeder is
 * what makes the 557-rule manifest actually enforce. Run it before flipping
 * SCOPE_ENFORCEMENT_MODE from report-only to enforce.
 *
 * Idempotent: upserts by a deterministic id derived from method+pattern, so
 * re-running updates in place (no duplicates). Validates EVERY rule first and
 * refuses to seed if any is malformed, contains a wildcard "*" scope, or an
 * unknown scope — a policy must never grant wildcard.
 *
 * Usage:
 *   PCC_DB_PATH=/data/pcc.sqlite node scripts/audit/seed-route-policy.mjs
 *   node scripts/audit/seed-route-policy.mjs --db :memory: --dry-run
 *
 * Exports validateManifest / seedRoutePolicies / ruleId for the test.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "route-policy-manifest.json");

// The gateway scope vocabulary (scope-checker.ts / DEFAULT_SCOPE_REQUIREMENTS).
export const VALID_SCOPES = new Set([
  "operator", "requestor", "verifier", "admin", "agent", "auditor", "template_author",
]);

/** Deterministic id so re-seeding upserts the same row. */
export function ruleId(method, pattern) {
  return "rp_" + createHash("sha256").update(`${method} ${pattern}`).digest("hex").slice(0, 20);
}

/** Returns a list of validation errors ([] means the manifest is safe to seed). */
export function validateManifest(rules) {
  const errors = [];
  if (!Array.isArray(rules) || rules.length === 0) return ["manifest has no rules"];
  const seen = new Set();
  for (const r of rules) {
    const where = `${r?.method} ${r?.pattern}`;
    if (!r || typeof r.method !== "string" || typeof r.pattern !== "string" ||
        !Array.isArray(r.scopes) || r.scopes.length === 0) {
      errors.push(`malformed rule: ${JSON.stringify(r)}`);
      continue;
    }
    if (r.scopes.includes("*")) errors.push(`wildcard "*" scope forbidden in a policy: ${where}`);
    // "*" is already reported as wildcard above; don't also flag it as unknown.
    for (const s of r.scopes) if (s !== "*" && !VALID_SCOPES.has(s)) errors.push(`unknown scope "${s}": ${where}`);
    const key = `${r.method} ${r.pattern}`;
    if (seen.has(key)) errors.push(`duplicate rule: ${where}`);
    seen.add(key);
  }
  return errors;
}

/** The endpoint_scopes id of the manifest marker row (inert: method "MARKER"). */
export const MANIFEST_MARKER_ID = "__route_policy_manifest__";

/**
 * Order-independent digest of the policy set (method + pattern + sorted scopes).
 * The seeder records it in the marker row; a runtime gate recomputes it over the
 * LIVE rows and compares — so prod can't boot enforce against a stale/partial
 * table even though CI proved the manifest file is complete.
 */
export function manifestDigest(rules) {
  const canon = rules
    .map((r) => `${r.method} ${r.pattern} ${[...r.scopes].sort().join(",")}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canon).digest("hex");
}

/** Write/refresh the marker row recording {version, count, digest} of this seed. */
export function writeManifestMarker(gov, rules, version) {
  const meta = JSON.stringify({ version: version ?? 0, count: rules.length, digest: manifestDigest(rules) });
  const row = {
    id: MANIFEST_MARKER_ID,
    method: "MARKER", // never a real HTTP method → matchRoute never matches it (inert)
    routePattern: MANIFEST_MARKER_ID,
    requiredScopes: ["__marker__"],
    description: meta,
  };
  if (gov.findEndpointScopeById(MANIFEST_MARKER_ID)) gov.updateEndpointScope(MANIFEST_MARKER_ID, row);
  else gov.insertEndpointScope(row);
  return meta;
}

/** Upsert every rule into endpoint_scopes via the governance repo. */
export function seedRoutePolicies(gov, rules) {
  let inserted = 0, updated = 0;
  for (const r of rules) {
    const id = ruleId(r.method, r.pattern);
    const row = {
      id,
      method: r.method,
      routePattern: r.pattern,
      requiredScopes: r.scopes,
      description: r.note ?? null,
    };
    if (gov.findEndpointScopeById(id)) {
      gov.updateEndpointScope(id, row);
      updated++;
    } else {
      gov.insertEndpointScope(row);
      inserted++;
    }
  }
  return { inserted, updated, total: rules.length };
}

// ── CLI (only when run directly) ──
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) await runCli();

async function runCli() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx !== -1 ? args[dbIdx + 1]
    : (process.env.DATABASE_URL ?? process.env.PCC_DB_PATH ?? "./data/pcc.sqlite");

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  const rules = manifest.rules;
  const errors = validateManifest(rules);
  if (errors.length) {
    console.error(`[seed-route-policy] REFUSING to seed — ${errors.length} invalid rule(s):`);
    for (const e of errors) console.error("  " + e);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[seed-route-policy] DRY RUN — ${rules.length} valid rules; would upsert into endpoint_scopes at ${dbPath}`);
    return;
  }

  const { createStore } = await import("@pcc/store");
  const store = createStore({ dbPath, seed: false });
  try {
    const res = seedRoutePolicies(store.repos.governance, rules);
    const marker = writeManifestMarker(store.repos.governance, rules, manifest.version);
    console.log(`[seed-route-policy] endpoint_scopes seeded at ${dbPath}: ${res.inserted} inserted, ${res.updated} updated (${res.total} total). marker ${marker}`);
  } finally {
    store.close();
  }
}
