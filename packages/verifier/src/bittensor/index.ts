/**
 * Bittensor Verification Subnet — barrel exports.
 */

export type {
  EvidenceVerifySynapse,
  MinerInfo,
  ValidatorConfig,
  SubnetMetrics,
  VerificationResult,
  MinerResponse,
} from "./types.js";
export { DEFAULT_VALIDATOR_CONFIG } from "./types.js";

export { MockMiner, type MinerQuality } from "./mock-miner.js";
export { MockValidator } from "./mock-validator.js";
export { BittensorSubnetBridge } from "./subnet-bridge.js";

// ── Task-Oriented Subnets ─────────────────────────────────────────────

export {
  CapabilityRoutingSubnet,
  type CapabilityRoutingSynapse,
  type CapabilityRoutingJobRequest,
  type CapabilityRoutingOperator,
  type CapabilityRoutingRankEntry,
  type CapabilityRoutingResult,
} from "./capability-router.js";

export {
  QualityScoringSubnet,
  type QualityScoringSynapse,
  type QualityScoreDimensions,
  type QualityScoringResult,
} from "./quality-scorer.js";

export {
  SimilaritySubnet,
  type SimilarityScoringSynapse,
  type SimilarityCandidateCsd,
  type SimilarityRegisteredCsd,
  type SimilarityCsdParam,
  type SimilarityCsdConstraint,
  type SimilarityCsdPricing,
  type SimilarityDimensions,
  type SimilarityEntry,
  type SimilarityResult,
  type SimilarityVerdict,
} from "./similarity-scorer.js";

export {
  BittensorTaskRouter,
  type TaskRouterConfig,
} from "./subnet-tasks.js";
