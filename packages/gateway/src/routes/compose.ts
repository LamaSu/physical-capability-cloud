/**
 * Composition engine routes.
 *
 * The keystone for PCC's agentic-composition layer. Takes an outcome spec +
 * budget + assurance tier, returns a sequenced DAG of capability instances
 * ready for execution.
 *
 * Storage: SQLite via @pcc/store (compositions + composition_candidates +
 * composition_executions tables), following the marketplace / requests
 * persistence pattern. State survives gateway redeploys. The candidate provider
 * is still the dev-injected pool for the scaffold; production wiring swaps it to
 * CapabilityFacade without changing the persisted shape.
 *
 * Execute wiring: executeComposition submits real jobs via JobFacade and
 * registers a durable workflow run via @pcc/workflow. The production binding
 * is activated by PCC_COMPOSE_EXECUTE_REAL=true; dev/test falls back to the
 * NOOP runner so existing tests pass unchanged.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  ComposeRequestSchema,
  ExecuteCompositionRequestSchema,
  RegisterCandidateRequestSchema,
  type ComposeRequest,
  type ComposeResponse,
  type CompositionCandidate,
  type CompositionOptimization,
  type CompositionStep,
  type CompositionStatus,
  type ExecuteCompositionResponse,
  type LocationConstraint,
  type GraphSearchRequest,
  type GraphSearchResponse,
  type GraphPathStep,
  type GraphSearchOptimization,
  type ReputationDelta,
  type StepOutcomeStatus,
} from "@pcc/spec";
import { schema, eq } from "@pcc/store";
import { getStore, initStore } from "../db.js";
import { searchGraph } from "./graph-search.js";
import { recordStepOutcome, finalizeReputation } from "./reputation.js";
import { openSqliteStore, WorkflowEngine, Workflow } from "@pcc/workflow";
import type { WorkflowContext } from "@pcc/workflow";
import { getJobFacade } from "../facades/index.js";
import type { SubmitJobInput, JobSubmitResult } from "../facades/index.js";
import type { Result } from "@pcc/spec";
import type {
  MachineAdapter,
  PreflightRequest,
  PreflightResult,
  PreflightRefusal,
} from "@pcc/kernel";
import { getKernelService } from "../services/kernel-service.js";

// ---------------------------------------------------------------------------
// Store access — getStore() is booted by server.ts in production; tests lazily
// initialise an in-memory store on first touch (mirrors the other substrate
// routes). Both share the @pcc/store singleton, so cross-module helpers
// (reputation, graph-search) see the same database.
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

const COMPOSITION_TTL_MS = 30 * 60 * 1000; // 30 min

function nowISO(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Every candidate currently in the scaffold pool. */
function listCandidates(): CompositionCandidate[] {
  const rows = db().select().from(schema.compositionCandidates).all();
  return rows.map((r) => r.data as CompositionCandidate);
}

/** Idempotent upsert of a candidate by capabilityId. */
function saveCandidate(c: CompositionCandidate): void {
  const row = {
    capabilityId: c.capabilityId,
    kernelId: c.kernelId,
    operatorAddress: c.operatorAddress,
    capabilityType: c.capabilityType,
    estimatedPriceUsd: c.estimatedPriceUSD,
    estimatedDurationMs: c.estimatedDurationMs,
    assuranceTier: c.assuranceTier,
    reputation: c.reputation ?? null,
    available: c.available,
    createdAt: nowISO(),
    data: c,
  };
  db()
    .insert(schema.compositionCandidates)
    .values(row)
    .onConflictDoUpdate({ target: schema.compositionCandidates.capabilityId, set: row })
    .run();
}

/** Persist a proposed composition so GET /api/compose/:id can return it. */
function saveComposition(r: ComposeResponse): void {
  db()
    .insert(schema.compositions)
    .values({
      id: r.compositionId,
      status: r.status,
      totalPriceUsd: r.totalPriceUSD,
      stepCount: r.steps.length,
      requesterAgentId: null,
      expiresAt: r.expiresAt,
      createdAt: r.proposedAt,
      data: r,
    })
    .run();
}

function getComposition(id: string): ComposeResponse | undefined {
  const row = db()
    .select()
    .from(schema.compositions)
    .where(eq(schema.compositions.id, id))
    .get();
  return row ? (row.data as ComposeResponse) : undefined;
}

function getExecution(id: string): ExecuteCompositionResponse | undefined {
  const row = db()
    .select()
    .from(schema.compositionExecutions)
    .where(eq(schema.compositionExecutions.compositionId, id))
    .get();
  return row ? (row.data as ExecuteCompositionResponse) : undefined;
}

function saveExecution(r: ExecuteCompositionResponse): void {
  db()
    .insert(schema.compositionExecutions)
    .values({
      compositionId: r.compositionId,
      workflowId: r.workflowId,
      status: r.status,
      startedAt: r.startedAt,
      createdAt: nowISO(),
      data: r,
    })
    .onConflictDoUpdate({
      target: schema.compositionExecutions.compositionId,
      set: { workflowId: r.workflowId, status: r.status, startedAt: r.startedAt, data: r },
    })
    .run();
}

