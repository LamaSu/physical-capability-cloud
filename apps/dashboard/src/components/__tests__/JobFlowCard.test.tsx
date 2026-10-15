// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GlowBadge } from "@pcc/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutionPhase, PayoutState, SettlementLink, MoneyTone } from "@pcc/spec";
import { classifyMoneyStatus } from "@pcc/spec";
import { jobFlowFixture } from "../../lib/__tests__/job-flow-fixture.js";
import { payoutBadge } from "../../lib/job-execution-view.js";

const phases: ExecutionPhase[] = ["pending", "queued", "dispatched", "running", "awaiting_handoff", "paused", "completed", "failed", "timed_out", "cancelled", "unknown"];
const payouts: PayoutState[] = ["paid", "reported_released", "refunded", "not_paid", "simulated", "unknown"];
const links: SettlementLink[] = ["linked", "not_linked", "ambiguous", "conflicting", "unavailable"];
const address = `0x${"a".repeat(40)}`;
const tx = `0x${"b".repeat(64)}`;
const noRelease = "Not paid: no release recorded";
const cardModule = "../JobFlowCard.js";

async function render(dto = jobFlowFixture(), stale = false) {
  const { JobFlowCard } = await import(cardModule);
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<JobFlowCard dto={dto} stale={stale} />);
  return host;
}

function payoutClass(payout: PayoutState, stale: boolean): string {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<GlowBadge color={payoutBadge(payout, stale).color}>reference</GlowBadge>);
  return host.querySelector("span")!.className;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("R15(b) exact truth table", () => {
  it.each(phases)("phase %s across every payout and link", async (phase) => {
    const { isFailedPrintWithNoRelease } = await import(cardModule);
    for (const payout of payouts) for (const link of links) {
      const dto = jobFlowFixture();
      Object.assign(dto.execution, { phase });
      Object.assign(dto.settlement, { payout, link });
      expect(isFailedPrintWithNoRelease(dto), `${phase}/${payout}/${link}`).toBe(phase === "failed" && payout === "unknown" && link === "not_linked");
    }
  });
});

