#!/usr/bin/env node
/**
 * Migrate legacy wildcard API keys off "*" (audit P0, lane d749deff).
 *
 * Before C-01, every provisioned key was minted `scopes: ["*"]`. Under the fixed
 * scope-checker a literal "*" scope now matches NO requirement, so every legacy
 * key is DENIED everything once enforce turns on. This re-scopes them safely.
 *
 * Classification (never blindly convert — a wildcard key may be an admin,
 * verifier, or internal service):
 *   - self-service keys (metadata.source === "landing-page") -> ["operator","requestor"]
 *   - everything else -> REPORTED for manual classification, NOT auto-changed
 *
 * Idempotent: a non-wildcard key is skipped. DRY-RUN by default; pass --apply to
 * write. Exports classifyKey / planMigration / applyMigration for the test.
 *
 * Usage:
 *   node scripts/audit/migrate-wildcard-keys.mjs                 # dry-run report
 *   PCC_DB_PATH=/data/pcc.sqlite node ...migrate-wildcard-keys.mjs --apply
 */
import { pathToFileURL } from "node:url";

export const SELF_SERVICE_SCOPES = ["operator", "requestor"];

/** Decide what to do with one key row. */
export function classifyKey(row) {
  let scopes = [];
  try { scopes = JSON.parse(row.scopes); } catch { /* treat as none */ }
  const isWildcard = Array.isArray(scopes) && scopes.length === 1 && scopes[0] === "*";
  if (!isWildcard) return { action: "skip", reason: "not a wildcard key" };

  let meta = {};
  try { meta = JSON.parse(row.metadata ?? "{}") ?? {}; } catch { /* unknown source */ }
  if (meta.source === "landing-page") {
    return { action: "rescope", to: SELF_SERVICE_SCOPES, reason: "self-service (landing-page) key" };
  }
  return { action: "review", reason: `wildcard key, source=${meta.source ?? "unknown"} — classify manually` };
}

/** Build a migration plan from the active-key rows. */
export function planMigration(rows) {
  const rescope = [], review = [], skip = [];
  for (const r of rows) {
    const c = classifyKey(r);
    if (c.action === "rescope") rescope.push({ id: r.id, operatorId: r.operatorId, to: c.to });
    else if (c.action === "review") review.push({ id: r.id, operatorId: r.operatorId, reason: c.reason });
    else skip.push(r.id);
  }
  return { rescope, review, skip };
}

/** Apply only the auto-rescope set (self-service keys). Returns count changed. */
export function applyMigration(apiKeys, plan) {
  let changed = 0;
  for (const k of plan.rescope) {
    if (apiKeys.updateScopes(k.id, k.to)) changed++;
  }
  return changed;
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

  const { createStore } = await import("@pcc/store");
  const store = createStore({ dbPath, seed: false });
  try {
    const rows = store.repos.apiKeys.listActive();
    const plan = planMigration(rows);
    console.log(`[migrate-wildcard-keys] active keys: ${rows.length} | auto-rescope: ${plan.rescope.length} | MANUAL REVIEW: ${plan.review.length} | skip: ${plan.skip.length}`);
    for (const k of plan.review) console.log(`  REVIEW  ${k.id} (${k.operatorId}) — ${k.reason}`);
    if (!apply) {
      console.log(`[migrate-wildcard-keys] DRY RUN — pass --apply to re-scope the ${plan.rescope.length} self-service key(s). Review keys are NEVER auto-changed.`);
      return;
    }
    const changed = applyMigration(store.repos.apiKeys, plan);
    console.log(`[migrate-wildcard-keys] APPLIED — re-scoped ${changed} self-service key(s) to [${SELF_SERVICE_SCOPES.join(",")}]. ${plan.review.length} still need manual classification.`);
  } finally {
    store.close();
  }
}
