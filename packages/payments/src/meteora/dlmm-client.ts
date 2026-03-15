/**
 * Meteora DLMM Client — interfaces with Meteora's Dynamic Liquidity Market Maker.
 *
 * In production, calls the @meteora-ag/dlmm SDK against Solana devnet/mainnet.
 * In mock mode (default), simulates DLMM bin mechanics locally for testing.
 *
 * Bins are discrete price points. Each bin has a price = (1 + binStep/10000)^binId.
 * Liquidity is concentrated in bins; swaps walk across bins consuming liquidity.
 */

import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import type {
  DLMMPoolConfig,
  PriceBin,
  LiquidityPosition,
  SwapQuote,
  PoolStats,
  SwapEvent,
  CreatePoolParams,
  AddLiquidityParams,
  RemoveLiquidityParams,
} from "./types.js";

/** Solana devnet USDC mint (Circle) */
const SOLANA_DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface DLMMClientConfig {
  /** Solana RPC URL */
  rpcUrl?: string;
  /** Use mock mode (default: true) */
  mock?: boolean;
}

interface MockPool {
  config: DLMMPoolConfig;
  bins: Map<number, { amountX: number; amountY: number }>;
  activeBinId: number;
  positions: Map<string, LiquidityPosition>;
  swapHistory: SwapEvent[];
  volume24h: number;
  fees24h: number;
}

/**
 * Client for Meteora DLMM pools.
 *
 * Each capability type gets its own DLMM pool. The pool's active bin
 * determines the current market price for that capability.
 */
export class DLMMClient {
  private connection: Connection;
  private mock: boolean;
  private pools: Map<string, MockPool> = new Map();

  constructor(config: DLMMClientConfig = {}) {
    this.connection = new Connection(
      config.rpcUrl ?? "https://api.devnet.solana.com",
      "confirmed",
    );
    this.mock = config.mock ?? true;
  }

  // ---------------------------------------------------------------------------
  // Pool lifecycle
  // ---------------------------------------------------------------------------

  /** Create a new DLMM pool for a capability type */
  async createPool(params: CreatePoolParams): Promise<DLMMPoolConfig> {
    const binStep = params.binStep ?? 25;
    const baseFee = params.baseFee ?? 30;
    const seedBins = params.seedBins ?? 10;

    // Calculate active bin ID from initial price
    // price = (1 + binStep/10000) ^ binId  →  binId = ln(price) / ln(1 + binStep/10000)
    const activeBinId = Math.round(
      Math.log(params.initialPrice) / Math.log(1 + binStep / 10000),
    );

    const poolAddress = this.mock
      ? Keypair.generate().publicKey.toBase58()
      : /* TODO: real DLMM pool creation via @meteora-ag/dlmm */ "";

    const tokenYMint = this.mock
      ? Keypair.generate().publicKey.toBase58()
      : /* TODO: real capability token mint */ "";

    const config: DLMMPoolConfig = {
      poolAddress,
      capabilityType: params.capabilityType,
      tokenXMint: SOLANA_DEVNET_USDC_MINT,
      tokenYMint,
      binStep,
      baseFee,
      dynamicFee: params.dynamicFee ?? true,
    };

    if (this.mock) {
      // Seed bins around the active price
      const bins = new Map<number, { amountX: number; amountY: number }>();
      const perBin = params.initialLiquidityUsdc / seedBins;

      for (let i = -Math.floor(seedBins / 2); i <= Math.floor(seedBins / 2); i++) {
        const binId = activeBinId + i;
        const price = Math.pow(1 + binStep / 10000, binId);
        // Bins below active price hold USDC (bids), bins above hold capability tokens (asks)
        if (i <= 0) {
          bins.set(binId, { amountX: perBin * 1e6, amountY: 0 });
        } else {
          bins.set(binId, { amountX: 0, amountY: (perBin / price) * 1e6 });
        }
      }

      this.pools.set(poolAddress, {
        config,
        bins,
        activeBinId,
        positions: new Map(),
        swapHistory: [],
        volume24h: 0,
        fees24h: 0,
      });
    }

    return config;
  }

  /** Get pool configuration */
  async getPool(poolAddress: string): Promise<DLMMPoolConfig | null> {
    const pool = this.pools.get(poolAddress);
    return pool?.config ?? null;
  }

  /** Get pool by capability type */
  async getPoolByCapability(capabilityType: string): Promise<DLMMPoolConfig | null> {
    for (const pool of this.pools.values()) {
      if (pool.config.capabilityType === capabilityType) return pool.config;
    }
    return null;
  }

  /** List all pools */
  async listPools(): Promise<DLMMPoolConfig[]> {
    return Array.from(this.pools.values()).map((p) => p.config);
  }

  // ---------------------------------------------------------------------------
  // Price & bins
  // ---------------------------------------------------------------------------

  /** Get the current market price for a capability */
  async getCurrentPrice(poolAddress: string): Promise<number> {
    const pool = this.pools.get(poolAddress);
    if (!pool) throw new Error(`Pool not found: ${poolAddress}`);
    return Math.pow(1 + pool.config.binStep / 10000, pool.activeBinId);
  }