// ---------------------------------------------------------------------------
// Candidate provider interface — production wiring point
// ---------------------------------------------------------------------------

/**
 * Pluggable provider that returns capability candidates matching a step's
 * constraints. The scaffold uses a SQLite-backed implementation; production
 * wires this to CapabilityFacade.list({ capabilityType, ... }).
 */
export interface CapabilityProvider {
  findByType(
    capabilityType: string,
    constraints: {
      minAssuranceTier: number;
      location?: LocationConstraint;
    },
  ): CompositionCandidate[];
}

const inMemoryProvider: CapabilityProvider = {
  findByType: (capabilityType, constraints) => {
    const all = listCandidates();
    return all.filter((c) => {
      if (c.capabilityType !== capabilityType) return false;
      if (!c.available) return false;
      if (c.assuranceTier < constraints.minAssuranceTier) return false;
      if (constraints.location && c.location) {
        const km = haversineKm(constraints.location, c.location);
        const radius = constraints.location.radiusKm ?? 50;
        if (km > radius) return false;
      }
      return true;
    });
  },
};

/** Haversine great-circle distance in km. */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const aHav =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(aHav));
}

// ---------------------------------------------------------------------------
// Planner — picks one candidate per step under the chosen optimization
// ---------------------------------------------------------------------------

function scoreCandidate(
  c: CompositionCandidate,
  optimization: CompositionOptimization,
): number {
  switch (optimization) {
    case "price":
      return c.estimatedPriceUSD;
    case "speed":
      return c.estimatedDurationMs;
    case "quality":
      // Higher tier + higher reputation = better; invert so lower score = better.
      return -1 * (c.assuranceTier * 1000 + (c.reputation ?? 0));
  }
}

function plan(
  req: ComposeRequest,
  provider: CapabilityProvider,
): { steps: CompositionStep[]; status: CompositionStatus; rejection?: string } {
  const stepTypes = req.steps ?? [req.outcomeType];
  const optimization = req.optimizeFor ?? "price";

  const chosen: CompositionStep[] = [];
  for (let i = 0; i < stepTypes.length; i++) {
    const capType = stepTypes[i]!;
    const matches = provider.findByType(capType, {
      minAssuranceTier: req.minAssuranceTier,
      location: req.location,
    });

    if (matches.length === 0) {
      return {
        steps: [],
        status: "no_path_found",
        rejection: `No candidate found for step ${i} (capabilityType="${capType}") at minAssuranceTier=${req.minAssuranceTier}`,
      };
    }

    matches.sort(
      (a, b) => scoreCandidate(a, optimization) - scoreCandidate(b, optimization),
    );
    const pick = matches[0]!;

    chosen.push({
      index: i,
      capabilityType: capType,
      capabilityId: pick.capabilityId,
      kernelId: pick.kernelId,
      operatorAddress: pick.operatorAddress,
      estimatedPriceUSD: pick.estimatedPriceUSD,
      estimatedDurationMs: pick.estimatedDurationMs,
      assuranceTier: pick.assuranceTier,
      dependsOn: i === 0 ? [] : [i - 1],
      reputation: pick.reputation,
      ...(pick.resourceRequirements
        ? { resourceRequirements: pick.resourceRequirements }
        : {}),
    });
  }

  const total = chosen.reduce((s, x) => s + x.estimatedPriceUSD, 0);
  if (total > req.budgetUSD) {
    return {
      steps: chosen,
      status: "over_budget",
      rejection: `Plan total $${total.toFixed(2)} exceeds budget $${req.budgetUSD.toFixed(2)}`,
    };
  }

  return { steps: chosen, status: "proposed" };
}

function summarize(
  req: ComposeRequest,
  steps: CompositionStep[],
  status: CompositionStatus,
  rejectionReason: string | undefined,
): ComposeResponse {
  const totalPriceUSD = steps.reduce((s, x) => s + x.estimatedPriceUSD, 0);
  const totalDurationMs = steps.reduce((s, x) => s + x.estimatedDurationMs, 0);
  const effectiveTier =
    steps.length === 0
      ? req.minAssuranceTier
      : (Math.min(...steps.map((s) => s.assuranceTier)) as 0 | 1 | 2 | 3);
  const budgetRemainingUSD = Math.max(0, req.budgetUSD - totalPriceUSD);

  return {
    compositionId: `cmp_${randomUUID()}`,
    status,
    steps,
    totalPriceUSD,
    totalDurationMs,
    effectiveAssuranceTier: effectiveTier,
    budgetUSD: req.budgetUSD,
    budgetRemainingUSD,
    optimizedFor: req.optimizeFor ?? "price",
    proposedAt: nowISO(),
    expiresAt: new Date(Date.now() + COMPOSITION_TTL_MS).toISOString(),
    rejectionReason,
  };
}

// ---------------------------------------------------------------------------
// Graph-search fallback — multi-step planning via Dijkstra (PR #92)
// ---------------------------------------------------------------------------

type PlanResult = {
  steps: CompositionStep[];
  status: CompositionStatus;
  rejection?: string;
};

