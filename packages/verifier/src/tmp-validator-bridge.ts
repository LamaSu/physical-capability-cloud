/**
 * TMP Validator Bridge -- bridges PCC's evidence verification infrastructure
 * to TMP Benchmark mode.
 *
 * When a TMP contract in Benchmark mode needs to validate a deliverable,
 * the bridge routes the proof through the appropriate PCC verifier:
 *
 *   sensor_evidence       -> EvidenceVerifier (bundle hash + tier checks)
 *   zk_proof              -> ZKProofService (mock Noir verification)
 *   merkle_commitment     -> CommitmentService (Merkle proof verification)
 *   bittensor_verification -> BittensorSubnetBridge (decentralized consensus)
 */

import type { Address, Timestamp, SHA256, EvidenceBundle, ZKProof } from "@pcc/spec";
import { EvidenceVerifier } from "./evidence-verifier.js";
import { CommitmentService } from "./commitment-service.js";
import { ZKProofService } from "./zk-proof-service.js";
import { BittensorSubnetBridge } from "./bittensor/subnet-bridge.js";
import { OracleVerificationBridge } from "./oracle/oracle-bridge.js";

// ── Types ────────────────────────────────────────────────────────────

/** Proof envelope submitted to the Benchmark validator */
export interface BenchmarkProofEnvelope {
  /** TMP on-chain task ID */
  taskId: string;
  /** TMP contract address */
  contractAddress: Address;
  /** Settlement chain ID */
  chainId: number;
  /** Worker who produced the deliverable */
  worker: Address;
  /** bytes32 hash of the deliverable */
  deliverable: string;
  /** Target metric expression, e.g., "dimensional_accuracy >= 0.95" */
  metricTarget: string;
  /** Which proof pipeline to route through */
  proofType:
    | "sensor_evidence"
    | "zk_proof"
    | "merkle_commitment"
    | "bittensor_verification"
    | "oracle_verification";
  /** Proof-type-specific payload */
  proof: Record<string, unknown>;
  /** When the proof was submitted */
  submittedAt: Timestamp;
}

// Alias for backward compatibility
export type { BenchmarkProofEnvelope as BenchmarkProofEnvelopeCompat };

/** Result of a benchmark validation */
export interface ValidationResult {
  /** Whether the deliverable meets the metric target */
  valid: boolean;
  /** Confidence in the validation (0-1) */
  confidence: number;
  /** Detailed findings from the verification pipeline */
  findings: Array<{ check: string; passed: boolean; details: string }>;
  /** Hash of the attestation (for on-chain anchoring) */
  attestationHash?: string;
}

/** Callback payload sent to TMP contract after validation */
export interface TMPAcceptanceCallback {
  taskId: string;
  worker: Address;
  accepted: boolean;
  validationResult: ValidationResult;
}

// ── Bridge Implementation ────────────────────────────────────────────

export class TMPValidatorBridge {
  constructor(
    private evidenceVerifier: EvidenceVerifier,
    private commitmentService: CommitmentService,
    private zkProofService: ZKProofService,
    /** Accepts either BittensorSubnetBridge (legacy) or OracleVerificationBridge (new) */
    private bittensorBridge?: BittensorSubnetBridge | OracleVerificationBridge,
  ) {}

  /**
   * Validate a benchmark proof by routing to the appropriate verifier.
   *
   * @param envelope - The proof submission envelope
   * @returns ValidationResult with findings and confidence
   */
  async validate(envelope: BenchmarkProofEnvelope): Promise<ValidationResult> {
    switch (envelope.proofType) {
      case "sensor_evidence":
        return this.validateSensorEvidence(envelope);
      case "zk_proof":
        return this.validateZKProof(envelope);
      case "merkle_commitment":
        return this.validateMerkleCommitment(envelope);
      case "bittensor_verification":
        return this.validateViaBittensor(envelope);
      case "oracle_verification":
        return this.validateViaOracle(envelope);
      default:
        return {
          valid: false,
          confidence: 0,
          findings: [
            {
              check: "proof_type",
              passed: false,
              details: `Unknown proof type: ${envelope.proofType}`,
            },
          ],
        };
    }
  }

  /**
   * Format a ValidationResult into a TMP acceptance callback payload.
   */
  formatAcceptance(
    envelope: BenchmarkProofEnvelope,
    result: ValidationResult,
  ): TMPAcceptanceCallback {
    return {
      taskId: envelope.taskId,
      worker: envelope.worker,
      accepted: result.valid && result.confidence >= 0.7,
      validationResult: result,
    };
  }

  // ── Private Validation Routes ────────────────────────────────────

  private async validateSensorEvidence(
    envelope: BenchmarkProofEnvelope,
  ): Promise<ValidationResult> {
    const bundle = envelope.proof.evidenceBundle as EvidenceBundle | undefined;
    if (!bundle) {
      return {
        valid: false,
        confidence: 0,
        findings: [
          {
            check: "evidence_bundle_present",
            passed: false,
            details: "No evidence bundle provided in proof payload",
          },
        ],
      };
    }

    const attestation = await this.evidenceVerifier.verify(bundle);

    return {
      valid: attestation.result === "valid",
      confidence: attestation.confidence / 100,
      findings: attestation.findings.map((f) => ({
        check: f.check,
        passed: f.passed,
        details: f.details,
      })),
      attestationHash: attestation.attestationHash,
    };
  }

