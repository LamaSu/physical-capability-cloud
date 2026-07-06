/**
 * Reputation propagation through compositions — gateway routes.
 *
 * The per-step attribution + dispute layer that gates payment in
 * agentic-composition workflows. When a composition executes, each step's
 * operator/human gets a per-step reputation impact, and per-step disputes
 * propagate slashing without nuking the whole composition.
 *
 *   GET  /api/reputation/:agentId                       — state + last 20 deltas
 *   GET  /api/reputation/:agentId/deltas                — paginated delta history
 *   GET  /api/reputation/leaderboard                    — top agents by score
 *   POST /api/compositions/:compositionId/step-outcome  — record a step result
 *   GET  /api/compositions/:compositionId/step-outcomes — list step outcomes
 *   POST /api/compositions/:compositionId/disputes      — file a step dispute
 *   GET  /api/compositions/:compositionId/disputes      — list step disputes
 *   POST /api/disputes/:disputeId/resolve               — resolve (apply deltas)
 *   POST /api/compositions/:compositionId/finalize-reputation — settle all deltas
 *
 * Storage is SQLite via @pcc/store (agent_reputations + reputation_deltas +
 * composition_step_outcomes + composition_step_disputes), following the
 * marketplace / requests persistence pattern. State survives gateway redeploys.
 * The composition engine (PR #88) calls the in-process `recordStepOutcome` on
 * each step completion and `finalizeReputation` at workflow finish.
 *
 * Scoring defaults: score ∈ [0, 1000], starts at 500 (neutral). step_completed
 * +10, step_failed -15, dispute_upheld -50 (disputed agent), dispute_rejected
 * +5 (disputed agent) / -5 (frivolous disputer), composition_completed +5 to
 * all participants when every step succeeds.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  RecordStepOutcomeSchema,
  FileDisputeSchema,
  ResolveDisputeSchema,
  FinalizeCompositionReputationSchema,
  ReputationAgentKindSchema,
  type AgentReputation,
  type ReputationAgentKind,
  type ReputationDelta,
  type RecordStepOutcomeRequest,
  type CompositionStepOutcome,
  type CompositionStepDispute,
  type FinalizeCompositionReputationResponse,
} from "@pcc/spec";
import { z } from "zod";
import { schema, eq, and, desc } from "@pcc/store";
import { getStore, initStore, getRepos } from "../db.js";

// ---------------------------------------------------------------------------
// Store access — see compose.ts for the lazy-init rationale.
// ---------------------------------------------------------------------------

function db() {
  try {
    return getStore().db;
  } catch {
    if (
      (process.env.VITEST || process.env.NODE_ENV === "test") &&
      !process.env.PCC_DB_PATH &&
      !process.env.DATABASE_URL
    ) {
      process.env.PCC_DB_PATH = ":memory:";
    }
    return initStore({ seed: false }).db;
  }
}

/** Repository access with the same lazy-init fallback as {@link db}. Used by the
 *  completion seam to read a job's `parameters.__pccStep` bridge. */
function reposOrInit() {
  try {
    return getRepos();
  } catch {
    if (
      (process.env.VITEST || process.env.NODE_ENV === "test") &&
      !process.env.PCC_DB_PATH &&
      !process.env.DATABASE_URL
    ) {
      process.env.PCC_DB_PATH = ":memory:";
    }
    initStore({ seed: false });
    return getRepos();
  }
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const STARTING_SCORE = 500; // neutral median
const MIN_SCORE = 0;
const MAX_SCORE = 1000;

const STEP_COMPLETED_DELTA = 10;
const STEP_FAILED_DELTA = -15;
const DISPUTE_UPHELD_DELTA = -50; // applied to the disputed agent
const DISPUTE_REJECTED_VINDICATION_DELTA = 5; // to the disputed (vindicated) agent
const DISPUTE_REJECTED_FRIVOLOUS_DELTA = -5; // to the disputer (frivolous filing)
const COMPOSITION_COMPLETED_DELTA = 5; // bonus to each participant

/** Kind assumed when an agent is first referenced without a declared kind. */
const DEFAULT_AGENT_KIND: ReputationAgentKind = "operator-kernel";
/** How many recent deltas the single-agent view returns. */
const RECENT_DELTAS_LIMIT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = (): string => new Date().toISOString();

function clampScore(score: number): number {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));
}

