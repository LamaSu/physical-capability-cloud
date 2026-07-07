/**
 * Capability Graph Search — types + Zod schemas.
 *
 * The composition engine (separate PR) answers "find me instances for THIS
 * step sequence". Graph search goes one level up: given a target outcome, a
 * budget, and constraints, it traverses the capability graph and returns the
 * top-N cheapest-verified composition PATHS — it discovers the step sequence
 * for you.
 *
 * The graph is bipartite-ish at the type level: every node (a capability
 * instance) consumes a set of input capability-types and produces a set of
 * output capability-types. An edge A→B exists when A's output type can be
 * handed off to B's input type (`capabilityTypeFlow`), with an optional
 * transfer cost (0 for pure-digital flows, non-zero for physical logistics).
 *
 * A "search" runs a Dijkstra-style shortest-path over this graph where the
 * edge weight is derived from `optimizeFor` (price | speed | quality |
 * reputation). Results are stored as short-lived proposals (30-min TTL) that
 * an agent can retrieve by id and — once PR #88 lands — feed straight into a
 * Workflow run for execution.
 *
 * This file is pure types + validation schemas (no runtime side effects), so
 * it is safe to import from browser code as well as the gateway.
 */

import { z } from "zod";
import type { Id, Timestamp } from "./common.js";

/** What the search optimises for. Lower composite score is always better. */
export type GraphSearchOptimization = "price" | "speed" | "quality" | "reputation";

export interface CapabilityGraphNode {
  capabilityId: Id;
  capabilityType: string;
  kernelId: Id;
  operatorAddress?: string;
  estimatedPriceUSD: number;
  estimatedDurationMs: number;
  assuranceTier: 0 | 1 | 2 | 3;
  reputation: number;                       // 0-1000
  location?: { lat: number; lng: number };
  available: boolean;
  /** Capability types this node consumes as input */
  inputTypes: string[];
  /** Capability types this node produces */
  outputTypes: string[];
  /**
   * Optional named resource requirements this node consumes per run (e.g.
   * `{ filamentGrams: 42 }`). Flows through graph-planned paths onto the
   * CompositionStep for the pre-flight gate. Absent = no resource declaration.
   */
  resourceRequirements?: Record<string, number>;
}

export interface CapabilityGraphEdge {
  fromCapabilityId: Id;
  toCapabilityId: Id;
  capabilityTypeFlow: string;               // the output→input type that bridges them
  estimatedHandoffPriceUSD: number;         // transfer cost (0 for pure-digital flows)
  estimatedHandoffDurationMs: number;
}

export interface GraphSearchRequest {
  outcomeType: string;                       // capability type the final node must produce
  budgetUSD: number;
  minAssuranceTier: 0 | 1 | 2 | 3;
  minReputation?: number;
  location?: { lat: number; lng: number; radiusKm?: number };
  optimizeFor?: GraphSearchOptimization;     // default 'price'
  /** Optional input seed type — search starts from a node that consumes this type */
  startInputType?: string;
  /** Maximum hops in the path. Default 5. */
  maxDepth?: number;
  /** Number of distinct top paths to return. Default 5. */
  topN?: number;
  requester?: { agentId: Id };
}

export interface GraphPathStep {
  capabilityId: Id;
  capabilityType: string;
  kernelId: Id;
  estimatedPriceUSD: number;
  estimatedDurationMs: number;
  assuranceTier: 0 | 1 | 2 | 3;
  reputation: number;
  /**
   * Optional named resource requirements this step consumes (e.g.
   * `{ filamentGrams: 42 }`), carried from the graph node. Propagated onto the
   * planned CompositionStep so the composition-layer pre-flight gate can check
   * it. Absent = no resource declaration (gate skips this step).
   */
  resourceRequirements?: Record<string, number>;
}

export interface GraphPathOption {
  pathId: Id;
  steps: GraphPathStep[];
  totalPriceUSD: number;
  totalDurationMs: number;
  minAssuranceTier: 0 | 1 | 2 | 3;
  avgReputation: number;
  compositeScore: number;                    // optimization-dependent score; LOWER is better
}

