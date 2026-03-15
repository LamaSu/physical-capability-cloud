import { describe, it, expect, beforeEach } from "vitest";
import { DLMMClient } from "../meteora/dlmm-client.js";
import { CapabilityPoolManager } from "../meteora/capability-pool.js";
import type { DLMMPoolConfig, SwapQuote, PoolStats } from "../meteora/types.js";

// =============================================================================
// DLMMClient — low-level pool operations
// =============================================================================

describe("DLMMClient", () => {
  let client: DLMMClient;

  beforeEach(() => {
    client = new DLMMClient({ mock: true });
  });

  it("creates a pool with correct config", async () => {
    const pool = await client.createPool({
      capabilityType: "hplc_analysis",
      initialPrice: 65.0,
      binStep: 10,
      baseFee: 30,
      dynamicFee: true,
      initialLiquidityUsdc: 1000,
      seedBins: 10,
    });

    expect(pool.capabilityType).toBe("hplc_analysis");
    expect(pool.binStep).toBe(10);
    expect(pool.baseFee).toBe(30);
    expect(pool.dynamicFee).toBe(true);
    expect(pool.poolAddress).toBeTruthy();
    expect(pool.tokenXMint).toBeTruthy();
    expect(pool.tokenYMint).toBeTruthy();
  });

  it("retrieves pool by address", async () => {
    const created = await client.createPool({
      capabilityType: "fdm_printing",
      initialPrice: 0.5,
      initialLiquidityUsdc: 500,
    });

    const retrieved = await client.getPool(created.poolAddress);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.capabilityType).toBe("fdm_printing");
  });

  it("retrieves pool by capability type", async () => {
    await client.createPool({
      capabilityType: "cnc_machining",
      initialPrice: 15.0,
      initialLiquidityUsdc: 500,
    });

    const pool = await client.getPoolByCapability("cnc_machining");
    expect(pool).not.toBeNull();
    expect(pool!.capabilityType).toBe("cnc_machining");
  });

  it("lists all pools", async () => {
    await client.createPool({ capabilityType: "a", initialPrice: 1, initialLiquidityUsdc: 100 });
    await client.createPool({ capabilityType: "b", initialPrice: 2, initialLiquidityUsdc: 100 });

    const pools = await client.listPools();
    expect(pools.length).toBe(2);
  });

  it("returns current price near initial price", async () => {
    const pool = await client.createPool({
      capabilityType: "hplc_analysis",
      initialPrice: 65.0,
      binStep: 10,
      initialLiquidityUsdc: 1000,
    });

    const price = await client.getCurrentPrice(pool.poolAddress);
    // Price should be close to 65 (exact depends on bin quantization)
    expect(price).toBeGreaterThan(50);
    expect(price).toBeLessThan(80);
  });

  it("returns active bins around current price", async () => {
    const pool = await client.createPool({
      capabilityType: "fdm_printing",
      initialPrice: 0.5,
      binStep: 50,
      initialLiquidityUsdc: 500,
      seedBins: 10,
    });

    const bins = await client.getActiveBins(pool.poolAddress, 8);
    expect(bins.length).toBeGreaterThan(0);
    // At least some bins should have liquidity
    const withLiquidity = bins.filter((b) => b.amountX > 0n || b.amountY > 0n);
    expect(withLiquidity.length).toBeGreaterThan(0);
  });

  it("generates a swap quote for buying", async () => {
    const pool = await client.createPool({
      capabilityType: "hplc_analysis",
      initialPrice: 65.0,
      binStep: 10,
      baseFee: 30,
      initialLiquidityUsdc: 5000,
      seedBins: 10,
    });

    const quote = await client.quoteSwap(pool.poolAddress, 100_000_000n, "buy"); // $100
    expect(quote.amountIn).toBe(100_000_000n);
    expect(quote.amountOut).toBeGreaterThan(0n);
    expect(quote.fee).toBeGreaterThan(0n);
    expect(quote.priceImpact).toBeGreaterThanOrEqual(0);
    expect(quote.effectivePrice).toBeGreaterThan(0);
  });

  it("executes a swap and records history", async () => {
    const pool = await client.createPool({
      capabilityType: "fdm_printing",
      initialPrice: 0.5,
      binStep: 50,
      initialLiquidityUsdc: 1000,
      seedBins: 10,
    });

    const result = await client.executeSwap(pool.poolAddress, 10_000_000n, "buy", "trader123");
    expect(result.txSignature).toContain("mock_tx_");
    expect(result.amountOut).toBeGreaterThan(0n);

    const history = await client.getSwapHistory(pool.poolAddress);
    expect(history.length).toBe(1);
    expect(history[0].trader).toBe("trader123");
    expect(history[0].direction).toBe("buy");
  });

  it("adds liquidity and creates a position", async () => {
    const pool = await client.createPool({
      capabilityType: "sla_printing",
      initialPrice: 2.0,
      initialLiquidityUsdc: 500,
    });

    const position = await client.addLiquidity(
      {
        poolAddress: pool.poolAddress,
        amountX: 500_000_000n,  // $500 USDC
        amountY: 250_000_000n,  // 250 capability tokens
        strategy: "curve",
        binCount: 5,
      },
      "operator_abc",
    );

    expect(position.owner).toBe("operator_abc");
    expect(position.capabilityType).toBe("sla_printing");
    expect(position.depositedX).toBe(500_000_000n);
    expect(position.depositedY).toBe(250_000_000n);
    expect(position.positionAddress).toBeTruthy();
  });

  it("removes liquidity from a position", async () => {
    const pool = await client.createPool({
      capabilityType: "pcb_assembly",
      initialPrice: 8.0,
      initialLiquidityUsdc: 500,
    });

    const position = await client.addLiquidity(
      {
        poolAddress: pool.poolAddress,
        amountX: 100_000_000n,
        amountY: 50_000_000n,
        strategy: "spot",
      },
      "operator_xyz",
    );

    const result = await client.removeLiquidity({
      positionAddress: position.positionAddress,
      fraction: 0.5,
    });

    expect(result.amountX).toBe(50_000_000n);
    expect(result.amountY).toBe(25_000_000n);
  });

  it("gets positions for an owner", async () => {
    const pool = await client.createPool({
      capabilityType: "laser_cutting",
      initialPrice: 5.0,
      initialLiquidityUsdc: 300,
    });

    await client.addLiquidity(
      { poolAddress: pool.poolAddress, amountX: 100_000_000n, amountY: 50_000_000n, strategy: "spot" },
      "operator_1",
    );
    await client.addLiquidity(
      { poolAddress: pool.poolAddress, amountX: 200_000_000n, amountY: 100_000_000n, strategy: "spot" },
      "operator_1",
    );
    await client.addLiquidity(
      { poolAddress: pool.poolAddress, amountX: 50_000_000n, amountY: 25_000_000n, strategy: "spot" },
      "operator_2",
    );

    const positions = await client.getPositions("operator_1");
    expect(positions.length).toBe(2);
  });

  it("returns pool statistics", async () => {
    const pool = await client.createPool({
      capabilityType: "mass_spectrometry",
      initialPrice: 120.0,
      binStep: 10,
      initialLiquidityUsdc: 2000,
      seedBins: 10,
    });

    // Execute a swap to generate volume
    await client.executeSwap(pool.poolAddress, 50_000_000n, "buy", "trader1");

    const stats = await client.getPoolStats(pool.poolAddress);
    expect(stats.capabilityType).toBe("mass_spectrometry");
    expect(stats.currentPrice).toBeGreaterThan(0);
    expect(stats.tvl).toBeGreaterThan(0);
    expect(stats.volume24h).toBeGreaterThan(0);
    expect(stats.fees24h).toBeGreaterThan(0);
  });
});

