/**
 * Composition engine — turns "outcome + budget + assurance tier" into a
 * sequenced DAG of capability instances ready for execution via @pcc/workflow.
 *
 * The composition engine is the keystone for PCC's agentic-composition layer.
 * Without it, capabilities exist as a directory; with it, an agent can request
 * "produce X within budget Y at tier Z" and receive a verifiable execution plan
 * composed from existing operator-bound capability instances.
 *
 * Companion to:
 *   - `/api/capabilities/*` — source of capability instances (per-operator)
 *   - `/api/tool-catalog/*` — tools that DO things, with or without operators
 *   - `@pcc/workflow` — durable execution of the composed DAG
 *   - `/api/escrow/*` — settles per-step payment as the DAG executes
 */

import { z } from "zod";

import type { Id, Timestamp } from "./common.js";
import type { AssuranceTier } from "./common.js";

// ---------------------------------------------------------------------------
// Optimization strategy
// ---------------------------------------------------------------------------

/**
 * Per-composition optimization target.
 *
 * - `price` — minimize total cost (default; price-takers in perfect competition)
 * - `speed` — minimize end-to-end wall-clock duration
 * - `quality` — maximize aggregate assurance tier + verifier reputation
 */
export type CompositionOptimization = "price" | "speed" | "quality";

/**
 * Geographic constraint for step routing.
 *
 * `radiusKm` defaults to 50; omit to allow any location matching `lat`/`lng` exactly.
 */
export interface LocationConstraint {
  lat: number;
  lng: number;
  radiusKm?: number;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Compose-engine input.
 *
 * Three modes:
 *   - Single-step: provide `outcomeType` only; engine returns the best
 *     capability instance of that type — falling back to capability
 *     graph-search if no direct provider matches.
 *   - Multi-step (explicit types): provide `steps` as an ordered list of
 *     capability types; engine returns one instance per step, sequenced.
 *   - Multi-step (graph chain): provide `outcomeChain` of outcome types; the
 *     engine delegates to graph-search's Dijkstra traversal to discover the
 *     cheapest multi-step path realizing the chain's final outcome.
 *
 * Full DAG-with-branching mode is planned for a future iteration; the
 * current scaffold is linear.
 */
export interface ComposeRequest {
  /** Final capability type the composition must deliver */
  outcomeType: string;
  /**
   * Optional ordered list of capability types if the outcome requires
   * multiple steps. Each entry is one capability type the engine resolves
   * to a specific instance. If absent, treated as a single-step composition
   * over `outcomeType`.
   */
  steps?: string[];
  /**
   * Optional ordered chain of OUTCOME types to thread through the capability
   * graph, e.g. `["synth", "purify", "assay"]`. When present (and non-empty),
   * the planner bypasses single-step provider matching and delegates to
   * graph-search: it targets the chain's FINAL element as the outcome type and
   * returns the cheapest multi-step path the graph can realize. The earlier
   * elements document the intended per-step outputs; the graph topology
   * (node input/output types + edges) must support the sequence. Absent
   * (default) → single-step / `steps` mode.
   */
  outcomeChain?: string[];
  /** Maximum total USD the engine may allocate across all steps */
  budgetUSD: number;
  /** Minimum assurance tier (0-3) every step must offer */
  minAssuranceTier: AssuranceTier;
  /** Optional location to bias capability selection */
  location?: LocationConstraint;
  /** Per-composition optimization target (default: price) */
  optimizeFor?: CompositionOptimization;
  /** Optional caller identity for attribution / dispute routing */
  requester?: {
    agentId: Id;
    did?: Id;
  };
  /** Free-form description for human-readable audit trails */
  description?: string;
}

export const LocationConstraintSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusKm: z.number().positive().max(20000).optional(),
});

export const ComposeRequestSchema = z.object({
  outcomeType: z.string().min(1).max(120),
  steps: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
  outcomeChain: z.array(z.string().min(1).max(120)).min(1).max(20).optional(),
  budgetUSD: z.number().positive().max(1_000_000_000),
  minAssuranceTier: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
  ]),
  location: LocationConstraintSchema.optional(),
  optimizeFor: z.enum(["price", "speed", "quality"] as const).default("price"),
  requester: z
    .object({
      agentId: z.string().min(1),
      did: z.string().min(1).optional(),
    })
    .optional(),
  description: z.string().min(1).max(4000).optional(),
});

// ---------------------------------------------------------------------------
// Candidate (input the engine considers when planning)
// ---------------------------------------------------------------------------

/**
 * A single capability instance available to the planner. The planner picks
 * one CompositionCandidate per step.
 *
 * In production this comes from `/api/capabilities` (CapabilityFacade).
 * In the scaffold + tests, candidates are registered in-memory.
 */
