/**
 * OracleVerificationBridge — Three-tier oracle verification cascade.
 *
 * Orchestrates:
 *   UMA Optimistic Oracle (primary, 2hr liveness)
 *   → Chainlink Functions (fallback, DON-based)
 *   → EigenLayer AVS (future stub, always unavailable)
 *
 * Drop-in replacement for BittensorSubnetBridge with the same public API.
 *
 * Cascade behavior:
 *   1. Try UMA — if unavailable or throws, fall through
 *   2. Try Chainlink — if unavailable or throws, fall through
 *   3. Try EigenLayer — always unavailable currently
 *   4. All failed → return failure result
 */

import { UMAOracleAdapter } from "./uma-adapter.js";
import { ChainlinkOracleAdapter } from "./chainlink-adapter.js";
import { EigenLayerOracleAdapter } from "./eigenlayer-adapter.js";
import type {
  VerificationOracle,
  OracleVerificationResult,
  OracleMetrics,
  OracleConfig,
  VerificationResult,
} from "./types.js";
import { DEFAULT_ORACLE_CONFIG } from "./types.js";

export interface OracleLeaderboardEntry {
  name: string;
  available: boolean;
  totalVerifications: number;
  averageScore: number;
  isPrimary: boolean;
}

export class OracleVerificationBridge {
  private oracles: VerificationOracle[];
  private umaAdapter: UMAOracleAdapter;
  private chainlinkAdapter: ChainlinkOracleAdapter;
  private eigenlayerAdapter: EigenLayerOracleAdapter;

  private cascadeMetrics = {
    totalVerifications: 0,
    scoreSum: 0,
    recentResults: [] as OracleMetrics["recentResults"],
  };

  constructor(config: OracleConfig = DEFAULT_ORACLE_CONFIG) {
    this.umaAdapter = new UMAOracleAdapter(config);
    this.chainlinkAdapter = new ChainlinkOracleAdapter(config);
    this.eigenlayerAdapter = new EigenLayerOracleAdapter();

    this.oracles = [this.umaAdapter, this.chainlinkAdapter, this.eigenlayerAdapter];
  }

  /**
   * Submit evidence for verification through the oracle cascade.
   * Tries UMA first, falls back to Chainlink, then EigenLayer.
   * Returns an OracleVerificationResult describing which oracle was used.
   */
  async submitForVerification(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
  ): Promise<OracleVerificationResult> {
    const errors: Array<{ oracle: string; error: string }> = [];

    for (const oracle of this.oracles) {
      if (!oracle.isAvailable()) {
        errors.push({ oracle: oracle.name, error: "unavailable" });
        continue;
      }

      try {
        const result = await oracle.submitForVerification(bundleHash, bundleData, requiredTier);
        this.recordCascadeResult(result);
        return result;
      } catch (err) {
        errors.push({
          oracle: oracle.name,
          error: (err as Error).message,
        });
      }
    }

    // All oracles failed
    const failResult: OracleVerificationResult = {
      passed: false,
      score: 0,
      tierCompliant: false,
      defects: ["all_oracles_unavailable"],
      oracle: "none",
      details: errors.map((e) => ({
        source: e.oracle,
        score: 0,
        passed: false,
        metadata: { error: e.error },
      })),
      totalTimeMs: 0,
    };

    this.recordCascadeResult(failResult);
    return failResult;
  }

  /**
   * Get aggregated metrics across all oracles in the cascade.
   */
  getMetrics(): OracleMetrics {
    const availableCount = this.oracles.filter((o) => o.isAvailable()).length;

    return {
      totalVerifications: this.cascadeMetrics.totalVerifications,
      averageScore:
        this.cascadeMetrics.totalVerifications > 0
          ? this.cascadeMetrics.scoreSum / this.cascadeMetrics.totalVerifications
          : 0,
      activeOracles: availableCount,
      primaryOracle: this.umaAdapter.isAvailable() ? "uma" : this.chainlinkAdapter.isAvailable() ? "chainlink" : "none",
      fallbackOracles: ["chainlink", "eigenlayer"],
      recentResults: [...this.cascadeMetrics.recentResults],
    };
  }

  /**
   * Get leaderboard of all oracles (replaces getMinerLeaderboard).
   */
  getOracleLeaderboard(): OracleLeaderboardEntry[] {
    return this.oracles.map((oracle, idx) => {
      const metrics = oracle.getMetrics();
      return {
        name: oracle.name,
        available: oracle.isAvailable(),
        totalVerifications: metrics.totalVerifications,
        averageScore: metrics.averageScore,
        isPrimary: idx === 0,
      };
    });
  }

  /**
   * Backward-compatible getMinerLeaderboard alias.
   * Returns oracle entries in the same shape as miner entries where possible.
   */
  getMinerLeaderboard(): OracleLeaderboardEntry[] {
    return this.getOracleLeaderboard();
  }

  /** Check if at least one oracle in the cascade is available */
  isAvailable(): boolean {
    return this.oracles.some((o) => o.isAvailable());
  }

  /** Access the UMA adapter directly (for testing/disable/enable) */
  getUMA(): UMAOracleAdapter { return this.umaAdapter; }
  /** Access the Chainlink adapter directly (for testing/disable/enable) */
  getChainlink(): ChainlinkOracleAdapter { return this.chainlinkAdapter; }
  /** Access the EigenLayer adapter directly (for testing/disable/enable) */
  getEigenLayer(): EigenLayerOracleAdapter { return this.eigenlayerAdapter; }

  /**
   * Convert OracleVerificationResult to the legacy VerificationResult shape
   * for backward compatibility with existing callers.
   */
  static toVerificationResult(result: OracleVerificationResult): VerificationResult {
    return {
      passed: result.passed,
      consensusScore: result.score,
      tierCompliant: result.tierCompliant,
      defects: result.defects,
      minerCount: 1,
      minerResponses: [],
      totalTimeMs: result.totalTimeMs,
      oracle: result.oracle,
      assertionId: result.assertionId,
      requestId: result.requestId,
    };
  }

  private recordCascadeResult(result: OracleVerificationResult): void {
    this.cascadeMetrics.totalVerifications++;
    this.cascadeMetrics.scoreSum += result.score;

    this.cascadeMetrics.recentResults.unshift({
      oracle: result.oracle,
      passed: result.passed,
      score: result.score,
      timestamp: new Date().toISOString(),
    });

    if (this.cascadeMetrics.recentResults.length > 20) {
      this.cascadeMetrics.recentResults = this.cascadeMetrics.recentResults.slice(0, 20);
    }
  }
}
