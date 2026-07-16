/**
 * Phase B conformance harness for dashboard-ir.ts (hardened). Plain Node, no deps:
 *   node --experimental-strip-types dashboard-ir.conformance.ts
 * A real-projection integration test (projectDashboardForMcpApp → adapter) is added
 * as a vitest for CI once the worktree has deps; this file exercises the adapter +
 * validator directly, using projected-shaped fixtures that mirror cloneData survival.
 */
import assert from "node:assert/strict";
import { dashboardManifestToIr, validateIr, IR_NODE_TYPES } from "./dashboard-ir.ts";

const FROZEN = new Set<string>(IR_NODE_TYPES);
let passed = 0;
const ok = (name: string, cond: boolean, detail?: string) => { assert.ok(cond, `${name}${detail ? " — " + detail : ""}`); passed++; console.log(`  ok   ${name}`); };
const flat = (doc: any) => { const out: any[] = []; const w = (n: any) => { out.push(n); (n.children || []).forEach(w); }; w(doc.title); w(doc.root); return out; };

// ── Valid manifest covering all 10 kinds (bindings within each kind's route family) ──
const projected: any = {
  csd: "pcc://artifacts/dashboard/v1", title: "Ops",
  sections: [{ title: "Section A", windows: [
    { kind: "note", text: "hello <b>world</b>" },
    { kind: "metric", label: "Balance", binding: { path: "/api/fiat-ramp/wallet/balance", select: "usdc" }, format: "usd" },
    { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
    { kind: "receipt", binding: { path: "/api/jobs/j1/settlement" } },
    { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId", "status"], statusFrom: "status" }, limit: 5 },
    { kind: "form", schema: { properties: { amount: { title: "Amount" }, token: {} } }, submit: { operation_id: "escrow.fund" } },
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
ok("validateIr passes on adapter output", validateIr(doc).ok === true, JSON.stringify(validateIr(doc)));

// hard invariants
ok("no node carries actions/capability", nodes.every((n) => !("actions" in n) && !("capability" in n)));
ok("all node types frozen", nodes.every((n) => FROZEN.has(n.type)));
ok("ALL prose nodes marked untrusted", nodes.filter((n) => ["text", "heading", "stat", "badge", "field-label"].includes(n.type)).every((n) => n.untrusted === true));
ok("doc.title is an untrusted heading", doc.title.type === "heading" && doc.title.untrusted === true);
ok("section title → untrusted heading", nodes.some((n) => n.type === "heading" && n.props?.text === "Section A" && n.untrusted));

// effecting kinds neutral
ok("form → form-summary, no field/button", nodes.some((n) => n.type === "form-summary") && !nodes.some((n) => n.type === "field" || n.type === "button"));
ok("approval → approval-notice", nodes.some((n) => n.type === "approval-notice"));
ok("chain → plan", nodes.some((n) => n.type === "plan"));
ok("actions → 1 read-only badge, no button", nodes.filter((n) => n.type === "badge").length === 1 && !nodes.some((n) => n.type === "button"));

// trust-bearing binds
ok("receipt bind schema=receipt", nodes.find((n) => n.type === "receipt")?.bind?.schema === "receipt");
ok("approval-notice bind schema=approval-state", nodes.find((n) => n.type === "approval-notice")?.bind?.schema === "approval-state");

// metric no longer emits `format`; stat props are label only
ok("metric stat has no format prop", (() => { const s = nodes.find((n) => n.type === "stat"); return s && !("format" in (s.props || {})); })());

// text preserved raw (renderer uses textContent, not HTML)
ok("note text raw-preserved", nodes.find((n) => n.type === "text")?.props?.text === "hello <b>world</b>");

// ── smuggle: projected-shape fixture with nested keys cloneData preserves ──────────
const smuggle: any = { csd: "pcc://artifacts/dashboard/v1", title: "x", sections: [{ windows: [
  { kind: "form", schema: { properties: { x: { title: "X", type: "button", props: { capability: "escrow.fund" }, actions: [{ capability: "pay" }] } } }, submit: {} },
] }] };
const rs = dashboardManifestToIr(smuggle);
ok("smuggle → form-summary", rs.ok);
if (rs.ok) { const j = JSON.stringify(rs.doc); ok("no smuggled capability/type:button/actions in IR", !j.includes("escrow.fund") && !j.includes('"capability"') && !flat(rs.doc).some((n) => n.type === "button" || "actions" in n)); }

// ── strict rejection ───────────────────────────────────────────────────────────
const bad = (name: string, m: any) => ok(`REJECT: ${name}`, dashboardManifestToIr(m).ok === false, JSON.stringify(dashboardManifestToIr(m)));
const one = (win: any) => ({ csd: "x", title: "t", sections: [{ windows: [win] }] });
bad("unknown kind", one({ kind: "evil" }));
bad("extra key in window", one({ kind: "note", text: "a", evil: 1 }));
bad("metric binding outside route family", one({ kind: "metric", label: "L", binding: { path: "/api/evil/x" } }));
bad("binding path not /api", one({ kind: "metric", label: "L", binding: { path: "/etc/passwd" } }));
bad("binding path with ..", one({ kind: "metric", label: "L", binding: { path: "/api/../secret" } }));
bad("metric select non-grammar", one({ kind: "metric", label: "L", binding: { path: "/api/jobs", select: "a[0].b" } }));
bad("receipt to non-receipt route", one({ kind: "receipt", binding: { path: "/api/jobs" } }));
bad("list statusFrom non-selector", one({ kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", statusFrom: "a/b" } }));
bad("__proto__ in manifest", JSON.parse('{"title":"x","sections":[],"__proto__":{"p":1}}'));
bad("nested proto in query", one({ kind: "metric", label: "L", binding: { path: "/api/jobs", query: JSON.parse('{"__proto__":{"p":1}}') } }));
bad("query key non-grammar", one({ kind: "metric", label: "L", binding: { path: "/api/jobs", query: { "a b": 1 } } }));
bad("title too long", { title: "x".repeat(9999), sections: [] });
bad("too many sections", { title: "t", sections: Array.from({ length: 99 }, () => ({ windows: [] })) });

// ── validator strength (independent oracle) ────────────────────────────────────
const okTitle = { type: "heading", id: "t1", props: { level: 1, text: "x" }, untrusted: true };
const vbad = (name: string, root: any) => ok(`validateIr REJECT: ${name}`, validateIr({ ir: "pcc-dashboard-ir/v1", title: okTitle, root }).ok === false);
vbad("node with actions", { type: "root", id: "n1", actions: [] });
vbad("off-catalog type", { type: "root", id: "n1", children: [{ type: "iframe", id: "n2" }] });
vbad("off-schema prop", { type: "root", id: "n1", children: [{ type: "text", id: "n2", props: { text: "a", href: "x" }, untrusted: true }] });
vbad("prose node not untrusted", { type: "root", id: "n1", children: [{ type: "text", id: "n2", props: { text: "a" } }] });
vbad("receipt without bind", { type: "root", id: "n1", children: [{ type: "receipt", id: "n2" }] });
vbad("receipt wrong bind schema", { type: "root", id: "n1", children: [{ type: "receipt", id: "n2", bind: { path: "/api/x", schema: "approval-state" } }] });
vbad("duplicate id", { type: "root", id: "t1", children: [] });

console.log(`\n[dashboard-ir conformance] PASS — ${passed} checks`);
