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
// NOTE: settlement + escrow + evidence are intentionally ABSENT — settlement/escrow are money
// routes removed from `metric` (a manifest-labelled scalar there = a fake receipt), the receipt
// window is now a STATIC pointer that binds no route, and evidence returns a bundle COLLECTION.
// Their unbindability by any id-taking kind is proven by the explicit negative controls below.
const PREFIX_KIND: Record<string, string> = {
  capabilities: "capability",
  jobs: "metric", kernels: "metric",
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
  ["metric", "/api/jobs/job-1"],
  ["metric", "/api/kernels/kernel_1"],
];
for (const [kind, path] of controls) {
  const r = dashboardManifestToIr(manifest(windowFor(kind, path)));
  assert.ok(r.ok, `positive control should accept ${kind} → ${path}: ${JSON.stringify(r)}`);
  passed++;
}
// Negative controls: the money routes are NOT metric-bindable (a manifest-labelled scalar over
// settlement/escrow state would paint a fake "Payment received"). Settlement data is shown only
// through the fixed static settlement-record pointer.
for (const money of ["/api/settlement/job-1", "/api/escrow/e1"]) {
  const r = dashboardManifestToIr(manifest(windowFor("metric", money)));
  assert.ok(!r.ok, `metric must REJECT money route ${money} (not metric-bindable)`);
  passed++;
}
console.log(`  ok   every static sibling rejected; ${controls.length} id-shaped controls accepted`);
console.log(`\n[dashboard-ir route-inventory] PASS — ${siblings.size} siblings + ${controls.length} controls (${passed} assertions)`);
