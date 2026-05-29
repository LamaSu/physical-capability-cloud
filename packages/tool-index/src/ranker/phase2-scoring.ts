/**
 * Phase 2 — heavy rerank on the top-N phase-1 candidates.
 *
 * Per ai/scoping/vespa-hybrid-ranking-2026-05-23.md §3:
 *
 *   phase2_score(d) =
 *     w_relevance   × phase1_score_normalized(d)
 *   + w_trust       × trust_gate(d)
 *   + w_provenance  × provenance_signal(d)
 *   + w_reputation  × reputation_signal(d)
 *   + w_freshness   × freshness_signal(d)
 *   + w_price       × price_affinity(d, query.priceHint)
 *   + w_geo         × geo_proximity(d, query.location)
 *
 *   final_score(d) = phase2_score(d) × hard_gate_aggregate(d)
 *
 * Hard-gate aggregate is 0 if any gate fails, 1 otherwise. Failing tools
 * are filtered out by the HybridRanker before this phase runs; we re-check
 * here as defense-in-depth and so the `passedGates` list is populated for
 * explain output.
 *
 * Cost: O(N) with N=100. <5ms total per query.
 */

import {
  evaluateHardGates,
} from "./filters.js";
import {
  freshnessSignal,
  geoSignal,
  priceSignal,
  provenanceSignal,
  reputationSignal,
  trustSignal,
} from "./signals.js";
import type {
  CandidateHit,
  HardFilter,
  RankWeights,
  RankedHit,
  RankerQuery,
  SignalContributions,
} from "./types.js";

/** Input to phase 2 — candidates + weights + query context. */
export interface Phase2Input {
  candidates: CandidateHit[];
  weights: RankWeights;
  filter?: HardFilter;
  priceHint?: RankerQuery["priceHint"];
  location?: RankerQuery["location"];
  topK: number;
  explain?: boolean;
  /** Override Date.now() for deterministic tests. */
  now?: number;
}

/**
 * Compute final phase-2 scores and return the top-K, ranked descending.
 */
export function runPhase2(input: Phase2Input): RankedHit[] {
  const out: RankedHit[] = [];

  for (const cand of input.candidates) {
    // Re-evaluate hard gates (defense-in-depth + populate passedGates).
    const gate = evaluateHardGates(cand.tool, input.filter);
    if (!gate.passed) continue;

    // Raw signal values in [0, 1].
    const sig = {
      relevance: cand.phase1Score,
      trust: trustSignal(cand.tool),
      provenance: provenanceSignal(cand.tool),
      reputation: reputationSignal(cand.tool),
      freshness: freshnessSignal(cand.tool, input.now),
      price: priceSignal(cand.tool, input.priceHint),
      geo: geoSignal(cand.tool, input.location),
    };

    // Weighted sum.
    const w = input.weights;
    const contributions: SignalContributions = {
      relevance: w.relevance * sig.relevance,
      trust: w.trust * sig.trust,
      provenance: w.provenance * sig.provenance,
      reputation: w.reputation * sig.reputation,
      freshness: w.freshness * sig.freshness,
      price: w.price * sig.price,
      geo: w.geo * sig.geo,
    };
    const sum =
      contributions.relevance +
      contributions.trust +
      contributions.provenance +
      contributions.reputation +
      contributions.freshness +
      contributions.price +
      contributions.geo;

    const hit: RankedHit = {
      tool: cand.tool,
      score: sum, // already gated above; multiplier is 1.
      rank: 0, // assigned after sort
    };
    if (input.explain) {
      hit.phase1Score = cand.phase1Score;
      hit.signals = contributions;
      hit.passedGates = gate.passedGates;
    }
    out.push(hit);
  }

  // Sort by final score desc, then rank, then truncate.
  out.sort((a, b) => b.score - a.score);
  for (let i = 0; i < out.length; i++) out[i]!.rank = i + 1;
  return out.slice(0, input.topK);
}
