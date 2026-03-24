/**
 * CapabilityRoutingSubnet — Bittensor subnet for competitive capability routing.
 *
 * Miners compete to produce the best ranking of available operators for a
 * given job request. This is a RANKING problem — Bittensor's Yuma Consensus
 * agrees on rankings using Kendall tau distance between miner rankings and
 * the stake-weighted consensus ranking.
 *
 * In production this would send CapabilityRoutingSynapse objects via
 * dendrite.query() to real subnet miners. Here we simulate the full
 * subnet lifecycle in-process.
 */

import type { MinerInfo, SubnetMetrics } from "./types.js";
import { type MinerQuality } from "./mock-miner.js";

// ── Synapse ──────────────────────────────────────────────────────────

export interface CapabilityRoutingJobRequest {
  capabilityType: string;   // e.g. "fdm_printing", "cnc_milling", "hplc_analysis"
  requiredTier: number;     // 0-3
  parameters: Record<string, unknown>;
  maxPrice?: string;
  deadline?: string;        // ISO 8601
}

export interface CapabilityRoutingOperator {
  kernelId: string;
  capabilityUrl: string;    // CSD URL
  reputation: number;       // 0-1 from ERC-8004 registry
  price: string;            // numeric string, e.g. "12.50"
  estimatedDuration: number; // seconds
  location?: string;
}

export interface CapabilityRoutingRankEntry {
  kernelId: string;
  score: number;            // 0-1 composite
  reasons: string[];        // e.g. ["best_price", "highest_reputation", "meets_deadline"]
}

export interface CapabilityRoutingSynapse {
  jobRequest: CapabilityRoutingJobRequest;
  operators: CapabilityRoutingOperator[];
  // --- Response (filled by miners) ---
  ranking?: CapabilityRoutingRankEntry[];
  processingTimeMs?: number;
}

// ── Result ───────────────────────────────────────────────────────────

export interface CapabilityRoutingResult {
  /** Final consensus ranking of operators, best first */
  ranking: CapabilityRoutingRankEntry[];
  /** Overall consensus score for this routing round (0-1) */
  consensusScore: number;
  /** Number of miners that participated */
  minerCount: number;
  /** Kendall tau correlation across miner rankings (1 = perfect agreement) */
  rankingAgreement: number;
  /** Time taken for the full round (ms) */
  totalTimeMs: number;
}

// ── Routing Miner ────────────────────────────────────────────────────

const QUALITY_ACCURACY: Record<MinerQuality, number> = {
  excellent: 0.95,
  good: 0.80,
  mediocre: 0.55,
  poor: 0.30,
};

class RoutingMiner {
  readonly uid: number;
  readonly hotkey: string;
  readonly quality: MinerQuality;
  readonly stake: number;
  private trust: number;
  private incentive: number = 0;

  constructor(uid: number, quality: MinerQuality = "good", stake: number = 1000) {
    this.uid = uid;
    this.hotkey = `5R${uid.toString(16).padStart(46, "0")}`;
    this.quality = quality;
    this.stake = stake;
    this.trust = QUALITY_ACCURACY[quality];
  }

  /**
   * Forward pass: rank operators for a job request.
   *
   * Weights: reputation 40%, price competitiveness 30%, deadline fitness 30%.
   * Quality affects how precisely the miner applies the weights — poor miners
   * add noise and may produce sub-optimal orderings.
   */
  async forward(synapse: CapabilityRoutingSynapse): Promise<CapabilityRoutingSynapse> {
    const start = Date.now();
    const result = { ...synapse };

    const { operators, jobRequest } = synapse;
    if (operators.length === 0) {
      result.ranking = [];
      result.processingTimeMs = 1;
      return result;
    }

    const accuracy = QUALITY_ACCURACY[this.quality];
    const noise = (1 - accuracy) * 0.4; // max noise magnitude

    // Normalise prices (lower is better → higher score)
    const prices = operators.map((op) => parseFloat(op.price) || 0);
    const maxPrice = Math.max(...prices, 1);
    const minPrice = Math.min(...prices, maxPrice);
    const priceRange = maxPrice - minPrice || 1;

    // Normalise durations (shorter is better → higher score)
    const durations = operators.map((op) => op.estimatedDuration);
    const maxDur = Math.max(...durations, 1);

    // Deadline fitness: 1 if meets deadline, 0 otherwise
    const deadlineTs = jobRequest.deadline ? new Date(jobRequest.deadline).getTime() : null;
    const now = Date.now();

    const scored = operators.map((op) => {
      const repScore = op.reputation; // already 0-1
      const priceScore = 1 - (parseFloat(op.price) - minPrice) / priceRange;
      const durationScore = 1 - op.estimatedDuration / maxDur;

      let deadlineScore: number;
      if (deadlineTs !== null) {
        const remainingMs = deadlineTs - now;
        const meetsDl = remainingMs > op.estimatedDuration * 1000;
        deadlineScore = meetsDl ? 1 : 0;
      } else {
        deadlineScore = durationScore; // no deadline — use duration proxy
      }

      const baseScore =
        0.4 * repScore +
        0.3 * priceScore +
        0.3 * deadlineScore;

      // Add quality-proportional noise
      const jitter = (Math.random() - 0.5) * noise;
      const finalScore = Math.max(0, Math.min(1, baseScore + jitter));

      const reasons: string[] = [];
      if (repScore >= 0.8) reasons.push("highest_reputation");
      if (priceScore >= 0.8) reasons.push("best_price");
      if (deadlineTs !== null && deadlineScore === 1) reasons.push("meets_deadline");
      if (durationScore >= 0.8) reasons.push("fastest_estimated");

      return { kernelId: op.kernelId, score: Math.round(finalScore * 1000) / 1000, reasons };
    });

    // Sort descending
    scored.sort((a, b) => b.score - a.score);

    result.ranking = scored;
    result.processingTimeMs = Math.round(20 + Math.random() * 80);
    return result;
  }

