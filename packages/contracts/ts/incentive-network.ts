/**
 * Revenue Incentive Network — protocol-level incentive distribution.
 *
 * Inspired by Virtuals Protocol's Revenue Network ($1M/month to agents).
 * PCC's incentive network funds DePIN reward epochs from platform fees,
 * yield-bearing escrow earnings, and protocol treasury.
 *
 * Flow:
 *   1. Platform fees (1.5% of each escrow settlement) accumulate in treasury
 *   2. Yield from idle escrow (operator's 70% share already distributed;
 *      protocol keeps a small portion for the incentive pool)
 *   3. Each epoch, the incentive pool is distributed to operators based on
 *      the RewardEngine's weighted scoring
 *
 * This layer sits above RewardEngine and manages the funding sources.
 */

import { RewardEngine, type KernelEpochInput } from "./reward-engine.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncentiveConfig {
  /** Platform fee percentage (basis points, default: 150 = 1.5%) */
  platformFeeBps: number;
  /** Percentage of platform fees allocated to incentive pool (0-1, default: 0.5) */
  feeToIncentiveRatio: number;
  /** Percentage of yield earnings allocated to incentive pool (0-1, default: 0.1) */
  yieldToIncentiveRatio: number;
  /** Minimum pool size to trigger epoch distribution (USDC atomic units) */
  minPoolForDistribution: bigint;
  /** Target epoch duration in seconds (default: 7 days) */
  epochDurationSeconds: number;
}

export interface FundingSource {
  type: "platform_fee" | "yield_earnings" | "treasury_injection" | "grant";
  amount: bigint;
  timestamp: number;
  reference?: string;
}

export interface IncentivePoolState {
  /** Current pool balance (USDC atomic units) */
  balance: bigint;
  /** Total distributed all-time */
  totalDistributed: bigint;
  /** Total epochs completed */
  epochsCompleted: number;
  /** Average distribution per epoch */
  avgDistributionPerEpoch: bigint;
  /** Funding sources for current pool */
  currentSources: FundingSource[];
}

// ---------------------------------------------------------------------------
// Incentive Network
// ---------------------------------------------------------------------------

export class IncentiveNetwork {
  private config: IncentiveConfig;
  private rewardEngine: RewardEngine;
  private poolBalance: bigint = 0n;
  private totalDistributed: bigint = 0n;
  private epochsCompleted: number = 0;
  private fundingSources: FundingSource[] = [];
  private lastEpochTime: number;

  constructor(config: Partial<IncentiveConfig> = {}, rewardEngine?: RewardEngine) {
    this.config = {
      platformFeeBps: config.platformFeeBps ?? 150,
      feeToIncentiveRatio: config.feeToIncentiveRatio ?? 0.5,
      yieldToIncentiveRatio: config.yieldToIncentiveRatio ?? 0.1,
      minPoolForDistribution: config.minPoolForDistribution ?? 100_000_000n, // $100
      epochDurationSeconds: config.epochDurationSeconds ?? 7 * 24 * 60 * 60, // 7 days
    };
    this.rewardEngine = rewardEngine ?? new RewardEngine();
    this.lastEpochTime = Math.floor(Date.now() / 1000);
  }

  /**
   * Record a platform fee from an escrow settlement.
   * Automatically allocates the incentive portion to the pool.
   */
  recordPlatformFee(settlementAmount: bigint, reference?: string): bigint {
    const fee = (settlementAmount * BigInt(this.config.platformFeeBps)) / 10000n;
    const incentivePortion = BigInt(
      Math.floor(Number(fee) * this.config.feeToIncentiveRatio),
    );

    this.poolBalance += incentivePortion;
    this.fundingSources.push({
      type: "platform_fee",
      amount: incentivePortion,
      timestamp: Math.floor(Date.now() / 1000),
      reference,
    });

    return incentivePortion;
  }

  /**
   * Record yield earnings from the yield-bearing escrow.
   * Allocates the incentive portion to the pool.
   */
  recordYieldEarnings(yieldAmount: bigint, reference?: string): bigint {
    const incentivePortion = BigInt(
      Math.floor(Number(yieldAmount) * this.config.yieldToIncentiveRatio),
    );

    this.poolBalance += incentivePortion;
    this.fundingSources.push({
      type: "yield_earnings",
      amount: incentivePortion,
      timestamp: Math.floor(Date.now() / 1000),
      reference,
    });

    return incentivePortion;
  }

  /**
   * Inject funds directly from the protocol treasury or grants.
   */
  injectFunds(amount: bigint, source: "treasury_injection" | "grant", reference?: string): void {
    this.poolBalance += amount;
    this.fundingSources.push({
      type: source,
      amount,
      timestamp: Math.floor(Date.now() / 1000),
      reference,
    });
  }

  /**
   * Check if conditions are met for a new epoch distribution.
   */
  isEpochReady(): { ready: boolean; reason?: string } {
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - this.lastEpochTime;

    if (elapsed < this.config.epochDurationSeconds) {
      const remaining = this.config.epochDurationSeconds - elapsed;
      return { ready: false, reason: `${remaining}s until next epoch` };
    }

    if (this.poolBalance < this.config.minPoolForDistribution) {
      return {
        ready: false,
        reason: `Pool ${this.poolBalance} < minimum ${this.config.minPoolForDistribution}`,
      };
    }

    return { ready: true };
  }

  /**
   * Execute an epoch distribution. Takes the current pool, scores all
   * operators, and distributes rewards proportionally.
   */
  executeEpoch(kernelInputs: KernelEpochInput[]): {
    epochNumber: number;
    totalDistributed: bigint;
    distributions: Array<{ kernelId: string; amount: string; score: number }>;
  } {
    const check = this.isEpochReady();
    if (!check.ready) {
      throw new Error(`Epoch not ready: ${check.reason}`);
    }

    const epochNumber = this.epochsCompleted + 1;
    const poolForDistribution = this.poolBalance;

    // Create and complete epoch in the reward engine
    const now = new Date().toISOString();
    const epoch = this.rewardEngine.createEpoch(
      epochNumber,
      this.lastEpochTime.toString(),
      now,
      poolForDistribution.toString(),
    );

    this.rewardEngine.completeEpoch(epoch.id, kernelInputs);

    // Extract distribution results
    const completedEpoch = this.rewardEngine.getEpoch(epoch.id)!;
    const distributions = completedEpoch.kernelScores.map(s => ({
      kernelId: s.kernelId,
      amount: s.rewardAmount,
      score: s.totalScore,
    }));

    // Update state
    this.totalDistributed += poolForDistribution;
    this.poolBalance = 0n;
    this.epochsCompleted++;
    this.lastEpochTime = Math.floor(Date.now() / 1000);
    this.fundingSources = []; // Reset for next epoch

    return {
      epochNumber,
      totalDistributed: poolForDistribution,
      distributions,
    };
  }

  /**
   * Get current pool state.
   */
  getPoolState(): IncentivePoolState {
    return {
      balance: this.poolBalance,
      totalDistributed: this.totalDistributed,
      epochsCompleted: this.epochsCompleted,
      avgDistributionPerEpoch: this.epochsCompleted > 0
        ? this.totalDistributed / BigInt(this.epochsCompleted)
        : 0n,
      currentSources: [...this.fundingSources],
    };
  }

  /** Get the underlying RewardEngine for direct access. */
  getRewardEngine(): RewardEngine {
    return this.rewardEngine;
  }
}
