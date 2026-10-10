/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(new NodeURL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
const bootTail = /  if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', mount\);\n  else mount\(\);/;
type Kit = {
  renderWindow(ctx: unknown, win: unknown): HTMLElement;
  canonicalJson(raw: unknown): string;
  dataAt(raw: unknown, key: string): unknown;
  requestDescriptor(action: unknown, body: unknown, host: boolean, apiBase: string): { ok: boolean; money: boolean };
  realRequestNode(desc: unknown): HTMLElement;
  approvalDetails(info: unknown): HTMLElement;
};
function kit() {
  const sandbox = { window: { kit: undefined as Kit | undefined, __PCC_UI_TEXT_VIOLATIONS__: 0 }, document, URL, setTimeout };
  vm.runInNewContext(source.replace(bootTail, "  window.kit = { renderWindow, canonicalJson, dataAt, requestDescriptor, realRequestNode, approvalDetails };"), sandbox);
  return { k: sandbox.window.kit!, count: () => sandbox.window.__PCC_UI_TEXT_VIOLATIONS__ };
}
function wideBody(size: number) {
  return Object.fromEntries(Array.from({ length: size }, (_, i) => [`field${i}`, i]));
}

describe("review N1: wide object reads stay linear", () => {
  it("renders a 6,000-key action body within 500 ms", () => {
    const { k, count } = kit();
    const body = wideBody(6000);
    const started = performance.now();
    const node = k.renderWindow({ mode: "snapshot", snapshot: {}, apiBase: "https://capability.network" }, {
      kind: "actions", actions: [{ kind: "post", path: "/api/feedback", label: "Send", body }],
    });
    const elapsed = performance.now() - started;
    expect(node.querySelectorAll(".pcc-btn")).toHaveLength(1);
    expect(elapsed).toBeLessThan(500);
    expect(count()).toBe(0);
  }, 20000);

  it("canonicalizes a 3,000-key body within 500 ms without losing fields", () => {
    const { k } = kit();
    const body = wideBody(3000);
    const started = performance.now();
    const encoded = k.canonicalJson(body);
    const elapsed = performance.now() - started;
    expect(JSON.parse(encoded)).toEqual(body);
    expect(elapsed).toBeLessThan(500);
  }, 20000);

  it("reads only enumerable own fields and sees subsequent mutations", () => {
    const { k } = kit();
    const raw = Object.create({ inherited: "hidden" }) as Record<string, unknown>;
    raw.field = 1;
    Object.defineProperty(raw, "nonenumerable", { value: "hidden" });
    expect(k.dataAt(raw, "inherited")).toBeUndefined();
    expect(k.dataAt(raw, "nonenumerable")).toBeUndefined();
    expect(k.dataAt(raw, "field")).toBe(1);
    raw.field = 2;
    expect(k.dataAt(raw, "field")).toBe(2);
    delete raw.field;
    expect(k.dataAt(raw, "field")).toBeUndefined();
  });
});

describe("review N2: approval field names identify the wire terms", () => {
  const claim = "PAID IN FULL - verified by PCC";
  const body = {
    amount: 25, totalAmount: 30, currency: "USDC", jobId: "job-1", escrowId: "esc-1",
    payeeAddress: "0x" + "a".repeat(40), refundAddress: "0x" + "b".repeat(40), [claim]: "a reported value",
  };
  it.each(["request box", "approval args"])("shows quoted, attributed payee, refund and claim keys in the %s", (surface) => {
    const { k, count } = kit();
    const desc = k.requestDescriptor({ kind: "post", path: "/api/escrow", confirm: "approval" }, body, false, "https://capability.network");
    expect(desc.ok).toBe(true);
    expect(desc.money).toBe(true);
    const node = surface === "request box" ? k.realRequestNode(desc) : k.approvalDetails({ amount: 25, currency: "USDC", args: body });
    const rows = Array.from(node.querySelectorAll(".pcc-args-row"));
    for (const key of ["payeeAddress", "refundAddress", claim]) {
      const expected = `reported: ${JSON.stringify(key)}`;
      const row = rows.find((row) => row.querySelector(".pcc-args-k")?.textContent === expected);
      expect(row, expected).toBeDefined();
      const value = body[key as keyof typeof body];
      expect(row!.querySelector(".pcc-args-v")!.textContent).toBe(`reported: ${surface === "request box" ? JSON.stringify(value) : value}`);
    }
    expect(node.textContent).not.toContain("withheld: stated money or verification");
    expect(count()).toBe(0);
  });
  it("quotes and attributes each key in multi-amount and multi-reference labels", () => {
    const { k, count } = kit();
    const desc = k.requestDescriptor({ kind: "post", path: "/api/escrow", confirm: "approval" }, body, false, "https://capability.network");
    const node = k.realRequestNode(desc);
    expect(Array.from(node.querySelectorAll(".pcc-realreq-amt"), (el) => el.textContent)).toEqual([
      'reported: "amount" 25.00 USDC', 'reported: "totalAmount" 30.00 USDC',
    ]);
    expect(Array.from(node.querySelectorAll(".pcc-realreq-ref"), (el) => el.textContent)).toEqual([
      'reported: "jobId" job-1', 'reported: "escrowId" esc-1',
    ]);
    expect(count()).toBe(0);
  });
});
