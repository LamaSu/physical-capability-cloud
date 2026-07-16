/**
 * Phase B conformance for dashboard-ir.ts (R4 hardened). Plain Node, no deps:
 *   node --experimental-strip-types dashboard-ir.conformance.ts
 * A real projectDashboardForMcpApp→adapter integration test lands as a vitest for CI.
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
    { kind: "metric", label: "Balance", binding: { path: "/api/fiat-ramp/wallet/balance", select: "usdc" }, format: "usd" },
    { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
    { kind: "receipt", binding: { path: "/api/jobs/j1/settlement" } },
    { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId", "status"], statusFrom: "status" }, limit: 5 },
    { kind: "form", schema: { properties: { amount: { title: "Amount", type: "number" }, asset: {} } }, submit: { operation_id: "escrow.fund" } },
    { kind: "run", binding: { path: "/api/jobs/j1" }, statusFrom: "status", latestFrom: "latest" },
    { kind: "approval", binding: { path: "/api/escrow/e1" }, approve: { operation_id: "job.cancel" }, deny: { operation_id: "x" } },
    { kind: "chain", composeRef: { id: "c1" }, execute: { operation_id: "compose.execute" } },
    { kind: "actions", actions: [{ id: "a", label: "Refresh", operation_id: "job.cancel" }] },
  ] }],
};
const r = dashboardManifestToIr(projected);
ok("valid manifest → IR", r.ok, r.ok ? "" : (r as any).reason);
if (!r.ok) throw new Error("stop");
const doc = r.doc, nodes = flat(doc);
ok("validateIr passes", validateIr(doc).ok === true, JSON.stringify(validateIr(doc)));
ok("no actions/capability", nodes.every((n) => !("actions" in n) && !("capability" in n)));
ok("all types frozen", nodes.every((n) => FROZEN.has(n.type)));
ok("all prose untrusted", nodes.filter((n) => ["text", "heading", "stat", "badge", "field-label"].includes(n.type)).every((n) => n.untrusted === true));
ok("doc.title untrusted heading", doc.title.type === "heading" && doc.title.untrusted === true);
ok("section heading untrusted", nodes.some((n) => n.type === "heading" && n.props?.text === "Section A" && n.untrusted));
ok("form→form-summary, no field/button", nodes.some((n) => n.type === "form-summary") && !nodes.some((n) => ["field", "button", "form"].includes(n.type)));
ok("approval→approval-notice with NO bind", (() => { const a = nodes.find((n) => n.type === "approval-notice"); return a && !a.bind; })());
ok("chain→plan", nodes.some((n) => n.type === "plan"));
ok("actions→1 badge, no button", nodes.filter((n) => n.type === "badge").length === 1 && !nodes.some((n) => n.type === "button"));
ok("receipt bind schema=receipt", nodes.find((n) => n.type === "receipt")?.bind?.schema === "receipt");
ok("metric stat: no format, untrusted, bound", (() => { const s = nodes.find((n) => n.type === "stat"); return s && !("format" in (s.props || {})) && s.untrusted === true && s.bind?.path === "/api/fiat-ramp/wallet/balance"; })());
ok("note text raw-preserved", nodes.find((n) => n.type === "text")?.props?.text === "hello <b>world</b>");

// smuggle now REJECTS (field-def with props/actions/type:button)
const smuggle: any = { csd: "x", title: "x", sections: [{ windows: [{ kind: "form", schema: { properties: { x: { title: "X", type: "button", props: { capability: "escrow.fund" }, actions: [{ capability: "pay" }] } } }, submit: {} }] }] };
ok("smuggle field-def → REJECT (not strip)", dashboardManifestToIr(smuggle).ok === false);

// strict rejection
const one = (win: any) => ({ csd: "x", title: "t", sections: [{ windows: [win] }] });
const bad = (name: string, m: any) => ok(`REJECT: ${name}`, dashboardManifestToIr(m).ok === false, JSON.stringify(dashboardManifestToIr(m)).slice(0, 120));
bad("unknown kind", one({ kind: "evil" }));
bad("extra key in window", one({ kind: "note", text: "a", evil: 1 }));
bad("section field 'title' (not heading)", { csd: "x", title: "t", sections: [{ title: "T", windows: [] }] });
bad("metric outside route family", one({ kind: "metric", label: "L", binding: { path: "/api/fiat-ramp/stripe/credits/u1" } }));
bad("capability reserved route /types", one({ kind: "capability", binding: { path: "/api/capabilities/types" } }));
bad("receipt to escrow (not receipt route)", one({ kind: "receipt", binding: { path: "/api/escrow/e1" } }));
bad("list to /api/evidence (leak)", one({ kind: "list", binding: { path: "/api/evidence" }, item: { title: "id" } }));
bad("path not /api", one({ kind: "metric", label: "L", binding: { path: "/etc/passwd" } }));
bad("path with ..", one({ kind: "metric", label: "L", binding: { path: "/api/../secret" } }));
bad("path single-dot segment", one({ kind: "metric", label: "L", binding: { path: "/api/jobs/." } }));
bad("select proto segment", one({ kind: "metric", label: "L", binding: { path: "/api/jobs/j1", select: "a.__proto__" } }));
bad("select brackets", one({ kind: "metric", label: "L", binding: { path: "/api/jobs/j1", select: "a[0]" } }));
bad("sse outside allowlist", one({ kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/kernel/k1" }, statusFrom: "s", latestFrom: "l" }));
bad("credential field (token)", one({ kind: "form", schema: { properties: { token: {} } }, submit: {} }));
bad("field-def with type:button", one({ kind: "form", schema: { properties: { x: { type: "button" } } }, submit: {} }));
bad("query NaN", one({ kind: "metric", label: "L", binding: { path: "/api/jobs/j1", query: { n: NaN } } }));
bad("__proto__ in manifest", JSON.parse('{"csd":"x","title":"x","sections":[],"__proto__":{"p":1}}'));
bad("nested proto in query", one({ kind: "metric", label: "L", binding: { path: "/api/jobs/j1", query: JSON.parse('{"__proto__":{"p":1}}') } }));
bad("non-standard prototype manifest", Object.assign(Object.create({ polluted: 1 }), { csd: "x", title: "t", sections: [] })); // Object.create(evil) → reject
ok("null-proto manifest is SAFE (accepted)", dashboardManifestToIr(Object.assign(Object.create(null), { csd: "x", title: "t", sections: [] })).ok === true);
bad("title too long", { csd: "x", title: "x".repeat(9999), sections: [] });
bad("too many sections", { csd: "x", title: "t", sections: Array.from({ length: 99 }, () => ({ windows: [] })) });

// validator parity
const okTitle = { type: "heading", id: "n1", props: { level: 1, text: "x" }, untrusted: true };
const vbad = (name: string, root: any) => ok(`validateIr REJECT: ${name}`, validateIr({ ir: "pcc-dashboard-ir/v1", title: okTitle, root }).ok === false);
vbad("node with actions", { type: "root", id: "n2", actions: [] });
vbad("off-catalog type", { type: "root", id: "n2", children: [{ type: "iframe", id: "n3" }] });
vbad("off-schema prop", { type: "root", id: "n2", children: [{ type: "text", id: "n3", props: { text: "a", href: "x" }, untrusted: true }] });
vbad("prop wrong type", { type: "root", id: "n2", children: [{ type: "text", id: "n3", props: { text: 42 }, untrusted: true }] });
vbad("bad badge tone", { type: "root", id: "n2", children: [{ type: "grid", id: "n3", props: { kind: "x" }, children: [{ type: "badge", id: "n4", props: { text: "a", tone: "rainbow" }, untrusted: true }] }] });
vbad("prose not untrusted", { type: "root", id: "n2", children: [{ type: "text", id: "n3", props: { text: "a" } }] });
vbad("non-prose marked untrusted", { type: "root", id: "n2", untrusted: true });
vbad("receipt without bind", { type: "root", id: "n2", children: [{ type: "receipt", id: "n3" }] });
vbad("bind on noBind type", { type: "root", id: "n2", children: [{ type: "plan", id: "n3", props: { kind: "x" }, bind: { path: "/api/jobs/j1" } }] });
vbad("illegal child under root", { type: "root", id: "n2", children: [{ type: "field-label", id: "n3", props: { label: "x" }, untrusted: true }] });
vbad("non-nN id", { type: "root", id: "root", children: [] });

console.log(`\n[dashboard-ir conformance] PASS — ${passed} checks`);
