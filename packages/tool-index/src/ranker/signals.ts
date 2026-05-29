/**
 * Phase-2 signal extractors for the HybridRanker.
 *
 * Each signal returns a value in [0, 1]. The phase-2 scorer multiplies
 * by the corresponding weight (from `RankerQuery.weights` or the active
 * preset), sums, then multiplies by 0/1 hard-gate aggregate.
 *
 * Per ai/scoping/vespa-hybrid-ranking-2026-05-23.md §4.2:
 *
 *   trust       — TIER_VALUE[trustTier]
 *   provenance  — base_pop × successRate × meanDccClass  (PCC-distinct)
 *   reputation  — source-typed external scorecard
 *   freshness   — exp-decay(lastFetchedAt) × drift multiplier
 *   price       — affinity to caller's priceHint
 *   geo         — haversine(kernelLocation, query.location)
 */

import type { IndexedTool } from "@pcc/spec";
import { TrustTier } from "@pcc/spec";
import type { GeoLocation, PriceHint } from "./types.js";

// ---------------------------------------------------------------------------
// Tier values — per §4.2.1
// ---------------------------------------------------------------------------

/**
 * Per-tier base value in [0, 1] for the trust_gate signal. QUARANTINED
 * scores 0 — the hard-gate machinery should have excluded it before this
 * function ever runs, but we keep the 0 here as a defense-in-depth.
 */
export const TIER_VALUE: Record<TrustTier, number> = {
  [TrustTier.QUARANTINED]: 0,
  [TrustTier.UNTRUSTED]: 0.3,
  [TrustTier.AUTO_INDEXED]: 0.55,
  [TrustTier.VERIFIED_PUBLISHER]: 0.8,
  [TrustTier.VERIFIED_PARTNER]: 0.95,
  [TrustTier.PCC_NATIVE]: 1.0,
};

/** trust_gate(d) = TIER_VALUE[d.trustTier]. */
export function trustSignal(tool: IndexedTool): number {
  return TIER_VALUE[tool.trustTier] ?? 0;
}

// ---------------------------------------------------------------------------
// Provenance — invocationCount × successRate × meanDccClass
// ---------------------------------------------------------------------------

/**
 * Sigmoid that maps invocation count to [0, 1) — 0 at 0 calls, 0.5 at 100,
 * 0.99 at 10K. Prevents a tool with 100K invocations from drowning a
 * 5K-invocation sibling.
 */
function basePopularity(invocationCount: number): number {
  if (invocationCount <= 0) return 0;
  return invocationCount / (invocationCount + 100);
}

/**
 * Mean DCC class achieved across recent invocations, normalized to [0, 1].
 * IndexedTool does not currently carry `meanDccClass` (denorm job is
 * scoped for Phase 2 follow-up). Until that lands, we approximate using
 * `assuranceCeiling` capped at the tier ceiling — same shape, slightly
 * higher noise.
 */
function meanDccClass(tool: IndexedTool): number {
  // assuranceCeiling is a DigitalCaptureClass enum DCC0..DCC5; map to [0, 1].
  const ceiling = tool.assuranceCeiling as unknown as string;
  const match = /DCC(\d)/.exec(String(ceiling));
  if (!match) return 0;
  const n = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(5, n)) / 5;
}

/**
 * Provenance — the network-effect signal. No competing aggregator can
 * match this because none of them see PCC's invocation receipts.
 */
export function provenanceSignal(tool: IndexedTool): number {
  const base = basePopularity(tool.invocationCount ?? 0);
  const success = Math.max(0, Math.min(1, tool.successRate ?? 0));
  const dcc = meanDccClass(tool);
  return base * success * dcc;
}

// ---------------------------------------------------------------------------
// Reputation — source-typed external scorecard
// ---------------------------------------------------------------------------

/**
 * Standard sigmoid for use-count signals (e.g. Smithery's `useCount`).
 * sigmoid(x/10000) so 10K uses ≈ 0.73, 50K uses ≈ 0.99.
 */
function useCountSigmoid(n: number): number {
  if (n <= 0) return 0;
  return 1 / (1 + Math.exp(-n / 10000));
}

/**
 * Source-typed reputation signal. Different upstreams expose different
 * scorecards — we read scoreSnapshot for known fields and fall back to
 * a neutral 0.5 for unknown sources.
 *
 * - glama       → scoreSnapshot.overall (0..1)
 * - smithery    → sigmoid(scoreSnapshot.useCount / 10K)
 * - pcc-native  → static 1.0 (PCC owns the source-of-truth)
 * - mcp-so / pulsemcp / mcp-directory → scoreSnapshot.stars / 1000 capped
 * - default     → 0.5 neutral
 *
 * ERC-8004 on-chain reputation lookups are deferred — they require an RPC
 * call per tool and PCC's reputation registry is not yet wired into the
 * aggregator pipeline. Phase 3 adds an LRU cache + lookup.
 */
export function reputationSignal(tool: IndexedTool): number {
  const snap = tool.source.scoreSnapshot;
  switch (tool.source.type) {
    case "glama": {
      const overall = snap?.overall;
      return typeof overall === "number" ? Math.max(0, Math.min(1, overall)) : 0.5;
    }
    case "smithery": {
      const useCount = snap?.useCount ?? snap?.usage ?? 0;
      return useCountSigmoid(useCount);
    }
    case "pcc-native":
      return 1.0;
    case "mcp-so":
    case "pulsemcp":
    case "mcp-directory": {
      const stars = snap?.stars ?? 0;
      return Math.max(0, Math.min(1, stars / 1000));
    }
    default:
      return 0.5;
  }
}