export interface GraphSearchResponse {
  searchId: Id;
  outcomeType: string;
  optimizedFor: GraphSearchOptimization;
  options: GraphPathOption[];
  searchStats: {
    nodesExplored: number;
    edgesExplored: number;
    durationMs: number;
    cappedAtMaxDepth: boolean;
    cappedAtBudget: boolean;
  };
  proposedAt: Timestamp;
  expiresAt: Timestamp;
}

export interface GraphStatsResponse {
  nodeCount: number;
  edgeCount: number;
  capabilityTypeCount: number;
  capabilityTypes: string[];
  lastRebuiltAt: Timestamp | null;
}

export interface RegisterGraphNodeRequest {
  capabilityId: Id;
  capabilityType: string;
  kernelId: Id;
  operatorAddress?: string;
  estimatedPriceUSD: number;
  estimatedDurationMs: number;
  assuranceTier: 0 | 1 | 2 | 3;
  reputation?: number;
  location?: { lat: number; lng: number };
  available?: boolean;
  inputTypes?: string[];
  outputTypes?: string[];
  resourceRequirements?: Record<string, number>;
}

export interface RegisterGraphEdgeRequest {
  fromCapabilityId: Id;
  toCapabilityId: Id;
  capabilityTypeFlow: string;
  estimatedHandoffPriceUSD?: number;
  estimatedHandoffDurationMs?: number;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/** AssuranceTier zod schema. Inlined because common.ts only exports the TS
 *  union type, not a runtime schema. Must match `AssuranceTier`: 0 | 1 | 2 | 3. */
const AssuranceTierSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const GraphSearchOptimizationSchema = z.enum([
  "price",
  "speed",
  "quality",
  "reputation",
]);

const LatLngSchema = z.object({
  lat: z.number(),
  lng: z.number(),
});

export const GraphSearchRequestSchema = z.object({
  outcomeType: z.string().min(1),
  budgetUSD: z.number().positive(),
  minAssuranceTier: AssuranceTierSchema,
  minReputation: z.number().min(0).max(1000).optional(),
  location: LatLngSchema.extend({
    radiusKm: z.number().positive().optional(),
  }).optional(),
  optimizeFor: GraphSearchOptimizationSchema.optional(),
  startInputType: z.string().min(1).optional(),
  maxDepth: z.number().int().positive().optional(),
  topN: z.number().int().positive().optional(),
  requester: z.object({ agentId: z.string().min(1) }).optional(),
});

export const RegisterGraphNodeSchema = z.object({
  capabilityId: z.string().min(1),
  capabilityType: z.string().min(1),
  kernelId: z.string().min(1),
  operatorAddress: z.string().optional(),
  estimatedPriceUSD: z.number().nonnegative(),
  estimatedDurationMs: z.number().nonnegative(),
  assuranceTier: AssuranceTierSchema,
  reputation: z.number().min(0).max(1000).optional(),
  location: LatLngSchema.optional(),
  available: z.boolean().optional(),
  inputTypes: z.array(z.string()).optional(),
  outputTypes: z.array(z.string()).optional(),
  resourceRequirements: z.record(z.number().nonnegative()).optional(),
});

export const RegisterGraphEdgeSchema = z.object({
  fromCapabilityId: z.string().min(1),
  toCapabilityId: z.string().min(1),
  capabilityTypeFlow: z.string().min(1),
  estimatedHandoffPriceUSD: z.number().nonnegative().optional(),
  estimatedHandoffDurationMs: z.number().nonnegative().optional(),
});

/** Inferred request types — handy for handlers that want the post-parse shape. */
export type GraphSearchRequestInput = z.infer<typeof GraphSearchRequestSchema>;
export type RegisterGraphNodeInput = z.infer<typeof RegisterGraphNodeSchema>;
export type RegisterGraphEdgeInput = z.infer<typeof RegisterGraphEdgeSchema>;
