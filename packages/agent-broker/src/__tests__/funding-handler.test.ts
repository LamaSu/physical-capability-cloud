import { describe, it, expect, beforeEach } from "vitest";
import { FundingHandler } from "../funding-handler.js";
import type { CapabilityDemand, CapabilitySupply } from "../funding-handler.js";

describe("FundingHandler", () => {
  let handler: FundingHandler;

  beforeEach(() => {
    handler = new FundingHandler();
  });

  // ── Demand Detection ──────────────────────────────────────────

  it("detects unmet demand when supply is zero (critical)", () => {
    const results = handler.detectUnmetDemand(
      [{ capabilityType: "laser-cut", requestCount: 10 }],
      [],
    );

    expect(results).toHaveLength(1);
    expect(results[0].gapSeverity).toBe("critical");
    expect(results[0].capabilityType).toBe("laser-cut");
    expect(results[0].supplyCount).toBe(0);
  });

  it("detects high severity when demand far exceeds supply", () => {
    const results = handler.detectUnmetDemand(
      [{ capabilityType: "fdm", requestCount: 60 }],
      [{ capabilityType: "fdm", kernelCount: 2, avgQueueDepth: 12 }],
    );

    expect(results).toHaveLength(1);
    expect(results[0].gapSeverity).toBe("high");
  });

  it("detects medium severity with moderate imbalance", () => {
    const results = handler.detectUnmetDemand(
      [{ capabilityType: "fdm", requestCount: 12 }],
      [{ capabilityType: "fdm", kernelCount: 5, avgQueueDepth: 3 }],
    );

    expect(results).toHaveLength(1);
    expect(results[0].gapSeverity).toBe("medium");
  });

  it("filters out low-severity gaps", () => {
    const results = handler.detectUnmetDemand(
      [{ capabilityType: "fdm", requestCount: 3 }],
      [{ capabilityType: "fdm", kernelCount: 5, avgQueueDepth: 1 }],
    );

    expect(results).toHaveLength(0);
  });

  it("sorts results by severity (critical first)", () => {
    const results = handler.detectUnmetDemand(
      [
        { capabilityType: "fdm", requestCount: 30 },
        { capabilityType: "laser-cut", requestCount: 5 },
      ],
      [
        { capabilityType: "fdm", kernelCount: 2, avgQueueDepth: 6 },
        // laser-cut has zero supply
      ],
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].gapSeverity).toBe("critical"); // laser-cut, zero supply
  });

  // ── Funding Evaluation ────────────────────────────────────────

  it("approves funding within treasury limits", () => {
    const result = handler.evaluateFundingRequest({
      capabilityType: "laser-cut",
      amount: "1000",
      reason: "High demand for laser cutting",
    });

    expect(result.approved).toBe(true);
    expect(result.proposal).toBeDefined();
    expect(result.proposal!.status).toBe("approved");
    expect(result.proposal!.capabilityType).toBe("laser-cut");
  });

  it("denies funding exceeding 10% policy cap", () => {
    const result = handler.evaluateFundingRequest({
      capabilityType: "laser-cut",
      amount: "10000", // > 10% of 50000
      reason: "Too much",
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("policy limit");
  });

  it("denies funding exceeding total treasury balance", () => {
    const result = handler.evaluateFundingRequest({
      capabilityType: "laser-cut",
      amount: "999999",
      reason: "Way too much",
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Insufficient treasury");
  });

  it("denies funding with invalid amount", () => {
    const result = handler.evaluateFundingRequest({
      capabilityType: "fdm",
      amount: "not-a-number",
      reason: "Bad amount",
    });

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Invalid amount");
  });

  it("deducts from treasury after approval", () => {
    const before = handler.getTreasury();
    const usdcBefore = parseFloat(
      before.balances.find((b) => b.currency === "USDC")!.amount,
    );

    handler.evaluateFundingRequest({
      capabilityType: "fdm",
      amount: "1000",
      reason: "Test",
    });

    const after = handler.getTreasury();
    const usdcAfter = parseFloat(
      after.balances.find((b) => b.currency === "USDC")!.amount,
    );

    expect(usdcAfter).toBeCloseTo(usdcBefore - 1000, 2);
  });

  // ── Dashboard Summary ─────────────────────────────────────────

  it("returns dashboard summary with treasury and proposals", () => {
    handler.evaluateFundingRequest({
      capabilityType: "fdm",
      amount: "1000",
      reason: "Test",
    });

    const summary = handler.getDashboardSummary();
    expect(summary.treasury.agentId).toBe("broker-agent");
    expect(summary.proposals).toHaveLength(1);
    expect(summary.proposalCount).toBe(1);
    expect(parseFloat(summary.approvedTotal)).toBe(1000);
  });

  it("proposeFundingGrant creates a proposal in proposed state", () => {
    const proposal = handler.proposeFundingGrant(
      "cnc-5axis",
      "5000",
      "Need more 5-axis CNC capacity",
    );

    expect(proposal.id).toMatch(/^fund_/);
    expect(proposal.status).toBe("proposed");
    expect(proposal.capabilityType).toBe("cnc-5axis");
    expect(proposal.amount).toBe("5000");
  });
});
