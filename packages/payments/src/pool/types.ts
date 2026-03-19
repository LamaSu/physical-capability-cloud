// ---------------------------------------------------------------------------
// Capability Investment Pool System — Types
// ---------------------------------------------------------------------------

/** Status lifecycle of an investment pool */
export type PoolStatus = "open" | "funded" | "active" | "sunset" | "cancelled";

/** A single stake in a pool */
export interface PoolStake {
  id: string;
  poolId: string;
  staker: string; // address or DID
  amount: number; // in USDC or credits
  shareBps: number; // basis points (0-10000) — calculated after pool closes
  stakedAt: string; // ISO timestamp
}

/** Revenue distribution record */
export interface PoolDistribution {
  id: string;
  poolId: string;
  jobId: string;
  totalFee: number; // total protocol fee from the job
  poolShare: number; // amount routed to this pool (revenueShareBps of fee)
  distributions: Array<{
    staker: string;
    amount: number;
    shareBps: number;
  }>;
  distributedAt: string;
}

/** The investment pool itself */
export interface InvestmentPool {
  id: string;
  capabilityType: string;
  description: string;

  // Funding
  targetAmount: number; // goal (optional — pool can close early)
  totalStaked: number;
  currency: "USDC" | "CREDITS";
  stakes: PoolStake[];

  // Revenue share terms
  revenueShareBps: number; // e.g., 25 = 0.25% of protocol fee goes to pool
  sunsetMultiplier: number; // e.g., 3 = pool sunsets after 3x return
  totalDistributed: number; // running total of all distributions

  // Lifecycle
  status: PoolStatus;
  operatorId?: string; // set when an operator claims
  capabilityCertId?: string; // set when capability is verified

  // Timestamps
  createdAt: string;
  fundedAt?: string; // when pool closes to new stakes
  activatedAt?: string; // when first job completes
  sunsetAt?: string; // when 3x cap hit

  // Distribution history
  distributions: PoolDistribution[];
}

/** Config for the pool system */
export interface PoolConfig {
  defaultRevenueShareBps: number; // default: 25 (0.25%)
  defaultSunsetMultiplier: number; // default: 3 (3x return)
  minStakeAmount: number; // minimum stake per person (default: 10)
  maxPoolDuration: number; // days before unclaimed pool expires (default: 90)
}

/** Summary of a staker's earnings across all pools */
export interface StakerEarnings {
  staker: string;
  totalStaked: number;
  totalEarned: number;
  activePools: number;
  sunsetPools: number;
  roi: number; // totalEarned / totalStaked
  pools: Array<{
    poolId: string;
    capabilityType: string;
    staked: number;
    earned: number;
    shareBps: number;
    status: PoolStatus;
  }>;
}
