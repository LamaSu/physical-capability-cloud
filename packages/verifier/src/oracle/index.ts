/**
 * Oracle Verification Cascade — barrel exports.
 */

export {
  OracleVerificationBridge,
  type OracleLeaderboardEntry,
} from "./oracle-bridge.js";

export { UMAOracleAdapter } from "./uma-adapter.js";
export { ChainlinkOracleAdapter, CHAINLINK_DON_SOURCE } from "./chainlink-adapter.js";
export { EigenLayerOracleAdapter } from "./eigenlayer-adapter.js";

export { evaluateEvidence, type EvaluationResult } from "./evidence-evaluator.js";

export type {
  VerificationOracle,
  OracleVerificationResult,
  OracleDetail,
  OracleMetrics,
  OracleConfig,
  VerificationResult as OracleVerificationResultCompat,
  OnChainOracleAttestation,
  AttestationBinding,
} from "./types.js";

export {
  DEFAULT_ORACLE_CONFIG,
  configFromEnv,
  buildOnChainAttestation,
} from "./types.js";
