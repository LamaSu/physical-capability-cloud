/**
 * Request Decomposition System Types
 *
 * Supports high-level requests that are decomposed into a capability DAG
 * with dependencies, timelines, and budget allocation.
 */

export type RequestStatus =
  | "draft"
  | "decomposing"
  // Decomposed into a capability DAG (nodes matched to registered
  // capabilities) but NOT yet published as bounties. This is the resting
  // state after POST /api/requests and /decompose — publishing is an
  // explicit, separate step (POST /api/requests/:id/publish).
  | "decomposed"
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
  // ── Capability matching (agentic decompose) ──────────────────────────────
  // Each node is matched to a registered capability instance so the request
  // can be priced and have its evidence requirements derived from the real
  // capability rather than a hardcoded template. `matchStatus` is "matched"
  // when a capability was found, "none" otherwise. Absent === "none" for
  // rows persisted before this field existed.
  matchStatus?: "matched" | "none";
  /** ID of the registered capability instance this node was matched to. */
  matchedCapabilityId?: string;
  /**
   * 0x + 64 hex. SHA-256 over the DEAL SNAPSHOT the match was made against —
   * {capabilityId, capabilityType, kernelId, price, currency, assuranceTiers}.
   * `matchedCapabilityId` is mutable (a capability row can be edited
   * underneath a plan); this is what a commitment binds to instead. It
   * answers "did the thing I matched change underneath me". It is NOT
   * `capabilityContractDigest` (the resolved-CSD identity) — capability rows
   * carry no CSD reference today, so that join does not exist. Consumers:
   * composition's compositionRoot guard, bridge's job-offer producer.
   */
  matchedCapabilityDigest?: string;
  /** Display name of the matched capability (e.g. "Marios Pizzeria"). */
  matchedCapabilityName?: string;
  /** Kernel that offers the matched capability. */
  matchedKernelId?: string;
  /** Match confidence in [0,1] from the semantic matcher. */
  matchScore?: number;
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
  /** How many nodes were matched to a registered capability. */
  matchedCount?: number;
  /**
   * Budget derived from the matched capabilities' prices (sum of each matched
   * node's price). Undefined when nothing matched. The route uses this when
   * the requester did not supply an explicit budget — replacing the old
   * hardcoded 1000 default.
   */
  derivedBudget?: number;
  /** True when an LLM produced the step plan (vs the offline heuristic). */
  usedLLM?: boolean;
  /** True when the engine fell back to the legacy keyword templates. */
  usedFallback?: boolean;
}
