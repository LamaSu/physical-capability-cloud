/**
 * POA (Proof of Assurance) Subnet Bridge — barrel exports.
 *
 * Integrates PCCP evidence verification with the Provenonce POA Bittensor subnet.
 */

// Types
export type {
  CPCTask,
  CPCTaskType,
  CPCWorkflowStep,
  CPCTaskConstraints,
  EvidenceBundle as POAEvidenceBundle,
  TraceEntry,
  ExecutionTimestamps,
  AssuranceScore,
  ScoreDimension,
  POABridgeConfig,
  POAVerificationResult,
} from "./types.js";
export { DEFAULT_POA_BRIDGE_CONFIG, DEFAULT_SCORING_WEIGHTS } from "./types.js";

// Bridge
export {
  POABridge,
  type CreateCPCParams,
  type SubmitEvidenceParams,
} from "./poa-bridge.js";
