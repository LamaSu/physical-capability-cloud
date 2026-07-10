/**
 * Reputation propagation through compositions.
 *
 * The composition engine (separate PR) takes outcome + budget + tier and emits
 * a DAG of capability instances. When that DAG executes, EACH step's
 * operator/human earns a per-step reputation impact, and per-step disputes
 * propagate slashing WITHOUT nuking the whole composition.
 *
 * Without this layer a 5-step composition that fails at step 3 has no
 * accountability: the composer can't sue, successful contributors get no
 * credit, the market breaks. This file is the shared type surface for that
 * attribution + dispute layer.
 *
 * Scoring model (see packages/gateway/src/routes/reputation.ts for the live
 * defaults):
 *   - score ∈ [0, 1000], starts at 500 (neutral median).
 *   - step_completed         +10  (to the step's agent)
 *   - step_failed            -15  (to the step's agent)
 *   - dispute_upheld         -50  (to the disputed agent)
 *   - dispute_rejected        +5  (to the disputed agent, vindication)
 *                             -5  (to the disputer, frivolous penalty)
 *   - composition_completed   +5  (bonus to ALL participants when every step
 *                                  succeeds)
 *
 * No runtime crypto, no on-chain calls — safe to import from browser code.
 * The Zod schemas validate the four request bodies at the API boundary.
 */

import { z } from "zod";
import type { Id, Timestamp } from "./common.js";

// ---------------------------------------------------------------------------
// Agent reputation
// ---------------------------------------------------------------------------

/**
 * The kinds of actor that accrue reputation inside a composition.
 *
 * - `operator-kernel` — a physical site fulfilling a capability step.
 * - `human-skill`     — a human contributing a skill-graded step.
 * - `asset-agent`     — an autonomous asset (robot/instrument) acting as agent.
 * - `verifier`        — an attestor grading another step's evidence.
 * - `composer`        — the agent that assembled the composition.
 */
export type ReputationAgentKind =
  | "operator-kernel"
  | "human-skill"
  | "asset-agent"
  | "verifier"
  | "composer";

/**
 * The running reputation state for a single agent.
 *
 * `score` is a clamped 0-1000 integer that starts at 500 (neutral). The
 * contribution / dispute counters are monotonic tallies kept alongside the
 * score so downstream UIs can show *why* a score moved without replaying the
 * full delta log.
 */
export interface AgentReputation {
  agentId: Id;
  kind: ReputationAgentKind;
  /** 0-1000, starts at 500 (neutral median) */
  score: number;
  positiveContributions: number;
  negativeContributions: number;
  disputesUpheld: number;
  disputesRejected: number;
  lastUpdatedAt: Timestamp;
}

/**
 * A single signed adjustment to an agent's reputation.
 *
 * Deltas are the append-only audit trail behind every `score` change. The
 * `reason` discriminates what produced the adjustment; the optional
 * composition / step / evidence fields tie it back to the work that caused it.
 */
export interface ReputationDelta {
  deltaId: Id;
  agentId: Id;
  /** signed; rep is clamped 0-1000 after applying */
  delta: number;
  reason:
    | "step_completed"
    | "step_failed"
    | "dispute_upheld"
    | "dispute_rejected"
    | "composition_completed"
    | "manual_adjustment";
  compositionId?: Id;
  stepIndex?: number;
  evidenceBundleId?: Id;
  appliedAt: Timestamp;
  /** who/what initiated this delta */
  appliedBy?: Id;
  note?: string;
}

// ---------------------------------------------------------------------------
// Step outcomes
// ---------------------------------------------------------------------------

export type StepOutcomeStatus =
  | "success"
  | "failed"
  | "disputed"
  | "abandoned"
  /**
   * The step's job has been submitted (acked) but physical completion has not
   * yet arrived, so no reputation delta may be applied. Real-execution mode
   * records this at ack and defers the +10/-15 to the completion path (see
   * gateway `settleStepReputationForJob`). `finalizeReputation` skips it (it
   * only settles `success`/`failed`) and the composition bonus is naturally
   * withheld while any step is still `pending`.
   */
  | "pending";

/**
 * The recorded result of executing one step of a composition.
 *
 * Persisted in `pending` reputation state (`finalReputationApplied=false`).
 * The composition engine POSTs one of these per step as it completes, then
 * POSTs `finalize-reputation` once at workflow finish to settle the deltas.
 */