// =============================================================================
// CapabilityPoolManager — high-level PCC integration
// =============================================================================

describe("CapabilityPoolManager", () => {
  let manager: CapabilityPoolManager;

  beforeEach(() => {
    manager = new CapabilityPoolManager({ mock: true, defaultLiquidity: 500 });
  });

  it("initializes default pools for all capability types", async () => {
    const pools = await manager.initializeDefaultPools();
    expect(pools.length).toBe(10); // 10 default capability types
    const types = pools.map((p) => p.capabilityType);
    expect(types).toContain("hplc_analysis");
    expect(types).toContain("fdm_printing");
    expect(types).toContain("cnc_machining");
    expect(types).toContain("mass_spectrometry");
  });

  it("does not duplicate pools on re-initialization", async () => {
    await manager.initializeDefaultPools();
    const pools2 = await manager.initializeDefaultPools();
    expect(pools2.length).toBe(10);
  });

  it("ensures a pool exists for a capability type", async () => {
    const pool = await manager.ensurePool("fdm_printing");
    expect(pool.capabilityType).toBe("fdm_printing");

    // Second call returns same pool
    const pool2 = await manager.ensurePool("fdm_printing");
    expect(pool2.poolAddress).toBe(pool.poolAddress);
  });

  it("creates pool for unknown capability type with custom price", async () => {
    const pool = await manager.ensurePool("electron_beam_welding", 250.0);
    expect(pool.capabilityType).toBe("electron_beam_welding");
  });

  it("returns market price for a capability", async () => {
    await manager.initializeDefaultPools();
    const price = await manager.getMarketPrice("hplc_analysis");
    expect(price).not.toBeNull();
    expect(price!).toBeGreaterThan(50);
    expect(price!).toBeLessThan(80);
  });

  it("returns all market prices", async () => {
    await manager.initializeDefaultPools();
    const prices = await manager.getAllPrices();
    expect(Object.keys(prices).length).toBe(10);
    expect(prices.hplc_analysis).toBeGreaterThan(0);
    expect(prices.fdm_printing).toBeGreaterThan(0);
  });

  it("quotes a buy for capability", async () => {
    await manager.initializeDefaultPools();
    const quote = await manager.quoteBuy("hplc_analysis", 100); // $100 USDC
    expect(quote).not.toBeNull();
    expect(quote!.amountOut).toBeGreaterThan(0n);
  });

  it("operator deposits liquidity", async () => {
    await manager.initializeDefaultPools();
    const position = await manager.operatorDeposit(
      "fdm_printing",
      500,     // $500 USDC
      1000,    // 1000 capability tokens
      "operator_wallet_123",
      "curve",
    );

    expect(position.owner).toBe("operator_wallet_123");
    expect(position.capabilityType).toBe("fdm_printing");
  });

  it("operator withdraws liquidity", async () => {
    await manager.initializeDefaultPools();
    const position = await manager.operatorDeposit("cnc_machining", 200, 50, "op1");
    const result = await manager.operatorWithdraw(position.positionAddress, 1.0);
    expect(result.usdcReturned).toBeGreaterThan(0);
  });

  it("gets operator positions across pools", async () => {
    await manager.initializeDefaultPools();
    await manager.operatorDeposit("fdm_printing", 100, 200, "multi_op");
    await manager.operatorDeposit("hplc_analysis", 300, 5, "multi_op");

    const positions = await manager.getOperatorPositions("multi_op");
    expect(positions.length).toBe(2);
  });

  it("requester buys capability via swap", async () => {
    await manager.initializeDefaultPools();
    const result = await manager.requesterBuy("fdm_printing", 10, "requester_abc");
    expect(result.txSignature).toContain("mock_tx_");
    expect(result.amountOut).toBeGreaterThan(0n);
  });

  it("returns pool stats for all pools", async () => {
    await manager.initializeDefaultPools();
    const stats = await manager.getAllPoolStats();
    expect(stats.length).toBe(10);
    for (const s of stats) {
      expect(s.currentPrice).toBeGreaterThan(0);
      expect(s.tvl).toBeGreaterThan(0);
    }
  });

  it("returns pool stats for a specific capability", async () => {
    await manager.initializeDefaultPools();
    const stats = await manager.getPoolStats("hplc_analysis");
    expect(stats).not.toBeNull();
    expect(stats!.capabilityType).toBe("hplc_analysis");
  });
});