// ── agent_reputations ──────────────────────────────────────────────────

/** Map a DB row to the public AgentReputation (drops the created_at column). */
function loadReputation(agentId: string): AgentReputation | undefined {
  const row = db()
    .select()
    .from(schema.agentReputations)
    .where(eq(schema.agentReputations.agentId, agentId))
    .get();
  if (!row) return undefined;
  return {
    agentId: row.agentId,
    kind: row.kind as ReputationAgentKind,
    score: row.score,
    positiveContributions: row.positiveContributions,
    negativeContributions: row.negativeContributions,
    disputesUpheld: row.disputesUpheld,
    disputesRejected: row.disputesRejected,
    lastUpdatedAt: row.lastUpdatedAt,
  };
}

function loadAllReputations(): AgentReputation[] {
  const rows = db().select().from(schema.agentReputations).all();
  return rows.map((row) => ({
    agentId: row.agentId,
    kind: row.kind as ReputationAgentKind,
    score: row.score,
    positiveContributions: row.positiveContributions,
    negativeContributions: row.negativeContributions,
    disputesUpheld: row.disputesUpheld,
    disputesRejected: row.disputesRejected,
    lastUpdatedAt: row.lastUpdatedAt,
  }));
}

/** Idempotent upsert of a reputation row. created_at is preserved on update. */
function saveReputation(rep: AgentReputation): void {
  const cols = {
    kind: rep.kind,
    score: rep.score,
    positiveContributions: rep.positiveContributions,
    negativeContributions: rep.negativeContributions,
    disputesUpheld: rep.disputesUpheld,
    disputesRejected: rep.disputesRejected,
    lastUpdatedAt: rep.lastUpdatedAt,
  };
  db()
    .insert(schema.agentReputations)
    .values({ agentId: rep.agentId, createdAt: now(), ...cols })
    .onConflictDoUpdate({ target: schema.agentReputations.agentId, set: cols })
    .run();
}

/**
 * Fetch an agent's reputation, lazily initializing it at the neutral starting
 * score on first reference (persisted immediately, mirroring the in-memory
 * Map's set-on-init). Returns a fresh object each call — callers that mutate it
 * must call {@link saveReputation} to persist.
 */
export function getOrInitReputation(
  agentId: string,
  kind: ReputationAgentKind = DEFAULT_AGENT_KIND,
): AgentReputation {
  const existing = loadReputation(agentId);
  if (existing) return existing;

  const fresh: AgentReputation = {
    agentId,
    kind,
    score: STARTING_SCORE,
    positiveContributions: 0,
    negativeContributions: 0,
    disputesUpheld: 0,
    disputesRejected: 0,
    lastUpdatedAt: now(),
  };
  saveReputation(fresh);
  return fresh;
}

/** Optional context attached to a reputation delta. */
interface DeltaContext {
  compositionId?: string;
  stepIndex?: number;
  evidenceBundleId?: string;
  appliedBy?: string;
  note?: string;
  kind?: ReputationAgentKind;
}

/**
 * Atomically apply a signed delta to an agent's reputation: lazy-init the
 * agent, bump the relevant contribution counter, clamp the new score to
 * [0, 1000], persist a ReputationDelta, and return it.
 */
export function applyDelta(
  agentId: string,
  delta: number,
  reason: ReputationDelta["reason"],
  context: DeltaContext = {},
): ReputationDelta {
  const rep = getOrInitReputation(agentId, context.kind);

  if (delta > 0) rep.positiveContributions += 1;
  else if (delta < 0) rep.negativeContributions += 1;

  rep.score = clampScore(rep.score + delta);
  rep.lastUpdatedAt = now();
  saveReputation(rep);

  const record: ReputationDelta = {
    deltaId: randomUUID(),
    agentId,
    delta,
    reason,
    compositionId: context.compositionId,
    stepIndex: context.stepIndex,
    evidenceBundleId: context.evidenceBundleId,
    appliedAt: now(),
    appliedBy: context.appliedBy,
    note: context.note,
  };
  insertDelta(record);
  return record;
}

