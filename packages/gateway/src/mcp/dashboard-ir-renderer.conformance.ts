/**
 * Phase B renderer conformance (item 7). Plain Node, no deps:
 *   node --experimental-strip-types dashboard-ir-renderer.conformance.ts
 */
import assert from "node:assert/strict";
import { dashboardManifestToIr, validateIr } from "./dashboard-ir.js";
import { renderIrDoc, bindListRows, bindScalar, bootIrView, type RElement, type RDocument } from "./dashboard-ir-renderer.js";

let passed = 0;
const ok = (n: string, c: boolean, d?: string) => { assert.ok(c, `${n}${d ? " — " + d : ""}`); passed++; console.log(`  ok   ${n}`); };

// Fake DOM. NOTE: no innerHTML member exists — a painter physically cannot set one.
function makeEl(tag: string): RElement {
  const attrs: Record<string, string> = {};
  const kids: RElement[] = [];
  const e: any = {
    tagName: tag, textContent: "", className: "", children: kids, attrs,
    setAttr(name: string, value: string) { attrs[name] = value; },
    appendChild(c: RElement) { kids.push(c); return c; },
  };
  return e as RElement;
}
const doc: RDocument = { createElement: makeEl };
const flat = (n: any): any[] => { const o = [n]; for (const c of n.children) o.push(...flat(c)); return o; };
const flatIr = (n: any): any[] => { const o = [n]; for (const c of (n.children || [])) o.push(...flatIr(c)); return o; };
const texts = (n: any): string[] => flat(n).map((x) => x.textContent).filter((t) => t !== "");
const classes = (n: any): string[] => flat(n).flatMap((x) => String(x.className).split(" ")).filter(Boolean);

// Build a valid IR from a valid manifest.
const manifest: any = { csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "Sec A", windows: [
  { kind: "note", text: "hello <b>not-html</b>" },
  { kind: "metric", label: "Balance", select: "usdc", binding: { path: "/api/fiat-ramp/cdp/wallet/0xabc/balance" } },
  { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId"], statusFrom: "status" }, limit: 3 },
  { kind: "approval", binding: { path: "/api/escrow/e1" }, approve: { operation_id: "job.cancel" } },
  { kind: "actions", actions: [{ id: "a", label: "Refresh", operation_id: "job.cancel" }] },
] }] };
const r = dashboardManifestToIr(manifest);
ok("manifest → IR", r.ok);
if (!r.ok) throw new Error("stop");

// bootIrView validates in-browser then paints.
const mount = makeEl("div");
ok("bootIrView paints a valid doc", bootIrView(doc, mount, r.doc, validateIr) === true);
const nodes = flat(mount);
ok("title heading text rendered via textContent", texts(mount).includes("Ops"));
ok("section heading rendered", texts(mount).includes("Sec A"));
ok("note text is INERT (verbatim, not parsed)", texts(mount).includes("hello <b>not-html</b>"));
ok("stat label rendered, value slot empty until bound", texts(mount).includes("Balance"));
ok("approval static notice rendered", texts(mount).some((t) => t.includes("authenticated PCC surface")));
ok("action label → badge text", texts(mount).includes("Refresh"));
ok("untrusted prose carries pcc-untrusted class", classes(mount).includes("pcc-untrusted"));
ok("no <script>/<iframe>/raw-html tag ever created", nodes.every((n: any) => n.tagName === "div"));

// in-browser validation gate: an invalid doc paints ONE inert notice, nothing else.
const bad = makeEl("div");
ok("bootIrView REJECTS invalid doc", bootIrView(doc, bad, { ir: "x", title: {}, root: {} }, validateIr) === false);
ok("rejected doc paints exactly one inert notice", bad.children.length === 1 && String(bad.children[0].className).includes("pcc-invalid"));

// a doc that is structurally an object but fails validateIr (tampered node type)
const tampered = JSON.parse(JSON.stringify(r.doc));
tampered.root.children[0].children[1].type = "iframe"; // off-catalog
const bad2 = makeEl("div");
ok("bootIrView REJECTS a tampered (off-catalog) doc", bootIrView(doc, bad2, tampered, validateIr) === false);

// schema-validated dynamic rows: only declared selectors, malformed rows dropped.
const listNode = flatIr(r.doc.root).find((n: any) => n.type === "list");
ok("found a list node", !!listNode);
const listEl = makeEl("div");
bindListRows(doc, listEl, listNode, [
  { id: "j1", kernelId: "k9", status: "done", secret: "LEAK" },
  { bad: 1 }, {}, "string-row", null,
  { id: "j2" },
]);
const rowTexts = flat(listEl).map((x: any) => x.textContent).filter(Boolean);
ok("valid rows rendered (j1 with meta+status, j2 title-only)", rowTexts.includes("j1") && rowTexts.includes("k9") && rowTexts.includes("done") && rowTexts.includes("j2"));
ok("malformed rows dropped (no phantom output)", listEl.children.length === 2);
ok("non-selector field ('secret') NEVER rendered", !rowTexts.includes("LEAK"));

// scalar bind: own-property read, proto-safe.
ok("bindScalar reads declared select", bindScalar({ type: "stat", id: "n1", bind: { path: "/api/x", select: "usdc" } } as any, { usdc: "42.5" }) === "42.5");
ok("bindScalar proto segment → empty (no traversal)", bindScalar({ type: "stat", id: "n1", bind: { path: "/api/x", select: "__proto__" } } as any, {}) === "");
ok("bindScalar drops nested-object value (scalar only)", bindScalar({ type: "stat", id: "n1", bind: { path: "/api/x", select: "a" } } as any, { a: { nested: 1 } }) === "");

console.log(`\n[dashboard-ir-renderer conformance] PASS — ${passed} checks`);
