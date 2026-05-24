/**
 * Demand Intent Capture Types — INTERNAL ONLY
 *
 * PCC captures composite-intent demand from its own API surface (and later
 * from network-level interception) into a private intelligence store. The
 * goal is strategic: know what global demand exists, where, and at what
 * intensity so PCC can allocate capacity, prioritize operator onboarding,
 * and identify niche composites worth specialized fulfillment.
 *
 * This data is PRIVATE. Not published. Not on-chain. Not signed for external
 * verification — PCC is the consumer of its own intelligence, not a public
 * feed publisher. Access is gated to authenticated PCC operators only.
 *
 * Phase 1 surface: DemandEnvelope (single intent), DemandSnapshot (window
 * aggregate). Sketch implementations live in @pcc/demand-intel.
 */
import { z } from "zod";
import type { AssuranceTier, Timestamp } from "./common.js";
import { canonicalize } from "../util/canonical.js";
import { sha256 as sha256Hash } from "@noble/hashes/sha256";

// ── Branded types ────────────────────────────────────────────────

/** sha256 hex string for a composition signature, prefixed with `0x` */
export type CompositionSignature = `0x${string}`;

// ── Enums ────────────────────────────────────────────────────────

/** Budget bucket — coarse-grained to enable aggregation without raw $ leakage */
export type BudgetBand =
  | "under_100"
  | "100_1k"
  | "1k_10k"
  | "10k_100k"
  | "100k_plus";

/** Urgency bucket — mirrors requests.urgency to keep the union stable */
export type UrgencyBand = "standard" | "rush" | "emergency";

/** Where the intent was captured */
export type IntentSource =
  | "requests_api"        // POST /api/requests
  | "negotiate_api"       // POST /api/negotiate/session
  | "query_api_synthetic" // POST /api/query, build-intent heuristic match
  | "sdk"                 // Phase 2 stub
  | "mcp_broker"          // Phase 2 stub
  | "otel";               // Phase 2 stub

/** How the captured intent ultimately got served (filled later by the fulfillment loop) */
export type FulfillmentPath = "auto" | "concierge" | "unfulfilled";

// ── Envelope ─────────────────────────────────────────────────────

/**
 * Single captured demand intent — atomic or composite. The shape is the same
 * across capture points so the aggregator can fold them uniformly.
 */
export interface DemandEnvelope {
  id: string;
  source: IntentSource;
  /** sha256(sorted capabilityTypes + sorted dependency edges) — stable across requesters */
  compositionSignature: CompositionSignature;
  /** Atomic types in this composite (single-element array for atomic intents) */
  capabilityTypes: string[];
  /** ≤200 char human-readable summary */
  summary: string;
  /** Phase 2 — int8 quantized embedding of the summary */
  embeddingQuantized?: number[];
  /** Country code, region tag, or "unknown" */
  geographicRegion?: string;
  budgetBand: BudgetBand;
  urgencyBand: UrgencyBand;
  assuranceTier?: AssuranceTier;
  /** Submitting agent identifier (e.g. claude-instance-uuid), when known */
  originAgentId?: string;
  /** Agent vendor (claude, openai, langchain, etc.) — phase-2 SDK fills this */
  originAgentVendor?: string;
  /** sha256(email|wallet) — never raw PII */
  requesterIdHash?: string;
  /** Filled by the fulfillment loop after capture */
  fulfillmentPath?: FulfillmentPath;
  /** ISO 8601 */
  createdAt: Timestamp;
}

// ── Snapshot ─────────────────────────────────────────────────────

/** Per-composition top-K row in a snapshot */
export interface DemandSnapshotComposition {
  signature: string;
  count: number;
  /** Top regions for this composition */
  geoTopN: Array<{ region: string; count: number }>;
  /** Top budget bands for this composition */
  budgetBandTopN: Array<{ band: string; count: number }>;
}

/** T-digest output for a numeric distribution */
export interface BudgetPercentiles {
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
}

/**
 * Windowed aggregate of captured intents, stored in PCC's private intelligence
 * backend for internal strategic queries. Not signed, not published — read by
 * PCC's own operator dashboards and resource-allocation tooling.
 */
