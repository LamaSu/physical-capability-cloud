/**
 * Phase 1 — high-recall candidate retrieval.
 *
 * Two parallel rankers feed RRF:
 *   - BM25 over searchableText (lexical)
 *   - Vector cosine over the description embedding (semantic)
 *
 * RRF (k=60, Cormack 2009 / Vespa default) fuses the two rank lists
 * disjunctively into a single top-N. Default N=100 per Vespa
 * `rerank-count` standard.
 *
 * Hard filters are applied BEFORE this stage by the HybridRanker;
 * this module receives a pre-filtered tool set.
 *
 * Latency budget: <50ms at N_candidates=10K.
 */

import type { IndexedTool } from "@pcc/spec";
import { bm25Score, tokenize } from "./bm25.js";
import type { InvertedIndex } from "./inverted-index.js";
import { reciprocalRankFusion } from "./rrf.js";
import type { CandidateHit } from "./types.js";

/** Default candidate pool size — Vespa's `rerank-count: 100` standard. */
export const PHASE1_DEFAULT_TOP_N = 100;

/** Cosine similarity between two equal-length numeric vectors. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Tool record carrying an optional embedding. The aggregator IndexedTool
 * does NOT carry an embedding (the spec schema is upstream-of-ranker), so
 * the HybridRanker stores embeddings in a side-map keyed by toolId. This
 * shape lets phase-1 consume the joined view.
 */
export interface RankableTool {
  tool: IndexedTool;
  embedding?: number[];
}

/**
 * Phase 1 input. Caller supplies the pre-filtered tool set plus the
 * query (text or embedding or both).
 */
export interface Phase1Input {
  /** Pre-filtered tools — hard gates already applied. */
  candidates: RankableTool[];
  /** Tokenized query string for BM25. Empty array = skip BM25 ranker. */
  queryTerms: string[];
  /** Query embedding for vector cosine. Undefined = skip vector ranker. */
  queryEmbedding?: number[];
  /** Inverted index (must match the candidates set or be a superset). */
  invertedIndex: InvertedIndex;
  /** Top-N to return. Default 100. */
  topN?: number;
}

/**
 * Run phase 1. Returns up to top-N CandidateHits with RRF-fused scores.
 *
 * Empty queries (no text + no embedding) return the candidates in input
 * order with phase1Score=0 — the phase-2 scorer can still apply trust /
 * provenance / etc. signals.
 */
export function runPhase1(input: Phase1Input): CandidateHit[] {
  const topN = input.topN ?? PHASE1_DEFAULT_TOP_N;
  const candidates = input.candidates;
  if (candidates.length === 0) return [];

  // Build O(1) lookup from id → candidate.
  const byId = new Map<string, RankableTool>();
  for (const c of candidates) byId.set(c.tool.id, c);

  // ── BM25 ranker ────────────────────────────────────────────────────────
  let bm25Ranked: string[] = [];
  if (input.queryTerms.length > 0) {
    const corpus = input.invertedIndex.corpusStats();
    // Candidate set may be smaller than the inverted index (post-filter).
    // We score only the intersection of (matches for query terms) ∩ (candidates).
    const matches = input.invertedIndex.candidatesFor(input.queryTerms);
    const scored: Array<{ id: string; score: number }> = [];
    for (const id of matches) {
      if (!byId.has(id)) continue; // dropped by hard filter
      const docStats = input.invertedIndex.docStatsOf(id);
      if (!docStats) continue;
      const s = bm25Score(input.queryTerms, docStats, corpus);
      if (s > 0) scored.push({ id, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    bm25Ranked = scored.map((s) => s.id);
  }

  // ── Vector ranker ──────────────────────────────────────────────────────
  let vectorRanked: string[] = [];
  if (input.queryEmbedding && input.queryEmbedding.length > 0) {
    const scored: Array<{ id: string; score: number }> = [];
    for (const c of candidates) {
      if (!c.embedding || c.embedding.length !== input.queryEmbedding.length) {
        continue;
      }
      const s = cosine(input.queryEmbedding, c.embedding);
      // Negative cosines (pathological with hash-fallback) → treat as 0.
      if (s > 0) scored.push({ id: c.tool.id, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    vectorRanked = scored.map((s) => s.id);
  }

  // ── Fuse via RRF ───────────────────────────────────────────────────────
  const rankers: string[][] = [];
  if (bm25Ranked.length > 0) rankers.push(bm25Ranked);
  if (vectorRanked.length > 0) rankers.push(vectorRanked);

  // If both rankers were empty, return everything in input order at score 0.
  if (rankers.length === 0) {
    return candidates.slice(0, topN).map((c) => ({
      tool: c.tool,
      phase1Score: 0,
    }));
  }

  const fused = reciprocalRankFusion(rankers);
  // Normalize phase1Score to [0, 1] by dividing by the max fused score.
  const maxScore = fused.length > 0 ? fused[0]!.score : 1;
  const out: CandidateHit[] = [];
  for (const f of fused) {
    const cand = byId.get(f.id);
    if (!cand) continue;
    const bm25Rank = f.ranks[0] !== undefined && bm25Ranked.length > 0 ? f.ranks[0] : undefined;
    const vectorRank =
      rankers.length === 2
        ? f.ranks[1]
        : bm25Ranked.length === 0
          ? f.ranks[0]
          : undefined;
    out.push({
      tool: cand.tool,
      phase1Score: maxScore > 0 ? f.score / maxScore : 0,
      bm25Rank,
      vectorRank,
    });
    if (out.length >= topN) break;
  }
  return out;
}

/** Re-export tokenize for convenience. */
export { tokenize };
