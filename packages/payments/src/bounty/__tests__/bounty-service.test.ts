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
    it("gives every signal a unique random id (no restart-colliding counter)", () => {
      const a = svc.submitDemand(makeDemandInput());
      const b = new BountyService().submitDemand(makeDemandInput());

      expect(a.id).toMatch(/^demand-[0-9a-f]{8}-/);
      expect(a.id).not.toBe(b.id);
    });

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

    it("a returned signal is a frozen snapshot: mutating it cannot fulfil it or change the counts (astra pack 36b)", () => {
      const s1 = svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "ebw" }));
      svc.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "ebw" }));

      expect(Object.isFrozen(s1)).toBe(true);
      expect(() => {
        (s1 as { status: string }).status = "fulfilled";
      }).toThrow(TypeError);

      const top = svc.getTopDemand();
      expect(top[0].count).toBe(2); // both still active: nothing outside the service can fulfil a signal
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

      expect(bounty.id).toMatch(/^bounty-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(bounty.fundingStatus).toBe("unfunded");
      expect(bounty.status).toBe("open");
      expect(bounty.bountyReward).toBe(2500);
      expect(bounty.currency).toBe("USDC");
      expect(bounty.requirements.minimumAssuranceTier).toBe(2);
      expect(bounty.expiresAt).toBeTruthy();
    });
  });

  // ── Auto-Bounty Creation ────────────────────────────────────────

  describe("auto-bounty creation (default: off)", () => {
    it("never auto-creates a bounty by default, even when every threshold is met", () => {
      // 3 requesters AND an annual value far above $10K: both triggers fire.
      for (const r of ["r1", "r2", "r3"]) {
        svc.submitDemand(makeDemandInput({ requesterId: r, capabilityType: "ebw", estimatedJobValue: 5000, estimatedFrequency: "daily" }));
      }

      expect(svc.checkAndCreateBounties()).toHaveLength(0);
      expect(svc.listBounties()).toHaveLength(0);
    });

    it("stays off for any options value other than an explicit true", () => {
      const loose = new BountyService({ autoCreateTreasuryBounties: "yes" as unknown as boolean });
      loose.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "cryo-em", estimatedJobValue: 1000, estimatedFrequency: "monthly" }));

      expect(loose.checkAndCreateBounties()).toHaveLength(0);
    });
  });

  describe("auto-bounty creation (explicit opt-in, tests/demos only)", () => {
    beforeEach(() => {
      svc = new BountyService({ autoCreateTreasuryBounties: true });
    });

    it("marks every auto-created bounty unfunded: no treasury backs it", () => {
      svc.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "cryo-em", estimatedJobValue: 1000, estimatedFrequency: "monthly" }));

      const created = svc.checkAndCreateBounties();
      expect(created).toHaveLength(1);
      expect(created[0].proposedFundingSource).toBe("treasury");
      expect("fundedBy" in created[0]).toBe(false);
      expect(created[0].fundingStatus).toBe("unfunded");
    });

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

  describe("verify bounty (retired: astra pack 36)", () => {
    it("refuses any caller-supplied score and changes nothing", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.claimBounty(bounty.id, "operator-001");
      for (const score of [0.95, 0.4]) {
        expect(() => svc.verifyBounty(bounty.id, "job-001", score)).toThrow(/verification is retired/);
      }
      const after = svc.listBounties().find((b) => b.id === bounty.id)!;
      expect(after.status).toBe("claimed");
      expect(after.verificationScore).toBeUndefined();
      expect(after.verificationJobId).toBeUndefined();
    });

    it("still reports an unknown bounty as not found", () => {
      expect(() => svc.verifyBounty("bounty-missing", "job-001", 0.9)).toThrow(/not found/);
    });
  });
  describe("pay bounty (retired: astra pack 36)", () => {
    it("refuses to pay: nothing funds a bounty", () => {
      const bounty = svc.createBounty({
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      });
      svc.claimBounty(bounty.id, "operator-001");
      expect(() => svc.payBounty(bounty.id)).toThrow(/payment is retired/);
      const after = svc.listBounties().find((b) => b.id === bounty.id)!;
      expect(after.status).toBe("claimed");
      expect(after.paidAt).toBeUndefined();
    });

    it("still reports an unknown bounty as not found", () => {
      expect(() => svc.payBounty("bounty-missing")).toThrow(/not found/);
    });
  });
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
    function claimOne(operatorId: string, capabilityType: string) {
      const b = svc.createBounty({ ...{
        capabilityType: "ebw",
        description: "EBW bounty",
        bountyReward: 2000,
        currency: "USDC",
        requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
        expiresInDays: 30,
      }, capabilityType });
      svc.claimBounty(b.id, operatorId);
      return b;
    }

    it("tracks claims and shows no earnings or completions: nothing is ever paid", () => {
      claimOne("operator-001", "ebw");
      claimOne("operator-001", "cryo-em");
      const [top] = svc.getLeaderboard();
      expect(top.operatorId).toBe("operator-001");
      expect(top.bountiesClaimed).toBe(2);
      expect(top.bountiesCompleted).toBe(0);
      expect(top.totalEarned).toBe(0);
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 3; i++) claimOne(`operator-${i}`, `cap-${i}`);
      expect(svc.getLeaderboard(2)).toHaveLength(2);
      for (const h of svc.getLeaderboard()) expect(h.totalEarned).toBe(0);
    });
  });
  describe("full lifecycle", () => {
    it("demand -> auto-bounty (demo opt-in) -> claim, then verification and payment are refused", () => {
      const demo = new BountyService({ autoCreateTreasuryBounties: true });
      demo.submitDemand(makeDemandInput({ requesterId: "r1", capabilityType: "cryo-em", estimatedJobValue: 500, estimatedFrequency: "monthly" }));
      demo.submitDemand(makeDemandInput({ requesterId: "r2", capabilityType: "cryo-em", estimatedJobValue: 800, estimatedFrequency: "monthly" }));
      demo.submitDemand(makeDemandInput({ requesterId: "r3", capabilityType: "cryo-em", estimatedJobValue: 300, estimatedFrequency: "weekly" }));
      const created = demo.checkAndCreateBounties();
      expect(created).toHaveLength(1);
      const bounty = created[0];
      expect(bounty.fundingStatus).toBe("unfunded");
      expect(bounty.proposedFundingSource).toBe("treasury");
      expect("fundedBy" in bounty).toBe(false);
      expect(demo.claimBounty(bounty.id, "operator-cryo").status).toBe("claimed");
      expect(() => demo.verifyBounty(bounty.id, "job-cryo-001", 0.92)).toThrow(/verification is retired/);
      expect(() => demo.payBounty(bounty.id)).toThrow(/payment is retired/);
      expect(demo.getLeaderboard()[0].totalEarned).toBe(0);
    });
  });
});

