/**
 * Reciprocal Rank Fusion — combine multiple ranked lists into one.
 *
 * Per Cormack et al. SIGIR 2009:
 *
 *   RRF_score(d) = Σ over rankers r:  1 / (k + rank_r(d))
 *
 * where:
 *   - rank_r(d) is the 1-indexed rank of doc d in ranker r's output
 *   - k is a smoothing constant
 *
 * k=60 is the empirical sweet-spot from the original paper and is the
 * default in Vespa, Microsoft Azure AI Search, Elastic, OpenSearch,
 * MongoDB Atlas, Weaviate, and MariaDB. **Qdrant defaults to k=2 — if
 * we swap to QdrantBackend in Phase 3, we MUST override to k=60.**
 *
 * Strengths:
 *   - Parameter-free (no per-ranker score normalization required)
 *   - Rank-only — robust to wildly different score distributions
 *   - Proven to outperform CombSUM/CombMNZ for hybrid lexical+semantic
 */

/** Standard k constant — Cormack 2009 / Vespa / Elastic / Azure / etc. */
export const RRF_K_DEFAULT = 60;

/** Read RRF k from env or fall back to canonical 60. */
export function rrfK(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PCC_RANK_RRF_K;
  if (!raw) return RRF_K_DEFAULT;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : RRF_K_DEFAULT;
}

/** One ranker's output — ordered list of ids, best first. */
export type RankedList = string[];

/**
 * Fuse N ranked lists into one combined ranking via RRF.
 *
 * Returns ids sorted by RRF score descending, plus the score itself for
 * downstream explainability. Items that appear in no list are excluded.
 *
 * @param lists - 2+ ranked lists (e.g. [bm25Ranks, vectorRanks])
 * @param options.k - Smoothing constant (default 60). Lower k weights top
 *                    positions more heavily; higher k flattens contributions.
 */
export function reciprocalRankFusion(
  lists: RankedList[],
  options: { k?: number } = {},
): Array<{ id: string; score: number; ranks: Array<number | undefined> }> {
  const k = options.k ?? rrfK();
  // Build per-id rank map per ranker, plus accumulate the fused score.
  const scores = new Map<string, number>();
  const ranksPerId = new Map<string, Array<number | undefined>>();
  for (let listIdx = 0; listIdx < lists.length; listIdx++) {
    const list = lists[listIdx]!;
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!;
      const rank = i + 1; // 1-indexed
      const contribution = 1 / (k + rank);
      scores.set(id, (scores.get(id) ?? 0) + contribution);
      let ranks = ranksPerId.get(id);
      if (!ranks) {
        ranks = new Array<number | undefined>(lists.length).fill(undefined);
        ranksPerId.set(id, ranks);
      }
      ranks[listIdx] = rank;
    }
  }
  const result = Array.from(scores.entries()).map(([id, score]) => ({
    id,
    score,
    ranks: ranksPerId.get(id)!,
  }));
  result.sort((a, b) => b.score - a.score);
  return result;
}
