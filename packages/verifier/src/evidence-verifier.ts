/**
 * Evidence Verifier -- checks that an evidence bundle meets tier requirements.
 *
 * This is what a verifier node runs when assigned a verification request.
 * It checks:
 *   1. Bundle hash integrity
 *   2. Event hash integrity
 *   3. Tier evidence requirements met
 *   4. Consistency checks between events (e.g., power profile matches execution duration)
 *   5. (Optional) Challenge freshness -- anti-replay proof
 *   6. (Optional) Step completeness -- workflow step coverage
 *   7. Assurance score rollup
 *   8. Produces a VerificationAttestation
 */

import type {
  EvidenceBundle,
  EvidenceEvent,
  VerificationAttestation,
  VerificationFinding,
  AssuranceTier,
  Signature,
  Address,
  DigitalWorkflowStep,
  WorkflowChallenge,
  ExecutionProof,
} from "@pcc/spec";
import { DEFAULT_TIER_REQUIREMENTS, verifyBundleHash, verifyEventHash, ids } from "@pcc/spec";
import { canonicalize, sha256 } from "@pcc/spec";
import { computeAssuranceScore } from "./workflow/assurance-score.js";
import { checkStepCompleteness, type StepTrace } from "./workflow/completeness-checker.js";
import { ChallengeService } from "./workflow/challenge-service.js";

/** Options for digital-workflow-aware verification. All fields are optional --
 *  callers that pass nothing get the existing behavior. */
export interface DigitalVerifyOptions {
  /** Declared workflow steps from the contract. Enables step-completeness checking. */
  workflowSteps?: DigitalWorkflowStep[];
  /** Challenge issued before execution. Together with executionProof, enables anti-replay freshness. */
  challenge?: WorkflowChallenge;
  /** Proof that execution happened after the challenge was issued. */
  executionProof?: ExecutionProof;
  /** Block timestamp to use for challenge age check. Defaults to Date.now()/1000. */
  currentBlockTimestamp?: bigint;
}

export class EvidenceVerifier {
  private verifierId: string;
  private verifierAddress: string;
  private signFn: (data: string) => Promise<Signature>;

  constructor(
    verifierId: string,
    verifierAddress: string,
    signFn?: (data: string) => Promise<Signature>,
  ) {
    this.verifierId = verifierId;
    this.verifierAddress = verifierAddress;
    // TEST-ONLY default -- replace with a real wallet signFn in production
    this.signFn = signFn ?? (async (data: string) => ({
      signer: verifierAddress as Address,
      algorithm: "secp256k1" as const,
      value: `test_sig_${data.slice(0, 16)}`,
    }));
  }

