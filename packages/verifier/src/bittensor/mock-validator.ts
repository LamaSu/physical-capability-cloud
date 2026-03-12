/**
 * MockValidator — simulates a Bittensor subnet validator.
 *
 * Maintains a pool of MockMiners, sends evidence verification synapses
 * to a subset of miners (like dendrite.query()), scores their responses
 * using simplified Yuma Consensus, and sets weights.
 *
 * Architecture mirrors Bittensor's validator loop:
 *   1. Select miners to query
 *   2. Send synapse (dendrite.query)
 *   3. Score responses against consensus + reference
 *   4. Update weights (metagraph.set_weights)
 *   5. Return aggregated result
 */

import { MockMiner, type MinerQuality } from "./mock-miner.js";
import type {
  EvidenceVerifySynapse,
  MinerInfo,
  ValidatorConfig,
  SubnetMetrics,
  VerificationResult,
  MinerResponse,
} from "./types.js";
import { DEFAULT_VALIDATOR_CONFIG as DEFAULT_CONFIG } from "./types.js";

export class MockValidator {
  private miners: MockMiner[] = [];
  private config: ValidatorConfig;
  private metrics: SubnetMetrics;
  private epoch: number = 0;
  /** Running weight matrix: weights[minerUid] = weight (0-1) */
  private weights: Map<number, number> = new Map();

  constructor(config?: Partial<ValidatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = {
      totalVerifications: 0,
      averageScore: 0,
      activeMinerCount: 0,
      lastEpochRewards: 0,
    };
  }

  /** Initialize the miner pool with varying quality levels */
  initializeMiners(count: number = 8): void {
    this.miners = [];
    const qualities: MinerQuality[] = ["excellent", "good", "good", "good", "mediocre", "mediocre", "poor", "poor"];

    for (let i = 0; i < count; i++) {
      const quality = qualities[i % qualities.length];
      const stake = 500 + Math.random() * 2000;
      const miner = new MockMiner(i, quality, Math.round(stake));
      this.miners.push(miner);
      this.weights.set(i, 1.0 / count); // Equal initial weights
    }

    this.metrics.activeMinerCount = count;
  }

  /** Add a specific miner to the pool */
  addMiner(miner: MockMiner): void {
    this.miners.push(miner);
    this.weights.set(miner.uid, 1.0 / this.miners.length);
    this.metrics.activeMinerCount = this.miners.length;
  }

  /**
   * Submit evidence for decentralized verification.
   * Mirrors the validator's forward pass + scoring loop.
   */
  async verify(
    evidenceHash: string,
    evidenceData: string,
    requiredTier: number,
  ): Promise<VerificationResult> {
    const startTime = Date.now();

    if (this.miners.length === 0) {
      throw new Error("No miners available in subnet");
    }

    // 1. Select miners to query (weighted random by stake + trust)
    const numToQuery = Math.min(this.config.numMinersToQuery, this.miners.length);
    const selectedMiners = this.selectMiners(numToQuery);

    // 2. Create synapse and send to miners (simulated dendrite.query)
    const synapse: EvidenceVerifySynapse = {
      evidenceHash,
      evidenceData,
      requiredTier,
    };

    const responses = await Promise.all(
      selectedMiners.map((miner) => miner.forward({ ...synapse })),
    );

    // 3. Score responses using Yuma Consensus
    const scored = this.yumaConsensus(responses, selectedMiners);

    // 4. Update miner weights based on scores
    this.updateWeights(scored);

    // 5. Aggregate results
    const result = this.aggregateResults(scored, startTime);

    // Update metrics
    this.metrics.totalVerifications++;
    const prevTotal = this.metrics.totalVerifications - 1;
    this.metrics.averageScore =
      (this.metrics.averageScore * prevTotal + result.consensusScore) /
      this.metrics.totalVerifications;

    return result;
  }

