#!/usr/bin/env node
/**
 * Migrate legacy wildcard API keys off "*" (audit P0, lane d749deff).
 *
 * Before C-01, every provisioned key was minted `scopes: ["*"]`. Under the fixed
 * scope-checker a literal "*" matches NO requirement, so every legacy key is
 * DENIED once enforce turns on. This re-scopes them SAFELY.
 *
 * SAFETY (review finding #1): `metadata.source === "landing-page"` proves only
 * that a key came through the old public provisioning endpoint — NOT that its
 * holder completed verified onboarding. operator/requestor scopes reach money
 * namespaces (escrow/settlement/fiat-ramp/pool/gasless), so auto-granting on
 * source alone would REINTRODUCE C-01. Therefore:
 *   - default: a wildcard key with NO authoritative verified-onboarding evidence
 *     is REPORTED for manual review — never auto-changed.
 *   - a wildcard key is auto-rescoped to [operator,requestor] ONLY when an
 *     injected `isVerifiedOnboarding(row)` predicate returns true (e.g. the key
 *     joins to an approved/activated onboarding registration). No predicate ⇒
 *     nothing is auto-migrated.
 * Apply is TOCTOU-safe: each key is re-read and re-checked (still active, still
 * exactly ["*"]) immediately before the update.
 *
 * Idempotent. DRY-RUN by default; pass --apply to write.
 *
 * Usage:
 *   node scripts/audit/migrate-wildcard-keys.mjs                 # dry-run report
 *   PCC_DB_PATH=/data/pcc.sqlite node ...migrate-wildcard-keys.mjs --apply
 */
import { pathToFileURL } from "node:url";

export const SELF_SERVICE_SCOPES = ["operator", "requestor"];

const isWildcardScopes = (raw) => {
  let s = [];
  try { s = JSON.parse(raw ?? "[]"); } catch { /* none */ }
  return Array.isArray(s) && s.length === 1 && s[0] === "*";
};

/**
 * Decide what to do with one key row. `isVerifiedOnboarding` is the ONLY thing
 * that authorizes an auto-grant; without it, wildcard keys go to manual review.
 */
export function classifyKey(row, isVerifiedOnboarding = () => false) {
  if (!isWildcardScopes(row.scopes)) return { action: "skip", reason: "not a wildcard key" };
  if (isVerifiedOnboarding(row)) {
    return { action: "rescope", to: SELF_SERVICE_SCOPES, reason: "authoritative verified-onboarding record" };
  }
  let meta = {};
  try { meta = JSON.parse(row.metadata ?? "{}") ?? {}; } catch { /* unknown */ }
  return {
    action: "review",
    reason: `wildcard key (source=${meta.source ?? "unknown"}) — NO verified-onboarding evidence; classify manually`,
  };
}

/** Build a migration plan from active-key rows. */
export function planMigration(rows, isVerifiedOnboarding = () => false) {
  const rescope = [], review = [], skip = [];
  for (const r of rows) {
    const c = classifyKey(r, isVerifiedOnboarding);
    if (c.action === "rescope") rescope.push({ id: r.id, operatorId: r.operatorId, to: c.to });
    else if (c.action === "review") review.push({ id: r.id, operatorId: r.operatorId, reason: c.reason });
    else skip.push(r.id);
  }
  return { rescope, review, skip };
}

/**
 * Apply the auto-rescope set. TOCTOU-safe AND re-authorizing (review R2 #3): for
 * each key, immediately before updating, re-read the fresh row and require it to be
 * still present, still exactly ["*"], and STILL verified by the authoritative
 * predicate (authorization can go stale between plan and apply). The plan's `to`
 * field is IGNORED — the hardcoded SELF_SERVICE_SCOPES is always what gets written,
 * so a crafted/tampered plan can never escalate. A predicate that throws fails
 * closed (skip), never grants. Returns { changed, skipped }.
 */
export function applyMigration(apiKeys, plan, isVerifiedOnboarding = () => false) {
  let changed = 0, skipped = 0;
  for (const k of plan.rescope) {
    const cur = apiKeys.findById(k.id);
    let ok = false;
    try {
      ok = !!cur && isWildcardScopes(cur.scopes) && isVerifiedOnboarding(cur) === true;
    } catch {
      ok = false; // predicate/authority failure → fail closed
    }
    if (!ok) {
      skipped++;
      continue;
    }
    // Ignore k.to — ALWAYS write the hardcoded least-privilege set.
    if (apiKeys.updateScopes(cur.id, SELF_SERVICE_SCOPES)) changed++;
    else skipped++;
  }
  return { changed, skipped };
}

// ── CLI ──
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) await runCli();

async function runCli() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dbIdx = args.indexOf("--db");
  const dbPath = dbIdx !== -1 ? args[dbIdx + 1]
    : (process.env.DATABASE_URL ?? process.env.PCC_DB_PATH ?? "./data/pcc.sqlite");

  // No verified-onboarding join wired here → NOTHING is auto-migrated by default.
  // Supply an isVerifiedOnboarding predicate (approved-registration join) to enable
  // the auto-rescope path; until then every wildcard key is manual-review.
  const isVerifiedOnboarding = () => false;

  const { createStore } = await import("@pcc/store");
  const store = createStore({ dbPath, seed: false });
  try {
    const rows = store.repos.apiKeys.listActive();
    const plan = planMigration(rows, isVerifiedOnboarding);
    console.log(`[migrate-wildcard-keys] active keys: ${rows.length} | auto-rescope: ${plan.rescope.length} | MANUAL REVIEW: ${plan.review.length} | skip: ${plan.skip.length}`);
    for (const k of plan.review) console.log(`  REVIEW  ${k.id} (${k.operatorId}) — ${k.reason}`);
    if (!apply) {
      console.log(`[migrate-wildcard-keys] DRY RUN. Wildcard keys are NEVER auto-granted on source alone — wire an approved-registration join to auto-migrate; otherwise classify the ${plan.review.length} review key(s) manually (rescope, leave scopeless, or revoke).`);
      return;
    }
    const res = applyMigration(store.repos.apiKeys, plan, isVerifiedOnboarding);
    console.log(`[migrate-wildcard-keys] APPLIED — re-scoped ${res.changed}, skipped ${res.skipped} (TOCTOU/inactive). ${plan.review.length} still need manual classification.`);
  } finally {
    store.close();
  }
}
