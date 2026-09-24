/**
 * WorkspaceLayoutV1 invariants (product-steward #2587, readmodels #2731,
 * genui #3156).
 * The gateway's PUT /api/me/workspaces/:workspace answers 422 with these
 * same violation codes.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_PATCH_OPS,
  MUST_SHOW_STATES,
  WORKSPACE_LAYOUT_SCHEMA,
  applyWorkspaceLayoutPatch,
  mustShowNow,
  validateWorkspaceCatalog,
  validateWorkspaceLayout,
  validateWorkspaceLayoutInput,
  type WorkspaceCatalog,
  type WorkspaceLayoutInput,
} from "../workspace/workspace-layout.js";

// Refs from genui's catalog contract (#3156). There is deliberately no
// escrow list: money state appears only in per-unit settlement components.
const CATALOG: WorkspaceCatalog = {
  "pcc.jobs.list": { emphasis: ["margin", "deadline"], mustShowFields: ["status", "provenance"] },
  "pcc.run.summary": { mustShowFields: ["status", "provenance", "settlement-qualifier"] },
  "pcc.approval": { mustShow: true, mustShowFields: ["this-will-send"] },
  "pcc.capabilities.list": { emphasis: ["lead-time"] },
};

function base(): WorkspaceLayoutInput {
  return {
    schema: WORKSPACE_LAYOUT_SCHEMA,
    workspace: "operate-work",
    slots: [
      { ref: "pcc.jobs.list", order: 0, size: "l", visible: true },
      { ref: "pcc.approval", order: 1, size: "m", visible: true },
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
    if (r.ok) expect(r.value.slots.map((s) => s.ref)).toEqual(["pcc.jobs.list", "pcc.approval"]);
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
    const input = { ...base(), view: { density: "compact", technicalDetails: "shown", emphasis: ["lead-time"] } };
    // "lead-time" is allowed only by pcc.capabilities.list, which is not in this workspace
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

describe("must-show fields and states (genui #3156)", () => {
  it("emphasis cannot name a must-show field, only an optional one", () => {
    const input = { ...base(), view: { density: "compact", technicalDetails: "shown", emphasis: ["status"] } };
    expect(codes(validateWorkspaceLayoutInput(input, CATALOG))).toEqual(["emphasis_not_allowed"]);
  });

  it("validateWorkspaceCatalog: a field both emphasisable and must-show is a catalog error", () => {
    expect(validateWorkspaceCatalog(CATALOG)).toEqual([]);
    const bad = { ...CATALOG, "pcc.run.summary": { emphasis: ["status"], mustShowFields: ["status"] } };
    expect(validateWorkspaceCatalog(bad).map((v) => [v.code, v.path])).toEqual([["bad_catalog", "pcc.run.summary.emphasis[0]"]]);
    expect(validateWorkspaceCatalog({ "not a ref": {} }).map((v) => v.code)).toEqual(["bad_catalog"]);
  });

  it("unknown money is a must-show state, like failed, disputed and refunded money", () => {
    expect(MUST_SHOW_STATES).toEqual(expect.arrayContaining(["money_failed", "money_disputed", "money_refunded", "money_unknown"]));
  });

  it("mustShowNow: a hidden slot is rendered while its component reports a must-show state", () => {
    const summary = CATALOG["pcc.run.summary"];
    expect(mustShowNow(summary, [])).toBe(false);
    expect(mustShowNow(summary, ["money_unknown"])).toBe(true);
    expect(mustShowNow(CATALOG["pcc.approval"], [])).toBe(true);
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
        { op: "show", ref: "pcc.capabilities.list" },
        { op: "view", set: { emphasis: ["margin"] } },
      ],
      CATALOG,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.slots.find((s) => s.ref === "pcc.jobs.list")?.size).toBe("full");
      expect(r.value.slots.some((s) => s.ref === "pcc.capabilities.list")).toBe(true);
    }
  });

  it("refuses a patch that would hide a mustShow component", () => {
    const r = applyWorkspaceLayoutPatch(base(), [{ op: "hide", ref: "pcc.approval" }], CATALOG);
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
