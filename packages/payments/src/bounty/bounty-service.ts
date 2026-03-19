// ---------------------------------------------------------------------------
// Capability Bounty Service — In-memory mock implementation
// ---------------------------------------------------------------------------

import type {
  DemandSignal,
  CapabilityBounty,
  BountyHunter,
  BountyRequirements,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum unique requesters to auto-create a bounty */
const AUTO_BOUNTY_MIN_REQUESTERS = 3;

/** Minimum estimated annual value ($) to auto-create a bounty */
const AUTO_BOUNTY_MIN_ANNUAL_VALUE = 10_000;

/** Bounty reward = 5% of estimated annual value */
const BOUNTY_REWARD_PERCENT = 0.05;

/** Maximum bounty reward cap ($) */
const BOUNTY_REWARD_CAP = 5_000;

/** Minimum verification score (0-1) required to pass */
const MIN_VERIFICATION_SCORE = 0.7;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let nextDemandId = 1;
let nextBountyId = 1;

function generateDemandId(): string {
  return `demand-${String(nextDemandId++).padStart(4, "0")}`;
}

function generateBountyId(): string {
  return `bounty-${String(nextBountyId++).padStart(4, "0")}`;
}

/** Map frequency to estimated annual multiplier */
function frequencyToAnnualMultiplier(
  freq: DemandSignal["estimatedFrequency"],
): number {
  switch (freq) {
    case "daily":
      return 365;
    case "weekly":
      return 52;
    case "monthly":
      return 12;
    case "one-time":
      return 1;
  }
}

// ---------------------------------------------------------------------------
// BountyService
// ---------------------------------------------------------------------------

export class BountyService {
  private demandSignals = new Map<string, DemandSignal>();
  private bounties = new Map<string, CapabilityBounty>();
  private hunters = new Map<string, BountyHunter>();

  // ── Demand Signals ──────────────────────────────────────────────

  submitDemand(
    input: Omit<DemandSignal, "id" | "createdAt" | "status">,
  ): DemandSignal {
    const signal: DemandSignal = {
      ...input,
      id: generateDemandId(),
      createdAt: new Date().toISOString(),
      status: "active",
    };
    this.demandSignals.set(signal.id, signal);
    return signal;
  }

  getDemandSignals(capabilityType?: string): DemandSignal[] {
    const all = [...this.demandSignals.values()];
    if (capabilityType) {
      return all.filter((s) => s.capabilityType === capabilityType);
    }
    return all;
  }

  getTopDemand(
    limit = 10,
  ): { capabilityType: string; count: number; annualValue: number }[] {
    const agg = new Map<
      string,
      { requesters: Set<string>; annualValue: number }
    >();

    for (const signal of this.demandSignals.values()) {
      if (signal.status !== "active") continue;
      let entry = agg.get(signal.capabilityType);
      if (!entry) {
        entry = { requesters: new Set(), annualValue: 0 };
        agg.set(signal.capabilityType, entry);
      }
      entry.requesters.add(signal.requesterId);
      entry.annualValue +=
        signal.estimatedJobValue *
        frequencyToAnnualMultiplier(signal.estimatedFrequency);
    }

    return [...agg.entries()]
      .map(([capabilityType, { requesters, annualValue }]) => ({
        capabilityType,
        count: requesters.size,
        annualValue,
      }))
      .sort((a, b) => b.annualValue - a.annualValue)
      .slice(0, limit);
  }

  // ── Bounties ────────────────────────────────────────────────────

  createBounty(params: {
    capabilityType: string;
    description: string;
    bountyReward: number;
    currency: "USDC" | "CREDITS";
    requirements: BountyRequirements;
    expiresInDays: number;
    fundedBy?: "treasury" | "requesters" | "mixed";
    demandCount?: number;
    estimatedAnnualValue?: number;
  }): CapabilityBounty {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + params.expiresInDays * 24 * 60 * 60 * 1000,
    );

    const bounty: CapabilityBounty = {
      id: generateBountyId(),
      capabilityType: params.capabilityType,
      description: params.description,
      demandCount: params.demandCount ?? 0,
      estimatedAnnualValue: params.estimatedAnnualValue ?? 0,
      bountyReward: params.bountyReward,
      currency: params.currency,
      fundedBy: params.fundedBy ?? "treasury",
      requirements: params.requirements,
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.bounties.set(bounty.id, bounty);
    return bounty;
  }

  listBounties(filter?: {
    status?: CapabilityBounty["status"];
    capabilityType?: string;
  }): CapabilityBounty[] {
    let result = [...this.bounties.values()];
    if (filter?.status) {
      result = result.filter((b) => b.status === filter.status);
    }
    if (filter?.capabilityType) {
      result = result.filter(
        (b) => b.capabilityType === filter.capabilityType,
      );
    }
    return result;
  }

  claimBounty(bountyId: string, operatorId: string): CapabilityBounty {
    const bounty = this.bounties.get(bountyId);
    if (!bounty) {
      throw new Error(`Bounty ${bountyId} not found`);
    }
    if (bounty.status !== "open") {
      throw new Error(
        `Bounty ${bountyId} cannot be claimed (status: ${bounty.status})`,
      );
    }

    bounty.status = "claimed";
    bounty.claimedBy = operatorId;
    bounty.claimedAt = new Date().toISOString();

    // Track the hunter
    this.ensureHunter(operatorId);
    const hunter = this.hunters.get(operatorId)!;
    hunter.bountiesClaimed += 1;

    return bounty;
  }

  verifyBounty(
    bountyId: string,
    jobId: string,
    verificationScore: number,
  ): CapabilityBounty {
    const bounty = this.bounties.get(bountyId);
    if (!bounty) {
      throw new Error(`Bounty ${bountyId} not found`);
    }
    if (bounty.status !== "claimed") {
      throw new Error(
        `Bounty ${bountyId} cannot be verified (status: ${bounty.status})`,
      );
    }

    bounty.verificationJobId = jobId;
    bounty.verificationScore = verificationScore;

    if (verificationScore >= MIN_VERIFICATION_SCORE) {
      bounty.status = "verified";
    }
    // If score is too low, bounty stays "claimed" — operator can retry

    return bounty;
  }

  payBounty(bountyId: string): CapabilityBounty {
    const bounty = this.bounties.get(bountyId);
    if (!bounty) {
      throw new Error(`Bounty ${bountyId} not found`);
    }
    if (bounty.status !== "verified") {
      throw new Error(
        `Bounty ${bountyId} cannot be paid (status: ${bounty.status})`,
      );
    }

    bounty.status = "paid";
    bounty.paidAt = new Date().toISOString();

    // Update hunter stats
    if (bounty.claimedBy) {
      const hunter = this.hunters.get(bounty.claimedBy);
      if (hunter) {
        hunter.bountiesCompleted += 1;
        hunter.totalEarned += bounty.bountyReward;
        if (!hunter.capabilitiesOnboarded.includes(bounty.capabilityType)) {
          hunter.capabilitiesOnboarded.push(bounty.capabilityType);
        }
        // Reputation = completed / claimed ratio * 100
        hunter.reputation = Math.round(
          (hunter.bountiesCompleted / hunter.bountiesClaimed) * 100,
        );
      }
    }

    // Mark matching demand signals as fulfilled
    for (const signal of this.demandSignals.values()) {
      if (
        signal.capabilityType === bounty.capabilityType &&
        signal.status === "active"
      ) {
        signal.status = "fulfilled";
      }
    }

    return bounty;
  }

  // ── Auto-Bounty Creation ────────────────────────────────────────

  checkAndCreateBounties(): CapabilityBounty[] {
    const topDemand = this.getTopDemand(100);
    const created: CapabilityBounty[] = [];

    // Collect capability types that already have an open or claimed bounty
    const existingBountyTypes = new Set<string>();
    for (const bounty of this.bounties.values()) {
      if (
        bounty.status === "open" ||
        bounty.status === "claimed" ||
        bounty.status === "verified"
      ) {
        existingBountyTypes.add(bounty.capabilityType);
      }
    }

    for (const demand of topDemand) {
      // Skip if a bounty already exists for this capability type
      if (existingBountyTypes.has(demand.capabilityType)) continue;

      const meetsRequesterThreshold =
        demand.count >= AUTO_BOUNTY_MIN_REQUESTERS;
      const meetsValueThreshold =
        demand.annualValue >= AUTO_BOUNTY_MIN_ANNUAL_VALUE;

      if (!meetsRequesterThreshold && !meetsValueThreshold) continue;

      // Calculate reward: 5% of annual value, capped at $5K
      const rawReward = demand.annualValue * BOUNTY_REWARD_PERCENT;
      const bountyReward = Math.min(rawReward, BOUNTY_REWARD_CAP);

      // Find a representative description from the demand signals
      const representativeSignal = [...this.demandSignals.values()].find(
        (s) =>
          s.capabilityType === demand.capabilityType &&
          s.status === "active",
      );

      const bounty = this.createBounty({
        capabilityType: demand.capabilityType,
        description:
          representativeSignal?.description ??
          `Bounty for ${demand.capabilityType} capability`,
        bountyReward,
        currency: "USDC",
        requirements: {
          minimumAssuranceTier: 1,
          mustComplete1Job: true,
          mustPassVerification: true,
        },
        expiresInDays: 90,
        fundedBy: "treasury",
        demandCount: demand.count,
        estimatedAnnualValue: demand.annualValue,
      });

      created.push(bounty);
    }

    return created;
  }

  // ── Leaderboard ─────────────────────────────────────────────────

  getLeaderboard(limit = 10): BountyHunter[] {
    return [...this.hunters.values()]
      .sort((a, b) => b.totalEarned - a.totalEarned)
      .slice(0, limit);
  }

  // ── Internal ────────────────────────────────────────────────────

  private ensureHunter(operatorId: string): void {
    if (!this.hunters.has(operatorId)) {
      this.hunters.set(operatorId, {
        operatorId,
        operatorDid: `did:pcc:operator:${operatorId}`,
        bountiesClaimed: 0,
        bountiesCompleted: 0,
        totalEarned: 0,
        capabilitiesOnboarded: [],
        reputation: 0,
      });
    }
  }
}
