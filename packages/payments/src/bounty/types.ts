// ---------------------------------------------------------------------------
// Capability Bounty System — Types
// ---------------------------------------------------------------------------

/** A signal that someone wants a capability that doesn't exist on the network */
export interface DemandSignal {
  id: string;
  requesterId: string;
  capabilityType: string;
  description: string;
  /** How much the requester would pay per job */
  estimatedJobValue: number;
  /** How often they'd use it */
  estimatedFrequency: "one-time" | "weekly" | "monthly" | "daily";
  location?: string;
  assuranceTier: number;
  createdAt: string;
  status: "active" | "fulfilled" | "expired";
}

/** Aggregated demand that becomes a bounty */
export interface CapabilityBounty {
  id: string;
  capabilityType: string;
  description: string;
  /** Number of unique requesters who want this */
  demandCount: number;
  /** Total estimated annual value (sum of all demand signals) */
  estimatedAnnualValue: number;
  /** Bounty reward amount (funded by treasury or requesters) */
  bountyReward: number;
  currency: "USDC" | "CREDITS";
  /** Who funded it */
  fundedBy: "treasury" | "requesters" | "mixed";
  /** Requirements to claim */
  requirements: BountyRequirements;
  status: "open" | "claimed" | "verified" | "paid" | "expired";
  /** Who claimed it (operator onboarding the capability) */
  claimedBy?: string;
  claimedAt?: string;
  /** Verification: first job evidence */
  verificationJobId?: string;
  verificationScore?: number;
  paidAt?: string;
  createdAt: string;
  expiresAt: string;
}

export interface BountyRequirements {
  minimumAssuranceTier: number;
  mustComplete1Job: boolean;
  mustPassVerification: boolean;
}

/** Leaderboard entry for top bounty hunters */
export interface BountyHunter {
  operatorId: string;
  operatorDid: string;
  bountiesClaimed: number;
  bountiesCompleted: number;
  totalEarned: number;
  capabilitiesOnboarded: string[];
  reputation: number;
}
