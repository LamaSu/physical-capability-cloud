/**
 * ReputationService — computes effective reputation with exponential decay and cold-start gating.
 *
 * Design principles:
 * - Pure computation: no DB reads, no async, no side effects.
 * - Decay is applied at READ time; the DB stores the ceiling (last known score).
 * - New operators (< 20 jobs) receive a cold-start bonus to avoid stuck states.
 * - Cold-start gate caps the maxAssuranceTier returned in DTOs.
 *
 * Decay formula: R_effective = R_stored × 2^(-Δt / T_half)
 *   - T_half = 30 days default
 *   - Grace period = 7 days (no decay within 7 days of last update)
 *   - Floor = 50 (registered kernels never decay below 50)
 *
 * Tier access:
 *   Tier 0 / 1 — always available
 *   Tier 2     — requires ≥ 5 completed jobs AND effective rep ≥ 300
 *   Tier 3     — requires ≥ 20 completed jobs AND effective rep ≥ 600
 */

import type { AssuranceTier } from "@pcc/spec";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default half-life for reputation decay (30 days in ms) */
const REPUTATION_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Grace period before decay begins (7 days in ms) */
const DECAY_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum effective reputation for any registered kernel */
const REPUTATION_FLOOR = 50;

/** Number of jobs required to exit cold-start */
const COLD_START_JOB_THRESHOLD = 20;

/** Reputation bonus per completed job during cold-start */
const COLD_START_BONUS_PER_JOB = 30;

/** Maximum cold-start bonus (first 20 jobs × 30 = 600 max) */
const COLD_START_BONUS_MAX = 600;

// ── Tier thresholds ────────────────────────────────────────────────────────

/** [minJobs, minEffectiveRep] required to access each tier */
const TIER_REQUIREMENTS: Record<2 | 3, [minJobs: number, minRep: number]> = {
  2: [5, 300],
  3: [20, 600],
};

// ── Service ────────────────────────────────────────────────────────────────

export class ReputationService {
  /**
   * Compute effective reputation for a kernel, applying exponential decay
   * and cold-start bonuses.
   *
   * @param baseScore - Stored reputation integer (0–1000) — the ceiling.
   * @param reputationUpdatedAt - ISO timestamp of last reputation write, or null.
   * @param totalJobsCompleted - Total completed jobs for this kernel.
   * @param now - Override current time in ms (for testing). Default: Date.now().
   */
  computeEffectiveReputation(
    baseScore: number,
    reputationUpdatedAt: string | null | undefined,
    totalJobsCompleted: number,
    now = Date.now(),
  ): number {
    // Cold-start bonus for operators in their first 20 jobs.
    // Applied to the base score before decay so early operators can unlock tiers.
    const bonus = this.coldStartBonus(totalJobsCompleted);
    const effectiveBase = Math.min(1000, baseScore + bonus);

    // No timestamp → legacy row, no decay info available → return base + bonus.
    if (!reputationUpdatedAt) return effectiveBase;

    const lastActiveMs = new Date(reputationUpdatedAt).getTime();
    if (isNaN(lastActiveMs)) return effectiveBase;

    const deltaMs = now - lastActiveMs;

    // Grace period: no decay within the first 7 days of inactivity.
    if (deltaMs <= DECAY_GRACE_PERIOD_MS) return effectiveBase;

    // Exponential decay: R × 2^(-Δt / T_half)
    const decayFactor = Math.pow(2, -(deltaMs / REPUTATION_HALF_LIFE_MS));
    const decayed = Math.round(effectiveBase * decayFactor);

    return Math.max(decayed, REPUTATION_FLOOR);
  }

  /**
   * Determine the maximum assurance tier allowed for a kernel, enforcing the
   * cold-start gate based on completed jobs and effective reputation.
   *
   * @param effectiveReputation - Already-decayed effective reputation score.
   * @param totalJobsCompleted - Total completed jobs for this kernel.
   */
  getMaxAllowedTier(
    effectiveReputation: number,
    totalJobsCompleted: number,
  ): AssuranceTier {
    const [tier3MinJobs, tier3MinRep] = TIER_REQUIREMENTS[3];
    const [tier2MinJobs, tier2MinRep] = TIER_REQUIREMENTS[2];

    if (
      totalJobsCompleted >= tier3MinJobs &&
      effectiveReputation >= tier3MinRep
    ) {
      return 3;
    }

    if (
      totalJobsCompleted >= tier2MinJobs &&
      effectiveReputation >= tier2MinRep
    ) {
      return 2;
    }

    // Tier 0 and 1 are always accessible.
    return 1;
  }

  /**
   * Compute the cold-start reputation bonus for an operator.
   * Linear ramp: +30 per completed job, max +600 over first 20 jobs.
   * Returns 0 once the operator has ≥ 20 completed jobs.
   */
  coldStartBonus(totalJobsCompleted: number): number {
    if (totalJobsCompleted >= COLD_START_JOB_THRESHOLD) return 0;
    return Math.min(totalJobsCompleted * COLD_START_BONUS_PER_JOB, COLD_START_BONUS_MAX);
  }

  /**
   * Compute the reputation delta to apply on job completion or failure.
   * Used by kernel-service.ts when updating the DB after a job result.
   *
   * @param success - Whether the job succeeded.
   * @param assuranceTier - The assurance tier of the completed job.
   */
  computeReputationGain(success: boolean, assuranceTier: number): number {
    if (success) {
      // Higher tiers earn more reputation.
      const tierGains: Record<number, number> = { 0: 5, 1: 10, 2: 20, 3: 40 };
      return tierGains[assuranceTier] ?? 10;
    } else {
      // Failures deduct reputation; higher tiers are penalised more.
      const tierPenalties: Record<number, number> = { 0: -10, 1: -10, 2: -50, 3: -100 };
      return tierPenalties[assuranceTier] ?? -20;
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _reputationService: ReputationService | null = null;

export function getReputationService(): ReputationService {
  if (!_reputationService) {
    _reputationService = new ReputationService();
  }
  return _reputationService;
}

/** Reset singleton (for tests) */
export function resetReputationService(): void {
  _reputationService = null;
}
