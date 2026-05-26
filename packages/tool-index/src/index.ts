/**
 * @pcc/tool-index — public surface
 *
 * Phase 1 of the BigTool-style retrieval substrate for PCC's 218-tool
 * agent-package.json catalog. Phase 3 will add loaders for external MCP
 * servers, OpenAPI specs, and skills — the IndexedTool shape is designed
 * to be source-agnostic for that future work.
 */

export type {
  IndexedTool,
  ToolEndpoint,
  ToolSearchHit,
  ToolSource,
} from "./types.js";

export type { EmbeddingProvider } from "./embeddings.js";
export {
  HashFallbackProvider,
  OpenAIEmbeddingProvider,
  maskSecrets,
  selectEmbeddingProvider,
} from "./embeddings.js";

export { ToolIndex } from "./index-store.js";
export type { SearchOptions } from "./index-store.js";

export {
  loadAgentPackage,
  indexAgentPackage,
  mapAgentPackageTool,
} from "./loaders/agent-package.js";

// ── Vespa-style hybrid 2-phase ranker (Phase 2 of tool-index) ────────────
export {
  HybridRanker,
  PRESET_AGENT_DEFAULT,
  PRESET_COMPLIANCE_STRICT,
  PRESET_DISCOVERY_EXPLORE,
  presetNames,
  TIER_VALUE,
  trustSignal,
  provenanceSignal,
  reputationSignal,
  freshnessSignal,
  priceSignal,
  geoSignal,
  haversineKm,
  evaluateHardGates,
  applyHardFilters,
  reciprocalRankFusion,
  RRF_K_DEFAULT,
  bm25Score,
  BM25_K1_DEFAULT,
  BM25_B_DEFAULT,
  InvertedIndex,
  searchableTextOf,
} from "./ranker/index.js";
export type {
  RankerBackend,
  RankerQuery,
  RankerProfile,
  RankWeights,
  RankedHit,
  CandidateHit,
  HardFilter,
  SignalContributions,
  PriceHint,
  GeoLocation,
  ShadowTelemetryEvent,
} from "./ranker/types.js";

// ── Shadow-mode telemetry (PCC_RANKER_MODE=shadow) ───────────────────────
export {
  appendShadowEvent,
  buildShadowEvent,
  resolveShadowLogPath,
} from "./ranker/shadow-telemetry.js";

// ── Lightweight → spec adapter (for PCC's own 218-tool catalog) ──────────
export {
  liftLightweightTool,
  liftLightweightTools,
} from "./ranker/lift-to-spec.js";