export interface DemandSnapshot {
  id: string;
  window: "hour" | "day";
  /** ISO 8601 */
  windowStart: Timestamp;
  /** ISO 8601 */
  windowEnd: Timestamp;
  /** Top 50 compositions in the window */
  topCompositions: DemandSnapshotComposition[];
  /** HyperLogLog estimate of distinct requester hashes */
  uniqueRequestersApprox: number;
  /** T-digest of budget upper bounds */
  budgetPercentiles: BudgetPercentiles;
  /** Total intents captured in the window */
  totalIntents: number;
  /** When this snapshot was computed */
  computedAt: Timestamp;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Compute a deterministic composition signature from a sorted set of capability
 * types and dependency edges. Identical inputs always produce identical
 * signatures regardless of original ordering.
 */
export function computeCompositionSignature(
  capabilityTypes: string[],
  dependencies: Array<{ from: string; to: string }>,
): CompositionSignature {
  const sortedTypes = [...capabilityTypes].sort();
  const sortedEdges = [...dependencies]
    .map((e) => ({ from: e.from, to: e.to }))
    .sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
    });
  const canon = canonicalize({ types: sortedTypes, edges: sortedEdges });
  const bytes = sha256Hash(new TextEncoder().encode(canon));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as CompositionSignature;
}

/** Map a numeric budget (in major units of the contract's currency) to a band */
export function budgetToBand(amount: number): BudgetBand {
  if (amount < 100) return "under_100";
  if (amount < 1_000) return "100_1k";
  if (amount < 10_000) return "1k_10k";
  if (amount < 100_000) return "10k_100k";
  return "100k_plus";
}

// ── Zod schemas ──────────────────────────────────────────────────

export const CompositionSignatureSchema = z
  .string()
  .regex(/^0x[a-f0-9]{64}$/i, "Must be 0x followed by 64 hex chars");

export const BudgetBandSchema = z.enum([
  "under_100",
  "100_1k",
  "1k_10k",
  "10k_100k",
  "100k_plus",
]);

export const UrgencyBandSchema = z.enum(["standard", "rush", "emergency"]);

export const IntentSourceSchema = z.enum([
  "requests_api",
  "negotiate_api",
  "query_api_synthetic",
  "sdk",
  "mcp_broker",
  "otel",
]);

export const FulfillmentPathSchema = z.enum(["auto", "concierge", "unfulfilled"]);

export const DemandEnvelopeSchema = z.object({
  id: z.string(),
  source: IntentSourceSchema,
  compositionSignature: CompositionSignatureSchema,
  capabilityTypes: z.array(z.string()),
  summary: z.string().max(200),
  embeddingQuantized: z.array(z.number()).optional(),
  geographicRegion: z.string().optional(),
  budgetBand: BudgetBandSchema,
  urgencyBand: UrgencyBandSchema,
  assuranceTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  originAgentId: z.string().optional(),
  originAgentVendor: z.string().optional(),
  requesterIdHash: z.string().optional(),
  fulfillmentPath: FulfillmentPathSchema.optional(),
  createdAt: z.string(),
});

export const DemandSnapshotCompositionSchema = z.object({
  signature: z.string(),
  count: z.number().int().nonnegative(),
  geoTopN: z.array(z.object({ region: z.string(), count: z.number().int().nonnegative() })),
  budgetBandTopN: z.array(z.object({ band: z.string(), count: z.number().int().nonnegative() })),
});

export const BudgetPercentilesSchema = z.object({
  p25: z.number(),
  p50: z.number(),
  p75: z.number(),
  p90: z.number(),
  p99: z.number(),
});

export const DemandSnapshotSchema = z.object({
  id: z.string(),
  window: z.enum(["hour", "day"]),
  windowStart: z.string(),
  windowEnd: z.string(),
  topCompositions: z.array(DemandSnapshotCompositionSchema).max(50),
  uniqueRequestersApprox: z.number().int().nonnegative(),
  budgetPercentiles: BudgetPercentilesSchema,
  totalIntents: z.number().int().nonnegative(),
  computedAt: z.string(),
});