export interface CompositionStepOutcome {
  outcomeId: Id;
  compositionId: Id;
  stepIndex: number;
  capabilityId: Id;
  /** who performed the step (kernel/human) */
  agentId: Id;
  status: StepOutcomeStatus;
  evidenceBundleId?: Id;
  startedAt: Timestamp;
  completedAt?: Timestamp;
  /** null until finalized */
  reputationDelta?: number;
  finalReputationApplied: boolean;
}

// ---------------------------------------------------------------------------
// Step disputes
// ---------------------------------------------------------------------------

export type DisputeStatus = "pending" | "upheld" | "rejected" | "withdrawn";

/**
 * A dispute filed against one step of a composition.
 *
 * Per-step scoping is the whole point: resolving a dispute slashes the
 * disputed step's agent without touching the other steps' contributors. The
 * `reputationDeltasApplied` array records every delta spawned by the
 * resolution so the slashing is fully auditable.
 */
export interface CompositionStepDispute {
  disputeId: Id;
  compositionId: Id;
  stepIndex: number;
  disputerId: Id;
  reason:
    | "evidence_invalid"
    | "wrong_output"
    | "timeout"
    | "spec_violation"
    | "fraud"
    | "other";
  description: string;
  evidence?: { bundleId?: Id; notes?: string };
  status: DisputeStatus;
  filedAt: Timestamp;
  resolvedAt?: Timestamp;
  resolverId?: Id;
  resolutionNote?: string;
  /** deltaIds spawned by this dispute */
  reputationDeltasApplied: Id[];
}

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface RecordStepOutcomeRequest {
  compositionId: Id;
  stepIndex: number;
  capabilityId: Id;
  agentId: Id;
  status: StepOutcomeStatus;
  evidenceBundleId?: Id;
  startedAt: Timestamp;
  completedAt?: Timestamp;
}

export interface FileDisputeRequest {
  disputerId: Id;
  stepIndex: number;
  reason:
    | "evidence_invalid"
    | "wrong_output"
    | "timeout"
    | "spec_violation"
    | "fraud"
    | "other";
  description: string;
  evidence?: { bundleId?: Id; notes?: string };
}

export interface ResolveDisputeRequest {
  resolverId: Id;
  decision: "upheld" | "rejected";
  resolutionNote: string;
}

export interface FinalizeCompositionReputationRequest {
  finalizerId: Id;
}

export interface FinalizeCompositionReputationResponse {
  compositionId: Id;
  stepsFinalized: number;
  deltasApplied: ReputationDelta[];
  affectedAgents: Id[];
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const ReputationAgentKindSchema = z.enum([
  "operator-kernel",
  "human-skill",
  "asset-agent",
  "verifier",
  "composer",
]);

export const StepOutcomeStatusSchema = z.enum([
  "success",
  "failed",
  "disputed",
  "abandoned",
  "pending",
]);

export const DisputeStatusSchema = z.enum([
  "pending",
  "upheld",
  "rejected",
  "withdrawn",
]);

export const DisputeReasonSchema = z.enum([
  "evidence_invalid",
  "wrong_output",
  "timeout",
  "spec_violation",
  "fraud",
  "other",
]);

export const ReputationDeltaReasonSchema = z.enum([
  "step_completed",
  "step_failed",
  "dispute_upheld",
  "dispute_rejected",
  "composition_completed",
  "manual_adjustment",
]);

const DisputeEvidenceSchema = z
  .object({
    bundleId: z.string().min(1).optional(),
    notes: z.string().optional(),
  })
  .optional();

export const RecordStepOutcomeSchema = z.object({
  compositionId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  capabilityId: z.string().min(1),
  agentId: z.string().min(1),
  status: StepOutcomeStatusSchema,
  evidenceBundleId: z.string().min(1).optional(),
  startedAt: z.string().min(1),
  completedAt: z.string().min(1).optional(),
});

export const FileDisputeSchema = z.object({
  disputerId: z.string().min(1),
  stepIndex: z.number().int().nonnegative(),
  reason: DisputeReasonSchema,
  description: z.string().min(1),
  evidence: DisputeEvidenceSchema,
});

export const ResolveDisputeSchema = z.object({
  resolverId: z.string().min(1),
  decision: z.enum(["upheld", "rejected"]),
  resolutionNote: z.string().min(1),
});

export const FinalizeCompositionReputationSchema = z.object({
  finalizerId: z.string().min(1),
});
