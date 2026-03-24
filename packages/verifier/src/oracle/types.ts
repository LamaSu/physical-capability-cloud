/**
 * Oracle Verification Cascade — Type definitions.
 *
 * Common interface types for the three-tier oracle cascade:
 *   UMA Optimistic Oracle (primary)
 *   → Chainlink Functions (fallback)
 *   → EigenLayer AVS (future stub)
 */

/** Common interface all oracle adapters implement */
export interface VerificationOracle {
  readonly name: string;
  submitForVerification(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
  ): Promise<OracleVerificationResult>;
  getMetrics(): OracleMetrics;
  isAvailable(): boolean;
}

export interface OracleVerificationResult {
  passed: boolean;
  score: number; // 0.0-1.0
  tierCompliant: boolean;
  defects: string[];
  oracle: string; // which oracle produced this ("uma" | "chainlink" | "eigenlayer" | "local")
  details: OracleDetail[];
  totalTimeMs: number;
  // UMA-specific
  assertionId?: string; // UMA assertion ID for tracking
  disputeWindow?: number; // seconds remaining in liveness
  bondAmount?: string; // bond amount in token units
  // Chainlink-specific
  requestId?: string; // Chainlink Functions request ID
}

export interface OracleDetail {
  source: string;
  score: number;
  passed: boolean;
  metadata: Record<string, unknown>;
}

export interface OracleMetrics {
  totalVerifications: number;
  averageScore: number;
  activeOracles: number;
  primaryOracle: string;
  fallbackOracles: string[];
  recentResults: Array<{
    oracle: string;
    passed: boolean;
    score: number;
    timestamp: string;
  }>;
}

export interface OracleConfig {
  /** Chain ID for on-chain operations */
  chainId: number;
  /** RPC URL */
  rpcUrl: string;
  /** UMA OOv3 contract address (auto-resolved if not set) */
  umaOracleAddress?: string;
  /** Bond token address (USDC) */
  bondTokenAddress?: string;
  /** Bond amount in token units (default: 500e6 for 500 USDC) */
  bondAmount?: bigint;
  /** UMA liveness period in seconds (default: 7200 = 2hr) */
  livenessSeconds?: number;
  /** Chainlink Functions router address */
  chainlinkRouter?: string;
  /** Chainlink DON ID */
  chainlinkDonId?: string;
  /** Chainlink subscription ID */
  chainlinkSubId?: bigint;
  /** Minimum score threshold (default: 0.6) */
  minScoreThreshold?: number;
  /** Enable mock mode (in-process simulation, no on-chain calls) */
  mock?: boolean;
}

export const DEFAULT_ORACLE_CONFIG: OracleConfig = {
  chainId: 84532, // Base Sepolia
  rpcUrl: "https://sepolia.base.org",
  livenessSeconds: 7200,
  bondAmount: BigInt(1_000_000), // 1 USDC (6 decimals) — low for testnet
  minScoreThreshold: 0.6,
  mock: true, // default to mock for dev
};

/**
 * Create OracleConfig from environment variables.
 * Mock mode is enabled by default (ORACLE_MOCK=true).
 * Set ORACLE_MOCK=false to activate live on-chain mode.
 */
export function configFromEnv(): OracleConfig {
  return {
    chainId: parseInt(process.env.CHAIN_ID ?? "84532"),
    rpcUrl: process.env.BASE_RPC_URL ?? "https://sepolia.base.org",
    umaOracleAddress: process.env.UMA_OOV3_ADDRESS,
    bondTokenAddress:
      process.env.UMA_BOND_TOKEN ?? "0x5f2eb54dc5cb9a6bfff58222c672e73e16e763e9",
    bondAmount: BigInt(process.env.UMA_BOND_AMOUNT ?? "1000000"),
    livenessSeconds: parseInt(process.env.UMA_LIVENESS_SECONDS ?? "7200"),
    chainlinkRouter:
      process.env.CHAINLINK_ROUTER ??
      "0xf9B8fc078197181C841c296C876945aaa425B278",
    chainlinkDonId:
      process.env.CHAINLINK_DON_ID ?? "fun-base-sepolia-1",
    chainlinkSubId: process.env.CHAINLINK_SUB_ID
      ? BigInt(process.env.CHAINLINK_SUB_ID)
      : undefined,
    minScoreThreshold: parseFloat(process.env.ORACLE_MIN_SCORE ?? "0.6"),
    mock: process.env.ORACLE_MOCK !== "false",
  };
}

/**
 * Backward-compatible VerificationResult shape that mirrors
 * the Bittensor VerificationResult interface for drop-in use.
 */
export interface VerificationResult {
  passed: boolean;
  /** Mapped from OracleVerificationResult.score */
  consensusScore: number;
  tierCompliant: boolean;
  defects: string[];
  /** Always 1 for oracle (no miner pool) */
  minerCount: number;
  /** Empty array — oracle replaces individual miner responses */
  minerResponses: [];
  totalTimeMs: number;
  /** Oracle-specific extras */
  oracle?: string;
  assertionId?: string;
  requestId?: string;
}
