/**
 * Asset-as-Agent Outbound Demand — gateway routes.
 *
 * Assets become economic agents: an owner grants a budget envelope, and the
 * asset autonomously posts OUTBOUND demand ("I need this capability") which is
 * routed to a composed solution and settled via escrow. This inverts the
 * usual labor market — instead of a requester shopping for capabilities, the
 * capability-bearing asset shops for what *it* needs to keep running.
 *
 *   PUT  /api/assets/:id/budget                         — owner sets/updates budget
 *   GET  /api/assets/:id/budget                         — read budget
 *   POST /api/assets/:id/outbound-demand                — asset posts a demand
 *   POST /api/assets/:id/outbound-demand/:demandId/approve — owner gate
 *   GET  /api/assets/:id/outbound-demand[?status=]      — list demands for asset
 *   GET  /api/assets/:id/outbound-demand/:demandId      — single demand
 *
 * Storage: SQLite via @pcc/store (asset_budgets + outbound_demands), following
 * the marketplace / requests persistence pattern — budgets and demands survive
 * gateway redeploys. The budget envelope is a flat object stored column-by-
 * column (it mutates in place on spend / daily-reset, so a single source of
 * truth avoids JSON drift). Demands keep the full OutboundDemandResponse in a
 * JSON column.
 *
 * Daily caps reset lazily at the first demand on a new UTC day; there is no
 * cron — the reset is folded into the spend check.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  SetAssetBudgetSchema,
  OutboundDemandRequestSchema,
  ApproveOutboundDemandRequestSchema,
  type AssetAgentBudget,
  type ComposeRequest,
  type OutboundDemandRequest,
  type OutboundDemandResponse,
  type OutboundDemandStatus,
} from "@pcc/spec";
import { schema, eq } from "@pcc/store";
import { getStore, initStore } from "../db.js";
import { planComposition } from "./compose.js";

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Demands expire 30 minutes after creation (mirrors composition sessions). */
const DEMAND_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

