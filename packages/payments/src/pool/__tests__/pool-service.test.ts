import { describe, it, expect, beforeEach } from "vitest";
import { PoolService } from "../pool-service.js";
import { BountyService } from "../../bounty/bounty-service.js";
import type { InvestmentPool } from "../types.js";

// ── Helpers ────────────────────────────────────────────────────────

function createOpenPool(svc: PoolService, overrides: Record<string, unknown> = {}): InvestmentPool {
  return svc.createPool({
    capabilityType: "cnc-milling",
    description: "5-axis CNC milling capability",
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("PoolService", () => {
  let svc: PoolService;

  beforeEach(() => {
    svc = new PoolService();
  });

  // ── Pool Creation ─────────────────────────────────────────────

  describe("createPool", () => {
    it("creates a pool with default config", () => {
      const pool = createOpenPool(svc);

      expect(pool.id).toMatch(/^pool-/);
      expect(pool.capabilityType).toBe("cnc-milling");
      expect(pool.description).toBe("5-axis CNC milling capability");
      expect(pool.status).toBe("open");
      expect(pool.totalStaked).toBe(0);
      expect(pool.stakes).toHaveLength(0);
      expect(pool.revenueShareBps).toBe(25);
      expect(pool.sunsetMultiplier).toBe(3);
      expect(pool.currency).toBe("USDC");
      expect(pool.distributions).toHaveLength(0);
      expect(pool.totalDistributed).toBe(0);
    });

    it("creates a pool with custom config", () => {
      const pool = svc.createPool({
        capabilityType: "sla-printing",
        description: "Resin SLA printing",
        targetAmount: 5000,
        currency: "CREDITS",
        revenueShareBps: 50,
        sunsetMultiplier: 5,
      });

      expect(pool.targetAmount).toBe(5000);
      expect(pool.currency).toBe("CREDITS");
      expect(pool.revenueShareBps).toBe(50);
      expect(pool.sunsetMultiplier).toBe(5);
    });
  });

  // ── Staking ───────────────────────────────────────────────────

  describe("stake", () => {
    it("adds a stake to an open pool and recalculates shares", () => {
      const pool = createOpenPool(svc);
      const stake = svc.stake(pool.id, "alice", 100);

      expect(stake.id).toMatch(/^stake-/);
      expect(stake.poolId).toBe(pool.id);
      expect(stake.staker).toBe("alice");
      expect(stake.amount).toBe(100);
      expect(stake.shareBps).toBe(10_000); // 100% of pool

      const updated = svc.getPool(pool.id)!;
      expect(updated.totalStaked).toBe(100);
      expect(updated.stakes).toHaveLength(1);
    });

    it("recalculates shares when multiple stakers join", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.stake(pool.id, "bob", 100);

      const updated = svc.getPool(pool.id)!;
      expect(updated.totalStaked).toBe(200);
      expect(updated.stakes[0].shareBps).toBe(5000); // alice 50%
      expect(updated.stakes[1].shareBps).toBe(5000); // bob 50%
    });

    it("handles 50/30/20 split correctly", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 500);
      svc.stake(pool.id, "bob", 300);
      svc.stake(pool.id, "charlie", 200);

      const updated = svc.getPool(pool.id)!;
      expect(updated.totalStaked).toBe(1000);
      expect(updated.stakes[0].shareBps).toBe(5000); // alice 50%
      expect(updated.stakes[1].shareBps).toBe(3000); // bob 30%
      expect(updated.stakes[2].shareBps).toBe(2000); // charlie 20%
    });

    it("enforces minimum stake amount", () => {
      const pool = createOpenPool(svc);
      expect(() => svc.stake(pool.id, "alice", 5)).toThrow(
        "Minimum stake amount is 10",
      );
    });

    it("rejects stake into non-existent pool", () => {
      expect(() => svc.stake("pool-9999", "alice", 100)).toThrow(
        "Pool pool-9999 not found",
      );
    });

    it("rejects stake into closed pool", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);

      expect(() => svc.stake(pool.id, "bob", 100)).toThrow(
        "not accepting stakes",
      );
    });
  });

  // ── Pool Closing ──────────────────────────────────────────────

  describe("closePool", () => {
    it("closes an open pool and sets status to funded", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      const closed = svc.closePool(pool.id);

      expect(closed.status).toBe("funded");
      expect(closed.fundedAt).toBeDefined();
    });

    it("rejects closing a non-open pool", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);

      expect(() => svc.closePool(pool.id)).toThrow("cannot be closed");
    });
  });

  // ── Operator Claiming ─────────────────────────────────────────

  describe("claimPool", () => {
    it("operator claims a funded pool", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);

      const claimed = svc.claimPool(pool.id, "operator-1");
      expect(claimed.operatorId).toBe("operator-1");
      // Pool stays funded until activated
      expect(claimed.status).toBe("funded");
    });

    it("rejects claiming a non-funded pool", () => {
      const pool = createOpenPool(svc);
      expect(() => svc.claimPool(pool.id, "operator-1")).toThrow(
        "cannot be claimed",
      );
    });
  });

  // ── Pool Activation ───────────────────────────────────────────

  describe("activatePool", () => {
    it("activates a funded pool with capability cert", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);

      const activated = svc.activatePool(pool.id, "cert-abc-123");
      expect(activated.status).toBe("active");
      expect(activated.capabilityCertId).toBe("cert-abc-123");
      expect(activated.activatedAt).toBeDefined();
    });

    it("rejects activating a non-funded pool", () => {
      const pool = createOpenPool(svc);
      expect(() => svc.activatePool(pool.id, "cert-1")).toThrow(
        "cannot be activated",
      );
    });
  });

  // ── Revenue Distribution ──────────────────────────────────────

  describe("distributeJobFee", () => {
    it("routes correct amount to active pool", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 1000);
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");

      // 25 bps of 10000 = 25
      const dist = svc.distributeJobFee("cnc-milling", "job-1", 10_000);

      expect(dist).not.toBeNull();
      expect(dist!.poolShare).toBe(25); // 10000 * 25 / 10000
      expect(dist!.distributions).toHaveLength(1);
      expect(dist!.distributions[0].staker).toBe("alice");
      expect(dist!.distributions[0].amount).toBe(25);
    });

    it("splits pro-rata among multiple stakers", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 500);
      svc.stake(pool.id, "bob", 300);
      svc.stake(pool.id, "charlie", 200);
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");

      const dist = svc.distributeJobFee("cnc-milling", "job-1", 100_000);

      expect(dist).not.toBeNull();
      // Pool share = 100000 * 25 / 10000 = 250
      expect(dist!.poolShare).toBe(250);

      // alice: 250 * 5000 / 10000 = 125
      expect(dist!.distributions[0].staker).toBe("alice");
      expect(dist!.distributions[0].amount).toBe(125);

      // bob: 250 * 3000 / 10000 = 75
      expect(dist!.distributions[1].staker).toBe("bob");
      expect(dist!.distributions[1].amount).toBe(75);

      // charlie: 250 * 2000 / 10000 = 50
      expect(dist!.distributions[2].staker).toBe("charlie");
      expect(dist!.distributions[2].amount).toBe(50);
    });

    it("accumulates multiple distributions correctly", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 1000);
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");

      svc.distributeJobFee("cnc-milling", "job-1", 10_000);
      svc.distributeJobFee("cnc-milling", "job-2", 20_000);

      const updated = svc.getPool(pool.id)!;
      // 10000*25/10000 + 20000*25/10000 = 25 + 50 = 75
      expect(updated.totalDistributed).toBe(75);
      expect(updated.distributions).toHaveLength(2);
    });

    it("returns null when no active pool for capability", () => {
      const result = svc.distributeJobFee("unknown-cap", "job-1", 10_000);
      expect(result).toBeNull();
    });

    it("returns null for pool with no stakes", () => {
      // Create a pool but don't stake anything, close and activate
      const pool = createOpenPool(svc);
      // We need to close and activate to make it active, but close requires open status
      // Since there are no stakes, the pool total is 0
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");

      const result = svc.distributeJobFee("cnc-milling", "job-1", 10_000);
      expect(result).toBeNull();
    });
  });

  // ── Auto-Sunset ───────────────────────────────────────────────

  describe("auto-sunset", () => {
    it("sunsets pool at 3x multiplier", () => {
      const svc2 = new PoolService({ defaultSunsetMultiplier: 3 });
      const pool = svc2.createPool({
        capabilityType: "cnc-milling",
        description: "test",
        revenueShareBps: 10_000, // 100% of fee goes to pool (for easy math)
      });
      svc2.stake(pool.id, "alice", 100);
      svc2.closePool(pool.id);
      svc2.activatePool(pool.id, "cert-1");

      // Need to accumulate 300 (100 * 3) in distributions
      // With 100% revenue share, each 100 fee gives 100 to pool
      svc2.distributeJobFee("cnc-milling", "job-1", 100);
      expect(svc2.getPool(pool.id)!.status).toBe("active");

      svc2.distributeJobFee("cnc-milling", "job-2", 100);
      expect(svc2.getPool(pool.id)!.status).toBe("active");

      svc2.distributeJobFee("cnc-milling", "job-3", 100);
      // 300 >= 100 * 3 → sunset
      expect(svc2.getPool(pool.id)!.status).toBe("sunset");
      expect(svc2.getPool(pool.id)!.sunsetAt).toBeDefined();
    });

    it("cannot distribute to sunset pool", () => {
      const svc2 = new PoolService({ defaultSunsetMultiplier: 1 });
      const pool = svc2.createPool({
        capabilityType: "cnc-milling",
        description: "test",
        revenueShareBps: 10_000,
      });
      svc2.stake(pool.id, "alice", 100);
      svc2.closePool(pool.id);
      svc2.activatePool(pool.id, "cert-1");

      // This should sunset: 100 >= 100 * 1
      svc2.distributeJobFee("cnc-milling", "job-1", 100);
      expect(svc2.getPool(pool.id)!.status).toBe("sunset");

      // Next distribution should find no active pool
      const result = svc2.distributeJobFee("cnc-milling", "job-2", 100);
      expect(result).toBeNull();
    });
  });

  // ── Pool Cancellation ─────────────────────────────────────────

  describe("cancelPool", () => {
    it("cancels an open pool", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      const cancelled = svc.cancelPool(pool.id);

      expect(cancelled.status).toBe("cancelled");
    });

    it("cancels a funded pool", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);
      const cancelled = svc.cancelPool(pool.id);

      expect(cancelled.status).toBe("cancelled");
    });

    it("cannot cancel an active pool", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");

      expect(() => svc.cancelPool(pool.id)).toThrow("cannot be cancelled");
    });

    it("cannot cancel a sunset pool", () => {
      const svc2 = new PoolService({ defaultSunsetMultiplier: 1 });
      const pool = svc2.createPool({
        capabilityType: "cnc-milling",
        description: "test",
        revenueShareBps: 10_000,
      });
      svc2.stake(pool.id, "alice", 100);
      svc2.closePool(pool.id);
      svc2.activatePool(pool.id, "cert-1");
      svc2.distributeJobFee("cnc-milling", "job-1", 100);

      expect(() => svc2.cancelPool(pool.id)).toThrow("cannot be cancelled");
    });
  });

  // ── Staker Earnings ───────────────────────────────────────────

  describe("getStakerEarnings", () => {
    it("aggregates earnings across pools", () => {
      // Pool 1: active
      const pool1 = svc.createPool({
        capabilityType: "cnc-milling",
        description: "CNC pool",
        revenueShareBps: 10_000,
      });
      svc.stake(pool1.id, "alice", 100);
      svc.closePool(pool1.id);
      svc.activatePool(pool1.id, "cert-1");
      svc.distributeJobFee("cnc-milling", "job-1", 50);

      // Pool 2: open (no earnings yet)
      const pool2 = svc.createPool({
        capabilityType: "sla-printing",
        description: "SLA pool",
      });
      svc.stake(pool2.id, "alice", 200);

      const earnings = svc.getStakerEarnings("alice");

      expect(earnings.staker).toBe("alice");
      expect(earnings.totalStaked).toBe(300);
      expect(earnings.totalEarned).toBe(50);
      expect(earnings.activePools).toBe(1);
      expect(earnings.roi).toBeCloseTo(50 / 300);
      expect(earnings.pools).toHaveLength(2);
    });

    it("returns zero earnings for unknown staker", () => {
      const earnings = svc.getStakerEarnings("unknown");

      expect(earnings.totalStaked).toBe(0);
      expect(earnings.totalEarned).toBe(0);
      expect(earnings.activePools).toBe(0);
      expect(earnings.sunsetPools).toBe(0);
      expect(earnings.roi).toBe(0);
      expect(earnings.pools).toHaveLength(0);
    });

    it("handles mixed pool statuses", () => {
      // Active pool
      const pool1 = svc.createPool({
        capabilityType: "cnc-milling",
        description: "CNC",
        revenueShareBps: 10_000,
      });
      svc.stake(pool1.id, "alice", 100);
      svc.closePool(pool1.id);
      svc.activatePool(pool1.id, "cert-1");

      // Sunset pool
      const svc2 = new PoolService({ defaultSunsetMultiplier: 1 });
      const pool2 = svc2.createPool({
        capabilityType: "sla-printing",
        description: "SLA",
        revenueShareBps: 10_000,
      });
      svc2.stake(pool2.id, "alice", 100);
      svc2.closePool(pool2.id);
      svc2.activatePool(pool2.id, "cert-2");
      svc2.distributeJobFee("sla-printing", "job-1", 100);

      const earnings2 = svc2.getStakerEarnings("alice");
      expect(earnings2.sunsetPools).toBe(1);
    });
  });

  // ── Pool ROI ──────────────────────────────────────────────────

  describe("getPoolROI", () => {
    it("calculates ROI correctly", () => {
      const pool = createOpenPool(svc, { revenueShareBps: 10_000 });
      svc.stake(pool.id, "alice", 1000);
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");
      svc.distributeJobFee("cnc-milling", "job-1", 500);

      const roi = svc.getPoolROI(pool.id);
      expect(roi).not.toBeNull();
      expect(roi!.totalStaked).toBe(1000);
      expect(roi!.totalDistributed).toBe(500);
      expect(roi!.roi).toBe(0.5);
    });

    it("returns null for non-existent pool", () => {
      expect(svc.getPoolROI("pool-9999")).toBeNull();
    });

    it("returns zero ROI for pool with no distributions", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");

      const roi = svc.getPoolROI(pool.id);
      expect(roi!.roi).toBe(0);
    });
  });

  // ── Bounty Integration ────────────────────────────────────────

  describe("createPoolFromBounty", () => {
    it("converts a bounty into an investment pool", () => {
      const bountyService = new BountyService();
      const bounty = bountyService.createBounty({
        capabilityType: "electron-beam-welding",
        description: "E-beam welding capability",
        bountyReward: 500,
        currency: "USDC",
        requirements: {
          minimumAssuranceTier: 1,
          mustComplete1Job: true,
          mustPassVerification: true,
        },
        expiresInDays: 90,
        fundedBy: "treasury",
      });

      const poolSvc = new PoolService({}, bountyService);
      const pool = poolSvc.createPoolFromBounty(bounty.id);

      expect(pool.capabilityType).toBe("electron-beam-welding");
      expect(pool.description).toBe("E-beam welding capability");
      expect(pool.currency).toBe("USDC");
      expect(pool.totalStaked).toBe(500); // bounty reward became treasury stake
      expect(pool.stakes).toHaveLength(1);
      expect(pool.stakes[0].staker).toBe("treasury");
      expect(pool.stakes[0].amount).toBe(500);
    });

    it("throws when bounty service not configured", () => {
      expect(() => svc.createPoolFromBounty("bounty-1")).toThrow(
        "BountyService not configured",
      );
    });

    it("throws when bounty not found", () => {
      const bountyService = new BountyService();
      const poolSvc = new PoolService({}, bountyService);
      expect(() => poolSvc.createPoolFromBounty("bounty-9999")).toThrow(
        "Bounty bounty-9999 not found",
      );
    });
  });

  // ── Query Methods ─────────────────────────────────────────────

  describe("listPools", () => {
    it("lists all pools", () => {
      createOpenPool(svc);
      svc.createPool({
        capabilityType: "sla-printing",
        description: "SLA",
      });

      expect(svc.listPools()).toHaveLength(2);
    });

    it("filters by status", () => {
      const pool1 = createOpenPool(svc);
      svc.createPool({
        capabilityType: "sla-printing",
        description: "SLA",
      });

      svc.stake(pool1.id, "alice", 100);
      svc.closePool(pool1.id);

      expect(svc.listPools({ status: "funded" })).toHaveLength(1);
      expect(svc.listPools({ status: "open" })).toHaveLength(1);
    });

    it("filters by capability type", () => {
      createOpenPool(svc);
      svc.createPool({
        capabilityType: "sla-printing",
        description: "SLA",
      });

      expect(
        svc.listPools({ capabilityType: "cnc-milling" }),
      ).toHaveLength(1);
    });
  });

  describe("getPoolByCapability", () => {
    it("returns active pool for capability", () => {
      const pool = createOpenPool(svc);
      svc.stake(pool.id, "alice", 100);
      svc.closePool(pool.id);
      svc.activatePool(pool.id, "cert-1");

      const found = svc.getPoolByCapability("cnc-milling");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(pool.id);
    });

    it("returns null when no active pool", () => {
      createOpenPool(svc); // open, not active
      expect(svc.getPoolByCapability("cnc-milling")).toBeNull();
    });
  });

  // ── Full Lifecycle ────────────────────────────────────────────

  describe("full lifecycle", () => {
    it("create -> stake -> close -> claim -> activate -> distribute -> sunset", () => {
      const poolSvc = new PoolService({
        defaultSunsetMultiplier: 2,
        defaultRevenueShareBps: 10_000, // 100% for easy math
      });

      // 1. Create
      const pool = poolSvc.createPool({
        capabilityType: "laser-cutting",
        description: "CO2 laser cutting",
      });
      expect(pool.status).toBe("open");

      // 2. Stake
      poolSvc.stake(pool.id, "alice", 600);
      poolSvc.stake(pool.id, "bob", 400);
      const staked = poolSvc.getPool(pool.id)!;
      expect(staked.totalStaked).toBe(1000);
      expect(staked.stakes[0].shareBps).toBe(6000);
      expect(staked.stakes[1].shareBps).toBe(4000);

      // 3. Close
      const closed = poolSvc.closePool(pool.id);
      expect(closed.status).toBe("funded");

      // 4. Claim
      const claimed = poolSvc.claimPool(pool.id, "operator-laser");
      expect(claimed.operatorId).toBe("operator-laser");

      // 5. Activate
      const activated = poolSvc.activatePool(pool.id, "cert-laser-001");
      expect(activated.status).toBe("active");
      expect(activated.capabilityCertId).toBe("cert-laser-001");

      // 6. Distribute (first job: fee = 1000)
      const dist1 = poolSvc.distributeJobFee("laser-cutting", "job-1", 1000);
      expect(dist1).not.toBeNull();
      expect(dist1!.poolShare).toBe(1000);
      // alice: 1000 * 6000/10000 = 600
      expect(dist1!.distributions[0].amount).toBe(600);
      // bob: 1000 * 4000/10000 = 400
      expect(dist1!.distributions[1].amount).toBe(400);

      // Still active (1000 < 1000 * 2)
      expect(poolSvc.getPool(pool.id)!.status).toBe("active");

      // 7. Another distribution to push past sunset
      const dist2 = poolSvc.distributeJobFee("laser-cutting", "job-2", 1000);
      expect(dist2).not.toBeNull();

      // 2000 >= 1000 * 2 → sunset
      const final = poolSvc.getPool(pool.id)!;
      expect(final.status).toBe("sunset");
      expect(final.totalDistributed).toBe(2000);
      expect(final.sunsetAt).toBeDefined();

      // Verify staker earnings
      const aliceEarnings = poolSvc.getStakerEarnings("alice");
      expect(aliceEarnings.totalStaked).toBe(600);
      expect(aliceEarnings.totalEarned).toBe(1200); // 600 + 600
      expect(aliceEarnings.sunsetPools).toBe(1);
      expect(aliceEarnings.roi).toBe(2); // 1200 / 600

      const bobEarnings = poolSvc.getStakerEarnings("bob");
      expect(bobEarnings.totalStaked).toBe(400);
      expect(bobEarnings.totalEarned).toBe(800); // 400 + 400
      expect(bobEarnings.roi).toBe(2); // 800 / 400
    });
  });
});