/**
 * Map a compose optimization target onto the graph-search vocabulary. Compose
 * targets (`price` | `speed` | `quality`) are a strict subset of graph-search's
 * (which adds `reputation`), so the mapping is identity with a `price` default.
 */
function toGraphOptimization(
  o: CompositionOptimization | undefined,
): GraphSearchOptimization {
  return o ?? "price";
}

/** One graph path step → one linear composition step (dependsOn = previous). */
function graphStepToCompositionStep(
  s: GraphPathStep,
  index: number,
): CompositionStep {
  return {
    index,
    capabilityType: s.capabilityType,
    capabilityId: s.capabilityId,
    kernelId: s.kernelId,
    // GraphPathStep carries no operator binding — graph search works at the
    // capability-instance granularity, not the operator. Leave empty for the
    // scaffold; the execute follow-on resolves the operator at submission.
    operatorAddress: "",
    estimatedPriceUSD: s.estimatedPriceUSD,
    estimatedDurationMs: s.estimatedDurationMs,
    assuranceTier: s.assuranceTier,
    dependsOn: index === 0 ? [] : [index - 1],
    reputation: s.reputation,
    ...(s.resourceRequirements
      ? { resourceRequirements: s.resourceRequirements }
      : {}),
  };
}

/**
 * Plan a composition by delegating to graph-search's Dijkstra traversal, then
 * fold the cheapest returned path into composition steps. Used for explicit
 * `outcomeChain` requests and as the fallback when no direct single-step
 * provider matches.
 *
 * Status mapping — graph-search has no status field (it returns `options` +
 * `searchStats`), so we derive the compose status:
 *   - options non-empty             → `proposed`      (a path was found)
 *   - empty + cappedAtBudget        → `over_budget`   (a path existed but priced out)
 *   - empty + not capped            → `no_path_found`
 */
function planViaGraphSearch(req: ComposeRequest, outcomeType: string): PlanResult {
  const gsReq: GraphSearchRequest = {
    outcomeType,
    budgetUSD: req.budgetUSD,
    minAssuranceTier: req.minAssuranceTier,
    location: req.location,
    optimizeFor: toGraphOptimization(req.optimizeFor),
    requester: req.requester ? { agentId: req.requester.agentId } : undefined,
  };

  const result: GraphSearchResponse = searchGraph(gsReq);
  const best = result.options[0]; // already sorted cheapest/best-first

  if (!best) {
    if (result.searchStats.cappedAtBudget) {
      return {
        steps: [],
        status: "over_budget",
        rejection: `No graph path to "${outcomeType}" within budget $${req.budgetUSD.toFixed(2)}`,
      };
    }
    return {
      steps: [],
      status: "no_path_found",
      rejection: `No graph path produces "${outcomeType}" at minAssuranceTier=${req.minAssuranceTier}`,
    };
  }

  return {
    steps: best.steps.map((s, i) => graphStepToCompositionStep(s, i)),
    status: "proposed",
  };
}

/**
 * Resolve a {@link ComposeRequest} to a step list + status, choosing between
 * the direct in-memory provider and graph-search:
 *   1. An explicit `outcomeChain` always routes to graph-search (targets the
 *      chain's final element).
 *   2. Otherwise the direct provider runs first (single-step / explicit
 *      `steps`); a `proposed` or `over_budget` result is honoured as-is.
 *   3. Only when the direct provider finds NO candidate does graph-search take
 *      over, searching for a multi-step path to `outcomeType`.
 */
function planSteps(req: ComposeRequest): PlanResult {
  // (1) Explicit chain → graph-search on the final outcome type.
  if (req.outcomeChain && req.outcomeChain.length > 0) {
    const finalType = req.outcomeChain[req.outcomeChain.length - 1]!;
    return planViaGraphSearch(req, finalType);
  }

  // (2) Direct provider first — preserves the backwards-compatible 1-step
  //     (and explicit `steps`) behaviour exactly.
  const direct = plan(req, inMemoryProvider);
  if (direct.status !== "no_path_found") {
    return direct;
  }

  // (3) No direct provider matched → fall back to a graph path to the outcome.
  return planViaGraphSearch(req, req.outcomeType);
}

// ---------------------------------------------------------------------------
// Public planner entrypoint — in-process composition without an HTTP round-trip
// ---------------------------------------------------------------------------

/**
 * Plan + summarize a composition — the exact logic `POST /api/compose` runs,
 * exposed for in-process callers that need a composition object directly (e.g.
 * the asset-outbound demand route).
 *
 * Picks one of two planners (see {@link planSteps}): the in-memory candidate
 * provider for direct single-step / `steps` requests, or graph-search's
 * Dijkstra traversal for an explicit `outcomeChain` or when no direct provider
 * matches. Either way the result is summarized identically and persisted to the
 * same store as the HTTP route, so the returned `compositionId` remains
 * retrievable via `GET /api/compose/:id`.
 *
 * Returns a full {@link ComposeResponse}; inspect `.status` to distinguish
 * `proposed` (plan ready) from `over_budget` / `no_path_found` (rejections).
 */
export function planComposition(req: ComposeRequest): ComposeResponse {
  const result = planSteps(req);
  const response = summarize(req, result.steps, result.status, result.rejection);
  saveComposition(response);
  return response;
}

