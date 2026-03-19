/**
 * @pcc/agent-evaluator — Third-party quality assessment for PCC milestone evidence.
 *
 * Provides:
 * - EvaluatorAgent: BaseAgent subclass that handles evaluation requests
 * - EvaluationEngine: Rules-based evidence assessment
 * - ReputationBridge: Auto-publish PCC metrics to ERC-8004
 * - AcpBridge: Virtuals ACP ↔ PCC A2A protocol bridge
 */

export { EvaluatorAgent, type EvaluatorAgentConfig } from "./evaluator-agent.js";
export {
  evaluate,
  type EvidenceData,
  type Requirement,
  type Finding,
  type EvaluationOutput,
} from "./evaluation-engine.js";
export {
  generateJobFeedback,
  generateAssuranceTierFeedback,
  generateUptimeFeedback,
  type JobCompletionData,
} from "./reputation-bridge.js";
export {
  intentToAcpMemo,
  acpMemoToIntent,
  capabilityToJobOffering,
  jobOfferingToQuoteRequest,
  getAcpPhase,
  isPhaseTransition,
  type AcpMemo,
  type AcpMemoType,
  type AcpPhase,
  type AcpJobOffering,
} from "./acp-bridge.js";
