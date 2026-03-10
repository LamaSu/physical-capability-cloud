/**
 * Intra-kernel orchestrator types.
 *
 * These types model the physical topology of instruments within a shop kernel,
 * the movement of samples between instruments, resource contention, and
 * multi-instrument workflow execution.
 */

import type { Id, Timestamp, SHA256 } from "./common.js";

// ── Physical topology ───────────────────────────────────────────

/** Transfer mechanism between nodes */
export type TransferMechanism =
  | "robot_arm"
  | "conveyor"
  | "pneumatic"
  | "manual"
  | "gravity"
  | "same_device"
  | (string & {});

/** Labware/sample container type */
export type LabwareType =
  | "plate"
  | "vial"
  | "tube"
  | "chip"
  | "substrate"
  | "tray"
  | "custom"
  | (string & {});

/** A physical location in the kernel topology */
export interface TransferNode {
  id: Id;
  kernelId: Id;
  deviceId?: Id;
  label: string;
  nodeType: "instrument" | "station" | "staging" | "manual";
  capabilities: string[];
  position?: { x: number; y: number; z?: number };
  metadata?: Record<string, unknown>;
}

/** A valid physical path between two nodes */
export interface TransferEdge {
  id: Id;
  fromNode: Id;
  toNode: Id;
  mechanism: TransferMechanism;
  transferTimeMs: number;
  bidirectional: boolean;
  constraints?: {
    maxWeightKg?: number;
    labwareTypes?: LabwareType[];
    maxDimensionMm?: number;
  };
}

/** The physical topology of a kernel */
export interface TransferGraph {
  id: Id;
  kernelId: Id;
  nodes: TransferNode[];
  edges: TransferEdge[];
  createdAt: Timestamp;
  updatedAt?: Timestamp;
}

// ── Samples ─────────────────────────────────────────────────────

/** A trackable unit moving through instruments */
export interface Sample {
  id: Id;
  jobId: Id;
  label: string;
  labwareType: LabwareType;
  currentNodeId: Id;
  status: "created" | "in_transit" | "processing" | "idle" | "completed" | "failed";
  history: SampleMovement[];
  metadata?: Record<string, unknown>;
  createdAt: Timestamp;
}

/** Record of a sample moving between nodes */
export interface SampleMovement {
  id: Id;
  sampleId: Id;
  fromNodeId: Id;
  toNodeId: Id;
  mechanism: TransferMechanism;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  evidenceHash?: SHA256;
}

// ── Instrument workflows ────────────────────────────────────────

/** One operation at one instrument */
export interface InstrumentStep {
  id: Id;
  nodeId: Id;
  action: string;
  params: Record<string, unknown>;
  estimatedDurationMs: number;
  requiredLabware?: LabwareType;
  producesEvidence: boolean;
  dependsOn: Id[];
}

/** A sequence of steps across instruments (intra-kernel DAG) */
export interface InstrumentWorkflow {
  id: Id;
  kernelId: Id;
  jobId: Id;
  steps: InstrumentStep[];
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt?: Timestamp;
  completedAt?: Timestamp;
  error?: string;
}

// ── Resource management ─────────────────────────────────────────

/** A lock on an instrument */
export interface ResourceClaim {
  id: Id;
  nodeId: Id;
  claimedBy: Id;
  claimedAt: Timestamp;
  expiresAt?: Timestamp;
  released: boolean;
  releasedAt?: Timestamp;
}

// ── Events ──────────────────────────────────────────────────────

export type OrchestratorEventType =
  | "workflow_started"
  | "workflow_completed"
  | "workflow_failed"
  | "workflow_cancelled"
  | "step_started"
  | "step_completed"
  | "step_failed"
  | "sample_moved"
  | "resource_claimed"
  | "resource_released"
  | "resource_queued";

/** Orchestrator lifecycle event */
export interface OrchestratorEvent {
  id: Id;
  workflowId: Id;
  timestamp: Timestamp;
  type: OrchestratorEventType;
  sampleId?: Id;
  stepId?: Id;
  nodeId?: Id;
  payload: Record<string, unknown>;
}