function insertDelta(record: ReputationDelta): void {
  db()
    .insert(schema.reputationDeltas)
    .values({
      deltaId: record.deltaId,
      agentId: record.agentId,
      delta: record.delta,
      reason: record.reason,
      compositionId: record.compositionId ?? null,
      stepIndex: record.stepIndex ?? null,
      appliedAt: record.appliedAt,
      createdAt: now(),
      data: record,
    })
    .run();
}

/** All deltas for an agent, newest-first (descending insertion order). */
function deltasForAgent(agentId: string): ReputationDelta[] {
  const rows = db()
    .select()
    .from(schema.reputationDeltas)
    .where(eq(schema.reputationDeltas.agentId, agentId))
    .orderBy(desc(schema.reputationDeltas.seq))
    .all();
  return rows.map((r) => r.data as ReputationDelta);
}

/** True once a composition_completed bonus has been recorded for a composition. */
function bonusApplied(compositionId: string): boolean {
  const row = db()
    .select({ seq: schema.reputationDeltas.seq })
    .from(schema.reputationDeltas)
    .where(
      and(
        eq(schema.reputationDeltas.compositionId, compositionId),
        eq(schema.reputationDeltas.reason, "composition_completed"),
      ),
    )
    .get();
  return !!row;
}

// ── composition_step_outcomes ──────────────────────────────────────────

/** All outcomes for a composition, ordered by stepIndex ascending. */
function outcomesForComposition(compositionId: string): CompositionStepOutcome[] {
  const rows = db()
    .select()
    .from(schema.compositionStepOutcomes)
    .where(eq(schema.compositionStepOutcomes.compositionId, compositionId))
    .orderBy(schema.compositionStepOutcomes.stepIndex)
    .all();
  return rows.map((r) => r.data as CompositionStepOutcome);
}

function getOutcomeByStep(
  compositionId: string,
  stepIndex: number,
): CompositionStepOutcome | undefined {
  const row = db()
    .select()
    .from(schema.compositionStepOutcomes)
    .where(
      and(
        eq(schema.compositionStepOutcomes.compositionId, compositionId),
        eq(schema.compositionStepOutcomes.stepIndex, stepIndex),
      ),
    )
    .get();
  return row ? (row.data as CompositionStepOutcome) : undefined;
}

/** Upsert an outcome by outcomeId (reused across the (comp, step) idempotency). */
function saveOutcome(outcome: CompositionStepOutcome): void {
  const cols = {
    compositionId: outcome.compositionId,
    stepIndex: outcome.stepIndex,
    agentId: outcome.agentId,
    capabilityId: outcome.capabilityId,
    status: outcome.status,
    finalReputationApplied: outcome.finalReputationApplied,
    data: outcome,
  };
  db()
    .insert(schema.compositionStepOutcomes)
    .values({ outcomeId: outcome.outcomeId, createdAt: now(), ...cols })
    .onConflictDoUpdate({ target: schema.compositionStepOutcomes.outcomeId, set: cols })
    .run();
}

// ── composition_step_disputes ──────────────────────────────────────────

function getDispute(disputeId: string): CompositionStepDispute | undefined {
  const row = db()
    .select()
    .from(schema.compositionStepDisputes)
    .where(eq(schema.compositionStepDisputes.disputeId, disputeId))
    .get();
  return row ? (row.data as CompositionStepDispute) : undefined;
}

function listDisputesForComposition(compositionId: string): CompositionStepDispute[] {
  const rows = db()
    .select()
    .from(schema.compositionStepDisputes)
    .where(eq(schema.compositionStepDisputes.compositionId, compositionId))
    .all();
  return rows.map((r) => r.data as CompositionStepDispute);
}

function saveDispute(dispute: CompositionStepDispute): void {
  const cols = {
    compositionId: dispute.compositionId,
    stepIndex: dispute.stepIndex,
    disputerDid: dispute.disputerId,
    status: dispute.status,
    resolution: dispute.resolutionNote ?? null,
    resolvedAt: dispute.resolvedAt ?? null,
    data: dispute,
  };
  db()
    .insert(schema.compositionStepDisputes)
    .values({ disputeId: dispute.disputeId, createdAt: dispute.filedAt, ...cols })
    .onConflictDoUpdate({ target: schema.compositionStepDisputes.disputeId, set: cols })
    .run();
}

// ---------------------------------------------------------------------------
// Composition lifecycle helpers (callable in-process; HTTP routes delegate here)
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link recordStepOutcome}. `ok: false` means the step's reputation
 * was already settled by a prior finalize and the recorded outcome is immutable
 * — the HTTP route maps this to a 409.
 */
