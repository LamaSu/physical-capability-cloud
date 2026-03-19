import { describe, it, expect, beforeEach } from "vitest";
import { BountyService } from "../bounty-service.js";
import type { DemandSignal, CapabilityBounty } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDemandInput(overrides: Partial<Omit<DemandSignal, "id" | "createdAt" | "status">> = {}) {
  return {
    requesterId: overrides.requesterId ?? "requester-001",
    capabilityType: overrides.capabilityType ?? "electron-beam-welding",
    description: overrides.description ?? "Need electron beam welding for aerospace parts",
    estimatedJobValue: overrides.estimatedJobValue ?? 500,
    estimatedFrequency: overrides.estimatedFrequency ?? ("monthly" as const),
    assuranceTier: overrides.assuranceTier ?? 2,
    location: overrides.location,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BountyService", () => {
  let svc: BountyService;

  beforeEach(() => {
    svc = new BountyService();
  });

  // ── Demand Signals ──────────────────────────────────────────────

  describe("demand signals", () => {
    it("should submit a demand signal", () => {
      const signal = svc.submitDemand(makeDemandInput());
      expect(signal.id).toMatch(/^demand-/);
      expect(signal.status).toBe("active");
      expect(signal.capabilityType).toBe("electron-beam-welding");
      expect(signal.createdAt).toBeTruthy();
    });

    it("should list all demand signals", () => {
      svc.submitDemand(makeDemandInput({ capabilityType: "ebw" }));
      svc.submitDemand(makeDemandInput({ capabilityType: "cryo-em" }));
      svc.submitDemand(makeDemandInput({ capabilityType: "ebw" }));

      expect(svc.getDemandSignals()).toHaveLength(3);
    });

    it("should filter demand signals by capability type", () => {
      svc.submitDemand(makeDemandInput({ capabilityType: "ebw" }));
      svc.submitDemand(makeDemandInput({ capabilityType: "cryo-em" }));
      svc.submitDemand(makeDemandInput({ capabilityType: "ebw" }));

      expect(svc.getDemandSignals("ebw")).toHaveLength(2);
      expect(svc.getDemandSignals("cryo-em")).toHaveLength(1);
    });

    it("should aggregate demand signals correctly in getTopDemand", () => {
      // 2 requesters for EBW, monthly @ $500 each => annual value = 2 * 500 * 12 = $12,000
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw", estimatedJobValue: 500, estimatedFrequency: "monthly" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "ebw", estimatedJobValue: 500, estimatedFrequency: "monthly" }));

      // 1 requester for cryo-em, daily @ $200 => annual = 200 * 365 = $73,000
      svc.submitDemand(makeDemandInput({ requesterId: "r3", capabilityType: "cryo-em", estimatedJobValue: 200, estimatedFrequency: "daily" }));

      const top = svc.getTopDemand();
      expect(top).toHaveLength(2);
      // cryo-em should be first (higher annual value)
      expect(top[0].capabilityType).toBe("cryo-em");
      expect(top[0].annualValue).toBe(73_000);
      expect(top[0].count).toBe(1);
      // ebw second
      expect(top[1].capabilityType).toBe("ebw");
      expect(top[1].annualValue).toBe(12_000);
      expect(top[1].count).toBe(2);
    });

    it("should rank getTopDemand by annual value", () => {
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "low", estimatedJobValue: 10, estimatedFrequency: "one-time" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "high", estimatedJobValue: 1000, estimatedFrequency: "weekly" }));

      const top = svc.getTopDemand();
      expect(top[0].capabilityType).toBe("high");
      expect(top[0].annualValue).toBe(52_000);
    });

    it("should count unique requesters (not duplicate signals from same requester)", () => {
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw", estimatedJobValue: 100, estimatedFrequency: "monthly" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw", estimatedJobValue: 200, estimatedFrequency: "monthly" }));

      const top = svc.getTopDemand();
      expect(top[0].count).toBe(1); // same requester, counted once
      // But annual value includes both signals: (100+200)*12 = 3600
      expect(top[0].annualValue).toBe(3_600);
    });

    it("should exclude fulfilled signals from getTopDemand", () => {
      const s1 = svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "ebw" }));

      // Manually set one to fulfilled
      (s1 as DemandSignal).status = "fulfilled";

      const top = svc.getTopDemand();
      expect(top[0].count).toBe(1); // only r2 counted
    });
  });

  // ── Manual Bounty Creation ──────────────────────────────────────

  describe("manual bounty creation", () => {
    it("should create a bounty with all fields", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "Electron beam welding capability needed",
        bountyReward: 2500,
        currency: "USDC",
        requirements: {
          minimumAssuranceTier: 2,
          mustComplete1Job: true,
          mustPassVerification: true,
        },
        expiresInDays: 60,
      });

      expect(bounty.id).toMatch(/^bounty-/);
      expect(bounty.status).toBe("open");
      expect(bounty.bountyReward).toBe(2500);
      expect(bounty.currency).toBe("USDC");
      expect(bounty.requirements.minimumAssuranceTier).toBe(2);
      expect(bounty.expiresAt).toBeTruthy();
    });
  });

  // ── Auto-Bounty Creation ────────────────────────────────────────

  describe("auto-bounty creation", () => {
    it("should auto-create bounty when 3+ requesters want the same capability", () => {
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw", estimatedJobValue: 100, estimatedFrequency: "monthly" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "ebw", estimatedJobValue: 100, estimatedFrequency: "monthly" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r3", capabilityType: "ebw", estimatedJobValue: 100, estimatedFrequency: "monthly" }));

      const created = svc.checkAndCreateBounties();
      expect(created).toHaveLength(1);
      expect(created[0].capabilityType).toBe("ebw");
      expect(created[0].status).toBe("open");
    });

    it("should auto-create bounty when annual value exceeds $10K", () => {
      // Single requester but high value: $1000 * 12 = $12,000
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "cryo-em", estimatedJobValue: 1000, estimatedFrequency: "monthly" }));

      const created = svc.checkAndCreateBounties();
      expect(created).toHaveLength(1);
      expect(created[0].capabilityType).toBe("cryo-em");
      expect(created[0].estimatedAnnualValue).toBe(12_000);
    });

    it("should NOT auto-create bounty when neither threshold is met", () => {
      // 2 requesters (< 3), annual value = 2 * 100 * 12 = $2,400 (< $10K)
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw", estimatedJobValue: 100, estimatedFrequency: "monthly" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "ebw", estimatedJobValue: 100, estimatedFrequency: "monthly" }));

      const created = svc.checkAndCreateBounties();
      expect(created).toHaveLength(0);
    });

    it("should calculate reward as 5% of annual value", () => {
      // Annual value = $20,000 => reward = $1,000
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw", estimatedJobValue: 5000, estimatedFrequency: "monthly" }));

      const created = svc.checkAndCreateBounties();
      expect(created[0].bountyReward).toBe(3_000); // 5% of 60,000
    });

    it("should cap reward at $5,000", () => {
      // Annual value = $365,000 => 5% = $18,250 => capped at $5,000
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "expensive", estimatedJobValue: 1000, estimatedFrequency: "daily" }));

      const created = svc.checkAndCreateBounties();
      expect(created[0].bountyReward).toBe(5_000);
    });

    it("should not create duplicate bounties for the same capability type", () => {
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw", estimatedJobValue: 1000, estimatedFrequency: "monthly" }));

      const first = svc.checkAndCreateBounties();
      expect(first).toHaveLength(1);

      const second = svc.checkAndCreateBounties();
      expect(second).toHaveLength(0);
    });
  });

  // ── Bounty Lifecycle ────────────────────────────────────────────

  describe("claim bounty", () => {
    it("should assign operator to bounty", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });

      const claimed = svc.claimBounty(bounty.id, "operator-001");
      expect(claimed.status).toBe("claimed");
      expect(claimed.claimedBy).toBe("operator-001");
      expect(claimed.claimedAt).toBeTruthy();
    });

    it("should throw when claiming an already-claimed bounty", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });

      svc.claimBounty(bounty.id, "operator-001");
      expect(() => svc.claimBounty(bounty.id, "operator-002")).toThrow(
        /cannot be claimed/,
      );
    });

    it("should throw when claiming a non-existent bounty", () => {
      expect(() => svc.claimBounty("bounty-9999", "operator-001")).toThrow(
        /not found/,
      );
    });
  });

  describe("verify bounty", () => {
    it("should verify bounty with passing score", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.claimBounty(bounty.id, "operator-001");

      const verified = svc.verifyBounty(bounty.id, "job-001", 0.95);
      expect(verified.status).toBe("verified");
      expect(verified.verificationJobId).toBe("job-001");
      expect(verified.verificationScore).toBe(0.95);
    });

    it("should NOT advance to verified with failing score", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.claimBounty(bounty.id, "operator-001");

      const result = svc.verifyBounty(bounty.id, "job-001", 0.4);
      expect(result.status).toBe("claimed"); // stays claimed
      expect(result.verificationScore).toBe(0.4);
    });

    it("should throw when verifying unclaimed bounty", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });

      expect(() => svc.verifyBounty(bounty.id, "job-001", 0.9)).toThrow(
        /cannot be verified/,
      );
    });
  });

  describe("pay bounty", () => {
    it("should pay a verified bounty", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.claimBounty(bounty.id, "operator-001");
      svc.verifyBounty(bounty.id, "job-001", 0.9);

      const paid = svc.payBounty(bounty.id);
      expect(paid.status).toBe("paid");
      expect(paid.paidAt).toBeTruthy();
    });

    it("should throw when paying unverified bounty", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.claimBounty(bounty.id, "operator-001");

      expect(() => svc.payBounty(bounty.id)).toThrow(/cannot be paid/);
    });

    it("should mark demand signals as fulfilled when bounty is paid", () => {
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "ebw" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r3", capabilityType: "other" }));

      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.claimBounty(bounty.id, "operator-001");
      svc.verifyBounty(bounty.id, "job-001", 0.85);
      svc.payBounty(bounty.id);

      const ebwSignals = svc.getDemandSignals("ebw");
      expect(ebwSignals.every((s) => s.status === "fulfilled")).toBe(true);

      const otherSignals = svc.getDemandSignals("other");
      expect(otherSignals[0].status).toBe("active");
    });
  });

  // ── List / Filter Bounties ──────────────────────────────────────

  describe("list bounties", () => {
    it("should list bounties by status", () => {
      const b1 = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW",
        bountyReward: 1000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.createBounty({
        capabilityType: "cryo-em",
        description: "Cryo-EM",
        bountyReward: 3000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 2, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 60,
      });

      svc.claimBounty(b1.id, "operator-001");

      expect(svc.listBounties({ status: "open" })).toHaveLength(1);
      expect(svc.listBounties({ status: "claimed" })).toHaveLength(1);
      expect(svc.listBounties({ status: "paid" })).toHaveLength(0);
    });

    it("should list bounties by capability type", () => {
      svc.createBounty({
        capabilityType: "ebw",
        description: "EBW",
        bountyReward: 1000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.createBounty({
        capabilityType: "cryo-em",
        description: "Cryo-EM",
        bountyReward: 3000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 2, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 60,
      });

      expect(svc.listBounties({ capabilityType: "ebw" })).toHaveLength(1);
      expect(svc.listBounties({ capabilityType: "cryo-em" })).toHaveLength(1);
      expect(svc.listBounties({ capabilityType: "nonexistent" })).toHaveLength(0);
    });

    it("should list all bounties when no filter provided", () => {
      svc.createBounty({
        capabilityType: "ebw",
        description: "EBW",
        bountyReward: 1000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.createBounty({
        capabilityType: "cryo-em",
        description: "Cryo-EM",
        bountyReward: 3000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 2, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 60,
      });

      expect(svc.listBounties()).toHaveLength(2);
    });
  });

  // ── Leaderboard ─────────────────────────────────────────────────

  describe("leaderboard", () => {
    it("should track bounty hunters", () => {
      const b1 = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      const b2 = svc.createBounty({
        capabilityType: "cryo-em",
        description: "Cryo-EM",
        bountyReward: 3000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 2, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 60,
      });

      // operator-001 completes both
      svc.claimBounty(b1.id, "operator-001");
      svc.verifyBounty(b1.id, "job-001", 0.9);
      svc.payBounty(b1.id);

      svc.claimBounty(b2.id, "operator-001");
      svc.verifyBounty(b2.id, "job-002", 0.85);
      svc.payBounty(b2.id);

      const leaderboard = svc.getLeaderboard();
      expect(leaderboard).toHaveLength(1);
      expect(leaderboard[0].operatorId).toBe("operator-001");
      expect(leaderboard[0].bountiesClaimed).toBe(2);
      expect(leaderboard[0].bountiesCompleted).toBe(2);
      expect(leaderboard[0].totalEarned).toBe(5000);
      expect(leaderboard[0].capabilitiesOnboarded).toContain("ebw");
      expect(leaderboard[0].capabilitiesOnboarded).toContain("cryo-em");
      expect(leaderboard[0].reputation).toBe(100);
    });

    it("should rank by total earned", () => {
      const b1 = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW",
        bountyReward: 1000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      const b2 = svc.createBounty({
        capabilityType: "cryo-em",
        description: "Cryo-EM",
        bountyReward: 4000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 2, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 60,
      });

      svc.claimBounty(b1.id, "operator-small");
      svc.verifyBounty(b1.id, "job-001", 0.9);
      svc.payBounty(b1.id);

      svc.claimBounty(b2.id, "operator-big");
      svc.verifyBounty(b2.id, "job-002", 0.95);
      svc.payBounty(b2.id);

      const leaderboard = svc.getLeaderboard();
      expect(leaderboard[0].operatorId).toBe("operator-big");
      expect(leaderboard[0].totalEarned).toBe(4000);
      expect(leaderboard[1].operatorId).toBe("operator-small");
      expect(leaderboard[1].totalEarned).toBe(1000);
    });

    it("should respect limit parameter", () => {
      // Create and complete 3 bounties for 3 different operators
      for (let i = 1; i <= 3; i++) {
        const b = svc.createBounty({
          capabilityType: `cap-${i}`,
          description: `Cap ${i}`,
          bountyReward: i * 1000,
          currency: "USDC",
          requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
          expiresInDays: 30,
        });
        svc.claimBounty(b.id, `operator-${i}`);
        svc.verifyBounty(b.id, `job-${i}`, 0.9);
        svc.payBounty(b.id);
      }

      expect(svc.getLeaderboard(2)).toHaveLength(2);
      expect(svc.getLeaderboard(2)[0].totalEarned).toBe(3000);
    });
  });

  // ── Full Lifecycle ──────────────────────────────────────────────

  describe("full lifecycle", () => {
    it("should complete demand -> auto-bounty -> claim -> verify -> pay", () => {
      // Step 1: Multiple requesters submit demand for "cryo-em"
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "cryo-em", estimatedJobValue: 500, estimatedFrequency: "monthly" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "cryo-em", estimatedJobValue: 800, estimatedFrequency: "monthly" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r3", capabilityType: "cryo-em", estimatedJobValue: 300, estimatedFrequency: "weekly" }));

      // Step 2: Check thresholds — should auto-create bounty
      // Annual value: 500*12 + 800*12 + 300*52 = 6000 + 9600 + 15600 = 31200
      const created = svc.checkAndCreateBounties();
      expect(created).toHaveLength(1);
      const bounty = created[0];
      expect(bounty.capabilityType).toBe("cryo-em");
      expect(bounty.demandCount).toBe(3);
      expect(bounty.estimatedAnnualValue).toBe(31_200);
      // 5% of 31200 = 1560
      expect(bounty.bountyReward).toBe(1_560);
      expect(bounty.fundedBy).toBe("treasury");

      // Step 3: Operator claims
      const claimed = svc.claimBounty(bounty.id, "operator-cryo");
      expect(claimed.status).toBe("claimed");

      // Step 4: Operator completes first job, verifier scores it
      const verified = svc.verifyBounty(bounty.id, "job-cryo-001", 0.92);
      expect(verified.status).toBe("verified");

      // Step 5: Payout
      const paid = svc.payBounty(bounty.id);
      expect(paid.status).toBe("paid");
      expect(paid.paidAt).toBeTruthy();

      // Step 6: Demand signals marked as fulfilled
      const signals = svc.getDemandSignals("cryo-em");
      expect(signals.every((s) => s.status === "fulfilled")).toBe(true);

      // Step 7: Leaderboard updated
      const lb = svc.getLeaderboard();
      expect(lb).toHaveLength(1);
      expect(lb[0].operatorId).toBe("operator-cryo");
      expect(lb[0].totalEarned).toBe(1_560);
      expect(lb[0].capabilitiesOnboarded).toContain("cryo-em");
    });
  });
});
