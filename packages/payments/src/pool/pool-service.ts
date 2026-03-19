// ---------------------------------------------------------------------------
// Capability Investment Pool Service — In-memory mock implementation
// ---------------------------------------------------------------------------

import type {
  InvestmentPool,
  PoolStake,
  PoolDistribution,
  PoolConfig,
  PoolStatus,
  StakerEarnings,
} from "./types.js";
import { BountyService } from "../bounty/bounty-service.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PoolConfig = {
  defaultRevenueShareBps: 25, // 0.25%
  defaultSunsetMultiplier: 3, // 3x return
  minStakeAmount: 10,
  maxPoolDuration: 90, // days
};

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let nextPoolId = 1;
let nextStakeId = 1;
let nextDistId = 1;

function generatePoolId(): string {
  return `pool-${String(nextPoolId++).padStart(4, "0")}`;
}

function generateStakeId(): string {
  return `stake-${String(nextStakeId++).padStart(4, "0")}`;
}

function generateDistId(): string {
  return `dist-${String(nextDistId++).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// PoolService
// ---------------------------------------------------------------------------

export class PoolService {
  private pools = new Map<string, InvestmentPool>();
  private config: PoolConfig;
  private bountyService?: BountyService;

  constructor(config?: Partial<PoolConfig>, bountyService?: BountyService) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.bountyService = bountyService;
  }

  // ── Pool Lifecycle ──────────────────────────────────────────────

  createPool(params: {
    capabilityType: string;
    description: string;
    targetAmount?: number;
    currency?: "USDC" | "CREDITS";
    revenueShareBps?: number;
    sunsetMultiplier?: number;
  }): InvestmentPool {
    const pool: InvestmentPool = {
      id: generatePoolId(),
      capabilityType: params.capabilityType,
      description: params.description,
      targetAmount: params.targetAmount ?? 0,
      totalStaked: 0,
      currency: params.currency ?? "USDC",
      stakes: [],
      revenueShareBps:
        params.revenueShareBps ?? this.config.defaultRevenueShareBps,
      sunsetMultiplier:
        params.sunsetMultiplier ?? this.config.defaultSunsetMultiplier,
      totalDistributed: 0,
      status: "open",
      createdAt: new Date().toISOString(),
      distributions: [],
    };

    this.pools.set(pool.id, pool);
    return pool;
  }

  stake(poolId: string, staker: string, amount: number): PoolStake {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`);
    }
    if (pool.status !== "open") {
      throw new Error(
        `Pool ${poolId} is not accepting stakes (status: ${pool.status})`,
      );
    }
    if (amount < this.config.minStakeAmount) {
      throw new Error(
        `Minimum stake amount is ${this.config.minStakeAmount}`,
      );
    }

    const stake: PoolStake = {
      id: generateStakeId(),
      poolId,
      staker,
      amount,
      shareBps: 0, // recalculated below
      stakedAt: new Date().toISOString(),
    };

    pool.stakes.push(stake);
    pool.totalStaked += amount;

    // Recalculate ALL share basis points
    this.recalculateShares(pool);

    return stake;
  }

  closePool(poolId: string): InvestmentPool {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`);
    }
    if (pool.status !== "open") {
      throw new Error(
        `Pool ${poolId} cannot be closed (status: ${pool.status})`,
      );
    }

    pool.status = "funded";
    pool.fundedAt = new Date().toISOString();
    return pool;
  }

  claimPool(poolId: string, operatorId: string): InvestmentPool {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`);
    }
    if (pool.status !== "funded") {
      throw new Error(
        `Pool ${poolId} cannot be claimed (status: ${pool.status})`,
      );
    }

    pool.operatorId = operatorId;
    return pool;
  }

  activatePool(poolId: string, capabilityCertId: string): InvestmentPool {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`);
    }
    if (pool.status !== "funded") {
      throw new Error(
        `Pool ${poolId} cannot be activated (status: ${pool.status})`,
      );
    }

    pool.status = "active";
    pool.capabilityCertId = capabilityCertId;
    pool.activatedAt = new Date().toISOString();
    return pool;
  }

  cancelPool(poolId: string): InvestmentPool {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`);
    }
    if (pool.status === "active" || pool.status === "sunset") {
      throw new Error(
        `Pool ${poolId} cannot be cancelled (status: ${pool.status})`,
      );
    }

    pool.status = "cancelled";
    return pool;
  }

  // ── Revenue Distribution ────────────────────────────────────────

  distributeJobFee(
    capabilityType: string,
    jobId: string,
    totalProtocolFee: number,
  ): PoolDistribution | null {
    // Find an active pool for this capability type
    const pool = this.findActivePool(capabilityType);
    if (!pool) return null;

    // No stakes means nothing to distribute
    if (pool.stakes.length === 0 || pool.totalStaked === 0) return null;

    // Calculate pool's share of the protocol fee
    const poolShare = (totalProtocolFee * pool.revenueShareBps) / 10_000;

    // Distribute pro-rata among stakers
    const distributions = pool.stakes.map((stake) => ({
      staker: stake.staker,
      amount: (poolShare * stake.shareBps) / 10_000,
      shareBps: stake.shareBps,
    }));

    const dist: PoolDistribution = {
      id: generateDistId(),
      poolId: pool.id,
      jobId,
      totalFee: totalProtocolFee,
      poolShare,
      distributions,
      distributedAt: new Date().toISOString(),
    };

    pool.distributions.push(dist);
    pool.totalDistributed += poolShare;

    // Auto-sunset check: if total distributed >= totalStaked * sunsetMultiplier
    if (pool.totalDistributed >= pool.totalStaked * pool.sunsetMultiplier) {
      pool.status = "sunset";
      pool.sunsetAt = new Date().toISOString();
    }

    return dist;
  }

  // ── Queries ─────────────────────────────────────────────────────

  getPool(poolId: string): InvestmentPool | null {
    return this.pools.get(poolId) ?? null;
  }

  getPoolByCapability(capabilityType: string): InvestmentPool | null {
    return this.findActivePool(capabilityType);
  }

  listPools(filter?: {
    status?: PoolStatus;
    capabilityType?: string;
  }): InvestmentPool[] {
    let result = [...this.pools.values()];
    if (filter?.status) {
      result = result.filter((p) => p.status === filter.status);
    }
    if (filter?.capabilityType) {
      result = result.filter(
        (p) => p.capabilityType === filter.capabilityType,
      );
    }
    return result;
  }

  getStakerEarnings(staker: string): StakerEarnings {
    let totalStaked = 0;
    let totalEarned = 0;
    let activePools = 0;
    let sunsetPools = 0;
    const poolEntries: StakerEarnings["pools"] = [];

    for (const pool of this.pools.values()) {
      const stake = pool.stakes.find((s) => s.staker === staker);
      if (!stake) continue;

      totalStaked += stake.amount;

      // Sum this staker's earnings from all distributions in this pool
      let earned = 0;
      for (const dist of pool.distributions) {
        const stakerDist = dist.distributions.find(
          (d) => d.staker === staker,
        );
        if (stakerDist) {
          earned += stakerDist.amount;
        }
      }
      totalEarned += earned;

      if (pool.status === "active") activePools++;
      if (pool.status === "sunset") sunsetPools++;

      poolEntries.push({
        poolId: pool.id,
        capabilityType: pool.capabilityType,
        staked: stake.amount,
        earned,
        shareBps: stake.shareBps,
        status: pool.status,
      });
    }

    return {
      staker,
      totalStaked,
      totalEarned,
      activePools,
      sunsetPools,
      roi: totalStaked > 0 ? totalEarned / totalStaked : 0,
      pools: poolEntries,
    };
  }

  getPoolROI(
    poolId: string,
  ): {
    totalStaked: number;
    totalDistributed: number;
    roi: number;
    projectedSunsetDate?: string;
  } | null {
    const pool = this.pools.get(poolId);
    if (!pool) return null;

    const roi = pool.totalStaked > 0
      ? pool.totalDistributed / pool.totalStaked
      : 0;

    // Project sunset date based on distribution velocity
    let projectedSunsetDate: string | undefined;
    if (
      pool.status === "active" &&
      pool.distributions.length >= 2 &&
      pool.totalStaked > 0
    ) {
      const first = new Date(pool.distributions[0].distributedAt).getTime();
      const last = new Date(
        pool.distributions[pool.distributions.length - 1].distributedAt,
      ).getTime();
      const elapsed = last - first;

      if (elapsed > 0) {
        const velocity = pool.totalDistributed / elapsed; // per ms
        const remaining =
          pool.totalStaked * pool.sunsetMultiplier - pool.totalDistributed;
        if (remaining > 0 && velocity > 0) {
          const msToSunset = remaining / velocity;
          projectedSunsetDate = new Date(
            Date.now() + msToSunset,
          ).toISOString();
        }
      }
    }

    return {
      totalStaked: pool.totalStaked,
      totalDistributed: pool.totalDistributed,
      roi,
      projectedSunsetDate,
    };
  }

  // ── Bounty Integration ──────────────────────────────────────────

  createPoolFromBounty(bountyId: string): InvestmentPool {
    if (!this.bountyService) {
      throw new Error("BountyService not configured");
    }

    const bounties = this.bountyService.listBounties();
    const bounty = bounties.find((b) => b.id === bountyId);
    if (!bounty) {
      throw new Error(`Bounty ${bountyId} not found`);
    }

    // Create pool from bounty
    const pool = this.createPool({
      capabilityType: bounty.capabilityType,
      description: bounty.description,
      currency: bounty.currency,
    });

    // Treasury stake from bounty reward
    if (bounty.bountyReward > 0) {
      this.stake(pool.id, "treasury", bounty.bountyReward);
    }

    return pool;
  }

  // ── Internal ────────────────────────────────────────────────────

  private recalculateShares(pool: InvestmentPool): void {
    if (pool.totalStaked === 0) return;
    for (const stake of pool.stakes) {
      stake.shareBps = Math.round((stake.amount / pool.totalStaked) * 10_000);
    }
  }

  private findActivePool(capabilityType: string): InvestmentPool | null {
    for (const pool of this.pools.values()) {
      if (
        pool.capabilityType === capabilityType &&
        pool.status === "active"
      ) {
        return pool;
      }
    }
    return null;
  }
}