export type RecordStepOutcomeResult =
  | { ok: true; outcome: CompositionStepOutcome }
  | { ok: false; reason: "outcome_finalized"; outcome: CompositionStepOutcome };

/**
 * Record (or idempotently replace) a single step's outcome — the callable form
 * of `POST /api/compositions/:id/step-outcome`. Identical logic: refuse to
 * overwrite a finalized outcome, otherwise upsert keyed on
 * `(compositionId, stepIndex)` and leave the reputation delta un-applied until
 * {@link finalizeReputation} settles it.
 *
 * Used in-process by the composition engine's `executeComposition` so a running
 * composition drives the same per-step bookkeeping as the HTTP API.
 */
export function recordStepOutcome(
  input: RecordStepOutcomeRequest,
): RecordStepOutcomeResult {
  const { compositionId, stepIndex } = input;

  const existing = getOutcomeByStep(compositionId, stepIndex);
  if (existing && existing.finalReputationApplied) {
    // Reputation already settled for this step — refuse to overwrite.
    return { ok: false, reason: "outcome_finalized", outcome: existing };
  }

  // Idempotent on (compositionId, stepIndex): replace in place if a
  // non-finalized outcome already exists, otherwise create a new one.
  const outcome: CompositionStepOutcome = {
    outcomeId: existing?.outcomeId ?? randomUUID(),
    compositionId,
    stepIndex,
    capabilityId: input.capabilityId,
    agentId: input.agentId,
    status: input.status,
    evidenceBundleId: input.evidenceBundleId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    reputationDelta: undefined,
    finalReputationApplied: false,
  };
  saveOutcome(outcome);
  return { ok: true, outcome };
}

/**
 * Settle every not-yet-finalized step of a composition — the callable form of
 * `POST /api/compositions/:id/finalize-reputation`. Applies `step_completed`
 * (+10) / `step_failed` (-15) per step, then a one-time `composition_completed`
 * (+5) bonus to each participant when EVERY step succeeded.
 *
 * Idempotent: outcomes carry `finalReputationApplied` and the bonus is guarded
 * by a recorded composition_completed delta, so a second call applies nothing.
 * Returns the deltas applied during this call (empty array on a no-op re-finalize).
 */
export function finalizeReputation(
  compositionId: string,
  finalizerId?: string,
): ReputationDelta[] {
  const compOutcomes = outcomesForComposition(compositionId);
  const deltasApplied: ReputationDelta[] = [];

  for (const outcome of compOutcomes) {
    if (outcome.finalReputationApplied) continue;

    if (outcome.status === "success") {
      deltasApplied.push(
        applyDelta(outcome.agentId, STEP_COMPLETED_DELTA, "step_completed", {
          compositionId,
          stepIndex: outcome.stepIndex,
          evidenceBundleId: outcome.evidenceBundleId,
          appliedBy: finalizerId,
        }),
      );
      outcome.reputationDelta = STEP_COMPLETED_DELTA;
      outcome.finalReputationApplied = true;
      saveOutcome(outcome);
    } else if (outcome.status === "failed") {
      deltasApplied.push(
        applyDelta(outcome.agentId, STEP_FAILED_DELTA, "step_failed", {
          compositionId,
          stepIndex: outcome.stepIndex,
          evidenceBundleId: outcome.evidenceBundleId,
          appliedBy: finalizerId,
        }),
      );
      outcome.reputationDelta = STEP_FAILED_DELTA;
      outcome.finalReputationApplied = true;
      saveOutcome(outcome);
    }
    // 'disputed' / 'abandoned' steps get no immediate delta — they wait for
    // dispute resolution and are intentionally left un-finalized.
  }

  // Bonus: when EVERY step succeeded (and the bonus has not already been paid
  // for this composition), credit every participant once.
  if (
    compOutcomes.length > 0 &&
    compOutcomes.every((o) => o.status === "success") &&
    !bonusApplied(compositionId)
  ) {
    const participants = [...new Set(compOutcomes.map((o) => o.agentId))];
    for (const agentId of participants) {
      deltasApplied.push(
        applyDelta(
          agentId,
          COMPOSITION_COMPLETED_DELTA,
          "composition_completed",
          { compositionId, appliedBy: finalizerId },
        ),
      );
    }
  }

  return deltasApplied;
}

