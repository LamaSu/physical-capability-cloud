/**
 * Phase-B PROMOTION acceptance test (sol's gate). Proves the REAL production chain —
 * actual tool handler → server projection → committed browser bytes → render — works
 * for a REAL schema-valid manifest that includes actions/form/approval/chain/receipt/
 * capability/run windows in their RAW shapes (actions carry kind/path/body). A naive
 * URI repoint (delivering the RAW manifest to the closed adapter) would FAIL-CLOSED on
 * these; the B tool handler must project first. Do NOT promote B until this is green.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, it, expect } from "vitest";
import { handleRenderIrDashboardTool } from "./mcp-app-view.js";

const KIT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"), "utf8");
const PROTOCOL = "2026-01-26";

// A REAL manifest: passes DashboardManifestSchema (Zod), covers every window kind, and
// its actions/form/approval/chain carry the RAW Action shape (id/label/kind/path/confirm/intentText).
const rawManifest = {
  csd: "pcc://artifacts/dashboard/v1",
  title: "Ops Board",
  sections: [{
    heading: "Live",
    windows: [
      { kind: "note", text: "Board status <b>x</b>" },
      { kind: "metric", label: "Balance", binding: { path: "/api/fiat-ramp/cdp/wallet/0xabc/balance" }, select: "usdc" },
      { kind: "capability", binding: { path: "/api/capabilities/cap-1" } },
      { kind: "receipt", binding: { path: "/api/settlement/j1" } },
      { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId"], statusFrom: "status" }, limit: 5 },
      { kind: "run", binding: { path: "/api/jobs/j1", sse: "/sse/stream/job/j1" }, statusFrom: "status", latestFrom: "latest" },
      { kind: "form", schema: { type: "object", properties: { amount: { type: "number", title: "Amount" } } }, submit: { id: "s1", label: "Fund", kind: "post", path: "/api/escrow/fund", confirm: "approval", intentText: "pcc: fund" } },
      { kind: "approval", binding: { path: "/api/settlement/j1" }, approve: { id: "a1", label: "Approve", kind: "post", path: "/api/escrow/e1/release", confirm: "approval", intentText: "pcc: approve" } },
      { kind: "chain", composeRef: { outcomeType: "pizza-delivery", budgetUSD: 50, minAssuranceTier: 1 }, execute: { id: "x1", label: "Run", kind: "post", path: "/api/compose/run", confirm: "inline", intentText: "pcc: run" } },
      { kind: "actions", actions: [{ id: "r1", label: "Refresh", kind: "post", path: "/api/jobs/j1/refresh", confirm: "inline", intentText: "pcc: refresh" }] },
    ],
  }],
};

function bootAndDeliver(projectedManifest: unknown): { mount: any; posted: any[] } {
  const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p class="pcc-invalid">waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
  const w: any = dom.window;
  const posted: any[] = [];
  w.parent.postMessage = (m: any) => posted.push(m);
  w.__PCC_IR_ORIGIN__ = "https://capability.network";
  w.fetch = () => Promise.reject(new Error("no fetch in test"));
  w.eval(KIT);
  w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: PROTOCOL } } }));
  const cloned = w.JSON.parse(w.JSON.stringify(projectedManifest)); // window-realm (as postMessage structured-clones)
  w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: cloned } } } }));
  return { mount: w.document.getElementById("pcc-ir-root"), posted };
}

describe("Phase-B promotion — real manifest → tool handler → projection → committed browser bytes", () => {
  it("the B tool handler accepts the real manifest and PROJECTS it (strips raw-HTTP action fields)", () => {
    const res: any = handleRenderIrDashboardTool(rawManifest);
    expect(res.isError).toBeFalsy();
    const m = res.structuredContent.manifest;
    const actionsWin = m.sections[0].windows.find((w: any) => w.kind === "actions");
    // projAction keeps display/typed-op fields, strips the raw-HTTP execution fields
    expect(actionsWin.actions[0].label).toBe("Refresh");
    expect(actionsWin.actions[0].kind).toBeUndefined();
    expect(actionsWin.actions[0].path).toBeUndefined();
    const formWin = m.sections[0].windows.find((w: any) => w.kind === "form");
    expect(formWin.submit.kind).toBeUndefined();
    expect(formWin.submit.confirm).toBe("approval");
  });

  it("the PROJECTED manifest RENDERS in the committed browser bytes (no fail-close on real actions/form/approval)", () => {
    const res: any = handleRenderIrDashboardTool(rawManifest);
    const { mount } = bootAndDeliver(res.structuredContent.manifest);
    // rendered a real dashboard, NOT the fail-closed notice
    expect(mount.textContent).not.toContain("could not be verified");
    expect(mount.querySelector(".pcc-section")).not.toBeNull();
    expect(mount.textContent).toContain("Ops Board");   // title
    expect(mount.textContent).toContain("Live");         // section heading
    expect(mount.textContent).toContain("Board status <b>x</b>"); // note, inert
    expect(mount.textContent).toContain("Balance");      // metric label
    expect(mount.textContent).toContain("Refresh");      // action → neutral badge
    expect(mount.textContent).toContain("Amount");       // form field-label
    expect(mount.textContent).toContain("authenticated PCC surface"); // approval → fixed notice
    // fixed PCC-owned schema cards paint their labels + framing (values fill on GET, stubbed here)
    expect(mount.textContent).toContain("Capability");                    // capability card FIXED heading
    expect(mount.textContent).toContain("Assurance tiers");               // capability FIXED label
    expect(mount.textContent).toContain("Progress");                      // run card FIXED label
    expect(mount.textContent).toContain("Settlement record (read-only)"); // receipt → read-only settlement record
    expect(mount.textContent).toContain("Not proof of payment");          // FIXED money-path warning
    // no live controls / bridge ever emitted
    expect(mount.querySelector("button")).toBeNull();
    expect(mount.querySelector("form")).toBeNull();
    expect(mount.querySelector("iframe")).toBeNull();
  });

  it("an UNPROJECTED (raw) delivery to the same bytes FAILS CLOSED — proving projection is required", () => {
    // deliver the RAW manifest (what a naive repoint would do) → the closed adapter rejects
    // the raw actions → inert. This is why the promotion MUST project server-side.
    const { mount } = bootAndDeliver(rawManifest);
    expect(mount.textContent).toContain("could not be verified");
  });
});