/** Reconstruct an AssetAgentBudget from its column row (optionals → undefined). */
function loadBudget(assetId: string): AssetAgentBudget | undefined {
  const row = db()
    .select()
    .from(schema.assetBudgets)
    .where(eq(schema.assetBudgets.assetId, assetId))
    .get();
  if (!row) return undefined;
  return {
    assetId: row.assetId,
    ownerDid: row.ownerDid,
    budgetCapUSD: row.budgetCapUsd,
    dailyCapUSD: row.dailyCapUsd,
    spentTodayUSD: row.spentTodayUsd,
    spentLifetimeUSD: row.spentLifetimeUsd,
    allowedCapabilityTypes: row.allowedCapabilityTypes ?? undefined,
    requiresOwnerApproval: row.requiresOwnerApproval ?? undefined,
    lastResetAt: row.lastResetAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Idempotent upsert of a budget by assetId. created_at is preserved on update. */
function saveBudget(b: AssetAgentBudget): void {
  const cols = {
    ownerDid: b.ownerDid,
    budgetCapUsd: b.budgetCapUSD,
    dailyCapUsd: b.dailyCapUSD,
    spentTodayUsd: b.spentTodayUSD,
    spentLifetimeUsd: b.spentLifetimeUSD,
    allowedCapabilityTypes: b.allowedCapabilityTypes ?? null,
    requiresOwnerApproval: b.requiresOwnerApproval ?? null,
    lastResetAt: b.lastResetAt,
    updatedAt: b.updatedAt,
  };
  db()
    .insert(schema.assetBudgets)
    .values({ assetId: b.assetId, createdAt: b.createdAt, ...cols })
    .onConflictDoUpdate({ target: schema.assetBudgets.assetId, set: cols })
    .run();
}

function getDemand(demandId: string): OutboundDemandResponse | undefined {
  const row = db()
    .select()
    .from(schema.outboundDemands)
    .where(eq(schema.outboundDemands.demandId, demandId))
    .get();
  return row ? (row.data as OutboundDemandResponse) : undefined;
}

function listDemandsForAsset(assetId: string): OutboundDemandResponse[] {
  const rows = db()
    .select()
    .from(schema.outboundDemands)
    .where(eq(schema.outboundDemands.assetId, assetId))
    .all();
  return rows.map((r) => r.data as OutboundDemandResponse);
}

/** Idempotent upsert of a demand by demandId. */
function saveDemand(d: OutboundDemandResponse): void {
  const cols = {
    assetId: d.assetId,
    status: d.status,
    rejectionReason: d.rejectionReason ?? null,
    expiresAt: d.expiresAt,
    updatedAt: new Date().toISOString(),
    data: d,
  };
  db()
    .insert(schema.outboundDemands)
    .values({ demandId: d.demandId, createdAt: d.createdAt, ...cols })
    .onConflictDoUpdate({ target: schema.outboundDemands.demandId, set: cols })
    .run();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `lastReset` (an ISO timestamp) falls on an earlier UTC calendar
 * day than `now`. Comparison is on the `YYYY-MM-DD` prefix of each instant's
 * UTC ISO form, so it is timezone-independent.
 */
export function isNewUtcDay(lastReset: string, now: Date): boolean {
  const lastDay = new Date(lastReset).toISOString().slice(0, 10);
  const nowDay = now.toISOString().slice(0, 10);
  return lastDay < nowDay;
}

/** Project a budget into the public snapshot embedded in a demand response. */
function snapshotOf(b: AssetAgentBudget): OutboundDemandResponse["budgetSnapshot"] {
  return {
    spentTodayUSD: b.spentTodayUSD,
    remainingDailyUSD: Math.max(0, b.dailyCapUSD - b.spentTodayUSD),
    remainingLifetimeUSD: Math.max(0, b.budgetCapUSD - b.spentLifetimeUSD),
  };
}

/**
 * Synthesize a mock composed solution.
 *
 * Retained ONLY for the owner-approval gate (`/approve`), whose planner wiring
 * is a separate follow-up. The direct `proposed` path below now routes through
 * the real composition engine via {@link toComposeRequest} + `planComposition`.
 */
function synthesizeSolution(
  request: OutboundDemandRequest,
  budget: AssetAgentBudget,
): NonNullable<OutboundDemandResponse["composedSolution"]> {
  return {
    compositionId: `cmp_${crypto.randomUUID()}`,
    totalPriceUSD: Math.min(request.maxPriceUSD, budget.budgetCapUSD),
    stepCount: 1,
  };
}

/**
 * Map an OutboundDemandRequest into a ComposeRequest for the composition engine.
 *
 *   - `requiredCapabilityType` → `outcomeType`: the matchable key the planner
 *     resolves against capability instances. (NOT the human description — that
 *     would never match a real `capabilityType`.)
 *   - `maxPriceUSD` → `budgetUSD`: the planner's hard ceiling, so any plan it
 *     returns is already within the asset's willingness-to-pay.
 *   - `preferredOptimization` → `optimizeFor` (default "price").
 *   - `location` passes straight through (shapes are identical).
 *   - `description` is carried for audit only; the planner ignores it.
 *   - `deadline` has no ComposeRequest analog yet and is intentionally dropped.
 */
function toComposeRequest(request: OutboundDemandRequest): ComposeRequest {
  return {
    outcomeType: request.requiredCapabilityType,
    budgetUSD: request.maxPriceUSD,
    minAssuranceTier: request.minAssuranceTier,
    optimizeFor: request.preferredOptimization ?? "price",
    location: request.location,
    description: `${request.requiredCapabilityType}: ${request.description}`,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function assetOutboundRoutes(app: FastifyInstance) {
  // ── PUT /api/assets/:id/budget ──────────────────────────────────────────
  // Owner sets or updates the asset's budget envelope. 201 on create, 200 on
  // update. `spentTodayUSD`/`spentLifetimeUSD` are server-stamped (0 only on
  // creation); `lastResetAt` and timestamps are always server-stamped.
  app.put<{ Params: { id: string } }>(
    "/api/assets/:id/budget",
    async (req, reply) => {
      const parsed = SetAssetBudgetSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid asset budget payload",
          details: parsed.error.flatten(),
        });
      }

      const assetId = req.params.id;
      const nowIso = new Date().toISOString();
      const existing = loadBudget(assetId);

      if (existing) {
        const updated: AssetAgentBudget = {
          ...existing,
          ownerDid: parsed.data.ownerDid,
          budgetCapUSD: parsed.data.budgetCapUSD,
          dailyCapUSD: parsed.data.dailyCapUSD,
          allowedCapabilityTypes: parsed.data.allowedCapabilityTypes,
          requiresOwnerApproval: parsed.data.requiresOwnerApproval,
          updatedAt: nowIso,
        };
        saveBudget(updated);
        return reply.status(200).send(updated);
      }

      const created: AssetAgentBudget = {
        assetId,
        ownerDid: parsed.data.ownerDid,
        budgetCapUSD: parsed.data.budgetCapUSD,
        dailyCapUSD: parsed.data.dailyCapUSD,
        spentTodayUSD: 0,
        spentLifetimeUSD: 0,
        allowedCapabilityTypes: parsed.data.allowedCapabilityTypes,
        requiresOwnerApproval: parsed.data.requiresOwnerApproval,
        lastResetAt: nowIso,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      saveBudget(created);
      return reply.status(201).send(created);
    },
  );

  // ── GET /api/assets/:id/budget ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/assets/:id/budget",
    async (req, reply) => {
      const budget = loadBudget(req.params.id);
      if (!budget) {
        return reply.status(404).send({
          error: "budget_not_found",
          message: `No budget set for asset ${req.params.id}`,
        });
      }
      return reply.status(200).send(budget);
    },
  );

  // ── POST /api/assets/:id/outbound-demand ────────────────────────────────
  // The asset posts an outbound demand. Always returns 201 with a persisted
  // OutboundDemandResponse; the `status` field encodes the outcome
  // (proposed / budget_exceeded / capability_not_allowed /
  // owner_approval_required). 404 only when no budget has been set.
  app.post<{ Params: { id: string } }>(
    "/api/assets/:id/outbound-demand",
    async (req, reply) => {
      const parsed = OutboundDemandRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid outbound demand payload",
          details: parsed.error.flatten(),
        });
      }

      const assetId = req.params.id;
      const budget = loadBudget(assetId);
      if (!budget) {
        return reply.status(404).send({
          error: "budget_not_found",
          message: `No budget set for asset ${assetId}. Set one via PUT /api/assets/${assetId}/budget first.`,
        });
      }

      const now = new Date();
      const nowIso = now.toISOString();

      // Lazy daily-cap reset at the first demand on a new UTC day.
      if (isNewUtcDay(budget.lastResetAt, now)) {
        budget.spentTodayUSD = 0;
        budget.lastResetAt = nowIso;
        budget.updatedAt = nowIso;
        saveBudget(budget);
      }

      const request: OutboundDemandRequest = parsed.data;
      const demandId = `dmd_${crypto.randomUUID()}`;
      const createdAt = nowIso;
      const expiresAt = new Date(now.getTime() + DEMAND_TTL_MS).toISOString();

      /** Persist a demand in its terminal state and return the 201 response. */
      const persist = (
        status: OutboundDemandStatus,
        extra: {
          composedSolution?: OutboundDemandResponse["composedSolution"];
          rejectionReason?: string;
        } = {},
      ) => {
        const demand: OutboundDemandResponse = {
          demandId,
          assetId,
          status,
          composedSolution: extra.composedSolution,
          budgetSnapshot: snapshotOf(budget),
          rejectionReason: extra.rejectionReason,
          request,
          createdAt,
          expiresAt,
        };
        saveDemand(demand);
        return reply.status(201).send(demand);
      };

      // 1. Budget gate — must fit under BOTH the remaining daily and lifetime caps.
      const remainingDaily = budget.dailyCapUSD - budget.spentTodayUSD;
      const remainingLifetime = budget.budgetCapUSD - budget.spentLifetimeUSD;
      if (request.maxPriceUSD > remainingDaily || request.maxPriceUSD > remainingLifetime) {
        return persist("budget_exceeded", {
          rejectionReason: `maxPriceUSD ${request.maxPriceUSD} exceeds remaining budget (daily ${remainingDaily}, lifetime ${remainingLifetime})`,
        });
      }

      // 2. Capability whitelist gate (when the owner restricted the asset).
      if (
        budget.allowedCapabilityTypes &&
        !budget.allowedCapabilityTypes.includes(request.requiredCapabilityType)
      ) {
        return persist("capability_not_allowed", {
          rejectionReason: `requiredCapabilityType "${request.requiredCapabilityType}" is not in the allowed list`,
        });
      }

      // 3. Owner-approval gate — hold the demand without spending.
      if (budget.requiresOwnerApproval) {
        return persist("owner_approval_required");
      }

      // 4. Route the demand through the real composition engine. The budget
      //    gate above already guaranteed headroom for `maxPriceUSD`, which is
      //    handed to the planner as its budget — so any returned plan is within
      //    the asset's ceiling.
      const composition = await planComposition(toComposeRequest(request));

      // 4a. No capability covers the demand at the required tier → reject,
      //     without touching the spend counters.
      if (composition.status === "no_path_found") {
        return persist("rejected", {
          rejectionReason:
            composition.rejectionReason ??
            `No composition path found for "${request.requiredCapabilityType}"`,
        });
      }

      // 4b. Even the cheapest path exceeds the demand's max price → no spend.
      //     (Mapped to budget_exceeded — same terminal meaning as the pre-gate.)
      if (composition.status === "over_budget") {
        return persist("budget_exceeded", {
          rejectionReason:
            composition.rejectionReason ??
            `Cheapest composition exceeds maxPriceUSD ${request.maxPriceUSD}`,
        });
      }

      // 4c. Proposed — charge the ACTUAL composed price (≤ maxPriceUSD), not the
      //     ceiling, then persist. Spend counters move ONLY on this branch.
      const composedSolution = {
        compositionId: composition.compositionId,
        totalPriceUSD: composition.totalPriceUSD,
        stepCount: composition.steps.length,
      };
      budget.spentTodayUSD += composedSolution.totalPriceUSD;
      budget.spentLifetimeUSD += composedSolution.totalPriceUSD;
      budget.updatedAt = nowIso;
      saveBudget(budget);
      return persist("proposed", { composedSolution });
    },
  );

  // ── POST /api/assets/:id/outbound-demand/:demandId/approve ──────────────
  // Owner gate for a demand parked in `owner_approval_required`. Approving
  // synthesizes the solution and charges the budget; rejecting records a
  // reason. Any other current status is a 409 conflict.
  app.post<{ Params: { id: string; demandId: string } }>(
    "/api/assets/:id/outbound-demand/:demandId/approve",
    async (req, reply) => {
      const parsed = ApproveOutboundDemandRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "invalid_body",
          message: "Invalid approval payload",
          details: parsed.error.flatten(),
        });
      }

      const demand = getDemand(req.params.demandId);
      if (!demand) {
        return reply.status(404).send({
          error: "demand_not_found",
          message: `No demand ${req.params.demandId}`,
        });
      }
      if (demand.status !== "owner_approval_required") {
        return reply.status(409).send({
          error: "invalid_state",
          message: `Demand ${demand.demandId} is "${demand.status}", not "owner_approval_required"`,
        });
      }

      const budget = loadBudget(req.params.id);
      if (!budget) {
        return reply.status(404).send({
          error: "budget_not_found",
          message: `No budget set for asset ${req.params.id}`,
        });
      }

      const nowIso = new Date().toISOString();

      if (parsed.data.approved) {
        const composedSolution = synthesizeSolution(demand.request, budget);
        budget.spentTodayUSD += composedSolution.totalPriceUSD;
        budget.spentLifetimeUSD += composedSolution.totalPriceUSD;
        budget.updatedAt = nowIso;
        saveBudget(budget);
        demand.status = "approved";
        demand.composedSolution = composedSolution;
        demand.rejectionReason = undefined;
      } else {
        demand.status = "rejected";
        demand.rejectionReason = parsed.data.note ?? "Rejected by owner";
      }
      demand.budgetSnapshot = snapshotOf(budget);
      saveDemand(demand);
      return reply.status(200).send(demand);
    },
  );

  // ── GET /api/assets/:id/outbound-demand ─────────────────────────────────
  // List an asset's demands, newest first. Optional `?status=` filter.
  app.get<{ Params: { id: string }; Querystring: { status?: string } }>(
    "/api/assets/:id/outbound-demand",
    async (req, reply) => {
      const assetId = req.params.id;
      const statusFilter = req.query.status;

      let list = listDemandsForAsset(assetId);
      if (statusFilter) {
        list = list.filter((d) => d.status === statusFilter);
      }
      // Descending by createdAt (ISO strings sort lexicographically by time).
      list.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );

      return reply.status(200).send({ demands: list, count: list.length });
    },
  );

  // ── GET /api/assets/:id/outbound-demand/:demandId ───────────────────────
  // Single demand. 404 unknown, 410 once past its 30-minute TTL.
  app.get<{ Params: { id: string; demandId: string } }>(
    "/api/assets/:id/outbound-demand/:demandId",
    async (req, reply) => {
      const demand = getDemand(req.params.demandId);
      if (!demand) {
        return reply.status(404).send({
          error: "demand_not_found",
          message: `No demand ${req.params.demandId}`,
        });
      }
      if (new Date(demand.expiresAt).getTime() < Date.now()) {
        return reply.status(410).send({
          error: "demand_expired",
          message: `Demand ${demand.demandId} expired at ${demand.expiresAt}`,
          demandId: demand.demandId,
          expiresAt: demand.expiresAt,
        });
      }
      return reply.status(200).send(demand);
    },
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Clear both stores between tests. */
export function _clearAssetOutboundForTests(): void {
  const d = db();
  d.delete(schema.assetBudgets).run();
  d.delete(schema.outboundDemands).run();
}

/** Seed a budget directly (bypasses PUT validation/stamping). */
export function _seedBudgetForTests(budget: AssetAgentBudget): void {
  saveBudget(budget);
}

/** Seed a demand directly — lets tests control createdAt / expiresAt / status. */
export function _seedDemandForTests(demand: OutboundDemandResponse): void {
  saveDemand(demand);
}
