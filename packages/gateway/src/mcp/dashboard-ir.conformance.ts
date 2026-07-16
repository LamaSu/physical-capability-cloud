/**
 * Phase B conformance harness for dashboard-ir.ts. Runs with plain Node (no deps):
 *   node --experimental-strip-types dashboard-ir.conformance.ts
 * (Standalone because the fresh B worktree has no vitest; a vitest mirror lands
 * for CI in the same round.)
 */
import assert from "node:assert/strict";
import { dashboardManifestToIr, validateIr, IR_NODE_TYPES } from "./dashboard-ir.ts";

const FROZEN = new Set<string>(IR_NODE_TYPES);
let passed = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  assert.ok(cond, `${name}${detail ? " — " + detail : ""}`);
  passed++;
  console.log(`  ok   ${name}`);
};

// A realistic PROJECTED manifest covering all 10 kinds.
const projected: any = {
  csd: "pcc://artifacts/dashboard/v1",
  title: "Ops",
  sections: [
    {
      windows: [
        { kind: "note", text: "hello <b>world</b>" },
        { kind: "metric", label: "Balance", binding: { path: "/api/fiat-ramp/wallet/balance", select: "usdc" }, format: "usd" },
        { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
        { kind: "receipt", binding: { path: "/api/jobs/j1/settlement" } },
        { kind: "list", binding: { path: "/api/jobs" }, item: { title: "job", meta: ["m1", "m2"], statusFrom: "status" }, limit: 5 },
        { kind: "form", schema: { properties: { amount: { title: "Amount" }, token: {} } }, submit: { operation_id: "escrow.fund", arguments: {} } },
        { kind: "run", binding: { path: "/api/jobs/j1" }, statusFrom: "status", latestFrom: "latest" },
        { kind: "approval", binding: { path: "/api/escrow/e1" }, approve: { operation_id: "job.cancel" }, deny: { operation_id: "x" } },
        { kind: "chain", composeRef: { id: "c1" }, execute: { operation_id: "compose.execute" } },
        { kind: "actions", actions: [{ id: "a", label: "Refresh", operation_id: "job.cancel", arguments: {} }] },
      ],
    },
  ],
};

// ── 1. Happy path ──────────────────────────────────────────────────────────────
const r = dashboardManifestToIr(projected);
ok("valid manifest → IR", r.ok, r.ok ? "" : r.reason);
if (!r.ok) throw new Error("stop");
const doc = r.doc;
ok("validateIr passes on adapter output", validateIr(doc).ok === true);

const nodes: any[] = [];
(function walk(n: any) { nodes.push(n); (n.children || []).forEach(walk); })(doc.root);

// ── 2. NO actions / capability anywhere (the hard invariant) ───────────────────
ok("no node carries `actions`", nodes.every((n) => !("actions" in n)));
ok("no node carries `capability`", nodes.every((n) => !("capability" in n)));

// ── 3. every node type is in the frozen set ────────────────────────────────────
ok("all node types are frozen-catalog", nodes.every((n) => FROZEN.has(n.type)));

// ── 4. effecting kinds render inert/neutral, NOT controls ──────────────────────
ok("form → form-summary, no inputs/buttons", nodes.some((n) => n.type === "form-summary") && !nodes.some((n) => n.type === "field" || n.type === "button"));
ok("approval → approval-notice (no control)", nodes.some((n) => n.type === "approval-notice"));
ok("chain → plan (no execute)", nodes.some((n) => n.type === "plan"));
ok("actions → read-only badges (no buttons)", nodes.filter((n) => n.type === "badge").length === 1);

// ── 5. trust-bearing content is a server-schema'd bind ─────────────────────────
ok("receipt binds with schema=receipt", nodes.find((n) => n.type === "receipt")?.bind?.schema === "receipt");
ok("approval binds canonical state (schema=approval-state)", nodes.find((n) => n.type === "approval-notice")?.bind?.schema === "approval-state");

// ── 6. manifest free text flagged untrusted, not HTML ──────────────────────────
const note = nodes.find((n) => n.type === "text");
ok("note text flagged untrusted", note?.untrusted === true);
ok("note text preserved as raw string (renderer uses textContent)", note?.props?.text === "hello <b>world</b>");

// ── 7. nested smuggled type/props/capability never reach the IR ────────────────
const smuggle: any = {
  csd: "pcc://artifacts/dashboard/v1", title: "x",
  sections: [{ windows: [
    { kind: "form", schema: { properties: { x: { title: "X", type: "button", props: { capability: "escrow.fund" }, actions: [{ capability: "pay" }] } } }, submit: {} },
  ] }],
};
const r2 = dashboardManifestToIr(smuggle);
ok("smuggle manifest still adapts (form→summary)", r2.ok);
if (r2.ok) {
  const flat: any[] = [];
  (function w(n: any) { flat.push(n); (n.children || []).forEach(w); })(r2.doc.root);
  const json = JSON.stringify(r2.doc);
  ok("no smuggled `capability` in output", !json.includes("escrow.fund") && !json.includes('"capability"'));
  ok("no smuggled type:button / actions in output", !flat.some((n) => n.type === "button") && !flat.some((n) => "actions" in n));
}

// ── 8. fail closed ──────────────────────────────────────────────────────────────
ok("unknown kind → fail closed", dashboardManifestToIr({ csd: "x", title: "x", sections: [{ windows: [{ kind: "evil" }] }] } as any).ok === false);
ok("__proto__ in manifest → fail closed", dashboardManifestToIr(JSON.parse('{"title":"x","sections":[],"__proto__":{"p":1}}')).ok === false);
ok("sections not array → fail closed", dashboardManifestToIr({ title: "x", sections: {} } as any).ok === false);
ok("too many sections → fail closed", dashboardManifestToIr({ title: "x", sections: Array.from({ length: 99 }, () => ({ windows: [] })) } as any).ok === false);
ok("validateIr rejects a node with actions", validateIr({ ir: "pcc-dashboard-ir/v1", root: { type: "root", id: "n1", actions: [] } }).ok === false);
ok("validateIr rejects an off-catalog type", validateIr({ ir: "pcc-dashboard-ir/v1", root: { type: "root", id: "n1", children: [{ type: "iframe", id: "n2" }] } }).ok === false);

console.log(`\n[dashboard-ir conformance] PASS — ${passed} checks`);
