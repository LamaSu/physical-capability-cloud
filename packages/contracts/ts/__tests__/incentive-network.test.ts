import { describe, it, expect, beforeEach } from "vitest";
import { IncentiveNetwork, type IncentiveConfig } from "../incentive-network.js";

describe("IncentiveNetwork", () => {
  let network: IncentiveNetwork;

  beforeEach(() => {
    network = new IncentiveNetwork({
      platformFeeBps: 150, // 1.5%
      feeToIncentiveRatio: 0.5,
      yieldToIncentiveRatio: 0.1,
      minPoolForDistribution: 100n, // Low for testing
      epochDurationSeconds: 0, // Immediate for testing
    });
  });

  describe("recordPlatformFee", () => {
    it("allocates correct portion to incentive pool", () => {
      // Settlement of $10,000 (10_000_000_000 atomic USDC)
      const incentive = network.recordPlatformFee(10_000_000_000n, "job-001");

      // Fee = 10B * 150 / 10000 = 150_000_000 ($150)
      // Incentive = $150 * 0.5 = $75
      expect(incentive).toBe(75_000_000n);

      const state = network.getPoolState();
      expect(state.balance).toBe(75_000_000n);
      expect(state.currentSources).toHaveLength(1);
      expect(state.currentSources[0]!.type).toBe("platform_fee");
    });
  });

  describe("recordYieldEarnings", () => {
    it("allocates correct portion to incentive pool", () => {
      const incentive = network.recordYieldEarnings(5_000_000n, "escrow-001"); // $5 yield

      // Incentive = $5 * 0.1 = $0.50
      expect(incentive).toBe(500_000n);
    });
  });

  describe("injectFunds", () => {
    it("adds funds directly to pool", () => {
      network.injectFunds(1_000_000_000n, "treasury_injection", "Q1 allocation");

      const state = network.getPoolState();
      expect(state.balance).toBe(1_000_000_000n);
      expect(state.currentSources[0]!.type).toBe("treasury_injection");
    });

    it("accepts grant funding", () => {
      network.injectFunds(500_000_000n, "grant", "Protocol Labs grant");

      const state = network.getPoolState();
      expect(state.balance).toBe(500_000_000n);
    });
  });

  describe("isEpochReady", () => {
    it("returns ready when pool meets minimum and duration elapsed", () => {
      network.injectFunds(1000n, "treasury_injection");
      const result = network.isEpochReady();
      expect(result.ready).toBe(true);
    });

    it("returns not ready when pool is below minimum", () => {
      network.injectFunds(50n, "treasury_injection");
      const result = network.isEpochReady();
      expect(result.ready).toBe(false);
      expect(result.reason).toContain("minimum");
    });
  });

  describe("executeEpoch", () => {
    it("distributes pool to operators based on scores", () => {
      network.injectFunds(10_000_000n, "treasury_injection"); // $10

      const result = network.executeEpoch([
        {
          kernelId: "k1",
          kernelDid: "did:pcc:k1",
          jobsCompleted: 10,
          qualityScore: 0.9,
          uptimePercent: 99,
          capabilityDiversity: 3,
          scarcityBonus: 0.5,
        },
        {
          kernelId: "k2",
          kernelDid: "did:pcc:k2",
          jobsCompleted: 5,
          qualityScore: 0.8,
          uptimePercent: 95,
          capabilityDiversity: 1,
          scarcityBonus: 0.2,
        },
      ]);

      expect(result.epochNumber).toBe(1);
      expect(result.totalDistributed).toBe(10_000_000n);
      expect(result.distributions).toHaveLength(2);

      // k1 should get more than k2 (higher scores in all dimensions)
      const k1 = result.distributions.find(d => d.kernelId === "k1")!;
      const k2 = result.distributions.find(d => d.kernelId === "k2")!;
      expect(parseFloat(k1.amount)).toBeGreaterThan(parseFloat(k2.amount));
    });

    it("resets pool after distribution", () => {
      network.injectFunds(10_000_000n, "treasury_injection");
      network.executeEpoch([{
        kernelId: "k1", kernelDid: "did:pcc:k1",
        jobsCompleted: 1, qualityScore: 1, uptimePercent: 100,
        capabilityDiversity: 1, scarcityBonus: 0,
      }]);

      const state = network.getPoolState();
      expect(state.balance).toBe(0n);
      expect(state.totalDistributed).toBe(10_000_000n);
      expect(state.epochsCompleted).toBe(1);
    });

    it("tracks cumulative stats across epochs", () => {
      // Epoch 1
      network.injectFunds(5_000_000n, "treasury_injection");
      network.executeEpoch([{
        kernelId: "k1", kernelDid: "did:pcc:k1",
        jobsCompleted: 1, qualityScore: 1, uptimePercent: 100,
        capabilityDiversity: 1, scarcityBonus: 0,
      }]);

      // Epoch 2
      network.injectFunds(15_000_000n, "treasury_injection");
      network.executeEpoch([{
        kernelId: "k1", kernelDid: "did:pcc:k1",
        jobsCompleted: 3, qualityScore: 0.95, uptimePercent: 99,
        capabilityDiversity: 2, scarcityBonus: 0.3,
      }]);

      const state = network.getPoolState();
      expect(state.epochsCompleted).toBe(2);
      expect(state.totalDistributed).toBe(20_000_000n);
      expect(state.avgDistributionPerEpoch).toBe(10_000_000n);
    });

    it("throws when epoch not ready", () => {
      // Pool too small
      network.injectFunds(10n, "treasury_injection");
      expect(() => network.executeEpoch([])).toThrow("not ready");
    });
  });

  describe("full flow: fees → yield → distribution", () => {
    it("accumulates from multiple sources then distributes", () => {
      // Accumulate from platform fees
      network.recordPlatformFee(2_000_000_000n); // $2000 settlement → ~$15 to pool
      network.recordPlatformFee(5_000_000_000n); // $5000 settlement → ~$37.5 to pool
      network.recordPlatformFee(3_000_000_000n); // $3000 settlement → ~$22.5 to pool

      // Add yield earnings
      network.recordYieldEarnings(10_000_000n); // $10 yield → $1 to pool

      const state = network.getPoolState();
      expect(state.currentSources).toHaveLength(4);
      expect(state.balance).toBeGreaterThan(0n);

      // Execute epoch
      const result = network.executeEpoch([
        {
          kernelId: "k1", kernelDid: "did:pcc:k1",
          jobsCompleted: 8, qualityScore: 0.92, uptimePercent: 99.5,
          capabilityDiversity: 3, scarcityBonus: 0.4,
        },
      ]);

      expect(result.distributions).toHaveLength(1);
      expect(parseFloat(result.distributions[0]!.amount)).toBeGreaterThan(0);
    });
  });
});