// ---------------------------------------------------------------------------
// Execution — drives reputation propagation per step + finalize
// ---------------------------------------------------------------------------

/**
 * Binds a proposed composition's steps to the agents that execute them and the
 * routine that "runs" each step. The scaffold's default runner is a no-op
 * (every step is assumed to succeed); production swaps it for real job
 * submission via JobFacade. A runner signals step failure by THROWING.
 */
export interface ExecutorBinding {
  /** Which agent is credited/debited for a step. Default: the step's operator. */
  resolveExecutor?: (step: CompositionStep) => string;
  /**
   * Runs one step; throw to mark it failed. Default: no-op (stub success).
   *
   * The optional `ctx` carries the composition coordinates so a production
   * runner can thread `{compositionId, stepIndex}` onto the submitted job
   * (via `parameters.__pccStep`), letting the async completion path settle the
   * step's reputation. NOOP/stub runners ignore it (backward compatible).
   */
  runStep?: (
    step: CompositionStep,
    ctx?: { compositionId: string },
  ) => Promise<void> | void;
  /**
   * Optional resolver for the whole-plan resource pre-flight gate. When present,
   * `executeComposition` holds a reservation for every step that declares
   * `resourceRequirements` BEFORE running step 1, and refuses the whole run
   * (throwing {@link CompositionPreflightError}) if any step is infeasible.
   * Absent (default) ⇒ the gate is a no-op — every existing composition (which
   * declares no resources) runs unchanged. In real-execution mode
   * (`PCC_COMPOSE_EXECUTE_REAL=true`) this defaults to
   * {@link createLocalPreflightResolver}.
   */
  preflightResolver?: PreflightResolver;
}

/** Structured result of {@link executeComposition}. */
export interface CompositionExecutionResult {
  compositionId: string;
  workflowId: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  /** How many steps actually ran (≤ steps.length; short-circuits on failure). */
  stepsExecuted: number;
  /** Index of the step that failed, or null when every step succeeded. */
  failedStepIndex: number | null;
  /** Reputation deltas applied by the post-run finalize. */
  deltasApplied: ReputationDelta[];
}

/** Default step runner — the scaffold assumes every step succeeds. */
const NOOP_RUNNER = (_step: CompositionStep): Promise<void> => Promise.resolve();

/**
 * Module-level runner the HTTP execute endpoint uses when no explicit binding
 * is supplied. Tests override it via {@link _setStepRunnerForTests} to inject a
 * mid-stream failure; reset by {@link _clearComposeForTests}. This is behaviour
 * injection (not persisted state), so it stays a module variable.
 */
let stepRunner: (step: CompositionStep) => Promise<void> | void = NOOP_RUNNER;

// ---------------------------------------------------------------------------
// Workflow engine — lazy-initialized singleton for production use.
// Opens the SQLite store only when PCC_COMPOSE_EXECUTE_REAL is set.
// Tests never hit this path (NOOP_RUNNER is used instead).
// ---------------------------------------------------------------------------

/** Workflow def for a composition run (wraps job submissions as steps). */
class CompositionWorkflow extends Workflow<{ compositionId: string }, { compositionId: string }> {
  readonly name = "CompositionExecution";
  readonly version = 1;

  async run(
    ctx: WorkflowContext,
    args: { compositionId: string },
  ): Promise<{ compositionId: string }> {
    // Durable marker — just records the run in the workflow engine.
    // Real job submission happens in the runStep binding before this workflow starts.
    // This gives us a real, crash-recoverable workflow ID tied to the composition.
    await ctx.step("record-composition-start", async () => {
      return { compositionId: args.compositionId, startedAt: new Date().toISOString() };
    });
    return { compositionId: args.compositionId };
  }
}

let _workflowEngine: WorkflowEngine | null = null;

function getWorkflowEngine(): WorkflowEngine {
  if (!_workflowEngine) {
    const dbPath =
      process.env.WORKFLOW_DB_PATH ?? "/data/workflow.sqlite";
    const store = openSqliteStore({ path: dbPath });
    _workflowEngine = new WorkflowEngine({ store, defaultActorId: "compose-engine" });
    _workflowEngine.register(CompositionWorkflow);
  }
  return _workflowEngine;
}

/** Minimal interface for the JobFacade subset that createProductionBinding needs. */
export interface JobSubmitter {
  submit(input: SubmitJobInput): Promise<Result<JobSubmitResult>>;
}

/**
 * Creates a production ExecutorBinding: each step submits a real job via
 * JobFacade and the composition registers a durable workflow run via
 * @pcc/workflow.
 *
 * runStep submits only the job ack — it does NOT block on job completion.
 * Physical completion, evidence, and oracle release happen asynchronously
 * downstream (paid-job-flow + Lane 2 settlement).
 *
 * @param facadeGetter - Optional override for the JobFacade factory; used in
 *   tests to inject a stub without ESM module-mock machinery.
 */
