/**
 * Protocol system types.
 *
 * Protocols are abstract, shareable recipes for multi-instrument workflows.
 * A ProtocolTemplate specifies capability types needed (not specific instruments).
 * A ProtocolRun binds a template to real instruments in a kernel at runtime.
 *
 * Transfers between instruments are robot-mediated (e.g., R2D3 OpenDroids)
 * with progressive automation: manual → teleop → pilot → VLA → autonomous.
 */

import type { Id, Timestamp, SHA256 } from "./common.js";
import type { LabwareType, TransferMechanism } from "./orchestrator.js";

// ── Automation Level ─────────────────────────────────────────────

/** Progressive automation levels for sample transfers */
export type AutomationLevel =
  | "manual"              // Human carries labware between instruments
  | "teleoperated"        // Human controls robot remotely in real-time
  | "pilot_operated"      // Trained pilot operates robot remotely
  | "vla_assisted"        // VLA model executes, human monitors
  | "fully_autonomous"    // VLA model executes without supervision
  | (string & {});

// ── Transfer Agent ───────────────────────────────────────────────

/** What/who performs a physical transfer between instruments */
export type TransferAgentType =
  | "robot"         // R2D3 or other robotic arm
  | "human"         // Human operator
  | "integrated"    // Built-in mechanism (deck, conveyor, pneumatic)
  | (string & {});

