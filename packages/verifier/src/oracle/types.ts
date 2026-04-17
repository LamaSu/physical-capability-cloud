/**
 * Oracle Verification Cascade — Type definitions.
 *
 * Common interface types for the three-tier oracle cascade:
 *   UMA Optimistic Oracle (primary)
 *   → Chainlink Functions (fallback)
 *   → EigenLayer AVS (future stub)
 */

import type { Hex, Address } from "viem";

/**
 * On-chain attestation struct — mirrors IPCCOracle.Attestation (Solidity).
 *
 * This is the shape that goes to MilestoneEscrow.submitAttestation(uint256,
 * Attestation) and MilestoneEscrow.release(uint256, Attestation). It must
 * be built atomically alongside the off-chain OracleVerificationResult
 * because the escrow binds the milestone to keccak256(abi.encode(attestation))
 * and re-verifies the signature on-chain at settlement.
 */
export interface OnChainOracleAttestation {
  /** Address of the MilestoneEscrow this attestation is bound to */
  escrowAddress: Address;
  /** Job ID this attestation covers (matches evidence.jobId) */
  jobId: string;
  /** keccak256 of the evidence bundle this attestation covers */
  evidenceHash: Hex;
  /** Assurance tier (0..3) */
  tier: number;
  /** Oracle's pass/fail verdict — must be true for settlement */
  verified: boolean;
  /** Unix timestamp (seconds) when the oracle signed */
  timestamp: bigint;
  /** Per-attestation nonce to prevent replay */
  nonce: Hex;
  /** Oracle signature over the struct (empty bytes for mocks) */
  signature: Hex;
}

/**
 * Binding context for on-chain attestation production.
 *
 * When supplied, the adapter populates OracleVerificationResult.attestation
 * with a fully-formed OnChainOracleAttestation that can be passed directly
 * to MilestoneEscrow.submitAttestation.
 */
export interface AttestationBinding {
  escrowAddress: Address;
  jobId: string;
}

/** Common interface all oracle adapters implement */
export interface VerificationOracle {
  readonly name: string;
  submitForVerification(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    binding?: AttestationBinding,
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
  /** Assurance score from the digital-verifier rollup (0.0-1.0) */
  assuranceScore?: number;
  /**
   * On-chain attestation struct derived from this verification. Populated
   * by adapters when the caller supplies an escrowAddress + jobId in the
   * submit call. MilestoneEscrow requires this struct verbatim for both
   * submitAttestation and release.
   */
  attestation?: OnChainOracleAttestation;
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
 * Build an OnChainOracleAttestation from a verification outcome + binding
 * context. Used by adapters to populate OracleVerificationResult.attestation
 * when the caller supplies an escrow to bind against.
 *
 * For mock adapters, `signature` is `0x` (empty bytes). The on-chain MockPCCOracle
 * accepts empty signatures when its `verified` flag matches; a production
 * oracle verifier must produce a real secp256k1 signature over
 * keccak256(abi.encode(escrow, jobId, evidenceHash, tier, verified, timestamp, nonce)).
 */
export function buildOnChainAttestation(params: {
  binding: AttestationBinding;
  evidenceHash: Hex;
  tier: number;
  verified: boolean;
  signature?: Hex;
  nonce?: Hex;
  timestamp?: bigint;
}): OnChainOracleAttestation {
  const now = params.timestamp ?? BigInt(Math.floor(Date.now() / 1000));
  // Default nonce: deterministic from evidenceHash + escrow + timestamp.
  // In production, the oracle must produce a server-side random nonce.
  const defaultNonce: Hex =
    params.nonce ??
    (`0x${Buffer.from(
      `${params.binding.escrowAddress}-${params.binding.jobId}-${params.evidenceHash}-${now.toString()}`,
    )
      .toString("hex")
      .padStart(64, "0")
      .slice(0, 64)}` as Hex);
  return {
    escrowAddress: params.binding.escrowAddress,
    jobId: params.binding.jobId,
    evidenceHash: params.evidenceHash,
    tier: params.tier,
    verified: params.verified,
    timestamp: now,
    nonce: defaultNonce,
    signature: params.signature ?? "0x",
  };
}

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
