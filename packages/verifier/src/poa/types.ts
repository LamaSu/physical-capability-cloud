/**
 * POA (Proof of Assurance) Protocol Types
 *
 * TypeScript equivalents of the Provenonce POA Bittensor subnet protocol.
 * Maps CPC (Canonical Path Contract), EEB (Execution Evidence Bundle),
 * and ASO (Assurance Score Output) to typed interfaces for PCCP integration.
 */

// ── CPC (Canonical Path Contract) ──────────────────────────────────

/** Types of tasks that can be assigned to POA miners. */
export type CPCTaskType =
  | "workflow_execution"
  | "data_analysis"
  | "content_generation"
  | "code_execution"
  | "multi_step_reasoning"
  | "canary";

/** A single step in a CPC workflow. */
export interface CPCWorkflowStep {
  stepId: string;
  stepType: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  constraints: Record<string, unknown>;
  dependsOn: string[];
}

/** Global execution constraints for a CPC task. */
export interface CPCTaskConstraints {
  maxExecutionTimeSeconds: number;
  maxSteps: number;
  requiredEvidenceTypes: string[];
  allowExternalApiCalls: boolean;
}

/** Canonical Path Contract — the task specification for POA miners. */
export interface CPCTask {
  taskId: string;
  version: string;
  taskType: CPCTaskType;
  title: string;
  description: string;
  workflowSteps: CPCWorkflowStep[];
  constraints: CPCTaskConstraints;
  nonce: string;
  inputData: Record<string, unknown>;
  issuedAt: string;
  issuedBy: string | null;
  metadata: Record<string, unknown>;
}

// ── EEB (Execution Evidence Bundle) ─────────────────────────────────

/** A single entry in the execution trace. */
export interface TraceEntry {
  stepId: string;
  action: string;
  inputHash: string;
  outputHash: string;
  outputSummary: string;
  durationMs: number;
  timestamp: string;
  metadata: Record<string, unknown>;
}

/** Timestamps bounding the execution. */
export interface ExecutionTimestamps {
  receivedAt: string;
  startedAt: string;
  completedAt: string;
  submittedAt: string;
}

/** Execution Evidence Bundle — proof artifact produced by miners. */
export interface EvidenceBundle {
  taskId: string;
  eebVersion: string;
  minerHotkey: string;
  executionTrace: TraceEntry[];
  hashChain: string[];
  nonceReflection: string;
  timestamps: ExecutionTimestamps;
  outputs: Record<string, unknown>;
  outputHash: string;
  signature: string;
  metadata: Record<string, unknown>;
}

// ── ASO (Assurance Score Output) ────────────────────────────────────

/** A single scoring dimension with its weight and computed value. */
export interface ScoreDimension {
  name: string;
  weight: number;
  rawScore: number;
  weightedScore: number;
  explanation: string;
}

/** Assurance Score Output — the commodity unit produced per CPC execution. */
export interface AssuranceScore {
  taskId: string;
  minerHotkey: string;
  validatorHotkey: string;
  verificationPassed: boolean;
  verificationFailures: string[];
  dimensions: ScoreDimension[];
  compositeScore: number;
  penalties: string[];
  penaltyMultiplier: number;
  finalScore: number;
  scoredAt: string;
}

// ── Bridge Configuration ────────────────────────────────────────────

/** Configuration for the POA bridge. */
export interface POABridgeConfig {
  /** Run in mock mode (local verification, no network calls). */
  mock: boolean;
  /** POA subnet endpoint URL (used in production mode). */
  poaEndpoint: string;
  /** Timeout for subnet calls in ms. */
  timeout: number;
  /** Validator hotkey identity for scoring. */
  validatorHotkey: string;
}

/** Default bridge configuration (mock mode). */
export const DEFAULT_POA_BRIDGE_CONFIG: POABridgeConfig = {
  mock: true,
  poaEndpoint: "ws://localhost:9944",
  timeout: 30_000,
  validatorHotkey: "pcc-validator-mock",
};

/** Verification result returned by the bridge. */
export interface POAVerificationResult {
  passed: boolean;
  failures: string[];
  score: AssuranceScore;
}

/** Default scoring weights from POA Technical Specification. */
export const DEFAULT_SCORING_WEIGHTS: Record<string, number> = {
  accuracy: 0.35,
  completeness: 0.25,
  evidence_integrity: 0.20,
  reasoning_quality: 0.10,
  efficiency: 0.10,
};