describe("JobFlowCard fixed rendering", () => {
  it("shows the R15 text with adjacent configured trace and explorer links only for the trigger", async () => {
    vi.stubEnv("VITE_DEMO_TRACE_URL_TEMPLATE", "https://trace.example/jobs/{jobId}.json");
    vi.stubEnv("VITE_VNEXT_ESCROW_ADDRESS", address);
    for (const phase of phases) for (const payout of payouts) for (const link of links) {
      const dto = jobFlowFixture();
      dto.execution.phase = phase;
      Object.assign(dto.settlement, { payout, link });
      const host = await render(dto);
      const trigger = phase === "failed" && payout === "unknown" && link === "not_linked";
      expect(host.textContent!.includes(noRelease), `${phase}/${payout}/${link}`).toBe(trigger);
      if (trigger) {
        const money = host.querySelector('[aria-label="Money"]')!;
        expect(money.textContent).toContain(noRelease);
        expect(money.querySelectorAll("a")).toHaveLength(2);
        expect(money.querySelector('a[href="https://trace.example/jobs/job-print-1.json"]')).not.toBeNull();
        expect(money.querySelector(`a[href="https://sepolia.basescan.org/address/${address}"]`)).not.toBeNull();
      }
    }
  });

  it("a failed print is neutral and never pending or waiting", async () => {
    const host = await render();
    expect(host.textContent).not.toMatch(/pending|waiting/i);
    expect(host.querySelector('[aria-label="Money"] span')!.className).toBe(payoutClass("unknown", false));
    expect(host.innerHTML).not.toMatch(/green|emerald/);
  });

  it.each(payouts)("Paid appears only for payout %s", async (payout) => {
    const dto = jobFlowFixture();
    dto.settlement.payout = payout;
    const host = await render(dto);
    expect([...host.querySelectorAll('[aria-label="Money"] span')].some(e => e.textContent === "Paid")).toBe(payout === "paid");
  });

  it.each(["settled", "refunded", "waiting", "running", "failed", "unknown"] as MoneyTone[])("payout controls money color despite record tone %s", async (tone) => {
    const dto = jobFlowFixture();
    dto.settlement.link = "linked";
    dto.settlement.record = {
      kind: "gateway_escrow_record", escrowId: "escrow-1", contractAddress: address, contractVersion: "3", simulated: false,
      escrow: { ...classifyMoneyStatus("ACTIVE"), tone, sourceStatus: "ACTIVE", vocabulary: "escrow_record" },
      milestoneMatch: "exact", milestoneClaimants: 1, milestone: null,
      escrowTotal: { amount: "1", currency: "USDC" }, createdAt: dto.asOf, deadline: dto.asOf, statusObservedAt: null,
    };
    for (const record of [dto.settlement.record, null]) for (const payout of payouts) for (const stale of [false, true]) {
      Object.assign(dto.settlement, { record, payout });
      const host = await render(dto, stale);
      const badge = host.querySelector('[aria-label="Money"] span')!;
      expect.soft(badge.className, `${record ? tone : "no record"}/${payout}/stale=${stale}`).toBe(payoutClass(payout, stale));
    }
  });

  it.each(["settled", "running", "failed"] as MoneyTone[])("a stale read renders %s money in neutral gray", async (tone) => {
    const dto = jobFlowFixture();
    dto.settlement.link = "linked";
    dto.settlement.payout = "paid";
    dto.settlement.record = {
      kind: "gateway_escrow_record", escrowId: "escrow-1", contractAddress: address, contractVersion: "3", simulated: false,
      escrow: { ...classifyMoneyStatus("ACTIVE"), tone, sourceStatus: "ACTIVE", vocabulary: "escrow_record" },
      milestoneMatch: "exact", milestoneClaimants: 1, milestone: null,
      escrowTotal: { amount: "1", currency: "USDC" }, createdAt: dto.asOf, deadline: dto.asOf, statusObservedAt: null,
    };
    const host = await render(dto, true);
    const money = host.querySelector('[aria-label="Money"]')!;
    expect(money.querySelector("span")!.className).toBe(payoutClass("paid", true));
    expect(money.textContent).toContain("Paid");
  });

  it("keeps received evidence unverified and capture checks separate from outcome and money", async () => {
    const dto = jobFlowFixture();
    Object.assign(dto.verification.captureChecks, { state: "present", pass: 7, partial: 2, fail: 1 });
    const host = await render(dto);
    expect(host.querySelector('[aria-label="Evidence"]')!.textContent).toContain("Evidence received (not verified here)");
    expect(host.textContent!.replace("not verified here", "")).not.toMatch(/\bverified\b/i);
    expect(host.textContent).toContain("Outcome verdict: not available in this view");
    expect(host.textContent).toContain("Capture-check counts");
    expect(host.querySelector('[aria-label="Money"]')!.textContent).toContain(noRelease);
  });

  it("orders rows and labels source times, ids, tiers and bounded evidence", async () => {
    const dto = jobFlowFixture();
    dto.execution.progressPercent = 42;
    dto.execution.completedAt = "2026-10-14T11:30:00Z";
    dto.evidence.bundles = Array.from({ length: 21 }, (_, i) => ({ ...dto.evidence.bundles[0], bundleId: `bundle-${i}-long-id-123456789`, bundleHash: `hash-${i}-long-hash-123456789` }));
    const host = await render(dto);
    expect([...host.querySelectorAll("section")].map(e => e.getAttribute("aria-label"))).toEqual(["Job", "Print", "Evidence", "Outcome verdict", "Money", "Notices"]);
    for (const text of ["created", dto.job.createdAt!, "read at", dto.asOf, "Source completion time", dto.execution.completedAt, "42%", "Contracted tier", "claimed tier", "stored at", dto.job.jobId, dto.job.kernelId, dto.job.stepId, dto.job.capabilityId, "Print bracket", "Workshop"]) expect(host.textContent).toContain(text);
    expect(host.textContent).not.toMatch(/started|updated at/i);
    expect(host.querySelectorAll('[aria-label="Evidence"] li')).toHaveLength(20);
    expect(host.textContent).not.toContain(dto.evidence.bundles[0].bundleId);
    expect(host.textContent).not.toContain(dto.evidence.bundles[0].bundleHash);
  });

  it("null counts and every source_read_failed are explicit read failures", async () => {
    const dto = jobFlowFixture();
    const error = { code: "source_read_failed" as const, message: "<b>nothing here</b>" };
    Object.assign(dto.evidence, { state: "unavailable", bundleCount: null, eventCount: null, fabricatedEventCount: null, error });
    dto.verification.captureChecks.error = error;
    dto.settlement.error = error;
    const host = await render(dto);
    expect(host.querySelector('[aria-label="Evidence"]')!.textContent!.match(/could not be read/g)!.length).toBeGreaterThanOrEqual(4);
    expect(host.querySelector('[aria-label="Outcome verdict"]')!.textContent).toContain("could not be read");
    expect(host.querySelector('[aria-label="Money"]')!.textContent).toContain("could not be read");
    expect(host.textContent).not.toContain("nothing here");
  });
});