  /**
   * Select miners for querying, weighted by stake * trust.
   * Higher-weighted miners are more likely to be selected.
   */
  private selectMiners(count: number): MockMiner[] {
    if (count >= this.miners.length) return [...this.miners];

    const weighted = this.miners.map((m) => ({
      miner: m,
      weight: (this.weights.get(m.uid) ?? 0) * m.getInfo().stake,
    }));

    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    const selected: MockMiner[] = [];
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
      // Safety valve: if random selection misses (floating point), take first unused
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

  /**
   * Simplified Yuma Consensus scoring.
   *
   * Real Yuma Consensus uses a stake-weighted majority mechanism where
   * validators' weight matrices are combined to produce consensus scores.
   * Our simplified version:
   *   1. Compute median score as the "consensus answer"
   *   2. Score each miner by how close they are to the median
   *   3. Weight by their stake
   *   4. Bonus for correct tier compliance (matching majority)
   */
  private yumaConsensus(
    responses: EvidenceVerifySynapse[],
    miners: MockMiner[],
  ): Array<{ miner: MockMiner; response: EvidenceVerifySynapse; consensusWeight: number }> {
    // Extract scores (default 0 for missing)
    const scores = responses.map((r) => r.verificationScore ?? 0);

    // Compute stake-weighted median as consensus target
    const medianScore = this.weightedMedian(
      scores,
      miners.map((m) => m.getInfo().stake),
    );

    // Compute tier compliance majority
    const tierVotes = responses.map((r) => r.tierCompliant ?? false);
    const tierMajority = tierVotes.filter(Boolean).length > tierVotes.length / 2;

    // Score each miner
    return responses.map((response, i) => {
      const miner = miners[i];
      const score = response.verificationScore ?? 0;

      // Distance from consensus (0 = perfect match, 1 = maximum disagreement)
      const distance = Math.abs(score - medianScore);
      const proximityScore = Math.max(0, 1.0 - distance * 2);

      // Tier compliance bonus
      const tierBonus = (response.tierCompliant ?? false) === tierMajority ? 0.1 : -0.1;

      // Speed bonus (faster is better, up to 0.05)
      const speedScore = response.processingTimeMs
        ? Math.max(0, 0.05 * (1 - response.processingTimeMs / this.config.timeout))
        : 0;

      const consensusWeight = Math.max(0, Math.min(1, proximityScore + tierBonus + speedScore));

      return { miner, response, consensusWeight };
    });
  }

  /** Compute weighted median of values */
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

  /** Update miner weights based on consensus scoring */
  private updateWeights(
    scored: Array<{ miner: MockMiner; consensusWeight: number }>,
  ): void {
    for (const { miner, consensusWeight } of scored) {
      const currentWeight = this.weights.get(miner.uid) ?? 0;
      // Exponential moving average
      const newWeight = currentWeight * 0.7 + consensusWeight * 0.3;
      this.weights.set(miner.uid, newWeight);

      // Update miner trust and incentive
      const info = miner.getInfo();
      const newTrust = info.trust * 0.8 + consensusWeight * 0.2;
      const newIncentive = consensusWeight;
      miner.updateScores(newTrust, newIncentive);
    }

    this.epoch++;

    // Calculate epoch rewards (simulated TAO distribution)
    const totalWeight = [...this.weights.values()].reduce((s, w) => s + w, 0);
    this.metrics.lastEpochRewards = totalWeight * 10; // 10 TAO per weight unit
  }

  /** Aggregate scored miner responses into a final VerificationResult */
  private aggregateResults(
    scored: Array<{ miner: MockMiner; response: EvidenceVerifySynapse; consensusWeight: number }>,
    startTime: number,
  ): VerificationResult {
    // Weighted average of scores
    const totalWeight = scored.reduce((sum, s) => sum + s.consensusWeight, 0);
    const weightedScore = totalWeight > 0
      ? scored.reduce((sum, s) => sum + (s.response.verificationScore ?? 0) * s.consensusWeight, 0) / totalWeight
      : 0;

    // Tier compliance via weighted vote
    const tierWeight = scored.reduce(
      (sum, s) => sum + ((s.response.tierCompliant ?? false) ? s.consensusWeight : 0),
      0,
    );
    const tierCompliant = tierWeight > totalWeight / 2;

    // Aggregate defects (include defects reported by high-weight miners)
    const defectCounts = new Map<string, number>();
    for (const { response, consensusWeight } of scored) {
      for (const defect of response.defectsFound ?? []) {
        defectCounts.set(defect, (defectCounts.get(defect) ?? 0) + consensusWeight);
      }
    }
    // Only include defects with weight > 30% of total
    const threshold = totalWeight * 0.3;
    const defects = [...defectCounts.entries()]
      .filter(([, weight]) => weight > threshold)
      .map(([defect]) => defect);

    const minerResponses: MinerResponse[] = scored.map((s) => ({
      uid: s.miner.uid,
      hotkey: s.miner.getInfo().hotkey,
      score: s.response.verificationScore ?? 0,
      tierCompliant: s.response.tierCompliant ?? false,
      defectsFound: s.response.defectsFound ?? [],
      processingTimeMs: s.response.processingTimeMs ?? 0,
      consensusWeight: Math.round(s.consensusWeight * 1000) / 1000,
    }));

    const consensusScore = Math.round(weightedScore * 1000) / 1000;

    return {
      passed: consensusScore >= this.config.minScoreThreshold && tierCompliant,
      consensusScore,
      tierCompliant,
      defects,
      minerCount: scored.length,
      minerResponses,
      totalTimeMs: Date.now() - startTime,
    };
  }

  /** Get current subnet metrics */
  getMetrics(): SubnetMetrics {
    return { ...this.metrics };
  }

  /** Get miner leaderboard, sorted by incentive descending */
  getMinerLeaderboard(): MinerInfo[] {
    return this.miners
      .map((m) => m.getInfo())
      .sort((a, b) => b.incentive - a.incentive);
  }

  /** Get miner count */
  getMinerCount(): number {
    return this.miners.length;
  }

  /** Check if validator has miners available */
  isReady(): boolean {
    return this.miners.length > 0;
  }
}
