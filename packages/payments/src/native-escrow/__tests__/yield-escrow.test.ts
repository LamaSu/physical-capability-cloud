import { describe, it, expect, beforeEach } from "vitest";
import { YieldEscrowService, type YieldConfig } from "../yield-escrow.js";

describe("YieldEscrowService", () => {
  let service: YieldEscrowService;

  beforeEach(() => {
    const config: YieldConfig = {
      strategy: "conservative",
      protocol: "aave-v3",
      chainId: 8453,
      protocolAddress: "0x1111111111111111111111111111111111111111",
      operatorYieldShare: 0.7,
    };
    service = new YieldEscrowService(config);
  });

  describe("deposit", () => {
    it("creates a yield position for an obligation", async () => {
      const position = await service.deposit("obl-001", 1_000_000_000n); // $1000 USDC

      expect(position.obligationId).toBe("obl-001");
      expect(position.principal).toBe(1_000_000_000n);
      expect(position.accruedYield).toBe(0n);
      expect(position.active).toBe(true);
      expect(position.strategy).toBe("conservative");
      expect(position.estimatedApyBps).toBe(350); // 3.5%
    });

    it("rejects duplicate deposits for same obligation", async () => {
      await service.deposit("obl-001", 1_000_000_000n);
      await expect(service.deposit("obl-001", 500_000_000n)).rejects.toThrow("already exists");
    });
  });

  describe("withdraw", () => {
    it("returns yield distribution with operator/user split", async () => {
      await service.deposit("obl-001", 1_000_000_000n);

      // Simulate passage of time by directly checking the distribution
      const distribution = await service.withdraw("obl-001");

      expect(distribution.totalYield).toBeGreaterThanOrEqual(0n);
      // operator gets 70%, user gets 30%
      expect(distribution.operatorShare + distribution.userShare).toBe(distribution.totalYield);
      expect(distribution.protocolFee).toBe(0n); // PCC doesn't take yield fees
      expect(distribution.durationSeconds).toBeGreaterThanOrEqual(0);
    });

    it("marks position as inactive after withdrawal", async () => {
      await service.deposit("obl-001", 1_000_000_000n);
      await service.withdraw("obl-001");

      const position = service.getPosition("obl-001");
      expect(position?.active).toBe(false);
      expect(position?.withdrawnAt).toBeDefined();
    });

    it("rejects withdrawal on non-existent position", async () => {
      await expect(service.withdraw("nonexistent")).rejects.toThrow("No yield position");
    });

    it("rejects double withdrawal", async () => {
      await service.deposit("obl-001", 1_000_000_000n);
      await service.withdraw("obl-001");
      await expect(service.withdraw("obl-001")).rejects.toThrow("already withdrawn");
    });
  });

  describe("getActivePositions", () => {
    it("returns only active positions", async () => {
      await service.deposit("obl-001", 1_000_000_000n);
      await service.deposit("obl-002", 500_000_000n);
      await service.withdraw("obl-001");

      const active = service.getActivePositions();
      expect(active).toHaveLength(1);
      expect(active[0]!.obligationId).toBe("obl-002");
    });
  });

  describe("getTotalValueLocked", () => {
    it("sums principal across all active positions", async () => {
      await service.deposit("obl-001", 1_000_000_000n);
      await service.deposit("obl-002", 500_000_000n);

      const tvl = service.getTotalValueLocked();
      expect(tvl.principal).toBe(1_500_000_000n);
      expect(tvl.total).toBeGreaterThanOrEqual(tvl.principal);
    });

    it("excludes withdrawn positions", async () => {
      await service.deposit("obl-001", 1_000_000_000n);
      await service.deposit("obl-002", 500_000_000n);
      await service.withdraw("obl-001");

      const tvl = service.getTotalValueLocked();
      expect(tvl.principal).toBe(500_000_000n);
    });
  });

  describe("moderate strategy", () => {
    it("has higher estimated APY than conservative", async () => {
      const moderateService = new YieldEscrowService({
        strategy: "moderate",
        protocol: "morpho",
        chainId: 8453,
        protocolAddress: "0x2222222222222222222222222222222222222222",
      });

      const conservativePos = await service.deposit("obl-c", 1_000_000_000n);
      const moderatePos = await moderateService.deposit("obl-m", 1_000_000_000n);

      expect(moderatePos.estimatedApyBps).toBeGreaterThan(conservativePos.estimatedApyBps);
    });
  });
});
