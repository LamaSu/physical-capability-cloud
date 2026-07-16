/**
 * Phase B conformance for dashboard-ir.ts (R5 hardened). Plain Node, no deps:
 *   node --experimental-strip-types dashboard-ir.conformance.ts
 * The real projection→adapter chain is covered by dashboard-ir.integration.test.ts (vitest/CI).
 */
import assert from "node:assert/strict";
import { dashboardManifestToIr, validateIr, IR_NODE_TYPES } from "./dashboard-ir.ts";
const FROZEN = new Set<string>(IR_NODE_TYPES);
let passed = 0;
const ok = (n: string, c: boolean, d?: string) => { assert.ok(c, `${n}${d ? " — " + d : ""}`); passed++; console.log(`  ok   ${n}`); };
const flat = (doc: any) => { const o: any[] = []; const w = (n: any) => { o.push(n); (n.children || []).forEach(w); }; w(doc.title); w(doc.root); return o; };

const projected: any = {
  csd: "pcc://artifacts/dashboard/v1", title: "Ops",
  sections: [{ heading: "Section A", windows: [
    { kind: "note", text: "hello <b>world</b>" },
    { kind: "metric", label: "Balance", select: "usdc", binding: { path: "/api/fiat-ramp/cdp/wallet/0xabc/balance" } },
    { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
    { kind: "receipt", binding: { path: "/api/settlement/j1" } },
    { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId", "status"], statusFrom: "status" }, limit: 5 },
    { kind: "form", schema: { type: "object", properties: { amount: { title: "Amount", type: "number" }, asset: {} } }, submit: { operation_id: "escrow.fund" } },
    { kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/job/j1" }, statusFrom: "status", latestFrom: "latest" },
    { kind: "approval", binding: { path: "/api/escrow/e1" }, approve: { operation_id: "job.cancel" }, deny: { operation_id: "x.y" } },
    { kind: "chain", composeRef: { id: "c1" }, execute: { operation_id: "compose.execute" } },
    { kind: "actions", actions: [{ id: "a", label: "Refresh", operation_id: "job.cancel" }] },
  ] }],
};
const r = dashboardManifestToIr(projected);
ok("valid manifest → IR", r.ok, r.ok ? "" : (r as any).reason);
if (!r.ok) throw new Error("stop");
const doc = r.doc, nodes = flat(doc);
ok("validateIr passes", validateIr(doc).ok === true, JSON.stringify(validateIr(doc)));
ok("frozen catalog is exactly 14 types", FROZEN.size === 14 && !FROZEN.has("progress") && !FROZEN.has("divider"));
ok("no actions/capability attrs", nodes.every((n) => !("actions" in n) && !("capability" in n)));
ok("all types frozen", nodes.every((n) => FROZEN.has(n.type)));
ok("all prose untrusted", nodes.filter((n) => ["text", "heading", "stat", "badge", "field-label"].includes(n.type)).every((n) => n.untrusted === true));
ok("doc.title untrusted H1", doc.title.type === "heading" && doc.title.props.level === 1 && doc.title.untrusted === true);
ok("section heading untrusted", nodes.some((n) => n.type === "heading" && n.props?.text === "Section A" && n.untrusted));
ok("metric stat: top-level select→bind.select, no format, bound, untrusted", (() => { const s = nodes.find((n) => n.type === "stat"); return s && s.bind?.select === "usdc" && !("format" in (s.props || {})) && s.untrusted === true && s.bind?.path === "/api/fiat-ramp/cdp/wallet/0xabc/balance"; })());
ok("form→form-summary, no field/button/form", nodes.some((n) => n.type === "form-summary") && !nodes.some((n) => ["field", "button", "form"].includes(n.type)));
ok("approval→approval-notice with NO bind", (() => { const a = nodes.find((n) => n.type === "approval-notice"); return a && !a.bind; })());
ok("chain→plan(composition)", nodes.some((n) => n.type === "plan" && n.props?.kind === "composition"));
ok("actions→1 badge, no button", nodes.filter((n) => n.type === "badge").length === 1 && !nodes.some((n) => n.type === "button"));
ok("receipt bind schema=receipt", nodes.find((n) => n.type === "receipt")?.bind?.schema === "receipt");
ok("run card sse/path correlated + selectors", (() => { const c = nodes.find((n) => n.type === "card" && n.props?.kind === "run"); return c && c.bind?.sse === "/sse/stream/job/j1" && c.props?.statusFrom === "status"; })());
ok("note text raw-preserved", nodes.find((n) => n.type === "text")?.props?.text === "hello <b>world</b>");

// smuggle: field-def with props/actions/type:button → REJECT (closed field grammar)
ok("smuggle field-def → REJECT", dashboardManifestToIr({ csd: "x", title: "x", sections: [{ windows: [{ kind: "form", schema: { properties: { x: { title: "X", type: "button", props: { capability: "escrow.fund" }, actions: [{ capability: "pay" }] } } }, submit: {} }] }] } as any).ok === false);

// ── strict rejection ──
const one = (win: any) => ({ csd: "x", title: "t", sections: [{ windows: [win] }] });
const bad = (name: string, m: any) => ok(`REJECT: ${name}`, dashboardManifestToIr(m).ok === false, JSON.stringify(dashboardManifestToIr(m)).slice(0, 120));
bad("unknown kind", one({ kind: "evil" }));
bad("extra key in window", one({ kind: "note", text: "a", evil: 1 }));
bad("section field 'title' (not heading)", { csd: "x", title: "t", sections: [{ title: "T", windows: [] }] });
// metric select is mandatory + top-level; format is disallowed; select-in-binding disallowed
bad("metric WITHOUT select", one({ kind: "metric", label: "L", binding: { path: "/api/jobs/j1" } }));
bad("metric WITH format (disallowed)", one({ kind: "metric", label: "L", select: "x", format: "usd", binding: { path: "/api/jobs/j1" } }));
bad("metric select inside binding (disallowed)", one({ kind: "metric", label: "L", binding: { path: "/api/jobs/j1", select: "x" } }));
bad("metric to DEAD /api/fiat-ramp/wallet/balance", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/fiat-ramp/wallet/balance" } }));
bad("metric to reserved /api/settlement/status", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/settlement/status" } }));
bad("metric to removed pool route", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/pool/p1" } }));
bad("metric to reserved /api/kernels/marketplace", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/kernels/marketplace" } }));
bad("capability reserved /types", one({ kind: "capability", binding: { path: "/api/capabilities/types" } }));
bad("receipt to escrow (not receipt route)", one({ kind: "receipt", binding: { path: "/api/escrow/e1" } }));
bad("list to /api/evidence (leak, not a list route)", one({ kind: "list", binding: { path: "/api/evidence" }, item: { title: "id" } }));
bad("list to /api/marketplace/orders (leak)", one({ kind: "list", binding: { path: "/api/marketplace/orders" }, item: { title: "id" } }));
bad("run sse/path IDENTITY MISMATCH", one({ kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/job/j2" }, statusFrom: "s", latestFrom: "l" }));
bad("sse outside allowlist", one({ kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/kernel/k1" }, statusFrom: "s", latestFrom: "l" }));
bad("path not /api", one({ kind: "metric", label: "L", select: "u", binding: { path: "/etc/passwd" } }));
bad("path with ..", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/../secret" } }));
bad("path single-dot segment", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/." } }));
bad("select proto segment", one({ kind: "metric", label: "L", select: "a.__proto__", binding: { path: "/api/jobs/j1" } }));
bad("select brackets", one({ kind: "metric", label: "L", select: "a[0]", binding: { path: "/api/jobs/j1" } }));
// normalized credential field names
bad("credential field token", one({ kind: "form", schema: { properties: { token: {} } }, submit: {} }));
bad("credential field api_key (normalized)", one({ kind: "form", schema: { properties: { api_key: {} } }, submit: {} }));
bad("credential field private_key (normalized)", one({ kind: "form", schema: { properties: { private_key: {} } }, submit: {} }));
bad("credential field authorization", one({ kind: "form", schema: { properties: { authorization: {} } }, submit: {} }));
bad("credential field Bearer (case)", one({ kind: "form", schema: { properties: { Bearer: {} } }, submit: {} }));
bad("credential field userPassword (substr)", one({ kind: "form", schema: { properties: { userPassword: {} } }, submit: {} }));
ok("NON-credential field 'author' is ALLOWED", dashboardManifestToIr(one({ kind: "form", schema: { properties: { author: { title: "Author" } } }, submit: { operation_id: "x.y" } })).ok === true);
// op-descriptor grammar (discarded but grammared)
bad("form.submit malformed shape", one({ kind: "form", schema: { properties: { a: {} } }, submit: { weird: "structure" } }));
bad("action bad operation_id grammar", one({ kind: "actions", actions: [{ label: "L", operation_id: "DROP TABLE; --" }] }));
bad("chain.execute malformed", one({ kind: "chain", composeRef: { id: "c" }, execute: { unknownField: 1 } }));
bad("field-def with type:button", one({ kind: "form", schema: { properties: { x: { type: "button" } } }, submit: {} }));
bad("query NaN", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/j1", query: { n: NaN } } }));
bad("__proto__ in manifest", JSON.parse('{"csd":"x","title":"x","sections":[],"__proto__":{"p":1}}'));
bad("nested proto in query", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/j1", query: JSON.parse('{"__proto__":{"p":1}}') } }));
bad("non-standard prototype manifest", Object.assign(Object.create({ polluted: 1 }), { csd: "x", title: "t", sections: [] }));
ok("null-proto manifest is SAFE (accepted)", dashboardManifestToIr(Object.assign(Object.create(null), { csd: "x", title: "t", sections: [] })).ok === true);
// symbol own key rejected (Reflect.ownKeys)
{ const s: any = { csd: "x", title: "t", sections: [] }; s[Symbol("x")] = 1; bad("symbol own key on manifest", s); }
bad("title too long", { csd: "x", title: "x".repeat(9999), sections: [] });
bad("too many sections", { csd: "x", title: "t", sections: Array.from({ length: 99 }, () => ({ windows: [] })) });

// ── R6: confirm enum, reserved-route completeness, poll-amplification cap, own-key depth ──
ok("action confirm:\"inline\" (real enum) ACCEPTED", dashboardManifestToIr(one({ kind: "actions", actions: [{ id: "a", label: "Approve", confirm: "inline", intentText: "pcc: approve", operation_id: "job.cancel" }] })).ok === true);
bad("action confirm:true (boolean, not enum)", one({ kind: "actions", actions: [{ label: "X", confirm: true }] }));
bad("receipt→/api/evidence/lit-status (Lit status leak)", one({ kind: "receipt", binding: { path: "/api/evidence/lit-status" } }));
bad("receipt→/api/evidence/archive (reserved)", one({ kind: "receipt", binding: { path: "/api/evidence/archive" } }));
bad("metric→/api/settlement/submit (reserved POST)", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/settlement/submit" } }));
bad("metric→/api/settlement/flush (reserved)", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/settlement/flush" } }));
bad("metric→/api/settlement/release (reserved)", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/settlement/release" } }));
bad("metric→/api/jobs/submit (reserved)", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/submit" } }));
bad("pollMs below 5000ms floor", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/j1", pollMs: 250 } }));
ok("pollMs at 5000ms floor ACCEPTED", dashboardManifestToIr(one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/j1", pollMs: 5000 } })).ok === true);
bad("bound-window budget (>64 binds)", { csd: "x", title: "t", sections: [{ windows: Array.from({ length: 65 }, () => ({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/j1" } })) }] });
{ const w: any = { kind: "note" }; Object.defineProperty(w, "text", { value: "hi", enumerable: false, configurable: true }); bad("non-enumerable allowed-name own key", one(w)); }
{ const secs: any = [{ windows: [] }]; secs.evil = 1; bad("extra own key on sections array", { csd: "x", title: "t", sections: secs }); }
{ const q: any = {}; Object.defineProperty(q, "n", { value: 1, enumerable: false, configurable: true }); bad("non-enumerable key in query", one({ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/j1", query: q } })); }

// ── validator parity (mirrors adapter) ──
const okTitle = { type: "heading", id: "n1", props: { level: 1, text: "x" }, untrusted: true };
const mkDoc = (root: any) => ({ ir: "pcc-dashboard-ir/v1", title: okTitle, root });
const vbad = (name: string, root: any) => ok(`validateIr REJECT: ${name}`, validateIr(mkDoc(root)).ok === false);
const rootWith = (child: any) => ({ type: "root", id: "n2", children: [{ type: "section", id: "n3", children: [child] }] });
vbad("node with actions", { type: "root", id: "n2", actions: [] });
vbad("off-catalog type", rootWith({ type: "iframe", id: "n4" }));
vbad("off-schema prop", rootWith({ type: "text", id: "n4", props: { text: "a", href: "x" }, untrusted: true }));
vbad("prop wrong type", rootWith({ type: "text", id: "n4", props: { text: 42 }, untrusted: true }));
vbad("bad badge tone", rootWith({ type: "grid", id: "n4", props: { kind: "actions-readonly" }, children: [{ type: "badge", id: "n5", props: { text: "a", tone: "rainbow" }, untrusted: true }] }));
vbad("bad card-kind", rootWith({ type: "card", id: "n4", props: { kind: "evil" }, bind: { path: "/api/capabilities/c1" } }));
vbad("bad grid-kind", rootWith({ type: "grid", id: "n4", props: { kind: "evil" }, children: [] }));
vbad("bad plan-kind", rootWith({ type: "plan", id: "n4", props: { kind: "evil" } }));
vbad("capability card carrying run props", rootWith({ type: "card", id: "n4", props: { kind: "capability", statusFrom: "s" }, bind: { path: "/api/capabilities/c1" } }));
vbad("run card missing selectors", rootWith({ type: "card", id: "n4", props: { kind: "run" }, bind: { path: "/api/jobs/j1" } }));
vbad("prose not untrusted", rootWith({ type: "text", id: "n4", props: { text: "a" } }));
vbad("non-prose marked untrusted", rootWith({ type: "grid", id: "n4", props: { kind: "actions-readonly" }, children: [], untrusted: true }));
vbad("receipt without bind", rootWith({ type: "receipt", id: "n4" }));
vbad("stat without bind", rootWith({ type: "stat", id: "n4", props: { label: "x" }, untrusted: true }));
vbad("stat bind without select (needsSelect)", rootWith({ type: "stat", id: "n4", props: { label: "x" }, untrusted: true, bind: { path: "/api/jobs/j1" } }));
vbad("stat bind to reserved route", rootWith({ type: "stat", id: "n4", props: { label: "x" }, untrusted: true, bind: { path: "/api/settlement/status", select: "u" } }));
vbad("bind on noBind type (plan)", rootWith({ type: "plan", id: "n4", props: { kind: "composition" }, bind: { path: "/api/jobs/j1" } }));
vbad("schema on non-receipt bind", rootWith({ type: "list", id: "n4", props: { rowTitle: "id", rowMeta: [] }, bind: { path: "/api/jobs", schema: "receipt" } }));
vbad("childless leaf with children", rootWith({ type: "stat", id: "n4", props: { label: "x" }, untrusted: true, bind: { path: "/api/jobs/j1", select: "s" }, children: [] }));
vbad("container without children array", { type: "root", id: "n2" });
vbad("illegal child under root (field-label)", { type: "root", id: "n2", children: [{ type: "field-label", id: "n3", props: { label: "x" }, untrusted: true }] });
vbad("illegal child under section (badge)", rootWith({ type: "badge", id: "n4", props: { text: "a", tone: "neutral" }, untrusted: true }));
vbad("non-nN id", { type: "root", id: "root", children: [] });
vbad("root too many sections (>24)", { type: "root", id: "n2", children: Array.from({ length: 25 }, (_, i) => ({ type: "section", id: "n" + (100 + i), children: [] })) });
vbad("grid empty (min 1 badge)", rootWith({ type: "grid", id: "n4", props: { kind: "actions-readonly" }, children: [] }));
vbad("list limit out of range (0)", rootWith({ type: "list", id: "n4", props: { rowTitle: "id", rowMeta: [], limit: 0 }, bind: { path: "/api/jobs" } }));
vbad("list limit non-integer", rootWith({ type: "list", id: "n4", props: { rowTitle: "id", rowMeta: [], limit: 1.5 }, bind: { path: "/api/jobs" } }));
vbad("approval-notice wrong text", rootWith({ type: "approval-notice", id: "n4", props: { notice: "Approve now!" } }));
vbad("section heading not H2", { type: "root", id: "n2", children: [{ type: "section", id: "n3", children: [{ type: "heading", id: "n4", props: { level: 1, text: "x" }, untrusted: true }] }] });
vbad("section heading not first", { type: "root", id: "n2", children: [{ type: "section", id: "n3", children: [{ type: "text", id: "n4", props: { text: "a" }, untrusted: true }, { type: "heading", id: "n5", props: { level: 2, text: "x" }, untrusted: true }] }] });
vbad("stat label too long (>400)", rootWith({ type: "stat", id: "n4", props: { label: "x".repeat(401) }, untrusted: true, bind: { path: "/api/jobs/j1", select: "s" } }));
ok("validateIr REJECT: doc.title not H1 (level 2)", validateIr({ ir: "pcc-dashboard-ir/v1", title: { type: "heading", id: "n1", props: { level: 2, text: "x" }, untrusted: true }, root: { type: "root", id: "n2", children: [] } }).ok === false);
ok("validateIr REJECT: doc.title not a heading", validateIr({ ir: "pcc-dashboard-ir/v1", title: { type: "text", id: "n1", props: { text: "x" }, untrusted: true }, root: { type: "root", id: "n2", children: [] } }).ok === false);

console.log(`\n[dashboard-ir conformance] PASS — ${passed} checks`);