  getInfo(): MinerInfo {
    return {
      uid: this.uid,
      hotkey: this.hotkey,
      stake: this.stake,
      trust: this.trust,
      incentive: this.incentive,
      lastUpdate: Date.now(),
    };
  }

  updateScores(trust: number, incentive: number): void {
    this.trust = Math.max(0, Math.min(1, trust));
    this.incentive = Math.max(0, Math.min(1, incentive));
  }
}

// ── Subnet ───────────────────────────────────────────────────────────

export class CapabilityRoutingSubnet {
  private miners: RoutingMiner[] = [];
  private metrics: SubnetMetrics = {
    totalVerifications: 0,
    averageScore: 0,
    activeMinerCount: 0,
    lastEpochRewards: 0,
  };
  private weights: Map<number, number> = new Map();

  constructor(minerCount: number = 8) {
    this.initMiners(minerCount);
  }

  private initMiners(count: number): void {
    const qualities: MinerQuality[] = [
      "excellent", "good", "good", "good", "mediocre", "mediocre", "poor", "poor",
    ];
    for (let i = 0; i < count; i++) {
      const quality = qualities[i % qualities.length];
      const stake = 500 + Math.random() * 2000;
      const miner = new RoutingMiner(i, quality, Math.round(stake));
      this.miners.push(miner);
      this.weights.set(i, 1.0 / count);
    }
    this.metrics.activeMinerCount = count;
  }

  /**
   * Route a job to the best operator via competitive miner ranking.
   */
  async routeJob(synapse: CapabilityRoutingSynapse): Promise<CapabilityRoutingResult> {
    const start = Date.now();
    if (this.miners.length === 0) throw new Error("No routing miners available");

    const numToQuery = Math.min(5, this.miners.length);
    const selected = this.selectMiners(numToQuery);

    const responses = await Promise.all(selected.map((m) => m.forward({ ...synapse })));

    // Yuma Consensus: score each miner by Kendall tau against consensus
    const consensusRanking = this.buildConsensusRanking(responses, selected);
    const scored = this.scoreByKendallTau(responses, selected, consensusRanking);

    // Update weights
    for (const { miner, weight } of scored) {
      const cur = this.weights.get(miner.uid) ?? 0;
      const updated = cur * 0.7 + weight * 0.3;
      this.weights.set(miner.uid, updated);
      const info = miner.getInfo();
      miner.updateScores(info.trust * 0.8 + weight * 0.2, weight);
    }

    // Agreement: average pairwise Kendall tau across miners
    const agreement = this.computeOverallAgreement(responses);

    // Consensus score: weighted average of top-operator scores
    const topScores = consensusRanking.map((e) => e.score);
    const avgTopScore = topScores.length > 0
      ? topScores.reduce((s, v) => s + v, 0) / topScores.length
      : 0;

    const consensusScore = Math.round(avgTopScore * 1000) / 1000;

    // Update metrics
    this.metrics.totalVerifications++;
    const prev = this.metrics.totalVerifications - 1;
    this.metrics.averageScore =
      (this.metrics.averageScore * prev + consensusScore) / this.metrics.totalVerifications;
    this.metrics.lastEpochRewards =
      [...this.weights.values()].reduce((s, w) => s + w, 0) * 10;

    return {
      ranking: consensusRanking,
      consensusScore,
      minerCount: selected.length,
      rankingAgreement: Math.round(agreement * 1000) / 1000,
      totalTimeMs: Date.now() - start,
    };
  }

