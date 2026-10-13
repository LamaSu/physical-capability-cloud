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
import { canonicalize } from "@pcc/spec";
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

/**
 * The pipelines that can enforce an assurance tier. zk_proof and merkle_commitment can't: neither evidences
 * the events every tier requires, so validation refuses them (tier_unenforceable), and a task may not be
 * created on them (E11e, E11f).
 */
export const TIER_ENFORCING_PIPELINES: readonly BenchmarkProofEnvelope["proofType"][] = [
  "sensor_evidence",
  "bittensor_verification",
  "oracle_verification",
];

/** A one-finding refusal. */
function refusal(check: string, details: string): ValidationResult {
  return { valid: false, confidence: 0, findings: [{ check, passed: false, details }] };
}

/**
 * The task's accepted tier, or a refusal when it has none. The worker's own claim (proof.requiredTier) is
 * never read (E11f): an unsigned field changes no verdict, in either direction.
 */
function acceptedTierOf(
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

  /**
   * The bundle a network judges, bound to the hash the worker names (E11f). bundleData must parse to an
   * evidence bundle that EvidenceVerifier accepts at the task's tier: every event hash and the bundle hash
   * recomputed, the tier's required events present, the consistency checks passed. The supplied bundleHash
   * must be that bundle's hash. The network then receives ONLY what that hash commits: the bundle hash and
   * each event's hashed fields and hash, in an order chosen by committed fields, as canonical JSON. No
   * uncommitted field (the bundle's id, jobId, assuranceTier or signatures, an event's id, the array order,
   * the payload's key order) reaches it, and its answer can only add a refusal.
   *
   * The boundary: "committed" means hash-committed. EvidenceVerifier recomputes hashes; it checks no
   * kernel or device signature (it has no key registry), exactly as on the sensor_evidence pipeline.
   */
  private async boundBundle(
    bundleHash: string,
    bundleData: string,
    tier: AssuranceTier,
    check: string,
  ): Promise<{ bundleData: string; local: ValidationResult["findings"][number] } | { refusal: ValidationResult }> {
    let bundle: unknown;
    try {
      bundle = JSON.parse(bundleData);
    } catch {
      return { refusal: refusal(check, "bundleData is not JSON") };
    }
    if (
      bundle === null ||
      typeof bundle !== "object" ||
      Array.isArray(bundle) ||
      !Array.isArray((bundle as { events?: unknown }).events)
    ) {
      return { refusal: refusal(check, "bundleData is not an evidence bundle with an events array") };
    }
    let attestation: Awaited<ReturnType<EvidenceVerifier["verify"]>>;
    try {
      attestation = await this.evidenceVerifier.verify(bundle as EvidenceBundle, { acceptedTier: tier });
    } catch (err) {
      return { refusal: refusal(check, `bundleData could not be verified: ${err instanceof Error ? err.message : String(err)}`) };
    }
    if (attestation.result !== "valid") {
      return {
        refusal: {
          valid: false,
          confidence: 0,
          findings: [
            { check, passed: false, details: `The bundle fails verification at the task's tier ${tier}, so no network is asked` },
            ...attestation.findings.filter((f) => !f.passed).map((f) => ({ check: f.check, passed: f.passed, details: f.details })),
          ],
        },
      };
    }
    const verified = bundle as EvidenceBundle;
    if (verified.bundleHash !== bundleHash) {
      return { refusal: refusal(check, "The supplied bundleHash is not the hash of the verified bundle") };
    }
    const at = (e: { timestamp: string }) => {
      const t = Date.parse(e.timestamp);
      return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    const events = verified.events
      .map((e) => ({ type: e.type, timestamp: e.timestamp, source: e.source, payload: e.payload, hash: e.hash }))
      .sort((a, b) => at(a) - at(b) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
    return {
      bundleData: canonicalize({ bundleHash: verified.bundleHash, events }),
      local: { check, passed: true, details: `The bundle verifies at the task's tier ${tier}, with its event and bundle hashes recomputed` },
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

    const bundleHash = envelope.proof.bundleHash;
    const bundleData = envelope.proof.bundleData;
    // The tier is the task's accepted one, never the worker's own claim (N118).
    const accepted = acceptedTierOf(context, "bittensor_accepted_tier");
    if ("refusal" in accepted) return accepted.refusal;
    const requiredTier = accepted.tier;

    if (typeof bundleHash !== "string" || bundleHash.length === 0 || typeof bundleData !== "string" || bundleData.length === 0) {
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

    // The network judges only the bundle verified here, bound to bundleHash (E11f).
    const bound = await this.boundBundle(bundleHash, bundleData, requiredTier, "bittensor_bundle");
    if ("refusal" in bound) return bound.refusal;

    const result = await this.bittensorBridge.submitForVerification(
      bundleHash,
      bound.bundleData,
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
        bound.local,
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

    const bundleHash = envelope.proof.bundleHash;
    const bundleData = envelope.proof.bundleData;
    // The tier is the task's accepted one, never the worker's own claim (N118).
    const accepted = acceptedTierOf(context, "oracle_accepted_tier");
    if ("refusal" in accepted) return accepted.refusal;
    const requiredTier = accepted.tier;

    if (typeof bundleHash !== "string" || bundleHash.length === 0 || typeof bundleData !== "string" || bundleData.length === 0) {
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

    // The network judges only the bundle verified here, bound to bundleHash (E11f).
    const bound = await this.boundBundle(bundleHash, bundleData, requiredTier, "oracle_bundle");
    if ("refusal" in bound) return bound.refusal;

    const result = await this.bittensorBridge.submitForVerification(
      bundleHash,
      bound.bundleData,
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
        bound.local,
      ],
    };
  }
}