export interface CompositionCandidate {
  capabilityId: Id;
  kernelId: Id;
  operatorAddress: string;
  capabilityType: string;
  estimatedPriceUSD: number;
  estimatedDurationMs: number;
  assuranceTier: AssuranceTier;
  /** ERC-8004 reputation score 0-1000 if known */
  reputation?: number;
  /** Where the capability instance lives (for location filtering) */
  location?: { lat: number; lng: number };
  /** Whether the capability is currently accepting jobs */
  available: boolean;
  /**
   * Optional named resource requirements this candidate consumes when it runs
   * (e.g. `{ filamentGrams: 42, buildVolumeMm3: 18000 }`). Propagated onto the
   * planned {@link CompositionStep} so the orchestration-layer whole-plan
   * pre-flight gate can refuse an infeasible composed job before any step
   * executes. Absent = the step declares no resources and the gate skips it.
   */
  resourceRequirements?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/**
 * Status of a composition proposal.
 *
 * - `proposed` — plan ready; caller may inspect or execute
 * - `over_budget` — no valid path within budget
 * - `no_path_found` — no candidate covers one or more steps at the required tier
 */
export type CompositionStatus =
  | "proposed"
  | "over_budget"
  | "no_path_found";

/**
 * One step in the proposed DAG.
 */
export interface CompositionStep {
  /** 0-based ordinal in the linear DAG */
  index: number;
  /** The capability type this step delivers */
  capabilityType: string;
  /** Specific capability instance chosen by the planner */
  capabilityId: Id;
  kernelId: Id;
  operatorAddress: string;
  estimatedPriceUSD: number;
  estimatedDurationMs: number;
  assuranceTier: AssuranceTier;
  /** Indices of earlier steps this step depends on (empty for the first step) */
  dependsOn: number[];
  /** Optional reputation snapshot at planning time */
  reputation?: number;
  /**
   * Optional named resource requirements for this step (e.g.
   * `{ filamentGrams: 42, buildVolumeMm3: 18000 }`), propagated from the chosen
   * candidate / graph node at planning time. Consumed by the orchestration-layer
   * whole-plan pre-flight gate (`preflightComposition`), which calls the step
   * adapter's `preflight()` to hold capacity before execution. Absent = no
   * resource check for this step (the gate is a no-op for it — backward
   * compatible with every composition planned before this field existed).
   */
  resourceRequirements?: Record<string, number>;
}

/**
 * Compose-engine output. Compositions are stored server-side with a unique id
 * and an `expiresAt`; callers may GET them back or POST to execute.
 */
export interface ComposeResponse {
  compositionId: Id;
  status: CompositionStatus;
  steps: CompositionStep[];
  /** Sum of step prices */
  totalPriceUSD: number;
  /** Sum of step durations (linear DAG; parallel paths come later) */
  totalDurationMs: number;
  /** Minimum assurance tier across all chosen steps */
  effectiveAssuranceTier: AssuranceTier;
  /** Echoed from request */
  budgetUSD: number;
  /** `budgetUSD - totalPriceUSD` (negative if over budget; clamped to 0 in response) */
  budgetRemainingUSD: number;
  /** Echoed from request */
  optimizedFor: CompositionOptimization;
  /** ISO 8601 — server time at which this proposal expires (default: 30 min) */
  expiresAt: Timestamp;
  /** ISO 8601 — when the engine generated this proposal */
  proposedAt: Timestamp;
  /** Human-readable explanation when status != proposed */
  rejectionReason?: string;
}

// ---------------------------------------------------------------------------
// Execute (commits a composition to actual job execution)
// ---------------------------------------------------------------------------

/**
 * Caller's commit signal — turns a `proposed` composition into a running
 * workflow. In the scaffold this returns a stub workflow id; the real
 * integration with @pcc/workflow + per-step job submission lands as a
 * follow-on PR.
 */
export interface ExecuteCompositionRequest {
  compositionId: Id;
  /** Optional caller-supplied idempotency key */
  idempotencyKey?: string;
}

export const ExecuteCompositionRequestSchema = z.object({
  compositionId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(120).optional(),
});

/**
 * Response to executing a composition — the workflow has been queued.
 *
 * Per-step job ids land in the workflow's evidence channel as it progresses;
 * caller subscribes to SSE on the returned workflowId for live updates.
 */
export interface ExecuteCompositionResponse {
  compositionId: Id;
  workflowId: Id;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: Timestamp;
  /** Optional: pre-allocated per-step job ids if the engine chose to submit eagerly */
  stepJobIds?: Id[];
}

// ---------------------------------------------------------------------------
// Server-only helpers (admin / dev surface)
// ---------------------------------------------------------------------------

/**
 * Dev/test endpoint: pre-register a CompositionCandidate so the in-memory
 * provider can return it. Production wiring replaces the in-memory provider
 * with a CapabilityFacade-backed one and this surface goes away.
 */
export const RegisterCandidateRequestSchema = z.object({
  capabilityId: z.string().min(1),
  kernelId: z.string().min(1),
  operatorAddress: z.string().min(1),
  capabilityType: z.string().min(1),
  estimatedPriceUSD: z.number().nonnegative(),
  estimatedDurationMs: z.number().nonnegative(),
  assuranceTier: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
  ]),
  reputation: z.number().min(0).max(1000).optional(),
  location: z
    .object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .optional(),
  available: z.boolean().default(true),
  /** Optional per-step resource requirements, e.g. `{ filamentGrams: 42 }`. */
  resourceRequirements: z.record(z.number().nonnegative()).optional(),
});
