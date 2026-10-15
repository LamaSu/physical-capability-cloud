/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { jobFlowFixture } from "../../lib/__tests__/job-flow-fixture.js";
import { classifyMoneyStatus, type MoneyTone } from "@pcc/spec";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const snapshotPath = "../../lib/job-flow-snapshot.js";
let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

async function mount() {
  const pagePath = "../JobFlowPage.js";
  const { JobFlowPage } = await import(/* @vite-ignore */ pagePath);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<JobFlowPage />));
  return host;
}

async function pick(host: HTMLElement, value: unknown) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([typeof value === "string" ? value : JSON.stringify(value)], "job.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => { observer.disconnect(); resolve(); });
      observer.observe(host, { childList: true, subtree: true, characterData: true });
      // The file-read event is asynchronous; this guard reports a useful assertion
      // if the page never resolves the selected file.
      setTimeout(() => { observer.disconnect(); resolve(); }, 100);
    });
  });
}

describe("job flow snapshot boundary", () => {
  it("refuses the wrong schemaId with a message", async () => {
    const host = await mount();
    await pick(host, { ...jobFlowFixture(), schemaId: "pcc.job-execution/v2" });
    expect(host.textContent).toContain("Unsupported snapshot schema");
    expect(host.textContent).not.toContain("Snapshot read at");
  });

  it("refuses malformed JSON with a message", async () => {
    const host = await mount();
    await pick(host, "{");
    expect(host.textContent).toContain("Snapshot could not be read");
  });

  it.each([
    ["job", null], ["execution", []], ["evidence", null],
    ["verification", {}], ["settlement", null], ["notices", {}],
  ])("refuses a malformed %s shape without crashing", async (key, value) => {
    const { parseJobExecutionSnapshot } = await import(/* @vite-ignore */ snapshotPath);
    expect(() => parseJobExecutionSnapshot(JSON.stringify({ ...jobFlowFixture(), [key as string]: value })))
      .toThrow("Snapshot could not be read");
  });

  it("refuses nested object text that React cannot render", async () => {
    const { parseJobExecutionSnapshot } = await import(/* @vite-ignore */ snapshotPath);
    const dto = jobFlowFixture();
    expect(() => parseJobExecutionSnapshot(JSON.stringify({ ...dto, job: { ...dto.job, capabilityName: { unsafe: true } } })))
      .toThrow("Snapshot could not be read");
  });

  it("normalizes unknown execution and payout vocabulary to unknown", async () => {
    const { parseJobExecutionSnapshot } = await import(/* @vite-ignore */ snapshotPath);
    const dto = jobFlowFixture();
    const parsed = parseJobExecutionSnapshot(JSON.stringify({
      ...dto,
      execution: { ...dto.execution, phase: "unrecognized_future_phase" },
      settlement: { ...dto.settlement, payout: "unrecognized_future_payout" },
    }));
    expect(parsed.execution.phase).toBe("unknown");
    expect(parsed.settlement.payout).toBe("unknown");
  });

  it("renders out-of-vocabulary axes as unknown without crashing", async () => {
    const host = await mount();
    const dto = jobFlowFixture();
    await pick(host, {
      ...dto,
      execution: { ...dto.execution, phase: "future_phase" },
      evidence: { ...dto.evidence, state: "future_evidence" },
      verification: { outcome: { state: "future_outcome", reason: "future_reason" }, captureChecks: { ...dto.verification.captureChecks, state: "future_capture" } },
      settlement: { ...dto.settlement, link: "future_link", payout: "future_payout" },
      notices: ["future_notice"],
    });
    expect(host.textContent).toContain(`Snapshot read at ${dto.asOf}`);
    expect(host.textContent).toContain("Evidence state unknown");
    expect(host.textContent).toContain("Outcome verdict: unknown");
    expect(host.textContent).toContain("Capture-check state unknown");
    expect(host.textContent).toContain("Settlement link unknown");
    expect(host.textContent).not.toContain("future_");
  });

  it("renders hostile names as inert text and makes no network requests", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const host = await mount();
    const dto = jobFlowFixture();
    const html = '<img src=x onerror="window.pwned=true">';
    const scriptUrl = "javascript:alert(document.cookie)";
    await pick(host, { ...dto, job: { ...dto.job, capabilityName: html, kernelName: scriptUrl } });
    expect(host.textContent).toContain(html);
    expect(host.textContent).toContain(scriptUrl);
    expect(host.querySelector("img, script")).toBeNull();
    expect(Array.from(host.querySelectorAll("a")).some((a) => a.getAttribute("href")?.startsWith("javascript:"))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["settled", "running", "failed"] as MoneyTone[])("a snapshot always renders %s money in neutral gray", async (tone) => {
    const host = await mount();
    const dto = jobFlowFixture();
    dto.settlement.link = "linked";
    dto.settlement.payout = "paid";
    dto.settlement.record = {
      kind: "gateway_escrow_record", escrowId: "escrow-1", contractAddress: `0x${"a".repeat(40)}`, contractVersion: "3", simulated: false,
      escrow: { ...classifyMoneyStatus("ACTIVE"), tone, sourceStatus: "ACTIVE", vocabulary: "escrow_record" },
      milestoneMatch: "exact", milestoneClaimants: 1, milestone: null,
      escrowTotal: { amount: "1", currency: "USDC" }, createdAt: dto.asOf, deadline: dto.asOf, statusObservedAt: null,
    };
    await pick(host, dto);
    expect(host.textContent).toContain(`Snapshot read at ${dto.asOf}`);
    const money = host.querySelector('[aria-label="Money"]')!;
    expect(money.getAttribute("data-tone")).toBe("unknown");
    expect(money.querySelector("span")!.className).toContain("text-white/60");
    expect(money.textContent).toContain("Paid");
  });
});