describe("JobFlowCard href boundaries", () => {
  it("never turns DTO names or URL-like job ids into hrefs", async () => {
    const dto = jobFlowFixture();
    Object.assign(dto.job, { jobId: "javascript:alert(1)", capabilityName: "https://evil.example", kernelName: '<img src=x onerror="alert(1)">' });
    const host = await render(dto);
    expect(host.querySelectorAll("a, img, script")).toHaveLength(0);
    expect(host.textContent).toContain(dto.job.kernelName);
    expect(host.textContent).toContain("trace not linked");
    expect(host.textContent).toContain("explorer link not configured");
  });

  it.each(["javascript:alert(1)/{jobId}", "http://trace.example/{jobId}", "//trace.example/{jobId}", "/\\evil/{jobId}", "/trace/\n{jobId}", "https://trace.example/no-placeholder"])("refuses unsafe trace config %j", async (template) => {
    vi.stubEnv("VITE_DEMO_TRACE_URL_TEMPLATE", template);
    expect((await render()).querySelectorAll("a")).toHaveLength(0);
  });

  it("encodes job ids into a safe relative trace config", async () => {
    vi.stubEnv("VITE_DEMO_TRACE_URL_TEMPLATE", "/trace/{jobId}.json");
    const dto = jobFlowFixture();
    dto.job.jobId = 'https://evil.example/a?b#c';
    const host = await render(dto);
    expect(host.querySelector("a")!.getAttribute("href")).toBe(`/trace/${encodeURIComponent(dto.job.jobId)}.json`);
  });

  it.each(["0xabc", "javascript:alert(1)", `0x${"g".repeat(40)}`, `0x${"a".repeat(41)}`])("refuses invalid explorer config %s", async (hex) => {
    vi.stubEnv("VITE_VNEXT_ESCROW_ADDRESS", hex);
    const host = await render();
    expect(host.querySelectorAll("a")).toHaveLength(0);
    expect(host.textContent).toContain("explorer link not configured");
  });

  it("builds transaction explorer links only on the fixed origin", async () => {
    vi.stubEnv("VITE_VNEXT_ESCROW_ADDRESS", tx);
    const host = await render();
    expect(host.querySelector(`a[href="https://sepolia.basescan.org/tx/${tx}"]`)).not.toBeNull();
  });

  it("uses the record address ahead of config and rejects invalid record URLs", async () => {
    vi.stubEnv("VITE_VNEXT_ESCROW_ADDRESS", address);
    const dto = jobFlowFixture();
    dto.settlement.record = { contractAddress: tx } as NonNullable<typeof dto.settlement.record>;
    let host = await render(dto);
    expect(host.querySelector(`a[href="https://sepolia.basescan.org/tx/${tx}"]`)).not.toBeNull();
    dto.settlement.record.contractAddress = "https://evil.example/escrow";
    host = await render(dto);
    expect(host.querySelectorAll("a")).toHaveLength(0);
  });
});
