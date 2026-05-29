/**
 * @pcc/tool-index — Vespa-style hybrid ranker types.
 *
 * The HybridRanker engine operates on the canonical @pcc/spec IndexedTool
 * (the rich aggregator record with trustTier / vetReport / invocationCount /
 * etc.). The @pcc/tool-index Phase 1 lightweight IndexedTool is adapted to
 * the spec shape via `lightweightToRankable()` so the engine has ONE input
 * type regardless of source.
 *
 * Engine API (RankerBackend) is the swap-point for Phase 3 Qdrant /
 * HNSW backends. Phase 2 ships InMemoryHybridRanker only.
 *
 * See: ai/scoping/vespa-hybrid-ranking-2026-05-23.md §3, §4, §6.
 */

import type { IndexedTool, IndexedToolActionClass, TrustTier } from "@pcc/spec";
import type { DigitalCaptureClass } from "@pcc/spec";

// ---------------------------------------------------------------------------
// Profile presets
// ---------------------------------------------------------------------------

/**
 * Built-in weight presets. `agent-default` is the recommended starting
 * profile (trust + receipts dominate, relevance is the tiebreaker).
 *
 * - `compliance-strict`: regulated callers — trust + freshness weighted
 *   higher, external reputation de-emphasized.
 * - `discovery-explore`: casual browse — relevance dominates, trust /
 *   provenance are thumbs on the scale only.
 *
 * Custom weights can override any preset via `RankerQuery.weights`.
 */
export type RankerProfile =
  | "agent-default"
  | "compliance-strict"
  | "discovery-explore";

// ---------------------------------------------------------------------------
// Weights — one multiplier per phase-2 signal
// ---------------------------------------------------------------------------

/**
 * Phase-2 signal weights. Dimensionless multipliers applied to each
 * signal's [0, 1] output before summing. Hard gates (trust floor, CVE,
 * drift, action class) zero the final score multiplicatively AFTER the
 * weighted sum.
 *
 * Defaults per `agent-default` preset:
 *   relevance 1.0  trust 2.0  provenance 2.5  reputation 1.0
 *   freshness 0.8  price 0.5  geo 1.5
 */
export interface RankWeights {
  /** Phase-1 fused (BM25 + cosine via RRF) score, normalized. */
  relevance: number;
  /** TIER_VALUE[trustTier] in [0, 1]. */
  trust: number;
  /** PCC-distinct: invocationCount × successRate × meanDccClass. */
  provenance: number;
  /** Source-typed external scorecard (Glama / Smithery / ERC-8004). */
  reputation: number;
  /** exp-decay over lastFetchedAt + drift multiplier. */
  freshness: number;
  /** PricingHint vs query.priceHint. */
  price: number;
  /** Haversine on kernelLocation for physical tools. */
  geo: number;
}

// ---------------------------------------------------------------------------
// Hard filters — applied BEFORE phase 1 (cheap candidate elimination)
// ---------------------------------------------------------------------------

/**
 * Hard filters narrow the candidate pool before any retrieval work.
 * They are strict gates — failing tools are excluded entirely (no
 * score contribution). All fields are AND-combined.
 */