export interface TransferAgent {
  id: Id;
  type: TransferAgentType;
  /** For robots: the robot ID / serial. For humans: operator ID */
  agentRef: Id;
  label: string;
  /** Capabilities (e.g., "dual_arm", "gripper_eg2_4c2", "liquid_handling") */
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

// ── Automation Status (per transfer pair) ────────────────────────

/** Tracks automation progression for a specific instrument-to-instrument transfer */
export interface AutomationStatus {
  id: Id;
  kernelId: Id;
  fromNodeId: Id;
  toNodeId: Id;
  transferAgentId: Id;
  currentLevel: AutomationLevel;
  /** Number of demonstration episodes collected */
  episodeCount: number;
  /** Minimum episodes before VLA training is attempted */
  minEpisodesForTraining: number;
  /** VLA model ID currently trained for this transfer */
  vlaModelId?: string;
  /** VLA model name (e.g., "GR00T N1.6", "SmolVLA") */
  vlaModelName?: string;
  /** Success rate of autonomous attempts (0-1) */
  vlaSuccessRate?: number;
  /** Threshold success rate to advance to next automation level */
  advanceThreshold: number;
  /** Timestamp of last episode */
  lastEpisodeAt?: Timestamp;
  /** Timestamp of last VLA training run */
  lastTrainedAt?: Timestamp;
  metadata?: Record<string, unknown>;
}

// ── Protocol Parameters ──────────────────────────────────────────

export type ProtocolParamType =
  | "enum"
  | "number"
  | "boolean"
  | "string"
  | "duration"
  | "temperature"
  | "volume"
  | (string & {});

export interface ProtocolParamOption {
  value: string;
  label: string;
  description?: string;
}

export interface ProtocolParameter {
  key: string;
  label: string;
  description?: string;
  type: ProtocolParamType;
  required: boolean;
  group?: string;
  defaultValue?: string | number | boolean;
  /** For enum type */
  options?: ProtocolParamOption[];
  /** For number types */
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Conditional visibility */
  visibleWhen?: { param: string; equals: string | number | boolean };
}

// ── Protocol Step (abstract) ─────────────────────────────────────

/** An abstract step: specifies what capability is needed, not which instrument */
export interface ProtocolStep {
  id: Id;
  /** What capability type this step requires */
  capabilityType: string;
  /** Human-readable label */
  label: string;
  /** Action name (e.g., "dilute_and_dispense", "spin_separate") */
  action: string;
  /** Fixed parameters for this step */
  params: Record<string, unknown>;
  /** Which protocol parameters this step exposes for customization */
  parameterBindings?: Array<{
    stepParamKey: string;
    protocolParamKey: string;
  }>;
  /** Estimated duration in ms */
  estimatedDurationMs: number;
  /** Required labware/container type */
  requiredLabware?: LabwareType;
  /** Whether this step produces evidence */
  producesEvidence: boolean;
  /** IDs of steps this depends on (DAG edges) */
  dependsOn: Id[];
  /** Position in the visual builder */
  position?: { x: number; y: number };
  /** Instructions for operator */
  notes?: string;
}

// ── Protocol Transfer (abstract) ─────────────────────────────────

/** An abstract transfer between two protocol steps */
export interface ProtocolTransfer {
  id: Id;
  fromStepId: Id;
  toStepId: Id;
  labwareType: LabwareType;
  constraints?: {
    maxWeightKg?: number;
    maxDimensionMm?: number;
    temperatureRange?: { min: number; max: number; unit: "C" | "F" };
    timeConstraintMs?: number;
    orientationRequired?: boolean;
  };
  /** Preferred automation level (actual may differ based on availability) */
  preferredAutomationLevel?: AutomationLevel;
  notes?: string;
}

// ── Protocol Template (publishable) ──────────────────────────────

export type ProtocolStatus =
  | "draft"
  | "published"
  | "deprecated"
  | "archived"
  | (string & {});

export interface ProtocolTemplate {
  id: Id;
  name: string;
  description: string;
  version: string;
  authorId: Id;
  authorName: string;
  status: ProtocolStatus;
  tags: string[];
  /** Capability types required (derived from steps for quick filtering) */
  requiredCapabilities: string[];
  steps: ProtocolStep[];
  transfers: ProtocolTransfer[];
  parameters: ProtocolParameter[];
  defaultValues: Record<string, string | number | boolean>;
  estimatedTotalDurationMs: number;
  forkCount: number;
  runCount: number;
  rating?: number;
  /** Source template ID if forked */
  forkedFrom?: Id;
  contentHash?: SHA256;
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

// ── Protocol Fork ────────────────────────────────────────────────

export interface ProtocolFork {
  id: Id;
  sourceTemplateId: Id;
  sourceTemplateVersion: string;
  forkedBy: Id;
  parameterOverrides: Record<string, string | number | boolean>;
  stepOverrides?: Array<{
    action: "modify" | "remove" | "add";
    stepId?: Id;
    step?: ProtocolStep;
    modifications?: Partial<ProtocolStep>;
  }>;
  name: string;
  notes?: string;
  createdAt: Timestamp;
}

// ── Protocol Run (concrete execution) ────────────────────────────

export type ProtocolRunStatus =
  | "binding"       // Resolving abstract steps to real instruments
  | "ready"         // Fully bound, ready to start
  | "running"       // In progress
  | "paused"        // Paused by operator
  | "completed"     // All steps done
  | "failed"        // Error occurred
  | "cancelled"     // Cancelled by user
  | (string & {});

export interface ProtocolRun {
  id: Id;
  templateId: Id;
  templateVersion: string;
  forkId?: Id;
  kernelId: Id;
  jobId?: Id;
  parameterValues: Record<string, string | number | boolean>;
  steps: ProtocolRunStep[];
  transfers: ProtocolRunTransfer[];
  status: ProtocolRunStatus;
  currentStepIndex: number;
  initiatedBy: Id;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  error?: string;
  sampleIds: Id[];
  metadata?: Record<string, unknown>;
  createdAt: Timestamp;
}

// ── Protocol Run Step (bound to real instrument) ─────────────────

export type ProtocolRunStepStatus =
  | "pending"
  | "waiting_transfer"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | (string & {});

export interface ProtocolRunStep {
  id: Id;
  protocolStepId: Id;
  nodeId: Id;
  deviceId?: Id;
  action: string;
  resolvedParams: Record<string, unknown>;
  actualDurationMs?: number;
  status: ProtocolRunStepStatus;
  evidenceHash?: SHA256;
  claimId?: Id;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  error?: string;
}

// ── Protocol Run Transfer (bound to real agent) ──────────────────

export type ProtocolRunTransferStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | (string & {});

export interface ProtocolRunTransfer {
  id: Id;
  protocolTransferId: Id;
  fromNodeId: Id;
  toNodeId: Id;
  transferAgentId?: Id;
  automationLevel: AutomationLevel;
  mechanism: TransferMechanism;
  /** Whether an episode was recorded for VLA training */
  episodeRecorded: boolean;
  episodeId?: Id;
  status: ProtocolRunTransferStatus;
  startedAt?: Timestamp;
  completedAt?: Timestamp;
}

// ── Protocol Events ──────────────────────────────────────────────

export type ProtocolEventType =
  | "protocol_run_created"
  | "protocol_run_started"
  | "protocol_run_completed"
  | "protocol_run_failed"
  | "protocol_run_paused"
  | "protocol_run_cancelled"
  | "protocol_step_started"
  | "protocol_step_completed"
  | "protocol_step_failed"
  | "protocol_transfer_started"
  | "protocol_transfer_completed"
  | "protocol_transfer_failed"
  | "protocol_episode_recorded"
  | "automation_level_advanced"
  | (string & {});

export interface ProtocolEvent {
  id: Id;
  runId: Id;
  timestamp: Timestamp;
  type: ProtocolEventType;
  stepId?: Id;
  transferId?: Id;
  payload: Record<string, unknown>;
}
