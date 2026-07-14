#!/usr/bin/env node
/**
 * Comparator divergence check (audit P0, lane d749deff; review R2 #5 / R3 #7).
 *
 * The runtime scope-checker (9de363c7) currently carries its OWN inline policy
 * comparator instead of importing the canonical policy/route-policy-precedence.ts.
 * That is a latent divergence: its 4-key `[methodExact, literalSegs, -doubleStars,
 * -singleStars]` + localeCompare tie-break lacks the canonical 5th `literalChars`
 * key and ambiguity rejection. This script proves whether the two pick DIFFERENT
 * winners on the ACTUALLY-shipped manifest (latent, safe today) or the same
 * (no divergence) — verified, not inferred.
 *
 * Portable: imports its sibling by relative path (Node resolves it against this
 * module's own URL), so it runs from any checkout / CI, not just one workstation.
 * Exits non-zero on any winner divergence or any ambiguity mine rejects — so CI
 * fails if the shipped policy set ever develops a case the two comparators disagree
 * on. The DURABLE fix is 9de363c7 importing route-policy-precedence.ts (flagged).
 *
 * Usage:  node scripts/audit/comparator-divergence-check.mjs
 */
import { buildInventory, resolvePolicy } from "./route-policy-inventory.mjs";

// EXACT replica of 9de363c7 scope-checker.ts policySpecificityKey/comparePolicySpecificity
// (fix/audit-p0 @ 3c4dfff0). Kept in sync by hand until the runtime imports the
// canonical module; this replica is the thing under test, not a source of truth.
function theirKey(r) {
  const literalSegs = r.pattern.split("/").filter((s) => s && !s.includes("*")).length;
  const doubleStars = (r.pattern.match(/\*\*/g) ?? []).length;
  const singleStars = (r.pattern.match(/\*/g) ?? []).length - 2 * doubleStars;
  const methodExact = r.method === "*" ? 0 : 1;
  return [methodExact, literalSegs, -doubleStars, -singleStars];
}
function theirCompare(a, b) {
  const ka = theirKey(a), kb = theirKey(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
  return a.method === b.method ? a.pattern.localeCompare(b.pattern) : a.method.localeCompare(b.method);
}
function theirWinnerScopes(matching) {
  if (!matching.length) return null;
  return [...[...matching].sort(theirCompare)[0].scopes].sort().join(",");
}

const concretize = (p) => p.replace(/:[A-Za-z0-9_]+/g, "x");
const inv = buildInventory();
// Full inventory (all of gateway/src after R3 #4), private routes only.
const priv = inv.routes.filter((r) => r.bucket !== "public" && r.bucket !== "cross_lane_pending");

let diverge = 0, ambigMine = 0, checked = 0;
for (const r of priv) {
  const mine = resolvePolicy(r.method, concretize(r.path));
  if (!mine.winner) continue;
  checked++;
  if (mine.ambiguous) { ambigMine++; console.log(`AMBIGUOUS (mine rejects, theirs picks): ${r.method} ${r.path}`); continue; }
  const theirs = theirWinnerScopes(mine.matching);
  const mineScopes = [...mine.scopes].sort().join(",");
  if (theirs !== mineScopes) {
    diverge++;
    console.log(`DIVERGE ${r.method} ${r.path}\n   mine=[${mineScopes}]  theirs=[${theirs}]`);
  }
}

console.log(`\nprivate routes checked: ${checked}`);
console.log(`ambiguous (mine rejects / theirs silently orders): ${ambigMine}`);
console.log(`winner divergences: ${diverge}`);
if (diverge === 0 && ambigMine === 0) {
  console.log("=> OK: identical winners on the shipped manifest. Reconcile at merge (9de363c7 imports the canonical module).");
  process.exit(0);
} else {
  console.log("=> DIVERGENCE: the runtime inline comparator disagrees with the canonical — reconciliation is now a blocker.");
  process.exit(1);
}
