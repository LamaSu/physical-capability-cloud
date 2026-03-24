/**
 * BittensorTaskRouter — unified entry point for all PCC Bittensor subnet tasks.
 *
 * Routes task requests to the appropriate subnet:
 *   - routeCapability → CapabilityRoutingSubnet
 *   - scoreQuality    → QualityScoringSubnet
 *   - detectSimilarity → SimilaritySubnet
 *
 * Each subnet maintains its own miner pool and metrics independently.
 */

import {
  CapabilityRoutingSubnet,
  type CapabilityRoutingSynapse,
  type CapabilityRoutingResult,
} from "./capability-router.js";
import {
  QualityScoringSubnet,
  type QualityScoringSynapse,
  type QualityScoringResult,
} from "./quality-scorer.js";
import {
  SimilaritySubnet,
  type SimilarityScoringSynapse,
  type SimilarityResult,
} from "./similarity-scorer.js";
import type { SubnetMetrics } from "./types.js";

export interface TaskRouterConfig {
  minersPerSubnet?: number;
}

export class BittensorTaskRouter {
  private capabilityRouter: CapabilityRoutingSubnet;
  private qualityScorer: QualityScoringSubnet;
  private similarityScorer: SimilaritySubnet;

  constructor(config?: TaskRouterConfig) {
    const count = config?.minersPerSubnet ?? 8;
    this.capabilityRouter = new CapabilityRoutingSubnet(count);
    this.qualityScorer = new QualityScoringSubnet(count);
    this.similarityScorer = new SimilaritySubnet(count);
  }

  /**
   * Route a job to the best operator via competitive ranking.
   */
  async routeCapability(synapse: CapabilityRoutingSynapse): Promise<CapabilityRoutingResult> {
    return this.capabilityRouter.routeJob(synapse);
  }

  /**
   * Score evidence quality using ML-like heuristics.
   */
  async scoreQuality(synapse: QualityScoringSynapse): Promise<QualityScoringResult> {
    return this.qualityScorer.scoreEvidence(synapse);
  }

  /**
   * Detect similarity between a new CSD and existing registered CSDs.
   */
  async detectSimilarity(synapse: SimilarityScoringSynapse): Promise<SimilarityResult> {
    return this.similarityScorer.detectSimilarity(synapse);
  }

  /**
   * Get aggregated metrics for all three subnets.
   */
  getSubnetMetrics(): {
    routing: SubnetMetrics;
    quality: SubnetMetrics;
    similarity: SubnetMetrics;
  } {
    return {
      routing: this.capabilityRouter.getMetrics(),
      quality: this.qualityScorer.getMetrics(),
      similarity: this.similarityScorer.getMetrics(),
    };
  }
}
