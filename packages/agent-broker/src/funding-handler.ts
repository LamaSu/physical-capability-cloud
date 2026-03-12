/**
 * Funding Handler — manages treasury oversight, demand detection,
 * and funding grant proposals for the Broker Agent.
 *
 * This module works with the DePIN reward system to identify
 * under-served capability types and propose grants to attract
 * new operators.
 */

import type {
  TreasuryBalance,
  FundingProposal,
} from "@pcc/spec";

export interface CapabilityDemand {
  capabilityType: string;
  /** Number of unfulfilled requests in a recent window */
  requestCount: number;
}

export interface CapabilitySupply {
  capabilityType: string;
  /** Number of kernels offering this capability */
  kernelCount: number;
  /** Average queue depth across those kernels */
  avgQueueDepth: number;
}

export interface UnmetDemandResult {
  capabilityType: string;
  demandCount: number;
  supplyCount: number;
  gapSeverity: "low" | "medium" | "high" | "critical";
}

export class FundingHandler {
  private proposals = new Map<string, FundingProposal>();

  private treasury: TreasuryBalance = {
    agentId: "broker-agent",
    chain: "base",
    balances: [
      { currency: "USDC", amount: "50000.00" },
      { currency: "ETH", amount: "10.5" },
    ],
    totalUsdValue: "85000.00",
    lastUpdated: new Date().toISOString(),
  };

  // ── Demand detection ──────────────────────────────────────────

  /**
   * Compare recent demand signals against current supply to find
   * capability gaps.
   */
  detectUnmetDemand(
    demands: CapabilityDemand[],
    supplies: CapabilitySupply[],
  ): UnmetDemandResult[] {
    const supplyMap = new Map(supplies.map((s) => [s.capabilityType, s]));
    const results: UnmetDemandResult[] = [];

    for (const demand of demands) {
      const supply = supplyMap.get(demand.capabilityType);
      const supplyCount = supply?.kernelCount ?? 0;
      const avgQueue = supply?.avgQueueDepth ?? 0;

      // Gap severity heuristic
      let gapSeverity: UnmetDemandResult["gapSeverity"];
      if (supplyCount === 0) {
        gapSeverity = "critical";
      } else if (demand.requestCount > supplyCount * 5 || avgQueue > 10) {
        gapSeverity = "high";
      } else if (demand.requestCount > supplyCount * 2 || avgQueue > 5) {
        gapSeverity = "medium";
      } else {
        gapSeverity = "low";
      }

      // Only surface gaps that are at least medium
      if (gapSeverity !== "low") {
        results.push({
          capabilityType: demand.capabilityType,
          demandCount: demand.requestCount,
          supplyCount,
          gapSeverity,
        });
      }
    }

    // Sort by severity: critical > high > medium
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    results.sort((a, b) => order[a.gapSeverity] - order[b.gapSeverity]);
    return results;
  }

  // ── Funding proposals ─────────────────────────────────────────

  /**
   * Create a grant proposal to incentivize operators for a
   * specific capability type.
   */
  proposeFundingGrant(
    capabilityType: string,
    amount: string,
    reason: string,
  ): FundingProposal {
    const id = `fund_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    const proposal: FundingProposal = {
      id,
      capabilityType,
      amount,
      reason,
      status: "proposed",
      createdAt: new Date().toISOString(),
    };
    this.proposals.set(id, proposal);
    return proposal;
  }

  /**
   * Evaluate a funding request (from an agent RequestFundingIntent).
   * Approves if treasury has sufficient balance and the amount is
   * within policy limits (max 10 % of USDC balance per request).
   */
  evaluateFundingRequest(request: {
    capabilityType: string;
    amount: string;
    reason: string;
  }): { approved: boolean; proposal?: FundingProposal; reason?: string } {
    const requested = parseFloat(request.amount);
    if (isNaN(requested) || requested <= 0) {
      return { approved: false, reason: "Invalid amount" };
    }

    const usdcBalance = this.getUsdcBalance();
    const maxPerRequest = usdcBalance * 0.1; // 10 % policy cap

    if (requested > usdcBalance) {
      return {
        approved: false,
        reason: `Insufficient treasury balance (requested ${request.amount}, available ${usdcBalance.toFixed(2)})`,
      };
    }

    if (requested > maxPerRequest) {
      return {
        approved: false,
        reason: `Exceeds per-request policy limit of ${maxPerRequest.toFixed(2)} USDC (10% of treasury)`,
      };
    }

    // Approve and create proposal
    const proposal = this.proposeFundingGrant(
      request.capabilityType,
      request.amount,
      request.reason,
    );
    proposal.status = "approved";

    // Deduct from treasury
    this.deductUsdc(requested);

    return { approved: true, proposal };
  }

  // ── Treasury ──────────────────────────────────────────────────

  /**
   * Return the current treasury summary for the dashboard.
   */
  getDashboardSummary(): {
    treasury: TreasuryBalance;
    proposals: FundingProposal[];
    proposalCount: number;
    approvedTotal: string;
  } {
    const proposals = [...this.proposals.values()];
    const approvedTotal = proposals
      .filter((p) => p.status === "approved" || p.status === "disbursed")
      .reduce((sum, p) => sum + parseFloat(p.amount), 0)
      .toFixed(2);

    return {
      treasury: { ...this.treasury },
      proposals,
      proposalCount: proposals.length,
      approvedTotal,
    };
  }

  /**
   * Update the treasury balance (e.g. from on-chain sync).
   */
  setTreasury(treasury: TreasuryBalance): void {
    this.treasury = treasury;
  }

  getTreasury(): TreasuryBalance {
    return { ...this.treasury };
  }

  // ── Internal helpers ──────────────────────────────────────────

  private getUsdcBalance(): number {
    const usdc = this.treasury.balances.find((b) => b.currency === "USDC");
    return usdc ? parseFloat(usdc.amount) : 0;
  }

  private deductUsdc(amount: number): void {
    const usdc = this.treasury.balances.find((b) => b.currency === "USDC");
    if (usdc) {
      const current = parseFloat(usdc.amount);
      usdc.amount = (current - amount).toFixed(2);
    }
    // Update total USD value estimate
    this.treasury.totalUsdValue = this.treasury.balances
      .reduce((sum, b) => {
        // Rough USD conversion
        if (b.currency === "USDC" || b.currency === "DAI") return sum + parseFloat(b.amount);
        if (b.currency === "ETH") return sum + parseFloat(b.amount) * 3500;
        return sum + parseFloat(b.amount);
      }, 0)
      .toFixed(2);
    this.treasury.lastUpdated = new Date().toISOString();
  }
}
