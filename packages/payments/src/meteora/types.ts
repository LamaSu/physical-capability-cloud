/**
 * Meteora DLMM types — Dynamic Liquidity Market Maker for capability pricing.
 *
 * Meteora DLMM uses discrete price bins to concentrate liquidity. PCC maps
 * each capability type to a DLMM pool where the "price" is the USDC cost
 * per capability unit. Operators add liquidity (supply), requesters swap
 * against it (demand), and the bin distribution reflects real-time pricing.
 */

/** A single price bin in a DLMM pool */
export interface PriceBin {
  /** Bin ID (integer, can be negative) */
  binId: number;
  /** USDC liquidity in this bin (atomic units, 6 decimals) */
  amountX: bigint;
  /** Capability token liquidity in this bin */
  amountY: bigint;
  /** Price of capability in USDC at this bin */
  price: number;
  /** Bin's share of total liquidity (0-1) */
  liquidityShare: number;
}

/** DLMM pool configuration for a capability type */
export interface DLMMPoolConfig {
  /** Solana pubkey of the DLMM pool */
  poolAddress: string;
  /** Capability type this pool prices (e.g. "fdm_printing", "hplc_analysis") */
  capabilityType: string;
  /** Token X mint — always USDC */
  tokenXMint: string;
  /** Token Y mint — capability token for this pool */
  tokenYMint: string;
  /** Bin step in basis points (e.g. 25 = 0.25% between bins) */
  binStep: number;
  /** Base fee in basis points */
  baseFee: number;
  /** Whether dynamic fees are enabled (volatility-adjusted) */
  dynamicFee: boolean;
}

/** A liquidity position owned by an operator */
export interface LiquidityPosition {
  /** Position pubkey */
  positionAddress: string;
  /** Owner (operator) wallet */
  owner: string;
  /** Pool this position belongs to */
  poolAddress: string;
  /** Capability type */
  capabilityType: string;
  /** Lower bin ID of the position range */
  lowerBinId: number;
  /** Upper bin ID of the position range */
  upperBinId: number;
  /** Total USDC deposited */
  depositedX: bigint;
  /** Total capability tokens deposited */
  depositedY: bigint;
  /** Unclaimed fees in USDC */
  unclaimedFeesX: bigint;
  /** Unclaimed fees in capability tokens */
  unclaimedFeesY: bigint;
  /** Timestamp of last update */
  lastUpdated: number;
}

/** Result of a price quote from the DLMM */
export interface SwapQuote {
  /** Amount of input token */
  amountIn: bigint;
  /** Estimated output amount */
  amountOut: bigint;
  /** Price impact as a fraction (0-1) */
  priceImpact: number;
  /** Fee amount in input token */
  fee: bigint;
  /** Number of bins crossed */
  binsCrossed: number;
  /** Effective price (amountIn / amountOut) */
  effectivePrice: number;
}

/** Pool statistics for dashboard display */
export interface PoolStats {
  poolAddress: string;
  capabilityType: string;
  /** Current active bin price (USDC per capability unit) */
  currentPrice: number;
  /** 24h volume in USDC */
  volume24h: number;
  /** Total value locked in USDC */
  tvl: number;
  /** 24h fees generated in USDC */
  fees24h: number;
  /** Number of active liquidity positions */
  activePositions: number;
  /** 24h price change percentage */
  priceChange24h: number;
  /** Active bin ID */
  activeBinId: number;
}

/** Event emitted when a swap occurs */
export interface SwapEvent {
  poolAddress: string;
  capabilityType: string;
  direction: "buy" | "sell";
  amountIn: bigint;
  amountOut: bigint;
  price: number;
  trader: string;
  timestamp: number;
}

/** Configuration for creating a new capability pool */
export interface CreatePoolParams {
  capabilityType: string;
  /** Initial price in USDC per capability unit */
  initialPrice: number;
  /** Bin step in basis points (default: 25) */
  binStep?: number;
  /** Base fee in basis points (default: 30) */
  baseFee?: number;
  /** Enable dynamic fees (default: true) */
  dynamicFee?: boolean;
  /** Initial USDC liquidity */
  initialLiquidityUsdc: number;
  /** Number of bins to seed around the initial price */
  seedBins?: number;
}

/** Parameters for adding liquidity */
export interface AddLiquidityParams {
  poolAddress: string;
  /** USDC amount to deposit */
  amountX: bigint;
  /** Capability token amount to deposit */
  amountY: bigint;
  /** Distribution strategy */
  strategy: "spot" | "curve" | "bid_ask";
  /** Number of bins to distribute across */
  binCount?: number;
}

/** Parameters for removing liquidity */
export interface RemoveLiquidityParams {
  positionAddress: string;
  /** Fraction to remove (0-1, 1 = remove all) */
  fraction: number;
}