  /**
   * Verify an evidence bundle and produce an attestation.
   *
   * @param bundle   The evidence bundle to verify.
   * @param options  Optional digital-workflow data. When omitted, existing
   *                 behavior is preserved exactly (backward compatible).
   */
  async verify(
    bundle: EvidenceBundle,
    options?: DigitalVerifyOptions,
  ): Promise<VerificationAttestation> {
    const findings: VerificationFinding[] = [];

    // 1. Verify bundle hash
    const bundleValid = await verifyBundleHash(bundle);
    findings.push({
      evidenceEventId: "",
      check: "bundle_hash_integrity",
      passed: bundleValid,
      details: bundleValid ? "Bundle hash matches events" : "Bundle hash mismatch",
      severity: bundleValid ? undefined : "critical",
    });

    // 2. Verify each event hash
    for (const event of bundle.events) {
      const eventValid = await verifyEventHash(event);
      findings.push({
        evidenceEventId: event.id,
        check: "event_hash_integrity",
        passed: eventValid,
        details: eventValid ? `Event ${event.id} hash valid` : `Event ${event.id} hash mismatch`,
        severity: eventValid ? undefined : "critical",
      });
    }

    // 3. Check tier requirements
    const tierReq = DEFAULT_TIER_REQUIREMENTS.find((r) => r.tier === bundle.assuranceTier);
    if (tierReq) {
      const eventTypes = new Set(bundle.events.map((e) => e.type));
      for (const group of tierReq.requiredEventTypes) {
        const found = group.some((t) => eventTypes.has(t));
        findings.push({
          evidenceEventId: "",
          check: `tier_requirement_${group.join("_or_")}`,
          passed: found,
          details: found
            ? `Required event type present: ${group.filter((t) => eventTypes.has(t)).join(", ")}`
            : `Missing required event type: one of ${group.join(", ")}`,
          severity: found ? undefined : "critical",
        });
      }
    }

    // 4. Consistency checks
    const executionStarted = bundle.events.find((e) => e.type === "execution_started");
    const executionCompleted = bundle.events.find((e) => e.type === "execution_completed");
    if (executionStarted && executionCompleted) {
      const startTime = new Date(executionStarted.timestamp).getTime();
      const endTime = new Date(executionCompleted.timestamp).getTime();
      const durationSec = (endTime - startTime) / 1000;

      findings.push({
        evidenceEventId: executionCompleted.id,
        check: "execution_duration_positive",
        passed: durationSec > 0,
        details: `Execution duration: ${durationSec}s`,
        severity: durationSec > 0 ? undefined : "critical",
      });

      // Check power profile consistency (if present)
      const powerSummary = bundle.events.find((e) => e.type === "power_profile_summary");
      if (powerSummary) {
        const powerDuration = (powerSummary.payload as any).durationSeconds;
        const durationRatio = powerDuration / durationSec;
        const consistent = durationRatio > 0.5 && durationRatio < 2.0;

        findings.push({
          evidenceEventId: powerSummary.id,
          check: "power_duration_consistency",
          passed: consistent,
          details: `Power duration ${powerDuration}s vs execution ${durationSec}s (ratio: ${durationRatio.toFixed(2)})`,
          severity: consistent ? undefined : "warning",
        });
      }
    }

    // ── Digital-verifier primitives (pre-oracle checks) ──────────────

    // 5. Challenge freshness check (anti-replay)
    if (options?.challenge && options?.executionProof) {
      const challengeService = new ChallengeService();
      const proofResult = challengeService.verifyExecutionProof({
        challenge: options.challenge,
        proof: options.executionProof,
        currentBlockTimestamp: options.currentBlockTimestamp ?? BigInt(Math.floor(Date.now() / 1000)),
      });
      findings.push({
        evidenceEventId: "",
        check: "challenge_freshness",
        passed: proofResult.valid,
        details: proofResult.valid
          ? "Execution proof is fresh and matches challenge"
          : proofResult.failures.join("; "),
        severity: proofResult.valid ? undefined : "critical",
      });
    }

    // 6. Step completeness check (workflow coverage)
    if (options?.workflowSteps && options.workflowSteps.length > 0) {
      const traces: StepTrace[] = bundle.events
        .filter(
          (e) =>
            e.type === "workflow_step_completed" ||
            e.type === "execution_completed",
        )
        .map((e) => ({
          stepId: (e.payload as any).stepId ?? e.id,
          outputHash: (e.payload as any).outputHash ?? e.hash,
          outputSummary: (e.payload as any).outputSummary ?? "",
          durationMs: (e.payload as any).durationMs,
          inputHash: (e.payload as any).inputHash,
        }));

      const completeness = checkStepCompleteness(
        { workflowSteps: options.workflowSteps },
        traces,
        { level: 1 },
      );
      findings.push(...completeness.findings);
    }

    // ── Assurance score rollup ───────────────────────────────────────

    const assuranceScore = computeAssuranceScore({
      findings: findings.map((f) => ({
        check: f.check,
        passed: f.passed,
        details: f.details,
        severity: f.severity === "info" ? undefined : f.severity,
      })),
      driftAlerts: [],
      consensusAgreement: undefined,
    });

    // ── Compute result ───────────────────────────────────────────────

    const criticalFailures = findings.filter((f) => !f.passed && f.severity === "critical");
    const passed = criticalFailures.length === 0;
    const confidence = passed
      ? 90 + (findings.filter((f) => f.passed).length / findings.length) * 10
      : Math.max(0, 50 - criticalFailures.length * 15);

    // Create attestation
    const attestationData = {
      verifierId: this.verifierId,
      bundleHash: bundle.bundleHash,
      result: passed ? "valid" : "invalid",
      confidence,
      findingsCount: findings.length,
      criticalFailures: criticalFailures.length,
      assuranceScore,
    };
    const attestationHash = await sha256(canonicalize(attestationData));
    const now = new Date().toISOString();

    // Generate POAW-style audit receipt
    const auditReceiptData = {
      attestationHash,
      verifierId: this.verifierId,
      checksPerformed: findings.length,
      timestamp: now,
    };
    const scanHash = await sha256(canonicalize(auditReceiptData));

    const signature = await this.signFn(attestationHash);

    return {
      id: ids.attestation(),
      requestId: "", // filled in by caller
      verifierId: this.verifierId,
      evidenceBundleHash: bundle.bundleHash,
      result: passed ? "valid" : criticalFailures.length > 0 ? "invalid" : "inconclusive",
      confidence: Math.round(confidence * 100) / 100,
      findings,
      attestationHash,
      signature,
      createdAt: now,
      assuranceScore,
      auditReceipt: {
        scanHash,
        chainPosition: 0,
        checksPerformed: findings.length,
        timestamp: now,
      },
    };
  }
}