describe("pack 36 (astra) findings: an unfunded bounty is never verified by a caller or paid", () => {
  function claimed() {
    const s = new BountyService();
    const b = s.createBounty({
      capabilityType: "hplc",
      description: "Reusable HPLC kit",
      bountyReward: 100,
      currency: "USDC",
      requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
      expiresInDays: 30,
    });
    s.claimBounty(b.id, "operator-1");
    return { s, b };
  }

  it("HIGH 2: verifyBounty refuses a caller-supplied score, and the bounty stays claimed", () => {
    const { s, b } = claimed();
    expect(() => s.verifyBounty(b.id, "invented-job", 1)).toThrow(/verification is retired/);
    expect(s.listBounties().find((x) => x.id === b.id)!.status).toBe("claimed");
  });

  it("HIGH 1: payBounty refuses an unfunded bounty; nothing becomes paid and no earnings appear", () => {
    const { s, b } = claimed();
    expect(() => s.payBounty(b.id)).toThrow(/payment is retired/);
    const after = s.listBounties().find((x) => x.id === b.id)!;
    expect(after.status).not.toBe("paid");
    expect(after.paidAt).toBeUndefined();
    const hunter = s.getLeaderboard().find((h) => h.operatorId === "operator-1");
    expect(hunter?.totalEarned ?? 0).toBe(0);
    expect(hunter?.bountiesCompleted ?? 0).toBe(0);
  });

  it("a new bounty names no funder while nothing funds it", () => {
    const { b } = claimed();
    expect(b.fundingStatus).toBe("unfunded");
    expect("fundedBy" in b).toBe(false);
  });

  it("demand and bounty ids carry a full UUID after their prefix (test-gap note)", () => {
    const s = new BountyService();
    const sig = s.submitDemand(makeDemandInput());
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    expect(sig.id).toMatch(new RegExp(`^demand-${UUID}$`));
    const { b } = claimed();
    expect(b.id).toMatch(new RegExp(`^bounty-${UUID}$`));
  });
});

describe("pack 36b (astra): returned records are detached snapshots, so no caller can forge state", () => {
  it("mutating every returned object never changes a later read", () => {
    const s = new BountyService();
    const created = s.createBounty({
      capabilityType: "hplc",
      description: "HPLC kit",
      bountyReward: 100,
      currency: "USDC",
      requirements: { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true },
      expiresInDays: 30,
    });
    const claimedRec = s.claimBounty(created.id, "operator-1");
    const forge = (o: unknown, patch: Record<string, unknown>) => {
      try {
        Object.assign(o as object, patch);
      } catch {
        /* a frozen snapshot refusing the write is also fine */
      }
    };
    forge(created, { status: "paid", paidAt: "2026-01-01T00:00:00Z", fundingStatus: "funded" });
    forge(claimedRec, { status: "verified", verificationScore: 1, verificationJobId: "invented" });
    forge(s.listBounties()[0], { status: "paid", fundingStatus: "funded" });
    forge(s.getLeaderboard()[0], { totalEarned: 999, bountiesCompleted: 7 });
    const sig = s.submitDemand(makeDemandInput());
    forge(sig, { status: "fulfilled" });
    forge(s.getDemandSignals()[0], { status: "fulfilled" });

    const stored = s.listBounties().find((b) => b.id === created.id)!;
    expect(stored.status).toBe("claimed");
    expect(stored.fundingStatus).toBe("unfunded");
    expect("paidAt" in stored).toBe(false);
    expect("verificationScore" in stored).toBe(false);
    const hunter = s.getLeaderboard()[0]!;
    expect(hunter.totalEarned).toBe(0);
    expect(hunter.bountiesCompleted).toBe(0);
    expect(s.getDemandSignals()[0]!.status).toBe("active");
  });
});

