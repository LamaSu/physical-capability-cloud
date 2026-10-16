import { readFileSync } from "node:fs";
import { TextDecoder, TextEncoder } from "node:util";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { BIDI_CONTROL_POINTS, DEFAULT_IGNORABLE_POINTS } from "../../../spec/src/__tests__/plain-text-fixtures.js";
import { dashboardManifestToIr, validateIr, boundStatusText, reportedFieldText, isMoneyClaim, isProseClaim, statesAmount, readText, WITHHELD_FIELD } from "./dashboard-ir.js";
import type { IrNode } from "./dashboard-ir.js";
const cp = String.fromCodePoint;
const rlo = cp(0x202e) + "deifirev tnemyaP";
const manifest = (text: string) => ({ csd: "pcc://artifacts/dashboard/v1", title: text, sections: [{ heading: text, windows: [
  { kind: "note", text },
  { kind: "actions", actions: [{ id: "r1", label: text, confirm: "inline", intentText: "pcc: refresh" }] },
  { kind: "form", schema: { type: "object", properties: { b: { type: "number", title: text } } }, submit: { id: "s1", label: "Submit", confirm: "inline", intentText: "pcc: submit" } },
] }] });
function nodes(n: IrNode): IrNode[] { return [n, ...(n.children ?? []).flatMap(nodes)]; }
describe("round 2f IR raw-direction and invisible guard", () => {
  it.each(BIDI_CONTROL_POINTS)("withholds raw Bidi_Control U+%s in both predicates", (p) => {
    const raw = "Plate reader run 3" + cp(p);
    expect(isProseClaim(raw)).toBe(true);
    expect(isMoneyClaim(raw)).toBe(true);
  });
  it("folds EVERY Default_Ignorable before detecting a claim", () => {
    expect(DEFAULT_IGNORABLE_POINTS.filter((p) => !isProseClaim("veri" + cp(p) + "fied")).map((p) => "U+" + p.toString(16))).toEqual([]);
  });
  it.each([0x05d0, 0x0627, 0x05f3, 0x07ca, 0x10840, 0x1e900])("withholds visual amounts through strong RTL U+%s", (p) => {
    const raw = "$" + cp(p) + "5,000";
    expect(statesAmount(raw)).toBe(true);
    expect(isMoneyClaim(raw)).toBe(true);
    expect(isProseClaim(raw)).toBe(true);
  });
  it("checks claim words after removing strong RTL characters", () => {
    expect(isMoneyClaim("veri" + cp(0x05d0) + "fied")).toBe(true);
    expect(isProseClaim("veri" + cp(0x0627) + "fied")).toBe(true);
  });
  it.each([cp(0x05d3, 0x05d5, 0x05d7), cp(0x062a, 0x0642, 0x0631, 0x064a, 0x0631)])("retains plain RTL prose %j", (raw) => {
    expect(isProseClaim(raw)).toBe(false);
  });
  it("withholds the Syriac abbreviation mark at first-strong position", () => {
    expect(isProseClaim(cp(0x070f) + "Plate reader notes")).toBe(true);
  });
  it.each(["title", "section", "note", "action", "field"])("adapter withholds RLO in %s prose", (role) => {
    const adapted = dashboardManifestToIr(manifest(rlo));
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error(adapted.reason);
    const all = [adapted.doc.title, ...nodes(adapted.doc.root)];
    const selected = role === "title" ? adapted.doc.title : role === "section" ? all.find((n) => n.type === "heading" && n !== adapted.doc.title) : all.find((n) => n.type === ({ note: "text", action: "badge", field: "field-label" } as const)[role as "note" | "action" | "field"]);
    expect(selected, role).toBeDefined();
    expect(selected?.props?.withheld, role).toBe(true);
  });
  it("validateIr rejects hand-built control-bearing prose", () => {
    const adapted = dashboardManifestToIr(manifest("Plate reader notes"));
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) throw new Error(adapted.reason);
    adapted.doc.title.props.text = rlo;
    expect(validateIr(adapted.doc).ok).toBe(false);
  });
  for (const [kind, raw] of [["RLO", rlo], ["U2065", "Payment veri" + cp(0x2065) + "fied"]]) {
    it(kind + " bound status withholds the raw value", () => { expect(readText(boundStatusText(raw!)).t).toBe(readText(WITHHELD_FIELD).t); });
    it(kind + " reported name withholds the raw value", () => { expect(readText(reportedFieldText("name", raw!)).t).toBe(readText(WITHHELD_FIELD).t); });
  }
  it("shipped IR kit renders withheld name/status and no RLO text node", async () => {
    const dom = new JSDOM('<main id="pcc-ir-root"></main>', { url: "https://capability.network/", runScripts: "outside-only" });
    const w = dom.window;
    try {
      Object.assign(w, { TextDecoder, __PCC_IR_ORIGIN__: "https://capability.network" });
      w.parent.postMessage = () => {};
      w.setTimeout = () => 1;
      const bytes = new TextEncoder().encode(JSON.stringify({ kernels: [{ id: "k-1", name: rlo, status: rlo }], asOf: new Date().toISOString() }));
      w.fetch = (() => { let sent = false; return Promise.resolve({ status: 200, redirected: false, headers: { get: () => "application/json" }, body: { getReader: () => ({ read: async () => sent ? { done: true } : ((sent = true), { done: false, value: bytes }), cancel: async () => {} }), cancel: async () => {} } }); }) as unknown as typeof fetch;
      w.eval(readFileSync(new URL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ir-kit.js", import.meta.url), "utf8"));
      w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2026-01-26" } } }));
      const m = { csd: "pcc://artifacts/dashboard/v1", title: "Plate reader notes", sections: [{ windows: [{ kind: "list", binding: { path: "/api/kernels" }, item: { title: "name", meta: ["status"], statusFrom: "status" } }] }] };
      w.dispatchEvent(new w.MessageEvent("message", { source: w.parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { manifest: w.JSON.parse(w.JSON.stringify(m)) } } } }));
      for (let i = 0; i < 60; i++) await Promise.resolve();
      expect(w.document.querySelector(".pcc-row")?.textContent).toContain(readText(WITHHELD_FIELD).t);
      for (const selector of [".pcc-row .pcc-heading", ".pcc-row .pcc-meta", ".pcc-row .pcc-badge"]) {
        expect(w.document.querySelector(selector)?.textContent, selector).toBe(readText(WITHHELD_FIELD).t);
      }
      const walker = w.document.createTreeWalker(w.document.body, w.NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) expect(walker.currentNode.textContent).not.toContain(cp(0x202e));
      expect(w.__PCC_UI_TEXT_VIOLATIONS__ ?? 0).toBe(0);
    } finally { w.close(); }
  });
});

it("IR identifier pair check also sees the strong-RTL-removed view", async () => {
  const { identifierText } = await import("./dashboard-ir.js");
  expect(readText(identifierText("id", "paym" + String.fromCodePoint(0x05d0) + "ent-from-the-remote-operator-received")).t).toBe(readText(WITHHELD_FIELD).t);
});

it("IR reserved notice check also sees the strong-RTL-removed view", () => {
  expect(readText(reportedFieldText("name", "withh" + String.fromCodePoint(0x05d0) + "eld")).t).toBe(readText(WITHHELD_FIELD).t);
});
