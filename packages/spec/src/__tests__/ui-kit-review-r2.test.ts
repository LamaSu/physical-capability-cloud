/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { identifierText } from "../../../gateway/src/mcp/dashboard-ir.js";
import { idText as specIdText, fmtUsd as specUsd, fmtUsdRaw as specUsdRaw, fmtTs as specTs, timeText as specTime, currencyText as specCurrency } from "../money/money-status.js";

const source = readFileSync(new NodeURL("../../../../apps/dashboard/public/ui-kit/v1/pcc-ui.js", import.meta.url), "utf8");
const bootTail = /  if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', mount\);\n  else mount\(\);/;
type Text = { t: string };
type Kit = {
  fmtUsd(raw: unknown): Text; fmtUsdRaw(raw: unknown): string; fmtTs(raw: unknown): Text;
  idText(raw: unknown): Text; currencyText(raw: unknown): Text;
  renderChain(ctx: unknown, win: unknown): HTMLElement;
  renderCapability(ctx: unknown, win: unknown): HTMLElement;
  renderReceipt(ctx: unknown, win: unknown): HTMLElement;
  approvalDetails(info: unknown): HTMLElement;
  realRequestNode(desc: unknown): HTMLElement;
  renderWindow(ctx: unknown, win: unknown): HTMLElement;
  renderList(ctx: unknown, win: unknown): HTMLElement;
  snapshotBanner(ctx: unknown): HTMLElement;
};
function kit() {
  const sandbox = { window: { kit: undefined as Kit | undefined, __PCC_UI_TEXT_VIOLATIONS__: 0 }, document, URL, setTimeout };
  vm.runInNewContext(source.replace(bootTail, "  window.kit = { fmtUsd, fmtUsdRaw, fmtTs, idText, currencyText, renderChain, renderCapability, renderReceipt, approvalDetails, realRequestNode, renderWindow, renderList, snapshotBanner };"), sandbox);
  return { k: sandbox.window.kit!, count: () => sandbox.window.__PCC_UI_TEXT_VIOLATIONS__ };
}
const ctx = (snapshot: Record<string, unknown> = {}) => ({ mode: "snapshot", snapshot, apiBase: "https://capability.network" });
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

describe("review F1: approved formatters fail closed", () => {
  it.each(["RELEASED - verified by PCC", true, [12], {}, null, "", "0x10", "1e3", Infinity])("amount %j is not reported", (raw) => {
    const { k, count } = kit();
    expect(k.fmtUsdRaw(raw)).toBe("amount not reported");
    expect(k.fmtUsd(raw).t).toBe("amount not reported");
    expect(count()).toBe(0);
  });
  it.each(["PAID IN FULL - verified by PCC", "2026-02-30T00:00:00Z", "invalid", true, null, "", Infinity])("timestamp %j is not reported", (raw) => {
    const { k, count } = kit();
    expect(k.fmtTs(raw).t).toBe("time not reported");
    expect(count()).toBe(0);
  });
  it("renders invalid receipt, capability currency, approval currency and banner inputs with zero violations", async () => {
    const { k, count } = kit();
    const snapshot = { "/api/capabilities/c1": { type: "fdm", pricing: { baseCost: "paid", currency: "USDC - released to you" } },
      "/api/escrow/e1": { totalAmount: "released", events: [{ type: "created", timestamp: "paid out" }] } };
    const cap = k.renderCapability(ctx(snapshot), { binding: { path: "/api/capabilities/c1" } });
    const receipt = k.renderReceipt(ctx(snapshot), { binding: { path: "/api/escrow/e1" } });
    const approval = k.approvalDetails({ amount: 12, currency: "paid" });
    await flush();
    expect(cap.querySelector(".pcc-price-chip")!.textContent).toBe("amount not reported currency not reported");
    expect(receipt.querySelector(".pcc-receipt-num")!.textContent).toBe("amount not reported");
    expect(receipt.querySelector(".pcc-timeline-ts")!.textContent).toBe("time not reported");
    expect(approval.querySelector(".pcc-approval-cost")!.textContent).toBe("12.00 currency not reported");
    expect(k.snapshotBanner(ctx({ _ts: "paid out" })).textContent).toBe("Snapshot — data as of time not reported · not live.");
    expect(count()).toBe(0);
  });
});