// ---------------------------------------------------------------------------
// Freshness — exp-decay × drift multiplier
// ---------------------------------------------------------------------------

/** Default decay rate: ~50% relevance at 14 days, ~10% at 46 days. */
const FRESHNESS_DECAY_RATE = 0.05;

/** Penalty multiplier when any high/critical driftAlert is present. */
const DRIFT_CRITICAL_PENALTY = 0.5;
/** Light penalty when schemaHashHistory shows a recent change. */
const SCHEMA_CHANGE_PENALTY = 0.85;
/** Threshold: schema changed in the last 24h is considered "recent". */
const SCHEMA_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Freshness signal — exp-decay over age + multiplicative drift penalty.
 *
 * Tiebreaker, not dominator: a stale-but-trusted PCC_NATIVE tool should
 * still beat a fresh UNTRUSTED submission. Default weight is 0.8.
 */
export function freshnessSignal(
  tool: IndexedTool,
  now: number = Date.now(),
): number {
  const lastFetched = Date.parse(tool.lastFetchedAt);
  if (!Number.isFinite(lastFetched)) return 0.5;
  const ageDays = Math.max(0, (now - lastFetched) / (24 * 60 * 60 * 1000));
  let signal = Math.exp(-FRESHNESS_DECAY_RATE * ageDays);

  // Drift penalty: any high/critical drift cuts freshness in half.
  const drifts = tool.driftAlerts ?? [];
  if (drifts.some((d) => d.severity === "high" || d.severity === "critical")) {
    signal *= DRIFT_CRITICAL_PENALTY;
  }

  // Schema-change penalty: applies when schemaHashHistory has >1 entry
  // AND the most recent entry was added within 24h (signal that callers
  // should know).
  const hist = tool.schemaHashHistory ?? [];
  if (hist.length > 1 && now - lastFetched < SCHEMA_CHANGE_WINDOW_MS) {
    signal *= SCHEMA_CHANGE_PENALTY;
  }

  return Math.max(0, Math.min(1, signal));
}

// ---------------------------------------------------------------------------
// Price affinity — caller priceHint vs tool.pricing
// ---------------------------------------------------------------------------

/**
 * Price affinity signal.
 *
 * Returns 0.5 (neutral) when either the tool has no pricing or the caller
 * supplies no hint. Otherwise:
 *   - free tools score 1.0 when preferFree, 0.7 otherwise
 *   - in-budget tools (ratio ≤ 1.0) score [0.7, 1.0]
 *   - 1-2× over budget scores [0.2, 0.5]
 *   - way over budget scores 0.1
 */
export function priceSignal(
  tool: IndexedTool,
  hint: PriceHint | undefined,
): number {
  if (!hint) return 0.5;
  const pricing = tool.pricing;
  if (!pricing) return 0.5;
  const actual = Number.parseFloat(pricing.perCallUsdc);
  if (!Number.isFinite(actual)) return 0.5;
  if (actual === 0) return hint.preferFree ? 1.0 : 0.7;
  const target = hint.maxUsd;
  if (target <= 0) return 0.1;
  const ratio = actual / target;
  if (ratio <= 1.0) return Math.max(0.7, 1.0 - 0.3 * ratio);
  if (ratio <= 2.0) return Math.max(0.2, 0.5 - 0.3 * (ratio - 1));
  return 0.1;
}

// ---------------------------------------------------------------------------
// Geo proximity — haversine on kernel location
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;
const GEO_DECAY_KM = 500;

/**
 * Great-circle distance in kilometers between two lat/lng points via
 * Haversine. Returns Infinity if either point is malformed.
 */
export function haversineKm(a: GeoLocation, b: GeoLocation): number {
  if (
    !Number.isFinite(a.lat) ||
    !Number.isFinite(a.lng) ||
    !Number.isFinite(b.lat) ||
    !Number.isFinite(b.lng)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * IndexedTool doesn't currently carry kernel location — the
 * `geoLocation` field is read from the source.scoreSnapshot fallback
 * (lat/lng) if present. Digital-only tools (no location data) return
 * 1.0 (neutral) so the caller's geo filter doesn't accidentally exclude
 * them.
 */
function extractToolLocation(tool: IndexedTool): GeoLocation | null {
  const snap = tool.source.scoreSnapshot;
  if (!snap) return null;
  const lat = snap.lat;
  const lng = snap.lng;
  if (typeof lat === "number" && typeof lng === "number") {
    return { lat, lng };
  }
  return null;
}

/**
 * Geo proximity signal.
 *
 * Digital-only tools (no kernel location) return 1.0 (neutral).
 * For physical tools: exp(-distance_km / 500). 1.0 at 0km, 0.37 at
 * 500km, 0.14 at 1000km.
 */
export function geoSignal(
  tool: IndexedTool,
  callerLocation: GeoLocation | undefined,
): number {
  if (!callerLocation) return 1.0;
  const toolLoc = extractToolLocation(tool);
  if (!toolLoc) return 1.0;
  const km = haversineKm(toolLoc, callerLocation);
  if (!Number.isFinite(km)) return 0;
  return Math.exp(-km / GEO_DECAY_KM);
}
