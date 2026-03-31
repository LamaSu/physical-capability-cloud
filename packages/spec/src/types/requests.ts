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
}
