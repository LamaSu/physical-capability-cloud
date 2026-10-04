// ---------------------------------------------------------------------------
// Capability Bounty Service — In-memory mock implementation
//
// Nothing here is funded: no treasury exists and no escrow is called, so every
// bounty carries fundingStatus "unfunded". Auto-creating "treasury" bounties
// from demand signals is OFF unless a caller opts in explicitly (tests/demos).
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";

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

// Random ids: a process-local counter restarts at 0001 and collides with ids
// handed out before a restart.
function generateDemandId(): string {
  return `demand-${randomUUID()}`;
}

function generateBountyId(): string {
  return `bounty-${randomUUID()}`;
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

export interface BountyServiceOptions {
  /**
   * Auto-create "treasury" bounties when demand crosses a threshold. Off by
   * default: no treasury exists, so an auto-created bounty would advertise a
   * reward nobody funded.
   */
  autoCreateTreasuryBounties?: boolean;
}

/**
 * A detached, deeply frozen copy (astra pack 36b). Every public read returns
 * one, so no caller can forge a stored record's status, funding, earnings or
 * demand state by mutating what it was handed.
 */
function snapshot<T>(value: T): Readonly<T> {
  const copy = structuredClone(value);
  const freeze = (o: unknown): void => {
    if (o !== null && typeof o === "object" && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o as Record<string, unknown>)) freeze(v);
    }
  };
  freeze(copy);
  return copy;
}

/**
 * State is runtime-private (astra pack 36c): ES `#` fields, not TypeScript
 * `private`, so a holder of an instance (the gateway's shared one included) can
 * neither reach nor enumerate the stored maps. The instance is frozen, so no one
 * can shadow its readers or flip the treasury switch after construction, and
 * inputs are copied on the way in, so a caller keeps no alias into stored state.
 */
export class BountyService {
  #demandSignals = new Map<string, DemandSignal>();
  #bounties = new Map<string, CapabilityBounty>();
  #hunters = new Map<string, BountyHunter>();
  readonly #autoCreateTreasuryBounties: boolean;

  constructor(options: BountyServiceOptions = {}) {
    this.#autoCreateTreasuryBounties = options.autoCreateTreasuryBounties === true;
    Object.freeze(this);
  }

  // ── Demand Signals ──────────────────────────────────────────────

  submitDemand(
    input: Omit<DemandSignal, "id" | "createdAt" | "status">,
  ): Readonly<DemandSignal> {
    const signal: DemandSignal = {
      ...structuredClone(input),
      id: generateDemandId(),
      createdAt: new Date().toISOString(),
      status: "active",
    };
    this.#demandSignals.set(signal.id, signal);
    return snapshot(signal);
  }

  getDemandSignals(capabilityType?: string): Readonly<DemandSignal>[] {
    const all = [...this.#demandSignals.values()];
    const picked = capabilityType ? all.filter((s) => s.capabilityType === capabilityType) : all;
    return picked.map(snapshot);
  }

  getTopDemand(
    limit = 10,
  ): { capabilityType: string; count: number; annualValue: number }[] {
    const agg = new Map<
      string,
      { requesters: Set<string>; annualValue: number }
    >();

    for (const signal of this.#demandSignals.values()) {
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
    /** Who is PROPOSED to fund it. A proposal only: nothing funds a bounty (see fundingStatus). */
    proposedFundingSource?: "treasury" | "requesters" | "mixed";
    demandCount?: number;
    estimatedAnnualValue?: number;
  }): Readonly<CapabilityBounty> {
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
      ...(params.proposedFundingSource ? { proposedFundingSource: params.proposedFundingSource } : {}),
      fundingStatus: "unfunded",
      requirements: structuredClone(params.requirements),
      status: "open",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    this.#bounties.set(bounty.id, bounty);
    return snapshot(bounty);
  }

  listBounties(filter?: {
    status?: CapabilityBounty["status"];
    capabilityType?: string;
  }): Readonly<CapabilityBounty>[] {
    let result = [...this.#bounties.values()];
    if (filter?.status) {
      result = result.filter((b) => b.status === filter.status);
    }
    if (filter?.capabilityType) {
      result = result.filter(
        (b) => b.capabilityType === filter.capabilityType,
      );
    }
    return result.map(snapshot);
  }

  claimBounty(bountyId: string, operatorId: string): Readonly<CapabilityBounty> {
    const bounty = this.#bounties.get(bountyId);
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
    this.#ensureHunter(operatorId);
    const hunter = this.#hunters.get(operatorId)!;
    hunter.bountiesClaimed += 1;

    return snapshot(bounty);
  }

  /**
   * RETIRED (astra pack 36, HIGH 2). A caller-supplied job id and score are not
   * verification authority: verification must be derived by the server from real
   * job evidence (ledger R45). Always refuses and changes nothing; the signature
   * stays for API compatibility.
   */
  verifyBounty(
    bountyId: string,
    _jobId: string,
    _verificationScore: number,
  ): never {
    if (!this.#bounties.has(bountyId)) {
      throw new Error(`Bounty ${bountyId} not found`);
    }
    throw new Error(
      `Bounty verification is retired: a caller-supplied score is not authority (bounty ${bountyId}). ` +
        "Verification is derived by the server from real job evidence (ledger R45).",
    );
  }

  /**
   * RETIRED (astra pack 36, HIGH 1). Nothing funds a bounty (fundingStatus is
   * always "unfunded"), so no bounty can be paid and no earnings may be recorded.
   * Payment happens only through the accepted-plan escrow path. Always refuses and
   * changes nothing: no "paid" state, no paidAt, no totalEarned or
   * bountiesCompleted, and no demand signal marked fulfilled.
   */
  payBounty(bountyId: string): never {
    const bounty = this.#bounties.get(bountyId);
    if (!bounty) {
      throw new Error(`Bounty ${bountyId} not found`);
    }
    throw new Error(
      `Bounty payment is retired: nothing funds bounty ${bountyId} (fundingStatus ${bounty.fundingStatus}). ` +
        "Payment happens only through the accepted-plan escrow path.",
    );
  }

  // ── Auto-Bounty Creation ────────────────────────────────────────

  checkAndCreateBounties(): Readonly<CapabilityBounty>[] {
    if (!this.#autoCreateTreasuryBounties) return [];

    const topDemand = this.getTopDemand(100);
    const created: Readonly<CapabilityBounty>[] = [];

    // Collect capability types that already have an open or claimed bounty
    const existingBountyTypes = new Set<string>();
    for (const bounty of this.#bounties.values()) {
      if (
        bounty.status === "open" ||
        bounty.status === "claimed"
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
      const representativeSignal = [...this.#demandSignals.values()].find(
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
        proposedFundingSource: "treasury",
        demandCount: demand.count,
        estimatedAnnualValue: demand.annualValue,
      });

      created.push(bounty);
    }

    return created;
  }

  // ── Leaderboard ─────────────────────────────────────────────────

  getLeaderboard(limit = 10): Readonly<BountyHunter>[] {
    return [...this.#hunters.values()]
      .sort((a, b) => b.totalEarned - a.totalEarned)
      .slice(0, limit)
      .map(snapshot);
  }

  // ── Internal ────────────────────────────────────────────────────

  #ensureHunter(operatorId: string): void {
    if (!this.#hunters.has(operatorId)) {
      this.#hunters.set(operatorId, {
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
