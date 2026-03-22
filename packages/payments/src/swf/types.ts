// ---------------------------------------------------------------------------
// Sovereign Wealth Fund — Configuration & Score Weights
// ---------------------------------------------------------------------------

import type { SWFAllocationStrategy } from "@pcc/spec";

/** Score dimension weights — must sum to 1.0 */
export const SWF_SCORE_WEIGHTS = {
  jobVolume: 0.30,
  reputationScore: 0.25,
  uptimeOrActivity: 0.20,
  tenureFactor: 0.15,
  governanceParticipation: 0.10,
} as const;

/** Default allocation strategy */
export const DEFAULT_ALLOCATION: SWFAllocationStrategy = {
  dividendPercent: 60,
  infrastructurePercent: 25,
  grantsPercent: 10,
  reservePercent: 5,
};

/** Service configuration */
export interface SWFConfig {
  /** Basis points taken from each protocol fee (default: 200 = 2 %) */
  accrualBps: number;
  /** Epoch duration in days (default: 7) */
  epochDurationDays: number;
  /** Fraction of eligible participants that must vote (default: 0.30) */
  quorumRequired: number;
  /** Proposal voting window in days (default: 7) */
  proposalDurationDays: number;
  /** Minimum tenure (days) before a participant can vote (default: 30) */
  minTenureForVotingDays: number;
  /** Default allocation strategy */
  defaultAllocationStrategy: SWFAllocationStrategy;
}

export const DEFAULT_SWF_CONFIG: SWFConfig = {
  accrualBps: 200,
  epochDurationDays: 7,
  quorumRequired: 0.30,
  proposalDurationDays: 7,
  minTenureForVotingDays: 30,
  defaultAllocationStrategy: DEFAULT_ALLOCATION,
};

/** Input data for scoring a participant in an epoch */
export interface ParticipantEpochInput {
  participantId: string;
  /** Raw jobs completed/submitted/verified count */
  jobCount: number;
  /** Reputation score 0-1000 from ERC-8004 */
  reputation: number;
  /** Uptime percentage 0-100 (operators) or activity frequency 0-100 (users) */
  uptimeOrActivity: number;
  /** Days on the network */
  tenureDays: number;
  /** Whether the participant voted in any proposal this epoch */
  votedThisEpoch: boolean;
}