describe("pack 36c (astra): stored state is runtime-private, so no holder of the service can forge it", () => {
  const REQ = { minimumAssuranceTier: 1, mustComplete1Job: true, mustPassVerification: true };
  function claimed() {
    const s = new BountyService();
    const b = s.createBounty({
      capabilityType: "hplc",
      description: "HPLC kit",
      bountyReward: 100,
      currency: "USDC",
      requirements: { ...REQ },
      expiresInDays: 30,
    });
    s.claimBounty(b.id, "operator-1");
    return { s, b };
  }
  const loose = (s: BountyService) => s as unknown as Record<string, unknown>;
  const tryAssign = (o: unknown, patch: Record<string, unknown>) => {
    try {
      Object.assign(o as object, patch);
    } catch {
      /* refused: also fine */
    }
  };

  it("HIGH 1: the stored maps are unreachable, by name or by enumeration; nothing becomes paid or funded, no earnings", () => {
    const { s, b } = claimed();
    // The verdict's reproduction: reach the maps by name ...
    const bounties = loose(s).bounties as Map<string, object> | undefined;
    const hunters = loose(s).hunters as Map<string, object> | undefined;
    if (bounties?.get(b.id)) tryAssign(bounties.get(b.id), { status: "paid", fundingStatus: "funded", paidAt: "2026-01-01T00:00:00Z" });
    if (hunters?.get("operator-1")) tryAssign(hunters.get("operator-1"), { totalEarned: 100, bountiesCompleted: 1 });
    // ... or discover them without names.
    for (const v of Object.values(loose(s))) {
      if (v instanceof Map) for (const rec of v.values()) tryAssign(rec, { status: "paid", fundingStatus: "funded", totalEarned: 100, bountiesCompleted: 1 });
    }
    expect(Object.values(loose(s)).some((v) => v instanceof Map)).toBe(false);
    const [after] = s.listBounties();
    expect(after).toMatchObject({ status: "claimed", fundingStatus: "unfunded" });
    expect("paidAt" in after!).toBe(false);
    expect(s.getLeaderboard()[0]).toMatchObject({ totalEarned: 0, bountiesCompleted: 0 });
  });

  it("HIGH 2: no runtime path sets verified, a verification job or a score", () => {
    const { s, b } = claimed();
    const bounties = loose(s).bounties as Map<string, object> | undefined;
    if (bounties?.get(b.id)) tryAssign(bounties.get(b.id), { status: "verified", verificationJobId: "invented", verificationScore: 1 });
    const [after] = s.listBounties();
    expect(after!.status).toBe("claimed");
    expect("verificationJobId" in after!).toBe(false);
    expect("verificationScore" in after!).toBe(false);
  });

  it("a holder of the shared instance cannot shadow its readers or add state", () => {
    const { s } = claimed();
    tryAssign(s, { listBounties: () => [{ status: "paid" }], getLeaderboard: () => [{ totalEarned: 100 }], extra: 1 });
    expect(s.listBounties()[0]!.status).toBe("claimed");
    expect(s.getLeaderboard()[0]!.totalEarned).toBe(0);
    expect(Object.keys(s)).toEqual([]);
    expect(Object.isFrozen(s)).toBe(true);
  });

  it("the treasury auto-bounty switch cannot be flipped on after construction", () => {
    const s = new BountyService();
    tryAssign(s, { autoCreateTreasuryBounties: true });
    for (const r of ["r1", "r2", "r3"]) {
      s.submitDemand(makeDemandInput({ requesterId: r, capabilityType: "ebw", estimatedJobValue: 5000, estimatedFrequency: "daily" }));
    }
    expect(s.checkAndCreateBounties()).toEqual([]);
    expect(s.listBounties()).toEqual([]);
  });

  it("inputs are copied on the way in: mutating a caller's object later changes nothing stored", () => {
    const s = new BountyService();
    const requirements = { ...REQ };
    s.createBounty({ capabilityType: "hplc", description: "d", bountyReward: 100, currency: "USDC", requirements, expiresInDays: 30 });
    requirements.mustPassVerification = false;
    requirements.minimumAssuranceTier = 0;
    expect(s.listBounties()[0]!.requirements).toEqual(REQ);
    // An out-of-schema nested value is copied too, never shared.
    const input = { ...makeDemandInput(), extra: { note: "a" } };
    s.submitDemand(input);
    input.extra.note = "b";
    expect((s.getDemandSignals()[0] as unknown as { extra?: { note: string } }).extra?.note).toBe("a");
  });
});
