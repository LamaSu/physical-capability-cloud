/**
 * PX-5 (#344) cross-family review, astra via coord-watch #2504. Each finding is pinned here:
 *  - manifest prose cannot present money (title, headings, notes, action and field labels);
 *  - lists show only a PCC-owned field profile per route; escrow is not listable;
 *  - the row cap holds when the manifest omits `limit`;
 *  - a malformed field type is refused, never thrown; the kit fails inert on any exception;
 *  - binding query keys are per-route allowlisted (no tokens in URLs);
 *  - every bindable route carries an effect review, pinned to BIND_POLICY.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { JSDOM } from "jsdom";
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from "node:util";
import {
  dashboardManifestToIr, validateIr, WITHHELD_PROSE, isMoneyClaim, LIST_ROW_CAP,
  EFFECT_REVIEWED_READS, bindPolicyRouteSources, reviewedRouteSource,
  RECORD_STATUS_NOTE, isMoneyState, recordValueText,
} from "./dashboard-ir.js";
import type { IrDoc, IrNode } from "./dashboard-ir.js";
import { bindListRows, bindScalar, bindSchemaCard } from "./dashboard-ir-renderer.js";
import type { RDocument, RElement } from "./dashboard-ir-renderer.js";

const KIT = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js"), "utf8");
const CSD = "pcc://artifacts/dashboard/v1";
const man = (windows: unknown[], title = "Ops", heading = "Sec") => ({ csd: CSD, title, sections: [{ heading, windows }] });
function proseOf(n: IrNode | undefined, out: string[] = []): string[] {
  if (!n) return out;
  const p = (n.props ?? {}) as { text?: unknown; label?: unknown };
  if (n.untrusted && typeof p.text === "string") out.push(p.text);
  if (n.untrusted && typeof p.label === "string") out.push(p.label);
  for (const c of n.children ?? []) proseOf(c, out);
  return out;
}
const ok = (m: unknown) => { const r = dashboardManifestToIr(m as never); if (!r.ok) throw new Error(r.reason); return r.doc; };

describe("#344 money: manifest prose cannot present money", () => {
  it("amounts and payment/verification claims are withheld in every prose slot", () => {
    const doc = ok({
      csd: CSD, title: "Available balance",
      sections: [{ heading: "Payment received - verified", windows: [
        { kind: "note", text: "1,000,000 USDC" },
        { kind: "note", text: "$12.50 on the way" },
        { kind: "note", text: "Pаid in full" },             // Cyrillic 'a'
        { kind: "note", text: "ｐａｉｄ" },       // fullwidth "paid"
        { kind: "note", text: "Settle​d yesterday" },        // zero-width space
        { kind: "actions", actions: [{ id: "a", label: "Refunded" }] },
        { kind: "form", schema: { type: "object", properties: { b: { type: "number", title: "Balance" } } } },
        { kind: "note", text: "Pick a kernel near you" },         // benign prose stays
      ] }],
    });
    const prose = [...proseOf(doc.title), ...proseOf(doc.root)];
    const withheld = prose.filter((t) => t === WITHHELD_PROSE).length;
    expect(withheld).toBe(9);
    expect(prose).toContain("Pick a kernel near you");
    for (const t of prose) expect(t === WITHHELD_PROSE || !isMoneyClaim(t), t).toBe(true);
    expect(validateIr(doc)).toEqual({ ok: true });
  });

  it("a directly forged IR whose prose states money is rejected by the validator", () => {
    const doc = ok(man([{ kind: "note", text: "fine" }]));
    const forged = JSON.parse(JSON.stringify(doc)) as IrDoc;
    (forged.root.children![0]!.children![1]!.props as { text: string }).text = "Paid 5 USDC - verified";
    const r = validateIr(forged);
    expect(r.ok).toBe(false);
  });

  it("the withheld notice itself is not a money claim (it cannot self-trigger)", () => {
    expect(isMoneyClaim(WITHHELD_PROSE)).toBe(false);
  });
});

describe("#344 money: lists show only a PCC-owned field profile", () => {
  const list = (path: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    dashboardManifestToIr(man([{ kind: "list", binding: { path, ...extra }, item }]) as never);

  it("astra's example (pricing.baseCost as a row title) is refused", () => {
    const r = list("/api/capabilities", { title: "pricing.baseCost", meta: ["pricing.currency"], statusFrom: "available" });
    expect(r.ok).toBe(false);
  });

  it("money fields are refused as title, meta or status on every list route", () => {
    for (const [path, item] of [
      ["/api/capabilities", { title: "name", meta: ["pricing.baseCost"] }],
      ["/api/capabilities", { title: "name", statusFrom: "pricing.currency" }],
      ["/api/jobs", { title: "id", meta: ["price"] }],
      ["/api/jobs", { title: "escrowAddress" }],
      ["/api/kernels", { title: "name", meta: ["operatorAddress"] }],
      ["/api/jobs", { title: "proposal.text" }],
    ] as Array<[string, Record<string, unknown>]>) {
      expect(list(path, item).ok, `${path} ${JSON.stringify(item)}`).toBe(false);
    }
  });

  it("escrow is not a list route", () => {
    expect(list("/api/escrow", { title: "id" }).ok).toBe(false);
  });

  it("profile fields still work", () => {
    expect(list("/api/capabilities", { title: "name", meta: ["type"], statusFrom: "available" }).ok).toBe(true);
    expect(list("/api/jobs", { title: "id", meta: ["kernelId", "status"], statusFrom: "status" }).ok).toBe(true);
    expect(list("/api/kernels", { title: "name", statusFrom: "status" }).ok).toBe(true);
  });

  it("a forged IR list with an off-profile selector is rejected by the validator", () => {
    const doc = ok(man([{ kind: "list", binding: { path: "/api/capabilities" }, item: { title: "name" } }]));
    const forged = JSON.parse(JSON.stringify(doc)) as IrDoc;
    (forged.root.children![0]!.children![1]!.props as { rowTitle: string }).rowTitle = "pricing.baseCost";
    expect(validateIr(forged).ok).toBe(false);
  });
});

describe("#344 catalog: row cap, malformed input, query keys", () => {
  // a minimal fake DOM for the renderer
  type FakeEl = RElement & { attrs: Record<string, string> };
  const fdoc: RDocument = {
    createElement(): RElement {
      const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
      return e;
    },
  };

  it("omitting `limit` does not lift the row cap", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: [] } } as unknown as IrNode;
    const rows = Array.from({ length: 5 * LIST_ROW_CAP }, (_, i) => ({ name: "k" + i }));
    bindListRows(fdoc, listEl, node, rows);
    expect(listEl.children.length).toBe(LIST_ROW_CAP);
  });

  it("a manifest `limit` above the cap cannot lift it either", () => {
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "name", rowMeta: [], limit: 10 * LIST_ROW_CAP } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, Array.from({ length: 3 * LIST_ROW_CAP }, (_, i) => ({ name: "k" + i })));
    expect(listEl.children.length).toBe(LIST_ROW_CAP);
  });

  it("a field type whose toString is null is refused, not thrown", () => {
    const m = JSON.parse('{"csd":"pcc://artifacts/dashboard/v1","title":"T","sections":[{"windows":[{"kind":"form","schema":{"type":"object","properties":{"x":{"type":{"toString":null}}}}}]}]}');
    let r: ReturnType<typeof dashboardManifestToIr> | undefined;
    expect(() => { r = dashboardManifestToIr(m); }).not.toThrow();
    expect(r!.ok).toBe(false);
  });

  it("the shipped kit fails INERT on that manifest (no throw, nothing rendered)", async () => {
    const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p>waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
    const w = dom.window as unknown as Window & { eval: (s: string) => void; __PCC_IR_ORIGIN__?: string; MessageEvent: typeof MessageEvent };
    (w as unknown as { parent: { postMessage: () => void } }).parent.postMessage = () => {};
    w.eval(KIT);
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent as never, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } } }));
    const m = JSON.parse('{"csd":"pcc://artifacts/dashboard/v1","title":"T","sections":[{"windows":[{"kind":"form","schema":{"type":"object","properties":{"x":{"type":{"toString":null}}}}}]}]}');
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent as never, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: m } } } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.document.getElementById("pcc-ir-root")!.textContent).toContain("could not be verified");
    dom.window.close();
  });

  it("query keys are allowlisted per route; credential-like names are refused", () => {
    const listQ = (path: string, query: Record<string, unknown>) =>
      dashboardManifestToIr(man([{ kind: "list", binding: { path, query }, item: { title: path === "/api/jobs" ? "id" : "name" } }]) as never).ok;
    expect(listQ("/api/jobs", { status: "open", limit: 5 })).toBe(true);
    expect(listQ("/api/capabilities", { type: "pizza" })).toBe(true);
    expect(listQ("/api/jobs", { token: "x" })).toBe(false);
    expect(listQ("/api/jobs", { apiKey: "x" })).toBe(false);
    expect(listQ("/api/kernels", { limit: 5 })).toBe(false); // not in the kernels allowlist
    expect(dashboardManifestToIr(man([{ kind: "metric", label: "L", select: "progress", binding: { path: "/api/jobs/j1/status", query: { a: 1 } } }]) as never).ok).toBe(false);
  });
});

describe("#344 /mcp/apps: every bindable route carries an effect review", () => {
  it("the reviewed routes are exactly the routes BIND_POLICY can bind", () => {
    const reviewed = [...new Set(EFFECT_REVIEWED_READS.map((r) => reviewedRouteSource(r.route)))].sort();
    expect(reviewed).toEqual(bindPolicyRouteSources());
  });

  it("each review names its handler and its effect", () => {
    for (const r of EFFECT_REVIEWED_READS) {
      expect(r.handler.length, r.route).toBeGreaterThan(10);
      expect(r.effect, r.route).toMatch(/^read only/);
    }
  });
});

describe("#3013 (pcc-design): a record's status word is never a payment fact", () => {
  it("money-state words are recognised through case, joins, fullwidth, lookalikes and zero-width", () => {
    for (const v of ["settled", "Settled", "SETTLED_RELEASED", "payoutPending", "refund-pending", "released", "paid",
      "\uff53\uff45\uff54\uff54\uff4c\uff45\uff44", "s\u0435ttled", "sett\u200bled", "funded", "escrowed"]) {
      expect(isMoneyState(v), v).toBe(true);
    }
    for (const v of ["running", "queued", "completed", "verified", "approved", "online", "unsettled", "settlement pending", ""]) {
      expect(isMoneyState(v), v).toBe(false);
    }
  });

  it("recordValueText qualifies only a value read from a field named status", () => {
    expect(recordValueText("status", "settled")).toBe("settled" + RECORD_STATUS_NOTE);
    expect(recordValueText("job.status", "SETTLED_RELEASED")).toBe("SETTLED_RELEASED" + RECORD_STATUS_NOTE);
    expect(recordValueText("kernel.status", "online")).toBe("online");
    expect(recordValueText("name", "settled")).toBe("settled");     // not a status field
    expect(recordValueText("statusText", "paid")).toBe("paid");      // not a field NAMED status
    expect(recordValueText("status", "")).toBe("");
  });

  it("every renderer sink applies it: metric, run card, list badge and list meta", () => {
    expect(bindScalar({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "status" } } as unknown as IrNode, { status: "released" }))
      .toBe("released" + RECORD_STATUS_NOTE);
    expect(bindScalar({ type: "stat", id: "n1", bind: { path: "/api/jobs/j1/status", select: "progress" } } as unknown as IrNode, { progress: "paid" }))
      .toBe("paid"); // progress is not a status field
    const slots = [{ textContent: "" }, { textContent: "" }];
    bindSchemaCard("run-summary-v1", { job: { status: "settled", progress: 100 } }, slots);
    expect(slots.map((x) => x.textContent)).toEqual(["settled" + RECORD_STATUS_NOTE, "100"]);
    bindSchemaCard("run-summary-v1", { status: "running", progress: 5 }, slots);
    expect(slots[0]!.textContent).toBe("running");
    type FakeEl = RElement & { attrs: Record<string, string> };
    const fdoc: RDocument = { createElement(): RElement {
      const e: FakeEl = { textContent: "", className: "", children: [], attrs: {}, setAttr(n, v) { e.attrs[n] = v; }, appendChild(c) { e.children.push(c); return c; } };
      return e;
    } };
    const listEl = fdoc.createElement("div");
    const node = { type: "list", id: "n1", props: { rowTitle: "id", rowMeta: ["kernelId", "status"], statusFrom: "status" } } as unknown as IrNode;
    bindListRows(fdoc, listEl, node, [{ id: "j3", kernelId: "k1", status: "released" }, { id: "j4", kernelId: "k1", status: "running" }]);
    const texts = (listEl.children as RElement[]).map((r) => (r.children as RElement[]).map((c) => c.textContent));
    expect(texts).toEqual([
      ["j3", "k1", "released" + RECORD_STATUS_NOTE, "released" + RECORD_STATUS_NOTE],
      ["j4", "k1", "running", "running"],
    ]);
  });

  it("the shipped kit shows the qualifier in all three sinks (committed bytes, URL-routed reads)", async () => {
    const dom = new JSDOM('<!doctype html><html><body><main id="pcc-ir-root"><p>waiting</p></main></body></html>', { url: "https://capability.network/", runScripts: "outside-only" });
    const w = dom.window as unknown as Record<string, any>;
    w.TextDecoder = NodeTextDecoder;
    w.parent.postMessage = () => {};
    w.__PCC_IR_ORIGIN__ = "https://capability.network";
    const byPath: Record<string, unknown> = {
      "/api/jobs/j1/status": { status: "settled", progress: 100 },
      "/api/jobs/j2": { job: { status: "SETTLED_RELEASED", progress: 100 } },
      "/api/jobs": { items: [{ id: "j3", kernelId: "k1", status: "released" }, { id: "j4", kernelId: "k1", status: "running" }] },
    };
    w.fetch = (url: string) => {
      const body = byPath[new URL(String(url)).pathname];
      const bytes = new NodeTextEncoder().encode(JSON.stringify(body ?? {}));
      let sent = false;
      return Promise.resolve({
        status: body === undefined ? 404 : 200, redirected: false,
        headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "application/json" : null) },
        body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: bytes })), cancel: async () => {} }), cancel: async () => {} },
      });
    };
    w.eval(KIT);
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } } }));
    const m = man([
      { kind: "metric", label: "Status", select: "status", binding: { path: "/api/jobs/j1/status" } },
      { kind: "run", binding: { path: "/api/jobs/j2", sse: "/sse/stream/job/j2" }, statusFrom: "status", latestFrom: "latest" },
      { kind: "list", binding: { path: "/api/jobs" }, item: { title: "id", meta: ["kernelId", "status"], statusFrom: "status" } },
    ], "Jobs", "Runs");
    w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: w.JSON.parse(JSON.stringify(m)) } } } }));
    for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
    const text = w.document.getElementById("pcc-ir-root").textContent as string;
    expect(text).toContain("settled" + RECORD_STATUS_NOTE);
    expect(text).toContain("SETTLED_RELEASED" + RECORD_STATUS_NOTE);
    expect(text.split("released" + RECORD_STATUS_NOTE).length - 1).toBe(2); // j3's meta + badge
    expect(text.split(RECORD_STATUS_NOTE).length - 1).toBe(4);              // and nothing else is qualified
    expect(text).toContain("running");
    dom.window.close();
  });
});
