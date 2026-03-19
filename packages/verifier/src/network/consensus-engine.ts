/**
 * ConsensusEngine — implements production-grade Yuma Consensus for the
 * private verification network.
 *
 * Improvements over MockValidator's consensus:
 *   - Weighted median (not mean) for outlier resistance
 *   - Standard deviation-based outlier detection with penalty
 *   - Reputation tracking: +1 aligned, -5 outlier, -20 non-response
 *   - Configurable consensus threshold (default 2/3)
 *   - Trust normalization across all participating nodes
 */

import type {
  VerificationResponse,
  ConsensusResult,
  NetworkConfig,
} from "./types.js";
import { DEFAULT_NETWORK_CONFIG } from "./types.js";
import type { VerifierNode } from "./verifier-node.js";

/** Reputation deltas for different outcomes */
const REPUTATION = {
  CONSENSUS_ALIGNED: 1,
  OUTLIER_PENALTY: -5,
  NON_RESPONSE_PENALTY: -20,
} as const;

export class ConsensusEngine {
  private config: NetworkConfig;
  /** nodeId -> cumulative reputation score */
  private reputations: Map<string, number> = new Map();

  constructor(config?: Partial<NetworkConfig>) {
    this.config = { ...DEFAULT_NETWORK_CONFIG, ...config };
  }

  /**
   * Run stake-weighted Yuma Consensus over a set of verification responses.
   *
   * Algorithm:
   *   1. Compute stake-weighted median score (outlier-resistant center)
   *   2. Compute standard deviation of scores
   *   3. For each response: score proximity to median, penalize >2 sigma deviations
   *   4. Stake-weighted vote on tier compliance and defects
   *   5. Update node reputations
   */
  async runConsensus(
    responses: VerificationResponse[],
    nodeStakes: Map<string, number>,
  ): Promise<ConsensusResult> {
    if (responses.length === 0) {
      throw new Error("Cannot run consensus with zero responses");
    }

    const requestId = responses[0].requestId;

    // Extract scores and stakes
    const scores = responses.map((r) => r.score);
    const stakes = responses.map((r) => nodeStakes.get(r.nodeId) ?? 1);
    const totalStake = stakes.reduce((sum, s) => sum + s, 0);

    // 1. Compute stake-weighted median
    const medianScore = this.weightedMedian(scores, stakes);

    // 2. Compute standard deviation
    const stdDev = this.standardDeviation(scores);

    // 3. Score each node's alignment and detect outliers
    const outlierThreshold = stdDev * 2;
    const nodeAlignments: Array<{
      response: VerificationResponse;
      stake: number;
      deviation: number;
      isOutlier: boolean;
      alignmentWeight: number;
    }> = responses.map((response, i) => {
      const deviation = Math.abs(response.score - medianScore);
      const isOutlier = stdDev > 0 && deviation > outlierThreshold;
      // Alignment weight: 1.0 at median, decays with distance, 0 for outliers
      const alignmentWeight = isOutlier
        ? 0
        : Math.max(0, 1.0 - (stdDev > 0 ? deviation / (stdDev * 3) : 0));

      return {
        response,
        stake: stakes[i],
        deviation,
        isOutlier,
        alignmentWeight,
      };
    });

    // 4. Compute consensus score (stake-weighted, excluding outliers)
    let weightedScoreSum = 0;
    let weightSum = 0;
    for (const item of nodeAlignments) {
      if (!item.isOutlier) {
        const weight = item.stake * item.alignmentWeight;
        weightedScoreSum += item.response.score * weight;
        weightSum += weight;
      }
    }
    const consensusScore = weightSum > 0
      ? Math.round((weightedScoreSum / weightSum) * 1000) / 1000
      : medianScore;

    // 5. Tier compliance via stake-weighted vote (excluding outliers)
    let tierCompliantWeight = 0;
    let tierTotalWeight = 0;
    for (const item of nodeAlignments) {
      if (!item.isOutlier) {
        tierTotalWeight += item.stake;
        if (item.response.tierCompliant) {
          tierCompliantWeight += item.stake;
        }
      }
    }
    const tierCompliant = tierTotalWeight > 0
      ? tierCompliantWeight / tierTotalWeight >= this.config.consensusThreshold
      : false;

    // 6. Aggregate defects (include defects with stake-weighted vote > 30%)
    const defectWeights = new Map<string, number>();
    for (const item of nodeAlignments) {
      if (!item.isOutlier) {
        for (const defect of item.response.defectsFound) {
          defectWeights.set(
            defect,
            (defectWeights.get(defect) ?? 0) + item.stake,
          );
        }
      }
    }
    const defectThreshold = tierTotalWeight * 0.3;
    const consensusDefects = [...defectWeights.entries()]
      .filter(([, weight]) => weight > defectThreshold)
      .map(([defect]) => defect);

    // 7. Update reputations
    for (const item of nodeAlignments) {
      const nodeId = item.response.nodeId;
      const currentRep = this.reputations.get(nodeId) ?? 100;
      const delta = item.isOutlier
        ? REPUTATION.OUTLIER_PENALTY
        : REPUTATION.CONSENSUS_ALIGNED;
      this.reputations.set(nodeId, Math.max(0, currentRep + delta));
    }

    // Apply reputation decay toward baseline (100)
    for (const [nodeId, rep] of this.reputations) {
      const decayed = rep + (100 - rep) * this.config.reputationDecayRate;
      this.reputations.set(nodeId, Math.round(decayed * 100) / 100);
    }

    return {
      requestId,
      responses,
      consensusScore,
      tierCompliant,
      consensusDefects,
      participatingNodes: responses.map((r) => r.nodeId),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Penalize nodes that failed to respond to a verification request.
   * Called by the network coordinator when nodes time out.
   */
  penalizeNonResponders(nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      const currentRep = this.reputations.get(nodeId) ?? 100;
      this.reputations.set(
        nodeId,
        Math.max(0, currentRep + REPUTATION.NON_RESPONSE_PENALTY),
      );
    }
  }

  /** Get the current reputation map */
  getNodeReputations(): Map<string, number> {
    return new Map(this.reputations);
  }

  /** Get reputation for a specific node */
  getNodeReputation(nodeId: string): number {
    return this.reputations.get(nodeId) ?? 100;
  }

  // ── Math utilities ────────────────────────────────────────────────────

  /**
   * Compute stake-weighted median.
   * Resistant to outliers — the median is the value where 50% of the
   * cumulative stake weight falls on each side.
   */
  private weightedMedian(values: number[], weights: number[]): number {
    const pairs = values
      .map((v, i) => ({ value: v, weight: weights[i] }))
      .sort((a, b) => a.value - b.value);

    const totalWeight = pairs.reduce((sum, p) => sum + p.weight, 0);
    let cumWeight = 0;

    for (const pair of pairs) {
      cumWeight += pair.weight;
      if (cumWeight >= totalWeight / 2) {
        return pair.value;
      }
    }

    return pairs[pairs.length - 1]?.value ?? 0;
  }

  /** Compute standard deviation of an array of numbers */
  private standardDeviation(values: number[]): number {
    if (values.length <= 1) return 0;

    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const variance =
      values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
  }
}
