/**
 * EigenLayer AVS Adapter — Future stub for decentralized verification.
 *
 * EigenLayer AVS is not yet production-ready (6-12 month build).
 * By default returns isAvailable(): false and throws on submit.
 *
 * Can be enabled in mock mode for testing cascade fallback behavior.
 * In mock mode, uses the shared evidence evaluator (same as UMA/Chainlink).
 *
 * Placeholder for future integration when EigenLayer restaking +
 * AVS operator network is ready for evidence verification tasks.
 */

import type { Hex } from "viem";
import type {
  VerificationOracle,
  OracleVerificationResult,
  OracleMetrics,
  OracleConfig,
  AttestationBinding,
} from "./types.js";
import { DEFAULT_ORACLE_CONFIG, buildOnChainAttestation } from "./types.js";
import { evaluateEvidence } from "./evidence-evaluator.js";

/** Mirror of uma-adapter.normalizeEvidenceHash */
function normalizeEvidenceHash(bundleHash: string): Hex {
  if (bundleHash.startsWith("0x") && bundleHash.length === 66) {
    return bundleHash as Hex;
  }
  const stripped = bundleHash.replace(/^sha256:/, "").replace(/^0x/, "");
  if (stripped.length >= 64) {
    return (`0x${stripped.slice(0, 64)}`) as Hex;
  }
  return (`0x${stripped.padStart(64, "0")}`) as Hex;
}

export class EigenLayerOracleAdapter implements VerificationOracle {
  readonly name = "eigenlayer";

  private enabled = false;
  private config: OracleConfig;
  private totalVerifications = 0;
  private scoreSum = 0;
  private recentResults: OracleMetrics["recentResults"] = [];

  constructor(config?: OracleConfig) {
    this.config = config ?? DEFAULT_ORACLE_CONFIG;
  }

  isAvailable(): boolean {
    return this.enabled;
  }

  /**
   * Enable the EigenLayer adapter in mock mode for testing.
   * In production, this would be gated on AVS operator quorum readiness.
   */
  enable(): void { this.enabled = true; }
  /** Disable the adapter (default state) */
  disable(): void { this.enabled = false; }

  async submitForVerification(
    bundleHash: string,
    bundleData: string,
    requiredTier: number,
    binding?: AttestationBinding,
  ): Promise<OracleVerificationResult> {
    if (!this.enabled) {
      throw new Error(
        "EigenLayer AVS not yet available. This is a future integration stub. " +
        "Use UMA or Chainlink adapters for current verification needs.",
      );
    }

    const startTime = Date.now();

    // Mock mode: evaluate locally via shared evaluator
    const evaluation = evaluateEvidence(bundleHash, bundleData, requiredTier);
    const minScore = this.config.minScoreThreshold ?? 0.6;
    const passed = evaluation.score >= minScore && evaluation.tierCompliant;

    const result: OracleVerificationResult = {
      passed,
      score: evaluation.score,
      tierCompliant: evaluation.tierCompliant,
      defects: evaluation.defects,
      oracle: "eigenlayer",
      details: [
        {
          source: "eigenlayer_mock",
          score: evaluation.score,
          passed,
          metadata: {
            hashValid: !evaluation.defects.includes("bundle_hash_mismatch"),
            defectCount: evaluation.defects.length,
            requiredTier,
            note: "EigenLayer AVS mock — restaked ETH collateral would back this in production",
          },
        },
      ],
      totalTimeMs: Date.now() - startTime,
      attestation: binding
        ? buildOnChainAttestation({
            binding,
            evidenceHash: normalizeEvidenceHash(bundleHash),
            tier: requiredTier,
            verified: passed,
          })
        : undefined,
    };

    this.recordResult(result);
    return result;
  }

  getMetrics(): OracleMetrics {
    return {
      totalVerifications: this.totalVerifications,
      averageScore: this.totalVerifications > 0 ? this.scoreSum / this.totalVerifications : 0,
      activeOracles: this.enabled ? 1 : 0,
      primaryOracle: "eigenlayer",
      fallbackOracles: [],
      recentResults: [...this.recentResults],
    };
  }

  private recordResult(result: OracleVerificationResult): void {
    this.totalVerifications++;
    this.scoreSum += result.score;

    this.recentResults.unshift({
      oracle: "eigenlayer",
      passed: result.passed,
      score: result.score,
      timestamp: new Date().toISOString(),
    });

    if (this.recentResults.length > 10) {
      this.recentResults = this.recentResults.slice(0, 10);
    }
  }
}