export interface HardFilter {
  /** Tools must have trust tier ≥ this rank. Default: UNTRUSTED (excludes QUARANTINED only). */
  minTrustTier?: TrustTier;
  /** Caller wants this DCC class at minimum — tools must attest at least this high. */
  requestedDccClass?: DigitalCaptureClass;
  /** Caller's agent allowlist; tools with actionClass outside this set are excluded. */
  actionClassAllowlist?: IndexedToolActionClass[];
  /** Exact-match on skills[] (any-of). */
  skill?: string;
  /** Exact-match on domains[] (any-of). */
  domain?: string;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** Pricing hint the caller supplies; off when null. */
export interface PriceHint {
  /** Caller's max-acceptable USDC per-call. */
  maxUsd: number;
  /** When true, free tools score higher than equivalently-priced tools. */
  preferFree?: boolean;
}

/** Geographic location for proximity scoring. */
export interface GeoLocation {
  lat: number;
  lng: number;
}

/** Complete ranker request. All fields optional except at least one of q/embedding. */
export interface RankerQuery {
  /** Free-text query. Embedded via the configured provider if `embedding` not supplied. */
  q?: string;
  /** Pre-computed query embedding (skip embedding step). Must match provider dim. */
  embedding?: number[];
  /** Hard filters applied before phase 1. */
  filter?: HardFilter;
  /** Weight preset name. Default: `agent-default`. */
  profile?: RankerProfile;
  /** Final number of results returned. Default 10, max 100. */
  topK?: number;
  /** Phase-1 candidate pool size (top-N before phase-2 rerank). Default 100 per Vespa standard. */
  topN?: number;
  /** Partial weight overrides applied on top of the chosen profile. */
  weights?: Partial<RankWeights>;
  /** When set, price_affinity signal becomes active. */
  priceHint?: PriceHint;
  /** When set, geo_proximity signal becomes active. */
  location?: GeoLocation;
  /** When true, RankedHit includes per-signal contribution breakdown. */
  explain?: boolean;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Per-signal contribution breakdown — populated when `explain=true`. */
export interface SignalContributions {
  relevance: number;
  trust: number;
  provenance: number;
  reputation: number;
  freshness: number;
  price: number;
  geo: number;
}

/** One ranked hit returned to the caller. */
export interface RankedHit {
  /** The full IndexedTool. */
  tool: IndexedTool;
  /** Final phase-2 score after hard-gate multiplication. */
  score: number;
  /** 1-indexed rank within this result set. */
  rank: number;
  /** Phase-1 fused score (RRF). Present only when `explain=true`. */
  phase1Score?: number;
  /** Per-signal raw values × weights. Present only when `explain=true`. */
  signals?: SignalContributions;
  /** Names of hard gates that PASSED (for explainability). Empty if `explain=false`. */
  passedGates?: string[];
}

// ---------------------------------------------------------------------------
// Backend interface — swap point for Phase 3 (Qdrant / HNSW / etc.)
// ---------------------------------------------------------------------------

/** Phase-1 retrieval result (before phase-2 rerank). */
export interface CandidateHit {
  tool: IndexedTool;
  /** RRF-fused phase-1 score in [0, 1]. */
  phase1Score: number;
  /** 1-indexed rank from BM25 (undefined if not matched lexically). */
  bm25Rank?: number;
  /** 1-indexed rank from vector cosine (undefined if no embedding). */
  vectorRank?: number;
}

/**
 * Pluggable backend for the HybridRanker. Phase 2 ships InMemoryHybridRanker.
 * Phase 3 swaps to QdrantBackend without changing this interface.
 */
export interface RankerBackend {
  /**
   * Phase 1: high-recall retrieval. Applies hard filters, then returns
   * top-N candidates fused via RRF over BM25 + vector rankings.
   */
  retrieve(query: RankerQuery): Promise<CandidateHit[]>;

  /** Phase 2 entry point: rank candidates, returning top-K final hits. */
  rank(query: RankerQuery): Promise<RankedHit[]>;

  /** Add or replace a tool in the index. */
  upsert(tool: IndexedTool): Promise<void>;

  /** Remove a tool by id. Returns true if it was present. */
  remove(id: string): Promise<boolean>;

  /** Replace the entire index. */
  reset(tools: IndexedTool[]): Promise<void>;

  /** Number of tools currently indexed. */
  size(): number;
}

// ---------------------------------------------------------------------------
// Shadow-mode telemetry payload
// ---------------------------------------------------------------------------

/**
 * Shape of one shadow-mode JSONL event. Written to
 * `~/.claude/audit/ranker-shadow.jsonl` (or PCC_RANKER_SHADOW_LOG override)
 * for A/B comparison of legacy vs hybrid output.
 */
export interface ShadowTelemetryEvent {
  ts: string;
  /** Free-text query (may be empty for pure-filter queries). */
  query: string;
  /** Top-5 ids from the legacy ranker. */
  legacyTop5: Array<{ id: string; score: number }>;
  /** Top-5 ids from the hybrid ranker. */
  hybridTop5: Array<{ id: string; score: number }>;
  /** Count of common ids in the two top-5 sets. */
  overlap: number;
  /** Per-id rank-shift legacy→hybrid. */
  rankDelta: Array<{ id: string; legacyRank: number | null; hybridRank: number | null }>;
}