/**
 * Completion-driven reputation settle for one composition step — the seam the
 * physical-completion paths (local `kernel-service`, external
 * `paid-job-flow` `PUT /complete`) call once a job's real outcome is known.
 *
 * Real-execution mode records each step's outcome as `pending` at ack (see
 * `compose.ts` `executeComposition`) and threads `{compositionId, stepIndex}`
 * onto the job's `parameters.__pccStep`. This function reads that bridge back,
 * flips the pending outcome to the completion verdict (`success`/`failed`),
 * and reuses {@link finalizeReputation} to apply the `+10`/`-15` step delta and
 * re-check the one-time composition `+5` bonus.
 *
 * No-op (returns `[]`) for:
 *   - jobs that carry no `__pccStep` (single `/api/jobs/submit` jobs, or
 *     compositions run in ack-finalize/NOOP mode) — reputation stays inert for
 *     them, exactly as today;
 *   - an outcome that is already finalized — idempotent, so a second completion
 *     signal for the same job applies nothing.
 *
 * Best-effort by contract: callers wrap it so a settlement/reputation hiccup can
 * never break job completion.
 */
export function settleStepReputationForJob(
  jobId: string,
  verdict: "success" | "failed",
  opts: { evidenceBundleId?: string; finalizerId?: string } = {},
): ReputationDelta[] {
  const job = reposOrInit().jobs.findById(jobId);
  const coords = (job?.parameters as Record<string, unknown> | null | undefined)
    ?.__pccStep as { compositionId: string; stepIndex: number } | undefined;
  if (!coords || typeof coords.compositionId !== "string" || typeof coords.stepIndex !== "number") {
    return []; // not a composition step → inert
  }

  const outcome = getOutcomeByStep(coords.compositionId, coords.stepIndex);
  if (!outcome || outcome.finalReputationApplied) {
    return []; // nothing recorded, or already settled → idempotent
  }

  outcome.status = verdict; // pending → success | failed
  if (opts.evidenceBundleId) outcome.evidenceBundleId = opts.evidenceBundleId;
  saveOutcome(outcome);

  return finalizeReputation(coords.compositionId, opts.finalizerId ?? "settlement-completion");
}

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const DeltaQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const LeaderboardQuerySchema = z.object({
  kind: ReputationAgentKindSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function reputationRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /api/reputation/leaderboard ─────────────────────────────────
  // Registered BEFORE the parameterized /:agentId route so "leaderboard"
  // is not swallowed as an agentId.
  app.get("/api/reputation/leaderboard", async (req, reply) => {
    const parsed = LeaderboardQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_query",
        message: "Invalid leaderboard query params",
        details: parsed.error.flatten(),
      });
    }
    const { kind, limit, offset } = parsed.data;
    const effectiveLimit = limit ?? 20;
    const effectiveOffset = offset ?? 0;

    let agents = loadAllReputations();
    if (kind) agents = agents.filter((a) => a.kind === kind);
    agents.sort((a, b) => b.score - a.score);

    const total = agents.length;
    const page = agents.slice(effectiveOffset, effectiveOffset + effectiveLimit);

    return {
      agents: page,
      count: page.length,
      total,
      limit: effectiveLimit,
      offset: effectiveOffset,
      kind: kind ?? null,
    };
  });

  // ── GET /api/reputation/:agentId/deltas ─────────────────────────────
  app.get<{ Params: { agentId: string } }>(
    "/api/reputation/:agentId/deltas",
    async (req, reply) => {
      const parsed = DeltaQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_query",
          message: "Invalid deltas query params",
          details: parsed.error.flatten(),
        });
      }
      const { agentId } = req.params;
      const { limit, offset } = parsed.data;
      const effectiveLimit = limit ?? 50;
      const effectiveOffset = offset ?? 0;

      const all = deltasForAgent(agentId);
      const page = all.slice(effectiveOffset, effectiveOffset + effectiveLimit);

      return {
        agentId,
        deltas: page,
        count: page.length,
        total: all.length,
        limit: effectiveLimit,
        offset: effectiveOffset,
      };
    },
  );

  // ── GET /api/reputation/:agentId ────────────────────────────────────
  app.get<{ Params: { agentId: string } }>(
    "/api/reputation/:agentId",
    async (req) => {
      const { agentId } = req.params;
      // Lazy-init at 500 so a never-seen agent reads as a neutral participant
      // rather than a 404 — composers query reputation before assigning work.
      const reputation = getOrInitReputation(agentId);
      const recentDeltas = deltasForAgent(agentId).slice(0, RECENT_DELTAS_LIMIT);
      return { reputation, recentDeltas };
    },
  );

  // ── POST /api/compositions/:compositionId/step-outcome ──────────────
  app.post<{ Params: { compositionId: string } }>(
    "/api/compositions/:compositionId/step-outcome",
    async (req, reply) => {
      const parsed = RecordStepOutcomeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid step-outcome body",
          details: parsed.error.flatten(),
        });
      }
      // The path param is authoritative for the composition id.
      const compositionId = req.params.compositionId;
      const data = parsed.data;

      const result = recordStepOutcome({ ...data, compositionId });
      if (!result.ok) {
        return reply.status(409).send({
          error: "outcome_finalized",
          message: `Step ${data.stepIndex} of composition ${compositionId} has already been finalized`,
          outcomeId: result.outcome.outcomeId,
        });
      }

      return reply.status(201).send({ outcome: result.outcome });
    },
  );

  // ── GET /api/compositions/:compositionId/step-outcomes ──────────────
  app.get<{ Params: { compositionId: string } }>(
    "/api/compositions/:compositionId/step-outcomes",
    async (req) => {
      const list = outcomesForComposition(req.params.compositionId);
      return { outcomes: list, count: list.length };
    },
  );

  // ── POST /api/compositions/:compositionId/disputes ──────────────────
  app.post<{ Params: { compositionId: string } }>(
    "/api/compositions/:compositionId/disputes",
    async (req, reply) => {
      const parsed = FileDisputeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid dispute body",
          details: parsed.error.flatten(),
        });
      }
      const compositionId = req.params.compositionId;
      const data = parsed.data;

      // A dispute can only be filed against a recorded step outcome.
      const outcome = getOutcomeByStep(compositionId, data.stepIndex);
      if (!outcome) {
        return reply.status(404).send({
          error: "outcome_not_found",
          message: `No recorded outcome for step ${data.stepIndex} of composition ${compositionId}`,
        });
      }

      const dispute: CompositionStepDispute = {
        disputeId: randomUUID(),
        compositionId,
        stepIndex: data.stepIndex,
        disputerId: data.disputerId,
        reason: data.reason,
        description: data.description,
        evidence: data.evidence,
        status: "pending",
        filedAt: now(),
        resolvedAt: undefined,
        resolverId: undefined,
        resolutionNote: undefined,
        reputationDeltasApplied: [],
      };
      saveDispute(dispute);

      // Flip a previously-successful outcome to 'disputed' so finalize-reputation
      // holds off crediting it until the dispute resolves.
      if (outcome.status === "success") {
        outcome.status = "disputed";
        saveOutcome(outcome);
      }

      return reply.status(201).send({ dispute });
    },
  );

  // ── GET /api/compositions/:compositionId/disputes ───────────────────
  app.get<{ Params: { compositionId: string } }>(
    "/api/compositions/:compositionId/disputes",
    async (req) => {
      const list = listDisputesForComposition(req.params.compositionId);
      return { disputes: list, count: list.length };
    },
  );

  // ── POST /api/disputes/:disputeId/resolve ───────────────────────────
  app.post<{ Params: { disputeId: string } }>(
    "/api/disputes/:disputeId/resolve",
    async (req, reply) => {
      const parsed = ResolveDisputeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid resolve body",
          details: parsed.error.flatten(),
        });
      }
      const { disputeId } = req.params;
      const dispute = getDispute(disputeId);
      if (!dispute) {
        return reply.status(404).send({
          error: "dispute_not_found",
          message: `No dispute with id=${disputeId}`,
        });
      }
      if (dispute.status !== "pending") {
        return reply.status(409).send({
          error: "dispute_not_pending",
          message: `Dispute ${disputeId} is already ${dispute.status}`,
        });
      }

      const { resolverId, decision, resolutionNote } = parsed.data;
      const outcome = getOutcomeByStep(dispute.compositionId, dispute.stepIndex);
      const disputedAgentId = outcome?.agentId;
      const applied: ReputationDelta[] = [];

      if (decision === "upheld") {
        // Slash the disputed agent.
        if (disputedAgentId) {
          applied.push(
            applyDelta(disputedAgentId, DISPUTE_UPHELD_DELTA, "dispute_upheld", {
              compositionId: dispute.compositionId,
              stepIndex: dispute.stepIndex,
              appliedBy: resolverId,
              note: `dispute ${disputeId} upheld: ${dispute.reason}`,
            }),
          );
          const rep = getOrInitReputation(disputedAgentId);
          rep.disputesUpheld += 1;
          saveReputation(rep);

          // Revert a previously-credited step_completed +10 if finalize already
          // settled this step before the dispute was upheld.
          if (
            outcome &&
            outcome.finalReputationApplied &&
            typeof outcome.reputationDelta === "number" &&
            outcome.reputationDelta > 0
          ) {
            applied.push(
              applyDelta(
                disputedAgentId,
                -outcome.reputationDelta,
                "manual_adjustment",
                {
                  compositionId: dispute.compositionId,
                  stepIndex: dispute.stepIndex,
                  appliedBy: resolverId,
                  note: `revert step_completed credit after dispute ${disputeId} upheld`,
                },
              ),
            );
          }
        }
      } else {
        // Rejected: vindicate the disputed agent, penalize the frivolous filer.
        if (disputedAgentId) {
          applied.push(
            applyDelta(
              disputedAgentId,
              DISPUTE_REJECTED_VINDICATION_DELTA,
              "dispute_rejected",
              {
                compositionId: dispute.compositionId,
                stepIndex: dispute.stepIndex,
                appliedBy: resolverId,
                note: `dispute ${disputeId} rejected — agent vindicated`,
              },
            ),
          );
          const rep = getOrInitReputation(disputedAgentId);
          rep.disputesRejected += 1;
          saveReputation(rep);
        }
        applied.push(
          applyDelta(
            dispute.disputerId,
            DISPUTE_REJECTED_FRIVOLOUS_DELTA,
            "dispute_rejected",
            {
              compositionId: dispute.compositionId,
              stepIndex: dispute.stepIndex,
              appliedBy: resolverId,
              note: `frivolous dispute ${disputeId} penalty`,
            },
          ),
        );
      }

      dispute.status = decision;
      dispute.resolvedAt = now();
      dispute.resolverId = resolverId;
      dispute.resolutionNote = resolutionNote;
      dispute.reputationDeltasApplied = applied.map((d) => d.deltaId);
      saveDispute(dispute);

      return reply.status(200).send({ dispute, deltasApplied: applied });
    },
  );

  // ── POST /api/compositions/:compositionId/finalize-reputation ───────
  app.post<{ Params: { compositionId: string } }>(
    "/api/compositions/:compositionId/finalize-reputation",
    async (req, reply) => {
      const parsed = FinalizeCompositionReputationSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid finalize body",
          details: parsed.error.flatten(),
        });
      }
      const compositionId = req.params.compositionId;
      const { finalizerId } = parsed.data;

      const deltasApplied = finalizeReputation(compositionId, finalizerId);
      // Exactly one step delta (step_completed | step_failed) is pushed per
      // finalized step; composition_completed bonus deltas don't count toward
      // stepsFinalized.
      const stepsFinalized = deltasApplied.filter(
        (d) => d.reason === "step_completed" || d.reason === "step_failed",
      ).length;
      const affectedAgents = [...new Set(deltasApplied.map((d) => d.agentId))];

      const response: FinalizeCompositionReputationResponse = {
        compositionId,
        stepsFinalized,
        deltasApplied,
        affectedAgents,
      };
      return reply.status(200).send(response);
    },
  );
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/** Wipe every reputation store. Test helper. */
export function _clearReputationForTests(): void {
  const d = db();
  d.delete(schema.agentReputations).run();
  d.delete(schema.reputationDeltas).run();
  d.delete(schema.compositionStepOutcomes).run();
  d.delete(schema.compositionStepDisputes).run();
}

/** Preload a single AgentReputation into the registry. Test helper. */
export function _seedReputationForTests(rep: AgentReputation): void {
  saveReputation(rep);
}
