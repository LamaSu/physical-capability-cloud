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
 * Design notes (mirrors the composition-engine scaffold):
 *   - Storage is two process-local `Map`s. Production wires budgets to the
 *     AssetFacade and persists demands alongside escrow rows.
 *   - `composedSolution` is synthesized here; a follow-on PR calls the real
 *     `/api/compose` engine and threads the returned composition through.
 *   - Demands expire 30 minutes after creation (same TTL as a negotiation /
 *     composition session) — a stale demand returns 410 Gone.
 *   - Daily caps reset lazily at the first demand on a new UTC day; there is
 *     no cron — the reset is folded into the spend check.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  SetAssetBudgetSchema,
  OutboundDemandRequestSchema,
  ApproveOutboundDemandRequestSchema,
  type AssetAgentBudget,
  type OutboundDemandRequest,
  type OutboundDemandResponse,
  type OutboundDemandStatus,
} from "@pcc/spec";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Demands expire 30 minutes after creation (mirrors composition sessions). */
const DEMAND_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// In-memory stores (process-local scaffold)
// ---------------------------------------------------------------------------

/** Budget envelope per asset, keyed by assetId. */
const budgets = new Map<string, AssetAgentBudget>();

/** Posted outbound demands, keyed by demandId. */
const demands = new Map<string, OutboundDemandResponse>();

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

/** Synthesize a mock composed solution. Follow-on wires this to /api/compose. */
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
      const existing = budgets.get(assetId);

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
        budgets.set(assetId, updated);
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
      budgets.set(assetId, created);
      return reply.status(201).send(created);
    },
  );

  // ── GET /api/assets/:id/budget ──────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/assets/:id/budget",
    async (req, reply) => {
      const budget = budgets.get(req.params.id);
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
      const budget = budgets.get(assetId);
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
        demands.set(demandId, demand);
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

      // 4. Happy path — synthesize a solution and charge the budget.
      const composedSolution = synthesizeSolution(request, budget);
      budget.spentTodayUSD += composedSolution.totalPriceUSD;
      budget.spentLifetimeUSD += composedSolution.totalPriceUSD;
      budget.updatedAt = nowIso;
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

      const demand = demands.get(req.params.demandId);
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

      const budget = budgets.get(req.params.id);
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
        demand.status = "approved";
        demand.composedSolution = composedSolution;
        demand.rejectionReason = undefined;
      } else {
        demand.status = "rejected";
        demand.rejectionReason = parsed.data.note ?? "Rejected by owner";
      }
      demand.budgetSnapshot = snapshotOf(budget);
      demands.set(demand.demandId, demand);
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

      let list = Array.from(demands.values()).filter((d) => d.assetId === assetId);
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
      const demand = demands.get(req.params.demandId);
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

/** Clear both in-memory stores between tests. */
export function _clearAssetOutboundForTests(): void {
  budgets.clear();
  demands.clear();
}

/** Seed a budget directly (bypasses PUT validation/stamping). */
export function _seedBudgetForTests(budget: AssetAgentBudget): void {
  budgets.set(budget.assetId, budget);
}

/** Seed a demand directly — lets tests control createdAt / expiresAt / status. */
export function _seedDemandForTests(demand: OutboundDemandResponse): void {
  demands.set(demand.demandId, demand);
}
