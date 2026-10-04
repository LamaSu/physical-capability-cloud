/**
 * TMP Validator Bridge -- bridges PCC's evidence verification infrastructure
 * to TMP Benchmark mode.
 *
 * When a TMP contract in Benchmark mode needs to validate a deliverable,
 * the bridge routes the proof through the pipeline the TASK requires (its
 * own record, never the worker's choice), at the task's accepted tier:
 *
 *   sensor_evidence        -> EvidenceVerifier (bundle hash + the accepted tier's requirements)
 *   bittensor_verification -> BittensorSubnetBridge (decentralized consensus at the accepted tier)
 *   oracle_verification    -> OracleVerificationBridge (oracle consensus at the accepted tier)
 *   zk_proof, merkle_commitment -> refused (tier_unenforceable): neither evidences a tier's
 *                             required events (E11e). The constructor keeps their services
 *                             for its callers.
 */

import type { Address, AssuranceTier, Timestamp, SHA256, EvidenceBundle, ZKProof } from "@pcc/spec";
import { EvidenceVerifier } from "./evidence-verifier.js";
import { CommitmentService } from "./commitment-service.js";
import { ZKProofService } from "./zk-proof-service.js";
import { BittensorSubnetBridge } from "./bittensor/subnet-bridge.js";
import { OracleVerificationBridge } from "./oracle/oracle-bridge.js";

/**
 * What the CALLER knows from authenticated state about the task a proof answers (N118). Never read
 * from the worker's envelope: the worker chooses neither the tier nor anything else the verdict
 * depends on.
 */
export interface ValidationContext {
  /** The assurance tier the task was accepted at (its own record, set when the task was created). */
  acceptedTier?: AssuranceTier;
  /** The proof pipeline the task requires (its own record). A submission on any other pipeline is refused. */
  proofType?: BenchmarkProofEnvelope["proofType"];
}

/** A one-finding refusal. */
function refusal(check: string, details: string): ValidationResult {
  return { valid: false, confidence: 0, findings: [{ check, passed: false, details }] };
}

/** The accepted tier as the routes need it, or a refusal: absent, or contradicted by the worker's proof. */
function acceptedTierOf(
  envelope: BenchmarkProofEnvelope,
  context: ValidationContext | undefined,
  check: string,
): { tier: AssuranceTier } | { refusal: ValidationResult } {
  const tier = context?.acceptedTier;
  if (tier !== 0 && tier !== 1 && tier !== 2 && tier !== 3) {
    return {
      refusal: {
        valid: false,
        confidence: 0,
        findings: [{ check, passed: false, details: "No accepted tier for this task: a worker's proof cannot choose one" }],
      },
    };
  }
  const claimed = envelope.proof.requiredTier;
  if (claimed !== undefined && claimed !== tier) {
    return {
      refusal: {
        valid: false,
        confidence: 0,
        findings: [{ check, passed: false, details: `The proof claims tier ${String(claimed)}, but the task was accepted at tier ${tier}` }],
      },
    };
  }
  return { tier };
}

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
  async validate(envelope: BenchmarkProofEnvelope, context?: ValidationContext): Promise<ValidationResult> {
    // The pipeline is the TASK's, never the worker's choice (E11e): a submission on any other one is refused.
    const pipeline = context?.proofType;
    if (pipeline === undefined) {
      return refusal("task_pipeline", "No pipeline for this task: a worker's proof cannot choose one");
    }
    if (envelope.proofType !== pipeline) {
      return refusal("task_pipeline", `The proof uses ${String(envelope.proofType)}, but the task requires ${String(pipeline)}`);
    }
    switch (pipeline) {
      case "sensor_evidence":
        return this.validateSensorEvidence(envelope, context);
      case "zk_proof":
      case "merkle_commitment":
        // Every assurance tier (0 to 3) requires evidence events (gcode_hash_verified, execution_completed,
        // and more). A ZK proof or a Merkle inclusion evidences none of them, so these pipelines cannot
        // enforce a tier, and they refuse (E11e: every pipeline enforces the tier or refuses). That also
        // ends the empty-path Merkle accept: a worker-chosen root equal to its leaf proved nothing.
        return refusal("tier_unenforceable", `${pipeline} cannot evidence an assurance tier's required events, so it cannot validate a task`);
      case "bittensor_verification":
        return this.validateViaBittensor(envelope, context);
      case "oracle_verification":
        return this.validateViaOracle(envelope, context);
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
    context?: ValidationContext,
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

    // The tier comes from the caller's authenticated context, never the bundle (N118): the verifier
    // fails closed without it and never reads the bundle's own, unsigned assuranceTier (E11e).
    const attestation = await this.evidenceVerifier.verify(bundle, { acceptedTier: context?.acceptedTier });

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

  private async validateViaBittensor(
    envelope: BenchmarkProofEnvelope,
    context?: ValidationContext,
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
    // The tier is the task's accepted one, never the worker's own claim (N118).
    const accepted = acceptedTierOf(envelope, context, "bittensor_accepted_tier");
    if ("refusal" in accepted) return accepted.refusal;
    const requiredTier = accepted.tier;

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
    context?: ValidationContext,
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
    // The tier is the task's accepted one, never the worker's own claim (N118).
    const accepted = acceptedTierOf(envelope, context, "oracle_accepted_tier");
    if ("refusal" in accepted) return accepted.refusal;
    const requiredTier = accepted.tier;

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
