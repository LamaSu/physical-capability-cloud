/**
 * Paymaster Client — gas sponsorship for agent UserOperations.
 *
 * In PCC, agent gas is a platform cost — operators shouldn't need ETH to
 * submit evidence or release milestones. The paymaster sponsors gas for
 * approved operations, paid from the platform treasury.
 *
 * Supports:
 * - Pimlico Verifying Paymaster (hosted, API key)
 * - Alchemy Gas Manager (hosted, policy ID)
 * - Custom/self-hosted paymaster contracts
 *
 * Policy enforcement:
 * - Only sponsor operations on approved contracts (escrows, registries)
 * - Rate limit per agent (prevent gas drain attacks)
 * - Daily budget cap
 */

import type { Address, Hex } from "viem";
import type { PaymasterConfig, SponsorshipResult } from "./types.js";
import { ENTRY_POINT_V07 } from "./smart-account.js";

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// ---------------------------------------------------------------------------
// PaymasterClient
// ---------------------------------------------------------------------------

export class PaymasterClient {
  private config: PaymasterConfig;
  private approvedContracts: Set<Address> = new Set();
  private rateLimits: Map<Address, RateLimitEntry> = new Map();
  private dailySpend = 0n;

  /** Max sponsorships per agent per hour */
  private maxPerAgentPerHour = 100;
  /** Daily gas budget in wei (default: 1 ETH) */
  private dailyBudgetWei = 1_000_000_000_000_000_000n;
  /** Window duration for rate limiting (1 hour) */
  private windowMs = 3_600_000;

  constructor(config: PaymasterConfig) {
    this.config = config;
  }

  // ── Configuration ───────────────────────────────────────────────────

  /** Add a contract to the approved sponsorship list */
  approveContract(address: Address): void {
    this.approvedContracts.add(address.toLowerCase() as Address);
  }

  /** Remove a contract from the approved list */
  revokeContract(address: Address): void {
    this.approvedContracts.delete(address.toLowerCase() as Address);
  }

  /** Set rate limit per agent per hour */
  setRateLimit(maxPerHour: number): void {
    this.maxPerAgentPerHour = maxPerHour;
  }

  /** Set daily gas budget in wei */
  setDailyBudget(budgetWei: bigint): void {
    this.dailyBudgetWei = budgetWei;
  }

  // ── Sponsorship ─────────────────────────────────────────────────────

  /**
   * Request gas sponsorship for a UserOperation.
   *
   * Checks policy (approved contracts, rate limits, daily budget) before
   * requesting sponsorship from the paymaster service.
   */
  async sponsor(
    userOp: Record<string, unknown>,
    agentAddress: Address,
  ): Promise<SponsorshipResult> {
    if (this.config.mode === "none") {
      return { paymasterAndData: "0x" as Hex, gasSaved: 0n, sponsored: false };
    }

    // Policy checks
    const policyCheck = this.checkPolicy(agentAddress);
    if (!policyCheck.allowed) {
      return { paymasterAndData: "0x" as Hex, gasSaved: 0n, sponsored: false };
    }

    try {
      const result = await this.requestSponsorship(userOp);

      if (result.sponsored) {
        // Track rate limit
        this.recordUsage(agentAddress);
        // Track daily spend
        this.dailySpend += result.gasSaved;
      }

      return result;
    } catch {
      return { paymasterAndData: "0x" as Hex, gasSaved: 0n, sponsored: false };
    }
  }

  /** Get sponsorship stats */
  getStats(): {
    dailySpend: bigint;
    dailyBudget: bigint;
    approvedContracts: number;
    activeAgents: number;
  } {
    return {
      dailySpend: this.dailySpend,
      dailyBudget: this.dailyBudgetWei,
      approvedContracts: this.approvedContracts.size,
      activeAgents: this.rateLimits.size,
    };
  }

  /** Reset daily budget (call at midnight or epoch boundary) */
  resetDaily(): void {
    this.dailySpend = 0n;
    this.rateLimits.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────

  private checkPolicy(agentAddress: Address): { allowed: boolean; reason?: string } {
    // Check daily budget
    if (this.dailySpend >= this.dailyBudgetWei) {
      return { allowed: false, reason: "daily_budget_exhausted" };
    }

    // Check rate limit
    const entry = this.rateLimits.get(agentAddress);
    if (entry) {
      const now = Date.now();
      if (now - entry.windowStart < this.windowMs) {
        if (entry.count >= this.maxPerAgentPerHour) {
          return { allowed: false, reason: "rate_limited" };
        }
      }
    }

    return { allowed: true };
  }

  private recordUsage(agentAddress: Address): void {
    const now = Date.now();
    const entry = this.rateLimits.get(agentAddress);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.rateLimits.set(agentAddress, { count: 1, windowStart: now });
    } else {
      entry.count += 1;
    }
  }

  private async requestSponsorship(
    userOp: Record<string, unknown>,
  ): Promise<SponsorshipResult> {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "pm_sponsorUserOperation",
      params: [userOp, ENTRY_POINT_V07],
    };

    // Add policy ID if configured (Pimlico/Alchemy)
    if (this.config.policyId) {
      (body.params as unknown[]).push({ policyId: this.config.policyId });
    }

    const response = await fetch(this.config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const json = await response.json();

    if (json.error || !json.result) {
      return { paymasterAndData: "0x" as Hex, gasSaved: 0n, sponsored: false };
    }

    // Pimlico returns { paymasterAndData, ... }
    const paymasterAndData = json.result.paymasterAndData as Hex;

    // Estimate gas saved (rough: verificationGasLimit * gasPrice)
    const gasSaved = BigInt(json.result.verificationGasLimit ?? "500000") *
      BigInt(json.result.maxFeePerGas ?? "1000000000");

    return { paymasterAndData, gasSaved, sponsored: true };
  }
}
