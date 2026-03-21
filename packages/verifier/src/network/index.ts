/**
 * Private Verification Network — barrel exports.
 *
 * Production replacement for the Bittensor verification subnet.
 * Self-sovereign, zero external dependencies beyond @pcc/spec + node:crypto.
 */

// Types
export type {
  VerifierNodeInfo,
  VerificationRequest,
  VerificationResponse,
  ConsensusResult,
  NetworkConfig,
  NetworkStatus,
  NodeStatus,
  HumanVerificationRequest,
  HumanVerificationResponse,
  DisputeRecord,
  VerifierReward,
  VerifierSlash,
} from "./types.js";
export { DEFAULT_NETWORK_CONFIG } from "./types.js";

// Classes
export { VerifierNode, type VerifierQuality, type VerifierNodeConfig } from "./verifier-node.js";
export { ConsensusEngine } from "./consensus-engine.js";
export { VerificationNetwork } from "./verification-network.js";
export { VerifierSelector } from "./verifier-selector.js";