  /** Build consensus ranking using stake-weighted score averaging */
  private buildConsensusRanking(
    responses: CapabilityRoutingSynapse[],
    miners: RoutingMiner[],
  ): CapabilityRoutingRankEntry[] {
    const scoreMap = new Map<string, { totalWeight: number; weightedScore: number; reasons: Set<string> }>();

    for (let i = 0; i < responses.length; i++) {
      const ranking = responses[i].ranking ?? [];
      const stake = miners[i].stake;

      for (const entry of ranking) {
        const existing = scoreMap.get(entry.kernelId) ?? { totalWeight: 0, weightedScore: 0, reasons: new Set() };
        existing.totalWeight += stake;
        existing.weightedScore += entry.score * stake;
        for (const r of entry.reasons) existing.reasons.add(r);
        scoreMap.set(entry.kernelId, existing);
      }
    }

    const result: CapabilityRoutingRankEntry[] = [];
    for (const [kernelId, data] of scoreMap.entries()) {
      result.push({
        kernelId,
        score: data.totalWeight > 0 ? Math.round((data.weightedScore / data.totalWeight) * 1000) / 1000 : 0,
        reasons: [...data.reasons],
      });
    }

    return result.sort((a, b) => b.score - a.score);
  }

  /** Score miners by Kendall tau distance to consensus ranking */
  private scoreByKendallTau(
    responses: CapabilityRoutingSynapse[],
    miners: RoutingMiner[],
    consensus: CapabilityRoutingRankEntry[],
  ): Array<{ miner: RoutingMiner; weight: number }> {
    const consensusOrder = consensus.map((e) => e.kernelId);

    return responses.map((response, i) => {
      const miner = miners[i];
      const minerOrder = (response.ranking ?? []).map((e) => e.kernelId);
      const tau = kendallTau(consensusOrder, minerOrder);
      // tau in [-1, 1] → weight in [0, 1]
      const weight = Math.max(0, (tau + 1) / 2);
      return { miner, weight };
    });
  }

  /** Average pairwise Kendall tau to measure overall miner agreement */
  private computeOverallAgreement(responses: CapabilityRoutingSynapse[]): number {
    const orders = responses.map((r) => (r.ranking ?? []).map((e) => e.kernelId));
    if (orders.length < 2) return 1.0;

    let total = 0;
    let pairs = 0;
    for (let i = 0; i < orders.length; i++) {
      for (let j = i + 1; j < orders.length; j++) {
        total += kendallTau(orders[i], orders[j]);
        pairs++;
      }
    }
    return pairs > 0 ? (total / pairs + 1) / 2 : 1.0;
  }

  private selectMiners(count: number): RoutingMiner[] {
    if (count >= this.miners.length) return [...this.miners];
    const weighted = this.miners.map((m) => ({
      miner: m,
      weight: (this.weights.get(m.uid) ?? 0) * m.stake,
    }));
    const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
    const selected: RoutingMiner[] = [];
    const used = new Set<number>();
    while (selected.length < count) {
      let random = Math.random() * totalWeight;
      for (const w of weighted) {
        if (used.has(w.miner.uid)) continue;
        random -= w.weight;
        if (random <= 0) {
          selected.push(w.miner);
          used.add(w.miner.uid);
          break;
        }
      }
      if (selected.length < count && used.size === selected.length) {
        for (const w of weighted) {
          if (!used.has(w.miner.uid)) {
            selected.push(w.miner);
            used.add(w.miner.uid);
            break;
          }
        }
      }
    }
    return selected;
  }

  getMetrics(): SubnetMetrics {
    return { ...this.metrics };
  }
}

// ── Kendall Tau Utility ───────────────────────────────────────────────

/**
 * Compute Kendall tau-b between two ranked lists.
 * Returns a value in [-1, 1] where 1 = identical, -1 = reversed.
 * Items not present in both lists are ignored.
 */
function kendallTau(a: string[], b: string[]): number {
  // Only compare items present in both lists
  const common = a.filter((x) => b.includes(x));
  if (common.length < 2) return 1.0;

  const bFiltered = b.filter((x) => common.includes(x));

  // Normalise to index positions
  const posA = new Map(common.map((x, i) => [x, i]));
  const posB = new Map(bFiltered.map((x, i) => [x, i]));

  let concordant = 0;
  let discordant = 0;
  const n = common.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const aI = posA.get(common[i])!;
      const aJ = posA.get(common[j])!;
      const bI = posB.get(common[i])!;
      const bJ = posB.get(common[j])!;
      const signA = Math.sign(aI - aJ);
      const signB = Math.sign(bI - bJ);
      if (signA * signB > 0) concordant++;
      else if (signA * signB < 0) discordant++;
    }
  }

  const total = concordant + discordant;
  return total > 0 ? (concordant - discordant) / total : 1.0;
}
