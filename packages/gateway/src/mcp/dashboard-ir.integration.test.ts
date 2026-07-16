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
      { kind: "metric", label: "Balance", select: "usdc", binding: { path: "/api/fiat-ramp/cdp/wallet/0xabc/balance" } },
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
    const { projected, ir } = chain(raw([{ kind: "metric", label: "Balance", select: "usdc", binding: { path: "/api/fiat-ramp/wallet/balance" } }]));
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

  it("binding.query nested-object value survives projection → adapter REJECTS", () => {
    const { projected, ir } = chain(raw([{ kind: "metric", label: "L", binding: { path: "/api/jobs/j1", query: { filter: { nested: "x" } } } }]));
    // Either the projector or the adapter must refuse a non-scalar query value.
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

  // ── Semantic-privilege escalation: a privileged-LOOKING window cannot bind to a
  //    non-canonical read path even though the path is a perfectly valid /api route.
  it("receipt window bound to /api/escrow/:id is REJECTED (route allowlist)", () => {
    const { projected, ir } = chain(raw([{ kind: "receipt", binding: { path: "/api/escrow/e1" } }]));
    // Projection accepts the binding shape; the adapter's per-kind route allowlist refuses it.
    expect(projected === null || ir?.ok === false).toBe(true);
  });

  it("metric bound to a financial-leak route (stripe/credits) is REJECTED", () => {
    const { projected, ir } = chain(raw([{ kind: "metric", label: "Credits", binding: { path: "/api/fiat-ramp/stripe/credits/u1" } }]));
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