export function createProductionBinding(
  facadeGetter?: () => JobSubmitter,
): ExecutorBinding {
  return {
    runStep: async (
      step: CompositionStep,
      ctx?: { compositionId: string },
    ): Promise<void> => {
      const facade = facadeGetter ? facadeGetter() : getJobFacade();
      const result = await facade.submit({
        stepId: step.capabilityId,
        kernelId: step.kernelId,
        capabilityId: step.capabilityId,
        assuranceTier: step.assuranceTier,
        description: `Composition step: ${step.capabilityType}`,
        // Thread the step→outcome bridge onto the job's parameters so the async
        // completion path can find (compositionId, stepIndex) and settle the
        // step's reputation. `JobFacade.submit` persists `parameters` verbatim
        // on both the external-queued and local job rows.
        ...(ctx
          ? {
              parameters: {
                __pccStep: { compositionId: ctx.compositionId, stepIndex: step.index },
              },
            }
          : {}),
      });
      if (!result.success) {
        throw new Error(
          `Job submission failed for step ${step.index} (${step.capabilityId}): ${result.error?.message ?? "unknown error"}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Orchestration-layer resource pre-flight gate (R3 — whole-plan poka-yoke)
//
// Moves the per-adapter refuse-to-start gate UP to the composition layer:
// before the executor runs ANY step of a composed DAG, hold a resource
// reservation for every step that declares `resourceRequirements` — via each
// step's adapter `preflight()`, which is the reused @pcc/resource-tracker leaf.
// If any step is infeasible, roll back the holds already taken and THROW,
// failing before step 1 spends and before any escrow/oracle. This layer is an
// aggregator + resolver + typed error around the existing leaf; no tracker
// logic is re-implemented here.
// ---------------------------------------------------------------------------

/** A resolved handle to run one step's resource pre-flight + finalize its hold. */
export interface StepPreflight {
  /** Hold a reservation for this step's requirements (the adapter leaf call). */
  preflight(req: PreflightRequest): Promise<PreflightResult>;
  /** Phase-2 commit: the step ran — permanently consume the held capacity. */
  commit(reservationId: string): void;
  /** Phase-2 rollback: the step never ran — release the hold, consume nothing. */
  rollback(reservationId: string): void;
}

/**
 * Maps a composition step to a {@link StepPreflight} handle, or `null` when the
 * step declares no resources / its adapter is not reachable in-process (skip).
 * Mirrors {@link ExecutorBinding}: an injectable seam whose default is a no-op,
 * so every existing composition (which declares no resources) runs unchanged.
 */
export interface PreflightResolver {
  resolve(step: CompositionStep): StepPreflight | null;
}

/**
 * Typed refuse-to-start error thrown by {@link preflightComposition} when a
 * step's resource pre-flight fails. Surfaced by the /execute route as HTTP 409
 * (matching the per-kernel `KernelPreflightError`), carrying the leaf's own
 * refusal `{code,message,details}` verbatim.
 */
export class CompositionPreflightError extends Error {
  readonly code = "composition_preflight_refused";
  constructor(
    readonly failedStepIndex: number,
    readonly capabilityId: string,
    readonly refusal: PreflightRefusal,
  ) {
    super(refusal.message);
    this.name = "CompositionPreflightError";
  }
}

/** One held reservation across the plan: which handle owns it + its id. */
interface HeldReservation {
  handle: StepPreflight;
  reservationId: string;
}

/** Roll back (release) every held reservation, swallowing individual errors. */
function rollbackAllHolds(held: Map<number, HeldReservation>): void {
  for (const { handle, reservationId } of held.values()) {
    try {
      handle.rollback(reservationId);
    } catch {
      // a hold already finalized elsewhere is not fatal to releasing the rest
    }
  }
  held.clear();
}

/**
 * Whole-plan pre-flight: hold a reservation for every step that declares
 * `resourceRequirements`, in order. On the FIRST infeasible step, roll back
 * every hold already taken and throw {@link CompositionPreflightError} — so
 * nothing has executed and nothing has escrowed. On success, returns a map of
 * held reservations keyed by step index; the executor commits each on the
 * step's success and rolls back any unreached holds on short-circuit.
 *
 * Steps with no `resourceRequirements`, or whose resolver returns `null` (no
 * in-process adapter to verify), are skipped — identical to the adapter-level
 * "missing preflight = no check" contract. This is what keeps the gate additive.
 */
export async function preflightComposition(
  composition: ComposeResponse,
  resolver: PreflightResolver,
): Promise<Map<number, HeldReservation>> {
  const held = new Map<number, HeldReservation>();
  for (const step of composition.steps) {
    const requirements = step.resourceRequirements;
    if (!requirements || Object.keys(requirements).length === 0) continue;

    const handle = resolver.resolve(step);
    if (!handle) continue; // no in-process adapter to verify → fail open (skip)

    let result: PreflightResult;
    try {
      result = await handle.preflight({
        requirements,
        jobId: `${composition.compositionId}:${step.index}`,
      });
    } catch (err) {
      // An adapter that throws instead of returning a typed refusal is treated
      // as a refusal — roll back holds already taken, then surface it.
      rollbackAllHolds(held);
      const message = err instanceof Error ? err.message : String(err);
      throw new CompositionPreflightError(step.index, step.capabilityId, {
        code: "preflight_threw",
        message,
      });
    }

    if (!result.ok) {
      rollbackAllHolds(held);
      throw new CompositionPreflightError(
        step.index,
        step.capabilityId,
        result.refusal ?? {
          code: "preflight_refused",
          message: "step pre-flight refused",
        },
      );
    }

    if (result.reservationId) {
      held.set(step.index, { handle, reservationId: result.reservationId });
    }
  }
  return held;
}

/**
 * Production resolver: map a step to a local in-process adapter via
 * `getKernelService()` and bind its `preflight` + `commitReservation` +
 * `rollbackReservation`. Returns `null` when the kernel service is not
 * initialised, no adapter matches the step, or the adapter declares no
 * `preflight` — every such case makes the gate skip that step (fail open).
 * Remote/third-party kernels (whose `preflight` lives behind an HTTPS endpoint)
 * are intentionally not resolved here; that is a future remote resolver.
 */
export function createLocalPreflightResolver(): PreflightResolver {
  return {
    resolve(step: CompositionStep): StepPreflight | null {
      let adapter: MachineAdapter | undefined;
      try {
        const svc = getKernelService();
        // A composition step carries kernelId + capabilityId, not a device id.
        // Best-effort in-process match against loaded adapters; a miss → skip.
        adapter =
          svc.getMachineAdapter(step.kernelId) ??
          svc.getMachineAdapter(step.capabilityId);
      } catch {
        return null; // kernel service not initialised in this process
      }
      if (!adapter || typeof adapter.preflight !== "function") return null;
      const preflight = adapter.preflight.bind(adapter);
      const commit = adapter.commitReservation?.bind(adapter);
      const rollback = adapter.rollbackReservation?.bind(adapter);
      return {
        preflight,
        commit: (id: string) => commit?.(id),
        rollback: (id: string) => rollback?.(id),
      };
    },
  };
}

/**
 * Module-level resolver the HTTP execute endpoint uses when no explicit binding
 * is supplied. Default `null` ⇒ the gate is a no-op (backward compatible).
 * Tests inject a resolver over mock adapters via
 * {@link _setPreflightResolverForTests}; reset by {@link _clearComposeForTests}.
 */
let preflightResolver: PreflightResolver | null = null;

/**
 * Execute a proposed composition, propagating reputation as it goes: record a
 * step-outcome per step (`success`, or `failed` when the runner throws), then
 * finalize the composition's reputation once the loop ends.
 *
 * A failed step SHORT-CIRCUITS the rest of the DAG: subsequent steps are not
 * executed, no outcomes are recorded for them, and finalize therefore skips the
 * `composition_completed` bonus (not every step succeeded). Successful steps up
 * to the failure are still credited +10 each; the failed step's executor takes
 * -15.
 *
 * Returns a real @pcc/workflow run id (not synthetic) when
 * PCC_COMPOSE_EXECUTE_REAL=true; falls back to a local UUID in NOOP/test mode.
 *
 * Exported so other routes (e.g. asset-outbound demand fulfilment) can execute
 * an in-process composition without an HTTP round-trip. Reputation deltas land
 * in the shared reputation store and are queryable via `/api/reputation/*`.
 */
export async function executeComposition(
  composition: ComposeResponse,
  binding: ExecutorBinding = {},
): Promise<CompositionExecutionResult> {
  const compositionId = composition.compositionId;
  const startedAt = nowISO();
  const resolveExecutor =
    binding.resolveExecutor ?? ((s: CompositionStep) => s.operatorAddress);

  // ack != completion — ONLY in real-execution mode. The NOOP/test runner is
  // both ack and completion (it resolves synchronously with a definitive
  // success/throw), so finalizing at ack there is correct. In real mode
  // `runStep` only submits a job and physical completion is a separate async
  // event, so we defer the +10/-15 to the completion path
  // (`settleStepReputationForJob`).
  const DEFER_TO_COMPLETION = process.env.PCC_COMPOSE_EXECUTE_REAL === "true";

  // Determine the effective step runner:
  // - Explicit binding.runStep always wins.
  // - Otherwise, use the production binding when PCC_COMPOSE_EXECUTE_REAL=true.
  // - Otherwise, fall back to the module-level stepRunner (NOOP in tests).
  const effectiveRunStep: (
    step: CompositionStep,
    ctx?: { compositionId: string },
  ) => Promise<void> | void =
    binding.runStep ??
    (process.env.PCC_COMPOSE_EXECUTE_REAL === "true"
      ? createProductionBinding().runStep!
      : stepRunner);

  // Whole-plan resource pre-flight gate (R3). Resolve the effective resolver:
  //   - an explicit binding.preflightResolver always wins,
  //   - else the local in-process resolver when real execution is on,
  //   - else the module-level resolver (null ⇒ no-op in tests / by default).
  // Hold a reservation for every step that declares resourceRequirements; a
  // throw here (CompositionPreflightError) precedes step 1's submit and all
  // downstream escrow/oracle — the /execute route maps it to HTTP 409. Nothing
  // below (saveExecution, finalizeReputation, workflow run) is reached on throw.
  const effectivePreflightResolver: PreflightResolver | null =
    binding.preflightResolver ??
    (process.env.PCC_COMPOSE_EXECUTE_REAL === "true"
      ? createLocalPreflightResolver()
      : preflightResolver);

  const held: Map<number, HeldReservation> = effectivePreflightResolver
    ? await preflightComposition(composition, effectivePreflightResolver)
    : new Map<number, HeldReservation>();

  let failedStepIndex: number | null = null;
  let stepsExecuted = 0;

  for (const step of composition.steps) {
    const executorAgentId = resolveExecutor(step);
    let ackFailed = false;
    try {
      // Thread the composition coordinates so a production runner can tag the
      // submitted job with (compositionId, stepIndex) for completion-time settle.
      await effectiveRunStep(step, { compositionId });
    } catch {
      ackFailed = true;
    }
    stepsExecuted += 1;

    // Finalize this step's resource hold (if it declared one): commit on a
    // successful ack (capacity permanently consumed), roll back on ack failure
    // (hold released). Any holds for steps that never run are released after
    // the loop by rollbackAllHolds(held).
    const hold = held.get(step.index);
    if (hold) {
      try {
        if (ackFailed) hold.handle.rollback(hold.reservationId);
        else hold.handle.commit(hold.reservationId);
      } catch {
        // finalizing a hold must never crash execution — leaf errors are benign
      }
      held.delete(step.index);
    }

    if (DEFER_TO_COMPLETION) {
      if (ackFailed) {
        // Submission itself failed — no job exists, so no completion will ever
        // arrive. Record the failure and settle just this step now (-15), then
        // short-circuit (preserve the existing downstream-skip semantics).
        recordStepOutcome({
          compositionId,
          stepIndex: step.index,
          capabilityId: step.capabilityId,
          agentId: executorAgentId,
          status: "failed",
          startedAt,
          completedAt: nowISO(),
        });
        finalizeReputation(compositionId, "compose-engine");
        failedStepIndex = step.index;
        break;
      }

      // Ack succeeded — record PENDING and DEFER. Do NOT finalize and do NOT
      // short-circuit: every sibling job still fans out and records its own
      // pending outcome, so compOutcomes.length === N up front and the one-time
      // +5 composition bonus can settle on whichever completion lands last.
      recordStepOutcome({
        compositionId,
        stepIndex: step.index,
        capabilityId: step.capabilityId,
        agentId: executorAgentId,
        status: "pending",
        startedAt,
        completedAt: nowISO(),
      });
      continue;
    }

    // NOOP/test mode: ack IS completion — record the definitive outcome and let
    // the post-loop finalize settle it, exactly as before.
    const status: StepOutcomeStatus = ackFailed ? "failed" : "success";
    recordStepOutcome({
      compositionId,
      stepIndex: step.index,
      capabilityId: step.capabilityId,
      agentId: executorAgentId,
      status,
      startedAt,
      completedAt: nowISO(),
    });

    if (status === "failed") {
      failedStepIndex = step.index;
      break; // short-circuit — do not execute downstream steps
    }
  }

  // Release any still-outstanding resource holds. After a clean run this is
  // empty (every hold committed inside the loop); after a short-circuit it holds
  // the reservations of steps that never executed — release them (those steps
  // never ran, so their capacity is returned).
  rollbackAllHolds(held);

  // Settle reputation: in NOOP/test mode this applies +10 per success, -15 on
  // the failed step, and the +5 all-success bonus. In real mode every recorded
  // outcome is still `pending` (or the one ack-failed step is already settled
  // above), so this is a no-op and the real deltas land at completion via
  // `settleStepReputationForJob`. Idempotent if already finalized.
  const deltasApplied = finalizeReputation(compositionId, "compose-engine");

  // Register a durable workflow run to get a real workflow ID.
  // In NOOP/test mode, falls back to a local UUID to avoid SQLite I/O.
  let workflowId: string;
  if (process.env.PCC_COMPOSE_EXECUTE_REAL === "true") {
    try {
      const engine = getWorkflowEngine();
      const handle = await engine.start<{ compositionId: string }, { compositionId: string }>(
        "CompositionExecution",
        { compositionId },
        { runId: `compose-${compositionId}`, correlationId: compositionId },
      );
      workflowId = handle.runId;
    } catch {
      // Fallback: engine unavailable, generate a local id
      workflowId = `wf_${randomUUID()}`;
    }
  } else {
    workflowId = `wf_${randomUUID()}`;
  }

  return {
    compositionId,
    workflowId,
    status: failedStepIndex === null ? "completed" : "failed",
    startedAt,
    completedAt: nowISO(),
    stepsExecuted,
    failedStepIndex,
    deltasApplied,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function composeRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/compose — propose a composition
  app.post("/api/compose", async (req, reply) => {
    const parsed = ComposeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_failed",
        message: "Invalid compose request",
        details: parsed.error.format(),
      });
    }

    const response = planComposition(parsed.data);
    return reply.code(response.status === "proposed" ? 201 : 200).send(response);
  });

  // GET /api/compose/:id — retrieve a previously-proposed composition
  app.get<{ Params: { id: string } }>(
    "/api/compose/:id",
    async (req, reply) => {
      const c = getComposition(req.params.id);
      if (!c) {
        return reply.code(404).send({
          error: "not_found",
          message: `No composition with id ${req.params.id}`,
        });
      }
      // Expire on the fly
      if (new Date(c.expiresAt).getTime() < Date.now()) {
        return reply.code(410).send({
          error: "expired",
          message: `Composition ${req.params.id} expired at ${c.expiresAt}`,
        });
      }
      return reply.send(c);
    },
  );

  // POST /api/compose/:id/execute — commit composition → run + propagate reputation
  //
  // Drives the composition through `executeComposition`: each step records a
  // reputation step-outcome, and the composition's reputation is finalized when
  // the run ends. Synchronous in the scaffold (the stub assumes each step
  // succeeds; production wires per-step jobs + real evidence verification). The
  // response keeps the ExecuteCompositionResponse shape — `status` now reflects
  // the real outcome ("completed" | "failed"). Re-executing an already-run
  // composition replays its stored result without re-applying any deltas.
  app.post<{ Params: { id: string } }>(
    "/api/compose/:id/execute",
    async (req, reply) => {
      const parsed = ExecuteCompositionRequestSchema.safeParse({
        ...(req.body as object),
        compositionId: req.params.id,
      });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          message: "Invalid execute payload",
          details: parsed.error.format(),
        });
      }

      const c = getComposition(req.params.id);
      if (!c) {
        return reply.code(404).send({
          error: "not_found",
          message: `No composition with id ${req.params.id}`,
        });
      }

      // Idempotency: a composition that already executed replays its stored
      // result — reputation deltas were applied exactly once on the first run.
      const prior = getExecution(req.params.id);
      if (prior) {
        return reply.code(202).send(prior);
      }

      if (c.status !== "proposed") {
        return reply.code(409).send({
          error: "not_executable",
          message: `Composition is in status "${c.status}" and cannot be executed`,
        });
      }
      if (new Date(c.expiresAt).getTime() < Date.now()) {
        return reply.code(410).send({
          error: "expired",
          message: `Composition expired at ${c.expiresAt}`,
        });
      }

      let result: CompositionExecutionResult;
      try {
        result = await executeComposition(c);
      } catch (err) {
        if (err instanceof CompositionPreflightError) {
          // Whole-plan resource pre-flight refused the job BEFORE any step ran:
          // no execution row saved, no reputation delta applied, no workflow
          // run registered. The composition stays "proposed" and can be
          // re-planned/re-executed later.
          return reply.code(409).send({
            error: err.code,
            failedStepIndex: err.failedStepIndex,
            capabilityId: err.capabilityId,
            refusal: err.refusal,
          });
        }
        throw err;
      }
      const response: ExecuteCompositionResponse = {
        compositionId: result.compositionId,
        workflowId: result.workflowId,
        status: result.status,
        startedAt: result.startedAt,
      };
      saveExecution(response);
      return reply.code(202).send(response);
    },
  );

  // POST /api/compose/_dev/register-candidate — scaffold-only candidate injection
  //
  // Production replaces the in-memory provider with CapabilityFacade and
  // this endpoint goes away. Keep it gated for dev/test only.
  app.post(
    "/api/compose/_dev/register-candidate",
    async (req, reply) => {
      const parsed = RegisterCandidateRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "validation_failed",
          message: "Invalid candidate",
          details: parsed.error.format(),
        });
      }
      const cap = parsed.data;
      saveCandidate(cap);
      return reply.code(201).send({ ok: true, capabilityId: cap.capabilityId });
    },
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Clear all composition stores between test cases. */
export function _clearComposeForTests(): void {
  const d = db();
  d.delete(schema.compositionCandidates).run();
  d.delete(schema.compositions).run();
  d.delete(schema.compositionExecutions).run();
  stepRunner = NOOP_RUNNER;
  preflightResolver = null;
}

/** Direct candidate injection for tests (bypass the dev endpoint). */
export function _registerCandidateForTests(c: CompositionCandidate): void {
  saveCandidate(c);
}

/**
 * Override the default step runner so the HTTP execute endpoint can be driven
 * into a mid-stream failure (the runner THROWS for the step it should fail).
 * Pass `null` to restore the no-op (all-success) runner. Auto-reset by
 * {@link _clearComposeForTests}.
 */
export function _setStepRunnerForTests(
  fn: ((step: CompositionStep) => Promise<void> | void) | null,
): void {
  stepRunner = fn ?? NOOP_RUNNER;
}

/**
 * Inject a resolver for the whole-plan resource pre-flight gate so the HTTP
 * execute endpoint runs it (tests supply a resolver over mock adapters). Pass
 * `null` to restore the no-op (gate disabled). Auto-reset by
 * {@link _clearComposeForTests}.
 */
export function _setPreflightResolverForTests(
  resolver: PreflightResolver | null,
): void {
  preflightResolver = resolver;
}

/** Read back a stored execution row (test-only assertion helper). */
export function _getExecutionForTests(
  id: string,
): ExecuteCompositionResponse | undefined {
  return getExecution(id);
}
