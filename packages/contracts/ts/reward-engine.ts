/**
 * DePIN Reward Engine — calculates per-epoch kernel scores and
 * distributes reward tokens proportionally.
 *
 * Score formula:
 *   jobs(40%) + quality(25%) + uptime(15%) + diversity(10%) + scarcity(10%)
 *
 * This is an off-chain calculation engine.  On-chain settlement
 * (Merkle-drop or direct transfer) is handled separately.
 */

import type {
  RewardEpoch,
  KernelEpochScore,
  DePINRewardClaim,
} from "@pcc/spec";

// ── Weight constants ────────────────────────────────────────────

export const SCORE_WEIGHTS = {
  jobsCompleted: 0.4,
  qualityScore: 0.25,
  uptimePercent: 0.15,
  capabilityDiversity: 0.1,
  scarcityBonus: 0.1,
} as const;

// ── Input data for epoch scoring ────────────────────────────────

export interface KernelEpochInput {
  kernelId: string;
  kernelDid: string;
  jobsCompleted: number;
  /** 0-1 */
  qualityScore: number;
  /** 0-100 */
  uptimePercent: number;
  /** Number of unique capability types */
  capabilityDiversity: number;
  /** 0-1 bonus for scarce capabilities */
  scarcityBonus: number;
}

// ── RewardEngine ────────────────────────────────────────────────

export class RewardEngine {
  private epochs = new Map<string, RewardEpoch>();
  private claims = new Map<string, DePINRewardClaim>();

  // ── Epoch lifecycle ──────────────────────────────────────────

  /**
   * Create a new reward epoch.
   */
  createEpoch(
    epochNumber: number,
    startTime: string,
    endTime: string,
    totalRewards: string,
  ): RewardEpoch {
    const id = `epoch_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    const epoch: RewardEpoch = {
      id,
      epochNumber,
      startTime,
      endTime,
      totalRewards,
      status: "active",
      kernelScores: [],
    };
    this.epochs.set(id, epoch);
    return epoch;
  }

  /**
   * Calculate weighted scores for every kernel in the epoch.
   * This normalizes raw metrics so that the highest performer in each
   * dimension gets a 1.0 and scores are relative.
   */
  calculateEpochScores(inputs: KernelEpochInput[]): KernelEpochScore[] {
    if (inputs.length === 0) return [];

    // Find max values for normalization
    const maxJobs = Math.max(...inputs.map((k) => k.jobsCompleted), 1);
    const maxDiversity = Math.max(
      ...inputs.map((k) => k.capabilityDiversity),
      1,
    );

    return inputs.map((input) => {
      const normJobs = input.jobsCompleted / maxJobs;
      const normQuality = Math.min(Math.max(input.qualityScore, 0), 1);
      const normUptime = Math.min(Math.max(input.uptimePercent, 0), 100) / 100;
      const normDiversity = input.capabilityDiversity / maxDiversity;
      const normScarcity = Math.min(Math.max(input.scarcityBonus, 0), 1);

      const totalScore =
        normJobs * SCORE_WEIGHTS.jobsCompleted +
        normQuality * SCORE_WEIGHTS.qualityScore +
        normUptime * SCORE_WEIGHTS.uptimePercent +
        normDiversity * SCORE_WEIGHTS.capabilityDiversity +
        normScarcity * SCORE_WEIGHTS.scarcityBonus;

      return {
        kernelId: input.kernelId,
        kernelDid: input.kernelDid,
        jobsCompleted: input.jobsCompleted,
        qualityScore: input.qualityScore,
        uptimePercent: input.uptimePercent,
        capabilityDiversity: input.capabilityDiversity,
        scarcityBonus: input.scarcityBonus,
        totalScore,
        rewardAmount: "0", // filled by distributeRewards
      };
    });
  }

  /**
   * Distribute the reward pool proportionally across kernel scores.
   * Returns the updated scores with `rewardAmount` populated.
   */
  distributeRewards(
    scores: KernelEpochScore[],
    totalPool: string,
  ): KernelEpochScore[] {
    const pool = parseFloat(totalPool);
    if (pool <= 0 || scores.length === 0) return scores;

    const sumScores = scores.reduce((s, k) => s + k.totalScore, 0);
    if (sumScores === 0) return scores;

    return scores.map((score) => ({
      ...score,
      rewardAmount: ((score.totalScore / sumScores) * pool).toFixed(6),
    }));
  }

  /**
   * Finalize an epoch: mark it as distributing, compute scores,
   * distribute rewards, then mark as completed.
   */
  completeEpoch(
    epochId: string,
    inputs: KernelEpochInput[],
  ): RewardEpoch {
    const epoch = this.epochs.get(epochId);
    if (!epoch) throw new Error(`Epoch ${epochId} not found`);
    if (epoch.status === "completed") {
      throw new Error(`Epoch ${epochId} is already completed`);
    }

    epoch.status = "distributing";
    const scores = this.calculateEpochScores(inputs);
    epoch.kernelScores = this.distributeRewards(scores, epoch.totalRewards);
    epoch.status = "completed";

    return epoch;
  }

  // ── Claims ────────────────────────────────────────────────────

  /**
   * Submit a reward claim for a kernel for a specific epoch.
   */
  submitClaim(
    kernelId: string,
    epochId: string,
    amount: string,
    chain: string,
  ): DePINRewardClaim {
    const id = `claim_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    const claim: DePINRewardClaim = {
      id,
      kernelId,
      epochId,
      amount,
      chain,
      status: "pending",
    };
    this.claims.set(id, claim);
    return claim;
  }

  /**
   * Mark a pending claim as successfully claimed (mock on-chain settlement).
   */
  settleClaim(claimId: string, txHash: string): DePINRewardClaim {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    if (claim.status !== "pending") {
      throw new Error(`Claim ${claimId} is not pending (status: ${claim.status})`);
    }
    claim.status = "claimed";
    claim.txHash = txHash;
    claim.claimedAt = new Date().toISOString();
    return claim;
  }

  /**
   * Mark a pending claim as failed.
   */
  failClaim(claimId: string): DePINRewardClaim {
    const claim = this.claims.get(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);
    claim.status = "failed";
    return claim;
  }

  // ── Queries ───────────────────────────────────────────────────

  getEpoch(epochId: string): RewardEpoch | undefined {
    return this.epochs.get(epochId);
  }

  listEpochs(
    filter?: { status?: RewardEpoch["status"] },
  ): RewardEpoch[] {
    let list = [...this.epochs.values()];
    if (filter?.status) {
      list = list.filter((e) => e.status === filter.status);
    }
    return list;
  }

  getClaimsForKernel(kernelId: string): DePINRewardClaim[] {
    return [...this.claims.values()].filter((c) => c.kernelId === kernelId);
  }

  getClaim(claimId: string): DePINRewardClaim | undefined {
    return this.claims.get(claimId);
  }

  listClaims(): DePINRewardClaim[] {
    return [...this.claims.values()];
  }

  /**
   * Get reward history for a kernel across all completed epochs.
   */
  getKernelRewardHistory(
    kernelId: string,
  ): { epochId: string; epochNumber: number; score: number; reward: string }[] {
    const history: { epochId: string; epochNumber: number; score: number; reward: string }[] = [];
    for (const epoch of this.epochs.values()) {
      if (epoch.status !== "completed") continue;
      const score = epoch.kernelScores.find((s) => s.kernelId === kernelId);
      if (score) {
        history.push({
          epochId: epoch.id,
          epochNumber: epoch.epochNumber,
          score: score.totalScore,
          reward: score.rewardAmount,
        });
      }
    }
    return history;
  }
}
