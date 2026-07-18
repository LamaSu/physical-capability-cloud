/**
 * Phase-B item 6 — REAL projection → adapter → validator integration (sol Round-3).
 *
 * The unit conformance (dashboard-ir.conformance.ts) feeds hand-built manifests
 * straight to the adapter. This test closes the gap sol named: run an UNTRUSTED
 * raw artifact through the REAL `projectDashboardForMcpApp` (whose `cloneData`
 * deep-preserves nested keys in form.schema / chain.composeRef / action.arguments
 * / binding.query), then assert the adapter is the backstop for whatever survives
 * projection — rejecting render-flowing smuggles, discarding never-rendered ones
 * with zero trace, and refusing semantic-privilege escalation end-to-end.
 *
 * Runs in CI (needs @pcc/spec + route deps). The adapter alone also has a
 * deps-free harness: `node --experimental-strip-types dashboard-ir.conformance.ts`.
 */
import { describe, it, expect } from "vitest";
import { projectDashboardForMcpApp } from "./mcp-app-view.js";
import { dashboardManifestToIr, validateIr } from "./dashboard-ir.js";

const CSD = "pcc://artifacts/dashboard/v1";
const raw = (windows: unknown[], heading = "Sec") => ({ csd: CSD, title: "Ops", sections: [{ heading, windows }] });
// The full projection→adapter chain, returning both stages for assertions.
function chain(input: unknown) {
  const projected = projectDashboardForMcpApp(input);
  const ir = projected === null ? null : dashboardManifestToIr(projected as any);
  return { projected, ir };
}