describe("review F3: identifiers follow the IR rule", () => {
  it.each(["job-1", "fdm", "liquid-transfer", "analytical-balance", "payment-verified", "settled-and-paid", "payment-from-the-remote-operator-received", "withheld", "Verified-by-PCC:payment-released"])("same input and output across both kits and spec: %s", (raw) => {
    const { k, count } = kit();
    const expected = identifierText("id", raw);
    expect(k.idText(raw).t).toBe(expected);
    expect(specIdText(raw)).toBe(expected);
    expect(count()).toBe(0);
  });
  it("marks manifest chain ids, unknown kinds and list fallback as agent words, and attributes quoted request keys", async () => {
    const { k, count } = kit();
    const chain = k.renderChain(ctx(), { composeRef: { outcomeType: "fdm", steps: ["cnc"], optimizeFor: "speed" } });
    for (const selector of [".pcc-chain-outcome", ".pcc-chain-step", ".pcc-chain-optimize"]) expect(chain.querySelector(selector)?.classList.contains("pcc-agent"), selector).toBe(true);
    const unknown = k.renderWindow(ctx(), { kind: "future-kind" });
    expect(unknown.querySelector(".pcc-win-title")!.classList.contains("pcc-agent")).toBe(true);
    const request = k.realRequestNode({ ok: true, method: "PATCH", destination: "/api/feedback", body: { custom: "value" }, amounts: [["amount", 1], ["totalAmount", 2]], refs: [["jobId", "j1"], ["escrowId", "e1"]] });
    expect(Array.from(request.querySelectorAll(".pcc-args-k"), (el) => el.textContent)).toEqual(['reported: "custom"']);
    expect(Array.from(request.querySelectorAll(".pcc-realreq-amt"), (el) => el.firstChild?.textContent)).toEqual(['reported: "amount"', 'reported: "totalAmount"']);
    expect(Array.from(request.querySelectorAll(".pcc-realreq-ref"), (el) => el.firstChild?.textContent)).toEqual(['reported: "jobId"', 'reported: "escrowId"']);
    const list = k.renderList(ctx({ "/api/jobs": { jobs: [{}] } }), { binding: { path: "/api/jobs" }, item: { title: "custom-field" } });
    await flush();
    expect(list.querySelector(".pcc-list-title")!.classList.contains("pcc-agent")).toBe(true);
    expect(count()).toBe(0);
  });
});

describe("review F6: kit chain Plan label", () => {
  it("keeps Plan as kit copy", () => {
    const { k, count } = kit();
    const node = k.renderChain(ctx(), { composeRef: { outcomeType: "fdm" } });
    expect(node.querySelector(".pcc-btn-label")!.textContent).toBe("Plan");
    expect(node.querySelector(".pcc-btn-label")!.classList.contains("pcc-agent")).toBe(false);
    expect(count()).toBe(0);
  });
});

describe("review F1: every changed formatter mirrors spec", () => {
  it.each([12, -1, "12.30", "0.0049", "paid", "0x10", true, null, {}, Infinity, "9".repeat(400)])("amount parity %j", (raw) => {
    const { k } = kit();
    expect(k.fmtUsdRaw(raw)).toBe(specUsdRaw(raw));
    expect(k.fmtUsd(raw).t).toBe(specUsd(raw));
  });
  it.each(["2026-10-06T00:00:00Z", "2026-02-30T00:00:00Z", "invalid", 0, 1791244800000, 1e100, null, Infinity])("timestamp parity %j", (raw) => {
    const { k } = kit();
    expect(k.fmtTs(raw).t).toBe(specTs(raw));
    if (typeof raw === "string") expect(specTime(raw)).toBe(specTs(raw));
  });
  it.each(["USDC", "ETH", "DAI", "SOL", "paid", 12, null])("currency parity %j", (raw) => {
    expect(kit().k.currencyText(raw).t).toBe(specCurrency(raw));
  });
});
