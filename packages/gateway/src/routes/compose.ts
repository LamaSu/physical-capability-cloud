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
 * is the dev-injected SQLite pool by default; set PCC_COMPOSE_USE_FACADE=true to
 * draw real registered capabilities from CapabilityFacade (production wiring)
 * without changing the persisted shape.
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
  type AssuranceTier,
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
import { getJobFacade, getCapabilityFacade, getKernelFacade } from "../facades/index.js";
import type { SubmitJobInput, JobSubmitResult, CapabilityDTO } from "../facades/index.js";
import type { Result } from "@pcc/spec";
import {
  isComposeSettlementEnabled,
  createCompositionEscrow,
  type CompositionSettlementPlan,
} from "../services/compose-settlement.js";

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
 * constraints. The scaffold/dev default is a SQLite-backed in-memory pool;
 * production wires this to {@link facadeProvider}, which draws real registered
 * capabilities from CapabilityFacade.listByType(). Implementations may resolve
 * synchronously (in-memory pool) or asynchronously (facade layer), so callers
 * MUST await the result.
 */
export interface CapabilityProvider {
  findByType(
    capabilityType: string,
    constraints: {
      minAssuranceTier: number;
      location?: LocationConstraint;
    },
  ): CompositionCandidate[] | Promise<CompositionCandidate[]>;
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
// Production candidate provider — CapabilityFacade-backed (the production gap
// this module documents). Selected at runtime by {@link activeProvider}.
// ---------------------------------------------------------------------------

/**
 * Capability DTOs carry no per-job duration estimate — duration is a property
 * of a submitted job, not the capability SKU. Until the catalog models it,
 * facade-sourced candidates use this placeholder; `speed` optimization
 * therefore can't yet differentiate facade candidates (the dev pool still
 * carries explicit per-candidate durations and is unaffected).
 */
const FACADE_DEFAULT_DURATION_MS = 60 * 60 * 1000; // 1h placeholder

/** Highest assurance tier a capability advertises (0 when none declared). */
function maxAssuranceTier(tiers: readonly number[] | undefined): AssuranceTier {
  if (!tiers || tiers.length === 0) return 0;
  const max = Math.max(...tiers);
  return (max >= 0 && max <= 3 ? max : 0) as AssuranceTier;
}

/**
 * Parse a capability's USD price from its pricing model. Prefers `baseCost`,
 * falls back to `minimum`, then 0. PricingModel amounts are strings.
 */
function priceFromPricing(pricing: CapabilityDTO["pricing"] | undefined): number {
  const base = Number.parseFloat(String(pricing?.baseCost ?? ""));
  if (Number.isFinite(base)) return base;
  const min = Number.parseFloat(String(pricing?.minimum ?? ""));
  return Number.isFinite(min) ? min : 0;
}

/** Map an enriched CapabilityDTO + resolved operator → a planner candidate. */
function dtoToCandidate(
  dto: CapabilityDTO,
  operatorAddress: string,
): CompositionCandidate {
  return {
    capabilityId: dto.id,
    kernelId: dto.kernelId,
    operatorAddress,
    capabilityType: dto.type,
    estimatedPriceUSD: priceFromPricing(dto.pricing),
    estimatedDurationMs: FACADE_DEFAULT_DURATION_MS,
    assuranceTier: maxAssuranceTier(dto.assuranceTiers),
    reputation: dto.reputation,
    location: dto.location,
    available: dto.available,
  };
}

/**
 * Production provider: draws real registered capabilities from CapabilityFacade
 * (the same source as `/api/capabilities`). It applies the SAME constraint
 * filter the in-memory provider does (availability, min assurance tier, and
 * location radius) and resolves each candidate's operatorAddress via
 * KernelFacade. Async because the facade layer is async — {@link plan} awaits it.
 */
const facadeProvider: CapabilityProvider = {
  findByType: async (capabilityType, constraints) => {
    const res = await getCapabilityFacade().listByType(capabilityType, {
      includeReputation: true,
    });
    if (!res.success) return [];

    const eligible = res.data.filter((dto) => {
      if (dto.type !== capabilityType) return false; // defensive (facade pre-filters)
      if (!dto.available) return false;
      if (maxAssuranceTier(dto.assuranceTiers) < constraints.minAssuranceTier) {
        return false;
      }
      if (constraints.location && dto.location) {
        const km = haversineKm(constraints.location, dto.location);
        const radius = constraints.location.radiusKm ?? 50;
        if (km > radius) return false;
      }
      return true;
    });

    // Resolve operatorAddress once per unique kernel (KernelFacade), batched.
    const kernelFacade = getKernelFacade();
    const kernelIds = [...new Set(eligible.map((d) => d.kernelId))];
    const opEntries = await Promise.all(
      kernelIds.map(async (kid) => {
        const k = await kernelFacade.getById(kid);
        return [kid, k.success ? k.data.operatorAddress : ""] as const;
      }),
    );
    const operatorByKernel = new Map<string, string>(opEntries);

    return eligible.map((dto) =>
      dtoToCandidate(dto, operatorByKernel.get(dto.kernelId) ?? ""),
    );
  },
};

/**
 * Provider selection — the production wiring switch. Test/dev default is the
 * in-memory candidate pool (filled via `_dev/register-candidate` /
 * `_registerCandidateForTests`); production sets PCC_COMPOSE_USE_FACADE=true so
 * /api/compose draws real registered capabilities through {@link facadeProvider}.
 * The dev endpoint + pool are retained either way (tests rely on them).
 */
function activeProvider(): CapabilityProvider {
  return process.env.PCC_COMPOSE_USE_FACADE === "true"
    ? facadeProvider
    : inMemoryProvider;
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

async function plan(
  req: ComposeRequest,
  provider: CapabilityProvider,
): Promise<{ steps: CompositionStep[]; status: CompositionStatus; rejection?: string }> {
  const stepTypes = req.steps ?? [req.outcomeType];
  const optimization = req.optimizeFor ?? "price";

  const chosen: CompositionStep[] = [];
  for (let i = 0; i < stepTypes.length; i++) {
    const capType = stepTypes[i]!;
    const matches = await provider.findByType(capType, {
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
async function planSteps(req: ComposeRequest): Promise<PlanResult> {
  // (1) Explicit chain → graph-search on the final outcome type.
  if (req.outcomeChain && req.outcomeChain.length > 0) {
    const finalType = req.outcomeChain[req.outcomeChain.length - 1]!;
    return planViaGraphSearch(req, finalType);
  }

  // (2) Direct provider first — preserves the backwards-compatible 1-step
  //     (and explicit `steps`) behaviour exactly. The active provider is the
  //     in-memory dev pool by default, or the CapabilityFacade-backed provider
  //     in production (PCC_COMPOSE_USE_FACADE=true) — see {@link activeProvider}.
  const direct = await plan(req, activeProvider());
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
 * Picks one of two planners (see {@link planSteps}): the active candidate
 * provider (in-memory dev pool or CapabilityFacade) for direct single-step /
 * `steps` requests, or graph-search's
 * Dijkstra traversal for an explicit `outcomeChain` or when no direct provider
 * matches. Either way the result is summarized identically and persisted to the
 * same store as the HTTP route, so the returned `compositionId` remains
 * retrievable via `GET /api/compose/:id`.
 *
 * Returns a full {@link ComposeResponse}; inspect `.status` to distinguish
 * `proposed` (plan ready) from `over_budget` / `no_path_found` (rejections).
 */
export async function planComposition(req: ComposeRequest): Promise<ComposeResponse> {
  const result = await planSteps(req);
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
  /** Runs one step; throw to mark it failed. Default: no-op (stub success). */
  runStep?: (step: CompositionStep) => Promise<void> | void;
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
  /**
   * Per-leg escrow settlement (Lane 2 DRAFT) — present only when
   * PCC_COMPOSE_SETTLEMENT=true. `plan` carries the escrow address + the
   * leg→milestone mapping; `error` is non-null when escrow creation failed,
   * in which case the execution failed CLOSED (no steps ran). Deliberately
   * NOT part of the HTTP ExecuteCompositionResponse (spec untouched) —
   * in-process callers and the persisted execution consume it.
   */
  settlement?: {
    plan: CompositionSettlementPlan | null;
    error: string | null;
  };
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
    runStep: async (step: CompositionStep): Promise<void> => {
      const facade = facadeGetter ? facadeGetter() : getJobFacade();
      const result = await facade.submit({
        stepId: step.capabilityId,
        kernelId: step.kernelId,
        capabilityId: step.capabilityId,
        assuranceTier: step.assuranceTier,
        description: `Composition step: ${step.capabilityType}`,
      });
      if (!result.success) {
        throw new Error(
          `Job submission failed for step ${step.index} (${step.capabilityId}): ${result.error?.message ?? "unknown error"}`,
        );
      }
    },
  };
}

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

  // Determine the effective step runner:
  // - Explicit binding.runStep always wins.
  // - Otherwise, use the production binding when PCC_COMPOSE_EXECUTE_REAL=true.
  // - Otherwise, fall back to the module-level stepRunner (NOOP in tests).
  const effectiveRunStep: (step: CompositionStep) => Promise<void> | void =
    binding.runStep ??
    (process.env.PCC_COMPOSE_EXECUTE_REAL === "true"
      ? createProductionBinding().runStep!
      : stepRunner);

  // ── Lane 2 (DRAFT): per-leg escrow settlement ────────────────────────────
  // When PCC_COMPOSE_SETTLEMENT=true, create + fund ONE MilestoneEscrowV3 with
  // one milestone per settleable leg BEFORE any step runs. Fail CLOSED: if the
  // composition's pay cannot be escrowed, no step executes — running legs
  // nobody can be paid for is worse than failing fast. Shape per
  // ai/research/industry-pain-points/lane2-escrow-shape-ADR.md (Option A,
  // owner sign-off pending). Release is per-leg, on each leg's OWN completion
  // evidence — see services/compose-settlement.ts for the flagged
  // completion-signal dependency (feat/composition-preflight-gate).
  let settlement: CompositionExecutionResult["settlement"];
  if (isComposeSettlementEnabled()) {
    try {
      settlement = { plan: await createCompositionEscrow(composition), error: null };
    } catch (err) {
      return {
        compositionId,
        workflowId: `wf_${randomUUID()}`,
        status: "failed",
        startedAt,
        completedAt: nowISO(),
        stepsExecuted: 0,
        failedStepIndex: null,
        deltasApplied: [],
        settlement: {
          plan: null,
          error: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  let failedStepIndex: number | null = null;
  let stepsExecuted = 0;

  for (const step of composition.steps) {
    const executorAgentId = resolveExecutor(step);
    let status: StepOutcomeStatus = "success";
    try {
      await effectiveRunStep(step);
    } catch {
      status = "failed";
    }

    recordStepOutcome({
      compositionId,
      stepIndex: step.index,
      capabilityId: step.capabilityId,
      agentId: executorAgentId,
      status,
      startedAt,
      completedAt: nowISO(),
    });
    stepsExecuted += 1;

    if (status === "failed") {
      failedStepIndex = step.index;
      break; // short-circuit — do not execute downstream steps
    }
  }

  // Settle reputation: +10 per success, -15 on the failed step, +5 bonus to all
  // participants when every step succeeded. Idempotent if already finalized.
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
    settlement,
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

    const response = await planComposition(parsed.data);
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

      const result = await executeComposition(c);
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

  // POST /api/compose/_dev/register-candidate — dev/test-only candidate injection
  //
  // Production draws candidates from CapabilityFacade (PCC_COMPOSE_USE_FACADE=true);
  // this endpoint + the in-memory pool are retained for dev/test, which rely on them.
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
