/**
 * Bittensor Verification Subnet — Type definitions.
 *
 * Mirrors the Bittensor Python protocol (synapses, metagraph, etc.)
 * in TypeScript for the PCC mock subnet simulation.
 */

/**
 * Synapse for evidence verification — analogous to a Bittensor
 * synapse class that travels between validators and miners.
 */
export interface EvidenceVerifySynapse {
  /** SHA-256 hash of the evidence bundle */
  evidenceHash: string;
  /** JSON-serialized EvidenceBundle data */
  evidenceData: string;
  /** Required assurance tier (0-3) */
  requiredTier: number;
  // --- Response fields (filled by miners) ---
  /** Overall verification score (0.0 - 1.0) */
  verificationScore?: number;
  /** Whether the evidence meets the required tier */
  tierCompliant?: boolean;
  /** List of defects or issues found */
  defectsFound?: string[];
  /** Time the miner took to process (ms) */
  processingTimeMs?: number;
}

/** Information about a miner in the subnet metagraph */
export interface MinerInfo {
  /** Unique ID in the subnet (0-255 in real Bittensor) */
  uid: number;
  /** Miner's hotkey (identity) */
  hotkey: string;
  /** Amount of TAO staked */
  stake: number;
  /** Trust score from validators (0.0 - 1.0) */
  trust: number;
  /** Incentive score (determines TAO rewards) */
  incentive: number;
  /** Block number of last weight update */
  lastUpdate: number;
}

/** Configuration for the subnet validator */
export interface ValidatorConfig {
  /** Bittensor subnet ID */
  subnetId: number;
  /** Network URL (finney, test, local) */
  networkUrl: string;
  /** Number of miners to query per verification */
  numMinersToQuery: number;
  /** Timeout for miner responses (ms) */
  timeout: number;
  /** Minimum consensus score to accept verification */
  minScoreThreshold: number;
}

/** Aggregated metrics for the verification subnet */
export interface SubnetMetrics {
  /** Total number of verifications processed */
  totalVerifications: number;
  /** Average verification score across all verifications */
  averageScore: number;
  /** Number of currently active miners */
  activeMinerCount: number;
  /** Total rewards distributed in the last epoch */
  lastEpochRewards: number;
}

/** Result from a decentralized subnet verification */
export interface VerificationResult {
  /** Whether the evidence passed verification */
  passed: boolean;
  /** Consensus score from miners (0.0 - 1.0) */
  consensusScore: number;
  /** Whether the required tier was met */
  tierCompliant: boolean;
  /** Aggregated defects from all miners */
  defects: string[];
  /** Number of miners that participated */
  minerCount: number;
  /** Individual miner responses (for transparency) */
  minerResponses: MinerResponse[];
  /** Time taken for the full verification round (ms) */
  totalTimeMs: number;
}

/** A single miner's response in a verification round */
export interface MinerResponse {
  uid: number;
  hotkey: string;
  score: number;
  tierCompliant: boolean;
  defectsFound: string[];
  processingTimeMs: number;
  /** Weight assigned by Yuma Consensus */
  consensusWeight: number;
}

/** Default validator configuration */
export const DEFAULT_VALIDATOR_CONFIG: ValidatorConfig = {
  subnetId: 42,
  networkUrl: "ws://localhost:9944",
  numMinersToQuery: 5,
  timeout: 30_000,
  minScoreThreshold: 0.6,
};
