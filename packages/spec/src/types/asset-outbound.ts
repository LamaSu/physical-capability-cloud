/**
 * Asset-as-Agent Outbound Demand — economic-agency primitive.
 *
 * The composition engine lets a requester compose capabilities into a job.
 * This primitive inverts the labor market: an *asset* (a machine, a device, a
 * tool) becomes an economic agent with a budget and the autonomy to post its
 * OWN outbound demand — "I need a part / a service / a consumable" — which is
 * then routed through the composition engine to find a solution and settled
 * via the existing escrow rail.
 *
 * Phase 1 surface (this file): the owner-set budget envelope
 * (`AssetAgentBudget`) and the outbound-demand request/response pair. The
 * gateway route synthesizes a mock composed solution; a follow-on PR wires
 * `composedSolution` to the real `/api/compose` engine and persists both the
 * budget and the demand through the AssetFacade.
 *
 * Companion to the composition engine. Storage is an in-memory scaffold —
 * the shapes here are the contract the production wiring must preserve.
 */
import { z } from "zod";
import type { Id, Timestamp, AssuranceTier } from "./common.js";

// ── Budget envelope ──────────────────────────────────────────────

/**
 * The spend envelope an owner grants to an asset so it can act as an economic
 * agent. Both caps are hard ceilings; the daily cap resets at UTC midnight.
 * `spent*` fields and timestamps are server-stamped — never client-supplied.
 */
export interface AssetAgentBudget {
  assetId: Id;
  ownerDid: Id;
  budgetCapUSD: number; // lifetime hard ceiling
  dailyCapUSD: number; // per-day cap (resets at UTC midnight)
  spentTodayUSD: number; // running daily total
  spentLifetimeUSD: number; // running lifetime total
  allowedCapabilityTypes?: string[]; // null = any; non-null = whitelist
  requiresOwnerApproval?: boolean; // true → owner must approve each demand
  lastResetAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ── Outbound demand ──────────────────────────────────────────────

/** Why a posted outbound demand landed where it did. */
export type OutboundDemandStatus =
  | "proposed"
  | "approved"
  | "budget_exceeded"
  | "owner_approval_required"
  | "capability_not_allowed"
  | "rejected";

/** The job an asset wants done on its behalf. */
export interface OutboundDemandRequest {
  description: string;
  requiredCapabilityType: string;
  maxPriceUSD: number;
  deadline?: Timestamp;
  minAssuranceTier: AssuranceTier;
  location?: { lat: number; lng: number; radiusKm?: number };
  preferredOptimization?: "price" | "speed" | "quality";
}

/** The persisted outcome of posting an outbound demand. */
export interface OutboundDemandResponse {
  demandId: Id;
  assetId: Id;
  status: OutboundDemandStatus;
  composedSolution?: {
    compositionId: Id;
    totalPriceUSD: number;
    stepCount: number;
  };
  budgetSnapshot: {
    spentTodayUSD: number;
    remainingDailyUSD: number;
    remainingLifetimeUSD: number;
  };
  rejectionReason?: string;
  request: OutboundDemandRequest;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

/** Owner gate decision on an `owner_approval_required` demand. */
export interface ApproveOutboundDemandRequest {
  approved: boolean;
  approverDid: Id;
  note?: string;
}

// ── Zod schemas ──────────────────────────────────────────────────

/**
 * Body schema for `PUT /api/assets/:id/budget`. The owner supplies the caps,
 * identity, and policy fields; the server stamps the running `spent*` totals
 * and all timestamps, so those are intentionally absent here.
 */
export const SetAssetBudgetSchema = z.object({
  ownerDid: z.string().min(1),
  budgetCapUSD: z.number().nonnegative(),
  dailyCapUSD: z.number().nonnegative(),
  allowedCapabilityTypes: z.array(z.string()).optional(),
  requiresOwnerApproval: z.boolean().optional(),
});

export const OutboundDemandRequestSchema = z.object({
  description: z.string().min(1),
  requiredCapabilityType: z.string().min(1),
  maxPriceUSD: z.number().positive(),
  deadline: z.string().optional(),
  minAssuranceTier: z.union([
    z.literal(0),
    z.literal(1),
    z.literal(2),
    z.literal(3),
  ]),
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
      radiusKm: z.number().optional(),
    })
    .optional(),
  preferredOptimization: z.enum(["price", "speed", "quality"]).optional(),
});

export const ApproveOutboundDemandRequestSchema = z.object({
  approved: z.boolean(),
  approverDid: z.string().min(1),
  note: z.string().optional(),
});
