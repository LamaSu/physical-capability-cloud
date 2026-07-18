/**
 * Phase B renderer conformance (item 7). Plain Node, no deps:
 *   node --experimental-strip-types dashboard-ir-renderer.conformance.ts
 */
import assert from "node:assert/strict";
import { dashboardManifestToIr, validateIr } from "./dashboard-ir.js";
import { renderIrDoc, bindListRows, bindScalar, bindSchemaCard, bootIrView, type RElement, type RDocument } from "./dashboard-ir-renderer.js";

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

// ── Fixed PCC-owned schema cards (hollow-node binding) ────────────────────────────
// The manifest supplies a bind PATH only; PCC owns headings, labels, and each value's
// FIXED source key. Adversarial gates below prove the manifest can never relabel a
// field, surface an off-schema response field, or mint a privileged-looking receipt.
const scMan: any = { csd: "pcc://artifacts/dashboard/v1", title: "Ops", sections: [{ heading: "S", windows: [
  { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
  { kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/job/j1" }, statusFrom: "amount", latestFrom: "x" },
  { kind: "receipt", binding: { path: "/api/settlement/j1" } },
] }] };
const scR = dashboardManifestToIr(scMan);
ok("schema-card manifest → IR", scR.ok);
if (!scR.ok) throw new Error("stop");
const scMount = makeEl("div");
ok("schema-card doc paints", bootIrView(doc, scMount, scR.doc, validateIr) === true);
const scTexts = texts(scMount);
ok("capability card FIXED heading painted", scTexts.includes("Capability"));
ok("capability FIXED labels painted", scTexts.includes("Name") && scTexts.includes("Assurance tiers") && scTexts.includes("Available"));
ok("run card FIXED heading painted", scTexts.includes("Run"));
ok("run FIXED labels painted", scTexts.includes("Status") && scTexts.includes("Progress"));
ok("settlement record FIXED read-only heading painted", scTexts.includes("Settlement record (read-only)"));
ok("settlement record carries the FIXED 'not proof of payment' warning", scTexts.some((t) => t.includes("Not proof of payment")));
// The unbound data cards default to the honest "—" until a GET lands (finding 1a): after
// paint (no fetch in this harness) every value slot reads "—", never an empty partial.
ok("data-card value slots default to '—' (honest unavailable pre-fetch)", (() => {
  const vals = flat(scMount).filter((n: any) => String(n.className).split(" ").includes("pcc-value"));
  return vals.length > 0 && vals.every((n: any) => n.textContent === "—");
})());

// GATE R — the settlement record is STATIC: it renders EXACTLY the fixed heading + warning,
// with NO value slots, so a manifest binding can never make it fetch or display any data.
{
  const rMount = makeEl("div");
  const rR: any = dashboardManifestToIr({ csd: "x", title: "t", sections: [{ windows: [{ kind: "receipt", binding: { path: "/api/settlement/j1" } }] }] } as any);
  bootIrView(doc, rMount, rR.doc, validateIr);
  const receiptEl = flat(rMount).find((n: any) => String(n.className).split(" ").includes("pcc-receipt"));
  const rValues = flat(rMount).filter((n: any) => String(n.className).split(" ").includes("pcc-value"));
  const rt = texts(receiptEl);
  ok("GATE-R settlement pointer has NO value slots (nothing is fetched)", rValues.length === 0);
  ok("GATE-R settlement pointer text is EXACTLY the fixed heading + warning", rt.length === 2 && rt.includes("Settlement record (read-only)") && rt.some((x: string) => x.includes("Not proof of payment")));
  ok("GATE-R settlement pointer never emits Paid/Verified (no fetched money field)", !/Paid|Verified/.test(rt.join(" ")));
}

const slots = (n: number) => Array.from({ length: n }, () => ({ textContent: "" }));
// GATE 1 — manifest selectors can NEVER relabel a field. The run window's statusFrom is
// "amount"; the render reads the FIXED `status` key, never the manifest-selected `amount`.
{
  const s = slots(2);
  bindSchemaCard("run-summary-v1", { status: "running", progress: 40, amount: 999 }, s);
  ok("GATE1 run Status ← fixed `status` (NOT manifest statusFrom→amount)", s[0].textContent === "running");
  ok("GATE1 run manifest-selected `amount` NEVER rendered", !s.some((x) => x.textContent.includes("999")));
}
// GATE 1b — dual-shape: the /jobs/:id detail envelope nests status/progress under `job`; the
// FIXED fallback key reads job.status/job.progress (a KNOWN server shape, not a manifest sel).
{
  const s = slots(2);
  bindSchemaCard("run-summary-v1", { job: { status: "queued", progress: 5 }, evidence: [] }, s);
  ok("GATE1b run reads job.status/job.progress from the detail envelope", s[0].textContent === "queued" && s[1].textContent === "5");
}
// GATE 2 — off-schema response fields (paid/verified/HTML) are NEVER rendered on a data card.
{
  const s = slots(6);
  bindSchemaCard("capability-summary-v1", { name: "FDM", type: "t", pricing: { baseCost: "1", currency: "USDC" }, assuranceTiers: [0], available: true, paid: true, verified: true, evil: "<b>x</b>" }, s);
  const all = s.map((x) => x.textContent).join("|");
  ok("GATE2 only the 6 fixed capability fields rendered", all === "FDM|t|1|USDC|0|Yes");
  ok("GATE2 off-schema paid/verified/HTML NEVER rendered", !all.includes("true") && !all.includes("<b>"));
}
// GATE 3 — missing/malformed canonical fields → honest unavailable (—), not a partial card.
{
  const s = slots(2);
  bindSchemaCard("run-summary-v1", { status: "running" }, s); // progress absent from both shapes
  ok("GATE3 missing progress → unavailable marker", s[1].textContent === "—");
  ok("GATE3 present status still shown", s[0].textContent === "running");
}
// GATE 5 — capability reads the KNOWN DTO shape (structured pricing, plural assuranceTiers
// array joined, boolean normalized); off-schema fields never leak.
{
  const s = slots(6);
  bindSchemaCard("capability-summary-v1", { name: "FDM", type: "3d-printing", pricing: { baseCost: "2.00", currency: "USDC" }, assuranceTiers: [0, 1, 2], available: true, secret: "LEAK" }, s);
  ok("GATE5 name/type/pricing.baseCost/currency read from fixed keys", s[0].textContent === "FDM" && s[1].textContent === "3d-printing" && s[2].textContent === "2.00" && s[3].textContent === "USDC");
  ok("GATE5 assuranceTiers array joined", s[4].textContent === "0, 1, 2");
  ok("GATE5 boolean available normalized to Yes", s[5].textContent === "Yes");
  ok("GATE5 off-schema `secret` NEVER rendered", !s.some((x) => x.textContent.includes("LEAK")));
}

console.log(`\n[dashboard-ir-renderer conformance] PASS — ${passed} checks`);
