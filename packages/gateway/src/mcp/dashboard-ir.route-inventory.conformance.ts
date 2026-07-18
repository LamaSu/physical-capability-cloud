/**
 * Phase B route-inventory collision proof (sol R7 finding 1). Plain Node, no deps:
 *   node --experimental-strip-types dashboard-ir.route-inventory.conformance.ts
 *
 * The id-grammar closes the CURRENT collision class, but is not mathematically complete
 * for FUTURE routes (a sibling with a digit/underscore could slip it). This test scans
 * the REAL src/routes/*.ts, auto-inventories every static single-segment sibling of each
 * allowed detail template, and proves the adapter's bind gate REJECTS each one. If a new
 * colliding sibling is ever added, THIS test fails — the durable guard sol asked for.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { dashboardManifestToIr } from "./dashboard-ir.js";

const ROUTES = join(dirname(fileURLToPath(import.meta.url)), "..", "routes");
// Detail templates in BIND_POLICY that take a `:seg` id, keyed by the window kind that binds them.
// NOTE: evidence is intentionally ABSENT — the settlement-record profile dropped
// /api/evidence/: entirely (it returns a bundle COLLECTION, not a settlement record).
// Its total unbindability is proven by the explicit negative control below.
const PREFIX_KIND: Record<string, string> = {
  capabilities: "capability", settlement: "receipt",
  jobs: "metric", kernels: "metric", escrow: "metric",
};
// A window of `kind` binding to `path` (metric/receipt/capability are the id-taking kinds).
function windowFor(kind: string, path: string): any {
  if (kind === "metric") return { kind, label: "L", select: "u", binding: { path } };
  return { kind, binding: { path } };
}
const manifest = (win: any) => ({ csd: "x", title: "t", sections: [{ windows: [win] }] });

// Scan every route file for `/api/<prefix>/<static-word>` (a single static segment; params
// like `:capId` are skipped because ":" is excluded from the segment class).
const SIB = new RegExp(`/api/(${Object.keys(PREFIX_KIND).join("|")})/([A-Za-z0-9_][A-Za-z0-9_-]*)`, "g");
const siblings = new Map<string, string>(); // path → prefix
let scanned = 0;
for (const f of readdirSync(ROUTES)) {
  if (!f.endsWith(".ts")) continue;
  scanned++;
  const src = readFileSync(join(ROUTES, f), "utf8");
  let m: RegExpExecArray | null;
  while ((m = SIB.exec(src)) !== null) {
    const [, prefix, word] = m;
    // exclude obvious non-route matches: require it to appear inside a quoted/backtick route literal
    const at = m.index;
    const before = src.slice(Math.max(0, at - 2), at);
    if (!/["'`\/]/.test(before[before.length - 1] ?? "")) continue;
    siblings.set(`/api/${prefix}/${word}`, prefix);
  }
}

console.log(`  scanned ${scanned} route files; found ${siblings.size} static single-segment siblings`);
let passed = 0;
const leaks: string[] = [];
for (const [path, prefix] of siblings) {
  const kind = PREFIX_KIND[prefix];
  const r = dashboardManifestToIr(manifest(windowFor(kind, path)));
  if (r.ok) leaks.push(`${kind} → ${path}`);
  else passed++;
}
if (leaks.length) { console.error("  LEAKS (bind gate ACCEPTED a non-detail sibling):\n   " + leaks.join("\n   ")); }
assert.equal(leaks.length, 0, `${leaks.length} route-collision leak(s)`);

// Positive control: a real id-shaped path for each id-taking kind is ACCEPTED (proves the
// test isn't vacuously rejecting everything).
const controls: Array<[string, string]> = [
  ["capability", "/api/capabilities/cap-1"],
  ["receipt", "/api/settlement/job-1"],
  ["metric", "/api/jobs/job-1"],
  ["metric", "/api/kernels/kernel_1"],
];
for (const [kind, path] of controls) {
  const r = dashboardManifestToIr(manifest(windowFor(kind, path)));
  assert.ok(r.ok, `positive control should accept ${kind} → ${path}: ${JSON.stringify(r)}`);
  passed++;
}
// Negative control: evidence is fully dropped from the settlement-record profile — even a
// detail-id-shaped evidence path must be REJECTED (an evidence bundle collection must never
// masquerade as a settlement record). Proves sol's drop, independent of the sibling scan.
{
  const r = dashboardManifestToIr(manifest(windowFor("receipt", "/api/evidence/job-1")));
  assert.ok(!r.ok, "receipt must REJECT /api/evidence/:id (dropped from the settlement-record profile)");
  passed++;
}
console.log(`  ok   every static sibling rejected; ${controls.length} id-shaped controls accepted`);
console.log(`\n[dashboard-ir route-inventory] PASS — ${siblings.size} siblings + ${controls.length} controls (${passed} assertions)`);
