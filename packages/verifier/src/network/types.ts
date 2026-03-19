/**
 * Private Verification Network — Type definitions.
 *
 * Replaces the Bittensor dependency with a self-sovereign verification
 * network. Nodes stake reputation, verify evidence, and reach consensus
 * via stake-weighted Yuma scoring with outlier penalties.
 */

/** Status of a verifier node in the network */
export type NodeStatus = "online" | "offline";

/** A node in the private verification network */
export interface VerifierNodeInfo {
  /** Unique identifier for the node */
  id: string;
  /** HTTP endpoint URL (for future networked mode) */
  endpoint: string;
  /** Ed25519 public key (hex-encoded) */
  publicKey: string;
  /** Amount of stake backing this node */
  stake: number;
  /** Reputation score (starts at 100, goes up/down) */
  reputation: number;
  /** Current node status */
  status: NodeStatus;
}

/** A request to verify an evidence bundle */
export interface VerificationRequest {
  /** Unique request identifier */
  requestId: string;
  /** SHA-256 hash of the evidence bundle */
  bundleHash: string;
  /** JSON-serialized evidence bundle data */
  bundleData: string;
  /** Required assurance tier (0-3) */
  requiredTier: number;
  /** When the request was created */
  timestamp: string;
  /** Address of the requester */
  requesterAddress: string;
}

/** A single node's response to a verification request */
export interface VerificationResponse {
  /** Matches the request's requestId */
  requestId: string;
  /** ID of the node that produced this response */
  nodeId: string;
  /** Overall verification score (0.0 - 1.0) */
  score: number;
  /** Whether the evidence meets the required assurance tier */
  tierCompliant: boolean;
  /** List of defects or issues found in the evidence */
  defectsFound: string[];
  /** Time the node took to process the request (ms) */
  processingTimeMs: number;
  /** Ed25519 signature of the response payload */
  signature: string;
}

/** Result of running consensus across node responses */
export interface ConsensusResult {
  /** Matches the original requestId */
  requestId: string;
  /** All individual node responses */
  responses: VerificationResponse[];
  /** Stake-weighted consensus score (0.0 - 1.0) */
  consensusScore: number;
  /** Whether consensus determined tier compliance */
  tierCompliant: boolean;
  /** Defects agreed upon by consensus (weighted vote > 30%) */
  consensusDefects: string[];
  /** IDs of nodes that participated */
  participatingNodes: string[];
  /** When the consensus was reached */
  timestamp: string;
}

/** Configuration for the verification network */
export interface NetworkConfig {
  /** Minimum number of nodes required for a valid consensus */
  minNodes: number;
  /** Fraction of stake-weight required for consensus (default 2/3) */
  consensusThreshold: number;
  /** Maximum time to wait for node responses (ms) */
  maxResponseTimeMs: number;
  /** Rate at which reputation decays toward baseline per epoch (0-1) */
  reputationDecayRate: number;
}

/** Default network configuration */
export const DEFAULT_NETWORK_CONFIG: NetworkConfig = {
  minNodes: 3,
  consensusThreshold: 2 / 3,
  maxResponseTimeMs: 30_000,
  reputationDecayRate: 0.01,
};

/** Network status summary */
export interface NetworkStatus {
  /** Total registered nodes */
  nodes: number;
  /** Nodes currently online */
  activeNodes: number;
  /** Total verifications processed */
  totalVerifications: number;
  /** Running average consensus score */
  averageConsensusScore: number;
}
