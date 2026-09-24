/**
 * WorkspaceLayoutV1 invariants (product-steward #2587, readmodels #2731).
 * The gateway's PUT /api/me/workspaces/:workspace answers 422 with these
 * same violation codes.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_PATCH_OPS,
  WORKSPACE_LAYOUT_SCHEMA,
  applyWorkspaceLayoutPatch,
  validateWorkspaceLayout,
  validateWorkspaceLayoutInput,
  type WorkspaceCatalog,
  type WorkspaceLayoutInput,
} from "../workspace/workspace-layout.js";

const CATALOG: WorkspaceCatalog = {
  "pcc.jobs.list": { emphasis: ["margin", "deadline"] },
  "pcc.job.execution": {},
  "pcc.approvals.pending": { mustShow: true },
  "pcc.escrow.list": { emphasis: ["amount"] },
};

function base(): WorkspaceLayoutInput {
  return {
    schema: WORKSPACE_LAYOUT_SCHEMA,
    workspace: "operate-work",
    slots: [
      { ref: "pcc.jobs.list", order: 0, size: "l", visible: true },
      { ref: "pcc.approvals.pending", order: 1, size: "m", visible: true },
    ],
    view: { density: "comfortable", technicalDetails: "on-failure" },
  };
}

function codes(r: ReturnType<typeof validateWorkspaceLayoutInput>): string[] {
  return r.ok ? [] : r.violations.map((v) => v.code);
}

describe("validateWorkspaceLayoutInput", () => {
  it("accepts a valid layout and sorts slots by order", () => {
    const input = base();
    input.slots.reverse();
    const r = validateWorkspaceLayoutInput(input, CATALOG);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.slots.map((s) => s.ref)).toEqual(["pcc.jobs.list", "pcc.approvals.pending"]);
  });

  it("journey 10: 'show margin first, hide blockchain details unless something fails' is expressible", () => {
    const input = { ...base(), view: { density: "compact", technicalDetails: "on-failure", emphasis: ["margin"] } };
    expect(validateWorkspaceLayoutInput(input, CATALOG).ok).toBe(true);
  });

  it("rejects a ref outside the trusted catalog", () => {
    const input = base();
    input.slots.push({ ref: "evil.iframe", order: 2, size: "s", visible: true });
    expect(codes(validateWorkspaceLayoutInput(input, CATALOG))).toContain("unknown_ref");
  });

  it("rejects protocol values smuggled in as extra keys, at every level", () => {
    const top = { ...base(), amount: "1000.00" };
    expect(codes(validateWorkspaceLayoutInput(top, CATALOG))).toContain("unknown_key");
    const inSlot = base() as unknown as { slots: Array<Record<string, unknown>> };
    inSlot.slots[0]!.status = "settled";
    expect(codes(validateWorkspaceLayoutInput(inSlot, CATALOG))).toContain("unknown_key");
    const inView = { ...base(), view: { density: "compact", technicalDetails: "shown", paid: true } };
    expect(codes(validateWorkspaceLayoutInput(inView, CATALOG))).toContain("unknown_key");
  });

  it("rejects a focus that is content rather than an id", () => {
    const input = base();
    input.slots[0]!.focus = "paid in full: $1,000";
    expect(codes(validateWorkspaceLayoutInput(input, CATALOG))).toContain("bad_shape");
  });

  it("mustShow: a component that asks for a decision cannot be hidden or collapsed", () => {
    const hidden = base();
    hidden.slots[1]!.visible = false;
    expect(codes(validateWorkspaceLayoutInput(hidden, CATALOG))).toContain("must_show_hidden");
    const collapsed = base();
    collapsed.slots[1]!.collapsed = true;
    expect(codes(validateWorkspaceLayoutInput(collapsed, CATALOG))).toContain("must_show_hidden");
  });

  it("emphasis must be on a slot's catalog allowlist", () => {
    const input = { ...base(), view: { density: "compact", technicalDetails: "shown", emphasis: ["amount"] } };
    // "amount" is allowed only by pcc.escrow.list, which is not in this workspace
    expect(codes(validateWorkspaceLayoutInput(input, CATALOG))).toContain("emphasis_not_allowed");
  });

  it("rejects duplicate refs, unknown workspaces and a wrong schema", () => {
    const dup = base();
    dup.slots.push({ ...dup.slots[0]!, order: 5 });
    expect(codes(validateWorkspaceLayoutInput(dup, CATALOG))).toContain("duplicate_ref");
    expect(codes(validateWorkspaceLayoutInput({ ...base(), workspace: "inspect" }, CATALOG))).toContain("bad_shape");
    expect(codes(validateWorkspaceLayoutInput({ ...base(), schema: "v0" }, CATALOG))).toContain("bad_shape");
  });

  it("does not accept server-owned fields from a client", () => {
    const input = { ...base(), scope: { kind: "user", id: "someone-else" }, version: 9 };
    expect(codes(validateWorkspaceLayoutInput(input, CATALOG))).toContain("unknown_key");
  });
});

describe("validateWorkspaceLayout (stored form)", () => {
  it("requires the server-owned scope, version and updatedAt", () => {
    const stored = { ...base(), scope: { kind: "user", id: "operator@example.test" }, version: 3, updatedAt: "2026-09-24T12:00:00Z" };
    expect(validateWorkspaceLayout(stored, CATALOG).ok).toBe(true);
    expect(validateWorkspaceLayout(base(), CATALOG).ok).toBe(false);
  });
});

describe("applyWorkspaceLayoutPatch (agent proposals, Layer C)", () => {
  it("applies harmless presentation changes", () => {
    const r = applyWorkspaceLayoutPatch(
      base(),
      [
        { op: "resize", ref: "pcc.jobs.list", size: "full" },
        { op: "show", ref: "pcc.escrow.list" },
        { op: "view", set: { emphasis: ["margin"] } },
      ],
      CATALOG,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slots.find((s) => s.ref === "pcc.jobs.list")?.size).toBe("full");
      expect(r.value.slots.some((s) => s.ref === "pcc.escrow.list")).toBe(true);
    }
  });

  it("refuses a patch that would hide a mustShow component", () => {
    const r = applyWorkspaceLayoutPatch(base(), [{ op: "hide", ref: "pcc.approvals.pending" }], CATALOG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations.map((v) => v.code)).toContain("must_show_hidden");
  });

  it("refuses a patch that smuggles values through view.set", () => {
    const r = applyWorkspaceLayoutPatch(base(), [{ op: "view", set: { paid: true } as never }], CATALOG);
    expect(r.ok).toBe(false);
  });

  it("caps patch size", () => {
    const ops = Array.from({ length: MAX_PATCH_OPS + 1 }, () => ({ op: "expand" as const, ref: "pcc.jobs.list" }));
    const r = applyWorkspaceLayoutPatch(base(), ops, CATALOG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.violations[0]!.code).toBe("patch_too_large");
  });

  it("does not modify the layout it was given", () => {
    const layout = base();
    const before = JSON.stringify(layout);
    applyWorkspaceLayoutPatch(layout, [{ op: "resize", ref: "pcc.jobs.list", size: "s" }], CATALOG);
    expect(JSON.stringify(layout)).toBe(before);
  });
});