  private async validateZKProof(
    envelope: BenchmarkProofEnvelope,
  ): Promise<ValidationResult> {
    const zkProof = envelope.proof.zkProof as ZKProof | undefined;

    if (!zkProof) {
      return {
        valid: false,
        confidence: 0,
        findings: [
          {
            check: "zk_proof_present",
            passed: false,
            details: "No ZK proof provided in proof payload",
          },
        ],
      };
    }

    const verified = await this.zkProofService.verifyProof(zkProof);

    return {
      valid: verified,
      confidence: verified ? 0.95 : 0,
      findings: [
        {
          check: "zk_proof_verification",
          passed: verified,
          details: verified
            ? `ZK proof ${zkProof.id} verified successfully`
            : `ZK proof ${zkProof.id} verification failed`,
        },
      ],
      attestationHash: verified ? zkProof.proof : undefined,
    };
  }

  private async validateMerkleCommitment(
    envelope: BenchmarkProofEnvelope,
  ): Promise<ValidationResult> {
    const root = envelope.proof.merkleRoot as SHA256 | undefined;
    const leaf = envelope.proof.leaf as SHA256 | undefined;
    const path = envelope.proof.path as SHA256[] | undefined;
    const indices = envelope.proof.indices as number[] | undefined;

    if (!root || !leaf || !path || !indices) {
      return {
        valid: false,
        confidence: 0,
        findings: [
          {
            check: "merkle_proof_complete",
            passed: false,
            details: "Incomplete Merkle proof: need root, leaf, path, and indices",
          },
        ],
      };
    }

    const verified = await this.commitmentService.verifyMerkleProof(
      root,
      leaf,
      { path, indices },
    );

    return {
      valid: verified,
      confidence: verified ? 0.99 : 0,
      findings: [
        {
          check: "merkle_inclusion",
          passed: verified,
          details: verified
            ? `Leaf ${leaf} proven in tree with root ${root}`
            : `Merkle proof invalid for leaf ${leaf}`,
        },
      ],
      attestationHash: verified ? root : undefined,
    };
  }

  private async validateViaBittensor(
    envelope: BenchmarkProofEnvelope,
  ): Promise<ValidationResult> {
    if (!this.bittensorBridge || !this.bittensorBridge.isAvailable()) {
      return {
        valid: false,
        confidence: 0,
        findings: [
          {
            check: "bittensor_available",
            passed: false,
            details: "Bittensor subnet bridge is not available",
          },
        ],
      };
    }

    const bundleHash = envelope.proof.bundleHash as string | undefined;
    const bundleData = envelope.proof.bundleData as string | undefined;
    const requiredTier = (envelope.proof.requiredTier as number) ?? 1;

    if (!bundleHash || !bundleData) {
      return {
        valid: false,
        confidence: 0,
        findings: [
          {
            check: "bittensor_input",
            passed: false,
            details: "Missing bundleHash or bundleData for Bittensor verification",
          },
        ],
      };
    }

    const result = await this.bittensorBridge.submitForVerification(
      bundleHash,
      bundleData,
      requiredTier,
    );

    // OracleVerificationBridge returns .score + .oracle; BittensorSubnetBridge returns .consensusScore + .minerCount
    const isLegacyBittensor = "consensusScore" in result && !("oracle" in result);
    const score = "consensusScore" in result ? result.consensusScore : (result as { score: number }).score;
    const minerCount = "minerCount" in result ? result.minerCount : 1;
    const oracleName = "oracle" in result ? (result as { oracle?: string }).oracle : "bittensor";
    const checkName = isLegacyBittensor ? "bittensor_consensus" : "oracle_consensus";

    return {
      valid: result.passed,
      confidence: score,
      findings: [
        {
          check: checkName,
          passed: result.passed,
          details: `${isLegacyBittensor ? "Bittensor" : "Oracle"} consensus (${oracleName ?? "unknown"}): ${result.passed ? "PASS" : "FAIL"} (score: ${(score * 100).toFixed(1)}%, sources: ${minerCount})`,
        },
      ],
    };
  }

  /**
   * validateViaOracle — new oracle cascade routing.
   * Accepts oracle_verification proof type.
   */
  async validateViaOracle(
    envelope: BenchmarkProofEnvelope,
  ): Promise<ValidationResult> {
    if (!this.bittensorBridge || !this.bittensorBridge.isAvailable()) {
      return {
        valid: false,
        confidence: 0,
        findings: [
          {
            check: "oracle_available",
            passed: false,
            details: "No verification oracle is available",
          },
        ],
      };
    }

    const bundleHash = envelope.proof.bundleHash as string | undefined;
    const bundleData = envelope.proof.bundleData as string | undefined;
    const requiredTier = (envelope.proof.requiredTier as number) ?? 1;

    if (!bundleHash || !bundleData) {
      return {
        valid: false,
        confidence: 0,
        findings: [
          {
            check: "oracle_input",
            passed: false,
            details: "Missing bundleHash or bundleData for oracle verification",
          },
        ],
      };
    }

    const result = await this.bittensorBridge.submitForVerification(
      bundleHash,
      bundleData,
      requiredTier,
    );

    const score = "consensusScore" in result ? result.consensusScore : (result as { score: number }).score;
    const oracleName = "oracle" in result ? (result as { oracle?: string }).oracle : "oracle";

    return {
      valid: result.passed,
      confidence: score,
      findings: [
        {
          check: "oracle_verification",
          passed: result.passed,
          details: `Oracle (${oracleName ?? "unknown"}): ${result.passed ? "PASS" : "FAIL"} (score: ${(score * 100).toFixed(1)}%)`,
        },
      ],
    };
  }
}