describe("dashboard-ir — real projection → adapter → validator", () => {
  it("happy path: valid artifact projects, adapts, and validates", () => {
    const { projected, ir } = chain(raw([
      { kind: "note", text: "Live ops board" },
      { kind: "metric", label: "Progress", select: "progress", binding: { path: "/api/jobs/j1/status" } },
      { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId", "status"], statusFrom: "status" } },
      { kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/job/j1" }, statusFrom: "status", latestFrom: "latest" },
    ]));
    expect(projected).not.toBeNull();
    expect(ir?.ok).toBe(true);
    if (ir?.ok) expect(validateIr(ir.doc).ok).toBe(true);
  });

  it("run window with MISMATCHED sse/path job identity is REJECTED end-to-end", () => {
    const { projected, ir } = chain(raw([{ kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/job/j2" }, statusFrom: "status", latestFrom: "latest" }]));
    expect(projected === null || ir?.ok === false).toBe(true);
  });

  it("metric bound to the DEAD /api/fiat-ramp/wallet/balance route is REJECTED", () => {
    const { projected, ir } = chain(raw([{ kind: "metric", label: "L", select: "usdc", binding: { path: "/api/fiat-ramp/wallet/balance" } }]));
    expect(projected === null || ir?.ok === false).toBe(true);
  });

  // ── The flagship backstop: a benign nested object SURVIVES cloneData, the
  //    adapter's closed field-def grammar is what rejects it (not the projector).
  it("form.schema nested prop survives projection → adapter REJECTS", () => {
    const input = raw([{ kind: "form", schema: { properties: { amount: { title: "Amount", props: { evil: 1 }, children: [{ x: 1 }] } } }, submit: { operation_id: "escrow.fund" } }]);
    const projected: any = projectDashboardForMcpApp(input);
    expect(projected).not.toBeNull(); // cloneData preserves benign nested keys
    const fieldDef = projected.sections[0].windows[0].schema.properties.amount;
    expect(fieldDef.props).toEqual({ evil: 1 }); // PROVE the smuggle survived projection
    expect(dashboardManifestToIr(projected).ok).toBe(false); // adapter is the backstop
  });

  it("binding.query nested-object value survives projection → adapter REJECTS (attributed: has select)", () => {
    // `select` present so the rejection is due to the non-scalar query value, not missing select.
    const { projected, ir } = chain(raw([{ kind: "metric", label: "L", select: "u", binding: { path: "/api/jobs/j1/status", query: { filter: { nested: "x" } } } }]));
    expect(projected === null || ir?.ok === false).toBe(true);
  });

  it("real schema-valid action (confirm:\"inline\") survives projection and renders as a badge", () => {
    // projAction strips the raw-HTTP kind/path; the adapter's isOpDescriptor must accept confirm:"inline".
    const { ir } = chain(raw([{ kind: "actions", actions: [{ id: "a", label: "Refresh", kind: "post", path: "/api/x", confirm: "inline", intentText: "pcc: refresh", operation_id: "job.cancel" }] }]));
    expect(ir?.ok).toBe(true);
    if (ir?.ok) { const has = (n: any): boolean => n.type === "badge" || (n.children || []).some(has); expect(has(ir.doc.root)).toBe(true); }
  });

  it("receipt with an evidence binding is a STATIC pointer — binding ignored, nothing fetched (no leak)", () => {
    // Former "leak" case: a static settlement-record pointer fetches nothing, so an evidence
    // (or any) binding cannot leak; it renders only the fixed read-only pointer.
    const { ir } = chain(raw([{ kind: "receipt", binding: { path: "/api/evidence/lit-status" } }]));
    expect(ir?.ok).toBe(true);
  });

  it("collision route /api/capabilities/graph-stats as a capability is REJECTED (id-grammar)", () => {
    const { projected, ir } = chain(raw([{ kind: "capability", binding: { path: "/api/capabilities/graph-stats" } }]));
    expect(projected === null || ir?.ok === false).toBe(true);
  });

  it("collision route /api/settlement/status as a metric is REJECTED (attributed: has select)", () => {
    const { projected, ir } = chain(raw([{ kind: "metric", label: "L", select: "u", binding: { path: "/api/settlement/status" } }]));
    expect(projected === null || ir?.ok === false).toBe(true);
  });

  // ── Never-rendered channels: benign nested content is discarded, not stripped —
  //    the emitted IR must contain ZERO trace of the smuggled marker.
  it("chain.composeRef benign nested is DISCARDED with no trace in IR", () => {
    const MARK = "COMPOSEREF_SMUGGLE_9c3f";
    const { projected, ir } = chain(raw([{ kind: "chain", composeRef: { id: "c1", note: MARK }, execute: { operation_id: "compose.execute" } }]));
    expect(projected).not.toBeNull();
    if (ir?.ok) expect(JSON.stringify(ir.doc)).not.toContain(MARK);
    else expect(ir?.ok).toBe(false);
  });

  it("action.arguments benign nested is DISCARDED with no trace in IR", () => {
    const MARK = "ARGS_SMUGGLE_71ab";
    const { projected, ir } = chain(raw([{ kind: "actions", actions: [{ id: "a", label: "Refresh", operation_id: "job.cancel", arguments: { hidden: MARK } }] }]));
    expect(projected).not.toBeNull();
    if (ir?.ok) expect(JSON.stringify(ir.doc)).not.toContain(MARK);
    else expect(ir?.ok).toBe(false);
  });

  it("__proto__ inside composeRef is rejected end-to-end and pollutes nothing", () => {
    const input = raw([{ kind: "chain", composeRef: JSON.parse('{"id":"c1","__proto__":{"polluted":"yes"}}'), execute: { operation_id: "compose.execute" } }]);
    const { projected, ir } = chain(input);
    expect(projected === null || ir?.ok === false).toBe(true);
    expect(({} as any).polluted).toBeUndefined(); // no global prototype pollution
  });

  // ── The settlement record is a STATIC pointer: a receipt window accepts + IGNORES any
  //    binding (like `approval`) and fetches nothing, so no route can leak through it.
  it("receipt window with an escrow binding is ACCEPTED as a static pointer (binding ignored, no fetch)", () => {
    const { ir } = chain(raw([{ kind: "receipt", binding: { path: "/api/escrow/e1" } }]));
    expect(ir?.ok).toBe(true);
  });

  it("metric bound to a financial-leak route (stripe/credits) is REJECTED (attributed: has select)", () => {
    const { projected, ir } = chain(raw([{ kind: "metric", label: "Credits", select: "u", binding: { path: "/api/fiat-ramp/stripe/credits/u1" } }]));
    expect(projected === null || ir?.ok === false).toBe(true);
  });

  it("every projected+adapted node is on the frozen catalog and prose is untrusted", () => {
    const { ir } = chain(raw([
      { kind: "note", text: "n" },
      { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
      { kind: "receipt", binding: { path: "/api/settlement/j1" } },
      { kind: "approval", binding: { path: "/api/escrow/e1" }, approve: { operation_id: "job.cancel" } },
    ]));
    expect(ir?.ok).toBe(true);
    if (!ir?.ok) return;
    const seen: any[] = [];
    const walk = (n: any) => { seen.push(n); (n.children || []).forEach(walk); };
    walk(ir.doc.title); walk(ir.doc.root);
    // no effecting attributes anywhere
    expect(seen.every((n) => !("actions" in n) && !("capability" in n))).toBe(true);
    // approval renders a static notice with NO live bind
    const appr = seen.find((n) => n.type === "approval-notice");
    expect(appr && !appr.bind).toBe(true);
    // independent validator agrees
    expect(validateIr(ir.doc).ok).toBe(true);
  });
});