  /** Get active bins around the current price */
  async getActiveBins(poolAddress: string, count = 10): Promise<PriceBin[]> {
    const pool = this.pools.get(poolAddress);
    if (!pool) throw new Error(`Pool not found: ${poolAddress}`);

    const result: PriceBin[] = [];
    const halfCount = Math.floor(count / 2);
    let totalLiquidity = 0;

    // First pass: sum total liquidity
    for (const [, bin] of pool.bins) {
      totalLiquidity += bin.amountX + bin.amountY;
    }

    // Second pass: build bin array
    for (let i = -halfCount; i <= halfCount; i++) {
      const binId = pool.activeBinId + i;
      const bin = pool.bins.get(binId);
      const price = Math.pow(1 + pool.config.binStep / 10000, binId);
      const amountX = bin?.amountX ?? 0;
      const amountY = bin?.amountY ?? 0;
      const liquidityShare = totalLiquidity > 0
        ? (amountX + amountY) / totalLiquidity
        : 0;

      result.push({
        binId,
        amountX: BigInt(Math.floor(amountX)),
        amountY: BigInt(Math.floor(amountY)),
        price,
        liquidityShare,
      });
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Swaps (buy/sell capability)
  // ---------------------------------------------------------------------------

  /** Get a quote for swapping USDC → capability tokens (buying capability) */
  async quoteSwap(
    poolAddress: string,
    amountIn: bigint,
    direction: "buy" | "sell",
  ): Promise<SwapQuote> {
    const pool = this.pools.get(poolAddress);
    if (!pool) throw new Error(`Pool not found: ${poolAddress}`);

    let remaining = Number(amountIn);
    let totalOut = 0;
    let totalFee = 0;
    let binsCrossed = 0;
    let currentBin = pool.activeBinId;

    const step = direction === "buy" ? 1 : -1;

    while (remaining > 0) {
      const bin = pool.bins.get(currentBin);
      const price = Math.pow(1 + pool.config.binStep / 10000, currentBin);

      // Calculate fee
      const feeRate = pool.config.baseFee / 10000;
      const fee = remaining * feeRate;
      const afterFee = remaining - fee;

      if (direction === "buy") {
        // Consuming capability tokens (amountY) from this bin
        const available = bin?.amountY ?? 0;
        if (available <= 0) {
          currentBin += step;
          binsCrossed++;
          if (binsCrossed > 50) break; // Safety limit
          continue;
        }
        const canBuy = afterFee / price; // capability units we can get
        const bought = Math.min(canBuy, available / 1e6) * 1e6;
        const spent = (bought / 1e6) * price * 1e6;

        totalOut += bought;
        totalFee += fee;
        remaining -= spent + fee;
      } else {
        // Selling capability tokens → receiving USDC
        const available = bin?.amountX ?? 0;
        if (available <= 0) {
          currentBin += step;
          binsCrossed++;
          if (binsCrossed > 50) break;
          continue;
        }
        const usdcOut = Math.min(afterFee * price, available);
        totalOut += usdcOut;
        totalFee += fee;
        remaining -= afterFee;
      }

      currentBin += step;
      binsCrossed++;
      if (binsCrossed > 50) break;
    }

    const startPrice = Math.pow(1 + pool.config.binStep / 10000, pool.activeBinId);
    const effectivePrice = totalOut > 0 ? Number(amountIn) / totalOut : startPrice;
    const priceImpact = Math.abs(effectivePrice - startPrice) / startPrice;

    return {
      amountIn,
      amountOut: BigInt(Math.floor(totalOut)),
      priceImpact,
      fee: BigInt(Math.floor(totalFee)),
      binsCrossed,
      effectivePrice,
    };
  }

  /** Execute a swap */
  async executeSwap(
    poolAddress: string,
    amountIn: bigint,
    direction: "buy" | "sell",
    trader: string,
  ): Promise<SwapQuote & { txSignature: string }> {
    const quote = await this.quoteSwap(poolAddress, amountIn, direction);
    const pool = this.pools.get(poolAddress)!;

    // In mock mode, update bin liquidity
    if (this.mock) {
      const price = await this.getCurrentPrice(poolAddress);

      const event: SwapEvent = {
        poolAddress,
        capabilityType: pool.config.capabilityType,
        direction,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        price,
        trader,
        timestamp: Date.now(),
      };

      pool.swapHistory.push(event);
      pool.volume24h += Number(amountIn) / 1e6;
      pool.fees24h += Number(quote.fee) / 1e6;
    }

    const txSignature = this.mock
      ? `mock_tx_${Date.now().toString(36)}`
      : /* TODO: real DLMM swap via @meteora-ag/dlmm */ "";

    return { ...quote, txSignature };
  }

  // ---------------------------------------------------------------------------
  // Liquidity management
  // ---------------------------------------------------------------------------

  /** Add liquidity to a pool */
  async addLiquidity(
    params: AddLiquidityParams,
    owner: string,
  ): Promise<LiquidityPosition> {
    const pool = this.pools.get(params.poolAddress);
    if (!pool) throw new Error(`Pool not found: ${params.poolAddress}`);

    const binCount = params.binCount ?? 5;
    const half = Math.floor(binCount / 2);
    const perBinX = Number(params.amountX) / binCount;
    const perBinY = Number(params.amountY) / binCount;

    // Distribute across bins based on strategy
    for (let i = -half; i <= half; i++) {
      let binId: number;
      switch (params.strategy) {
        case "spot":
          binId = pool.activeBinId + i;
          break;
        case "curve":
          // Concentrate more in center bins
          binId = pool.activeBinId + i;
          break;
        case "bid_ask":
          // Bids below, asks above
          binId = pool.activeBinId + (i < 0 ? i * 2 : i * 2);
          break;
        default:
          binId = pool.activeBinId + i;
      }

      const existing = pool.bins.get(binId) ?? { amountX: 0, amountY: 0 };
      let xAdd = perBinX;
      let yAdd = perBinY;

      if (params.strategy === "curve") {
        // Bell curve weighting
        const weight = Math.exp(-(i * i) / (2 * (half / 2) * (half / 2)));
        xAdd = perBinX * weight * 2;
        yAdd = perBinY * weight * 2;
      }

      pool.bins.set(binId, {
        amountX: existing.amountX + xAdd,
        amountY: existing.amountY + yAdd,
      });
    }

    const positionAddress = this.mock
      ? Keypair.generate().publicKey.toBase58()
      : "";

    const position: LiquidityPosition = {
      positionAddress,
      owner,
      poolAddress: params.poolAddress,
      capabilityType: pool.config.capabilityType,
      lowerBinId: pool.activeBinId - half,
      upperBinId: pool.activeBinId + half,
      depositedX: params.amountX,
      depositedY: params.amountY,
      unclaimedFeesX: 0n,
      unclaimedFeesY: 0n,
      lastUpdated: Date.now(),
    };

    pool.positions.set(positionAddress, position);
    return position;
  }

  /** Remove liquidity from a position */
  async removeLiquidity(params: RemoveLiquidityParams): Promise<{ amountX: bigint; amountY: bigint }> {
    // Find the position across all pools
    for (const pool of this.pools.values()) {
      const position = pool.positions.get(params.positionAddress);
      if (!position) continue;

      const returnX = BigInt(Math.floor(Number(position.depositedX) * params.fraction));
      const returnY = BigInt(Math.floor(Number(position.depositedY) * params.fraction));

      if (params.fraction >= 1) {
        pool.positions.delete(params.positionAddress);
      } else {
        position.depositedX -= returnX;
        position.depositedY -= returnY;
        position.lastUpdated = Date.now();
      }

      return { amountX: returnX + position.unclaimedFeesX, amountY: returnY + position.unclaimedFeesY };
    }

    throw new Error(`Position not found: ${params.positionAddress}`);
  }

  /** Get positions for an owner across all pools */
  async getPositions(owner: string): Promise<LiquidityPosition[]> {
    const result: LiquidityPosition[] = [];
    for (const pool of this.pools.values()) {
      for (const pos of pool.positions.values()) {
        if (pos.owner === owner) result.push(pos);
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Analytics
  // ---------------------------------------------------------------------------

  /** Get pool statistics */
  async getPoolStats(poolAddress: string): Promise<PoolStats> {
    const pool = this.pools.get(poolAddress);
    if (!pool) throw new Error(`Pool not found: ${poolAddress}`);

    let tvl = 0;
    for (const [binId, bin] of pool.bins) {
      const price = Math.pow(1 + pool.config.binStep / 10000, binId);
      tvl += bin.amountX / 1e6 + (bin.amountY / 1e6) * price;
    }

    const currentPrice = Math.pow(1 + pool.config.binStep / 10000, pool.activeBinId);

    // Calculate 24h price change from swap history
    const dayAgo = Date.now() - 86400_000;
    const recentSwaps = pool.swapHistory.filter((s) => s.timestamp > dayAgo);
    const oldPrice = recentSwaps.length > 0 ? recentSwaps[0].price : currentPrice;
    const priceChange24h = oldPrice > 0 ? ((currentPrice - oldPrice) / oldPrice) * 100 : 0;

    return {
      poolAddress,
      capabilityType: pool.config.capabilityType,
      currentPrice,
      volume24h: pool.volume24h,
      tvl,
      fees24h: pool.fees24h,
      activePositions: pool.positions.size,
      priceChange24h,
      activeBinId: pool.activeBinId,
    };
  }

  /** Get swap history for a pool */
  async getSwapHistory(poolAddress: string, limit = 50): Promise<SwapEvent[]> {
    const pool = this.pools.get(poolAddress);
    if (!pool) return [];
    return pool.swapHistory.slice(-limit);
  }
}
