/**
 * Capability Pool Manager — PCC-specific DLMM pool orchestration.
 *
 * Maps PCC capability types to Meteora DLMM pools. Handles:
 * - Pool creation with sensible defaults per capability type
 * - Dynamic pricing (current market rate from DLMM bin)
 * - Operator liquidity provisioning (supply-side)
 * - Requester swaps (demand-side)
 * - Price feeds for the contract builder
 */

import { DLMMClient, type DLMMClientConfig } from "./dlmm-client.js";
import type {
  DLMMPoolConfig,
  PoolStats,
  SwapQuote,
  LiquidityPosition,
} from "./types.js";

/** Default pricing per capability type (USDC per unit) */
const DEFAULT_PRICES: Record<string, number> = {
  fdm_printing: 0.50,        // per gram
  sla_printing: 2.00,        // per gram
  cnc_machining: 15.00,      // per hour
  laser_cutting: 5.00,       // per minute
  hplc_analysis: 65.00,      // per run
  mass_spectrometry: 120.00, // per sample
  pcb_assembly: 8.00,        // per board
  injection_molding: 25.00,  // per shot
  pcr_amplification: 35.00,  // per run
  confocal_imaging: 45.00,   // per session
};

/** Default bin steps per capability type (basis points) */
const DEFAULT_BIN_STEPS: Record<string, number> = {
  fdm_printing: 50,       // 0.5% — low-value, wider steps
  sla_printing: 25,       // 0.25% — standard
  cnc_machining: 25,
  laser_cutting: 50,
  hplc_analysis: 10,      // 0.1% — high precision pricing
  mass_spectrometry: 10,
  pcb_assembly: 25,
  injection_molding: 25,
  pcr_amplification: 25,
  confocal_imaging: 25,
};

export interface CapabilityPoolManagerConfig extends DLMMClientConfig {
  /** Initial USDC liquidity per pool (default: $1000) */
  defaultLiquidity?: number;
}

/**
 * Manages DLMM pools for PCC capabilities.
 *
 * Each capability type gets one pool. The active bin's price is the
 * current market rate. Operators add liquidity to earn fees.
 * Requesters pay market rate or better.
 */
export class CapabilityPoolManager {
  private client: DLMMClient;
  private defaultLiquidity: number;
  /** Maps capability type → pool address for fast lookup */
  private capabilityPools: Map<string, string> = new Map();

  constructor(config: CapabilityPoolManagerConfig = {}) {
    this.client = new DLMMClient(config);
    this.defaultLiquidity = config.defaultLiquidity ?? 1000;
  }

  /** Initialize pools for known capability types */
  async initializeDefaultPools(): Promise<DLMMPoolConfig[]> {
    const pools: DLMMPoolConfig[] = [];

    for (const [capType, price] of Object.entries(DEFAULT_PRICES)) {
      const existing = await this.client.getPoolByCapability(capType);
      if (existing) {
        this.capabilityPools.set(capType, existing.poolAddress);
        pools.push(existing);
        continue;
      }

      const pool = await this.client.createPool({
        capabilityType: capType,
        initialPrice: price,
        binStep: DEFAULT_BIN_STEPS[capType] ?? 25,
        baseFee: 30,
        dynamicFee: true,
        initialLiquidityUsdc: this.defaultLiquidity,
        seedBins: 10,
      });

      this.capabilityPools.set(capType, pool.poolAddress);
      pools.push(pool);
    }

    return pools;
  }

  /** Get or create a pool for a capability type */
  async ensurePool(capabilityType: string, initialPrice?: number): Promise<DLMMPoolConfig> {
    const existing = this.capabilityPools.get(capabilityType);
    if (existing) {
      const pool = await this.client.getPool(existing);
      if (pool) return pool;
    }

    const pool = await this.client.createPool({
      capabilityType,
      initialPrice: initialPrice ?? DEFAULT_PRICES[capabilityType] ?? 10.0,
      binStep: DEFAULT_BIN_STEPS[capabilityType] ?? 25,
      baseFee: 30,
      dynamicFee: true,
      initialLiquidityUsdc: this.defaultLiquidity,
      seedBins: 10,
    });

    this.capabilityPools.set(capabilityType, pool.poolAddress);
    return pool;
  }

