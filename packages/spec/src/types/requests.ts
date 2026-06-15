/**
 * Request Decomposition System Types
 *
 * Supports high-level requests that are decomposed into a capability DAG
 * with dependencies, timelines, and budget allocation.
 */

export type RequestStatus =
  | "draft"
  | "decomposing"
  | "published"
  | "in_progress"
  | "completed"
  | "cancelled";

export type CapabilityNodeStatus =
  | "pending"
  | "bidding"
  | "assigned"
  | "in_progress"
  | "completed"
  | "failed";

export interface CapabilityRequest {
  id: string;
  title: string;
  description: string;
  requesterEmail?: string;
  requesterWallet?: string;
  budget: number;
  currency: string;
  deadline: string;
  urgency: "standard" | "rush" | "emergency";
  status: RequestStatus;
  capabilityDag: CapabilityNode[];
  totalEstimatedCost: number;
  totalEstimatedHours: number;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityNode {
  id: string;
  requestId: string;
  name: string;
  description: string;
  capabilityType: string;
  category: string;
  estimatedCost: number;
  estimatedHours: number;
  dependencies: string[];
  parallel: boolean;
  status: CapabilityNodeStatus;
  assignedOperator?: string;
  bountyId?: string;
  materials: MaterialRequirement[];
  evidenceRequirements: string[];
  /**
   * Matched capability id from the registry, set by the agentic decomposer when
   * a concrete capability satisfies this node. Absent when match:none — the
   * node still stands as the desired step, awaiting an operator/capability
   * to fulfill via the bounty flow.
   */
  matchedCapabilityId?: string;
  /** Kernel that owns the matched capability (mirrored for convenience). */
  matchedKernelId?: string;
  /** How many units of the matched capability are needed (drives cost derivation). */
  quantity?: number;
  /** "agentic" when produced by the LLM decomposer, "template" for legacy fallback. */
  decompositionSource?: "agentic" | "template";
}

export interface MaterialRequirement {
  name: string;
  quantity: number;
  unit: string;
  estimatedCost: number;
  marketplaceCategory?: string;
}

export interface DecompositionResult {
  nodes: CapabilityNode[];
  totalEstimatedCost: number;
  totalEstimatedHours: number;
  criticalPath: string[];
  parallelTracks: string[][];
  /** Which decomposer produced this result. Defaults to "template" when absent. */
  source?: "agentic" | "template";
  /** Total node count whose capabilityType matched a live capability in the registry. */
  matchCount?: number;
  /** Aggregate evidence requirements across all matched capability nodes (deduped). */
  evidenceRequirements?: string[];
}
