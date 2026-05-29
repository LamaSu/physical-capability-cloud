/**
 * @pcc/tool-index/ranker — Vespa-style hybrid 2-phase ranker.
 *
 * Phase 2 ships InMemoryHybridRanker (pure-TS, zero ops surface).
 * Phase 3 will swap to QdrantBackend without changing the
 * RankerBackend interface.
 *
 * Use:
 *   const ranker = new HybridRanker(provider);
 *   await ranker.reset(tools);
 *   const hits = await ranker.rank({ q: "summarize document", topK: 10 });
 *
 * Custom weights via per-query override:
 *   await ranker.rank({
 *     q: "...",
 *     profile: "compliance-strict",
 *     weights: { provenance: 4.0 },     // tweak on top of profile
 *     filter: { requestedDccClass: DigitalCaptureClass.DCC3 },
 *     priceHint: { maxUsd: 0.01 },
 *     location: { lat: 37.77, lng: -122.42 },
 *     explain: true,
 *   });
 *
 * See ai/scoping/vespa-hybrid-ranking-2026-05-23.md for the design.
 */

import type { IndexedTool } from "@pcc/spec";
import type { EmbeddingProvider } from "../embeddings.js";
import { applyHardFilters } from "./filters.js";
import { InvertedIndex, searchableTextOf } from "./inverted-index.js";
import {
  PHASE1_DEFAULT_TOP_N,
  runPhase1,
  tokenize,
  type RankableTool,
} from "./phase1-candidates.js";
import { runPhase2 } from "./phase2-scoring.js";
import { resolveWeights } from "./presets.js";
import type {
  CandidateHit,
  RankedHit,
  RankerBackend,
  RankerQuery,
} from "./types.js";

export * from "./types.js";
export { PRESET_AGENT_DEFAULT, PRESET_COMPLIANCE_STRICT, PRESET_DISCOVERY_EXPLORE, presetNames } from "./presets.js";
export { TIER_VALUE, trustSignal, provenanceSignal, reputationSignal, freshnessSignal, priceSignal, geoSignal, haversineKm } from "./signals.js";
export { evaluateHardGates, applyHardFilters } from "./filters.js";
export { reciprocalRankFusion, RRF_K_DEFAULT } from "./rrf.js";
export { bm25Score, tokenize, BM25_K1_DEFAULT, BM25_B_DEFAULT } from "./bm25.js";
export { InvertedIndex, searchableTextOf } from "./inverted-index.js";

/** Final hit cap — bounded so an out-of-range topK doesn't explode the response. */
const MAX_TOP_K = 100;

/**
 * In-memory implementation of RankerBackend. Holds:
 *   - Map<id, IndexedTool>  — the canonical tool store
 *   - Map<id, embedding>    — side-table of embeddings (lazy)
 *   - InvertedIndex         — BM25 candidates + corpus stats
 *
 * Lifecycle:
 *   1. construct with an EmbeddingProvider
 *   2. reset(tools) to seed
 *   3. rank(query) returns top-K
 *
 * Re-adding a tool with the same id replaces its entry AND drops its
 * embedding (so the next rank() re-embeds with the current provider).
 */
export class HybridRanker implements RankerBackend {
  private readonly tools = new Map<string, IndexedTool>();
  private readonly embeddings = new Map<string, number[]>();
  private readonly inverted = new InvertedIndex();

  constructor(private readonly provider: EmbeddingProvider) {}

  size(): number {
    return this.tools.size;
  }

  /** Active embedding provider name (for status / observability). */
  get providerName(): string {
    return this.provider.name;
  }

  /** Active embedding dim. */
  get dim(): number {
    return this.provider.dim;
  }

  async upsert(tool: IndexedTool): Promise<void> {
    this.tools.set(tool.id, tool);
    this.embeddings.delete(tool.id);
    this.inverted.upsert(tool.id, searchableTextOf(tool));
  }

  async remove(id: string): Promise<boolean> {
    const had = this.tools.delete(id);
    this.embeddings.delete(id);
    this.inverted.remove(id);
    return had;
  }

  async reset(tools: IndexedTool[]): Promise<void> {
    this.tools.clear();
    this.embeddings.clear();
    this.inverted.reset();
    for (const t of tools) {
      this.tools.set(t.id, t);
      this.inverted.upsert(t.id, searchableTextOf(t));
    }
  }

  /** Inspect one tool by id. */
  get(id: string): IndexedTool | undefined {
    return this.tools.get(id);
  }

  /** Iterate over all tools (insertion order). */
  *all(): IterableIterator<IndexedTool> {
    yield* this.tools.values();
  }

  /**
   * Phase 1: high-recall retrieval. Applies hard filters, runs BM25 +
   * vector cosine, fuses via RRF, returns top-N candidates.
   */
  async retrieve(query: RankerQuery): Promise<CandidateHit[]> {
    const topN = Math.max(1, Math.min(MAX_TOP_K * 5, query.topN ?? PHASE1_DEFAULT_TOP_N));

    // Hard filter the full tool set first.
    const filtered = applyHardFilters(Array.from(this.tools.values()), query.filter ?? {});
    if (filtered.length === 0) return [];

    // Tokenize the query.
    const queryTerms = query.q ? tokenize(query.q) : [];

    // Compute query embedding only if vector ranker needed.
    let queryEmbedding = query.embedding;
    if (!queryEmbedding && query.q && query.q.trim().length > 0) {
      await this.ensureEmbeddings(filtered);
      const [vec] = await this.provider.embed([query.q]);
      queryEmbedding = vec;
    } else if (queryEmbedding && queryEmbedding.length === this.provider.dim) {
      // Caller supplied an embedding — ensure candidates have theirs.
      await this.ensureEmbeddings(filtered);
    }

    // Build candidate set for phase 1, attaching embeddings where present.
    const rankable: RankableTool[] = filtered.map((t) => ({
      tool: t,
      embedding: this.embeddings.get(t.id),
    }));

    return runPhase1({
      candidates: rankable,
      queryTerms,
      queryEmbedding,
      invertedIndex: this.inverted,
      topN,
    });
  }

  /** Phase 2 entry point — runs phase 1 then re-scores top-N down to top-K. */
  async rank(query: RankerQuery): Promise<RankedHit[]> {
    const topK = Math.max(1, Math.min(MAX_TOP_K, query.topK ?? 10));
    const weights = resolveWeights(query.profile, query.weights);

    const candidates = await this.retrieve(query);
    if (candidates.length === 0) return [];

    return runPhase2({
      candidates,
      weights,
      filter: query.filter,
      priceHint: query.priceHint,
      location: query.location,
      topK,
      explain: query.explain,
    });
  }

  // ─ private ─────────────────────────────────────────────────────────────

  /**
   * Lazily embed any tools that don't have a cached embedding yet. Batched
   * into one provider call.
   */
  private async ensureEmbeddings(tools: IndexedTool[]): Promise<void> {
    const need: IndexedTool[] = [];
    for (const t of tools) {
      const cached = this.embeddings.get(t.id);
      if (cached && cached.length === this.provider.dim) continue;
      need.push(t);
    }
    if (need.length === 0) return;
    const texts = need.map((t) => searchableTextOf(t));
    const vectors = await this.provider.embed(texts);
    for (let i = 0; i < need.length; i++) {
      const v = vectors[i];
      if (Array.isArray(v) && v.length === this.provider.dim) {
        this.embeddings.set(need[i]!.id, v);
      }
    }
  }
}