  // ---------------------------------------------------------------------------
  // Pricing — used by contract builder and agent quotes
  // ---------------------------------------------------------------------------

  /** Get current market price for a capability type */
  async getMarketPrice(capabilityType: string): Promise<number | null> {
    const addr = this.capabilityPools.get(capabilityType);
    if (!addr) return DEFAULT_PRICES[capabilityType] ?? null;
    return this.client.getCurrentPrice(addr);
  }

  /** Get a swap quote (how much capability can X USDC buy?) */
  async quoteBuy(capabilityType: string, usdcAmount: number): Promise<SwapQuote | null> {
    const addr = this.capabilityPools.get(capabilityType);
    if (!addr) return null;
    return this.client.quoteSwap(addr, BigInt(Math.floor(usdcAmount * 1e6)), "buy");
  }

  /** Get all market prices at once (for dashboard) */
  async getAllPrices(): Promise<Record<string, number>> {
    const prices: Record<string, number> = {};
    for (const [capType, addr] of this.capabilityPools) {
      try {
        prices[capType] = await this.client.getCurrentPrice(addr);
      } catch {
        prices[capType] = DEFAULT_PRICES[capType] ?? 0;
      }
    }
    return prices;
  }

  // ---------------------------------------------------------------------------
  // Operator liquidity (supply side)
  // ---------------------------------------------------------------------------

  /** Operator adds liquidity to a capability pool (earns fees) */
  async operatorDeposit(
    capabilityType: string,
    usdcAmount: number,
    capabilityTokenAmount: number,
    operatorAddress: string,
    strategy: "spot" | "curve" | "bid_ask" = "curve",
  ): Promise<LiquidityPosition> {
    const pool = await this.ensurePool(capabilityType);
    return this.client.addLiquidity(
      {
        poolAddress: pool.poolAddress,
        amountX: BigInt(Math.floor(usdcAmount * 1e6)),
        amountY: BigInt(Math.floor(capabilityTokenAmount * 1e6)),
        strategy,
        binCount: 5,
      },
      operatorAddress,
    );
  }

  /** Operator withdraws liquidity */
  async operatorWithdraw(
    positionAddress: string,
    fraction = 1,
  ): Promise<{ usdcReturned: number; tokensReturned: number }> {
    const result = await this.client.removeLiquidity({ positionAddress, fraction });
    return {
      usdcReturned: Number(result.amountX) / 1e6,
      tokensReturned: Number(result.amountY) / 1e6,
    };
  }

  /** Get operator's positions across all pools */
  async getOperatorPositions(operatorAddress: string): Promise<LiquidityPosition[]> {
    return this.client.getPositions(operatorAddress);
  }

  // ---------------------------------------------------------------------------
  // Requester swaps (demand side)
  // ---------------------------------------------------------------------------

  /** Requester buys capability (swaps USDC → capability tokens) */
  async requesterBuy(
    capabilityType: string,
    usdcAmount: number,
    requesterAddress: string,
  ): Promise<SwapQuote & { txSignature: string }> {
    const pool = await this.ensurePool(capabilityType);
    return this.client.executeSwap(
      pool.poolAddress,
      BigInt(Math.floor(usdcAmount * 1e6)),
      "buy",
      requesterAddress,
    );
  }

  // ---------------------------------------------------------------------------
  // Analytics
  // ---------------------------------------------------------------------------

  /** Get stats for all pools (dashboard overview) */
  async getAllPoolStats(): Promise<PoolStats[]> {
    const stats: PoolStats[] = [];
    for (const addr of this.capabilityPools.values()) {
      try {
        stats.push(await this.client.getPoolStats(addr));
      } catch { /* skip dead pools */ }
    }
    return stats;
  }

  /** Get stats for a specific capability's pool */
  async getPoolStats(capabilityType: string): Promise<PoolStats | null> {
    const addr = this.capabilityPools.get(capabilityType);
    if (!addr) return null;
    return this.client.getPoolStats(addr);
  }

  /** Underlying DLMM client for advanced usage */
  get dlmmClient(): DLMMClient {
    return this.client;
  }
}
